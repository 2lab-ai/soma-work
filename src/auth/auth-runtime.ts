import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type AuthMode, config, LLMUX_PLACEHOLDER_API_KEY } from '../config';
import { Logger } from '../logger';

const logger = new Logger('AuthRuntime');

/**
 * Runtime-mutable auth backend state (#llmux runtime switch).
 *
 * `config.auth` (parsed from `AUTH_MODE` / `ANTHROPIC_BASE_URL` /
 * `ANTHROPIC_API_KEY` env at boot) is the *initial default* only. This module
 * owns the LIVE values consumed by every dispatch:
 *
 *   - {@link getAuthMode} — read by `ensureActiveSlotAuth`
 *     (credentials-manager) and `buildQueryEnv` (query-env-builder) on every
 *     Claude Agent SDK call, so a mode flip applies to the NEXT dispatch with
 *     no restart.
 *   - {@link getLlmuxSettings} — live `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`
 *     used in llmux mode (and as the llmux admin-API endpoint).
 *
 * Persistence: `data/auth-runtime.json` (same `DATA_DIR` convention as
 * `cct-store.json`). Written atomically (tmp + rename) on every setter, loaded
 * once at first read. Precedence at boot:
 *
 *   1. persisted `data/auth-runtime.json`   (an operator's explicit runtime choice)
 *   2. `AUTH_MODE` env                       (explicit deployment default)
 *   3. llmux boot probe (see `initAuthRuntimeDefault` in index.ts): llmux
 *      reachable → `'llmux'` (llmux is the preferred default; cct is legacy),
 *      unreachable → `'ccp'`.
 *
 * Concurrency: single mutation point per setter, plain in-memory object reads
 * — Node's single-threaded event loop makes torn reads impossible. Multi-
 * process deployments share the file but not live state (same limitation as
 * the pre-existing env-only wiring; acceptable because mode flips are rare
 * admin actions).
 */
export interface AuthRuntimeState {
  /** Live auth backend. `'ccp'` = legacy CCT slot leases, `'llmux'` = local llmux proxy. */
  mode: AuthMode;
  llmux: {
    /** Live llmux base URL (`ANTHROPIC_BASE_URL` for SDK subprocesses + admin API host). */
    baseUrl: string;
    /**
     * Live API key forwarded to llmux (`ANTHROPIC_API_KEY` for SDK
     * subprocesses, `x-api-key` for the llmux admin API). llmux ignores the
     * value on loopback; non-loopback llmux validates it against its
     * `proxy.api_key`.
     */
    apiKey: string;
  };
}

/** On-disk shape — every field optional so partial/older files still load. */
interface PersistedAuthRuntime {
  mode?: string;
  llmux?: { baseUrl?: string; apiKey?: string };
}

/** Default on-disk location — sibling of `cct-store.json` under DATA_DIR. */
function defaultAuthRuntimePath(): string {
  const dataDir = process.env.DATA_DIR || './data';
  return path.join(dataDir, 'auth-runtime.json');
}

let _state: AuthRuntimeState | null = null;
let _storePath: string | null = null;

function storePath(): string {
  if (_storePath === null) _storePath = defaultAuthRuntimePath();
  return _storePath;
}

function envDefaults(): AuthRuntimeState {
  return {
    mode: config.auth.mode,
    llmux: {
      baseUrl: config.auth.llmux.baseUrl,
      apiKey: config.auth.llmux.apiKey,
    },
  };
}

function parseMode(raw: string | undefined): AuthMode | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  // Accept the user-facing legacy alias 'cct' for 'ccp' — the Slack surface
  // labels the legacy mode "cct" (the token store it drives), while the
  // internal enum keeps its historical 'ccp' spelling.
  if (normalized === 'ccp' || normalized === 'cct') return 'ccp';
  if (normalized === 'llmux') return 'llmux';
  return null;
}

/** Load persisted state over env defaults. Never throws — a corrupt file logs + falls back. */
function load(): AuthRuntimeState {
  const state = envDefaults();
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedAuthRuntime;
    const mode = parseMode(parsed.mode);
    if (mode) state.mode = mode;
    if (typeof parsed.llmux?.baseUrl === 'string' && parsed.llmux.baseUrl.trim() !== '') {
      state.llmux.baseUrl = parsed.llmux.baseUrl.trim();
    }
    if (typeof parsed.llmux?.apiKey === 'string' && parsed.llmux.apiKey.trim() !== '') {
      state.llmux.apiKey = parsed.llmux.apiKey.trim();
    }
    logger.info(`Loaded auth runtime state: mode=${state.mode}, baseUrl=${state.llmux.baseUrl}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`auth-runtime.json unreadable (${(err as Error).message}); using env defaults`);
    }
  }
  return state;
}

/** Atomic persist (tmp + rename). Failure logs but never blocks the live flip. */
function persist(state: AuthRuntimeState): void {
  try {
    const target = storePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    logger.error(`Failed to persist auth runtime state: ${(err as Error).message}`);
  }
}

function state(): AuthRuntimeState {
  if (_state === null) _state = load();
  return _state;
}

/** Live auth mode — consult on EVERY dispatch, never cache across awaits. */
export function getAuthMode(): AuthMode {
  return state().mode;
}

/** Live llmux settings (defensive copy). */
export function getLlmuxSettings(): { baseUrl: string; apiKey: string } {
  return { ...state().llmux };
}

/**
 * Cached result of the llmux-config file read used by {@link getLlmuxAdminKey}.
 * `key` is `null` when no candidate file yielded a usable `proxy.api_key`.
 * Short TTL so an operator who starts/edits llmux does not need a restart,
 * while a per-dispatch key lookup stays free of syscalls.
 */
let _llmuxConfigKeyCache: { key: string | null; readAtMs: number } | null = null;
const LLMUX_CONFIG_KEY_TTL_MS = 60_000;

/**
 * Candidate paths of llmux's OWN config file, in llmux's resolution order
 * (llmux `src/config/mod.rs`): `$LLMUX_CONFIG`, else
 * `$XDG_CONFIG_HOME/llmux.json`, else `~/.config/llmux.json`.
 *
 * Reading these external-tool env names directly is a deliberate, documented
 * exception to the `SOMA_`-prefixed-config rule (rules/config.md §5): they are
 * llmux's variables, not ours — re-declaring them under a `SOMA_` name would
 * create a second source of truth for someone else's config path.
 */
function llmuxConfigCandidates(): string[] {
  const explicit = process.env.LLMUX_CONFIG?.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return [
    ...(explicit ? [explicit] : []),
    path.join(xdg && xdg !== '' ? xdg : path.join(os.homedir(), '.config'), 'llmux.json'),
  ];
}

/** First candidate file with a non-empty `.proxy.api_key`, else null. Never throws. */
function readLlmuxConfigApiKey(): string | null {
  for (const candidate of llmuxConfigCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { proxy?: { api_key?: unknown } };
      const key = parsed?.proxy?.api_key;
      if (typeof key === 'string' && key.trim() !== '') return key.trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(`llmux config ${candidate} unreadable (${(err as Error).message}); no admin key from it`);
      }
    }
  }
  return null;
}

/**
 * Whether `baseUrl` addresses a daemon on THIS host. Unparseable input is NOT
 * loopback — an unrecognized URL must never unlock the local-credential path.
 */
function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    // Node keeps IPv6 literals bracketed in `hostname` ("[::1]").
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

/**
 * Credential for llmux's CONTROL plane (`/llmux/*`).
 *
 * llmux requires an ADMIN credential on every control endpoint — including
 * loopback callers (llmux `src/proxy/server.rs` client_auth), unlike the data
 * plane which lets loopback through as the `local` tenant. So the placeholder
 * data-plane key is NOT sufficient here.
 *
 * Resolution:
 *   1. Operator-set `llmux.apiKey` (runtime settings / `ANTHROPIC_API_KEY`)
 *      always wins — an explicit key is an explicit choice.
 *   2. Otherwise (the operator left {@link LLMUX_PLACEHOLDER_API_KEY}) read the
 *      co-located llmux daemon's own config file and use its legacy
 *      `proxy.api_key`, which llmux resolves to admin. This mirrors llmux's own
 *      behavior for server-local CLIs, which auto-present that key. Cached for
 *      60s.
 *
 *      ONLY when the daemon this credential is about to be SENT TO is loopback.
 *      That file belongs to the llmux running on THIS host, so without the gate
 *      "placeholder apiKey + remote destination" would ship the local daemon's
 *      admin secret to a foreign host. A remote llmux must be given its own key
 *      explicitly (path 1).
 *   3. Otherwise return the placeholder unchanged (legacy behavior: harmless
 *      against single-tenant/older llmux, 403 against multi-tenant llmux —
 *      which every caller already degrades gracefully on).
 *
 * @param targetBaseUrl the URL this credential will actually be sent to.
 *   Callers with a per-request baseUrl override (llmux-client's Settings-modal
 *   candidate probe) MUST pass it — the live setting can be loopback while the
 *   request goes off-host. Omitted → the live setting.
 */
export function getLlmuxAdminKey(targetBaseUrl?: string): string {
  const { apiKey, baseUrl } = getLlmuxSettings();
  if (apiKey.trim() !== '' && apiKey !== LLMUX_PLACEHOLDER_API_KEY) return apiKey;
  if (!isLoopbackBaseUrl(targetBaseUrl?.trim() || baseUrl)) return apiKey;

  const now = Date.now();
  if (_llmuxConfigKeyCache === null || now - _llmuxConfigKeyCache.readAtMs >= LLMUX_CONFIG_KEY_TTL_MS) {
    _llmuxConfigKeyCache = { key: readLlmuxConfigApiKey(), readAtMs: now };
  }
  return _llmuxConfigKeyCache.key ?? apiKey;
}

/** Full snapshot for card rendering (defensive copy). */
export function getAuthRuntimeSnapshot(): AuthRuntimeState {
  const s = state();
  return { mode: s.mode, llmux: { ...s.llmux } };
}

/**
 * Flip the live auth mode and persist. Takes effect on the next dispatch —
 * in-flight SDK calls keep the env map they were built with.
 */
export function setAuthMode(mode: AuthMode): AuthRuntimeState {
  const s = state();
  s.mode = mode;
  persist(s);
  logger.info(`Auth mode switched to ${mode}`);
  return getAuthRuntimeSnapshot();
}

/**
 * Update live llmux settings (partial — omitted/blank fields keep their
 * current value, mirroring llmux's own `POST /llmux/settings` contract).
 */
export function setLlmuxSettings(update: { baseUrl?: string; apiKey?: string }): AuthRuntimeState {
  const s = state();
  const baseUrl = update.baseUrl?.trim();
  const apiKey = update.apiKey?.trim();
  if (baseUrl) s.llmux.baseUrl = baseUrl.replace(/\/+$/, '');
  if (apiKey) s.llmux.apiKey = apiKey;
  persist(s);
  logger.info(`llmux settings updated: baseUrl=${s.llmux.baseUrl}`);
  return getAuthRuntimeSnapshot();
}

/**
 * Boot-time default resolution (#llmux is the preferred default; cct/ccp is
 * legacy). Call once from index.ts BEFORE serving traffic:
 *
 *   - persisted file exists → it already won at load(); no probe.
 *   - `AUTH_MODE` env explicitly set → deployment operator's call; no probe.
 *   - neither → probe `GET {baseUrl}/llmux/status` (short timeout). Up →
 *     start in `'llmux'`; down → stay `'ccp'` so environments without a
 *     local llmux keep working unchanged.
 *
 * The probe result is NOT persisted — a later llmux install flips the default
 * on the next restart without an operator step, and an llmux outage falls
 * back to ccp on restart.
 */
export async function initAuthRuntimeDefault(probe: (baseUrl: string) => Promise<boolean>): Promise<AuthRuntimeState> {
  const persistedExists = fs.existsSync(storePath());
  const envModeSet = (process.env.AUTH_MODE ?? '').trim() !== '';
  const s = state();
  if (!persistedExists && !envModeSet) {
    try {
      const up = await probe(s.llmux.baseUrl);
      if (up) {
        s.mode = 'llmux';
        logger.info(`llmux reachable at ${s.llmux.baseUrl} — defaulting auth mode to llmux (cct is legacy)`);
      } else {
        logger.info(`llmux not reachable at ${s.llmux.baseUrl} — keeping legacy ccp auth mode`);
      }
    } catch (err) {
      logger.warn(`llmux boot probe failed (${(err as Error).message}); keeping ccp`);
    }
  }
  return getAuthRuntimeSnapshot();
}

/** Test-only: reset module state (and optionally point the store elsewhere). */
export function resetAuthRuntimeForTests(overridePath?: string): void {
  _state = null;
  _storePath = overridePath ?? null;
  _llmuxConfigKeyCache = null;
}

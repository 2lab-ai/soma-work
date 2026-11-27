import type { SlotAuthLease } from '../credentials-manager';
import { getAgentGhConfigDir } from '../github/agent-gh-config';
import { getAuthMode, getLlmuxSettings } from './auth-runtime';
import type { TenantKeyLease } from './llmux-tenant-keys';

/**
 * Result of {@link buildQueryEnv}: a fresh env map suitable for the Claude
 * Agent SDK `query()` call's `options.env`.
 *
 * The map is a **standalone copy** — mutating it has no effect on
 * `process.env`, and two results from distinct leases do not share object
 * identity, so concurrent dispatches cannot interfere with each other's
 * credentials.
 */
export interface QueryEnvResult {
  env: Record<string, string>;
}

/** Per-call inputs that only some dispatches can supply. */
export interface QueryEnvOptions {
  /**
   * Per-user llmux credential from `ensureTenantKey` — the secret AND the
   * daemon it is valid at; llmux mode only. `null`/omitted → the shared key
   * against the live daemon (legacy tenant).
   */
  llmuxTenant?: TenantKeyLease | null;
}

/**
 * Reserved env keys that operators MUST NOT set via `config.json#claude.env`.
 *
 * Two reasons a key lands here:
 *   1. **Auth ownership** — `CLAUDE_CODE_OAUTH_TOKEN` is owned by the lease;
 *      `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` would silently re-route
 *      auth to a different provider/path.
 *   2. **Subprocess integrity** — `CLAUDE_CONFIG_DIR` redirects credential
 *      state, `CLAUDE_CODE_USE_BEDROCK`/`USE_VERTEX` re-route traffic to a
 *      different provider, and `HTTP_PROXY` / `HTTPS_PROXY` /
 *      `NODE_EXTRA_CA_CERTS` widen the TLS-trust attack surface.
 *
 * Single source of truth — consumed by:
 *   - {@link setQueryEnvAdditional} / {@link buildQueryEnv} (build-time
 *     defense in depth: lease token override happens last)
 *   - `parseClaudeEnv()` in `config-loader.ts` (load-time drop with
 *     warn so operators learn about the conflict)
 */
export const RESERVED_LEASE_KEYS: readonly string[] = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
]);

/**
 * Module-level state for operator-controlled additional env (config.json#claude.env).
 *
 * Set ONCE at boot from `index.ts` via {@link setQueryEnvAdditional}; read
 * concurrently by every {@link buildQueryEnv} call across all 7 SDK call
 * sites in the repo (claude-handler ×2, conversation/* ×3, slack/z/topics/*).
 *
 * Mutability scope:
 *   - Single mutation point at process startup → no read/write races in steady
 *     state.
 *   - Tests reset between cases via `beforeEach(() => setQueryEnvAdditional({}))`.
 *
 * Hot reload is intentionally NOT supported. Operators must restart the
 * process after editing `config.json#claude.env`. This is documented in
 * docs/misc/guides/setup.md and `config.example.json`.
 */
let _additionalEnv: Record<string, string> = {};

/**
 * Install the operator-controlled additional env (parsed from
 * `config.json#claude.env`). Defensively clones the input so post-call
 * mutation by the caller cannot leak into module state.
 *
 * Restart required for changes — there is no watcher.
 */
export function setQueryEnvAdditional(env: Record<string, string>): void {
  _additionalEnv = { ...env };
}

/**
 * Read-only accessor for the currently installed additional env. Returned
 * object is a defensive clone, so callers cannot mutate module state.
 *
 * Used by tests and the boot-time timing log; not by `buildQueryEnv` itself
 * (which reads the module variable directly to avoid an extra clone per
 * dispatch).
 */
export function getQueryEnvAdditional(): Record<string, string> {
  return { ..._additionalEnv };
}

/**
 * What of the bot's own environment an agent inherits: the OS session, the locale, the TLS and proxy setup, and
 * soma-work's non-secret locations (its config directory, the CLI's, the data directory, the hook port, log knobs).
 *
 * Nothing else. The bot's environment also holds its `.env` — the Slack app's tokens and signing secret, the GitHub
 * App's private key, the subscription tokens, the dashboard's signing key — and an agent's shell, its hooks and its
 * stdio MCP servers all inherit `options.env` whole: a copy of `process.env` handed every one of them to the model.
 * The servers soma-work starts get what they need in their own `env` (`mcp-config-builder.ts`). A variable an agent's
 * tools need and this list lacks belongs in `config.json#claude.env` (layer 2), where the operator names it.
 */
const INHERITED_ENV_NAMES: ReadonlySet<string> = new Set([
  // The OS session.
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'TERM',
  'COLORTERM',
  '__CF_USER_TEXT_ENCODING',
  // How the host reaches the network and checks certificates.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // soma-work's locations: its config directory (the MCP servers resolve their files from it), the CLI's, the data
  // directory, and the port the hook proxy posts to.
  'SOMA_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'DATA_DIR',
  'CONVERSATION_VIEWER_PORT',
  'SOMA_HOOK_PORT',
  'HOOKS_PROXY_ENABLED',
  // The MCP servers' log level.
  'DEBUG',
  'LOG_LEVEL',
  'LOG_CATEGORIES',
  'LOG_MUTE',
]);

/** `LC_*` locale categories. */
const INHERITED_ENV_PREFIXES: readonly string[] = ['LC_'];

/** The part of `source` (the bot's environment) an agent inherits: {@link INHERITED_ENV_NAMES}. */
export function inheritedAgentEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (INHERITED_ENV_NAMES.has(key) || INHERITED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

/** Provider selectors recognized by the pinned SDK; llmux owns routing instead. */
const LLMUX_COMPETING_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
] as const;

/** Custom headers are applied after SDK credentials, so strip identity overrides only. */
function isolateLlmuxAuth(env: Record<string, string>): void {
  // The pinned SDK copies options.env as the complete child environment.
  // Remove competing values after both of our environment layers are applied.
  for (const key of LLMUX_COMPETING_ENV_KEYS) delete env[key];
  if (env.ANTHROPIC_CUSTOM_HEADERS === undefined) return;
  const headers = env.ANTHROPIC_CUSTOM_HEADERS.split(/\r?\n/)
    .filter((line) => {
      const separator = line.indexOf(':');
      const name = line.slice(0, separator).trim().toLowerCase();
      return separator < 0 || (name !== 'authorization' && name !== 'x-api-key');
    })
    .join('\n');
  if (headers.trim()) env.ANTHROPIC_CUSTOM_HEADERS = headers;
  else delete env.ANTHROPIC_CUSTOM_HEADERS;
}

/**
 * Build a per-call env map that carries the lease's fresh access token to the
 * Claude Agent SDK via `options.env`.
 *
 * Why this exists:
 *   Prior to this seam, `TokenManager.mirrorToEnv()` mutated
 *   `process.env.CLAUDE_CODE_OAUTH_TOKEN` as a shared global. Two concurrent
 *   `query()` calls holding leases on different CCT slots would race each
 *   other — whichever wrote last won, leaking one tenant's token into the
 *   other tenant's subprocess. `buildQueryEnv()` replaces that with a
 *   per-spawn env map, scoped to a single `query()` invocation.
 *
 * Layering (last write wins):
 *   1. The allow-listed part of `process.env` ({@link inheritedAgentEnv}: PATH, HOME, the locale, config
 *      locations …) — never the bot's `.env` secrets, which the agent's shell would otherwise inherit.
 *   2. Operator-controlled additional env from `config.json#claude.env`,
 *      installed via {@link setQueryEnvAdditional}. Operator intent overrides
 *      the inherited shell environment.
 *   3. Auth backend (`config.auth.mode`):
 *        - `'ccp'` (default): `CLAUDE_CODE_OAUTH_TOKEN = lease.accessToken`.
 *          ALWAYS last — defense in depth even if the load-time denylist in
 *          `parseClaudeEnv` is bypassed, the lease's fresh token cannot be
 *          overridden by config.
 *        - `'llmux'`: set `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` and remove
 *          competing credentials/provider selectors so llmux owns upstream auth.
 *          The lease token is unused in this mode. When the dispatch has a user
 *          identity, BOTH values come from `opts.llmuxTenant` — the
 *          triggering user's own llmux client key and the daemon that issued
 *          it, taken as an atomic pair so a mid-dispatch daemon flip can never
 *          combine one daemon's key with another's URL (the flip applies from
 *          the next dispatch, matching auth-runtime's "in-flight calls keep the
 *          env they were built with" contract). Without a tenant lease the live
 *          settings + shared key are used — what identity-less system
 *          dispatches run on (the legacy tenant).
 *
 * Contract:
 *   - NEVER mutates `process.env`.
 *   - Returns a new object each call; callers hold no aliases to a shared
 *     map, so parallel calls are trivially isolated.
 *   - In ccp mode, `CLAUDE_CODE_OAUTH_TOKEN` is set to `lease.accessToken`.
 *     For both current lease kinds (`setup_token`, `oauth_credentials`) this
 *     is the value the Agent SDK hands to the Claude CLI over OAuth.
 *   - In llmux mode, the `LLMUX_COMPETING_ENV_KEYS` credentials/provider
 *     selectors are removed after both layers, and `authorization` /
 *     `x-api-key` lines are filtered out of `ANTHROPIC_CUSTOM_HEADERS`.
 *   - No other `process.env` variable is copied: the operator-controlled
 *     additional env is the only way to hand an agent another one.
 *
 * Non-goals for this module (tracked in #575 PR-2 / v2.1):
 *   - `api_key` lease kind + `ANTHROPIC_API_KEY` env var.
 *   - `CLAUDE_CONFIG_DIR` credential-directory isolation.
 */
export function buildQueryEnv(lease: SlotAuthLease, opts?: QueryEnvOptions): QueryEnvResult {
  // Layer 1 — the part of the bot's environment an agent may have (never its secrets): a fresh record, so the
  // caller's map and process.env stay apart.
  const env = inheritedAgentEnv(process.env);

  // Layer 1b — the GitHub CLI credential (#834). This env is a copy taken once per turn, and the App installation token
  // lives an hour: a `gh` reading GITHUB_TOKEN from the copy fails with 401 once it expires (git does not — it re-reads
  // its config, which every refresh rewrites). While a bot-owned hosts.yml holds the live token, agent shells get its
  // dir instead of the frozen token — gh re-reads hosts.yml on every call. The operator's claude.env (layer 2) still
  // wins. Without one (a PAT setup, or a hosts.yml that could not be written), the bot's own GitHub token is passed
  // on: git and gh run as the bot on purpose — the one secret of the bot an agent is meant to use.
  const ghConfigDir = getAgentGhConfigDir();
  if (ghConfigDir) {
    env.GH_CONFIG_DIR = ghConfigDir;
  } else {
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
      const value = process.env[key];
      if (typeof value === 'string') env[key] = value;
    }
  }

  // Layer 2 — operator-controlled additional env. Already validated +
  // denylist-filtered by `parseClaudeEnv` at load time; values are guaranteed
  // strings. Overlays the inherited process.env.
  for (const [key, value] of Object.entries(_additionalEnv)) {
    env[key] = value;
  }

  // Hook-proxy opt-in. The zworkflow plugin's hook-proxy.sh defaults to the
  // self-contained shell call tracker (`HOOKS_PROXY_ENABLED` unset → standalone)
  // so external Claude Code installs work without a localhost service. soma-work
  // DOES run the Fastify hook service, so it opts spawned agents into the HTTP
  // proxy here. Only defaults when unset — an explicit process.env / operator
  // value (layers 1–2) still wins, e.g. for local debugging. Set before the
  // auth-backend branch so both llmux and ccp dispatches carry it.
  if (env.HOOKS_PROXY_ENABLED === undefined) {
    env.HOOKS_PROXY_ENABLED = 'true';
  }

  // Layer 3 — auth backend. Read from the RUNTIME state (auth-runtime.ts),
  // not static config: `auth llmux|cct` flips the mode live and the flip must
  // apply to the next dispatch without a restart. AUTH_MODE env remains the
  // boot-time default only.
  if (getAuthMode() === 'llmux') {
    // llmux mode: the local proxy (https://github.com/2lab-ai/llmux) owns the
    // real upstream account pool. Point the SDK at it with the caller's llmux
    // key and remove competing credentials/provider selectors from the child
    // environment. `lease.accessToken` is intentionally
    // unused here; the synthetic llmux lease carries the placeholder key for
    // symmetry only.
    // Per-user tenant credential when the dispatch knows who triggered it (so
    // llmux meters that user separately), else the live shared settings. URL
    // and key ALWAYS come from the same source — mixing a tenant key with a
    // different daemon's URL 401s instead of degrading to the shared key.
    const llmux = getLlmuxSettings();
    const tenant = opts?.llmuxTenant;
    env.ANTHROPIC_BASE_URL = tenant ? tenant.baseUrl : llmux.baseUrl;
    env.ANTHROPIC_API_KEY = tenant ? tenant.secret : llmux.apiKey;
    isolateLlmuxAuth(env);
    return { env };
  }

  // ccp mode (default) — lease token override. ALWAYS last. Defense in depth:
  // even if a future code path forgets to deny `CLAUDE_CODE_OAUTH_TOKEN` at
  // load time, the lease's fresh token wins here. process.env is never touched.
  env.CLAUDE_CODE_OAUTH_TOKEN = lease.accessToken;

  return { env };
}

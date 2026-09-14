/**
 * config.json loader.
 *
 * Reads the canonical config.json with all sections in one place:
 *   - mcpServers, server-tools, agents, claude.env, plugin, a2t.
 *
 * Legacy `mcp-servers.json` is no longer supported — it was a transient
 * format kept around during the merge into config.json (see git history).
 * Operators with a leftover `mcp-servers.json` should move its contents
 * under `mcpServers` in `config.json`.
 */

import { atomicWriteFile } from '@soma/common/atomic-write';
import * as fs from 'fs';
import type { A2tConfig } from './a2t/types';
import { RESERVED_LEASE_KEYS } from './auth/query-env-builder';
import { loadDotenvForConfig, substituteEnvVars, warnMissingPlaceholders } from './config-env-substitution';
import { Logger } from './logger';
import type { McpServerConfig } from './mcp/config-loader';
import { validatePluginConfig } from './plugin/config-parser';
import type { PluginConfig } from './plugin/types';
import { DEFAULT_UI_SURFACES } from './slack/surface-config';
import { normalizeSigningSecret, SIGNING_SECRET_MIN_LENGTH } from './slack-signing-secret';
import type { AgentConfig } from './types';

const logger = new Logger('ConfigLoader');

/**
 * Identifier regex for `claude.env` keys. Matches POSIX env-var conventions
 * (alpha/underscore start, alphanumeric/underscore continue). Anything else
 * is rejected at load time — operators get a warn so the typo is visible.
 */
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RESERVED_LEASE_KEYS_SET = new Set<string>(RESERVED_LEASE_KEYS);

/**
 * Process-scoped guard so the legacy `llmChat` warning fires at most once.
 * `loadConfig` is called on boot *and* every plugin-manager save, which
 * would otherwise double-log the same deprecation message within seconds.
 */
let warnedLegacyLlmChat = false;

/**
 * Process-scoped guard so the "seeded default ui" info log fires at most
 * once. Same rationale as `warnedLegacyLlmChat`: `loadConfig` runs at boot
 * *and* on every plugin-manager save (and once per agent config in
 * multi-agent setups) — the seed itself is idempotent per file, but the
 * log would otherwise repeat.
 */
let seededUiDefaults = false;

/**
 * Mode for every write of `config.json` in this module and in
 * {@link saveConfig}.
 *
 * All writers must agree. `somawork doctor` requires the profile's config to be
 * owner-only, and a single writer left at the umask default would hand the
 * operator an intermittent permission failure whose cause (a plugin save, a
 * `ui` seed) is invisible from the report.
 */
const CONFIG_FILE_MODE = 0o600;

/**
 * Mode for a config parent directory this module has to create. Never applied
 * to a directory that already exists — see {@link writeConfigFileAtomically}.
 */
const CONFIG_DIR_MODE = 0o700;

/**
 * Internal sentinel used to skip the `ui` seed under `readOnly` while reusing
 * that site's existing failure path, so the seed keeps exactly one exit. (The
 * legacy `llmChat` strip is skipped by an `if` guard instead, because its warn
 * has to be suppressed too.)
 */
class ReadOnlyConfigLoad extends Error {}

/**
 * The single writer for `config.json`. Every mutation of that file in this
 * module and in {@link saveConfig} goes through it.
 *
 * Delegates to the repository's hardened helper rather than re-implementing
 * temp-and-rename, which buys three things a bare `writeFileSync` + `rename`
 * did not have:
 *
 * - a **unique** temp name per call, so a stale `config.json.tmp` left by a
 *   crashed save (0644, from before this hardening) can never be reused and
 *   renamed over the live file;
 * - `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` plus an `fchmod` on the descriptor —
 *   `writeFileSync`'s `mode` is umask-masked and is ignored outright when the
 *   target already exists, so passing it was not the guarantee it looked like;
 * - `fsync` before the rename.
 *
 * `tightenExistingDir: false` opts out of the helper's tightening of a
 * PRE-EXISTING parent. That behaviour is right for a profile directory and
 * wrong here: `config.json` also lives at a repository root in the dev flow,
 * and silently chmod'ing the checkout from 0755 to 0700 is not a side effect a
 * config save may have.
 *
 * `dirMode` stays 0700 and is a separate decision — it is the mode a parent
 * this call has to CREATE gets, which happens on the `saveConfig` path when the
 * config directory does not exist yet. Spelling the opt-out as a permissive
 * `dirMode` conflated the two and landed such a directory at 0o7777
 * (world-writable, setuid/setgid/sticky) — strictly worse than the 0644 file
 * mode this writer exists to prevent, since `config.json`'s `mcpServers`
 * entries are command lines the runtime executes.
 *
 * `atomicWriteJson` is deliberately NOT used: it sorts object keys deeply,
 * which would reorder an operator's `config.json` on every seed/strip/save and
 * break `saveConfig`'s documented "2-space indent, insertion order" contract.
 */
function writeConfigFileAtomically(configFile: string, content: string): void {
  atomicWriteFile(configFile, content, {
    mode: CONFIG_FILE_MODE,
    dirMode: CONFIG_DIR_MODE,
    tightenExistingDir: false,
  });
}

export interface Config {
  mcpServers?: Record<string, McpServerConfig>;
  plugin?: PluginConfig;
  agents?: Record<string, AgentConfig>;
  a2t?: A2tConfig;
  /**
   * Operator-controlled env vars injected into every Claude Agent SDK
   * subprocess at `query()` time, equivalent to a shell `KEY=VALUE`
   * prefix on the `claude` invocation.
   *
   * The dotted JSON key (`"claude.env"`) is preserved verbatim so the file
   * round-trips through `plugin-manager.saveConfig` (which uses
   * `{...full, plugin: ...}` spread) without rename.
   *
   * Values in this Record are always strings — the parser stringifies
   * `number`/`boolean` JSON values and rejects everything else with a warn.
   */
  'claude.env'?: Record<string, string>;
  /**
   * UI surface composition overrides (thread header, turn-end card,
   * dashboard card header). Kept OPAQUE here — validation/normalization is
   * owned by `@soma/slack/surface-config` (`normalizeUiSurfacesConfig`),
   * installed once at boot via `setUiSurfacesConfig` in `src/index.ts`.
   * Schema + examples: docs/ui-surfaces.md; inspectable defaults:
   * config.default.json (repo root).
   *
   * The passthrough matters for round-trip safety: plugin-manager
   * (`src/plugin/plugin-manager.ts`) does `loadConfig` → spread →
   * `saveConfig`; without this key a plugin save would silently delete the
   * operator's ui config.
   *
   * NOTE: ui values are treated as LITERALS — `${VAR}` placeholders are NOT
   * substituted in `ui` (display-only config) and are preserved verbatim on
   * the saveConfig round-trip. This intentionally mirrors the llmChat-strip
   * rule below: never persist post-substitution values back to disk.
   */
  ui?: Record<string, unknown>;
}

/**
 * Validate and normalize the raw `config.json#claude.env` field into a
 * `Record<string, string>` ready to install via `setQueryEnvAdditional`.
 *
 * Rules (mirrored in unit tests):
 *   - The whole field must be a plain JSON object. `null`, arrays, strings,
 *     numbers → field ignored entirely with a warn.
 *   - Keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/` → otherwise drop entry.
 *   - Keys in `RESERVED_LEASE_KEYS` → drop entry with a warn ("operator
 *     footgun guard"). The lease/auth path owns those slots.
 *   - Values: `string` (verbatim, including empty string for "unset"
 *     intent), `boolean` (→ `"true"` / `"false"`), finite `number`
 *     (→ `String(n)`). Everything else (`null`, `undefined`, object, array,
 *     `NaN`, `Infinity`, `bigint`, `symbol`, `function`) → drop with warn.
 *
 * Logging contract: warnings include only the offending KEY name, never
 * the value. Operators may misconfigure secrets here; logs MUST NOT leak
 * them. `config-loader.test.ts` enforces this with a regex.
 */
export function parseClaudeEnv(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn(`Ignoring config.json#"claude.env": expected a JSON object, got ${describeKind(raw)}`);
    return undefined;
  }

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_KEY_REGEX.test(key)) {
      logger.warn(`Skipping claude.env entry: invalid env key (key=${key})`);
      continue;
    }
    if (RESERVED_LEASE_KEYS_SET.has(key)) {
      logger.warn(`Skipping claude.env entry: ${key} is reserved (auth/provider/proxy slot owned by lease)`);
      continue;
    }
    const coerced = coerceEnvValue(value);
    if (coerced === null) {
      // describeKind never reads the value contents — only its typeof — so
      // string contents (which may be a secret) never reach the log.
      logger.warn(`Skipping claude.env entry: invalid value type (key=${key}, type=${describeKind(value)})`);
      continue;
    }
    result[key] = coerced;
  }

  return result;
}

/**
 * Stringify a JSON value for env injection, or return `null` to signal
 * "drop this entry." Empty string IS allowed — operators may want to clear
 * an inherited process.env value; layer 2 of `buildQueryEnv` writes
 * `env[KEY] = ''` which is forwarded to the spawn.
 */
function coerceEnvValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  return null;
}

/**
 * Describe a JSON value's shape WITHOUT echoing its contents — used in
 * warn messages. Returns one of: 'null', 'undefined', 'array', 'object',
 * 'string', 'number', 'boolean', 'bigint', 'symbol', 'function', 'NaN',
 * 'Infinity'. Never includes the actual value, so secrets cannot leak.
 */
function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') {
    if (Number.isNaN(value as number)) return 'NaN';
    if (!Number.isFinite(value as number)) return 'Infinity';
  }
  return t;
}

/**
 * Tagged-union return for validators below. Surfacing the failure as data
 * (rather than throwing) lets `parseAgentsConfig` apply the skip-on-warn
 * rule without try/catch noise: one bad agent must not poison sibling
 * agents — Trace: docs/current/plans/multi-agent/trace.md, Scenario 1.
 */
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Required tokens an agent must declare (string-typed).
 * Listed explicitly to keep `extractRequiredString` callers type-safe.
 *
 * `signingSecret` is NOT here: it verifies the `X-Slack-Signature` header on
 * HTTP delivery, and every agent runs Socket Mode (outbound wss keyed by
 * `slackAppToken`). It is handled by `extractOptionalSigningSecret` instead.
 */
type RequiredAgentStringKey = 'slackBotToken' | 'slackAppToken';

/**
 * Pull a required string field off a raw agent entry, optionally enforcing
 * a fixed prefix (Slack token format) and/or a minimum length. The two
 * failure modes produce distinct warnings on purpose:
 *   - presence / type / min-length     → 'missing or invalid <key>[ (min N chars)]'
 *   - prefix mismatch                  → "<key> must start with '<prefix>-'"
 *
 * The original `parseAgentsConfig` (cog 30) ran these checks inline; the
 * exact wording is part of the contract pinned by the characterization
 * tests in `src/__tests__/config-loader.test.ts`.
 */
function extractRequiredString(
  name: string,
  agent: Record<string, unknown>,
  key: RequiredAgentStringKey,
  opts?: { prefix?: string; minLength?: number },
): Result<string, string> {
  const value = agent[key];
  const minLength = opts?.minLength ?? 0;

  if (!value || typeof value !== 'string' || value.length < minLength) {
    const suffix = minLength > 0 ? ` (min ${minLength} chars)` : '';
    return { ok: false, error: `Skipping agent '${name}': missing or invalid ${key}${suffix}` };
  }

  if (opts?.prefix && !value.startsWith(opts.prefix)) {
    return {
      ok: false,
      error: `Skipping agent '${name}': ${key} must start with '${opts.prefix}'`,
    };
  }

  return { ok: true, value };
}

/**
 * Read the OPTIONAL per-agent `signingSecret`.
 *
 * Absent (`undefined` / `null` / key omitted) is valid — Socket Mode never
 * verifies a request signature, so an agent without a secret still loads. A
 * value that IS declared must be plausible, so a wrong type, a blank string,
 * or fewer than `SIGNING_SECRET_MIN_LENGTH` characters skips the agent.
 *
 * The warning text intentionally matches `extractRequiredString`'s wording so
 * operator-facing diagnostics stay uniform; it reports the key and the
 * minimum, never the declared value.
 */
function extractOptionalSigningSecret(
  name: string,
  agent: Record<string, unknown>,
): Result<string | undefined, string> {
  const value = agent.signingSecret;
  if (value === undefined || value === null) return { ok: true, value: undefined };

  const normalized = typeof value === 'string' ? normalizeSigningSecret(value) : undefined;
  if (normalized === undefined || normalized.length < SIGNING_SECRET_MIN_LENGTH) {
    return {
      ok: false,
      error: `Skipping agent '${name}': missing or invalid signingSecret (min ${SIGNING_SECRET_MIN_LENGTH} chars)`,
    };
  }
  return { ok: true, value: normalized };
}

/**
 * Read an optional string field, returning `fallback` when the field is
 * absent, non-string, OR empty. Used for `promptDir` / `persona`: an empty
 * value here would silently overwrite the documented default, so we treat
 * it as "unset."
 */
function optionalStringWithFallback(agent: Record<string, unknown>, key: string, fallback: string): string {
  const value = agent[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Read an optional string field, returning `undefined` only when the field
 * is absent or non-string. Empty strings are preserved verbatim — used for
 * `description` / `model`, which are allowed to be deliberately blank.
 *
 * The asymmetry vs. `optionalStringWithFallback` is intentional and pinned
 * by tests in `config-loader.test.ts`.
 */
function optionalString(agent: Record<string, unknown>, key: string): string | undefined {
  const value = agent[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validate one raw agent entry and assemble the typed `AgentConfig`.
 * Validation order is fixed (slackBotToken → slackAppToken → signingSecret)
 * because the first-failing rule decides the warning text — reordering
 * would silently change diagnostics seen by operators. `signingSecret` is
 * optional (Socket Mode needs no request-signature verification) but is still
 * validated last when declared, so the order above is unchanged.
 *
 * Optional fields fall back to defaults documented on `AgentConfig`:
 *   - promptDir → `src/prompt/${name}`     (empty string ⇒ fallback)
 *   - persona   → 'default'                (empty string ⇒ fallback)
 *   - description / model → undefined when absent or non-string
 *                          (empty string preserved verbatim)
 */
function validateAgentConfig(name: string, raw: unknown): Result<AgentConfig, string> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `Skipping agent '${name}': invalid entry (not an object)` };
  }
  const agent = raw as Record<string, unknown>;

  const bot = extractRequiredString(name, agent, 'slackBotToken', { prefix: 'xoxb-' });
  if (!bot.ok) return bot;
  const app = extractRequiredString(name, agent, 'slackAppToken', { prefix: 'xapp-' });
  if (!app.ok) return app;
  const signing = extractOptionalSigningSecret(name, agent);
  if (!signing.ok) return signing;

  return {
    ok: true,
    value: {
      slackBotToken: bot.value,
      slackAppToken: app.value,
      // Omit the key entirely when undeclared — `AgentConfig.signingSecret` is
      // optional, and a config object that never carries a declared-but-empty
      // secret stays unambiguous when serialized, diffed, or logged.
      ...(signing.value !== undefined ? { signingSecret: signing.value } : {}),
      promptDir: optionalStringWithFallback(agent, 'promptDir', `src/prompt/${name}`),
      persona: optionalStringWithFallback(agent, 'persona', 'default'),
      description: optionalString(agent, 'description'),
      model: optionalString(agent, 'model'),
    },
  };
}

/**
 * Parse and validate the agents section from raw config JSON.
 * Invalid agents are skipped with a warning (not fatal).
 * Trace: docs/current/plans/multi-agent/trace.md, Scenario 1
 */
export function parseAgentsConfig(raw: any): Record<string, AgentConfig> {
  const result: Record<string, AgentConfig> = {};

  if (!raw?.agents || typeof raw.agents !== 'object') {
    return result;
  }

  for (const [name, entry] of Object.entries(raw.agents)) {
    const validated = validateAgentConfig(name, entry);
    if (validated.ok) {
      result[name] = validated.value;
    } else {
      logger.warn(validated.error);
    }
  }

  const names = Object.keys(result);
  if (names.length > 0) {
    logger.info(`Loaded ${names.length} agent configurations: [${names.join(', ')}]`);
  }

  return result;
}

/**
 * Load the application config from `config.json`.
 *
 * @param configFile  Absolute path to `config.json` (resolved by env-paths.ts).
 *
 * Returns an empty `Config` if the file is missing or unparseable — boot
 * continues so a broken config doesn't bring the whole service down before
 * the operator can see the warning.
 */
/**
 * Additive options for {@link loadConfig}.
 *
 * Both fields exist for one caller shape: an inspector that loads *another*
 * profile's `config.json` and must neither mutate `process.env` nor re-derive
 * the placeholder grammar to find out what did not resolve.
 */
export interface LoadConfigOptions {
  /**
   * Environment used to resolve `${VAR}` placeholders. When present, the
   * `.env` auto-discovery step is skipped (see the body) so this load has no
   * ambient side effect at all. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Receives the names of bare `${VAR}` placeholders that had no value. The
   * existing warn-once logging still happens; this is the programmatic view
   * the same pass already computes.
   */
  onMissingPlaceholders?: (missing: string[]) => void;
  /**
   * Inspect without mutating. Suppresses the two on-disk rewrites this
   * function otherwise performs (the `ui` seed and the legacy `llmChat`
   * strip) and the operator-facing success/miss logs.
   *
   * Defaults to `true` whenever `env` is supplied: a caller that brings its
   * own environment is by definition inspecting some *other* process's
   * config, and seeding or stripping a profile you were only asked to
   * diagnose is a mutation the caller never requested.
   */
  readOnly?: boolean;
  /**
   * Invoked when the load fails.
   *
   * Without it a failure is swallowed into `{}` — correct for the runtime
   * (boot with defaults beats crash-looping) and a false green for an
   * inspector, which cannot otherwise distinguish "config is empty" from
   * "config threw". Notably `${VAR:?}` throws inside `substituteEnvVars`
   * *before* {@link LoadConfigOptions.onMissingPlaceholders} can fire, so
   * the missing list is not a sufficient failure signal on its own.
   */
  onError?: (error: unknown) => void;
}

/** Outcome of {@link inspectConfig}. */
export interface ConfigInspection {
  /** False when the file is absent or the load threw for any reason. */
  loaded: boolean;
  /** Bare `${VAR}` placeholders that did not resolve. */
  missing: string[];
  /** The parsed config, or `null` when `loaded` is false. */
  config: Config | null;
}

/**
 * Load `configFile` for inspection: no disk mutation, no ambient `process.env`
 * mutation, no operator logs, and failures reported instead of swallowed.
 *
 * This is the shape a gate needs. `loadConfig` deliberately degrades to `{}` so
 * the runtime boots; a checker that reuses it without this wrapper reports
 * "config parses and resolves" for a config the runtime just failed to load.
 */
export function inspectConfig(configFile: string, opts: { env?: NodeJS.ProcessEnv } = {}): ConfigInspection {
  let missing: string[] = [];
  let failed = false;
  const config = loadConfig(configFile, {
    env: opts.env,
    readOnly: true,
    onMissingPlaceholders: (names) => {
      missing = names;
    },
    onError: () => {
      failed = true;
    },
  });
  return failed ? { loaded: false, missing, config: null } : { loaded: true, missing, config };
}

export function loadConfig(configFile: string, opts: LoadConfigOptions = {}): Config {
  // An explicit flag wins; otherwise supplying `env` implies inspection.
  const readOnly = opts.readOnly ?? opts.env !== undefined;
  if (fs.existsSync(configFile)) {
    try {
      // .env discovery (per-call, deduped per-process):
      //   cwd → dirname(configFile) → parent of dirname(configFile)
      // dotenv default behavior is "first writer wins" so this priority
      // order matches the docs/operator mental model.
      //
      // Skipped for BOTH inspection signals, not just `env`. `dotenv.config()`
      // writes the discovered file's variables into the ambient `process.env`,
      // which is the exact global mutation an out-of-process inspector
      // (`somawork doctor`) must not perform on a profile it is only reading —
      // and `readOnly` is that promise regardless of whether the caller also
      // brought an env map. Keying this on `env` alone left
      // `inspectConfig(file)` and `loadConfig(file, {readOnly:true})` silently
      // mutating `process.env` while their contract said otherwise.
      if (opts.env === undefined && !readOnly) {
        loadDotenvForConfig(configFile);
      }

      const rawParsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      // Substitute `${VAR}` placeholders in every string leaf BEFORE the
      // structural validators run — so a placeholder for `slackBotToken`
      // (which must start with `xoxb-`) is checked against the resolved
      // value, not the literal `${SLACK_BOT_TOKEN}` text.
      const { value: raw, missing } = substituteEnvVars(rawParsed, { env: opts.env });
      opts.onMissingPlaceholders?.(missing);
      if (!readOnly) warnMissingPlaceholders(missing, configFile);
      const result: Config = {};

      if (raw.mcpServers && typeof raw.mcpServers === 'object') {
        result.mcpServers = raw.mcpServers;
      }

      if (raw.plugin) {
        result.plugin = validatePluginConfig(raw.plugin);
      }

      // Parse agents section (Trace: docs/current/plans/multi-agent/trace.md, S1)
      const agents = parseAgentsConfig(raw);
      if (Object.keys(agents).length > 0) {
        result.agents = agents;
      }

      // Parse A2T (audio-to-text) config section
      if (raw.a2t && typeof raw.a2t === 'object') {
        result.a2t = raw.a2t as A2tConfig;
      }

      // Parse claude.env — operator-controlled env vars injected into every
      // Claude Agent SDK subprocess. Validated + denylist-filtered;
      // warnings log keys only (never values).
      const claudeEnv = parseClaudeEnv(raw['claude.env']);
      if (claudeEnv && Object.keys(claudeEnv).length > 0) {
        result['claude.env'] = claudeEnv;
      }

      // Pass through `ui` (surface composition) opaquely — deep validation
      // happens in @soma/slack/surface-config at install time. Only the
      // "plain object" shape is checked here; arrays/strings are dropped so
      // a malformed value cannot poison the saveConfig round-trip.
      //
      // CRITICAL: take `ui` from `rawParsed` (PRE-substitution), never from
      // `raw` (post-`substituteEnvVars`). `ui` is display-only config, so
      // `${VAR}` placeholders are treated as literals and preserved verbatim.
      // Using the substituted object would make plugin-manager `saveConfig`
      // persist RESOLVED env values to disk — a secret disclosure and a
      // round-trip corruption that breaks env rotation (same hazard class as
      // the llmChat strip below).
      const rawUi = (rawParsed as Record<string, unknown>).ui;
      if (rawUi && typeof rawUi === 'object' && !Array.isArray(rawUi)) {
        result.ui = rawUi as Record<string, unknown>;
      } else if (rawUi !== undefined) {
        logger.warn(`Ignoring config.json#"ui": expected a JSON object, got ${describeKind(rawUi)}`);
      } else {
        // Seed the built-in UI surface defaults INTO config.json when the
        // `ui` key is absent (user requirement: "디폴트 설정을 config.json에
        // 넣어줘") — operators then see and edit the full default composition
        // directly in their config file instead of hunting for
        // config.default.json. Seeded only when the key is missing, so an
        // operator-customized (or deliberately emptied `{}`) `ui` is never
        // overwritten and future boots are no-ops.
        //
        // Same atomic tmp+rename pattern as the llmChat strip below, and the
        // same pre-substitution rule: spread `rawParsed` so every `${VAR}`
        // placeholder elsewhere in the file survives verbatim.
        // `DEFAULT_UI_SURFACES` itself is pure literal JSON data containing
        // no `${VAR}` placeholders, so writing it to disk cannot interact
        // with env substitution on future loads.
        // Reflect the seed into `rawParsed` BEFORE the write attempt: the
        // legacy llmChat strip below re-writes the file from `rawParsed`,
        // and a losing process in a concurrent-boot rename race would
        // otherwise strip llmChat from an UNSEEDED object — persisting a
        // file with no `ui` (codex review, PR #1270, rounds 1–2). Setting it
        // up-front makes every later rewrite in this load carry the seed,
        // even when this process's own seed write loses the race or fails.
        (rawParsed as Record<string, unknown>).ui = DEFAULT_UI_SURFACES;
        result.ui = JSON.parse(JSON.stringify(DEFAULT_UI_SURFACES)) as Record<string, unknown>;
        // The in-memory seed above still applies under `readOnly` — the caller
        // asked what the runtime would see. Only the disk write is skipped.
        try {
          if (readOnly) throw new ReadOnlyConfigLoad();
          writeConfigFileAtomically(configFile, `${JSON.stringify(rawParsed, null, 2)}\n`);
          if (!seededUiDefaults) {
            seededUiDefaults = true;
            logger.info('Seeded default `ui` surface settings into config.json', { path: configFile });
          }
        } catch (seedError) {
          // Not seeding under `readOnly` is the requested behaviour, not a
          // failure. Everything else is: seed failed (disk full, permissions)
          // — non-fatal, since the built-in defaults still apply at runtime
          // via the surface-config fallback.
          if (!(seedError instanceof ReadOnlyConfigLoad)) {
            logger.warn('Failed to seed default `ui` settings into config.json', {
              path: configFile,
              error: (seedError as Error).message,
            });
          }
        }
      }

      // PR #639 removed the `llmChat` subsystem (prompt-builder snippet,
      // llmChatConfigStore, Slack LlmChatHandler). Legacy configs still
      // carrying `llmChat` keep working but the key is silently dropped on
      // the next saveConfig round-trip; warn so upgraded users see a
      // trace rather than discovering the drop via vanished data. The flag
      // is process-scoped because this loader runs at boot *and* on every
      // plugin-manager save.
      //
      // Issue #1014: relying on "the next saveConfig" leaves the key in place
      // indefinitely for workspaces that never trigger a plugin-manager
      // operation between restarts — the same warn then fires once per
      // process for the lifetime of the deployment (production grep: 55x in
      // a single rotation). Eagerly strip the key from the on-disk JSON now
      // so the warn becomes a one-shot migration event rather than chronic
      // noise.
      //
      // CRITICAL: strip from `rawParsed` (pre-substitution), NEVER from
      // `raw` (post-`substituteEnvVars`). Writing `raw` back would persist
      // resolved secret values (e.g. a `"${JIRA_PAT_TOKEN}"` placeholder
      // would land on disk as `"Basic <actual-token>"`) — both a secret
      // disclosure on the filesystem and a round-trip corruption that
      // breaks future env-driven rotation. By rewriting `rawParsed` we
      // preserve every `${VAR}` placeholder verbatim and keep all unknown
      // future top-level keys.
      // `readOnly` skips the whole block, warn included: the message promises
      // "Stripping from config.json now", which an inspector does not do, and
      // firing it here would additionally burn the process-scoped warn-once
      // flag so a later real load in this process stays silent about it.
      if (raw.llmChat !== undefined && !warnedLegacyLlmChat && !readOnly) {
        warnedLegacyLlmChat = true;
        logger.warn(
          'Ignoring legacy `llmChat` config key — subsystem removed in PR #639. ' +
            'Stripping from config.json now (issue #1014).',
          { path: configFile },
        );

        try {
          // Spread the PRE-SUBSTITUTION object so `${VAR}` placeholders
          // remain placeholders in the on-disk rewrite.
          const cleaned: Record<string, unknown> = { ...(rawParsed as Record<string, unknown>) };
          delete cleaned.llmChat;
          // If two processes race here they each write identical content; the
          // last rename wins and the result is idempotent.
          writeConfigFileAtomically(configFile, `${JSON.stringify(cleaned, null, 2)}\n`);
          logger.info('Stripped legacy `llmChat` key from config.json', { path: configFile });
        } catch (writeError) {
          // Strip failed (disk full, permissions) — don't fail the load. The
          // warn already informed operators and the next plugin-manager save
          // still drops the key via the existing path.
          logger.warn('Failed to strip legacy `llmChat` key from config.json', {
            path: configFile,
            error: (writeError as Error).message,
          });
        }
      }

      if (!readOnly) {
        logger.info('Loaded config', {
          path: configFile,
          mcpServers: result.mcpServers ? Object.keys(result.mcpServers).length : 0,
          hasPluginConfig: !!result.plugin,
          agents: result.agents ? Object.keys(result.agents).length : 0,
          hasA2t: !!result.a2t,
          hasUi: !!result.ui,
          // keys-only — never log the values
          claudeEnvKeys: result['claude.env'] ? Object.keys(result['claude.env']) : [],
        });
      }

      return result;
    } catch (error) {
      if (!readOnly) {
        logger.error('Failed to parse config', {
          path: configFile,
          error: (error as Error).message,
        });
      }
      // Reported, then still degraded to `{}`: the runtime's boot-with-defaults
      // behaviour is unchanged for every caller that does not pass `onError`.
      opts.onError?.(error);
      return {};
    }
  }

  if (!readOnly) logger.warn('config.json not found', { path: configFile });
  opts.onError?.(new Error('config.json not found'));
  return {};
}

/**
 * Save config to config.json using atomic write.
 *
 * Writes to a temporary file first, then renames to the target path.
 * This prevents corruption if the process crashes mid-write.
 *
 * @param configFile  Absolute path to config.json
 * @param config      The Config to persist
 */
export function saveConfig(configFile: string, config: Config): void {
  writeConfigFileAtomically(configFile, JSON.stringify(config, null, 2) + '\n');
  logger.info('Saved config', { path: configFile });
}

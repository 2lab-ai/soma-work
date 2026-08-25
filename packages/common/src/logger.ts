/**
 * Logger with configurable levels and categories
 *
 * Environment variables:
 * - LOG_LEVEL: error | warn | info | debug (default: info)
 * - LOG_CATEGORIES: comma-separated list of categories to show (empty = all)
 * - LOG_MUTE: comma-separated list of categories to hide
 */

// ---------------------------------------------------------------------------
// Secret redaction — the single owner for every credential shape this repo
// knows about. `redactSecrets` is the implementation; `redactAnthropicSecrets`
// is the historical name kept as an alias so existing call sites (token
// manager, admin handler, stream executor) keep working while gaining the
// wider coverage. Never add a second regex set elsewhere: a redactor that only
// some sinks use is a redactor that leaks.
// ---------------------------------------------------------------------------

/**
 * Regex matching Anthropic API credentials.
 *
 * Recognised kinds, by their `sk-ant-…` infix: `oat01` (OAuth access token),
 * `ort01` (OAuth refresh token), `api03` (API key), `admin01` (admin key).
 *
 * Written that way on purpose. This file compiles into the runtime bundle, and
 * the bundle smoke (`scripts/smoke/setup-package.js`) scans every staged text
 * file for credential shapes with **no allowlist** — an allowlist for
 * credential-shaped bytes is a permanent blind spot. A doc comment carrying a
 * full `sk-ant-<kind>-<body>` example would be the one entry that list needed,
 * so the example is described rather than spelled.
 *
 * Only the 8+ character suffix body is matched (A-Z, a-z, 0-9, _, -).
 */
const ANTHROPIC_SECRET_RE = /\bsk-ant-(oat01|ort01|api03|admin01)-[A-Za-z0-9_-]{8,}\b/g;

/**
 * llmux client-key secrets (`lmk-…`) — per-user tenant keys issued by the
 * llmux daemon (src/auth/llmux-tenant-keys.ts). They authenticate against the
 * llmux proxy exactly like an API key, so a logged one is a leaked one; the
 * DM path is the only sanctioned carrier. Same shape rules as above.
 */
const LLMUX_KEY_RE = /\blmk-[A-Za-z0-9_-]{8,}\b/g;

/**
 * Slack refresh/rotation tokens. Matched *before* the plain `xox?-` family
 * because `xoxe.xoxp-…` embeds an `xoxp-` token: without this ordering the
 * inner match would leave the `xoxe.` prefix dangling in the output.
 */
const SLACK_ROTATION_TOKEN_RE = /\bxoxe[.-][A-Za-z0-9._-]{8,}/g;

/** Slack bot/user/app/legacy tokens (`xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-`). */
const SLACK_TOKEN_RE = /\bxox([bpars])-[A-Za-z0-9-]{8,}/g;

/** Slack app-level (Socket Mode) tokens. */
const SLACK_APP_TOKEN_RE = /\bxapp-[A-Za-z0-9-]{8,}/g;

/**
 * Socket Mode WebSocket URLs. `apps.connections.open` returns a `wss://` URL
 * whose query string *is* the credential, so the whole URL is redacted rather
 * than parsed. The character class deliberately stops at quotes/brackets so a
 * URL embedded in JSON does not swallow its closing delimiter.
 */
const WSS_URL_RE = /\bwss:\/\/[^\s"'`<>\\)\]}]+/gi;

/**
 * Unambiguous credential key names in `key=value`, `key: value` and
 * `"key": "value"` forms. These names carry no non-secret meaning, so an 8+
 * character value next to one is always redacted.
 */
const OAUTH_KV_RE =
  /\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|bot[_-]?token|app[_-]?token)\b(["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{8,})/gi;

/**
 * OAuth authorization codes. `code` *is* an ordinary word (`exit code 3`,
 * `{"code":"ENOENT"}`), so this pattern is deliberately narrow: a key/value
 * separator, a 20+ character value, and a value that is not a SCREAMING_SNAKE
 * error identifier. Anything looser redacts debugging information.
 */
const OAUTH_CODE_KV_RE = /\b(code)(["']?\s*[:=]\s*["']?)([A-Za-z0-9._~-]{20,})/gi;
const ERROR_IDENTIFIER_RE = /^[A-Z][A-Z0-9_]*$/;

/** Options for {@link redactSecrets}. */
export interface RedactOptions {
  /**
   * Values that are secret only for this call — a Slack auth ticket, a
   * challenge code, a provider one-time token. They have no recognisable
   * shape, so the caller must register them explicitly; every occurrence is
   * replaced with `[REDACTED ephemeral]`. Matched literally, not as a regex.
   */
  ephemeralValues?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactString(value: string, ephemeral: readonly string[]): string {
  let out = value;

  // Ephemeral values first: they are arbitrary strings that may contain (or be
  // contained by) a shaped token, and losing them is the worst outcome.
  for (const secret of ephemeral) {
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED ephemeral]');
  }

  return out
    .replace(ANTHROPIC_SECRET_RE, (match, kind: string) => `[REDACTED sk-ant-${kind}-...${match.slice(-4)}]`)
    .replace(LLMUX_KEY_RE, (match) => `[REDACTED lmk-...${match.slice(-4)}]`)
    .replace(SLACK_ROTATION_TOKEN_RE, (match) => `[REDACTED xoxe-...${match.slice(-4)}]`)
    .replace(SLACK_TOKEN_RE, (match, kind: string) => `[REDACTED xox${kind}-...${match.slice(-4)}]`)
    .replace(SLACK_APP_TOKEN_RE, (match) => `[REDACTED xapp-...${match.slice(-4)}]`)
    .replace(WSS_URL_RE, '[REDACTED wss-url]')
    .replace(OAUTH_KV_RE, (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`)
    .replace(OAUTH_CODE_KV_RE, (match, key: string, sep: string, value: string) =>
      ERROR_IDENTIFIER_RE.test(value) ? match : `${key}${sep}[REDACTED]`,
    );
}

/**
 * Deep-clone `input` and redact every known credential shape found in strings.
 *
 * Covered: Anthropic `sk-ant-*`, llmux `lmk-*`, Slack `xoxb/xoxp/xoxa/xoxr/
 * xoxs`, `xapp-*` and `xoxe.`/`xoxe-` rotation tokens, Socket Mode `wss://`
 * URLs, unambiguous OAuth key/value pairs (`access_token`, `refresh_token`,
 * `client_secret`, `signing_secret`, `bot_token`, `app_token`), long OAuth
 * authorization `code=` values, and any {@link RedactOptions.ephemeralValues}
 * the caller registered for this call.
 *
 * - Objects and arrays are cloned; nested strings are redacted recursively.
 * - Other primitives (`number`, `boolean`, `null`, `undefined`, `bigint`,
 *   `symbol`) are returned as-is.
 * - Circular references are short-circuited via an internal `WeakSet` and
 *   replaced with a `"[Circular]"` sentinel to avoid infinite recursion.
 * - The caller's input is never mutated.
 */
export function redactSecrets(input: unknown, options?: RedactOptions): unknown {
  const ephemeral = (options?.ephemeralValues ?? []).filter((v) => typeof v === 'string' && v.length > 0);
  return redactValue(input, new WeakSet<object>(), ephemeral);
}

/**
 * Historical name for {@link redactSecrets}, kept so existing call sites keep
 * compiling. It is the same function, not a narrower one: callers that only
 * expected Anthropic coverage now also get Slack/OAuth coverage, which is
 * strictly safer for a log sink.
 */
export function redactAnthropicSecrets(input: unknown): unknown {
  return redactSecrets(input);
}

function redactValue(value: unknown, seen: WeakSet<object>, ephemeral: readonly string[]): unknown {
  if (typeof value === 'string') {
    return redactString(value, ephemeral);
  }

  if (value === null || typeof value !== 'object') {
    // number, boolean, undefined, bigint, symbol, function → passthrough
    return value;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);

  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = redactValue(value[i], seen, ephemeral);
    }
    return out;
  }

  // Plain object: copy own enumerable keys.
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    out[key] = redactValue(src[key], seen, ephemeral);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Console wrapper — installs redaction on the global console once.
// ---------------------------------------------------------------------------

type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug' | 'trace';
const CONSOLE_METHODS: readonly ConsoleMethod[] = ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const;

// Brand marker so we can detect an already-installed wrapper and stay idempotent.
const REDACTION_BRAND = Symbol.for('soma-work.logger.redactionWrapped');

type BrandedFn = ((...args: unknown[]) => void) & { [REDACTION_BRAND]?: true };

/**
 * Replace the global `console.{log,warn,error,info,debug,trace}` with
 * wrappers that run every argument through {@link redactSecrets}
 * before delegating to the original method.
 *
 * Idempotent — calling more than once is a no-op after the first install.
 * Must be invoked explicitly by caller code; importing this module does not
 * auto-install.
 */
export function installConsoleRedaction(): void {
  for (const method of CONSOLE_METHODS) {
    const current = console[method] as BrandedFn | undefined;
    if (!current || current[REDACTION_BRAND] === true) {
      continue;
    }
    const original = current.bind(console);
    const wrapped: BrandedFn = (...args: unknown[]) => {
      const redacted = args.map((a) => redactSecrets(a));
      original(...redacted);
    };
    wrapped[REDACTION_BRAND] = true;
    console[method] = wrapped as (typeof console)[typeof method];
  }
}

// Log levels (lower = more important)
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

// Parse environment config
function getLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase();
  if (level && level in LOG_LEVELS) {
    return level as LogLevel;
  }
  return process.env.DEBUG === 'true' ? 'debug' : 'info';
}

function getEnabledCategories(): Set<string> | null {
  const cats = process.env.LOG_CATEGORIES;
  if (!cats) return null; // null = all enabled
  return new Set(cats.split(',').map((c) => c.trim().toLowerCase()));
}

function getMutedCategories(): Set<string> {
  const cats = process.env.LOG_MUTE || '';
  return new Set(
    cats
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Cached config
let cachedLevel: LogLevel | null = null;
let cachedEnabled: Set<string> | null | undefined;
let cachedMuted: Set<string> | null = null;

function getConfig() {
  if (cachedLevel === null) {
    cachedLevel = getLogLevel();
    cachedEnabled = getEnabledCategories();
    cachedMuted = getMutedCategories();
  }
  return { level: cachedLevel, enabled: cachedEnabled, muted: cachedMuted! };
}

// Reset cache (for testing or dynamic config)
function resetLoggerConfig() {
  cachedLevel = null;
  cachedEnabled = undefined;
  cachedMuted = null;
}

/**
 * `JSON.stringify` that never throws.
 *
 * Fast path is a plain `JSON.stringify` so serializable payloads keep byte-
 * identical output. Only when that throws (circular structure, BigInt) does
 * the cycle-guard replacer run, substituting `"[Circular]"` for re-visited
 * objects. A log call must never take down its caller: a circular object in
 * a debug payload (an in-process SDK MCP server instance inside stream
 * options — ajv SchemaEnv's `root` self-reference) failed every Slack turn
 * on 2026-07-10.
 */
export function safeJsonStringify(data: unknown, space?: number): string {
  try {
    const out = JSON.stringify(data, undefined, space);
    return out === undefined ? String(data) : out;
  } catch {
    // Fallback replacer. The WeakSet marks every visited object, so shared
    // (non-cyclic) references also collapse to "[Circular]" — acceptable for
    // a log line that would previously have crashed the process.
    const seen = new WeakSet<object>();
    try {
      const out = JSON.stringify(
        data,
        (_key, value) => {
          if (typeof value === 'bigint') return `${value}n`;
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
          }
          return value;
        },
        space,
      );
      return out === undefined ? String(data) : out;
    } catch (err) {
      return `[Unserializable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}]`;
    }
  }
}

export class Logger {
  private context: string;
  private contextLower: string;

  constructor(context: string) {
    this.context = context;
    this.contextLower = context.toLowerCase();
  }

  private shouldLog(level: LogLevel): boolean {
    const config = getConfig();

    // Check level threshold
    if (LOG_LEVELS[level] > LOG_LEVELS[config.level]) return false;

    // Check if category is muted
    if (config.muted.has(this.contextLower)) return false;

    // Check if category is enabled (when filter is active)
    if (config.enabled && !config.enabled.has(this.contextLower)) return false;

    return true;
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const levelPadded = level.toUpperCase().padEnd(5);
    const prefix = `[${timestamp}] [${levelPadded}] [${this.context}]`;

    if (data && Object.keys(data).length > 0) {
      // Compact single-line JSON for simple objects
      const jsonStr = safeJsonStringify(data);
      if (jsonStr.length < 100) {
        return `${prefix} ${message} ${jsonStr}`;
      }
      return `${prefix} ${message}\n${safeJsonStringify(data, 2)}`;
    }
    return `${prefix} ${message}`;
  }

  debug(message: string, data?: any) {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: any) {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  warn(message: string, data?: any) {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  error(message: string, error?: any) {
    if (this.shouldLog('error')) {
      const errorData =
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack?.split('\n').slice(0, 3).join('\n'),
            }
          : error;
      console.error(this.formatMessage('error', message, errorData));
    }
  }
}

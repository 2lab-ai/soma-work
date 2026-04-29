/**
 * Logger with configurable levels and categories
 *
 * Environment variables:
 * - LOG_LEVEL: error | warn | info | debug (default: info)
 * - LOG_CATEGORIES: comma-separated list of categories to show (empty = all)
 * - LOG_MUTE: comma-separated list of categories to hide
 */

// ---------------------------------------------------------------------------
// Anthropic secret redaction
// ---------------------------------------------------------------------------

/**
 * Regex matching Anthropic API credentials.
 *
 * Recognised kinds:
 *   - sk-ant-oat01-...    (OAuth access token)
 *   - sk-ant-ort01-...    (OAuth refresh token)
 *   - sk-ant-api03-...    (API key)
 *   - sk-ant-admin01-...  (admin key)
 *
 * Only the 8+ character suffix body is matched (A-Z, a-z, 0-9, _, -).
 */
const ANTHROPIC_SECRET_RE = /\bsk-ant-(oat01|ort01|api03|admin01)-[A-Za-z0-9_-]{8,}\b/g;

function redactString(value: string): string {
  // Reset lastIndex is unnecessary when using String.replace with a /g regex,
  // but spelling it out avoids surprises if we ever switch to exec().
  return value.replace(ANTHROPIC_SECRET_RE, (match, kind: string) => {
    const last4 = match.slice(-4);
    return `[REDACTED sk-ant-${kind}-...${last4}]`;
  });
}

/**
 * Deep-clone and redact any Anthropic secrets found in strings.
 *
 * - Strings are scanned with {@link ANTHROPIC_SECRET_RE} and each match is
 *   replaced by `[REDACTED sk-ant-${kind}-...${last4}]`.
 * - Objects and arrays are cloned; nested strings are redacted recursively.
 * - Other primitives (`number`, `boolean`, `null`, `undefined`, `bigint`,
 *   `symbol`) are returned as-is.
 * - Circular references are short-circuited via an internal `WeakSet` and
 *   replaced with a `"[Circular]"` sentinel to avoid infinite recursion.
 * - The caller's input is never mutated.
 */
export function redactAnthropicSecrets(input: unknown): unknown {
  return redactValue(input, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
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
      out[i] = redactValue(value[i], seen);
    }
    return out;
  }

  // Plain object: copy own enumerable keys.
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    out[key] = redactValue(src[key], seen);
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
 * wrappers that run every argument through {@link redactAnthropicSecrets}
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
      const redacted = args.map((a) => redactAnthropicSecrets(a));
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
      const jsonStr = JSON.stringify(data);
      if (jsonStr.length < 100) {
        return `${prefix} ${message} ${jsonStr}`;
      }
      return `${prefix} ${message}\n${JSON.stringify(data, null, 2)}`;
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

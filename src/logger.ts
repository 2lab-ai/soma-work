/**
 * Logger with configurable levels and categories
 *
 * Environment variables:
 * - LOG_LEVEL: error | warn | info | debug (default: info)
 * - LOG_CATEGORIES: comma-separated list of categories to show (empty = all)
 * - LOG_MUTE: comma-separated list of categories to hide
 */

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
  return new Set(cats.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean));
}

// Cached config
let cachedLevel: LogLevel | null = null;
let cachedEnabled: Set<string> | null | undefined = undefined;
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
export function resetLoggerConfig() {
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

    // Check level
    if (LOG_LEVELS[level] > LOG_LEVELS[config.level]) {
      return false;
    }

    // Check if category is muted
    if (config.muted.has(this.contextLower)) {
      return false;
    }

    // Check if category is enabled (if filter is set)
    if (config.enabled !== null && config.enabled !== undefined && !config.enabled.has(this.contextLower)) {
      return false;
    }

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

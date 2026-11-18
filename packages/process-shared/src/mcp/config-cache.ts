import * as fs from 'fs';
import { StderrLogger } from '../stderr-logger.js';

export interface ConfigCacheOptions<T> {
  /** JSON key in config file (e.g. 'llmChat', 'server-tools') */
  section: string;
  /** Parse the raw section value into T. Return null to keep previous cache. */
  loader: (raw: any) => T | null;
  /**
   * A directory whose change also re-runs the loader — the secret store for a loader that resolves
   * `{"$secret"}` references (secret-access WU1, #1337): a secret added or replaced without touching the
   * config file is picked up on the next read. A directory that does not exist counts as unchanged.
   */
  watchDir?: () => string | undefined;
}

/**
 * Generic mtime-based config cache.
 *
 * Reads a section from the JSON file at SOMA_CONFIG_FILE env var.
 * Only re-reads when the file's mtime or size changes.
 */
export class ConfigCache<T> {
  private cached: T;
  private defaultValue: T;
  private mtimeMs = 0;
  private size = 0;
  private dirMtimeMs = 0;
  private options: ConfigCacheOptions<T>;
  private logger: StderrLogger;

  constructor(defaultValue: T, options: ConfigCacheOptions<T>) {
    this.cached = defaultValue;
    this.defaultValue = defaultValue;
    this.options = options;
    this.logger = new StderrLogger(`ConfigCache:${options.section}`);
  }

  /**
   * Get the cached config, reloading from disk if mtime changed.
   */
  get(): T {
    const configFile = process.env.SOMA_CONFIG_FILE || '';
    if (!configFile) return this.cached;

    try {
      const stat = fs.statSync(configFile);
      const dirMtimeMs = this.watchedDirMtime();
      if (stat.mtimeMs === this.mtimeMs && stat.size === this.size && dirMtimeMs === this.dirMtimeMs) {
        return this.cached; // File unchanged — use cache
      }

      const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      const section = raw?.[this.options.section];
      const parsed = this.options.loader(section);

      if (parsed !== null) {
        this.cached = parsed;
        this.logger.info(`Reloaded ${this.options.section} config`);
      }

      // Always update mtime/size so we don't re-read unchanged file
      this.mtimeMs = stat.mtimeMs;
      this.size = stat.size;
      this.dirMtimeMs = dirMtimeMs;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Never the error itself: a JSON parse error quotes the text around the fault, and this file holds secrets.
        this.logger.warn(`Failed to reload ${this.options.section} config, keeping previous values`, {
          error: (error as Error)?.name ?? 'Error',
          code,
        });
      }
    }

    return this.cached;
  }

  private watchedDirMtime(): number {
    const dir = this.options.watchDir?.();
    if (!dir) return 0;
    try {
      return fs.statSync(dir).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Reset cache state. Forces re-read on next get().
   */
  reset(): void {
    this.cached = this.defaultValue;
    this.mtimeMs = 0;
    this.size = 0;
    this.dirMtimeMs = 0;
  }
}

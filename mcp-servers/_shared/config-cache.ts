import * as fs from 'fs';
import { StderrLogger } from './stderr-logger.js';

export interface ConfigCacheOptions<T> {
  /** JSON key in config file (e.g. 'llmChat', 'server-tools') */
  section: string;
  /** Parse the raw section value into T. Return null to keep previous cache. */
  loader: (raw: any) => T | null;
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
      if (stat.mtimeMs === this.mtimeMs && stat.size === this.size) {
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
    } catch {
      // File doesn't exist or is invalid — keep current cache
    }

    return this.cached;
  }

  /**
   * Reset cache state. Forces re-read on next get().
   */
  reset(): void {
    this.cached = this.defaultValue;
    this.mtimeMs = 0;
    this.size = 0;
  }
}

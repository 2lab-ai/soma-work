import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** A downloaded thread file older than this is removed at the next download. */
const DOWNLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Remove downloads older than DOWNLOAD_MAX_AGE_MS from `dir`; a file that cannot be removed waits for the next call. */
export async function pruneOldDownloads(dir: string, now: number = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = await fs.lstat(file);
      if (stat.isFile() && now - stat.mtimeMs > DOWNLOAD_MAX_AGE_MS) await fs.unlink(file);
    } catch {
      // Gone already.
    }
  }
}

import { execSync } from 'child_process';
import fs from 'fs';

/**
 * Get directory size in bytes using `du -sk` (fast, OS-level).
 * Returns 0 if the directory doesn't exist or is inaccessible.
 */
export function getDirSizeBytes(dirPath: string): number {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    // du -sk outputs size in KB; multiply by 1024 for bytes
    const output = execSync(`du -sk "${dirPath}" 2>/dev/null`, { timeout: 5000, encoding: 'utf-8' });
    const kb = parseInt(output.split('\t')[0], 10);
    return Number.isNaN(kb) ? 0 : kb * 1024;
  } catch {
    return 0;
  }
}

/**
 * Format bytes into human-readable string (B, KB, MB, GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

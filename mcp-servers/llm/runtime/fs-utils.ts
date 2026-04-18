/**
 * Filesystem helpers shared across the llm MCP runtime.
 *
 * `writeJsonlAtomic` / `writeJsonlAtomicSync` are the durable rewrite primitive
 * used by session-store and child-registry: write to tmp → fsync → rename.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function joinLines(lines: string[]): string {
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export async function writeJsonlAtomic(filePath: string, lines: string[]): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, joinLines(lines), 'utf-8');
  const fh = await fs.promises.open(tmpPath, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmpPath, filePath);
}

export function writeJsonlAtomicSync(filePath: string, lines: string[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, joinLines(lines), 'utf-8');
  const fd = fs.openSync(tmpPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

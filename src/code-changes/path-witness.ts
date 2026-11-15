/**
 * Proof, after a read, that the folders read through were not swapped meanwhile (#1299 review — the check/use race on
 * folders the model writes: a git dir checked, then replaced by a link to another repository while git reads it).
 *
 * Renaming, replacing, creating or removing an entry changes its directory's ctime (and the moved entry's own), and no
 * process can set a ctime back — `utimes` sets it to now. So a directory whose device, inode and ctime are the same
 * after a read as before had no entry swapped in between; a file whose are the same was not rewritten. A read that
 * finds any noted path changed is thrown away, never stored.
 */

import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type PathKind = 'dir' | 'file' | 'link' | 'other';

const markOf = (st: BigIntStats) => `${st.dev}:${st.ino}:${st.mode}:${st.ctimeNs}`;

export class PathWitness {
  private readonly marks = new Map<string, string>();

  /** Notes `p` as it is now (not followed). Its kind, or undefined when it does not exist. */
  async note(p: string): Promise<PathKind | undefined> {
    const st = await fs.lstat(p, { bigint: true }).catch(() => undefined);
    if (!st) return undefined;
    // The first look is the one compared: a later note of the same path must not hide a change since.
    if (!this.marks.has(p)) this.marks.set(p, markOf(st));
    return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  }

  /**
   * Notes every folder from `from` down to `to` (both included; `to` inside `from`). False when one is not a plain
   * folder — a link on the way is refused, not followed.
   */
  async noteChain(from: string, to: string): Promise<boolean> {
    const rel = path.relative(from, to);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    let cur = from;
    if ((await this.note(cur)) !== 'dir') return false;
    for (const part of rel ? rel.split(path.sep) : []) {
      cur = path.join(cur, part);
      if ((await this.note(cur)) !== 'dir') return false;
    }
    return true;
  }

  /** Whether every noted path still has the device, inode, type and ctime it had when first noted. */
  async intact(): Promise<boolean> {
    for (const [p, mark] of this.marks) {
      const st = await fs.lstat(p, { bigint: true }).catch(() => undefined);
      if (!st || markOf(st) !== mark) return false;
    }
    return true;
  }

  get size(): number {
    return this.marks.size;
  }
}

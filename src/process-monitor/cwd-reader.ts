import { readlink } from 'node:fs/promises';
import type { RunCommand } from './node-capacity';

/**
 * Where each process works — its current directory — for the Processes tab's "where" column and the detail view.
 *
 * Linux reads `/proc/<pid>/cwd` (a link the owner of the process may read). macOS has no /proc: one `lsof -a -d cwd`
 * call answers for every pid at once. Only the daemon's own processes answer (a session's tree is the daemon's), and a
 * pid either way that does not answer is simply absent — a cwd is a hint, never a reason to fail a sample.
 */
export type ReadCwds = (pids: readonly number[]) => Promise<Map<number, string>>;

/** `lsof -F pn` output → pid → cwd. Records are `p<pid>` then `n<path>` (the `f` field is dropped by `-F pn`). */
export function parseLsofCwds(out: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isSafeInteger(n) && n > 0 ? n : null;
    } else if (line.startsWith('n') && pid !== null && !cwds.has(pid)) {
      const path = line.slice(1);
      if (path.startsWith('/')) cwds.set(pid, path);
    }
  }
  return cwds;
}

/** The platform's reader: `/proc` on Linux, one `lsof` on macOS, none elsewhere. */
export function createCwdReader(
  platform: string,
  run: RunCommand,
  readLink: (path: string) => Promise<string> = (p) => readlink(p),
): ReadCwds | undefined {
  if (platform === 'linux') {
    return async (pids) => {
      const out = new Map<number, string>();
      const links = await Promise.allSettled(pids.map((pid) => readLink(`/proc/${pid}/cwd`)));
      links.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.startsWith('/')) out.set(pids[i], r.value);
      });
      return out;
    };
  }
  if (platform === 'darwin') {
    return async (pids) => {
      if (pids.length === 0) return new Map();
      // -a: AND the selections (this pid list AND the cwd descriptor); -w: no warnings on stderr; -F pn: parseable.
      const out = await run('/usr/sbin/lsof', ['-a', '-w', '-d', 'cwd', '-F', 'pn', '-p', pids.join(',')]);
      return parseLsofCwds(out);
    };
  }
  return undefined;
}

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { maskCommandLine } from './command-mask';
import type { RunCommand } from './node-capacity';
import { parseCpuTime, stateOf } from './ps-table';
import type { ProcessState } from './types';

/**
 * One process, read in depth for the detail view — what Process Explorer's Properties window shows, as far as the
 * daemon's own user may read it without root: image and command line, where it works, who runs it, when it started,
 * CPU time and priority, memory, threads, open files and sockets.
 *
 * A snapshot: read once when the reader opens it, never refreshed on a timer. Every part is best effort — a part the
 * OS would not give is listed in `unreadable` and the rest still answers. The environment is never read (it holds the
 * session's credentials).
 */

export interface ProcessFileEntry {
  /** The descriptor (`0`, `12`, `cwd`, `txt`). */
  readonly fd: string;
  /** `REG`, `DIR`, `PIPE`, `CHR`, `unix`, `IPv4` … (lsof's names; Linux `/proc` links are mapped to the same words). */
  readonly type: string;
  readonly name: string;
}

export interface ProcessSocketEntry {
  readonly fd: string;
  /** `TCP`, `UDP`, `unix`. */
  readonly proto: string;
  readonly local: string;
  /** The peer (`''` for a listening or unconnected socket). */
  readonly remote: string;
  /** TCP state (`LISTEN`, `ESTABLISHED` …); `''` when the protocol has none. */
  readonly state: string;
}

export interface ProcessInspection {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number | null;
  readonly startToken: string;
  /** Epoch ms the process started (from `lstart`; `null` when it could not be read). */
  readonly startedAt: number | null;
  readonly elapsedSeconds: number | null;
  /** The executable's path. */
  readonly exe: string;
  /** The full command line, secret values masked (`command-mask.ts`). */
  readonly commandLine: string;
  /** Whether `commandLine` came from the real argument vector (Linux) or a space-joined `ps args` line (macOS). */
  readonly argvExact: boolean;
  readonly cwd: string;
  readonly user: string;
  readonly uid: number | null;
  /** `ps stat` as is (`S+`, `R`, `T` …). */
  readonly stat: string;
  readonly state: ProcessState;
  readonly nice: number | null;
  readonly priority: number | null;
  /** Cumulative CPU (user + system), seconds. */
  readonly cpuSeconds: number | null;
  /** ps `%cpu`: a decaying average on macOS, the lifetime average on Linux. */
  readonly psCpuPercent: number | null;
  readonly memPercent: number | null;
  readonly rssBytes: number | null;
  readonly vszBytes: number | null;
  /** Linux `VmHWM` (peak resident). */
  readonly peakRssBytes: number | null;
  readonly threads: number | null;
  /** Linux voluntary / involuntary context switches. */
  readonly contextSwitches: { readonly voluntary: number; readonly involuntary: number } | null;
  /** Linux `/proc/<pid>/io` storage bytes. */
  readonly io: { readonly readBytes: number; readonly writeBytes: number } | null;
  /** Open descriptors, every kind. */
  readonly fdCount: number | null;
  /** Descriptors per type (`REG` 12, `PIPE` 4, `txt` 98 …). */
  readonly fdByType: Readonly<Record<string, number>>;
  /** Files and other non-socket descriptors, up to {@link MAX_FILES}; `filesTruncated` when there were more. */
  readonly files: readonly ProcessFileEntry[];
  readonly filesTruncated: boolean;
  /**
   * More descriptors than one detail read looks at (Linux): `fdCount` is all of them, but `fdByType`, `files` and
   * `sockets` cover the first {@link MAX_FD_LINKS} only.
   */
  readonly fdScanPartial: boolean;
  readonly sockets: readonly ProcessSocketEntry[];
  readonly socketsTruncated: boolean;
  /** Epoch ms of the read. */
  readonly takenAt: number;
  /** Parts the OS would not give (`files`, `threads`, `command` …). */
  readonly unreadable: readonly string[];
}

/** `gone`: no such pid now; `stale`: the pid started at another time (reused) — before or during the read. */
export type InspectProcess = (pid: number, startToken: string) => Promise<ProcessInspection | 'gone' | 'stale'>;

export const MAX_FILES = 60;
export const MAX_SOCKETS = 40;
const MAX_FD_LINKS = 400;

/** Fixed columns first, `lstart` (5 tokens) last — no column with spaces before it. */
const PS_COLUMNS = 'pid=,ppid=,pgid=,uid=,user=,stat=,nice=,pri=,%cpu=,%mem=,rss=,vsz=,time=,etime=,lstart=';

export interface PsDetail {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number | null;
  readonly uid: number | null;
  readonly user: string;
  readonly stat: string;
  readonly nice: number | null;
  readonly priority: number | null;
  readonly psCpuPercent: number | null;
  readonly memPercent: number | null;
  readonly rssBytes: number | null;
  readonly vszBytes: number | null;
  readonly cpuSeconds: number | null;
  readonly elapsedSeconds: number | null;
  readonly startToken: string;
}

const int = (s: string | undefined): number | null => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : null);
const num = (s: string | undefined): number | null => (s !== undefined && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseElapsed(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** One line of `ps -o PS_COLUMNS -p <pid>` → its fields. `null` when the line is not that shape. */
export function parsePsDetail(out: string): PsDetail | null {
  const line = out.split('\n').find((l) => l.trim() !== '');
  if (!line) return null;
  const t = line.trim().split(/\s+/);
  if (t.length < 19) return null;
  const pid = int(t[0]);
  const ppid = int(t[1]);
  if (pid === null || ppid === null) return null;
  const kb = (s: string) => {
    const n = int(s);
    return n === null ? null : n * 1024;
  };
  return {
    pid,
    ppid,
    pgid: int(t[2]),
    uid: int(t[3]),
    user: t[4],
    stat: t[5],
    nice: int(t[6]),
    priority: int(t[7]),
    psCpuPercent: num(t[8]),
    memPercent: num(t[9]),
    rssBytes: kb(t[10]),
    vszBytes: kb(t[11]),
    cpuSeconds: parseCpuTime(t[12]),
    elapsedSeconds: parseElapsed(t[13]),
    startToken: t.slice(14, 19).join(' '),
  };
}

/** `lstart` (`Tue Nov 24 15:50:48 2026`, local time — the C locale's form, which `Date.parse` reads) → epoch ms. */
export function parseLstart(token: string): number | null {
  const ms = Date.parse(token);
  return Number.isNaN(ms) ? null : ms;
}

interface FdTable {
  files: ProcessFileEntry[];
  sockets: ProcessSocketEntry[];
  byType: Record<string, number>;
  count: number;
  exe: string;
  cwd: string;
}

const emptyFds = (): FdTable => ({ files: [], sockets: [], byType: {}, count: 0, exe: '', cwd: '' });

/** `host:port->peer:port` (lsof's socket name) → its two ends. */
function splitEnds(name: string): { local: string; remote: string } {
  const arrow = name.indexOf('->');
  return arrow < 0 ? { local: name, remote: '' } : { local: name.slice(0, arrow), remote: name.slice(arrow + 2) };
}

/** `lsof -F ftnPT` for one pid → its descriptors. Records: `f<fd>` then `t<type>`, `P<proto>`, `n<name>`, `T<k=v>`. */
export function parseLsofFds(out: string): FdTable {
  const table = emptyFds();
  type Rec = { fd: string; type: string; proto: string; name: string; state: string };
  const recs: Rec[] = [];
  let cur: Rec | null = null;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const v = line.slice(1);
    if (tag === 'f') {
      cur = { fd: v, type: '', proto: '', name: '', state: '' };
      recs.push(cur);
    } else if (cur && tag === 't') cur.type = v;
    else if (cur && tag === 'P') cur.proto = v;
    else if (cur && tag === 'n') cur.name = v;
    else if (cur && tag === 'T' && v.startsWith('ST=')) cur.state = v.slice(3);
  }
  for (const r of recs) {
    if (r.fd === 'cwd') {
      table.cwd ||= r.name;
      continue;
    }
    if (r.fd === 'txt') {
      // The first text segment is the executable; the rest are its libraries (counted, not listed).
      table.exe ||= r.name;
      table.byType.txt = (table.byType.txt ?? 0) + 1;
      continue;
    }
    // Numbered descriptors only (`rtd`, `mem` … are not open files).
    if (!/^\d+[a-zA-Z]*$/.test(r.fd)) continue;
    table.count++;
    const type = r.type || '?';
    table.byType[type] = (table.byType[type] ?? 0) + 1;
    const fd = r.fd.replace(/[a-zA-Z]+$/, '');
    if (type === 'IPv4' || type === 'IPv6' || type === 'unix') {
      table.sockets.push({
        fd,
        proto: type === 'unix' ? 'unix' : r.proto || type,
        ...(type === 'unix' ? { local: r.name, remote: '' } : splitEnds(r.name)),
        state: r.state,
      });
    } else table.files.push({ fd, type, name: r.name });
  }
  return table;
}

// ── Linux /proc ──

const TCP_STATES: Readonly<Record<string, string>> = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
};

/** `0100007F:1F90` (little-endian IPv4) or a 32-hex IPv6 → `127.0.0.1:8080` / `[::1]:8080`. */
export function formatProcNetAddress(hex: string): string {
  const [addr, portHex] = hex.split(':');
  const port = Number.parseInt(portHex ?? '', 16);
  if (!addr || !Number.isFinite(port)) return hex;
  if (addr.length === 8) {
    const b = addr.match(/../g)?.map((x) => Number.parseInt(x, 16)) ?? [];
    return `${b.reverse().join('.')}:${port}`;
  }
  if (addr.length === 32) {
    // Four 32-bit words, each little-endian.
    const bytes: number[] = [];
    for (let w = 0; w < 4; w++) {
      const word = addr.slice(w * 8, w * 8 + 8).match(/../g) ?? [];
      bytes.push(...word.reverse().map((x) => Number.parseInt(x, 16)));
    }
    if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
      return `${bytes.slice(12).join('.')}:${port}`;
    }
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    // The URL host serializer writes the canonical form (zero runs as `::`) with its brackets.
    return `${new URL(`http://[${groups.join(':')}]`).hostname}:${port}`;
  }
  return hex;
}

/** `/proc/<pid>/net/{tcp,tcp6,udp,udp6}` → inode → socket. */
export function parseProcNetInet(text: string, proto: 'TCP' | 'UDP'): Map<string, Omit<ProcessSocketEntry, 'fd'>> {
  const out = new Map<string, Omit<ProcessSocketEntry, 'fd'>>();
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const inode = f[9];
    if (!inode || inode === '0') continue;
    const remote = formatProcNetAddress(f[2]);
    const listening = proto === 'TCP' ? f[3] === '0A' : /^0+:0+$/.test(f[2]);
    out.set(inode, {
      proto,
      local: formatProcNetAddress(f[1]),
      remote: listening || /^(0\.0\.0\.0|\[::\]):0$/.test(remote) ? '' : remote,
      state: proto === 'TCP' ? (TCP_STATES[f[3]] ?? f[3]) : '',
    });
  }
  return out;
}

/** `/proc/<pid>/net/unix` → inode → socket path (`''` for an unnamed one). */
export function parseProcNetUnix(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 7) continue;
    out.set(f[6], f[7] ?? '');
  }
  return out;
}

/** `/proc/<pid>/status` → the fields the detail view shows. */
export function parseProcStatus(text: string): {
  threads: number | null;
  peakRssBytes: number | null;
  contextSwitches: { voluntary: number; involuntary: number } | null;
} {
  const field = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim();
  const kb = (s: string | undefined) => {
    const m = s ? /^(\d+)\s*kB$/.exec(s) : null;
    return m ? Number(m[1]) * 1024 : null;
  };
  const vol = int(field('voluntary_ctxt_switches'));
  const invol = int(field('nonvoluntary_ctxt_switches'));
  return {
    threads: int(field('Threads')),
    peakRssBytes: kb(field('VmHWM')),
    contextSwitches: vol !== null && invol !== null ? { voluntary: vol, involuntary: invol } : null,
  };
}

/** `/proc/<pid>/io` → storage bytes. */
export function parseProcIo(text: string): { readBytes: number; writeBytes: number } | null {
  const r = /^read_bytes:\s*(\d+)$/m.exec(text);
  const w = /^write_bytes:\s*(\d+)$/m.exec(text);
  return r && w ? { readBytes: Number(r[1]), writeBytes: Number(w[1]) } : null;
}

/** A `/proc/<pid>/fd/<n>` link target → lsof's type word. */
export function fdTypeOfLink(target: string): string {
  if (target.startsWith('socket:')) return 'sock';
  if (target.startsWith('pipe:')) return 'PIPE';
  if (target.startsWith('anon_inode:')) return 'a_inode';
  if (target.startsWith('/dev/')) return 'CHR';
  if (target.startsWith('/')) return 'REG';
  return '?';
}

export interface InspectorDeps {
  readonly platform: string;
  readonly run: RunCommand;
  readonly now?: () => number;
  readonly readFile?: (path: string) => Promise<string>;
  readonly readLink?: (path: string) => Promise<string>;
  readonly readDir?: (path: string) => Promise<string[]>;
  /** The daemon's own uid and name (a ps `user` column on Linux truncates long names). */
  readonly self?: { readonly uid: number; readonly name: string };
}

function selfUser(): { uid: number; name: string } | undefined {
  try {
    const u = os.userInfo();
    return { uid: u.uid, name: u.username };
  } catch {
    return undefined;
  }
}

/** The platform's inspector; `undefined` where there is none (Windows). */
export function createProcessInspector(deps: InspectorDeps): InspectProcess | undefined {
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') return undefined;
  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  const readLink = deps.readLink ?? ((p: string) => fs.readlink(p));
  const readDir = deps.readDir ?? ((p: string) => fs.readdir(p));
  const self = deps.self ?? selfUser();
  const linux = deps.platform === 'linux';

  const psDetail = async (pid: number): Promise<PsDetail | null> =>
    parsePsDetail(await deps.run('ps', ['-ww', '-o', PS_COLUMNS, '-p', String(pid)]));

  return async (pid, startToken) => {
    const takenAt = now();
    // A pid gone before the first read: ps exits 1 (no such process) — gone, not a server failure.
    const before = await psDetail(pid).catch((err: { code?: unknown }) => {
      if (err?.code === 1) return null;
      throw err;
    });
    if (!before) return 'gone';
    if (before.startToken !== startToken) return 'stale';
    const unreadable: string[] = [];
    const attempt = async <T>(part: string, read: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await read();
      } catch {
        unreadable.push(part);
        return fallback;
      }
    };

    let commandLine = '';
    let exe = '';
    let cwd = '';
    let threads: number | null = null;
    let peakRssBytes: number | null = null;
    let contextSwitches: ProcessInspection['contextSwitches'] = null;
    let io: ProcessInspection['io'] = null;
    let fds = emptyFds();
    let fdsRead = false;
    let fdScanPartial = false;

    if (linux) {
      commandLine = await attempt(
        'command',
        async () => {
          // NUL-separated, with a NUL after the last argument.
          const argv = (await readFile(`/proc/${pid}/cmdline`)).replace(/\0$/, '').split('\0');
          return maskCommandLine({ argv, exact: true });
        },
        '',
      );
      exe = await attempt('exe', () => readLink(`/proc/${pid}/exe`), '');
      cwd = await attempt('cwd', () => readLink(`/proc/${pid}/cwd`), '');
      const status = await attempt('status', async () => parseProcStatus(await readFile(`/proc/${pid}/status`)), null);
      if (status) ({ threads, peakRssBytes, contextSwitches } = status);
      io = await attempt('io', async () => parseProcIo(await readFile(`/proc/${pid}/io`)), null);
      await attempt(
        'files',
        async () => {
          const names = (await readDir(`/proc/${pid}/fd`))
            .filter((n) => /^\d+$/.test(n))
            .sort((a, b) => Number(a) - Number(b));
          const links = await Promise.allSettled(
            names.slice(0, MAX_FD_LINKS).map((n) => readLink(`/proc/${pid}/fd/${n}`)),
          );
          fdScanPartial = names.length > MAX_FD_LINKS;
          const inet = new Map<string, Omit<ProcessSocketEntry, 'fd'>>();
          let unix = new Map<string, string>();
          if (links.some((l) => l.status === 'fulfilled' && l.value.startsWith('socket:'))) {
            // A table that cannot be read is said (`sockets`), and its sockets stay unknown — never guessed at.
            let tableFailed = false;
            const table = (file: string) =>
              readFile(`/proc/${pid}/net/${file}`).catch(() => {
                tableFailed = true;
                return '';
              });
            for (const [file, proto] of [
              ['tcp', 'TCP'],
              ['tcp6', 'TCP'],
              ['udp', 'UDP'],
              ['udp6', 'UDP'],
            ] as const) {
              for (const [k, v] of parseProcNetInet(await table(file), proto)) inet.set(k, v);
            }
            unix = parseProcNetUnix(await table('unix'));
            if (tableFailed) unreadable.push('sockets');
          }
          fds = emptyFds();
          fds.count = names.length;
          links.forEach((l, i) => {
            if (l.status !== 'fulfilled') return;
            const target = l.value;
            const type = fdTypeOfLink(target);
            if (type === 'sock') {
              const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1] ?? '';
              const s = inet.get(inode);
              const isUnix = !s && unix.has(inode);
              const kind = s ? (s.local.startsWith('[') ? 'IPv6' : 'IPv4') : isUnix ? 'unix' : 'sock';
              fds.byType[kind] = (fds.byType[kind] ?? 0) + 1;
              fds.sockets.push(
                s
                  ? { fd: names[i], ...s }
                  : { fd: names[i], proto: isUnix ? 'unix' : '?', local: unix.get(inode) ?? '', remote: '', state: '' },
              );
              return;
            }
            fds.byType[type] = (fds.byType[type] ?? 0) + 1;
            fds.files.push({ fd: names[i], type, name: target });
          });
          fdsRead = true;
        },
        undefined,
      );
    } else {
      commandLine = await attempt(
        'command',
        async () =>
          maskCommandLine({
            argv: [(await deps.run('ps', ['-ww', '-o', 'args=', '-p', String(pid)])).trim()],
            exact: false,
          }),
        '',
      );
      threads = await attempt(
        'threads',
        async () => {
          const lines = (await deps.run('ps', ['-M', '-p', String(pid)])).split('\n').filter((l) => l.trim() !== '');
          return lines.length > 1 ? lines.length - 1 : null;
        },
        null,
      );
      await attempt(
        'files',
        async () => {
          fds = parseLsofFds(await deps.run('/usr/sbin/lsof', ['-w', '-n', '-P', '-p', String(pid), '-F', 'ftnPT']));
          fdsRead = true;
        },
        undefined,
      );
      exe = fds.exe;
      cwd = fds.cwd;
      if (!exe)
        exe = await attempt('exe', async () => (await deps.run('ps', ['-o', 'comm=', '-p', String(pid)])).trim(), '');
    }

    // The pid may have exited and been reused while this read ran: the answer is only good if it is still that process.
    const after = await psDetail(pid).catch(() => null);
    if (!after) return 'gone';
    if (after.startToken !== startToken) return 'stale';

    const files = fds.files.slice(0, MAX_FILES);
    const sockets = fds.sockets.slice(0, MAX_SOCKETS);
    return {
      pid,
      ppid: before.ppid,
      pgid: before.pgid,
      startToken,
      startedAt: parseLstart(startToken),
      elapsedSeconds: before.elapsedSeconds,
      exe,
      commandLine,
      argvExact: linux,
      cwd,
      user: self && before.uid === self.uid ? self.name : before.user,
      uid: before.uid,
      stat: before.stat,
      state: stateOf(before.stat),
      nice: before.nice,
      priority: before.priority,
      cpuSeconds: before.cpuSeconds,
      psCpuPercent: before.psCpuPercent,
      memPercent: before.memPercent,
      rssBytes: before.rssBytes,
      vszBytes: before.vszBytes,
      peakRssBytes,
      threads,
      contextSwitches,
      io,
      fdCount: fdsRead ? fds.count : null,
      fdByType: fds.byType,
      files,
      filesTruncated: fds.files.length > files.length || fdScanPartial,
      fdScanPartial,
      sockets,
      socketsTruncated: fds.sockets.length > sockets.length,
      takenAt,
      unreadable,
    };
  };
}

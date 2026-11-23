import type { ProcessState } from './types';

/**
 * Parsers for the two `ps` calls one sample makes. Both formats work on macOS
 * (BSD ps) and Linux (procps) when run with `LC_ALL=C`:
 *
 *   1. `ps -A -o pid=,ppid=`              — the whole parent map, small.
 *   2. `ps -ww -o <DETAIL_COLUMNS> -p …`  — only the processes in a tracked tree.
 */

/** Columns of the detail call. `lstart` is 5 tokens (`Mon Nov 23 19:45:17 2026`); `args` runs to the end of the line. */
export const DETAIL_COLUMNS = 'pid=,ppid=,stat=,lstart=,time=,%cpu=,rss=,args=';

export interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly stat: string;
  readonly startToken: string;
  /** Cumulative CPU seconds (user + system). `null` when the column could not be read. */
  readonly cpuSeconds: number | null;
  /** ps's own %CPU — a decaying average (macOS) or a lifetime average (Linux). Used only before a second sample exists. */
  readonly psCpuPercent: number;
  readonly rssBytes: number;
  readonly args: string;
}

function toInt(s: string | undefined): number | null {
  if (s === undefined || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Output of `ps -A -o pid=,ppid=` → pid → ppid. Malformed lines are skipped. */
export function parseParentMap(out: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of out.split('\n')) {
    const [a, b] = line.trim().split(/\s+/);
    const pid = toInt(a);
    const ppid = toInt(b);
    if (pid !== null && ppid !== null) map.set(pid, ppid);
  }
  return map;
}

/**
 * `time` column → seconds. macOS prints `MMM:SS.ss` (minutes can exceed 59);
 * Linux prints `[DD-]HH:MM:SS`.
 */
export function parseCpuTime(s: string): number | null {
  const m = /^(?:(\d+)-)?([\d:.]+)$/.exec(s.trim());
  if (!m) return null;
  const days = m[1] ? Number(m[1]) : 0;
  const parts = m[2].split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  const secs = parts.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
  return days * 86400 + secs;
}

/** The 11 fixed columns before `args`; each `\S+\s+` step is unambiguous, so this never backtracks. */
const LEADING_FIELDS = /^\s*((?:\S+\s+){11})(\S.*)$/;

/** Output of the detail call → rows. Malformed lines are skipped, never guessed at. */
export function parseDetailRows(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const raw of out.split('\n')) {
    // pid ppid stat + 5 lstart tokens + time %cpu rss, then argv to the end of the line.
    const m = LEADING_FIELDS.exec(raw);
    if (!m) continue;
    const tokens = m[1].trim().split(/\s+/);
    const args = m[2].trim();
    const pid = toInt(tokens[0]);
    const ppid = toInt(tokens[1]);
    const rssKb = toInt(tokens[10]);
    const psCpu = Number(tokens[9]);
    if (pid === null || ppid === null || rssKb === null || !Number.isFinite(psCpu) || !args) continue;
    rows.push({
      pid,
      ppid,
      stat: tokens[2],
      startToken: tokens.slice(3, 8).join(' '),
      cpuSeconds: parseCpuTime(tokens[8]),
      psCpuPercent: psCpu,
      rssBytes: rssKb * 1024,
      args,
    });
  }
  return rows;
}

/** First letter of `stat` → state. BSD and procps share the letters that matter here. */
export function stateOf(stat: string): ProcessState {
  switch (stat.charAt(0)) {
    case 'R':
      return 'running';
    case 'S':
    case 'I':
    case 'D':
    case 'U':
      return 'sleeping';
    case 'T':
    case 't':
      return 'stopped';
    case 'Z':
      return 'zombie';
    default:
      return 'other';
  }
}

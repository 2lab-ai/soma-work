import type { TrackedClaudeRootInfo } from '../agent-runtime/claude-child-process-registry';
import { commandPreview, processName, splitArgs } from './command-preview';
import type { ReadCwds } from './cwd-reader';
import { DETAIL_COLUMNS, type PsRow, parseDetailRows, parseParentMap, stateOf } from './ps-table';
import type { NodeCapacity, ProcessSample, SessionProcessDetail } from './types';

/** A Claude Code process the SDK spawned, as the child registry knows it (pid + the session it runs for, if any). */
/** Pids per detail `ps` call. */
const DETAIL_BATCH = 200;
/** How long a process's working directory is trusted before it is read again (a shell `cd`s, most processes never do). */
const CWD_TTL_MS = 15_000;

export type TrackedRoot = Pick<TrackedClaudeRootInfo, 'pid' | 'sessionKey'>;

/** Runs `ps` with these arguments and returns stdout. Must resolve with partial stdout when ps exits 1 because a pid vanished. */
export type RunPs = (args: readonly string[]) => Promise<string>;

/**
 * Cumulative CPU seconds per pid from a finer source than ps `time` (whole seconds on Linux, where 1 s of a 5 s
 * window is 20% of a core): Linux `/proc/<pid>/stat` ticks. A pid it does not answer for keeps the ps value.
 */
export type ReadCpuSeconds = (pids: readonly number[]) => Promise<Map<number, number>>;

export interface TreeSample {
  readonly sessions: SessionProcessDetail[];
  readonly unattributed: { processCount: number; cpuPercent: number; rssBytes: number };
}

interface Remembered {
  readonly startToken: string;
  readonly depth: number;
}

/** Owner key of the unattributed group: SDK children with no session. */
const NO_SESSION = '';

/**
 * Samples every tracked Claude Code process and all its descendants.
 *
 * A descendant whose parent exits is re-parented by the OS (to PID 1, or to a
 * subreaper) and drops out of a plain tree walk. The sampler remembers every
 * process it has seen under an owner, identified by pid + start time, and keeps
 * counting it — and whatever it spawns — for that owner until it exits. A
 * process that is born and orphaned between two samples is the one thing it
 * cannot see.
 *
 * CPU is the change in cumulative CPU time between two samples divided by the
 * wall time between them — the same meaning on macOS and Linux, unlike ps
 * `%cpu`, which is used only for a process seen for the first time.
 */
export class TreeSampler {
  private readonly remembered = new Map<string, Map<number, Remembered>>();
  private readonly prevCpu = new Map<string, { cpuSeconds: number; at: number }>();
  /** `pid:start` → its working directory and when it was read. */
  private readonly cwds = new Map<string, { cwd: string; at: number }>();

  constructor(
    private readonly runPs: RunPs,
    private readonly now: () => number = Date.now,
    private readonly readCpuSeconds?: ReadCpuSeconds,
    private readonly readCwds?: ReadCwds,
    private readonly logger?: { warn(msg: string, meta?: unknown): void },
  ) {}

  /** Whether a sample would do any work (a tracked root, or a remembered leftover). */
  hasWork(roots: readonly TrackedRoot[]): boolean {
    return roots.length > 0 || this.remembered.size > 0;
  }

  async sample(roots: readonly TrackedRoot[], nodeId: NodeCapacity['nodeId']): Promise<TreeSample> {
    const at = this.now();
    if (!this.hasWork(roots)) return { sessions: [], unattributed: { processCount: 0, cpuPercent: 0, rssBytes: 0 } };

    const parentOf = parseParentMap(await this.runPs(['-A', '-o', 'pid=,ppid=']));
    const childrenOf = new Map<number, number[]>();
    for (const [pid, ppid] of parentOf) {
      if (pid === ppid) continue;
      const list = childrenOf.get(ppid);
      if (list) list.push(pid);
      else childrenOf.set(ppid, [pid]);
    }

    const rootsByOwner = new Map<string, number[]>();
    for (const r of roots) {
      const owner = r.sessionKey ?? NO_SESSION;
      const list = rootsByOwner.get(owner) ?? [];
      list.push(r.pid);
      rootsByOwner.set(owner, list);
    }
    const owners = new Set<string>([...rootsByOwner.keys(), ...this.remembered.keys()]);

    // First pass: membership from live roots plus remembered processes still in the table.
    let membership = this.walk(owners, rootsByOwner, parentOf, childrenOf, () => true);
    const wanted = new Set<number>();
    for (const m of membership.values()) for (const pid of m.keys()) wanted.add(pid);
    const rows = new Map<number, PsRow>();
    if (wanted.size > 0) {
      // In batches: one oversized or failing batch costs only its own rows (a missing row is handled below), and the
      // `-p` list stays short. Only when every batch fails is the sample a failure.
      const pids = [...wanted];
      const outs: string[] = [];
      let failure: unknown = null;
      let missed = 0;
      for (let i = 0; i < pids.length; i += DETAIL_BATCH) {
        const batch = pids.slice(i, i + DETAIL_BATCH);
        try {
          outs.push(await this.runPs(['-ww', '-o', DETAIL_COLUMNS, '-p', batch.join(',')]));
        } catch (err) {
          failure ??= err;
          missed += batch.length;
        }
      }
      if (outs.length === 0) throw failure;
      // A partial sample is still a sample, but it should not look whole: say once what it lacks.
      if (missed > 0) {
        this.logger?.warn('process sample: a detail batch failed; its processes are missing from this sample', {
          pids: missed,
          error: String(failure),
        });
      }
      const fine = this.readCpuSeconds ? await this.readCpuSeconds(pids).catch(() => new Map<number, number>()) : null;
      for (const row of outs.flatMap((out) => parseDetailRows(out))) {
        // A pid whose parent differs between the two ps calls exited and was reused in between: not the process the
        // tree walk found, so it is not counted (nor remembered, nor offered for pause) — unless it is a process
        // already remembered with this start time, which the OS just re-parented in that window.
        if (parentOf.get(row.pid) !== row.ppid && !this.rememberedAnywhere(row.pid, row.startToken)) continue;
        const cpu = fine?.get(row.pid);
        rows.set(row.pid, cpu === undefined ? row : { ...row, cpuSeconds: cpu });
      }
    }

    // Second pass: a remembered pid that now started at another time is a reused pid — not ours, nor its children.
    membership = this.walk(owners, rootsByOwner, parentOf, childrenOf, (owner, pid) => {
      const seen = this.remembered.get(owner)?.get(pid);
      const row = rows.get(pid);
      return !!row && (!seen || seen.startToken === row.startToken);
    });

    // Working directories, for session trees only (the unattributed group is never shown per process): read again only
    // for a process not read in the last CWD_TTL_MS. A failed read leaves '' until the next read.
    if (this.readCwds) {
      const stale: number[] = [];
      for (const [owner, members] of membership) {
        if (owner === NO_SESSION) continue;
        for (const pid of members.keys()) {
          const row = rows.get(pid);
          if (!row) continue;
          const known = this.cwds.get(`${pid}:${row.startToken}`);
          if (!known || at - known.at >= CWD_TTL_MS) stale.push(pid);
        }
      }
      if (stale.length > 0) {
        const read = await this.readCwds(stale).catch(() => new Map<number, string>());
        // The cwd reader names a pid, not a process: one that exited and was reused between the detail ps and that
        // read would hand another program's folder to this session. Its start time is read again after the cwd —
        // the same start before and after means the same process throughout.
        const after =
          read.size > 0
            ? await this.runPs(['-o', 'pid=,lstart=', '-p', [...read.keys()].join(',')])
                .then(parseStartTokens)
                .catch(() => new Map<number, string>())
            : new Map<number, string>();
        for (const pid of stale) {
          const row = rows.get(pid);
          if (!row) continue;
          const cwd = read.get(pid);
          if (cwd !== undefined && after.get(pid) !== row.startToken) continue; // unverified: read again next sample
          this.cwds.set(`${pid}:${row.startToken}`, { cwd: cwd ?? '', at });
        }
      }
    }

    const sessions: SessionProcessDetail[] = [];
    const unattributed = { processCount: 0, cpuPercent: 0, rssBytes: 0 };
    const liveCpuKeys = new Set<string>();
    const previous = new Map(this.remembered);
    this.remembered.clear();

    for (const [owner, members] of membership) {
      const rootPids = new Set(rootsByOwner.get(owner) ?? []);
      const processes: ProcessSample[] = [];
      const memory = new Map<number, Remembered>();
      for (const [pid, depth] of orderTree(members, parentOf)) {
        const row = rows.get(pid);
        if (!row) continue; // exited between the two ps calls
        const cpuKey = `${pid}:${row.startToken}`;
        liveCpuKeys.add(cpuKey);
        const cpuPercent = this.cpuPercent(cpuKey, row, at);
        const argv = splitArgs(row.args);
        const parentIsMember = members.has(row.ppid);
        processes.push({
          pid,
          ppid: row.ppid,
          startToken: row.startToken,
          depth,
          role: rootPids.has(pid) ? 'root' : parentIsMember ? 'child' : 'orphan',
          state: stateOf(row.stat),
          cpuPercent,
          rssBytes: row.rssBytes,
          name: processName(argv),
          command: commandPreview(argv),
          cwd: this.cwds.get(cpuKey)?.cwd ?? '',
        });
        memory.set(pid, { startToken: row.startToken, depth });
      }
      if (memory.size > 0) this.remembered.set(owner, memory);
      if (processes.length === 0) continue;

      const totals = sum(processes);
      if (owner === NO_SESSION) {
        unattributed.processCount += processes.length;
        unattributed.cpuPercent += totals.cpuPercent;
        unattributed.rssBytes += totals.rssBytes;
        continue;
      }
      sessions.push({
        sessionKey: owner,
        nodeId,
        rootAlive: processes.some((p) => p.role === 'root'),
        processCount: processes.length,
        stoppedCount: processes.filter((p) => p.state === 'stopped').length,
        cpuPercent: round1(totals.cpuPercent),
        rssBytes: totals.rssBytes,
        sampledAt: at,
        processes,
      });
    }

    // A remembered process still in the parent map whose detail row is missing (ps skipped or could not read it) is
    // not gone: keep remembering it, or an orphan — whose parent is gone — could never be found again. A pid reused
    // meanwhile is caught by the start-time check of the next sample.
    for (const [owner, seen] of previous) {
      for (const [pid, entry] of seen) {
        if (!parentOf.has(pid) || rows.has(pid)) continue;
        const memory = this.remembered.get(owner) ?? new Map<number, Remembered>();
        memory.set(pid, entry);
        this.remembered.set(owner, memory);
      }
    }

    for (const key of this.prevCpu.keys()) if (!liveCpuKeys.has(key)) this.prevCpu.delete(key);
    for (const key of this.cwds.keys()) if (!liveCpuKeys.has(key)) this.cwds.delete(key);
    unattributed.cpuPercent = round1(unattributed.cpuPercent);
    return { sessions, unattributed };
  }

  /** Whether this process (pid and start time) is remembered under any owner — seen, or carried over a missing row. */
  rememberedAnywhere(pid: number, startToken: string): boolean {
    for (const m of this.remembered.values()) if (m.get(pid)?.startToken === startToken) return true;
    return false;
  }

  /** The owner's remembered process with this pid, if it was in the last sample. */
  rememberedStart(sessionKey: string, pid: number): string | undefined {
    return this.remembered.get(sessionKey)?.get(pid)?.startToken;
  }

  private cpuPercent(key: string, row: PsRow, at: number): number {
    const prev = this.prevCpu.get(key);
    if (row.cpuSeconds !== null) this.prevCpu.set(key, { cpuSeconds: row.cpuSeconds, at });
    if (!prev || row.cpuSeconds === null || at <= prev.at) return round1(row.psCpuPercent);
    return round1(Math.max(0, ((row.cpuSeconds - prev.cpuSeconds) / ((at - prev.at) / 1000)) * 100));
  }

  /**
   * Owner → (pid → depth). Seeds are the owner's live roots and its remembered
   * processes that `keep` accepts; each seed's descendants follow. A pid claimed
   * by a live root's walk is never also given to another owner.
   */
  private walk(
    owners: Iterable<string>,
    rootsByOwner: Map<string, number[]>,
    parentOf: Map<number, number>,
    childrenOf: Map<number, number[]>,
    keep: (owner: string, pid: number) => boolean,
  ): Map<string, Map<number, number>> {
    const claimed = new Set<number>();
    const result = new Map<string, Map<number, number>>();
    const ownerList = [...owners];
    // Live roots first, so a live tree always wins a pid over a stale memory.
    for (const owner of ownerList) {
      const members = new Map<number, number>();
      for (const pid of rootsByOwner.get(owner) ?? []) {
        if (parentOf.has(pid) && keep(owner, pid)) this.descend(pid, 0, members, claimed, childrenOf);
      }
      result.set(owner, members);
    }
    for (const owner of ownerList) {
      const members = result.get(owner) ?? new Map<number, number>();
      for (const [pid, seen] of this.remembered.get(owner) ?? []) {
        if (claimed.has(pid) || !parentOf.has(pid) || !keep(owner, pid)) continue;
        this.descend(pid, seen.depth, members, claimed, childrenOf);
      }
      result.set(owner, members);
    }
    return result;
  }

  private descend(
    start: number,
    depth: number,
    members: Map<number, number>,
    claimed: Set<number>,
    childrenOf: Map<number, number[]>,
  ): void {
    const stack: Array<[number, number]> = [[start, depth]];
    while (stack.length > 0) {
      const [pid, d] = stack.pop() as [number, number];
      if (claimed.has(pid)) continue;
      claimed.add(pid);
      members.set(pid, d);
      for (const child of childrenOf.get(pid) ?? []) stack.push([child, d + 1]);
    }
  }
}

/** Members in tree order (each process right after its parent; tops by depth, then pid). */
function orderTree(members: Map<number, number>, parentOf: Map<number, number>): Array<[number, number]> {
  const kids = new Map<number, number[]>();
  const tops: number[] = [];
  for (const pid of members.keys()) {
    const ppid = parentOf.get(pid);
    if (ppid !== undefined && ppid !== pid && members.has(ppid)) {
      const list = kids.get(ppid) ?? [];
      list.push(pid);
      kids.set(ppid, list);
    } else tops.push(pid);
  }
  tops.sort((a, b) => (members.get(a) ?? 0) - (members.get(b) ?? 0) || a - b);
  const out: Array<[number, number]> = [];
  const visit = (pid: number) => {
    out.push([pid, members.get(pid) ?? 0]);
    for (const c of (kids.get(pid) ?? []).sort((a, b) => a - b)) visit(c);
  };
  for (const t of tops) visit(t);
  return out;
}

function sum(ps: readonly ProcessSample[]): { cpuPercent: number; rssBytes: number } {
  let cpuPercent = 0;
  let rssBytes = 0;
  for (const p of ps) {
    cpuPercent += p.cpuPercent;
    rssBytes += p.rssBytes;
  }
  return { cpuPercent, rssBytes };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** `ps -o pid=,lstart=` → pid → its start token (lstart's 5 words, single-spaced). */
function parseStartTokens(out: string): Map<number, string> {
  const tokens = new Map<number, string>();
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 6 || !/^\d+$/.test(t[0])) continue;
    tokens.set(Number(t[0]), t.slice(1, 6).join(' '));
  }
  return tokens;
}

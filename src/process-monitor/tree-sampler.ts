import { commandPreview, processName, splitArgs } from './command-preview';
import { DETAIL_COLUMNS, type PsRow, parseDetailRows, parseParentMap, stateOf } from './ps-table';
import type { NodeCapacity, ProcessSample, SessionProcessDetail } from './types';

/** A Claude Code process the SDK spawned, as the child registry knows it. */
export interface TrackedRoot {
  readonly pid: number;
  /** The work session it runs for; absent for one-shot helpers (title, dispatch, voice). */
  readonly sessionKey?: string;
}

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

  constructor(
    private readonly runPs: RunPs,
    private readonly now: () => number = Date.now,
    private readonly readCpuSeconds?: ReadCpuSeconds,
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
      const out = await this.runPs(['-ww', '-o', DETAIL_COLUMNS, '-p', [...wanted].join(',')]);
      const fine = this.readCpuSeconds
        ? await this.readCpuSeconds([...wanted]).catch(() => new Map<number, number>())
        : null;
      for (const row of parseDetailRows(out)) {
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

    const sessions: SessionProcessDetail[] = [];
    const unattributed = { processCount: 0, cpuPercent: 0, rssBytes: 0 };
    const liveCpuKeys = new Set<string>();
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

    for (const key of this.prevCpu.keys()) if (!liveCpuKeys.has(key)) this.prevCpu.delete(key);
    unattributed.cpuPercent = round1(unattributed.cpuPercent);
    return { sessions, unattributed };
  }

  private rememberedAnywhere(pid: number, startToken: string): boolean {
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

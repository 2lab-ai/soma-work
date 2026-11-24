/**
 * Process monitor wire types — one node, its capacity, and what each work
 * session's Claude Code process tree uses on it.
 *
 * Shaped per node on purpose: today every session runs on the master node, but
 * work will later be spread over worker nodes by their free CPU and memory. A
 * worker reports the same {@link NodeProcessSnapshot}; the dashboard and a future
 * scheduler read `node.capacity` and `sessions` without caring where they ran.
 */

import type { ProcessInspection } from './process-inspector';

/** Stable id of the node a snapshot was taken on (`SOMA_NODE_ID`, else the host name). */
export type NodeId = string;

/** What a node has and how much of it is in use — the input a scheduler places work by. */
export interface NodeCapacity {
  readonly nodeId: NodeId;
  /** `process.platform` of the node (`darwin`, `linux`). */
  readonly platform: string;
  /** Logical CPU cores. 100% CPU in a process sample = one core. */
  readonly cpuCount: number;
  /** Whole-node CPU in use since the previous sample, 0–100 (all cores). `null` on the first sample. */
  readonly cpuBusyPercent: number | null;
  /** 1-minute load average (0 where the platform has none). */
  readonly loadAvg1: number;
  readonly totalMemBytes: number;
  /** Memory the node can still hand out (Linux MemAvailable, macOS free+inactive+speculative pages). */
  readonly availableMemBytes: number;
}

/** Scheduler state of one process as `ps` reports it. */
export type ProcessState = 'running' | 'sleeping' | 'stopped' | 'zombie' | 'other';

/** One process in a session's tree. */
export interface ProcessSample {
  readonly pid: number;
  readonly ppid: number;
  /**
   * The process's start time as `ps` prints it. Together with `pid` it names one
   * process: a control request must send it back, so a pid the OS has since
   * reused for another program is never signalled.
   */
  readonly startToken: string;
  /** Depth under the session's Claude Code process (0 = that process). Orphans keep the depth they were seen at. */
  readonly depth: number;
  /**
   * `root` — the Claude Code process the SDK spawned for the session;
   * `child` — a live descendant of a tracked process;
   * `orphan` — seen in the tree before, its parent has since exited and the OS re-parented it.
   */
  readonly role: 'root' | 'child' | 'orphan';
  readonly state: ProcessState;
  /** CPU since the previous sample, percent of one core (may exceed 100 for multi-threaded processes). */
  readonly cpuPercent: number;
  /** Resident set size. Shared pages count once per process, so a tree total can overstate. */
  readonly rssBytes: number;
  /** Executable name, for the table. */
  readonly name: string;
  /** Command line with secrets, long values and JSON blobs cut out — never the raw argv. */
  readonly command: string;
  /** Its working directory (`''` when it could not be read). Owner and admins only on the dashboard, like `command`. */
  readonly cwd: string;
  /** Held part of each period by its task's CPU cap (`cpu-throttler.ts`) — it reads as running, not paused. */
  readonly throttled?: boolean;
}

/** Totals over one session's tree. */
export interface SessionProcessUsage {
  readonly sessionKey: string;
  readonly nodeId: NodeId;
  /** Whether the session's Claude Code process itself is alive (false = only leftover processes remain). */
  readonly rootAlive: boolean;
  readonly processCount: number;
  readonly stoppedCount: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  /** Epoch ms of the sample. */
  readonly sampledAt: number;
  /** The CPU cap on this task (percent of one core; absent: no cap — an admin's task, or caps not wired). */
  readonly cpuCapPercent?: number;
  /** Whether the cap is holding the tree now (it went over the cap). */
  readonly throttling?: boolean;
}

export interface SessionProcessDetail extends SessionProcessUsage {
  /** Tree order: each process right after its parent. */
  readonly processes: readonly ProcessSample[];
}

/** Everything one node reports per sample. */
export interface NodeProcessSnapshot {
  readonly node: NodeCapacity;
  readonly sampledAt: number;
  readonly sessions: readonly SessionProcessDetail[];
  /** Claude Code processes the SDK spawned with no session (title, dispatch, voice one-shots) and their trees. */
  readonly unattributed: { readonly processCount: number; readonly cpuPercent: number; readonly rssBytes: number };
}

/** A process next to the one in a detail view (its parent chain, its children), as the tree sampled it. */
export interface ProcessRelative {
  readonly pid: number;
  readonly startToken: string;
  readonly name: string;
  readonly role: ProcessSample['role'];
  readonly state: ProcessState;
  readonly cpuPercent: number;
  readonly rssBytes: number;
}

/**
 * One process in depth (the detail view): what the OS says of it ({@link ProcessInspection}) plus where it sits in its
 * session's tree. A snapshot — read once, never refreshed on a timer.
 */
export interface ProcessDetailSnapshot extends ProcessInspection {
  readonly sessionKey: string;
  readonly nodeId: NodeId;
  readonly name: string;
  /** The table's allow-list preview of the command (the full line is `commandLine`). */
  readonly command: string;
  readonly role: ProcessSample['role'];
  readonly depth: number;
  /** CPU in the sample the tree was checked against (percent of one core). */
  readonly cpuPercent: number;
  readonly sampledAt: number;
  /** From the session's Claude Code process down to this one's parent. */
  readonly ancestors: readonly ProcessRelative[];
  readonly children: readonly ProcessRelative[];
  /** This process and everything under it. */
  readonly subtree: { readonly processCount: number; readonly cpuPercent: number; readonly rssBytes: number };
}

export type ProcessInspectResult =
  | { readonly ok: true; readonly detail: ProcessDetailSnapshot }
  | {
      readonly ok: false;
      /**
       * As {@link ProcessControlResult}: `not-found`, `stale` (reused pid), `unsupported` (no inspector on this node);
       * `busy` — other detail reads are in line (try again shortly).
       */
      readonly reason: 'not-found' | 'stale' | 'unsupported' | 'busy';
    };

export type ProcessControlAction = 'pause' | 'resume';

export type ProcessControlResult =
  | { readonly ok: true; readonly pid: number; readonly state: ProcessState }
  | {
      readonly ok: false;
      /**
       * `not-found` — the pid is not in this session's tree (or the session has no live tree);
       * `stale` — the pid is in the tree but started at a different time than the caller saw (reused pid);
       * `denied` — the OS refused the signal;
       * `unsupported` — the platform has no job-control signals (Windows).
       */
      readonly reason: 'not-found' | 'stale' | 'denied' | 'unsupported';
    };

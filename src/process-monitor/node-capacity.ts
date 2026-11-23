import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import type { NodeCapacity, NodeId } from './types';

/** Runs a fixed read-only command (`vm_stat`) and returns stdout. */
export type RunCommand = (cmd: string, args: readonly string[]) => Promise<string>;

export interface NodeCapacityDeps {
  readonly nodeId: NodeId;
  readonly platform?: string;
  readonly cpus?: () => os.CpuInfo[];
  readonly loadavg?: () => number[];
  readonly totalmem?: () => number;
  readonly freemem?: () => number;
  readonly readFile?: (path: string) => Promise<string>;
  readonly run?: RunCommand;
}

/** `/proc/meminfo` → MemAvailable bytes, or null. */
export function parseMemAvailable(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

/**
 * `vm_stat` → bytes the kernel can hand out without paging: free + inactive +
 * speculative + purgeable pages (what Activity Monitor counts as not under
 * pressure). Returns null when the page size or free count is missing.
 */
export function parseVmStatAvailable(out: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(out);
  if (!pageSize) return null;
  const pages = (label: string): number => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?$`, 'm').exec(out);
    return m ? Number(m[1]) : 0;
  };
  const free = /^Pages free:\s+(\d+)\.?$/m.exec(out);
  if (!free) return null;
  return (Number(free[1]) + pages('inactive') + pages('speculative') + pages('purgeable')) * Number(pageSize[1]);
}

/**
 * Reads what this node has and how busy it is. Whole-node CPU is the change in
 * the kernel's per-core busy/idle counters since the previous call.
 */
export function createNodeCapacityReader(deps: NodeCapacityDeps): () => Promise<NodeCapacity> {
  const platform = deps.platform ?? process.platform;
  const cpus = deps.cpus ?? os.cpus;
  const loadavg = deps.loadavg ?? os.loadavg;
  const totalmem = deps.totalmem ?? os.totalmem;
  const freemem = deps.freemem ?? os.freemem;
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  let prev: { busy: number; total: number } | null = null;

  const available = async (): Promise<number> => {
    try {
      if (platform === 'linux') return parseMemAvailable(await readFile('/proc/meminfo')) ?? freemem();
      if (platform === 'darwin' && deps.run) {
        const out = await deps.run('vm_stat', []);
        return parseVmStatAvailable(out) ?? freemem();
      }
    } catch {
      // A failed read leaves the portable (lower) number; capacity is advisory.
    }
    return freemem();
  };

  return async () => {
    const list = cpus();
    let busy = 0;
    let total = 0;
    for (const c of list) {
      const t = c.times;
      const all = t.user + t.nice + t.sys + t.idle + t.irq;
      total += all;
      busy += all - t.idle;
    }
    let cpuBusyPercent: number | null = null;
    if (prev && total > prev.total) {
      cpuBusyPercent = Math.round(((busy - prev.busy) / (total - prev.total)) * 1000) / 10;
    }
    prev = { busy, total };
    return {
      nodeId: deps.nodeId,
      platform,
      cpuCount: list.length,
      cpuBusyPercent,
      loadAvg1: Math.round((loadavg()[0] ?? 0) * 100) / 100,
      totalMemBytes: totalmem(),
      availableMemBytes: await available(),
    };
  };
}

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { getClaudeChildProcessRegistry } from '../agent-runtime/claude-child-process-registry';
import { getProcessMonitorNodeId } from '../config';
import { Logger } from '../logger';
import type { RunCommand } from './node-capacity';
import { LocalProcessMonitor } from './process-monitor';
import type { RunPs } from './tree-sampler';

export type { ProcessControlInput, ProcessHost } from './process-monitor';
export { LocalProcessMonitor } from './process-monitor';
export type * from './types';

const logger = new Logger('ProcessMonitor');
const PS_TIMEOUT_MS = 4_000;
const PS_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Run a fixed read-only binary (`ps`, `vm_stat`) with `LC_ALL=C` so column
 * formats do not change with the locale. ps exits 1 when one of the `-p` pids
 * is gone; its stdout still lists the others, so that case resolves.
 */
export const runReadOnly: RunCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' } },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        if ((error as { code?: unknown }).code === 1 && typeof stdout === 'string') {
          return resolve(stdout);
        }
        reject(error);
      },
    );
  });

const runPs: RunPs = (args) => runReadOnly('ps', args);

let monitor: LocalProcessMonitor | null = null;

/** The daemon's monitor of its own node. Created on first use; `startProcessMonitor` starts the timer. */
export function getProcessMonitor(): LocalProcessMonitor {
  if (!monitor) {
    monitor = new LocalProcessMonitor({
      nodeId: getProcessMonitorNodeId() ?? os.hostname(),
      roots: getClaudeChildProcessRegistry(),
      runPs,
      runCommand: runReadOnly,
      logger,
    });
  }
  return monitor;
}

export function startProcessMonitor(): LocalProcessMonitor {
  const m = getProcessMonitor();
  m.start();
  return m;
}

/** Test isolation only. */
export function resetProcessMonitorForTests(): void {
  monitor?.stop();
  monitor = null;
}

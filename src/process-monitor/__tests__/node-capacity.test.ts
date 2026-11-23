import type * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { createNodeCapacityReader, parseMemAvailable, parseVmStatAvailable } from '../node-capacity';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  1000.
Pages active:                                5000.
Pages inactive:                              2000.
Pages speculative:                            500.
Pages throttled:                                0.
Pages wired down:                            3000.
Pages purgeable:                              100.
`;

const cpu = (busy: number, idle: number): os.CpuInfo => ({
  model: 'x',
  speed: 1,
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
});

describe('node capacity', () => {
  it('reads macOS vm_stat as free + inactive + speculative + purgeable pages', () => {
    expect(parseVmStatAvailable(VM_STAT)).toBe((1000 + 2000 + 500 + 100) * 16384);
    expect(parseVmStatAvailable('nothing')).toBeNull();
  });

  it('reads Linux MemAvailable', () => {
    expect(parseMemAvailable('MemTotal:  100 kB\nMemAvailable:   2048 kB\n')).toBe(2048 * 1024);
    expect(parseMemAvailable('MemTotal: 1 kB')).toBeNull();
  });

  it('reports whole-node CPU as the busy share since the previous read; null on the first', async () => {
    let times = [cpu(100, 900), cpu(100, 900)];
    const read = createNodeCapacityReader({
      nodeId: 'n1',
      platform: 'linux',
      cpus: () => times,
      loadavg: () => [2.345, 0, 0],
      totalmem: () => 8e9,
      freemem: () => 1e9,
      readFile: async () => 'MemAvailable:   4000000 kB\n',
    });
    const first = await read();
    expect(first).toEqual({
      nodeId: 'n1',
      platform: 'linux',
      cpuCount: 2,
      cpuBusyPercent: null,
      loadAvg1: 2.35,
      totalMemBytes: 8e9,
      availableMemBytes: 4000000 * 1024,
    });
    // +300 busy, +100 idle per core → 75%.
    times = [cpu(400, 1000), cpu(400, 1000)];
    expect((await read()).cpuBusyPercent).toBe(75);
  });

  it('falls back to os.freemem when the platform read fails', async () => {
    const read = createNodeCapacityReader({
      nodeId: 'n1',
      platform: 'darwin',
      cpus: () => [cpu(1, 1)],
      freemem: () => 123,
      run: async () => {
        throw new Error('no vm_stat');
      },
    });
    expect((await read()).availableMemBytes).toBe(123);
  });
});

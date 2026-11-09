import * as os from 'os';
import { describe, expect, it } from 'vitest';
import { availableMemoryMb } from '../a2t-service';

// A 128 GB Mac at rest: the free list is ~2 GB, but 40 GB is inactive (reclaimable on demand). os.freemem() reports
// only the free list, so the 4 GB dictation floor refused to start the Whisper worker at boot; the Python worker's own
// check (psutil available = free + inactive) would have passed.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              132678.
Pages active:                           2471234.
Pages inactive:                         2481856.
Pages speculative:                        58112.
Pages throttled:                              0.
Pages wired down:                        402311.
Pages purgeable:                          29421.
`;
const MB = 1024 * 1024;

describe('availableMemoryMb — memory the OS can give a new worker', () => {
  it('on macOS counts free + inactive + speculative pages from vm_stat', () => {
    const mb = availableMemoryMb({ platform: 'darwin', vmStat: () => VM_STAT });
    expect(mb).toBeCloseTo(((132678 + 2481856 + 58112) * 16384) / MB, 0);
    expect(mb).toBeGreaterThan(40_000);
  });

  it('on macOS falls back to os.freemem() when vm_stat fails', () => {
    const mb = availableMemoryMb({
      platform: 'darwin',
      vmStat: () => {
        throw new Error('vm_stat: not found');
      },
    });
    expect(mb).toBeCloseTo(os.freemem() / MB, -2);
  });

  it('on macOS never reports less than os.freemem()', () => {
    const mb = availableMemoryMb({ platform: 'darwin', vmStat: () => 'garbage' });
    expect(mb).toBeGreaterThanOrEqual(Math.floor(os.freemem() / MB) - 1);
  });

  it('elsewhere is os.freemem() (Linux reports MemAvailable there)', () => {
    let called = false;
    const mb = availableMemoryMb({
      platform: 'linux',
      vmStat: () => {
        called = true;
        return VM_STAT;
      },
    });
    expect(called).toBe(false);
    expect(mb).toBeCloseTo(os.freemem() / MB, -2);
  });
});

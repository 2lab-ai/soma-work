import { beforeEach, describe, expect, it, vi } from 'vitest';
import { availableMemoryMb } from '../a2t-service';

// os.freemem() (the free list) is the floor of the answer, so every case pins it. A case that compares against the
// live value passes on a host with a big free list even when vm_stat is ignored, and two live reads can drift apart.
const { freemem } = vi.hoisted(() => ({ freemem: vi.fn<() => number>() }));
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  return { ...real, default: { ...real, freemem }, freemem };
});

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
const FREE_LIST_MB = 2_048;

describe('availableMemoryMb — memory the OS can give a new worker', () => {
  beforeEach(() => {
    freemem.mockReset();
    freemem.mockReturnValue(FREE_LIST_MB * MB);
  });

  it('on macOS counts free + inactive + speculative pages from vm_stat', () => {
    // (132678 + 2481856 + 58112) pages * 16 KiB = 41,760.09375 MB
    expect(availableMemoryMb({ platform: 'darwin', vmStat: () => VM_STAT })).toBe(41_760.09375);
  });

  it('on macOS a free list larger than the vm_stat total wins', () => {
    freemem.mockReturnValue(50_000 * MB);
    expect(availableMemoryMb({ platform: 'darwin', vmStat: () => VM_STAT })).toBe(50_000);
  });

  it('on macOS falls back to os.freemem() when vm_stat fails', () => {
    const mb = availableMemoryMb({
      platform: 'darwin',
      vmStat: () => {
        throw new Error('vm_stat: not found');
      },
    });
    expect(mb).toBe(FREE_LIST_MB);
  });

  it('on macOS never reports less than os.freemem()', () => {
    expect(availableMemoryMb({ platform: 'darwin', vmStat: () => 'garbage' })).toBe(FREE_LIST_MB);
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
    expect(mb).toBe(FREE_LIST_MB);
  });
});

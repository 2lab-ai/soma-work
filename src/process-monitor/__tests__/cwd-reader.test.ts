import { describe, expect, it, vi } from 'vitest';
import { createCwdReader, parseLsofCwds } from '../cwd-reader';

describe('cwd reader', () => {
  it('parses lsof -F pn records: the first absolute path per pid', () => {
    expect(parseLsofCwds('p100\nn/work/repo\np200\nn/tmp\np300\nnrelative\np0\nn/x\n')).toEqual(
      new Map([
        [100, '/work/repo'],
        [200, '/tmp'],
      ]),
    );
  });

  it('macOS: one lsof call for every pid, cwd descriptors only, no warnings', async () => {
    const run = vi.fn(async () => 'p1\nn/a\np2\nn/b\n');
    const read = createCwdReader('darwin', run);
    expect(await read?.([1, 2])).toEqual(
      new Map([
        [1, '/a'],
        [2, '/b'],
      ]),
    );
    expect(run).toHaveBeenCalledWith('/usr/sbin/lsof', ['-a', '-w', '-d', 'cwd', '-F', 'pn', '-p', '1,2']);
    expect(await read?.([])).toEqual(new Map());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('Linux: /proc/<pid>/cwd per pid; a pid that does not answer is left out', async () => {
    const readLink = vi.fn(async (p: string) => {
      if (p === '/proc/2/cwd') throw new Error('EACCES');
      return p === '/proc/1/cwd' ? '/work' : 'not-absolute';
    });
    const read = createCwdReader('linux', vi.fn(), readLink);
    expect(await read?.([1, 2, 3])).toEqual(new Map([[1, '/work']]));
  });

  it('no reader elsewhere', () => {
    expect(createCwdReader('win32', vi.fn())).toBeUndefined();
  });
});

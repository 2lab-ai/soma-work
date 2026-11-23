import { describe, expect, it } from 'vitest';
import { parseCpuTime, parseDetailRows, parseParentMap, stateOf } from '../ps-table';

describe('parseCpuTime', () => {
  it('reads the macOS MMM:SS.ss form, minutes past 59 included', () => {
    expect(parseCpuTime('0:01.50')).toBeCloseTo(1.5);
    expect(parseCpuTime('793:38.18')).toBeCloseTo(793 * 60 + 38.18);
  });

  it('reads the Linux [DD-]HH:MM:SS form', () => {
    expect(parseCpuTime('00:01:23')).toBe(83);
    expect(parseCpuTime('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  });

  it('refuses anything else', () => {
    for (const bad of ['', '-', '12', 'a:b', '1:2:3:4', '1::2']) expect(parseCpuTime(bad)).toBeNull();
  });
});

describe('parseParentMap', () => {
  it('maps pid to ppid and skips malformed lines', () => {
    const map = parseParentMap('    1     0\n  200     1\n garbage\n  201   200\n');
    expect([...map]).toEqual([
      [1, 0],
      [200, 1],
      [201, 200],
    ]);
  });
});

describe('parseDetailRows', () => {
  const line = (pid: number, ppid: number, stat: string, args: string) =>
    `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${stat.padEnd(4)} Mon Nov  3 09:05:07 2026     0:02.50   3.1  20480 ${args}`;

  it('reads every column, keeps the start time whole and argv with its inner spaces', () => {
    const [row] = parseDetailRows(`${line(300, 200, 'S+', '/usr/bin/node  /opt/x/cli.js --flag')}\n`);
    expect(row).toEqual({
      pid: 300,
      ppid: 200,
      stat: 'S+',
      startToken: 'Mon Nov 3 09:05:07 2026',
      cpuSeconds: 2.5,
      psCpuPercent: 3.1,
      rssBytes: 20480 * 1024,
      args: '/usr/bin/node  /opt/x/cli.js --flag',
    });
  });

  it('skips a line without argv or with a non-numeric pid', () => {
    const out = [
      line(300, 200, 'S', ''),
      'abc 1 S Mon Nov 3 09:05:07 2026 0:00.00 0.0 1 x',
      line(301, 200, 'R', 'ok'),
    ].join('\n');
    expect(parseDetailRows(out).map((r) => r.pid)).toEqual([301]);
  });
});

describe('stateOf', () => {
  it('maps the BSD and procps letters', () => {
    expect(stateOf('R+')).toBe('running');
    expect(stateOf('Ss')).toBe('sleeping');
    expect(stateOf('I')).toBe('sleeping');
    expect(stateOf('D')).toBe('sleeping');
    expect(stateOf('T')).toBe('stopped');
    expect(stateOf('t')).toBe('stopped');
    expect(stateOf('Z')).toBe('zombie');
    expect(stateOf('?')).toBe('other');
  });
});

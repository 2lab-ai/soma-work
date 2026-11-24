import { describe, expect, it, vi } from 'vitest';
import {
  createProcessInspector,
  fdTypeOfLink,
  formatProcNetAddress,
  parseElapsed,
  parseLsofFds,
  parseLstart,
  parseProcIo,
  parseProcNetInet,
  parseProcNetUnix,
  parseProcStatus,
  parsePsDetail,
} from '../process-inspector';

const START = 'Tue Nov 24 15:50:48 2026';
/** One `ps -o pid=,ppid=,pgid=,uid=,user=,stat=,nice=,pri=,%cpu=,%mem=,rss=,vsz=,time=,etime=,lstart=` line. */
const psLine = (start = START, pid = 4242) =>
  `${pid} 4000 4000   501 zhuge Ss    0  20   113.0  2.5  3145728 435308384   12:03.50 01:02:03 ${start}\n`;

/** lsof -F ftnPT of a node process: cwd, the binary and two libraries, stdio, a file, a listening and a connected socket, a unix socket. */
const LSOF = [
  'p4242',
  'fcwd',
  'tDIR',
  'n/work/repo',
  'ftxt',
  'tREG',
  'n/opt/homebrew/bin/node',
  'ftxt',
  'tREG',
  'n/usr/lib/libc.dylib',
  'ftxt',
  'tREG',
  'n/usr/lib/libz.dylib',
  'f0u',
  'tCHR',
  'n/dev/ttys001',
  'f5r',
  'tREG',
  'n/work/repo/package.json',
  'f12u',
  'tIPv4',
  'PTCP',
  'n*:8764',
  'TST=LISTEN',
  'TQR=0',
  'f13u',
  'tIPv6',
  'PTCP',
  'n[::1]:50000->[::1]:443',
  'TST=ESTABLISHED',
  'f14u',
  'tunix',
  'n->0x3ffedfa513a7ae6b',
  'frtd',
  'tDIR',
  'n/',
].join('\n');

describe('process inspector parsers', () => {
  it('ps detail: every fixed column, lstart last', () => {
    expect(parsePsDetail(psLine())).toEqual({
      pid: 4242,
      ppid: 4000,
      pgid: 4000,
      uid: 501,
      user: 'zhuge',
      stat: 'Ss',
      nice: 0,
      priority: 20,
      psCpuPercent: 113,
      memPercent: 2.5,
      rssBytes: 3145728 * 1024,
      vszBytes: 435308384 * 1024,
      cpuSeconds: 12 * 60 + 3.5,
      elapsedSeconds: 3723,
      startToken: START,
    });
    expect(parsePsDetail('')).toBeNull();
    expect(parsePsDetail('4242 4000 short\n')).toBeNull();
  });

  it('elapsed and lstart', () => {
    expect([parseElapsed('00:05'), parseElapsed('01:02:03'), parseElapsed('2-01:00:00'), parseElapsed('x')]).toEqual([
      5,
      3723,
      2 * 86400 + 3600,
      null,
    ]);
    expect(parseLstart(START)).toBe(new Date(2026, 10, 24, 15, 50, 48).getTime());
    expect(parseLstart('Mon Nov  3 09:05:01 2026')).toBe(new Date(2026, 10, 3, 9, 5, 1).getTime());
    expect(parseLstart('garbage')).toBeNull();
  });

  it('lsof: cwd and the binary named, libraries counted not listed, numbered descriptors split into files and sockets', () => {
    const t = parseLsofFds(LSOF);
    expect(t.cwd).toBe('/work/repo');
    expect(t.exe).toBe('/opt/homebrew/bin/node');
    expect(t.count).toBe(5);
    expect(t.byType).toEqual({ txt: 3, CHR: 1, REG: 1, IPv4: 1, IPv6: 1, unix: 1 });
    expect(t.files).toEqual([
      { fd: '0', type: 'CHR', name: '/dev/ttys001' },
      { fd: '5', type: 'REG', name: '/work/repo/package.json' },
    ]);
    expect(t.sockets).toEqual([
      { fd: '12', proto: 'TCP', local: '*:8764', remote: '', state: 'LISTEN' },
      { fd: '13', proto: 'TCP', local: '[::1]:50000', remote: '[::1]:443', state: 'ESTABLISHED' },
      { fd: '14', proto: 'unix', local: '->0x3ffedfa513a7ae6b', remote: '', state: '' },
    ]);
  });

  it('/proc/net addresses: little-endian IPv4, IPv6 words, v4-mapped', () => {
    expect(formatProcNetAddress('0100007F:1F90')).toBe('127.0.0.1:8080');
    expect(formatProcNetAddress('00000000000000000000000001000000:01BB')).toBe('[::1]:443');
    expect(formatProcNetAddress('0000000000000000FFFF00000100007F:0050')).toBe('127.0.0.1:80');
    expect(formatProcNetAddress('00000000000000000000000000000000:0016')).toBe('[::]:22');
  });

  it('/proc/net tables → inode → socket; unix paths; status; io; fd link types', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5151 1',
      '   1: 0100007F:C350 0100007F:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 5152 1',
      '   2: 0100007F:C351 0100007F:01BB 06 00000000:00000000 00:00000000 00000000  1000        0 0 1',
    ].join('\n');
    const m = parseProcNetInet(tcp, 'TCP');
    expect(m.get('5151')).toEqual({ proto: 'TCP', local: '127.0.0.1:8080', remote: '', state: 'LISTEN' });
    expect(m.get('5152')).toEqual({
      proto: 'TCP',
      local: '127.0.0.1:50000',
      remote: '127.0.0.1:443',
      state: 'ESTABLISHED',
    });
    expect(m.size).toBe(2);
    expect(
      parseProcNetUnix(
        'Num RefCount Protocol Flags Type St Inode Path\nffff: 00000002 00000000 00010000 0001 01 7777 /run/x.sock\nffff: 00000002 00000000 00000000 0001 03 7778\n',
      ),
    ).toEqual(
      new Map([
        ['7777', '/run/x.sock'],
        ['7778', ''],
      ]),
    );
    expect(
      parseProcStatus(
        'Name:\tnode\nThreads:\t11\nVmHWM:\t  204800 kB\nvoluntary_ctxt_switches:\t42\nnonvoluntary_ctxt_switches:\t7\n',
      ),
    ).toEqual({ threads: 11, peakRssBytes: 204800 * 1024, contextSwitches: { voluntary: 42, involuntary: 7 } });
    expect(parseProcStatus('Name:\tx\n')).toEqual({ threads: null, peakRssBytes: null, contextSwitches: null });
    expect(parseProcIo('rchar: 1\nread_bytes: 4096\nwrite_bytes: 8192\n')).toEqual({
      readBytes: 4096,
      writeBytes: 8192,
    });
    expect(parseProcIo('')).toBeNull();
    expect(['socket:[1]', 'pipe:[2]', 'anon_inode:[eventpoll]', '/dev/null', '/work/a', 'x'].map(fdTypeOfLink)).toEqual(
      ['sock', 'PIPE', 'a_inode', 'CHR', 'REG', '?'],
    );
  });
});

describe('createProcessInspector', () => {
  it('macOS: ps + ps -M + lsof → one snapshot; the command line is masked; no environment is read', async () => {
    const run = vi.fn(async (cmd: string, args: readonly string[]) => {
      if (cmd === '/usr/sbin/lsof') return LSOF;
      if (args.includes('args='))
        return 'node /work/repo/node_modules/.bin/tsc --token hunter2 --mcp-config {"a":"b"}\n';
      if (args[0] === '-M')
        return 'USER PID TT %CPU STAT PRI STIME UTIME COMMAND\nz 4242 s001 1.0 S 31T 0:00.01 0:00.02 node\n   4242 0.0 S 31T 0:00.00 0:00.00\n';
      return psLine();
    });
    const inspect = createProcessInspector({
      platform: 'darwin',
      run,
      now: () => 99,
      self: { uid: 501, name: 'somabot' },
    });
    const got = await inspect?.(4242, START);
    expect(got).toMatchObject({
      pid: 4242,
      ppid: 4000,
      exe: '/opt/homebrew/bin/node',
      cwd: '/work/repo',
      commandLine: 'node /work/repo/node_modules/.bin/tsc --token ••• --mcp-config {•••}',
      argvExact: false,
      // The daemon's own uid: its full name (Linux ps truncates long ones).
      user: 'somabot',
      threads: 2,
      fdCount: 5,
      state: 'sleeping',
      psCpuPercent: 113,
      takenAt: 99,
      unreadable: [],
    });
    expect(run.mock.calls.every(([, args]) => !args.some((a) => /env|environ|-E/.test(a)))).toBe(true);
  });

  it('refuses a reused pid — before the read (stale), after it (stale), or a pid gone (gone)', async () => {
    const other = 'Wed Nov 25 01:00:00 2026';
    const at = (lines: string[]) => {
      let i = 0;
      return vi.fn(async (cmd: string, args: readonly string[]) => {
        if (cmd === 'ps' && args.includes('-ww') && args.some((a) => a.includes('lstart='))) return lines[i++] ?? '';
        return '';
      });
    };
    const mk = (run: ReturnType<typeof at>) => createProcessInspector({ platform: 'darwin', run, self: undefined });
    expect(await mk(at([psLine(other)]))?.(4242, START)).toBe('stale');
    expect(await mk(at([psLine(), psLine(other)]))?.(4242, START)).toBe('stale');
    expect(await mk(at(['']))?.(4242, START)).toBe('gone');
    expect(await mk(at([psLine(), '']))?.(4242, START)).toBe('gone');
  });

  it('a part the OS will not give is listed in unreadable; the rest still answers', async () => {
    const run = vi.fn(async (cmd: string, args: readonly string[]) => {
      if (cmd === '/usr/sbin/lsof') throw new Error('lsof failed');
      if (args[0] === '-M') throw new Error('no');
      if (args.includes('comm=')) return '/usr/bin/node\n';
      if (args.includes('args=')) return 'node x.js\n';
      return psLine();
    });
    const got = await createProcessInspector({ platform: 'darwin', run })?.(4242, START);
    expect(got).toMatchObject({
      exe: '/usr/bin/node',
      cwd: '',
      fdCount: null,
      threads: null,
      unreadable: ['threads', 'files'],
    });
  });

  it('Linux: exact argv from /proc cmdline (quoted, masked), /proc status, io, fd links resolved to sockets', async () => {
    const files: Record<string, string> = {
      '/proc/4242/cmdline': 'bash\0-c\0curl -H "Authorization: Bearer abc" https://x\0',
      '/proc/4242/status':
        'Threads:\t3\nVmHWM:\t1000 kB\nvoluntary_ctxt_switches:\t5\nnonvoluntary_ctxt_switches:\t6\n',
      '/proc/4242/io': 'read_bytes: 10\nwrite_bytes: 20\n',
      '/proc/4242/net/tcp':
        'header\n   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5151 1\n',
      '/proc/4242/net/unix': 'Num RefCount Protocol Flags Type St Inode Path\nffff: 2 0 0 1 1 6000 /run/a.sock\n',
    };
    const links: Record<string, string> = {
      '/proc/4242/exe': '/usr/bin/bash',
      '/proc/4242/cwd': '/work',
      '/proc/4242/fd/0': '/dev/null',
      '/proc/4242/fd/1': 'pipe:[9]',
      '/proc/4242/fd/3': 'socket:[5151]',
      '/proc/4242/fd/4': 'socket:[6000]',
    };
    const inspect = createProcessInspector({
      platform: 'linux',
      run: async () => psLine(),
      readFile: async (p) => {
        if (p in files) return files[p];
        throw new Error('ENOENT');
      },
      readLink: async (p) => {
        if (p in links) return links[p];
        throw new Error('ENOENT');
      },
      readDir: async () => ['0', '1', '3', '4'],
    });
    const got = await inspect?.(4242, START);
    expect(got).toMatchObject({
      exe: '/usr/bin/bash',
      cwd: '/work',
      argvExact: true,
      threads: 3,
      peakRssBytes: 1000 * 1024,
      contextSwitches: { voluntary: 5, involuntary: 6 },
      io: { readBytes: 10, writeBytes: 20 },
      fdCount: 4,
      fdByType: { CHR: 1, PIPE: 1, IPv4: 1, unix: 1 },
      sockets: [
        { fd: '3', proto: 'TCP', local: '127.0.0.1:8080', remote: '', state: 'LISTEN' },
        { fd: '4', proto: 'unix', local: '/run/a.sock', remote: '', state: '' },
      ],
    });
    expect(got && got !== 'gone' && got !== 'stale' ? got.commandLine : '').toBe(
      `bash -c 'curl -H "Authorization: •••'`,
    );
  });

  it('none on Windows', () => {
    expect(createProcessInspector({ platform: 'win32', run: vi.fn() })).toBeUndefined();
  });
});

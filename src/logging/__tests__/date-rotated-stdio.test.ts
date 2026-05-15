import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLogPath,
  type DateRotatedStdioHandle,
  formatLocalDateStamp,
  installDateRotatedStdio,
  parseDateFromLogFilename,
} from '../date-rotated-stdio';

describe('formatLocalDateStamp', () => {
  it('formats date in local timezone as YYYY-MM-DD', () => {
    const d = new Date(2026, 4, 15, 23, 59, 59);
    expect(formatLocalDateStamp(d)).toBe('2026-05-15');
  });

  it('pads single-digit month and day', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(formatLocalDateStamp(d)).toBe('2026-01-01');
  });

  it('rolls to the next day past local midnight', () => {
    const before = new Date(2026, 4, 15, 23, 59, 59);
    const after = new Date(2026, 4, 16, 0, 0, 0);
    expect(formatLocalDateStamp(before)).toBe('2026-05-15');
    expect(formatLocalDateStamp(after)).toBe('2026-05-16');
  });
});

describe('buildLogPath', () => {
  it('joins logsDir, prefix, and date stamp into <prefix>-<date>.log', () => {
    expect(buildLogPath('/var/log/svc', 'stdout', '2026-05-15')).toBe('/var/log/svc/stdout-2026-05-15.log');
    expect(buildLogPath('/var/log/svc', 'stderr', '2026-05-15')).toBe('/var/log/svc/stderr-2026-05-15.log');
  });
});

describe('parseDateFromLogFilename', () => {
  it('extracts date from <prefix>-YYYY-MM-DD.log', () => {
    expect(parseDateFromLogFilename('stdout-2026-05-15.log')).toBe('2026-05-15');
    expect(parseDateFromLogFilename('stderr-2026-01-01.log')).toBe('2026-01-01');
  });

  it('returns null for filenames that do not match the rotated-log shape', () => {
    expect(parseDateFromLogFilename('stdout.log')).toBe(null);
    expect(parseDateFromLogFilename('app.log')).toBe(null);
    expect(parseDateFromLogFilename('stdout-2026-05-15.txt')).toBe(null);
    expect(parseDateFromLogFilename('stdout-bad-date.log')).toBe(null);
  });
});

describe('installDateRotatedStdio', () => {
  let tmpDir: string;
  let handle: DateRotatedStdioHandle | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'date-rotated-stdio-test-'));
    handle = null;
  });

  afterEach(() => {
    if (handle) {
      handle.uninstall();
      handle = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes stdout chunks to <logsDir>/stdout-<today>.log', () => {
    const now = new Date(2026, 4, 15, 10, 0, 0);
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    process.stdout.write('hello\n');
    process.stdout.write('world\n');
    handle.flush();
    const expected = path.join(tmpDir, 'stdout-2026-05-15.log');
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, 'utf-8')).toBe('hello\nworld\n');
  });

  it('writes stderr chunks to <logsDir>/stderr-<today>.log', () => {
    const now = new Date(2026, 4, 15, 10, 0, 0);
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    process.stderr.write('oops\n');
    handle.flush();
    const expected = path.join(tmpDir, 'stderr-2026-05-15.log');
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, 'utf-8')).toBe('oops\n');
  });

  it('opens a NEW file when the local date rolls over (midnight rotation)', () => {
    let now = new Date(2026, 4, 15, 23, 59, 59);
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    process.stdout.write('day1\n');
    now = new Date(2026, 4, 16, 0, 0, 1);
    process.stdout.write('day2\n');
    handle.flush();
    expect(fs.readFileSync(path.join(tmpDir, 'stdout-2026-05-15.log'), 'utf-8')).toBe('day1\n');
    expect(fs.readFileSync(path.join(tmpDir, 'stdout-2026-05-16.log'), 'utf-8')).toBe('day2\n');
  });

  it('accepts Buffer chunks', () => {
    const now = new Date(2026, 4, 15, 10, 0, 0);
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    process.stdout.write(Buffer.from('binary\n'));
    handle.flush();
    expect(fs.readFileSync(path.join(tmpDir, 'stdout-2026-05-15.log'), 'utf-8')).toBe('binary\n');
  });

  it('honors explicit encoding for string chunks', () => {
    const now = new Date(2026, 4, 15, 10, 0, 0);
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    // 'hello' in base64 is 'aGVsbG8='
    process.stdout.write('aGVsbG8=', 'base64');
    handle.flush();
    expect(fs.readFileSync(path.join(tmpDir, 'stdout-2026-05-15.log'), 'utf-8')).toBe('hello');
  });

  it('is idempotent — second install returns the same handle, no double-wrap', () => {
    const now = new Date(2026, 4, 15, 10, 0, 0);
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    const handle2 = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    expect(handle2).toBe(handle);
    process.stdout.write('once\n');
    handle.flush();
    // If wrapped twice, content would be duplicated. Assert single copy.
    expect(fs.readFileSync(path.join(tmpDir, 'stdout-2026-05-15.log'), 'utf-8')).toBe('once\n');
  });

  it('uninstall restores original write and closes fds', () => {
    const now = new Date(2026, 4, 15, 10, 0, 0);
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    expect(process.stdout.write).not.toBe(originalStdoutWrite);
    expect(process.stderr.write).not.toBe(originalStderrWrite);
    handle.uninstall();
    handle = null;
    expect(process.stdout.write).toBe(originalStdoutWrite);
    expect(process.stderr.write).toBe(originalStderrWrite);
  });

  it('does NOT call original write when passthrough is false', () => {
    const now = new Date(2026, 4, 15, 10, 0, 0);
    const original = process.stdout.write.bind(process.stdout);
    let calls = 0;
    const capturing = ((_chunk: unknown) => {
      calls++;
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capturing;
    try {
      handle = installDateRotatedStdio({
        logsDir: tmpDir,
        clock: () => now,
        passthrough: false,
        scheduleRetention: false,
      });
      process.stdout.write('silent\n');
    } finally {
      handle?.uninstall();
      handle = null;
      process.stdout.write = original;
    }
    expect(calls).toBe(0);
  });

  it('DOES call original write when passthrough is true', () => {
    const now = new Date(2026, 4, 15, 10, 0, 0);
    const original = process.stdout.write.bind(process.stdout);
    let calls = 0;
    const capturing = ((_chunk: unknown) => {
      calls++;
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capturing;
    try {
      handle = installDateRotatedStdio({
        logsDir: tmpDir,
        clock: () => now,
        passthrough: true,
        scheduleRetention: false,
      });
      process.stdout.write('echoed\n');
    } finally {
      handle?.uninstall();
      handle = null;
      process.stdout.write = original;
    }
    expect(calls).toBe(1);
  });

  it('prunes files older than retentionDays based on filename date, keeps today and unrelated files', () => {
    const oldFile = path.join(tmpDir, 'stdout-2026-04-01.log');
    const recentFile = path.join(tmpDir, 'stdout-2026-05-13.log');
    const todayFile = path.join(tmpDir, 'stdout-2026-05-15.log');
    const otherFile = path.join(tmpDir, 'random.log');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(recentFile, 'recent');
    fs.writeFileSync(otherFile, 'unrelated');

    const now = new Date(2026, 4, 15, 10, 0, 0);
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      retentionDays: 7,
      scheduleRetention: false,
    });

    // Open today's file so the prune path also sees it as "current".
    process.stdout.write('today\n');
    handle.flush();
    const deleted = handle.pruneNow();

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
    expect(fs.existsSync(todayFile)).toBe(true);
    expect(fs.existsSync(otherFile)).toBe(true);
  });

  it('retention=0 disables pruning entirely', () => {
    const oldFile = path.join(tmpDir, 'stdout-2020-01-01.log');
    fs.writeFileSync(oldFile, 'ancient');

    const now = new Date(2026, 4, 15, 10, 0, 0);
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      retentionDays: 0,
      scheduleRetention: false,
    });
    const deleted = handle.pruneNow();
    expect(deleted).toBe(0);
    expect(fs.existsSync(oldFile)).toBe(true);
  });

  it('clock moving backward within the same day stays on the same file (no phantom future file)', () => {
    let now = new Date(2026, 4, 15, 23, 0, 0);
    handle = installDateRotatedStdio({
      logsDir: tmpDir,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    process.stdout.write('first\n');
    now = new Date(2026, 4, 15, 22, 0, 0);
    process.stdout.write('second\n');
    handle.flush();
    expect(fs.readFileSync(path.join(tmpDir, 'stdout-2026-05-15.log'), 'utf-8')).toBe('first\nsecond\n');
    const stdoutFiles = fs.readdirSync(tmpDir).filter((n) => n.startsWith('stdout-'));
    expect(stdoutFiles).toHaveLength(1);
  });

  it('creates logsDir if it does not already exist', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'logs');
    expect(fs.existsSync(nested)).toBe(false);
    const now = new Date(2026, 4, 15, 10, 0, 0);
    handle = installDateRotatedStdio({
      logsDir: nested,
      clock: () => now,
      passthrough: false,
      scheduleRetention: false,
    });
    process.stdout.write('mk\n');
    handle.flush();
    expect(fs.existsSync(path.join(nested, 'stdout-2026-05-15.log'))).toBe(true);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ledger } from './ledger.js';

// Pass-through `open` that records which paths got an fsync, and can tear the next write to one file:
// half of the bytes reach the file, then the write fails.
const faults = vi.hoisted(() => ({ synced: [] as string[], tearNextWriteTo: null as string | null, torn: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  type Write = (buffer: Uint8Array, offset: number, length: number) => Promise<{ bytesWritten: number }>;
  const open = async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args);
    const target = String(args[0]);
    const sync = handle.sync.bind(handle);
    const patch: Record<string, unknown> = {
      sync: async () => {
        faults.synced.push(target);
        await sync();
      },
    };
    if (faults.tearNextWriteTo === target) {
      faults.tearNextWriteTo = null;
      const write = handle.write.bind(handle) as unknown as Write;
      patch.write = async (buffer: Uint8Array, offset: number, length: number) => {
        await write(buffer, offset, Math.max(1, Math.floor(length / 2)));
        faults.torn += 1;
        throw Object.assign(new Error('EIO: injected torn write'), { code: 'EIO' });
      };
    }
    return Object.assign(handle, patch);
  };
  return { ...real, open };
});

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-ledger-'));
  file = path.join(dir, 'ledger.jsonl');
  faults.synced = [];
  faults.tearNextWriteTo = null;
  faults.torn = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rows(): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('Ledger', () => {
  it('appends one JSON line per row with an ISO timestamp first', async () => {
    const ledger = new Ledger(file);
    await ledger.append({ event: 'approval.posted', approvalId: 'abc12345' });
    await ledger.append({ event: 'gh.run', exitCode: 0, nested: { argv: ['pr', 'list'] } });
    const text = fs.readFileSync(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const parsed = rows();
    expect(parsed).toHaveLength(2);
    expect(Object.keys(parsed[0])[0]).toBe('ts');
    expect(parsed[0]).toMatchObject({ event: 'approval.posted', approvalId: 'abc12345' });
    expect(parsed[1]).toMatchObject({ event: 'gh.run', exitCode: 0, nested: { argv: ['pr', 'list'] } });
    for (const row of parsed) expect(row.ts).toMatch(ISO_UTC_RE);
  });

  it('creates the file 0600 (and a missing parent 0700)', async () => {
    const nested = path.join(dir, 'state', 'ledger.jsonl');
    await new Ledger(nested).append({ event: 'start' });
    expect(fs.statSync(nested).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(nested)).mode & 0o777).toBe(0o700);
  });

  it('tightens an existing file to 0600 and keeps earlier lines', async () => {
    fs.writeFileSync(file, '{"ts":"2026-01-01T00:00:00.000Z","event":"old"}\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    await new Ledger(file).append({ event: 'new' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(rows().map((row) => row.event)).toEqual(['old', 'new']);
  });

  it('does not interleave concurrent appends', async () => {
    const ledger = new Ledger(file);
    const bulk = 'x'.repeat(64 * 1024);
    await Promise.all(Array.from({ length: 50 }, (_, i) => ledger.append({ event: 'bulk', i, bulk })));
    const parsed = rows();
    expect(parsed).toHaveLength(50);
    expect(parsed.map((row) => row.i)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    for (const row of parsed) expect(row.bulk).toBe(bulk);
  }, 15_000);

  it('two Ledger objects on one file still produce whole lines', async () => {
    const a = new Ledger(file);
    const b = new Ledger(file);
    const bulk = 'y'.repeat(16 * 1024);
    await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).append({ event: 'bulk', i, bulk })));
    expect(rows()).toHaveLength(40);
  });

  it.each(['token', 'secret', 'value', 'Token'])('refuses a top-level %s key and writes nothing', async (key) => {
    await expect(new Ledger(file).append({ event: 'x', [key]: 'test-secret-0001' })).rejects.toThrow(key);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never puts the refused value in the error', async () => {
    const err = await new Ledger(file).append({ event: 'x', token: 'test-secret-0001' }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).not.toContain('test-secret-0001');
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing event', { approvalId: 'a' }],
    ['an empty event', { event: '' }],
    ['a numeric event', { event: 1 }],
    ['a caller-supplied ts', { event: 'x', ts: '2026-01-01T00:00:00.000Z' }],
    ['a function', { event: 'x', fn: () => 1 }],
    ['undefined', { event: 'x', missing: undefined }],
    ['NaN', { event: 'x', n: Number.NaN }],
    ['a bigint', { event: 'x', n: BigInt(1) }],
    ['a Date', { event: 'x', at: new Date(0) }],
  ])('refuses a row with %s', async (_name, row) => {
    await expect(new Ledger(file).append(row as { event: string })).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses a cyclic row', async () => {
    const row: Record<string, unknown> = { event: 'x' };
    row.self = row;
    await expect(new Ledger(file).append(row as { event: string })).rejects.toThrow();
  });

  it('keeps working after a refused row', async () => {
    const ledger = new Ledger(file);
    await expect(ledger.append({ event: 'x', secret: 's' })).rejects.toThrow();
    await ledger.append({ event: 'ok' });
    expect(rows().map((row) => row.event)).toEqual(['ok']);
  });
});

describe('Ledger: torn tails and creation', () => {
  /** Every line of the file; the last element is '' when the file ends with a newline. */
  function lines(): string[] {
    return fs.readFileSync(file, 'utf8').split('\n');
  }

  function parses(line: string): boolean {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }

  it('after a write that tore mid-line and failed, the next row starts on its own line', async () => {
    const ledger = new Ledger(file);
    await ledger.append({ event: 'first' });
    faults.tearNextWriteTo = file;
    await expect(ledger.append({ event: 'torn', detail: 'x'.repeat(200) })).rejects.toThrow('EIO');
    expect(faults.torn).toBe(1);
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(false);

    await ledger.append({ event: 'after' });
    const all = lines();
    expect(all).toHaveLength(4);
    expect(all[3]).toBe('');
    const [first, fragment, after] = all;
    expect(JSON.parse(first)).toMatchObject({ event: 'first' });
    // The fragment stays as evidence, on a line of its own.
    expect(fragment.startsWith('{"ts":')).toBe(true);
    expect(parses(fragment)).toBe(false);
    expect(JSON.parse(after)).toMatchObject({ event: 'after' });
  });

  it('another Ledger object on the same file also repairs the tail after a torn write', async () => {
    const a = new Ledger(file);
    await a.append({ event: 'first' });
    faults.tearNextWriteTo = file;
    await expect(a.append({ event: 'torn', detail: 'y'.repeat(200) })).rejects.toThrow('EIO');
    await new Ledger(file).append({ event: 'after' });
    const all = lines();
    expect(all.filter(parses).map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(['first', 'after']);
    expect(all).toHaveLength(4);
  });

  it('a torn tail from before a restart: the first append starts on a fresh line', async () => {
    const old = '{"ts":"2026-01-01T00:00:00.000Z","event":"old"}\n';
    const tail = '{"ts":"2026-01-01T00:00:01.000Z","ev';
    fs.writeFileSync(file, `${old}${tail}`, { mode: 0o600 });
    await new Ledger(file).append({ event: 'new' });
    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith(`${old}${tail}\n{"ts":`)).toBe(true);
    const all = lines();
    expect(all).toHaveLength(4);
    expect(parses(all[0])).toBe(true);
    expect(parses(all[1])).toBe(false);
    expect(JSON.parse(all[2])).toMatchObject({ event: 'new' });
  });

  it('a clean file gets no extra newline on first use', async () => {
    const old = '{"ts":"2026-01-01T00:00:00.000Z","event":"old"}\n';
    fs.writeFileSync(file, old, { mode: 0o600 });
    await new Ledger(file).append({ event: 'new' });
    const all = lines();
    expect(all).toHaveLength(3);
    expect(all.slice(0, 2).every(parses)).toBe(true);
  });

  it('syncs the parent directory when it creates the file, and only then', async () => {
    const ledger = new Ledger(file);
    await ledger.append({ event: 'one' });
    expect(faults.synced).toContain(dir);
    expect(faults.synced).toContain(file);
    faults.synced = [];
    await ledger.append({ event: 'two' });
    expect(faults.synced).toEqual([file]);
  });

  it('syncs a nested parent it created', async () => {
    const nested = path.join(dir, 'state', 'ledger.jsonl');
    await new Ledger(nested).append({ event: 'one' });
    expect(faults.synced).toContain(path.dirname(nested));
  });
});

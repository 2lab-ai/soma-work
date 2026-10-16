import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DATA_DIR is read lazily by work-log.ts, so a getter lets each test point the
// store at its own temp directory.
const paths = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  get DATA_DIR() {
    return paths.dataDir;
  },
}));

type WorkLogModule = typeof import('../work-log');

async function loadFresh(): Promise<WorkLogModule> {
  // A fresh module instance = a process restart: in-memory seq counters are gone,
  // only the files on disk remain.
  vi.resetModules();
  return import('../work-log');
}

function logFile(conversationId: string): string {
  return path.join(paths.dataDir, 'worklogs', `${conversationId}.jsonl`);
}

describe('work log store', () => {
  let wl: WorkLogModule;

  beforeEach(async () => {
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-worklog-'));
    wl = await loadFresh();
  });

  afterEach(async () => {
    await wl.flushWorkLog();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  it('assigns a monotonic seq per conversation and defaults ts to now', async () => {
    const before = Date.now();
    const a1 = wl.appendWorkLog('conv-a', { kind: 'instruction', text: 'do the thing' });
    const a2 = wl.appendWorkLog('conv-a', { kind: 'narration', text: 'looking at files' });
    const b1 = wl.appendWorkLog('conv-b', { kind: 'tool', text: 'Read src/x.ts', tool: 'Read' });
    const after = Date.now();

    expect([a1.seq, a2.seq, b1.seq]).toEqual([1, 2, 1]);
    expect(a1.ts).toBeGreaterThanOrEqual(before);
    expect(a1.ts).toBeLessThanOrEqual(after);
    expect(b1).toMatchObject({ kind: 'tool', text: 'Read src/x.ts', tool: 'Read' });

    const explicit = wl.appendWorkLog('conv-a', { kind: 'final', text: 'done', ts: 1234 });
    expect(explicit).toMatchObject({ seq: 3, ts: 1234 });
  });

  it('persists append-only JSONL under DATA_DIR/worklogs and reads it back in order', async () => {
    wl.appendWorkLog('conv-a', { kind: 'instruction', text: 'one', turnId: 't1' });
    wl.appendWorkLog('conv-a', { kind: 'tool_result', text: 'Bash', tool: 'Bash', ok: false });
    const entries = await wl.readWorkLog('conv-a');

    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(entries[0]).toMatchObject({ kind: 'instruction', text: 'one', turnId: 't1' });
    expect(entries[1]).toMatchObject({ kind: 'tool_result', tool: 'Bash', ok: false });

    const lines = fs.readFileSync(logFile('conv-a'), 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).seq).toBe(2);
  });

  it('serializes concurrent appends so every line stays whole and ordered', async () => {
    for (let i = 0; i < 50; i++) wl.appendWorkLog('conv-c', { kind: 'narration', text: `step ${i}` });
    const entries = await wl.readWorkLog('conv-c');
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(entries[49].text).toBe('step 49');
  });

  it('readWorkLog filters by afterSeq and returns only the last `limit` entries', async () => {
    for (let i = 1; i <= 10; i++) wl.appendWorkLog('conv-d', { kind: 'narration', text: `n${i}` });

    expect((await wl.readWorkLog('conv-d', { afterSeq: 7 })).map((e) => e.seq)).toEqual([8, 9, 10]);
    expect((await wl.readWorkLog('conv-d', { limit: 3 })).map((e) => e.seq)).toEqual([8, 9, 10]);
    expect((await wl.readWorkLog('conv-d', { afterSeq: 2, limit: 2 })).map((e) => e.seq)).toEqual([9, 10]);
    expect(await wl.readWorkLog('conv-d', { afterSeq: 10 })).toEqual([]);
    expect(await wl.readWorkLog('conv-missing')).toEqual([]);
  });

  it('defaults to the last 500 entries', async () => {
    for (let i = 0; i < 520; i++) wl.appendWorkLog('conv-e', { kind: 'narration', text: 'x' });
    const entries = await wl.readWorkLog('conv-e');
    expect(entries).toHaveLength(500);
    expect(entries[0].seq).toBe(21);
    expect(entries[499].seq).toBe(520);
  });

  it('truncates text to 4000 characters', async () => {
    const long = wl.appendWorkLog('conv-f', { kind: 'narration', text: 'a'.repeat(5000) });
    const short = wl.appendWorkLog('conv-f', { kind: 'narration', text: 'b'.repeat(4000) });
    expect(long.text.length).toBe(4000);
    expect(long.text.startsWith('aaaa')).toBe(true);
    expect(short.text).toBe('b'.repeat(4000));
    const [stored] = await wl.readWorkLog('conv-f', { limit: 2 });
    expect(stored.text.length).toBe(4000);
  });

  it('does not split a surrogate pair at the truncation boundary', () => {
    // 3998 ASCII chars put the emoji's high surrogate at index 3998, right where
    // the cut lands.
    const text = `${'a'.repeat(3998)}😀😀`;
    const entry = wl.appendWorkLog('conv-g', { kind: 'narration', text });
    expect(entry.text.length).toBeLessThanOrEqual(4000);
    const last = entry.text.charCodeAt(entry.text.length - 2);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('stores only contract fields', async () => {
    wl.appendWorkLog('conv-h', { kind: 'notice', text: 'compacting', extra: 'nope' } as never);
    const [entry] = await wl.readWorkLog('conv-h');
    expect(Object.keys(entry).sort()).toEqual(['kind', 'seq', 'text', 'ts']);
  });

  it('rejects conversation ids that are not a safe filename', async () => {
    for (const bad of ['../escape', 'a/b', '..', '', 'a\\b', 'x'.repeat(200), 'conv.jsonl']) {
      expect(() => wl.appendWorkLog(bad, { kind: 'narration', text: 'x' })).toThrow();
      expect(await wl.readWorkLog(bad)).toEqual([]);
    }
    expect(fs.existsSync(path.join(paths.dataDir, 'escape.jsonl'))).toBe(false);
    expect(() =>
      wl.appendWorkLog('1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', { kind: 'narration', text: 'ok' }),
    ).not.toThrow();
  });

  it('continues the seq from the existing file after a restart', async () => {
    wl.appendWorkLog('conv-r', { kind: 'instruction', text: 'first' });
    wl.appendWorkLog('conv-r', { kind: 'narration', text: 'second' });
    wl.appendWorkLog('conv-r', { kind: 'final', text: 'third' });
    await wl.readWorkLog('conv-r'); // drain pending writes

    const restarted = await loadFresh();
    const next = restarted.appendWorkLog('conv-r', { kind: 'instruction', text: 'after restart' });
    expect(next.seq).toBe(4);
    expect((await restarted.readWorkLog('conv-r')).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('after a torn final line, the next entry lands on its own line with a higher seq', async () => {
    fs.mkdirSync(path.dirname(logFile('conv-t')), { recursive: true });
    fs.writeFileSync(
      logFile('conv-t'),
      `${JSON.stringify({ seq: 1, ts: 1, kind: 'narration', text: 'ok' })}\n{"seq":2,"ts":2,"ki`,
    );

    const restarted = await loadFresh();
    const next = restarted.appendWorkLog('conv-t', { kind: 'narration', text: 'recovered' });
    expect(next.seq).toBeGreaterThan(2);
    const entries = await restarted.readWorkLog('conv-t');
    expect(entries.map((e) => e.text)).toEqual(['ok', 'recovered']);
  });

  it('notifies the registered callback on every append, and a throwing callback does not break the append', async () => {
    const seen: Array<[string, number]> = [];
    wl.setOnWorkLogAppendedCallback((conversationId, entry) => {
      seen.push([conversationId, entry.seq]);
      throw new Error('listener blew up');
    });
    const entry = wl.appendWorkLog('conv-l', { kind: 'error', text: 'boom' });
    expect(entry.seq).toBe(1);
    expect(seen).toEqual([['conv-l', 1]]);
    expect(await wl.readWorkLog('conv-l')).toHaveLength(1);
  });
});

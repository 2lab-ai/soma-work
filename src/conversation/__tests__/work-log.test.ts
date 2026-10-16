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

function writeRaw(conversationId: string, content: string): void {
  fs.mkdirSync(path.dirname(logFile(conversationId)), { recursive: true });
  fs.writeFileSync(logFile(conversationId), content);
}

function line(seq: number, text = `n${seq}`): string {
  return `${JSON.stringify({ seq, ts: seq, kind: 'narration', text })}\n`;
}

const seqs = (page: { entries: Array<{ seq: number }> }) => page.entries.map((e) => e.seq);

// Captured before any test spies on it, so a wrapper never calls itself.
const realOpen = fs.promises.open.bind(fs.promises);

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('work log store', () => {
  let wl: WorkLogModule;

  beforeEach(async () => {
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-worklog-'));
    wl = await loadFresh();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await wl.flushWorkLog();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  it('assigns a monotonic seq per conversation and defaults ts to the call time', async () => {
    const before = Date.now();
    const pending = [
      wl.appendWorkLog('conv-a', { kind: 'instruction', text: 'do the thing' }),
      wl.appendWorkLog('conv-a', { kind: 'narration', text: 'looking at files' }),
      wl.appendWorkLog('conv-b', { kind: 'tool', text: 'Read src/x.ts', tool: 'Read' }),
    ];
    const after = Date.now();
    const [a1, a2, b1] = await Promise.all(pending);

    expect([a1.seq, a2.seq, b1.seq]).toEqual([1, 2, 1]);
    expect(a1.ts).toBeGreaterThanOrEqual(before);
    expect(a1.ts).toBeLessThanOrEqual(after);
    expect(b1).toMatchObject({ kind: 'tool', text: 'Read src/x.ts', tool: 'Read' });

    const explicit = await wl.appendWorkLog('conv-a', { kind: 'final', text: 'done', ts: 1234 });
    expect(explicit).toMatchObject({ seq: 3, ts: 1234 });
  });

  it('persists append-only JSONL under DATA_DIR/worklogs and reads it back in order', async () => {
    await wl.appendWorkLog('conv-a', { kind: 'instruction', text: 'one', turnId: 't1' });
    await wl.appendWorkLog('conv-a', { kind: 'tool_result', text: 'Bash', tool: 'Bash', ok: false });
    const page = await wl.readWorkLog('conv-a');

    expect(page).toMatchObject({ hasMore: false });
    expect(seqs(page)).toEqual([1, 2]);
    expect(page.entries[0]).toMatchObject({ kind: 'instruction', text: 'one', turnId: 't1' });
    expect(page.entries[1]).toMatchObject({ kind: 'tool_result', tool: 'Bash', ok: false });

    const lines = fs.readFileSync(logFile('conv-a'), 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).seq).toBe(2);
  });

  it('serializes concurrent appends so every line stays whole and ordered', async () => {
    const all = Array.from({ length: 50 }, (_, i) =>
      wl.appendWorkLog('conv-c', { kind: 'narration', text: `step ${i}` }),
    );
    expect((await Promise.all(all)).map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const page = await wl.readWorkLog('conv-c');
    expect(seqs(page)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(page.entries[49].text).toBe('step 49');
  });

  it('without afterSeq returns the latest `limit` entries; hasMore = older entries exist', async () => {
    for (let i = 1; i <= 10; i++) await wl.appendWorkLog('conv-d', { kind: 'narration', text: `n${i}` });

    expect(await wl.readWorkLog('conv-d', { limit: 3 })).toMatchObject({ hasMore: true });
    expect(seqs(await wl.readWorkLog('conv-d', { limit: 3 }))).toEqual([8, 9, 10]);
    expect(await wl.readWorkLog('conv-d', { limit: 10 })).toMatchObject({ hasMore: false });
    expect(await wl.readWorkLog('conv-missing')).toEqual({ entries: [], hasMore: false });
  });

  it('with afterSeq returns the FIRST `limit` entries after it; hasMore = newer entries exist', async () => {
    for (let i = 1; i <= 10; i++) await wl.appendWorkLog('conv-p', { kind: 'narration', text: `n${i}` });

    const page1 = await wl.readWorkLog('conv-p', { afterSeq: 2, limit: 3 });
    expect(seqs(page1)).toEqual([3, 4, 5]);
    expect(page1.hasMore).toBe(true);
    const page2 = await wl.readWorkLog('conv-p', { afterSeq: 5, limit: 3 });
    expect(seqs(page2)).toEqual([6, 7, 8]);
    const last = await wl.readWorkLog('conv-p', { afterSeq: 8, limit: 3 });
    expect(seqs(last)).toEqual([9, 10]);
    expect(last.hasMore).toBe(false);
    expect(await wl.readWorkLog('conv-p', { afterSeq: 7 })).toMatchObject({ hasMore: false });
    expect(seqs(await wl.readWorkLog('conv-p', { afterSeq: 0, limit: 2 }))).toEqual([1, 2]);
    expect(await wl.readWorkLog('conv-p', { afterSeq: 10 })).toEqual({ entries: [], hasMore: false });
  });

  it('defaults to the latest 500 entries', async () => {
    writeRaw('conv-e', Array.from({ length: 520 }, (_, i) => line(i + 1)).join(''));
    const page = await wl.readWorkLog('conv-e');
    expect(page.entries).toHaveLength(500);
    expect(page.entries[0].seq).toBe(21);
    expect(page.entries[499].seq).toBe(520);
    expect(page.hasMore).toBe(true);
  });

  describe('large history (bounded reads)', () => {
    const N = 20_000;
    let fileSize = 0;
    let bytesRead = 0;

    beforeEach(() => {
      // ~6 MB: 20k entries with ~250 chars of text each.
      const filler = 'x'.repeat(240);
      writeRaw('conv-big', Array.from({ length: N }, (_, i) => line(i + 1, `${filler} #${i + 1}`)).join(''));
      fileSize = fs.statSync(logFile('conv-big')).size;

      bytesRead = 0;
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const fh = await realOpen(...args);
        const realRead = fh.read.bind(fh) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
        (fh as { read: unknown }).read = async (...a: unknown[]) => {
          const r = await realRead(...a);
          bytesRead += r.bytesRead;
          return r;
        };
        return fh;
      });
      vi.spyOn(fs.promises, 'readFile');
    });

    afterEach(() => {
      expect(fs.promises.readFile).not.toHaveBeenCalled();
    });

    it('is several MB, and the store has no whole-file read path', () => {
      expect(fileSize).toBeGreaterThan(5 * 1024 * 1024);
      // ESM namespace exports cannot be spied on, so pin the sync API structurally.
      const source = fs.readFileSync(path.join(__dirname, '..', 'work-log.ts'), 'utf-8');
      expect(source).not.toMatch(/readFileSync|readFile\(|createReadStream/);
    });

    it('latest-window read touches only the tail', async () => {
      const page = await wl.readWorkLog('conv-big', { limit: 500 });
      expect(page.entries[0].seq).toBe(N - 499);
      expect(page.entries[499].seq).toBe(N);
      expect(page.entries[499].text.endsWith(`#${N}`)).toBe(true);
      expect(page.hasMore).toBe(true);
      expect(bytesRead).toBeLessThan(fileSize / 20);
    });

    it('afterSeq near the tail (reconnect) touches only the tail', async () => {
      const page = await wl.readWorkLog('conv-big', { afterSeq: N - 3, limit: 500 });
      expect(seqs(page)).toEqual([N - 2, N - 1, N]);
      expect(page.hasMore).toBe(false);
      expect(bytesRead).toBeLessThan(fileSize / 20);
    });

    it('afterSeq deep in the history pages forward from the right place', async () => {
      for (const afterSeq of [0, 1, 777, 9_999, 15_000, N - 600]) {
        bytesRead = 0;
        const page = await wl.readWorkLog('conv-big', { afterSeq, limit: 5 });
        expect(seqs(page)).toEqual([1, 2, 3, 4, 5].map((k) => afterSeq + k));
        expect(page.entries[0].text.endsWith(`#${afterSeq + 1}`)).toBe(true);
        expect(page.hasMore).toBe(true);
        expect(bytesRead).toBeLessThan(fileSize / 8);
      }
    });

    it('seeds the next seq from the tail without reading the whole file', async () => {
      const next = await wl.appendWorkLog('conv-big', { kind: 'notice', text: 'after restart' });
      expect(next.seq).toBe(N + 1);
      expect(bytesRead).toBeLessThan(256 * 1024);
    });
  });

  it('truncates text to 4000 characters', async () => {
    const long = await wl.appendWorkLog('conv-f', { kind: 'narration', text: 'a'.repeat(5000) });
    const short = await wl.appendWorkLog('conv-f', { kind: 'narration', text: 'b'.repeat(4000) });
    expect(long.text.length).toBe(4000);
    expect(long.text.startsWith('aaaa')).toBe(true);
    expect(short.text).toBe('b'.repeat(4000));
    const page = await wl.readWorkLog('conv-f', { limit: 2 });
    expect(page.entries[0].text.length).toBe(4000);
  });

  it('does not split a surrogate pair at the truncation boundary', async () => {
    // 3998 ASCII chars put the emoji's high surrogate at index 3998, right where
    // the cut lands.
    const text = `${'a'.repeat(3998)}😀😀`;
    const entry = await wl.appendWorkLog('conv-g', { kind: 'narration', text });
    expect(entry.text.length).toBeLessThanOrEqual(4000);
    const last = entry.text.charCodeAt(entry.text.length - 2);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('stores only contract fields', async () => {
    await wl.appendWorkLog('conv-h', { kind: 'notice', text: 'compacting', extra: 'nope' } as never);
    const [entry] = (await wl.readWorkLog('conv-h')).entries;
    expect(Object.keys(entry).sort()).toEqual(['kind', 'seq', 'text', 'ts']);
  });

  it('rejects conversation ids that are not a safe filename', async () => {
    for (const bad of ['../escape', 'a/b', '..', '', 'a\\b', 'x'.repeat(200), 'conv.jsonl']) {
      await expect(wl.appendWorkLog(bad, { kind: 'narration', text: 'x' })).rejects.toThrow();
      expect(await wl.readWorkLog(bad)).toEqual({ entries: [], hasMore: false });
    }
    expect(fs.existsSync(path.join(paths.dataDir, 'escape.jsonl'))).toBe(false);
    await expect(
      wl.appendWorkLog('1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', { kind: 'narration', text: 'ok' }),
    ).resolves.toMatchObject({ seq: 1 });
  });

  it('continues the seq from the existing file after a restart', async () => {
    await wl.appendWorkLog('conv-r', { kind: 'instruction', text: 'first' });
    await wl.appendWorkLog('conv-r', { kind: 'narration', text: 'second' });
    await wl.appendWorkLog('conv-r', { kind: 'final', text: 'third' });

    const restarted = await loadFresh();
    const next = await restarted.appendWorkLog('conv-r', { kind: 'instruction', text: 'after restart' });
    expect(next.seq).toBe(4);
    expect(seqs(await restarted.readWorkLog('conv-r'))).toEqual([1, 2, 3, 4]);
  });

  it('counts a complete last entry that lost its newline, and starts the next one on a fresh line', async () => {
    writeRaw('conv-nl', `${line(1)}${line(2).trimEnd()}`);
    const next = await wl.appendWorkLog('conv-nl', { kind: 'narration', text: 'three' });
    expect(next.seq).toBe(3);
    expect(seqs(await wl.readWorkLog('conv-nl'))).toEqual([1, 2, 3]);
  });

  it('after a torn final line, the next entry lands on its own line', async () => {
    writeRaw('conv-t', `${line(1, 'ok')}{"seq":2,"ts":2,"ki`);

    const next = await wl.appendWorkLog('conv-t', { kind: 'narration', text: 'recovered' });
    // seq 2 never reached a reader (torn write, never broadcast), so reusing it is safe.
    expect(next.seq).toBe(2);
    const page = await wl.readWorkLog('conv-t');
    expect(page.entries.map((e) => e.text)).toEqual(['ok', 'recovered']);
  });

  describe('failure handling', () => {
    it('a non-ENOENT seed error drops the append, caches nothing, and the next append seeds correctly', async () => {
      writeRaw('conv-s', `${line(1)}${line(2)}${line(3)}`);
      const seen: number[] = [];
      wl.setOnWorkLogAppendedCallback((_id, entry) => seen.push(entry.seq));
      vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(ioError('EIO'));

      await expect(wl.appendWorkLog('conv-s', { kind: 'narration', text: 'lost' })).rejects.toThrow('EIO');
      expect(fs.readFileSync(logFile('conv-s'), 'utf-8')).toBe(`${line(1)}${line(2)}${line(3)}`);
      expect(seen).toEqual([]);

      const next = await wl.appendWorkLog('conv-s', { kind: 'narration', text: 'kept' });
      expect(next.seq).toBe(4);
      expect(seen).toEqual([4]);
      expect(seqs(await wl.readWorkLog('conv-s'))).toEqual([1, 2, 3, 4]);
    });

    it('a failed write on a torn file keeps the newline repair for the next append', async () => {
      writeRaw('conv-w', `${line(1, 'ok')}{"seq":2,"ts":2,"ki`);
      vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(ioError('ENOSPC'));

      await expect(wl.appendWorkLog('conv-w', { kind: 'narration', text: 'lost' })).rejects.toThrow('ENOSPC');
      const next = await wl.appendWorkLog('conv-w', { kind: 'narration', text: 'recovered' });

      const raw = fs.readFileSync(logFile('conv-w'), 'utf-8');
      expect(raw).toContain(`"ki\n${JSON.stringify(next)}\n`);
      expect(raw.endsWith('\n')).toBe(true);
      expect((await wl.readWorkLog('conv-w')).entries.map((e) => e.text)).toEqual(['ok', 'recovered']);
    });

    it('a write that fails after landing part of its line is repaired the same way', async () => {
      await wl.appendWorkLog('conv-x', { kind: 'narration', text: 'first' });
      const realAppend = fs.promises.appendFile.bind(fs.promises);
      vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async (file, data) => {
        await realAppend(file, String(data).slice(0, 12), 'utf-8');
        throw ioError('EIO');
      });

      await expect(wl.appendWorkLog('conv-x', { kind: 'narration', text: 'torn' })).rejects.toThrow('EIO');
      const next = await wl.appendWorkLog('conv-x', { kind: 'narration', text: 'second' });
      expect(next.seq).toBe(2);
      expect((await wl.readWorkLog('conv-x')).entries.map((e) => e.text)).toEqual(['first', 'second']);
    });

    it('a write failure does not block later appends to the same conversation', async () => {
      vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(ioError('EIO'));
      const results = await Promise.allSettled([
        wl.appendWorkLog('conv-q', { kind: 'narration', text: 'a' }),
        wl.appendWorkLog('conv-q', { kind: 'narration', text: 'b' }),
        wl.appendWorkLog('conv-q', { kind: 'narration', text: 'c' }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
      expect(seqs(await wl.readWorkLog('conv-q'))).toEqual([1, 2]);
    });
  });

  it('notifies the registered callback after each persisted append; a throwing callback does not fail it', async () => {
    const seen: Array<[string, number, boolean]> = [];
    wl.setOnWorkLogAppendedCallback((conversationId, entry) => {
      seen.push([conversationId, entry.seq, fs.existsSync(logFile(conversationId))]);
      throw new Error('listener blew up');
    });
    const entry = await wl.appendWorkLog('conv-l', { kind: 'error', text: 'boom' });
    expect(entry.seq).toBe(1);
    expect(seen).toEqual([['conv-l', 1, true]]);
    expect((await wl.readWorkLog('conv-l')).entries).toHaveLength(1);
  });

  it('keeps the writer-state cache bounded and re-seeds evicted conversations from disk', async () => {
    for (let i = 0; i < 300; i++) await wl.appendWorkLog(`conv-lru-${i}`, { kind: 'narration', text: 'x' });
    const openSpy = vi.spyOn(fs.promises, 'open');

    // conv-lru-0 was evicted: appending reads its tail again and still continues at 2.
    expect((await wl.appendWorkLog('conv-lru-0', { kind: 'narration', text: 'y' })).seq).toBe(2);
    expect(openSpy).toHaveBeenCalledTimes(1);
    // conv-lru-299 is still warm: no tail read.
    openSpy.mockClear();
    expect((await wl.appendWorkLog('conv-lru-299', { kind: 'narration', text: 'y' })).seq).toBe(2);
    expect(openSpy).not.toHaveBeenCalled();
  });
});

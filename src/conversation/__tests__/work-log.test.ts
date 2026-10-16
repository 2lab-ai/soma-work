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
type FileHandle = fs.promises.FileHandle;

async function loadFresh(): Promise<WorkLogModule> {
  // A fresh module instance = a process restart: in-memory seq counters are gone,
  // only the files on disk remain.
  vi.resetModules();
  return import('../work-log');
}

function logFile(conversationId: string): string {
  return path.join(paths.dataDir, 'worklogs', `${conversationId}.jsonl`);
}

function sidecarFile(conversationId: string): string {
  return path.join(paths.dataDir, 'worklogs', `${conversationId}.seq`);
}

function writeRaw(conversationId: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(logFile(conversationId)), { recursive: true });
  fs.writeFileSync(logFile(conversationId), content);
}

function appendRaw(conversationId: string, content: string | Buffer): void {
  fs.appendFileSync(logFile(conversationId), content);
}

function line(seq: number, text = `n${seq}`): string {
  return `${JSON.stringify({ seq, ts: seq, kind: 'narration', text })}\n`;
}

const seqs = (page: { entries: Array<{ seq: number }> }) => page.entries.map((e) => e.seq);

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

// Captured before any test spies on it, so a wrapper never calls itself.
const realOpen = fs.promises.open.bind(fs.promises);
type OpenArgs = Parameters<typeof fs.promises.open>;

/** Wrap every opened handle; `wrap` may replace methods on it. */
function spyOpen(wrap: (fh: FileHandle, args: OpenArgs) => void) {
  return vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: OpenArgs) => {
    const fh = await realOpen(...args);
    wrap(fh, args);
    return fh;
  });
}

/** Count bytes read through opened handles (all reads in work-log.ts go through these). */
function countReads(): { bytes: number } {
  const counter = { bytes: 0 };
  spyOpen((fh) => {
    const realRead = fh.read.bind(fh) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
    (fh as { read: unknown }).read = async (...a: unknown[]) => {
      const r = await realRead(...a);
      counter.bytes += r.bytesRead;
      return r;
    };
  });
  return counter;
}

/** Make the next append-mode open fail in the given way. */
function failNextAppend(how: 'nothing-written' | 'partial-write' | 'datasync'): void {
  let armed = true;
  spyOpen((fh, args) => {
    if (!armed || args[1] !== 'a') return;
    armed = false;
    const realWrite = fh.writeFile.bind(fh);
    if (how === 'nothing-written') {
      (fh as { writeFile: unknown }).writeFile = async () => {
        throw ioError('ENOSPC');
      };
    } else if (how === 'partial-write') {
      (fh as { writeFile: unknown }).writeFile = async (data: string) => {
        await realWrite(String(data).slice(0, 12), 'utf-8');
        throw ioError('EIO');
      };
    } else {
      (fh as { datasync: unknown }).datasync = async () => {
        throw ioError('EIO');
      };
    }
  });
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

  describe('durability before publish', () => {
    it('fdatasyncs the line (and fsyncs the directory for a new file) before resolving or broadcasting', async () => {
      const events: string[] = [];
      spyOpen((fh, args) => {
        const file = String(args[0]);
        const tag = file.endsWith('.jsonl') ? 'log' : file === path.join(paths.dataDir, 'worklogs') ? 'dir' : 'other';
        if (tag === 'other') return;
        for (const method of ['writeFile', 'datasync', 'sync'] as const) {
          const real = (fh[method] as (...a: unknown[]) => Promise<unknown>).bind(fh);
          (fh as unknown as Record<string, unknown>)[method] = async (...a: unknown[]) => {
            const r = await real(...a);
            events.push(`${tag}.${method}`);
            return r;
          };
        }
      });
      wl.setOnWorkLogAppendedCallback(() => events.push('publish'));

      const first = await wl.appendWorkLog('conv-dur', { kind: 'narration', text: 'one' });
      events.push('resolved');
      expect(first.seq).toBe(1);
      // The sidecar reservation also fsyncs the directory, before the log write.
      expect(events.slice(events.indexOf('log.writeFile'))).toEqual([
        'log.writeFile',
        'log.datasync',
        'dir.sync',
        'publish',
        'resolved',
      ]);

      events.length = 0;
      await wl.appendWorkLog('conv-dur', { kind: 'narration', text: 'two' });
      events.push('resolved');
      // The file exists and the reservation still covers seq 2: one fdatasync only.
      expect(events).toEqual(['log.writeFile', 'log.datasync', 'publish', 'resolved']);
    });

    it('a failed fdatasync rejects the append and publishes nothing', async () => {
      const seen: number[] = [];
      wl.setOnWorkLogAppendedCallback((_id, entry) => seen.push(entry.seq));
      await wl.appendWorkLog('conv-ds', { kind: 'narration', text: 'one' });
      failNextAppend('datasync');

      await expect(wl.appendWorkLog('conv-ds', { kind: 'narration', text: 'two' })).rejects.toThrow('EIO');
      expect(seen).toEqual([1]);
      // The bytes did land, so the re-seed reads them back and moves past seq 2.
      const next = await wl.appendWorkLog('conv-ds', { kind: 'narration', text: 'three' });
      expect(next.seq).toBe(3);
      expect(seen).toEqual([1, 3]);
      // A landed-but-unpublished entry still reads back normally (clients backfill the gap).
      expect(seqs(await wl.readWorkLog('conv-ds'))).toEqual([1, 2, 3]);
    });

    it('reserves seqs durably in the sidecar before using them', async () => {
      const first = await wl.appendWorkLog('conv-res', { kind: 'narration', text: 'one' });
      const reserved = JSON.parse(fs.readFileSync(sidecarFile('conv-res'), 'utf-8')).reservedSeq;
      expect(reserved).toBe(first.seq + wl.WORK_LOG_SEQ_RESERVE_BLOCK - 1);
    });
  });

  describe('large history (bounded reads)', () => {
    const N = 20_000;
    let fileSize = 0;
    let counter: { bytes: number };

    beforeEach(() => {
      // ~6 MB: 20k entries with ~250 chars of text each.
      const filler = 'x'.repeat(240);
      writeRaw('conv-big', Array.from({ length: N }, (_, i) => line(i + 1, `${filler} #${i + 1}`)).join(''));
      fileSize = fs.statSync(logFile('conv-big')).size;
      counter = countReads();
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
      expect(counter.bytes).toBeLessThan(fileSize / 20);
    });

    it('afterSeq near the tail (reconnect) touches only the tail', async () => {
      const page = await wl.readWorkLog('conv-big', { afterSeq: N - 3, limit: 500 });
      expect(seqs(page)).toEqual([N - 2, N - 1, N]);
      expect(page.hasMore).toBe(false);
      expect(counter.bytes).toBeLessThan(fileSize / 20);
    });

    it('afterSeq deep in the history pages forward from the right place', async () => {
      for (const afterSeq of [0, 1, 777, 9_999, 15_000, N - 600]) {
        counter.bytes = 0;
        const page = await wl.readWorkLog('conv-big', { afterSeq, limit: 5 });
        expect(seqs(page)).toEqual([1, 2, 3, 4, 5].map((k) => afterSeq + k));
        expect(page.entries[0].text.endsWith(`#${afterSeq + 1}`)).toBe(true);
        expect(page.hasMore).toBe(true);
        // Fast path (2 MB) + binary search + a short forward read: well under the file.
        expect(counter.bytes).toBeLessThan(fileSize / 2);
      }
    });

    it('seeds the next seq from the tail without reading the whole file', async () => {
      const next = await wl.appendWorkLog('conv-big', { kind: 'notice', text: 'after restart' });
      expect(next.seq).toBe(N + 1);
      expect(counter.bytes).toBeLessThan(256 * 1024);
    });
  });

  describe('scan budget (bounded work on a junk tail)', () => {
    // 9 MB of junk: more than the 8 MB budget.
    const JUNK_BYTES = 9 * 1024 * 1024;
    const junkLines = () => Buffer.from('x\n'.repeat(JUNK_BYTES / 2));
    const blankLines = () => Buffer.alloc(JUNK_BYTES, 0x0a);

    for (const [name, junk] of [
      ['short malformed lines', junkLines],
      ['blank lines', blankLines],
    ] as const) {
      describe(`suffix of ${name}`, () => {
        let counter: { bytes: number };

        beforeEach(() => {
          writeRaw('conv-junk', Array.from({ length: 1000 }, (_, i) => line(i + 1)).join(''));
          appendRaw('conv-junk', junk());
          counter = countReads();
        });

        it('a latest-window read stops at the budget with hasMore', async () => {
          const page = await wl.readWorkLog('conv-junk', { limit: 10 });
          expect(page).toEqual({ entries: [], hasMore: true });
          expect(counter.bytes).toBeLessThanOrEqual(wl.WORK_LOG_SCAN_BUDGET_BYTES);
        });

        it('an afterSeq read stays within the budget and returns what it found', async () => {
          const page = await wl.readWorkLog('conv-junk', { afterSeq: 995, limit: 10 });
          expect(seqs(page)).toEqual([996, 997, 998, 999, 1000]);
          expect(page.hasMore).toBe(true);
          expect(counter.bytes).toBeLessThanOrEqual(wl.WORK_LOG_SCAN_BUDGET_BYTES);
        });

        it('a seed stops at the budget, quarantines the log, and continues above the reservation', async () => {
          // The reservation the module would have written for entries 1..1000.
          fs.writeFileSync(sidecarFile('conv-junk'), JSON.stringify({ reservedSeq: 1999 }));
          const next = await wl.appendWorkLog('conv-junk', { kind: 'notice', text: 'fresh' });

          expect(next.seq).toBe(2000);
          expect(counter.bytes).toBeLessThanOrEqual(wl.WORK_LOG_SCAN_BUDGET_BYTES + 1);
          const dir = fs.readdirSync(path.dirname(logFile('conv-junk')));
          expect(dir.filter((f) => f.startsWith('conv-junk.jsonl.corrupt-'))).toHaveLength(1);
          expect(seqs(await wl.readWorkLog('conv-junk'))).toEqual([2000]);
          expect(JSON.parse(fs.readFileSync(sidecarFile('conv-junk'), 'utf-8')).reservedSeq).toBeGreaterThanOrEqual(
            2000,
          );
        });
      });
    }

    it('without a sidecar the quarantine resumes above every seq the file could hold', async () => {
      writeRaw('conv-legacy', Array.from({ length: 50 }, (_, i) => line(i + 1)).join(''));
      appendRaw('conv-legacy', Buffer.alloc(JUNK_BYTES, 0x0a));
      const size = fs.statSync(logFile('conv-legacy')).size;

      const next = await wl.appendWorkLog('conv-legacy', { kind: 'notice', text: 'fresh' });
      expect(next.seq).toBe(Math.ceil(size / 32) + 1);
      expect(next.seq).toBeGreaterThan(50);
    });

    it('quarantine never goes backwards across restarts', async () => {
      for (let i = 0; i < 3; i++) await wl.appendWorkLog('conv-q2', { kind: 'narration', text: `n${i}` });
      appendRaw('conv-q2', Buffer.alloc(JUNK_BYTES, 0x0a));
      const restarted = await loadFresh();
      const afterQuarantine = await restarted.appendWorkLog('conv-q2', { kind: 'notice', text: 'fresh' });
      expect(afterQuarantine.seq).toBeGreaterThan(3);

      const again = await loadFresh();
      const later = await again.appendWorkLog('conv-q2', { kind: 'notice', text: 'later' });
      expect(later.seq).toBe(afterQuarantine.seq + 1);
      await again.flushWorkLog();
    });
  });

  describe('1 MB line contract', () => {
    const LIMIT = 1024 * 1024;

    /** A parseable entry line of exactly `bytes` bytes (without `\n`), with multibyte text. */
    function entryOfBytes(seq: number, bytes: number): string {
      const base = Buffer.byteLength(JSON.stringify({ seq, ts: seq, kind: 'narration', text: '' }));
      const room = bytes - base;
      const wide = Math.floor(room / 3) - 1;
      const text = '한'.repeat(wide) + 'a'.repeat(room - wide * 3);
      const json = JSON.stringify({ seq, ts: seq, kind: 'narration', text });
      if (Buffer.byteLength(json) !== bytes) throw new Error('fixture size mismatch');
      return json;
    }

    const exact = entryOfBytes(1, LIMIT);
    const over = entryOfBytes(2, LIMIT + 1);

    it('exports the limit it enforces', () => {
      expect(wl.WORK_LOG_MAX_LINE_BYTES).toBe(LIMIT);
    });

    for (const pad of [0, 1, 2, 4095, 65535, 65536, 65537, 100_003]) {
      it(`keeps exact-limit lines and skips over-limit ones at alignment +${pad}`, async () => {
        const content = Buffer.concat([
          Buffer.from(pad > 0 ? `${'z'.repeat(pad - 1)}\n` : ''), // junk line shifts every boundary
          Buffer.from(`${exact}\n`),
          Buffer.from(`${over}\n`),
          Buffer.from(`${JSON.stringify({ seq: 3, ts: 3, kind: 'narration', text: 'crlf' })}\r\n`),
          Buffer.from(`${JSON.stringify({ seq: 4, ts: 4, kind: 'narration', text: '멀티바이트 ✓ 😀' })}\n`),
          Buffer.from(JSON.stringify({ seq: 5, ts: 5, kind: 'narration', text: 'no trailing newline' })),
        ]);
        writeRaw('conv-lines', content);

        // Backward scan (latest window).
        const latest = await wl.readWorkLog('conv-lines');
        expect(seqs(latest)).toEqual([1, 3, 4, 5]);
        expect(latest.entries[0].text).toBe(JSON.parse(exact).text);
        expect(latest.entries[2].text).toBe('멀티바이트 ✓ 😀');

        // Forward scan (limit 1 forces the binary search + forward path).
        const forward: number[] = [];
        let after = 0;
        for (let guard = 0; guard < 10; guard++) {
          const page = await wl.readWorkLog('conv-lines', { afterSeq: after, limit: 1 });
          if (page.entries.length === 0) break;
          forward.push(page.entries[0].seq);
          after = page.entries[0].seq;
        }
        expect(forward).toEqual([1, 3, 4, 5]);

        // Seed: continues after the last entry and repairs the missing newline.
        const next = await wl.appendWorkLog('conv-lines', { kind: 'notice', text: 'next' });
        expect(next.seq).toBe(6);
        expect(seqs(await wl.readWorkLog('conv-lines', { afterSeq: 4 }))).toEqual([5, 6]);
      });
    }

    it('never buffers more than one line limit plus one chunk, however long a line is', async () => {
      // A 3 MB line with no newline in it, between valid entries.
      writeRaw('conv-huge', `${line(1)}${'q'.repeat(3 * LIMIT)}\n${line(2)}${line(3)}`);
      const realConcat = Buffer.concat.bind(Buffer);
      let largest = 0;
      vi.spyOn(Buffer, 'concat').mockImplementation((list: readonly Uint8Array[], total?: number) => {
        const out = realConcat(list, total);
        largest = Math.max(largest, out.length);
        return out;
      });

      expect(seqs(await wl.readWorkLog('conv-huge'))).toEqual([1, 2, 3]);
      expect(seqs(await wl.readWorkLog('conv-huge', { afterSeq: 0, limit: 1 }))).toEqual([1]);
      expect(seqs(await wl.readWorkLog('conv-huge', { afterSeq: 1, limit: 1 }))).toEqual([2]);
      expect(largest).toBeGreaterThan(0);
      expect(largest).toBeLessThanOrEqual(wl.WORK_LOG_MAX_LINE_BYTES + wl.WORK_LOG_READ_CHUNK_BYTES);
    });

    it('skips an over-limit first line in both scan directions', async () => {
      writeRaw('conv-head', `${over}\n${line(3)}${line(4)}${line(5)}`);
      expect(seqs(await wl.readWorkLog('conv-head'))).toEqual([3, 4, 5]);
      // limit 1 from afterSeq 0 goes through the forward scan from offset 0.
      expect(seqs(await wl.readWorkLog('conv-head', { afterSeq: 0, limit: 1 }))).toEqual([3]);
    });

    it('skips an over-limit last line without a newline', async () => {
      writeRaw('conv-tail', `${line(1)}${over}`);
      expect(seqs(await wl.readWorkLog('conv-tail'))).toEqual([1]);
      expect((await wl.appendWorkLog('conv-tail', { kind: 'notice', text: 'x' })).seq).toBe(2);
    });

    it('caps tool and turnId like text, so the writer never produces an over-limit line', async () => {
      const entry = await wl.appendWorkLog('conv-cap', {
        kind: 'tool',
        text: '\u0001'.repeat(10_000), // escapes to 6 bytes each in JSON
        tool: 't'.repeat(5000),
        turnId: 'u'.repeat(5000),
      });
      expect(entry.tool?.length).toBe(wl.WORK_LOG_FIELD_MAX);
      expect(entry.turnId?.length).toBe(wl.WORK_LOG_FIELD_MAX);
      expect(entry.text.length).toBe(wl.WORK_LOG_TEXT_MAX);
      const raw = fs.readFileSync(logFile('conv-cap'));
      expect(raw.length - 1).toBeLessThanOrEqual(wl.WORK_LOG_MAX_LINE_BYTES);
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

  it('after a torn final line, the next entry reuses its seq on a fresh line', async () => {
    writeRaw('conv-t', `${line(1, 'ok')}{"seq":2,"ts":2,"ki`);

    const next = await wl.appendWorkLog('conv-t', { kind: 'narration', text: 'recovered' });
    // Guarantee: an entry is published only after its whole line is fdatasync'd,
    // so a line that is torn on disk was never published and its seq was never
    // handed to a reader — reusing it cannot collide with what a client holds.
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
      failNextAppend('nothing-written');

      await expect(wl.appendWorkLog('conv-w', { kind: 'narration', text: 'lost' })).rejects.toThrow('ENOSPC');
      const next = await wl.appendWorkLog('conv-w', { kind: 'narration', text: 'recovered' });

      const raw = fs.readFileSync(logFile('conv-w'), 'utf-8');
      expect(raw).toContain(`"ki\n${JSON.stringify(next)}\n`);
      expect(raw.endsWith('\n')).toBe(true);
      expect((await wl.readWorkLog('conv-w')).entries.map((e) => e.text)).toEqual(['ok', 'recovered']);
    });

    it('a write that fails after landing part of its line is repaired the same way', async () => {
      await wl.appendWorkLog('conv-x', { kind: 'narration', text: 'first' });
      failNextAppend('partial-write');

      await expect(wl.appendWorkLog('conv-x', { kind: 'narration', text: 'torn' })).rejects.toThrow('EIO');
      const next = await wl.appendWorkLog('conv-x', { kind: 'narration', text: 'second' });
      expect(next.seq).toBe(2);
      expect((await wl.readWorkLog('conv-x')).entries.map((e) => e.text)).toEqual(['first', 'second']);
    });

    it('a write failure does not block later appends to the same conversation', async () => {
      await wl.appendWorkLog('conv-q', { kind: 'narration', text: 'first' });
      failNextAppend('nothing-written');
      const results = await Promise.allSettled([
        wl.appendWorkLog('conv-q', { kind: 'narration', text: 'a' }),
        wl.appendWorkLog('conv-q', { kind: 'narration', text: 'b' }),
        wl.appendWorkLog('conv-q', { kind: 'narration', text: 'c' }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
      expect(seqs(await wl.readWorkLog('conv-q'))).toEqual([1, 2, 3]);
    });

    it('a new log whose first write failed resumes above the reservation, never below it', async () => {
      failNextAppend('nothing-written');
      await expect(wl.appendWorkLog('conv-q0', { kind: 'narration', text: 'lost' })).rejects.toThrow('ENOSPC');
      // Nothing parseable on disk, and the sidecar reserved 1..1000 before the
      // write: without proof of which of those were used, continue above them.
      const next = await wl.appendWorkLog('conv-q0', { kind: 'narration', text: 'kept' });
      expect(next.seq).toBe(wl.WORK_LOG_SEQ_RESERVE_BLOCK + 1);
      expect(seqs(await wl.readWorkLog('conv-q0'))).toEqual([next.seq]);
    });
  });

  it('notifies the registered callback after each published append; a throwing callback does not fail it', async () => {
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

  describe('writer-state cache', () => {
    const CAP = 256;
    // Each new conversation pays its real fsyncs (sidecar, directory, line), so a
    // few hundred of them take seconds.
    const SLOW = { timeout: 60_000 };

    it('exports the cap it enforces', () => {
      expect(wl.WORK_LOG_MAX_CACHED_STATES).toBe(CAP);
    });

    it('evicts the least recently used idle state; it re-seeds from disk, warm ones do not', SLOW, async () => {
      await Promise.all(
        Array.from({ length: CAP }, (_, i) => wl.appendWorkLog(`conv-lru-${i}`, { kind: 'narration', text: 'x' })),
      );
      const full = wl._cachedWorkLogStateIds();
      expect(full).toHaveLength(CAP);
      const [oldest] = full;
      const newest = full[full.length - 1];

      await wl.appendWorkLog('conv-lru-new', { kind: 'narration', text: 'x' });
      const after = wl._cachedWorkLogStateIds();
      expect(after).toHaveLength(CAP);
      expect(after).not.toContain(oldest);
      expect(after[after.length - 1]).toBe('conv-lru-new');

      const opens = spyOpen(() => {});
      const tailReads = (id: string) =>
        opens.mock.calls.filter((c) => String(c[0]) === logFile(id) && c[1] === 'r').length;
      // Evicted: appending reads its tail again and still continues at 2.
      expect((await wl.appendWorkLog(oldest, { kind: 'narration', text: 'y' })).seq).toBe(2);
      expect(tailReads(oldest)).toBe(1);
      // Warm: no tail read.
      expect((await wl.appendWorkLog(newest, { kind: 'narration', text: 'y' })).seq).toBe(2);
      expect(tailReads(newest)).toBe(0);
    });

    it('a burst of more than 256 distinct conversations settles back under the cap', SLOW, async () => {
      const burst = Array.from({ length: CAP + 44 }, (_, i) =>
        wl.appendWorkLog(`conv-burst-${i}`, { kind: 'narration', text: 'x' }),
      );
      // Everything is in flight at once, so nothing is evictable yet.
      expect(wl._cachedWorkLogStateIds()).toHaveLength(CAP + 44);
      expect((await Promise.all(burst)).every((e) => e.seq === 1)).toBe(true);
      expect(wl._cachedWorkLogStateIds().length).toBeLessThanOrEqual(CAP);
    });
  });
});

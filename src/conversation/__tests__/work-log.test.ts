import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every test here does real, fsync'd file I/O, many on multi-MB fixtures; on a
// heavily loaded host (load average 50+) a few of them cross the 5 s default
// without anything being wrong. They are bounded by design, so give them room.
vi.setConfig({ testTimeout: 30_000 });

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

/** Root ignores permission bits, so a chmod-based failure injection cannot fail there. */
const AS_ROOT = process.getuid?.() === 0;

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

  it('keeps the task an entry was made in (taskId + taskTitle, capped) — SSOT 2026-10-22 T10', async () => {
    const e = await wl.appendWorkLog('conv-task', {
      kind: 'tool',
      text: 'Read x',
      tool: 'Read',
      taskId: 'T3',
      taskTitle: 'y'.repeat(5000),
    });
    expect(e.taskId).toBe('T3');
    expect(e.taskTitle?.length).toBe(wl.WORK_LOG_FIELD_MAX);
    const page = await wl.readWorkLog('conv-task');
    expect(page.entries[0]).toMatchObject({ taskId: 'T3', taskTitle: e.taskTitle });
    const plain = await wl.appendWorkLog('conv-task', { kind: 'instruction', text: 'go' });
    expect('taskId' in plain).toBe(false);
  });

  it('keeps who made an entry (agentId) and which agent it starts (agentRef), and marks it attributed — spec 12 §2.4', async () => {
    const sub = await wl.appendWorkLog('conv-agent', {
      kind: 'tool',
      text: 'Grep x',
      tool: 'Grep',
      agentId: 'toolu_agent_1',
    });
    expect(sub).toMatchObject({ agentId: 'toolu_agent_1', attributed: true });
    const spawn = await wl.appendWorkLog('conv-agent', {
      kind: 'tool',
      text: 'Agent {...}',
      tool: 'Agent',
      agentRef: 'x'.repeat(5000),
    });
    expect(spawn.agentRef?.length).toBe(wl.WORK_LOG_FIELD_MAX);
    const main = await wl.appendWorkLog('conv-agent', { kind: 'narration', text: 'main' });
    expect('agentId' in main).toBe(false);
    expect('agentRef' in main).toBe(false);
    expect(main.attributed).toBe(true);
    const page = await wl.readWorkLog('conv-agent');
    expect(page.entries.map((e) => [e.agentId, e.agentRef?.length, e.attributed])).toEqual([
      ['toolu_agent_1', undefined, true],
      [undefined, wl.WORK_LOG_FIELD_MAX, true],
      [undefined, undefined, true],
    ]);
    // An entry written before attribution existed reads back without the mark.
    appendRaw('conv-agent', `${JSON.stringify({ seq: 9000, ts: 1, kind: 'tool', tool: 'Bash', text: 'Bash ls' })}\n`);
    const again = await (await loadFresh()).readWorkLog('conv-agent');
    expect(again.entries[again.entries.length - 1].attributed).toBeUndefined();
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

    it('seeds from the reservation, reading only the tail (for the trailing newline and quarantine)', async () => {
      fs.writeFileSync(sidecarFile('conv-big'), JSON.stringify({ reservedSeq: N + 999 }));
      const next = await wl.appendWorkLog('conv-big', { kind: 'notice', text: 'after restart' });
      expect(next.seq).toBe(N + 1000);
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

        it('a seed stops at the budget, quarantines the log, and continues above the live reservation', async () => {
          // The reservation the module would have written for entries 1..1000.
          fs.writeFileSync(sidecarFile('conv-junk'), JSON.stringify({ reservedSeq: 1999 }));
          const next = await wl.appendWorkLog('conv-junk', { kind: 'notice', text: 'fresh' });

          expect(next.seq).toBe(2000);
          expect(counter.bytes).toBeLessThanOrEqual(wl.WORK_LOG_SCAN_BUDGET_BYTES + 1);
          const dir = fs.readdirSync(path.dirname(logFile('conv-junk')));
          expect(dir.filter((f) => f.startsWith('conv-junk.jsonl.corrupt-'))).toHaveLength(1);
          expect(seqs(await wl.readWorkLog('conv-junk'))).toEqual([next.seq]);
          expect(JSON.parse(fs.readFileSync(sidecarFile('conv-junk'), 'utf-8')).reservedSeq).toBeGreaterThanOrEqual(
            next.seq,
          );
        });
      });
    }

    it('without a sidecar an unreadable tail fails closed instead of guessing from the file size', async () => {
      writeRaw('conv-legacy', Array.from({ length: 50 }, (_, i) => line(i + 1)).join(''));
      appendRaw('conv-legacy', Buffer.alloc(JUNK_BYTES, 0x0a));

      await expect(wl.appendWorkLog('conv-legacy', { kind: 'notice', text: 'fresh' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );
      expect(fs.existsSync(logFile('conv-legacy'))).toBe(true); // not quarantined
    });

    it('quarantine never goes backwards across restarts', async () => {
      for (let i = 0; i < 3; i++) await wl.appendWorkLog('conv-q2', { kind: 'narration', text: `n${i}` });
      appendRaw('conv-q2', Buffer.alloc(JUNK_BYTES, 0x0a));
      const restarted = await loadFresh();
      const afterQuarantine = await restarted.appendWorkLog('conv-q2', { kind: 'notice', text: 'fresh' });
      expect(afterQuarantine.seq).toBeGreaterThan(3);

      const again = await loadFresh();
      const later = await again.appendWorkLog('conv-q2', { kind: 'notice', text: 'later' });
      expect(later.seq).toBeGreaterThan(afterQuarantine.seq); // a restart resumes at the reservation
      await again.flushWorkLog();
    });

    describe('recovery ordering (review round 4)', () => {
      const realRename = fs.promises.rename.bind(fs.promises);

      it('a quarantine interrupted right after the rename never reissues an old seq', async () => {
        writeRaw('conv-qi', Array.from({ length: 50 }, (_, i) => line(i + 1)).join(''));
        appendRaw('conv-qi', Buffer.alloc(JUNK_BYTES, 0x0a));
        fs.writeFileSync(sidecarFile('conv-qi'), JSON.stringify({ reservedSeq: 1049 }));
        vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => {
          await realRename(from, to); // the rename lands, then the process "dies"
          throw ioError('EIO');
        });

        await expect(wl.appendWorkLog('conv-qi', { kind: 'notice', text: 'lost' })).rejects.toThrow('EIO');
        expect(fs.existsSync(logFile('conv-qi'))).toBe(false); // evidence moved away
        // Both sidecar copies held the floor before the evidence moved.
        expect(JSON.parse(fs.readFileSync(sidecarFile('conv-qi'), 'utf-8')).reservedSeq).toBe(1049);
        expect(JSON.parse(fs.readFileSync(`${sidecarFile('conv-qi')}.bak`, 'utf-8')).reservedSeq).toBe(1049);

        const restarted = await loadFresh();
        const next = await restarted.appendWorkLog('conv-qi', { kind: 'notice', text: 'after crash' });
        expect(next.seq).toBe(1050);
        await restarted.flushWorkLog();
      });

      it('a quarantine whose rename itself fails keeps the log and still never reissues an old seq', async () => {
        writeRaw('conv-qr', Array.from({ length: 50 }, (_, i) => line(i + 1)).join(''));
        appendRaw('conv-qr', Buffer.alloc(JUNK_BYTES, 0x0a));
        fs.writeFileSync(sidecarFile('conv-qr'), JSON.stringify({ reservedSeq: 1049 }));
        vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(ioError('EACCES'));

        await expect(wl.appendWorkLog('conv-qr', { kind: 'notice', text: 'lost' })).rejects.toThrow('EACCES');
        expect(fs.existsSync(logFile('conv-qr'))).toBe(true);
        const next = await wl.appendWorkLog('conv-qr', { kind: 'notice', text: 'retry' });
        expect(next.seq).toBe(1050);
      });
    });
  });

  describe('backup-only reservations (review round 5)', () => {
    const JUNK_BYTES = 9 * 1024 * 1024;
    const reservationIn = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8')).reservedSeq as number;
    const corruptLive = (id: string) => fs.writeFileSync(sidecarFile(id), '{"reservedSeq": 30');

    async function errorSpy() {
      // The freshly loaded work-log module and this import share one Logger class.
      const { Logger } = await import('../../logger');
      return vi.spyOn(Logger.prototype, 'error');
    }

    it('repeated corruption: .bak is restored to one block behind before 2001 is published, and step 4 fails closed', async () => {
      // 1. Live reservation 2000, .bak 1000, seqs 1..2000 published.
      writeRaw('conv-rc', Array.from({ length: 2000 }, (_, i) => line(i + 1)).join(''));
      fs.writeFileSync(sidecarFile('conv-rc'), JSON.stringify({ reservedSeq: 2000 }));
      fs.writeFileSync(`${sidecarFile('conv-rc')}.bak`, JSON.stringify({ reservedSeq: 1000 }));

      // 2. Live is corrupted; a fresh process re-seeds from the tail (2000) and publishes 2001.
      corruptLive('conv-rc');
      let step2 = await loadFresh();
      const atPublish: Array<{ seq: number; bak: number; live: number }> = [];
      step2.setOnWorkLogAppendedCallback((_id, entry) => {
        atPublish.push({
          seq: entry.seq,
          bak: reservationIn(`${sidecarFile('conv-rc')}.bak`),
          live: reservationIn(sidecarFile('conv-rc')),
        });
      });
      const e2001 = await step2.appendWorkLog('conv-rc', { kind: 'narration', text: 'after first corruption' });
      expect(e2001.seq).toBe(2001);
      // The invariant at the moment 2001 went out: .bak is at most one block behind live.
      expect(atPublish).toHaveLength(1);
      expect(atPublish[0].live).toBeGreaterThanOrEqual(2001);
      expect(atPublish[0].bak).toBeGreaterThanOrEqual(2000);
      expect(atPublish[0].live - atPublish[0].bak).toBeLessThanOrEqual(step2.WORK_LOG_SEQ_RESERVE_BLOCK);
      await step2.flushWorkLog();

      // 3. Live is corrupted again and the tail is unreadable within budget.
      corruptLive('conv-rc');
      appendRaw('conv-rc', Buffer.alloc(JUNK_BYTES, 0x0a));

      // 4. Recovery has only the backup and no readable entry: it publishes nothing.
      step2 = await loadFresh();
      const errors = await errorSpy();
      const published: number[] = [];
      step2.setOnWorkLogAppendedCallback((_id, entry) => published.push(entry.seq));
      for (let i = 0; i < 3; i++) {
        await expect(step2.appendWorkLog('conv-rc', { kind: 'notice', text: `retry ${i}` })).rejects.toBeInstanceOf(
          step2.WorkLogUnboundedError,
        );
      }
      expect(published).toEqual([]);
      const verdicts = errors.mock.calls.filter(([message]) => String(message).includes('no provable seq upper bound'));
      expect(verdicts).toHaveLength(1); // once per conversation
      expect(verdicts[0][1]).toMatchObject({
        conversationId: 'conv-rc',
        logPath: logFile('conv-rc'),
        reservationSource: 'backup',
        logSize: fs.statSync(logFile('conv-rc')).size,
      });
      expect(fs.existsSync(logFile('conv-rc'))).toBe(true); // evidence kept, not quarantined
    });

    it('the backup repair holds on its own when the append fails before any new reservation', async () => {
      writeRaw('conv-b0', Array.from({ length: 1500 }, (_, i) => line(i + 1)).join(''));
      corruptLive('conv-b0');
      fs.writeFileSync(`${sidecarFile('conv-b0')}.bak`, JSON.stringify({ reservedSeq: 1000 }));
      // The repair runs inside the seed; the append then dies at the directory
      // mkdir, before writing the next reservation (which would promote anyway).
      vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(ioError('EIO'));

      await expect(wl.appendWorkLog('conv-b0', { kind: 'notice', text: 'x' })).rejects.toThrow('EIO');
      expect(reservationIn(sidecarFile('conv-b0'))).toBe(2000);
      expect(reservationIn(`${sidecarFile('conv-b0')}.bak`)).toBe(2000);
    });

    it('backup-only with a readable tail rewrites both copies and resumes a block above the backup', async () => {
      writeRaw('conv-b1', Array.from({ length: 1500 }, (_, i) => line(i + 1)).join(''));
      corruptLive('conv-b1');
      fs.writeFileSync(`${sidecarFile('conv-b1')}.bak`, JSON.stringify({ reservedSeq: 1000 }));

      const next = await wl.appendWorkLog('conv-b1', { kind: 'notice', text: 'x' });
      // The lost live copy can have reserved up to 1000 + one block; the tail says 1500.
      expect(next.seq).toBe(2001);
      expect(reservationIn(`${sidecarFile('conv-b1')}.bak`)).toBeGreaterThanOrEqual(2000);
      expect(reservationIn(sidecarFile('conv-b1'))).toBeGreaterThanOrEqual(2001);
    });

    it.each([
      ['a missing log', (id: string) => fs.rmSync(logFile(id))],
      ['an empty log', (id: string) => writeRaw(id, '')],
      ['a log with no parseable entry', (id: string) => writeRaw(id, 'garbage\n{"seq":\n')],
    ])('backup-only with %s fails closed', async (_name, damage) => {
      writeRaw('conv-b2', line(1));
      corruptLive('conv-b2');
      fs.writeFileSync(`${sidecarFile('conv-b2')}.bak`, JSON.stringify({ reservedSeq: 1000 }));
      damage('conv-b2');
      await expect(wl.appendWorkLog('conv-b2', { kind: 'notice', text: 'x' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );
    });

    it('without a sidecar, a log with only junk fails closed; a missing log starts at 1', async () => {
      writeRaw('conv-n1', 'junk\nmore junk\n');
      await expect(wl.appendWorkLog('conv-n1', { kind: 'notice', text: 'x' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );
      expect((await wl.appendWorkLog('conv-n2', { kind: 'notice', text: 'x' })).seq).toBe(1);
    });

    it('a fail-closed conversation is not re-scanned until its files change, then recovers', async () => {
      writeRaw('conv-fc', Array.from({ length: 10 }, (_, i) => line(i + 1)).join(''));
      appendRaw('conv-fc', Buffer.alloc(JUNK_BYTES, 0x0a));
      fs.writeFileSync(`${sidecarFile('conv-fc')}.bak`, JSON.stringify({ reservedSeq: 1000 }));
      corruptLive('conv-fc');
      await expect(wl.appendWorkLog('conv-fc', { kind: 'notice', text: 'a' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );

      const counter = countReads();
      await expect(wl.appendWorkLog('conv-fc', { kind: 'notice', text: 'b' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );
      expect(counter.bytes).toBe(0); // same files: refused without another 8 MB scan

      // An operator restores the live reservation: the verdict is re-evaluated and lifted.
      fs.writeFileSync(sidecarFile('conv-fc'), JSON.stringify({ reservedSeq: 2000 }));
      const next = await wl.appendWorkLog('conv-fc', { kind: 'notice', text: 'c' });
      expect(next.seq).toBe(2001);
    });

    it('a failed append burns its seq; the cursor is never re-derived from a damaged file', async () => {
      for (let i = 0; i < 3; i++) await wl.appendWorkLog('conv-hw', { kind: 'narration', text: `n${i}` });
      // The file loses its last two entries behind the writer's back.
      writeRaw('conv-hw', line(1));
      failNextAppend('nothing-written');
      await expect(wl.appendWorkLog('conv-hw', { kind: 'narration', text: 'lost' })).rejects.toThrow('ENOSPC');

      const next = await wl.appendWorkLog('conv-hw', { kind: 'narration', text: 'kept' });
      expect(next.seq).toBe(5); // 4 burned by the failure; never 2
    });
  });

  describe('one-block reservation steps (review round 7)', () => {
    // A small block keeps the same shape (two boundary crossings, a full block of
    // publishes) at tens of fdatasyncs instead of thousands. Every fresh module
    // load starts at the production block, so it is set again after each one.
    const BLOCK = 10;
    const dir = () => path.join(paths.dataDir, 'worklogs');
    async function freshWithSmallBlock(): Promise<WorkLogModule> {
      const mod = await loadFresh();
      mod._setWorkLogReserveBlockForTests(BLOCK);
      return mod;
    }

    afterEach(() => {
      wl._setWorkLogReserveBlockForTests();
    });
    const readSeqFile = (file: string): number | null =>
      fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')).reservedSeq as number) : null;

    /** A restart onto a full block: live reservation and cursor both at `at`. */
    function restartAt(id: string, at: number): void {
      writeRaw(id, Array.from({ length: at }, (_, i) => line(i + 1)).join(''));
      fs.writeFileSync(sidecarFile(id), JSON.stringify({ reservedSeq: at }));
    }

    /**
     * Make the directory read-only, so the next reservation write fails before it
     * lands. Permission bits do not bind root, so the tests using it skip there.
     */
    async function withReadOnlyDir<T>(fn: () => Promise<T>): Promise<T> {
      fs.chmodSync(dir(), 0o500);
      try {
        return await fn();
      } finally {
        fs.chmodSync(dir(), 0o700);
      }
    }

    /** Record (live, .bak) at every directory sync — every reservation write ends with one. */
    function watchSidecar(
      id: string,
      extra: (fh: FileHandle, args: OpenArgs) => void = () => {},
    ): Array<{ live: number | null; bak: number | null }> {
      const seen: Array<{ live: number | null; bak: number | null }> = [];
      spyOpen((fh, args) => {
        extra(fh, args);
        if (args[1] !== 'r' || String(args[0]) !== dir()) return;
        const real = fh.sync.bind(fh);
        (fh as { sync: unknown }).sync = async () => {
          await real();
          seen.push({ live: readSeqFile(sidecarFile(id)), bak: readSeqFile(`${sidecarFile(id)}.bak`) });
        };
      });
      return seen;
    }

    function expectOneBlockSteps(seen: Array<{ live: number | null; bak: number | null }>): void {
      const lives = seen.map((s) => s.live).filter((v): v is number => v !== null);
      for (let i = 1; i < lives.length; i++) {
        expect(lives[i] - lives[i - 1]).toBeGreaterThanOrEqual(0);
        expect(lives[i] - lives[i - 1]).toBeLessThanOrEqual(BLOCK);
      }
      for (const { live, bak } of seen) {
        if (live !== null && bak !== null) expect(live - bak).toBeLessThanOrEqual(BLOCK);
      }
    }

    it.skipIf(AS_ROOT)(
      'the full chain: a reservation failure, a block of publishes, live lost + last entry truncated → no reuse',
      async () => {
        const id = 'conv-chain';
        // 1. Live reservation and cursor both one block; 1..BLOCK were published by an earlier process.
        restartAt(id, BLOCK);
        const published = new Set<number>(Array.from({ length: BLOCK }, (_, i) => i + 1));
        let proc = await freshWithSmallBlock();
        wl = proc;
        proc.setOnWorkLogAppendedCallback((_c, e) => published.add(e.seq));

        // 2. Append BLOCK + 1 fails before its reservation write lands.
        await withReadOnlyDir(() =>
          expect(proc.appendWorkLog(id, { kind: 'narration', text: 'fails' })).rejects.toThrow(),
        );
        const afterFailure = { live: readSeqFile(sidecarFile(id)), bak: readSeqFile(`${sidecarFile(id)}.bak`) };

        // 3–4. The retry reserves the next block; publish up to the live reservation.
        const retried = await proc.appendWorkLog(id, { kind: 'narration', text: 'retry' });
        const step3 = { live: readSeqFile(sidecarFile(id)), bak: readSeqFile(`${sidecarFile(id)}.bak`) };
        let last = retried.seq;
        while (last < (step3.live ?? 0))
          last = (await proc.appendWorkLog(id, { kind: 'narration', text: `p${last}` })).seq;
        await proc.flushWorkLog();

        // 5. The live sidecar is lost and the last entry is truncated away.
        fs.rmSync(sidecarFile(id));
        const raw = fs.readFileSync(logFile(id), 'utf-8');
        fs.truncateSync(logFile(id), Buffer.byteLength(raw.slice(0, raw.lastIndexOf('\n', raw.length - 2) + 1)));

        // 6. Recovery from .bak + the tail must not republish anything.
        const before = new Set(published);
        proc = await freshWithSmallBlock();
        wl = proc;
        proc.setOnWorkLogAppendedCallback((_c, e) => published.add(e.seq));
        const recovered = await proc.appendWorkLog(id, { kind: 'notice', text: 'after recovery' });
        await proc.flushWorkLog();
        expect(before.has(recovered.seq)).toBe(false);
        expect(recovered.seq).toBeGreaterThan(Math.max(...before));

        // And the mechanism: the failed write landed nothing and burned nothing;
        // the retry stepped exactly one block, keeping .bak one block behind.
        expect(afterFailure).toEqual({ live: BLOCK, bak: null });
        expect(retried.seq).toBe(BLOCK + 1);
        expect(step3).toEqual({ live: 2 * BLOCK, bak: BLOCK });
      },
    );

    it.skipIf(AS_ROOT)(
      'a burst of burned seqs beyond a block, then reservation failures, then success: every live step ≤ one block',
      async () => {
        const id = 'conv-burst';
        restartAt(id, BLOCK);
        wl = await freshWithSmallBlock();
        // Phase 1: 2 blocks of appends whose reservation succeeds but whose line
        // write fails — real burns, crossing two block boundaries.
        let failWrites = true;
        const seen = watchSidecar(id, (fh, args) => {
          if (args[1] === 'a' && failWrites) {
            (fh as { writeFile: unknown }).writeFile = async () => {
              throw ioError('ENOSPC');
            };
          }
        });
        for (let i = 0; i < 2 * BLOCK; i++) {
          await expect(wl.appendWorkLog(id, { kind: 'narration', text: `b${i}` })).rejects.toThrow('ENOSPC');
        }
        failWrites = false;

        // Phase 2: the next boundary's reservation write fails five times.
        await withReadOnlyDir(async () => {
          for (let i = 0; i < 5; i++) {
            await expect(wl.appendWorkLog(id, { kind: 'narration', text: `r${i}` })).rejects.toThrow();
          }
        });

        // Then a successful append.
        const ok = await wl.appendWorkLog(id, { kind: 'narration', text: 'ok' });
        expect(ok.seq).toBe(3 * BLOCK + 1); // BLOCK+1..3·BLOCK burned; the failed reservations burned nothing
        seen.push({ live: readSeqFile(sidecarFile(id)), bak: readSeqFile(`${sidecarFile(id)}.bak`) });

        expectOneBlockSteps(seen);
        expect(seen.map((s) => s.live).filter((v, i, a) => v !== a[i - 1])).toEqual([2 * BLOCK, 3 * BLOCK, 4 * BLOCK]);
        expect(seen[seen.length - 1]).toEqual({ live: 4 * BLOCK, bak: 3 * BLOCK });
      },
    );

    it('the production block is 1000, and resetting the test setter restores it', async () => {
      expect(wl.WORK_LOG_SEQ_RESERVE_BLOCK).toBe(1000);
      expect(() => wl._setWorkLogReserveBlockForTests(0)).toThrow();
      wl._setWorkLogReserveBlockForTests(BLOCK);
      await wl.appendWorkLog('conv-small', { kind: 'narration', text: 'x' });
      expect(readSeqFile(sidecarFile('conv-small'))).toBe(BLOCK);
      wl._setWorkLogReserveBlockForTests();
      await wl.appendWorkLog('conv-default', { kind: 'narration', text: 'x' });
      expect(readSeqFile(sidecarFile('conv-default'))).toBe(1000);
    });

    it('the step assertion refuses (error log, no write) a reservation that lowers live or jumps more than a block', async () => {
      const { Logger } = await import('../../logger');
      const errors = vi.spyOn(Logger.prototype, 'error');
      fs.mkdirSync(dir(), { recursive: true });
      const sidecar = sidecarFile('conv-assert');
      fs.writeFileSync(sidecar, JSON.stringify({ reservedSeq: 1000 }));

      await expect(wl._writeWorkLogReservationForTests(sidecar, 1000, 2001)).rejects.toThrow(/one-block invariant/);
      await expect(wl._writeWorkLogReservationForTests(sidecar, 1000, 999)).rejects.toThrow(/one-block invariant/);
      expect(readSeqFile(sidecar)).toBe(1000);
      expect(errors.mock.calls.filter(([m]) => String(m).includes('reservation step refused'))).toHaveLength(2);

      await wl._writeWorkLogReservationForTests(sidecar, 1000, 2000);
      expect(readSeqFile(sidecar)).toBe(2000);
    });

    it('backup B with a readable entry above B + block refuses: no one-block step from B covers it', async () => {
      writeRaw('conv-bigt', `${line(1)}${line(2500)}`);
      fs.writeFileSync(sidecarFile('conv-bigt'), '{"reservedSeq": 30');
      fs.writeFileSync(`${sidecarFile('conv-bigt')}.bak`, JSON.stringify({ reservedSeq: 1000 }));
      await expect(wl.appendWorkLog('conv-bigt', { kind: 'notice', text: 'x' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );
    });
  });

  describe('final-review items (review round 9)', () => {
    afterEach(() => {
      wl._setWorkLogReserveBlockForTests();
    });

    async function loggerSpies() {
      const { Logger } = await import('../../logger');
      return { error: vi.spyOn(Logger.prototype, 'error'), warn: vi.spyOn(Logger.prototype, 'warn') };
    }

    const truncate = (file: string) => fs.writeFileSync(file, '{"reservedSeq": 9');
    const remove = (file: string) => fs.rmSync(file);
    const wrongSchema = (file: string) => fs.writeFileSync(file, JSON.stringify({ foo: 1 }));
    it.each([
      ['corrupted', truncate, truncate],
      ['deleted', remove, remove],
      // Review round 10: a VALID but stale value (an older reservation put back
      // over live 20) must not be promoted to `.bak` at the next crossing — that
      // left `.bak` two blocks behind, and recovery reused 21.
      [
        'overwritten with an older reservation',
        (file: string) => fs.writeFileSync(file, '{"reservedSeq":10}'),
        truncate,
      ],
      // ...nor valid JSON of the wrong schema: promoting it left no usable copy
      // after live was lost, so the conversation failed closed for good.
      ['overwritten with the wrong schema', wrongSchema, wrongSchema],
    ])('live sidecar %s in-process, a block crossed, the tail lost, live lost again → no seq reused', async (_how, damage, damageAgain) => {
      const BLOCK = 10;
      const id = 'conv-tf';
      const live = sidecarFile(id);
      writeRaw(id, Array.from({ length: BLOCK }, (_, i) => line(i + 1)).join(''));
      fs.writeFileSync(live, JSON.stringify({ reservedSeq: BLOCK }));
      const published = new Set<number>(Array.from({ length: BLOCK }, (_, i) => i + 1));
      const fresh = async () => {
        const mod = await loadFresh();
        mod._setWorkLogReserveBlockForTests(BLOCK);
        mod.setOnWorkLogAppendedCallback((_c, e) => published.add(e.seq));
        wl = mod;
        return mod;
      };

      let proc = await fresh();
      for (let s = BLOCK + 1; s <= 2 * BLOCK; s++) await proc.appendWorkLog(id, { kind: 'narration', text: `a${s}` });
      // live 20, .bak 10. Now the live copy is damaged while the writer is warm...
      damage(live);
      // ...and the next block is crossed (reservation 20 → 30) and 21..25 published.
      for (let s = 2 * BLOCK + 1; s <= 2 * BLOCK + 5; s++) {
        await proc.appendWorkLog(id, { kind: 'narration', text: `b${s}` });
      }
      const bakAfterCrossing = JSON.parse(fs.readFileSync(`${live}.bak`, 'utf-8')).reservedSeq;
      await proc.flushWorkLog();

      // Entries 21..25 are lost, and the live copy is damaged again.
      const kept = fs
        .readFileSync(logFile(id), 'utf-8')
        .split('\n')
        .filter((l) => l && JSON.parse(l).seq <= 2 * BLOCK);
      writeRaw(id, `${kept.join('\n')}\n`);
      damageAgain(live);

      const before = new Set(published);
      proc = await fresh();
      const next = await proc.appendWorkLog(id, { kind: 'notice', text: 'after restart' });
      await proc.flushWorkLog();
      expect(before.has(next.seq)).toBe(false);
      expect(next.seq).toBeGreaterThan(Math.max(...before));
      // The mechanism: the crossing promoted .bak to the new reservation even
      // though live did not hold the writer's previous one.
      expect(bakAfterCrossing).toBe(3 * BLOCK);
    });

    it('afterSeq paging makes progress past a mid-log junk region (reviewer probe)', async () => {
      const id = 'conv-midjunk';
      // The reader is under test, so the entries are written raw (no per-entry fdatasync).
      writeRaw(id, Array.from({ length: 50 }, (_, i) => line(i + 1)).join(''));
      appendRaw(id, Buffer.from('x\n'.repeat(3 * 1024 * 1024))); // ~6 MB of junk lines
      appendRaw(id, Array.from({ length: 30 }, (_, i) => line(51 + i)).join(''));

      const after50 = await wl.readWorkLog(id, { afterSeq: 50 });
      expect(seqs(after50)).toEqual(Array.from({ length: 30 }, (_, i) => 51 + i));
      expect(after50.hasMore).toBe(false);

      // Paging from before the junk: first the entries in front of it, then past it.
      const after40 = await wl.readWorkLog(id, { afterSeq: 40 });
      expect(seqs(after40)).toEqual(Array.from({ length: 10 }, (_, i) => 41 + i));
      expect(after40.hasMore).toBe(true);
      const small = await wl.readWorkLog(id, { afterSeq: 50, limit: 10 });
      expect(seqs(small)).toEqual(Array.from({ length: 10 }, (_, i) => 51 + i));
      expect(small.hasMore).toBe(true);
    });

    it('a junk region wider than the budget never makes paging skip entries past it', async () => {
      const id = 'conv-widejunk';
      writeRaw(id, Array.from({ length: 50 }, (_, i) => line(i + 1)).join(''));
      appendRaw(id, Buffer.from('x\n'.repeat(10 * 1024 * 1024))); // 20 MB
      appendRaw(id, Array.from({ length: 600 }, (_, i) => line(51 + i)).join(''));

      const page = await wl.readWorkLog(id, { afterSeq: 50 });
      // Either nothing yet (documented stall) or exactly from 51 — never a jump past 51.
      if (page.entries.length > 0) expect(page.entries[0].seq).toBe(51);
      expect(page.hasMore).toBe(true);
    });

    it('a corrupt live sidecar with no .bak fails closed with one error log across 5 appends', async () => {
      const id = 'conv-nobak';
      writeRaw(id, Array.from({ length: 5 }, (_, i) => line(i + 1)).join(''));
      fs.writeFileSync(sidecarFile(id), '{"reservedSeq": 10');
      const { error, warn } = await loggerSpies();

      for (let i = 0; i < 5; i++) {
        await expect(wl.appendWorkLog(id, { kind: 'notice', text: `t${i}` })).rejects.toBeInstanceOf(
          wl.WorkLogUnboundedError,
        );
      }
      expect(error.mock.calls.filter(([m]) => String(m).includes('no provable seq upper bound'))).toHaveLength(1);
      expect(warn.mock.calls.filter(([m]) => String(m).includes('seed failed'))).toHaveLength(0);
    });

    it('an unreadable sidecar (I/O error) is not cached as a verdict: it is retried and recovers', async () => {
      const id = 'conv-eisdir';
      writeRaw(id, Array.from({ length: 5 }, (_, i) => line(i + 1)).join(''));
      // A directory where the sidecar should be: reading it fails with EISDIR
      // for every user, root included (a chmod 0o000 would not bind root).
      fs.mkdirSync(sidecarFile(id));
      const failure = await wl.appendWorkLog(id, { kind: 'notice', text: 'a' }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(wl.WorkLogUnboundedError);

      fs.rmdirSync(sidecarFile(id));
      fs.writeFileSync(sidecarFile(id), JSON.stringify({ reservedSeq: 1000 }));
      expect((await wl.appendWorkLog(id, { kind: 'notice', text: 'b' })).seq).toBe(1001);
    });
  });

  describe('review round 10', () => {
    it('afterSeq paging returns the entries after junk wider than the remaining budget when they start at afterSeq + 1', async () => {
      const id = 'conv-gapjunk';
      writeRaw(id, Array.from({ length: 50 }, (_, i) => line(i + 1)).join(''));
      appendRaw(id, Buffer.from('x\n'.repeat(10 * 1024 * 1024))); // 20 MB, wider than the whole budget
      appendRaw(id, Array.from({ length: 30 }, (_, i) => line(51 + i)).join(''));

      const page = await wl.readWorkLog(id, { afterSeq: 50 });
      expect(seqs(page)).toEqual(Array.from({ length: 30 }, (_, i) => 51 + i));
      expect(page.hasMore).toBe(false);

      // The backward scan collects at most limit + 1 entries, so the proof also
      // holds when exactly one more than the page follows: hasMore from the extra.
      const short = await wl.readWorkLog(id, { afterSeq: 50, limit: 29 });
      expect(seqs(short)).toEqual(Array.from({ length: 29 }, (_, i) => 51 + i));
      expect(short.hasMore).toBe(true);
    });

    it('a sidecar whose CONTENT mentions "unreadable:" is still classified by what happened (fails closed)', async () => {
      const id = 'conv-sniff';
      writeRaw(id, Array.from({ length: 5 }, (_, i) => line(i + 1)).join(''));
      // Invalid JSON whose parser error quotes it — the old message sniffing
      // read that as an I/O failure and retried forever instead of failing closed.
      fs.writeFileSync(sidecarFile(id), 'unreadable: x');

      await expect(wl.appendWorkLog(id, { kind: 'notice', text: 'a' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );
    });
  });

  describe('the floor rests only on the reservation (review round 6)', () => {
    async function publishThree(id: string): Promise<number> {
      for (let i = 1; i <= 3; i++) await wl.appendWorkLog(id, { kind: 'narration', text: `entry ${i}` });
      await wl.flushWorkLog();
      return JSON.parse(fs.readFileSync(sidecarFile(id), 'utf-8')).reservedSeq as number;
    }

    it('a restart after the last published entry was corrupted resumes above the reservation', async () => {
      const reserved = await publishThree('conv-c3');
      // Damage entry 3 in place (same length, no longer JSON).
      const raw = fs.readFileSync(logFile('conv-c3'), 'utf-8');
      const lastStart = raw.lastIndexOf('\n', raw.length - 2) + 1;
      writeRaw('conv-c3', `${raw.slice(0, lastStart)}${'x'.repeat(raw.length - lastStart - 1)}\n`);
      expect(seqs(await wl.readWorkLog('conv-c3'))).toEqual([1, 2]);

      const restarted = await loadFresh();
      const next = await restarted.appendWorkLog('conv-c3', { kind: 'notice', text: 'after restart' });
      expect(next.seq).toBeGreaterThan(reserved);
      await restarted.flushWorkLog();
    });

    it('a restart after the last published entry was truncated away resumes above the reservation', async () => {
      const reserved = await publishThree('conv-t3');
      const raw = fs.readFileSync(logFile('conv-t3'), 'utf-8');
      fs.truncateSync(logFile('conv-t3'), Buffer.byteLength(raw.slice(0, raw.lastIndexOf('\n', raw.length - 2) + 1)));
      expect(seqs(await wl.readWorkLog('conv-t3'))).toEqual([1, 2]);

      const restarted = await loadFresh();
      const next = await restarted.appendWorkLog('conv-t3', { kind: 'notice', text: 'after restart' });
      expect(next.seq).toBeGreaterThan(reserved);
      await restarted.flushWorkLog();
    });

    it('no sidecar with a non-empty log refuses, even when the log reads cleanly', async () => {
      writeRaw('conv-ns', `${line(1)}${line(2)}`);
      await expect(wl.appendWorkLog('conv-ns', { kind: 'notice', text: 'x' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );
    });

    it('a readable entry above the live reservation contradicts it and refuses', async () => {
      writeRaw('conv-gt', `${line(1)}${line(1500)}`);
      fs.writeFileSync(sidecarFile('conv-gt'), JSON.stringify({ reservedSeq: 1000 }));
      await expect(wl.appendWorkLog('conv-gt', { kind: 'notice', text: 'x' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );
    });

    it('the fail-closed verdict notices a same-size replacement whose mtime was preserved', async () => {
      writeRaw('conv-fp', Array.from({ length: 10 }, (_, i) => line(i + 1)).join(''));
      appendRaw('conv-fp', Buffer.alloc(9 * 1024 * 1024, 0x0a));
      fs.writeFileSync(`${sidecarFile('conv-fp')}.bak`, JSON.stringify({ reservedSeq: 1000 }));
      const live = sidecarFile('conv-fp');
      fs.writeFileSync(live, '{"reservedSeq":2000'); // corrupt: 19 bytes
      const pinned = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(live, pinned, pinned);
      await expect(wl.appendWorkLog('conv-fp', { kind: 'notice', text: 'a' })).rejects.toBeInstanceOf(
        wl.WorkLogUnboundedError,
      );

      // Same path, same size, mtime put back: only ino/ctime can tell.
      fs.writeFileSync(live, '{"reservedSeq":200}'); // valid: also 19 bytes
      fs.utimesSync(live, pinned, pinned);
      expect(fs.statSync(live).mtimeMs).toBe(pinned.getTime());
      const next = await wl.appendWorkLog('conv-fp', { kind: 'notice', text: 'b' });
      expect(next.seq).toBe(201);
    });
  });

  describe('directory durability obligations (review round 4)', () => {
    const worklogsDir = () => path.join(paths.dataDir, 'worklogs');

    /**
     * Record log datasyncs, directory syncs and publishes; fail the first sync
     * of `failDir` that happens after the trigger event (or right away).
     */
    function recordSyncs(failDir: () => string, after: 'log.datasync' | null) {
      const events: string[] = [];
      let triggered = after === null;
      let failed = false;
      spyOpen((fh, args) => {
        const file = String(args[0]);
        if (file.endsWith('.jsonl') && args[1] === 'a') {
          const real = fh.datasync.bind(fh);
          (fh as { datasync: unknown }).datasync = async () => {
            await real();
            events.push('log.datasync');
            if (after === 'log.datasync') triggered = true;
          };
        } else if (args[1] === 'r' && (file === worklogsDir() || file === paths.dataDir)) {
          const tag = file === worklogsDir() ? 'worklogs.sync' : 'parent.sync';
          const real = fh.sync.bind(fh);
          (fh as { sync: unknown }).sync = async () => {
            if (file === failDir() && triggered && !failed) {
              failed = true;
              throw ioError('EIO');
            }
            await real();
            events.push(tag);
          };
        }
      });
      wl.setOnWorkLogAppendedCallback(() => events.push('publish'));
      return events;
    }

    it('a directory fsync that failed after the first append is redone before the next publish', async () => {
      const events = recordSyncs(worklogsDir, 'log.datasync');

      await expect(wl.appendWorkLog('conv-dir', { kind: 'narration', text: 'one' })).rejects.toThrow('EIO');
      expect(events).not.toContain('publish');

      events.length = 0;
      const second = await wl.appendWorkLog('conv-dir', { kind: 'narration', text: 'two' });
      events.push('resolved');
      expect(second.seq).toBe(2); // seq 1 landed (fdatasync'd) and stays a normal entry
      expect(events).toEqual(['log.datasync', 'worklogs.sync', 'publish', 'resolved']);
      expect(seqs(await wl.readWorkLog('conv-dir'))).toEqual([1, 2]);

      // Obligation cleared by that success: the third append syncs nothing extra.
      events.length = 0;
      await wl.appendWorkLog('conv-dir', { kind: 'narration', text: 'three' });
      expect(events).toEqual(['log.datasync', 'publish']);
    });

    it('a change that lands while a directory sync is in flight keeps its own obligation', async () => {
      // Warm up so the directory exists and every obligation so far is cleared.
      await wl.appendWorkLog('conv-warm', { kind: 'narration', text: 'warm' });

      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        return { promise, resolve };
      };
      const aSyncStarted = deferred();
      const releaseA = deferred();
      const bDatasynced = deferred();
      const releaseB = deferred();
      const events: string[] = [];
      let armA = false;
      let gatedA = false;

      spyOpen((fh, args) => {
        const file = String(args[0]);
        if (args[1] === 'a' && file === logFile('conv-A')) {
          const real = fh.datasync.bind(fh);
          (fh as { datasync: unknown }).datasync = async () => {
            await real();
            armA = true; // A's next directory sync is the one held in flight
          };
        } else if (args[1] === 'a' && file === logFile('conv-B')) {
          const real = fh.datasync.bind(fh);
          (fh as { datasync: unknown }).datasync = async () => {
            await real();
            events.push('B.datasync');
            bDatasynced.resolve();
            await releaseB.promise;
          };
        } else if (args[1] === 'r' && file === worklogsDir()) {
          const real = fh.sync.bind(fh);
          (fh as { sync: unknown }).sync = async () => {
            if (armA && !gatedA) {
              gatedA = true;
              aSyncStarted.resolve();
              await releaseA.promise; // A's sync is in flight...
            }
            await real();
            events.push('worklogs.sync');
          };
        }
      });
      wl.setOnWorkLogAppendedCallback((id) => events.push(`${id}.publish`));

      const pA = wl.appendWorkLog('conv-A', { kind: 'narration', text: 'a' });
      await aSyncStarted.promise;
      // ...while B creates its log (a new directory entry) and stalls after fdatasync.
      const pB = wl.appendWorkLog('conv-B', { kind: 'narration', text: 'b' });
      await bDatasynced.promise;
      releaseA.resolve();
      await pA;
      releaseB.resolve();
      await pB;

      // A's held sync finished after B's create, then A published. That sync began
      // before the create, so it must not have cleared B's obligation: B syncs again.
      expect(events.slice(events.indexOf('B.datasync'))).toEqual([
        'B.datasync',
        'worklogs.sync', // A's, released
        'conv-A.publish',
        'worklogs.sync', // B's own, for the entry it created
        'conv-B.publish',
      ]);
    });

    it('a persistent directory-sync failure publishes nothing, settles every append, logs, and recovers', async () => {
      const { Logger } = await import('../../logger');
      const errors = vi.spyOn(Logger.prototype, 'error');
      // The fault starts right after the first line's fdatasync, so the new log's
      // directory obligation can never be discharged: every append gets past its
      // (still covered) reservation and dies at the pre-publish directory sync.
      let failing = false;
      spyOpen((fh, args) => {
        const file = String(args[0]);
        if (args[1] === 'a' && file === logFile('conv-sf')) {
          const real = fh.datasync.bind(fh);
          (fh as { datasync: unknown }).datasync = async () => {
            await real();
            failing = true;
          };
        } else if (args[1] === 'r' && file === worklogsDir()) {
          const real = fh.sync.bind(fh);
          (fh as { sync: unknown }).sync = async () => {
            if (failing) throw ioError('EIO');
            await real();
          };
        }
      });
      const published: number[] = [];
      wl.setOnWorkLogAppendedCallback((_id, entry) => published.push(entry.seq));

      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => wl.appendWorkLog('conv-sf', { kind: 'narration', text: `t${i}` })),
      );
      expect(attempts.map((a) => a.status)).toEqual(Array(5).fill('rejected'));
      expect(published).toEqual([]);
      expect(errors.mock.calls.some(([message]) => String(message).includes('Failed to persist work log entry'))).toBe(
        true,
      );
      // Each attempt's line did land; none was broadcast.
      expect(seqs(await wl.readWorkLog('conv-sf'))).toEqual([1, 2, 3, 4, 5]);

      vi.restoreAllMocks(); // the fault clears
      const next = await wl.appendWorkLog('conv-sf', { kind: 'narration', text: 'recovered' });
      expect(next.seq).toBe(6);
      expect(published).toEqual([6]);
      // The landed-but-unpublished entries 1..5 are backfillable below it.
      expect(seqs(await wl.readWorkLog('conv-sf', { afterSeq: 0 }))).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('a failed parent fsync after mkdir is redone before the next publish (ensureDir retry)', async () => {
      const events = recordSyncs(() => paths.dataDir, null);

      await expect(wl.appendWorkLog('conv-mk', { kind: 'narration', text: 'one' })).rejects.toThrow('EIO');
      expect(events).not.toContain('publish');

      events.length = 0;
      await wl.appendWorkLog('conv-mk', { kind: 'narration', text: 'two' });
      const publishAt = events.indexOf('publish');
      expect(publishAt).toBeGreaterThan(-1);
      expect(events.slice(0, publishAt)).toContain('parent.sync');
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

        // Seed: continues at the reservation and repairs the missing newline.
        fs.writeFileSync(sidecarFile('conv-lines'), JSON.stringify({ reservedSeq: 5 }));
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
      fs.writeFileSync(sidecarFile('conv-tail'), JSON.stringify({ reservedSeq: 2 }));
      expect(seqs(await wl.readWorkLog('conv-tail'))).toEqual([1]);
      expect((await wl.appendWorkLog('conv-tail', { kind: 'notice', text: 'x' })).seq).toBe(3);
      expect(seqs(await wl.readWorkLog('conv-tail'))).toEqual([1, 3]); // on its own line after the dropped one
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
    // `attributed` (spec 12): written by a store that records who made each entry.
    expect(Object.keys(entry).sort()).toEqual(['attributed', 'kind', 'seq', 'text', 'ts']);
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

  it('after a restart continues above the reservation (a hole of up to one block), never below', async () => {
    await wl.appendWorkLog('conv-r', { kind: 'instruction', text: 'first' });
    await wl.appendWorkLog('conv-r', { kind: 'narration', text: 'second' });
    await wl.appendWorkLog('conv-r', { kind: 'final', text: 'third' });

    const restarted = await loadFresh();
    const next = await restarted.appendWorkLog('conv-r', { kind: 'instruction', text: 'after restart' });
    expect(next.seq).toBe(wl.WORK_LOG_SEQ_RESERVE_BLOCK + 1);
    expect(seqs(await restarted.readWorkLog('conv-r'))).toEqual([1, 2, 3, next.seq]);
  });

  it('a complete last entry that lost its newline is kept, and the next one starts on a fresh line', async () => {
    writeRaw('conv-nl', `${line(1)}${line(2).trimEnd()}`);
    fs.writeFileSync(sidecarFile('conv-nl'), JSON.stringify({ reservedSeq: 2 }));
    const next = await wl.appendWorkLog('conv-nl', { kind: 'narration', text: 'three' });
    expect(next.seq).toBe(3);
    expect(seqs(await wl.readWorkLog('conv-nl'))).toEqual([1, 2, 3]);
  });

  it('after a torn final line, the next entry starts on a fresh line above the reservation', async () => {
    writeRaw('conv-t', `${line(1, 'ok')}{"seq":2,"ts":2,"ki`);
    fs.writeFileSync(sidecarFile('conv-t'), JSON.stringify({ reservedSeq: 1000 }));

    const next = await wl.appendWorkLog('conv-t', { kind: 'narration', text: 'recovered' });
    expect(next.seq).toBe(1001);
    const page = await wl.readWorkLog('conv-t');
    expect(page.entries.map((e) => e.text)).toEqual(['ok', 'recovered']);
  });

  describe('failure handling', () => {
    it('a non-ENOENT seed error drops the append, caches nothing, and the next append seeds correctly', async () => {
      writeRaw('conv-s', `${line(1)}${line(2)}${line(3)}`);
      fs.writeFileSync(sidecarFile('conv-s'), JSON.stringify({ reservedSeq: 3 }));
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
      fs.writeFileSync(sidecarFile('conv-w'), JSON.stringify({ reservedSeq: 1000 }));
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
      expect(next.seq).toBe(3); // 2 burned (part of it is on disk)
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
      expect(seqs(await wl.readWorkLog('conv-q'))).toEqual([1, 3, 4]); // 2 burned
    });

    it('a new log whose first write failed burns seq 1 in-process, and a restart resumes above the reservation', async () => {
      failNextAppend('nothing-written');
      await expect(wl.appendWorkLog('conv-q0', { kind: 'narration', text: 'lost' })).rejects.toThrow('ENOSPC');
      const next = await wl.appendWorkLog('conv-q0', { kind: 'narration', text: 'kept' });
      expect(next.seq).toBe(2);
      expect(seqs(await wl.readWorkLog('conv-q0'))).toEqual([2]);

      // A fresh process has only the reservation (1..1000) as proof.
      const restarted = await loadFresh();
      const after = await restarted.appendWorkLog('conv-q0', { kind: 'narration', text: 'after restart' });
      expect(after.seq).toBe(wl.WORK_LOG_SEQ_RESERVE_BLOCK + 1);
      await restarted.flushWorkLog();
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

  describe('raw output (the full content behind a one-line entry, in <id>.raw.jsonl)', () => {
    const RAW_MAX = 256 * 1024;
    const SLOW = { timeout: 120_000 };

    function rawFile(id: string): string {
      return path.join(paths.dataDir, 'worklogs', `${id}.raw.jsonl`);
    }

    function storedLines(id: string): Array<Record<string, unknown>> {
      return fs
        .readFileSync(logFile(id), 'utf-8')
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l));
    }

    /** The raw-file record an entry's stored line points at. */
    function recordAt(id: string, stored: Record<string, unknown>): unknown {
      const bytes = fs.readFileSync(rawFile(id));
      const offset = stored.rawOffset as number;
      return JSON.parse(bytes.subarray(offset, offset + (stored.rawLen as number)).toString('utf-8'));
    }

    async function loggerWarn() {
      const { Logger } = await import('../../logger');
      return vi.spyOn(Logger.prototype, 'warn');
    }

    /** Fail the next write to `file` after it landed `keep` bytes. */
    function failNextWriteTo(file: string, keep: number): void {
      let armed = true;
      spyOpen((fh, args) => {
        if (!armed || String(args[0]) !== file) return;
        armed = false;
        const realWrite = fh.writeFile.bind(fh);
        (fh as { writeFile: unknown }).writeFile = async (data: string) => {
          await realWrite(String(data).slice(0, keep), 'utf-8');
          throw ioError('EIO');
        };
      });
    }

    it('exports the raw cap it enforces', () => {
      expect(wl.WORK_LOG_RAW_MAX_BYTES).toBe(RAW_MAX);
    });

    it('stores raw as a record in the raw file; the entry line points at it and stays small', async () => {
      const first = '{\n  "command": "ls -la"\n}\n한글 ✓ 😀\u0001';
      const second = 'total 0\n'.repeat(500);
      const a = await wl.appendWorkLog('conv-raw', { kind: 'tool', text: 'Bash ls', tool: 'Bash', raw: first });
      await wl.appendWorkLog('conv-raw', { kind: 'narration', text: 'no raw here' });
      const c = await wl.appendWorkLog('conv-raw', { kind: 'tool_result', text: 'Bash ok', tool: 'Bash', raw: second });

      const [la, lb, lc] = storedLines('conv-raw');
      expect(la).toMatchObject({ seq: 1, rawBytes: Buffer.byteLength(first), rawOffset: 0 });
      expect(la).not.toHaveProperty('raw');
      expect(lb).not.toHaveProperty('rawOffset');
      expect(lc.rawOffset).toBe((la.rawOffset as number) + (la.rawLen as number) + 1);
      expect(recordAt('conv-raw', la)).toEqual({ seq: 1, raw: first });
      expect(recordAt('conv-raw', lc)).toEqual({ seq: 3, raw: second });
      expect(fs.statSync(logFile('conv-raw')).size).toBeLessThan(1024);

      expect(await wl.readWorkLogRaw('conv-raw', a.seq)).toEqual({
        seq: 1,
        raw: first,
        rawBytes: Buffer.byteLength(first),
        rawTruncated: false,
      });
      expect(await wl.readWorkLogRaw('conv-raw', c.seq)).toMatchObject({ seq: 3, raw: second });
    });

    it('list pages, the appended callback and the resolved entry carry rawBytes, never raw or its position', async () => {
      const seen: unknown[] = [];
      wl.setOnWorkLogAppendedCallback((_id, e) => seen.push(e));
      const raw = 'total 0\n한글';
      const resolved = await wl.appendWorkLog('conv-pub', {
        kind: 'tool_result',
        text: 'Bash ok',
        tool: 'Bash',
        ok: true,
        raw,
      });
      await wl.appendWorkLog('conv-pub', { kind: 'narration', text: 'no raw here' });
      await wl.appendWorkLog('conv-pub', { kind: 'final', text: 'done' });

      expect(resolved).toEqual({
        seq: 1,
        ts: resolved.ts,
        kind: 'tool_result',
        text: 'Bash ok',
        tool: 'Bash',
        ok: true,
        attributed: true,
        rawBytes: Buffer.byteLength(raw),
      });
      expect(seen).toHaveLength(3);
      expect(seen[0]).toEqual(resolved);
      expect(seen[1]).not.toHaveProperty('rawBytes');

      // Every page path: latest window, the afterSeq fast path, and the binary
      // search + forward scan (limit 1 with more entries than the page).
      const latest = await wl.readWorkLog('conv-pub');
      const fast = await wl.readWorkLog('conv-pub', { afterSeq: 0 });
      const forward = await wl.readWorkLog('conv-pub', { afterSeq: 0, limit: 1 });
      expect(latest.entries[0]).toEqual(resolved);
      expect(fast.entries[0]).toEqual(resolved);
      expect(forward.entries).toEqual([resolved]);
      expect(latest.entries[1]).not.toHaveProperty('rawBytes');
      for (const e of [...seen, ...latest.entries, ...fast.entries, ...forward.entries]) {
        for (const key of ['raw', 'rawOffset', 'rawLen']) expect(e).not.toHaveProperty(key);
      }
    });

    it(
      'a heavy session (600 entries with 200 KiB raw each) still shows the full 500-entry latest window',
      SLOW,
      async () => {
        const raw = `${'r'.repeat(200 * 1024 - 1)}\n`;
        for (let i = 1; i <= 600; i++) {
          await wl.appendWorkLog('conv-heavy', { kind: 'tool_result', text: `Read ok #${i}`, tool: 'Read', raw });
        }

        const page = await wl.readWorkLog('conv-heavy');
        expect(page.entries).toHaveLength(500);
        expect(page.entries[0].seq).toBe(101);
        expect(page.entries[499]).toMatchObject({ seq: 600, rawBytes: 200 * 1024 });
        expect(page.hasMore).toBe(true);
        expect(await wl.readWorkLogRaw('conv-heavy', 1)).toMatchObject({ seq: 1, raw });
        expect(await wl.readWorkLogRaw('conv-heavy', 600)).toMatchObject({ seq: 600, raw });
      },
    );

    it('a 2 MB raw with control and multibyte characters is cut at the byte cap, on a character boundary', async () => {
      // 11 UTF-8 bytes per unit.
      const unit = 'a\u0001한😀\n"';
      const raw = unit.repeat(Math.ceil((2 * 1024 * 1024) / 11));
      const entry = await wl.appendWorkLog('conv-2mb', { kind: 'tool_result', text: 'Bash ok', tool: 'Bash', raw });

      expect(entry).toMatchObject({ seq: 1, rawBytes: Buffer.byteLength(raw), rawTruncated: true });
      expect(fs.statSync(logFile('conv-2mb')).size).toBeLessThan(1024);
      const got = await wl.readWorkLogRaw('conv-2mb', 1);
      expect(got).toMatchObject({ seq: 1, rawBytes: Buffer.byteLength(raw), rawTruncated: true });
      const kept = got && got !== 'budget' ? got.raw : '';
      expect(raw.startsWith(kept)).toBe(true);
      expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(RAW_MAX);
      expect(Buffer.byteLength(kept)).toBeGreaterThan(RAW_MAX - 4);
      const last = kept.charCodeAt(kept.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    });

    it('cuts exactly at the byte cap, never inside a surrogate pair', async () => {
      const exact = 'a'.repeat(RAW_MAX);
      const pair = `${'a'.repeat(RAW_MAX - 2)}😀tail`; // the emoji's 4 bytes would end 2 past the cap
      const a = await wl.appendWorkLog('conv-cut', { kind: 'tool_result', text: 'ok', raw: exact });
      const b = await wl.appendWorkLog('conv-cut', { kind: 'tool_result', text: 'ok', raw: `${exact}b` });
      const c = await wl.appendWorkLog('conv-cut', { kind: 'tool_result', text: 'ok', raw: pair });

      expect(a).not.toHaveProperty('rawTruncated');
      expect(await wl.readWorkLogRaw('conv-cut', a.seq)).toEqual({
        seq: a.seq,
        raw: exact,
        rawBytes: RAW_MAX,
        rawTruncated: false,
      });
      expect(await wl.readWorkLogRaw('conv-cut', b.seq)).toEqual({
        seq: b.seq,
        raw: exact,
        rawBytes: RAW_MAX + 1,
        rawTruncated: true,
      });
      expect(await wl.readWorkLogRaw('conv-cut', c.seq)).toMatchObject({ raw: 'a'.repeat(RAW_MAX - 2) });
    });

    it('an emitter-supplied rawBytes (raw already cut upstream) is the reported original size', async () => {
      const cut = await wl.appendWorkLog('conv-up', { kind: 'tool_result', text: 'ok', raw: 'abc', rawBytes: 5000 });
      expect(cut).toMatchObject({ rawBytes: 5000, rawTruncated: true });
      expect(await wl.readWorkLogRaw('conv-up', cut.seq)).toEqual({
        seq: cut.seq,
        raw: 'abc',
        rawBytes: 5000,
        rawTruncated: true,
      });
      // Smaller than what arrived, or not a byte count: ignored, the store measures.
      for (const rawBytes of [1, -1, 1.5, Number.NaN]) {
        const e = await wl.appendWorkLog('conv-up', { kind: 'tool_result', text: 'ok', raw: 'abc', rawBytes });
        expect(e.rawBytes).toBe(3);
        expect(e).not.toHaveProperty('rawTruncated');
      }
    });

    it('a text over 4000 characters with no raw keeps the full text as raw', async () => {
      const text = `${'n'.repeat(5000)} 끝`;
      const entry = await wl.appendWorkLog('conv-long', { kind: 'narration', text });
      expect(entry.text.length).toBe(wl.WORK_LOG_TEXT_MAX);
      expect(entry).toMatchObject({ rawBytes: Buffer.byteLength(text) });
      expect(entry).not.toHaveProperty('rawTruncated');
      expect(await wl.readWorkLogRaw('conv-long', entry.seq)).toEqual({
        seq: entry.seq,
        raw: text,
        rawBytes: Buffer.byteLength(text),
        rawTruncated: false,
      });

      // An explicit raw wins over the long text.
      const explicit = await wl.appendWorkLog('conv-long', { kind: 'tool', text: 'x'.repeat(5000), raw: 'input' });
      expect(await wl.readWorkLogRaw('conv-long', explicit.seq)).toMatchObject({ raw: 'input' });
      // A text within the cap has no raw.
      const short = await wl.appendWorkLog('conv-long', { kind: 'final', text: 'f'.repeat(4000) });
      expect(short).not.toHaveProperty('rawBytes');
      expect(await wl.readWorkLogRaw('conv-long', short.seq)).toBeNull();
    });

    it('readWorkLogRaw is null for an entry without raw (every pre-existing entry), an unknown seq or log, an unsafe id', async () => {
      writeRaw('conv-old', `${line(1)}${line(2)}`);
      expect(await wl.readWorkLogRaw('conv-old', 1)).toBeNull();
      expect(await wl.readWorkLogRaw('conv-old', 3)).toBeNull();
      expect(await wl.readWorkLogRaw('conv-old', 0)).toBeNull();
      expect(await wl.readWorkLogRaw('conv-old', 1.5)).toBeNull();
      expect(await wl.readWorkLogRaw('conv-none', 1)).toBeNull();
      expect(await wl.readWorkLogRaw('../escape', 1)).toBeNull();
    });

    it("waits for this process's pending write to the same log", async () => {
      const pending = wl.appendWorkLog('conv-wait', { kind: 'tool_result', text: 'ok', raw: 'just written' });
      expect(await wl.readWorkLogRaw('conv-wait', 1)).toMatchObject({ raw: 'just written' });
      await pending;
    });

    it('a failed raw write still publishes the entry, without raw; the next record starts on a fresh line', async () => {
      const seen: unknown[] = [];
      wl.setOnWorkLogAppendedCallback((_id, e) => seen.push(e));
      await wl.appendWorkLog('conv-rawfail', { kind: 'tool', text: 'first', raw: 'one' });
      const warn = await loggerWarn();
      failNextWriteTo(rawFile('conv-rawfail'), 9); // lands `{"seq":2,` then fails

      const lost = await wl.appendWorkLog('conv-rawfail', { kind: 'tool_result', text: 'Bash ok', raw: 'two' });
      expect(lost).toEqual({ seq: 2, ts: lost.ts, kind: 'tool_result', text: 'Bash ok', attributed: true });
      expect(seen[1]).toEqual(lost);
      expect(storedLines('conv-rawfail')[1]).toEqual({
        seq: 2,
        ts: lost.ts,
        kind: 'tool_result',
        text: 'Bash ok',
        attributed: true,
      });
      expect(await wl.readWorkLogRaw('conv-rawfail', 2)).toBeNull();
      expect(warn.mock.calls.filter(([m]) => String(m).includes('raw'))).toHaveLength(1);

      vi.restoreAllMocks();
      const next = await wl.appendWorkLog('conv-rawfail', { kind: 'tool_result', text: 'Bash ok', raw: 'three' });
      expect(await wl.readWorkLogRaw('conv-rawfail', next.seq)).toMatchObject({ raw: 'three' });
      expect(await wl.readWorkLogRaw('conv-rawfail', 1)).toMatchObject({ raw: 'one' });
      expect(fs.readFileSync(rawFile('conv-rawfail'), 'utf-8')).toContain('{"seq":2,\n{"seq":3,');
    });

    it.each([
      [
        'a record with another seq',
        (file: string) => {
          const text = fs.readFileSync(file, 'utf-8');
          fs.writeFileSync(file, text.replace('{"seq":1,', '{"seq":7,'));
        },
      ],
      ['a truncated raw file (short read)', (file: string) => fs.truncateSync(file, 10)],
      ['bytes that do not parse', (file: string) => fs.writeFileSync(file, 'x'.repeat(fs.statSync(file).size))],
      ['a missing raw file', (file: string) => fs.rmSync(file)],
    ])('%s at the recorded position reads as no raw, with one warn', async (_what, damage) => {
      await wl.appendWorkLog('conv-dmg', { kind: 'tool', text: 'Bash ls', raw: 'the input' });
      damage(rawFile('conv-dmg'));
      const warn = await loggerWarn();

      expect(await wl.readWorkLogRaw('conv-dmg', 1)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("'budget' when the scan cannot reach the entry within its budget, not null", async () => {
      const id = 'conv-budget';
      writeRaw(id, Array.from({ length: 50 }, (_, i) => line(i + 1)).join(''));
      appendRaw(id, Buffer.from('x\n'.repeat(4.5 * 1024 * 1024))); // 9 MB
      appendRaw(id, Array.from({ length: 10 }, (_, i) => line(51 + i)).join(''));
      appendRaw(id, Buffer.from('x\n'.repeat(1.5 * 1024 * 1024))); // 3 MB: wider than the backward fast path
      const warn = await loggerWarn();

      expect(await wl.readWorkLogRaw(id, 55)).toBe('budget');
      // One warn that names the raw lookup and the damage — not the list's "partial page".
      const messages = warn.mock.calls.map(([m]) => String(m));
      expect(messages).toEqual([expect.stringContaining('raw lookup')]);
      expect(messages[0]).toContain('damaged');
      expect(messages[0]).not.toContain('partial page');
      // Every retry gets the same answer: the junk stays and the log only grows at its tail.
      expect(await wl.readWorkLogRaw(id, 55)).toBe('budget');
      // An entry the scan does reach is answered (it has no raw).
      expect(await wl.readWorkLogRaw(id, 10)).toBeNull();
    });

    it('finds old, middle and recent entries in a log longer than the backward fast path', async () => {
      const id = 'conv-deep';
      const N = 12_000; // ~3.5 MB of entry lines
      const records: string[] = [];
      const lines: string[] = [];
      let offset = 0;
      for (let seq = 1; seq <= N; seq++) {
        const raw = `raw #${seq}`;
        const record = JSON.stringify({ seq, raw });
        const rawLen = Buffer.byteLength(record);
        lines.push(
          JSON.stringify({
            seq,
            ts: seq,
            kind: 'tool',
            text: `${'t'.repeat(200)} ${seq}`,
            rawBytes: raw.length,
            rawOffset: offset,
            rawLen,
          }),
        );
        records.push(record);
        offset += rawLen + 1;
      }
      writeRaw(id, `${lines.join('\n')}\n`);
      fs.writeFileSync(rawFile(id), `${records.join('\n')}\n`);
      expect(fs.statSync(logFile(id)).size).toBeGreaterThan(3 * 1024 * 1024);

      const counter = countReads();
      for (const seq of [1, 2, 5_000, N - 1, N]) {
        counter.bytes = 0;
        expect(await wl.readWorkLogRaw(id, seq)).toEqual({
          seq,
          raw: `raw #${seq}`,
          rawBytes: `raw #${seq}`.length,
          rawTruncated: false,
        });
        expect(counter.bytes).toBeLessThanOrEqual(wl.WORK_LOG_SCAN_BUDGET_BYTES);
      }
      expect(await wl.readWorkLogRaw(id, N + 1)).toBeNull();
    });

    it('a quarantine of the log leaves the raw file in place; new records append after the old ones', async () => {
      const id = 'conv-qraw';
      await wl.appendWorkLog(id, { kind: 'tool', text: 'before', raw: 'old record' });
      await wl.flushWorkLog();
      const before = fs.readFileSync(rawFile(id));
      appendRaw(id, Buffer.from('x\n'.repeat(4.5 * 1024 * 1024))); // 9 MB of junk: the next seed quarantines

      wl = await loadFresh();
      const next = await wl.appendWorkLog(id, { kind: 'tool', text: 'after', raw: 'new record' });
      const dir = fs.readdirSync(path.dirname(logFile(id)));
      expect(dir.filter((f) => f.startsWith(`${id}.jsonl.corrupt-`))).toHaveLength(1);
      const after = fs.readFileSync(rawFile(id));
      expect(after.subarray(0, before.length).equals(before)).toBe(true);
      expect(await wl.readWorkLogRaw(id, next.seq)).toMatchObject({ seq: next.seq, raw: 'new record' });
    });
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
      // Evicted: a fresh seed — reads the tail (newline/quarantine) and resumes at the reservation.
      expect((await wl.appendWorkLog(oldest, { kind: 'narration', text: 'y' })).seq).toBe(
        wl.WORK_LOG_SEQ_RESERVE_BLOCK + 1,
      );
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

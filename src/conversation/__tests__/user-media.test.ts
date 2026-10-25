/**
 * User media (SSOT 2026-10-25) — the store that keeps the files a user attached
 * to an instruction so the dashboard can show them.
 *
 *   M1  a downloaded file is copied before the turn's temp cleanup; the copy is
 *       served only once the user turn that lists it is saved (commit)
 *   M2  files the pipeline did not download keep metadata + https permalink
 *   M3  only this process's downloads (slack-file-* under a temp root) are read,
 *       never a symlink, never anything else
 *   M4  kind / MIME from the file name, then a short Slack-MIME allowlist
 *   M5  the card count, the turn lookups, unsafe ids
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/user-media-data-') };
});

import {
  classifyUserMedia,
  findSessionMedia,
  listSessionMedia,
  type UserMediaFile,
  UserMediaStore,
} from '../user-media';

const TMP = fs.realpathSync(os.tmpdir());

describe('UserMediaStore', () => {
  let root: string;
  let store: UserMediaStore;
  const made: string[] = [];

  function download(name: string, body: string | Buffer, dir = TMP): string {
    const p = path.join(dir, `slack-file-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
    fs.writeFileSync(p, body);
    made.push(p);
    return p;
  }
  function file(p: string, name: string, mimetype = '', extra: Partial<UserMediaFile> = {}): UserMediaFile {
    return { path: p, name, mimetype, size: fs.existsSync(p) ? fs.statSync(p).size : 0, ...extra };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(TMP, 'um-store-'));
    store = new UserMediaStore(path.join(root, 'store'));
  });
  afterEach(() => {
    for (const p of made.splice(0)) fs.rmSync(p, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('M1 — copies a download; the copy outlives the temp cleanup and is served after commit', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const src = download('login.png', png);
    const [a] = await store.capture('conv-1', [file(src, 'login.png', 'image/png', { slackFileId: 'F1' })]);
    expect(a).toMatchObject({
      name: 'login.png',
      kind: 'image',
      mime: 'image/png',
      size: png.length,
      stored: true,
      slackFileId: 'F1',
    });
    // Not served before the turn that lists it is saved.
    expect(store.contentPath('conv-1', a.id)).toBeNull();
    fs.rmSync(src); // FileHandler.cleanupTempFiles
    await store.commit('conv-1', [a]);
    const blob = store.contentPath('conv-1', a.id) as string;
    expect(blob).toBeTruthy();
    expect(fs.readFileSync(blob)).toEqual(png);
    // The stored file is named by the id only — never by the user's file name.
    expect(path.basename(blob)).toBe(a.id);
  });

  it('M1 — a capture whose turn never saved is swept once stale', async () => {
    const src = download('a.txt', 'hello');
    const [a] = await store.capture('conv-s', [file(src, 'a.txt', 'text/plain')]);
    const dir = path.join(root, 'store', 'conv-s');
    const pending = fs.readdirSync(dir).filter((n) => n.startsWith('.pending-'));
    expect(pending).toHaveLength(1);
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(dir, pending[0]), old, old);
    await store.capture('conv-s', []); // any later use of the directory sweeps
    await store.capture('conv-s', [file(download('b.txt', 'x'), 'b.txt')]);
    expect(fs.readdirSync(dir).some((n) => n === `.pending-${a.id}`)).toBe(false);
  });

  it('M2 — a file the pipeline did not download keeps metadata and an https permalink only', async () => {
    const [video, audio] = await store.capture('conv-2', [
      {
        path: '',
        name: 'demo.mov',
        mimetype: 'video/quicktime',
        size: 9_000_000,
        slackFileId: 'FV',
        permalink: 'https://x.slack.com/files/U/FV/demo.mov',
      },
      { path: '', name: 'memo.m4a', mimetype: 'audio/mp4', size: 3000, permalink: 'javascript:alert(1)' },
    ]);
    expect(video).toMatchObject({
      kind: 'video',
      stored: false,
      size: 9_000_000,
      permalink: 'https://x.slack.com/files/U/FV/demo.mov',
    });
    expect(audio.stored).toBe(false);
    expect(audio.permalink).toBeUndefined();
    await store.commit('conv-2', [video, audio]);
    expect(store.contentPath('conv-2', video.id)).toBeNull();
  });

  it('M3 — refuses a symlink, a file outside the temp roots, and a temp file the pipeline did not write', async () => {
    const target = download('real.png', 'PNG');
    const link = path.join(TMP, `slack-file-${Date.now()}-link.png`);
    fs.symlinkSync(target, link);
    made.push(link);
    const outside = path.join(process.cwd(), 'package.json');
    const foreign = path.join(TMP, `someone-else-${Date.now()}.png`);
    fs.writeFileSync(foreign, 'PNG');
    made.push(foreign);
    const list = await store.capture('conv-3', [
      file(link, 'link.png'),
      file(outside, 'package.json'),
      file(foreign, 'x.png'),
      file(`${TMP}/slack-file-1-../../etc/passwd`, 'passwd'),
    ]);
    expect(list.map((a) => a.stored)).toEqual([false, false, false, false]);
  });

  it('M4 — kind by name, then a Slack-MIME allowlist; html and svg are classified, never trusted', () => {
    expect(classifyUserMedia('a.PNG', '')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(classifyUserMedia('report.pdf', 'application/octet-stream')).toEqual({
      kind: 'pdf',
      mime: 'application/pdf',
    });
    expect(classifyUserMedia('image', 'image/png')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(classifyUserMedia('voice', 'audio/webm;codecs=opus')).toEqual({ kind: 'audio', mime: 'audio/webm' });
    expect(classifyUserMedia('blob', 'text/html')).toEqual({ kind: 'file', mime: 'application/octet-stream' });
    expect(classifyUserMedia('page.html', 'text/html').kind).toBe('html');
    expect(classifyUserMedia('x.svg', '').mime).toBe('image/svg+xml');
  });

  it('M4 — an explicit audio MIME wins over a video-looking extension (a browser voice note in .webm)', () => {
    expect(classifyUserMedia('voice.webm', 'audio/webm')).toEqual({ kind: 'audio', mime: 'audio/webm' });
    expect(classifyUserMedia('clip.webm', 'video/webm')).toEqual({ kind: 'video', mime: 'video/webm' });
  });

  it('M6 — bounded: past the deadline or the per-turn caps a file keeps its metadata, uncopied', async () => {
    const late = await store.capture('conv-6', [file(download('a.png', 'A'), 'a.png')], { deadlineMs: -1 });
    expect(late).toEqual([expect.objectContaining({ name: 'a.png', stored: false })]);
    // A copy that lands after its deadline removes itself — it is on no turn.
    await new Promise((r) => setTimeout(r, 200));
    const dir6 = path.join(root, 'store', 'conv-6');
    expect(fs.existsSync(dir6) ? fs.readdirSync(dir6).filter((n) => n.startsWith('.pending-')) : []).toEqual([]);
    const many = Array.from({ length: 22 }, (_, i) => file(download(`f${i}.txt`, 'x'), `f${i}.txt`));
    const out = await store.capture('conv-6b', many);
    expect(out).toHaveLength(22); // never dropped
    expect(out.filter((a) => a.stored)).toHaveLength(20);
  });

  it('M6 — a spent budget launches no I/O at all', async () => {
    const copy = vi.fn(async () => {});
    const bounded = new UserMediaStore(path.join(root, 'bounded'), { copy });
    const out = await bounded.capture('conv-b0', [file(download('a.png', 'A'), 'a.png')], { deadlineMs: -1 });
    expect(out.map((a) => a.stored)).toEqual([false]);
    expect(copy).not.toHaveBeenCalled();
  });

  it('M6 — slow copies cannot stack up past the deadline', async () => {
    const copy = vi.fn(
      (_src: string, dest: string) =>
        new Promise<void>((r) =>
          setTimeout(() => {
            // The test may have cleaned its directory by now: a late write must not throw.
            fs.promises.writeFile(dest, 'x').catch(() => {});
            r();
          }, 1000),
        ),
    );
    const bounded = new UserMediaStore(path.join(root, 'bounded'), { copy });
    const many = Array.from({ length: 10 }, (_, i) => file(download(`s${i}.png`, 'x'), `s${i}.png`));
    const out = await bounded.capture('conv-b1', many, { deadlineMs: 200 });
    expect(out.every((a) => !a.stored)).toBe(true);
    // One copy may start inside the budget; none may start after it (load-proof: at most one).
    expect(copy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('M6 — the byte cap counts every copy it launches, landed or not', async () => {
    const copy = vi.fn(async () => {
      throw new Error('disk full');
    });
    const bounded = new UserMediaStore(path.join(root, 'bounded'), { copy });
    const big = Array.from({ length: 5 }, (_, i) => {
      const p = download(`big${i}.bin`, '');
      fs.truncateSync(p, 50 * 1024 * 1024); // sparse: 50 MiB without writing it
      return file(p, `big${i}.bin`);
    });
    await bounded.capture('conv-b2', big, { deadlineMs: 10_000 });
    expect(copy).toHaveBeenCalledTimes(4); // 4 × 50 MiB = the 200 MiB turn cap
  });

  it('M2 — a download the pipeline gave up on (too large, failed) is kept with its reason', async () => {
    const [a] = await store.capture('conv-7', [
      { path: '', name: 'huge.png', mimetype: 'image/png', size: 60_000_000, unavailable: 'too_large' },
    ]);
    expect(a).toMatchObject({ name: 'huge.png', kind: 'image', stored: false, unavailable: 'too_large' });
  });

  it('M5 — counts the attachments the dashboard keeps for a conversation', async () => {
    expect(store.count('conv-5')).toBe(0);
    const atts = await store.capture('conv-5', [
      file(download('a.png', 'A'), 'a.png'),
      file(download('b.pdf', 'B'), 'b.pdf'),
      { path: '', name: 'c.mov', mimetype: 'video/quicktime', size: 1 },
    ]);
    expect(store.count('conv-5')).toBe(0); // not committed yet
    await store.commit('conv-5', atts);
    expect(store.count('conv-5')).toBe(3);
    // A fresh store (process restart) reads the same number back from disk.
    expect(new UserMediaStore(path.join(root, 'store')).count('conv-5')).toBe(3);
  });

  it('M5 — unsafe conversation or media ids are refused', async () => {
    expect(await store.capture('../x', [file(download('a.png', 'A'), 'a.png')])).toEqual([]);
    expect(store.contentPath('conv-1', '../index')).toBeNull();
    expect(store.count('../x')).toBe(0);
  });
});

describe('turn lookups', () => {
  const record = {
    id: 'c',
    turns: [
      {
        id: 't1',
        role: 'user',
        timestamp: 10,
        rawContent: 'a',
        attachments: [{ id: 'M1', name: 'a.png', kind: 'image', mime: 'image/png', size: 1, stored: true }],
      },
      { id: 't2', role: 'assistant', timestamp: 20, rawContent: 'b' },
      {
        id: 't3',
        role: 'user',
        timestamp: 30,
        rawContent: '',
        attachments: [{ id: 'M2', name: 'b.pdf', kind: 'pdf', mime: 'application/pdf', size: 2, stored: true }],
      },
    ],
  } as any;

  it('lists every attachment with the turn it came with, oldest first', () => {
    expect(listSessionMedia(record).map((m) => [m.id, m.turnId, m.turnTs])).toEqual([
      ['M1', 't1', 10],
      ['M2', 't3', 30],
    ]);
  });

  it('finds an attachment by id in user turns only', () => {
    expect(findSessionMedia(record, 'M2')?.name).toBe('b.pdf');
    expect(findSessionMedia(record, 'nope')).toBeUndefined();
    expect(findSessionMedia(null, 'M1')).toBeUndefined();
  });
});

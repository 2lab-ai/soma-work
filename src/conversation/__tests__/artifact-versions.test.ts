/**
 * #1074 — the same artifact uploaded again is its next version, not an unrelated new file.
 *
 *   T1  same session + same key (the model's artifact_key, else the file name without its time stamps)
 *   T2  re-uploaded → one entry, "version N · changed since the previous version"
 *   T3  the same content hash → no new version
 *   T6  the same bytes are stored once; a key keeps the bytes of its newest 10 versions;
 *       the board summary carries the version badge only, never the version list or hashes
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureArtifactFromWorkLog, resetArtifactCaptureForTests } from '../artifact-capture';
import { ArtifactStore, boardArtifact } from '../artifacts';

let root: string;
let srcDir: string;
let store: ArtifactStore;
let fid = 0;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function srcFile(name: string, body: string): string {
  const p = path.join(srcDir, name);
  fs.writeFileSync(p, body);
  return p;
}

function upload(cid: string, name: string, body: string, extra: Record<string, unknown> = {}) {
  return store.recordSlackUpload({
    conversationId: cid,
    filePath: srcFile(name, body),
    filename: name,
    slackFileId: `F${++fid}`,
    ...extra,
  });
}

function blobFiles(cid: string): string[] {
  return fs.readdirSync(path.join(root, 'store', cid)).filter((f) => !f.startsWith('.') && !f.startsWith('index.json'));
}

beforeEach(() => {
  root = fs.mkdtempSync('/tmp/artifact-versions-test-');
  srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir);
  store = new ArtifactStore(path.join(root, 'store'));
  resetArtifactCaptureForTests();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#1074 T1/T2 — the same key is the next version', () => {
  it('the same name re-sent with new content → version 2, changed since version 1', async () => {
    const v1 = await upload('c', 'report.html', '<h1>one</h1>', { now: 10 });
    const v2 = await upload('c', 'report.html', '<h1>two</h1>', { now: 20 });
    expect(v1).toMatchObject({ key: 'name:report.html', version: 1, sha256: sha('<h1>one</h1>') });
    expect(v1?.changed).toBeUndefined();
    expect(v2).toMatchObject({ key: 'name:report.html', version: 2, changed: true, previousId: v1?.id });
    expect(fs.readFileSync(store.blobPath('c', v1!.id)!, 'utf-8')).toBe('<h1>one</h1>');
    expect(fs.readFileSync(store.blobPath('c', v2!.id)!, 'utf-8')).toBe('<h1>two</h1>');
  });

  it('time-stamped names of one report are one artifact; another report is its own', async () => {
    await upload('c', 'html-weekly-20261109-100000.html', 'a', { now: 1 });
    const b = await upload('c', 'html-weekly-20261109-110000.html', 'b', { now: 2 });
    const other = await upload('c', 'html-monthly-20261109-110000.html', 'm', { now: 3 });
    expect(b).toMatchObject({ key: 'name:html-weekly.html', version: 2, changed: true });
    expect(other).toMatchObject({ key: 'name:html-monthly.html', version: 1 });
  });

  it("the model's artifact_key wins: different names under one key are one artifact", async () => {
    await upload('c', 'pr-1074-body-before.md', 'old body', { key: 'pr-1074-body', now: 1 });
    const v2 = await upload('c', 'pr-1074-body-after.md', 'new body', { key: 'pr-1074-body', now: 2 });
    expect(v2).toMatchObject({ key: 'key:pr-1074-body', version: 2, changed: true });
  });

  it('another session is another artifact, whatever the name', async () => {
    await upload('c1', 'report.html', 'a');
    expect(await upload('c2', 'report.html', 'b')).toMatchObject({ version: 1 });
  });
});

describe('#1074 T3 — the same content is not a new version', () => {
  it('records nothing new, keeps no new bytes, and still knows the Slack file (dedupe)', async () => {
    const seen: string[] = [];
    store.onRecorded((a) => seen.push(a.id));
    const v1 = await upload('c', 'report.html', 'same');
    const again = await store.recordSlackUpload({
      conversationId: 'c',
      filePath: srcFile('report.html', 'same'),
      filename: 'report.html',
      slackFileId: 'F-again',
    });
    expect(again).toBeNull();
    expect(store.list('c').map((a) => a.id)).toEqual([v1?.id]);
    expect(blobFiles('c')).toEqual([v1?.id]);
    expect(seen).toEqual([v1?.id]);
    // The re-send's Slack file is known: a backfill reading it later records nothing either.
    await store.recordSlackUpload({ conversationId: 'c', filename: 'report.html', slackFileId: 'F-again', size: 4 });
    expect(store.list('c')).toHaveLength(1);
  });
});

describe('#1074 T6 — bytes on disk', () => {
  it('the same bytes are stored once: a version that returns to older content shares its copy', async () => {
    const v1 = await upload('c', 'r.html', 'A', { now: 1 });
    await upload('c', 'r.html', 'B', { now: 2 });
    const v3 = await upload('c', 'r.html', 'A', { now: 3 });
    expect(v3).toMatchObject({ version: 3, changed: true, stored: true });
    expect(fs.readFileSync(store.blobPath('c', v3!.id)!, 'utf-8')).toBe('A');
    expect(blobFiles('c')).toHaveLength(2);
    expect(store.blobPath('c', v3!.id)).toBe(store.blobPath('c', v1!.id));
  });

  it('a key keeps the bytes of its newest 10 versions; older ones keep their row and Slack link', async () => {
    const all = [];
    for (let i = 1; i <= 12; i++)
      all.push(await upload('c', 'r.html', `v${i}`, { now: i, permalink: `https://s/${i}` }));
    const rows = store.versions('c', all[11]!.id);
    expect(rows.map((a) => a.version)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(rows.filter((a) => a.stored)).toHaveLength(10);
    expect(rows.slice(10).map((a) => [a.version, a.stored, a.permalink])).toEqual([
      [2, false, 'https://s/2'],
      [1, false, 'https://s/1'],
    ]);
    expect(blobFiles('c')).toHaveLength(10);
    expect(store.blobPath('c', all[0]!.id)).toBeNull();
  });

  it('a pruned copy another version still points at stays on disk', async () => {
    const first = await upload('c', 'r.html', 'SHARED', { now: 0 });
    for (let i = 1; i <= 9; i++) await upload('c', 'r.html', `v${i}`, { now: i });
    const back = await upload('c', 'r.html', 'SHARED', { now: 100 }); // version 11: v1 drops past the cap
    expect(store.blobPath('c', first!.id)).toBeNull();
    expect(fs.readFileSync(store.blobPath('c', back!.id)!, 'utf-8')).toBe('SHARED');
  });
});

describe('#1074 T6 — what the board carries', () => {
  it('one entry per artifact (its latest version) with the version badge, never hashes or the version list', async () => {
    await upload('c', 'report.html', 'one', { now: 1 });
    await upload('c', 'chart.png', 'png', { now: 2 });
    await upload('c', 'report.html', 'two', { now: 3 });
    const s = store.summary('c')!;
    expect(s.count).toBe(2);
    expect(s.recent.map((a) => [a.name, a.version, a.changed])).toEqual([
      ['report.html', 2, true],
      ['chart.png', 1, undefined],
    ]);
    for (const a of s.recent) {
      expect(a).not.toHaveProperty('sha256');
      expect(a).not.toHaveProperty('previousId');
      expect(a).not.toHaveProperty('blob');
      expect(a).not.toHaveProperty('resentFileIds');
    }
    const live = await upload('c', 'report.html', 'three', { now: 4 });
    expect(Object.keys(boardArtifact(live!))).not.toContain('sha256');
  });

  it('the session list still has every version (the turn that made each one shows it)', async () => {
    await upload('c', 'report.html', 'one', { now: 1 });
    await upload('c', 'report.html', 'two', { now: 2 });
    expect(store.list('c').map((a) => a.version)).toEqual([2, 1]);
  });
});

describe('#1074 — rows recorded before versions existed', () => {
  it('get keys and versions on load, so the next upload continues them', async () => {
    const dir = path.join(root, 'store', 'old');
    fs.mkdirSync(dir, { recursive: true });
    const row = (id: string, name: string, createdAt: number) => ({
      id,
      conversationId: 'old',
      kind: 'html',
      name,
      mime: 'text/html',
      size: 1,
      createdAt,
      source: 'slack_upload',
      stored: false,
      slackFileId: id,
    });
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({
        version: 1,
        backfilled: true,
        artifacts: [row('A', 'html-r-20261101-100000.html', 1), row('B', 'html-r-20261102-100000.html', 2)],
      }),
    );
    expect(store.summary('old')).toMatchObject({ count: 1 });
    const next = await upload('old', 'html-r-20261103-100000.html', 'x', { now: 3 });
    expect(next).toMatchObject({ version: 3, previousId: 'B' });
    expect(next?.changed).toBeUndefined(); // no hash on record for version 2
  });
});

describe('#1074 — capture carries the key and the hash from slack-mcp', () => {
  it('artifact_key from the call, sha256 from the reply when no copy is kept', async () => {
    const tu = 'tu_k';
    await captureArtifactFromWorkLog(
      'c',
      {
        kind: 'tool',
        tool: 'mcp__slack-mcp__send_file',
        toolUseId: tu,
        text: 'send_file',
        raw: JSON.stringify({ file_path: path.join(srcDir, 'gone.md'), artifact_key: 'pr-9-body' }),
      },
      store,
    );
    await captureArtifactFromWorkLog(
      'c',
      {
        kind: 'tool_result',
        tool: 'mcp__slack-mcp__send_file',
        toolUseId: tu,
        ok: true,
        text: 'ok',
        raw: JSON.stringify({ uploaded: true, file_id: 'FK', filename: 'gone.md', size: 3, sha256: sha('abc') }),
      },
      store,
    );
    expect(store.list('c')[0]).toMatchObject({ key: 'key:pr-9-body', version: 1, sha256: sha('abc'), stored: false });
  });
});

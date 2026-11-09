/**
 * #1074 review gate (r1) — slack-mcp's announced version is the version the daemon records.
 *
 * The slack-mcp helper plans an upload against the session's index file; the reply then goes through the
 * daemon's capture into the store, which writes that same index. Three uploads end to end, with and without
 * the model's artifact_key: every reply's version equals the stored row's version.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// slack-mcp's half (what the upload says) is the shared module the MCP server re-exports.
import { planUploadVersion, versionFields } from 'somalib/artifacts/upload-version';
import { captureArtifactFromWorkLog, resetArtifactCaptureForTests } from '../artifact-capture';
import { ArtifactStore } from '../artifacts';

let root: string;
let store: ArtifactStore;
let n = 0;

beforeEach(() => {
  root = fs.mkdtempSync('/tmp/artifact-versions-e2e-');
  store = new ArtifactStore(path.join(root, 'store'));
  resetArtifactCaptureForTests();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** One send_file: the helper's plan (what Slack is told), then the call and its reply through capture. */
async function send(cid: string, name: string, body: string, artifactKey?: string) {
  const file = path.join(root, `${++n}-${name}`);
  fs.writeFileSync(file, body);
  const plan = await planUploadVersion({
    indexPath: store.indexFile(cid) ?? undefined,
    filePath: file,
    displayName: name,
    artifactKey,
    lang: 'ko',
  });
  const tu = `tu_${n}`;
  await captureArtifactFromWorkLog(
    cid,
    {
      kind: 'tool',
      tool: 'mcp__slack-mcp__send_file',
      toolUseId: tu,
      text: 'send_file',
      raw: JSON.stringify({ file_path: file, filename: name, ...(artifactKey ? { artifact_key: artifactKey } : {}) }),
    },
    store,
  );
  await captureArtifactFromWorkLog(
    cid,
    {
      kind: 'tool_result',
      tool: 'mcp__slack-mcp__send_file',
      toolUseId: tu,
      ok: true,
      text: 'ok',
      raw: JSON.stringify({
        uploaded: true,
        file_id: `F${n}`,
        filename: name,
        size: Buffer.byteLength(body),
        ...versionFields(plan), // exactly what slack-mcp replies with
      }),
    },
    store,
  );
  return plan;
}

describe('#1074 r1 — the version slack-mcp announces is the version the store records', () => {
  it('no artifact_key: three uploads of one report → versions 1, 2, 3 on both sides', async () => {
    const said = [
      await send('c', 'html-r-20261109-100000.html', 'one'),
      await send('c', 'html-r-20261109-110000.html', 'two'),
      await send('c', 'html-r-20261109-120000.html', 'three'),
    ];
    expect(said.map((p) => p?.version)).toEqual([1, 2, 3]);
    expect(said.map((p) => p?.note)).toEqual(['', '판 2 · 이전 판 이후 바뀜', '판 3 · 이전 판 이후 바뀜']);
    const rows = store.list('c');
    expect(rows.map((a) => [a.key, a.version])).toEqual([
      ['name:html-r.html', 3],
      ['name:html-r.html', 2],
      ['name:html-r.html', 1],
    ]);
  });

  it('with artifact_key, and an unchanged re-send in between', async () => {
    const a = await send('c', 'pr-9-body-a.md', 'body one', 'pr-9-body');
    const same = await send('c', 'pr-9-body-b.md', 'body one', 'pr-9-body');
    const b = await send('c', 'pr-9-body-c.md', 'body two', 'pr-9-body');
    expect([a?.version, same?.version, same?.changed, b?.version]).toEqual([1, 1, false, 2]);
    expect(store.list('c').map((r) => [r.key, r.version])).toEqual([
      ['key:pr-9-body', 2],
      ['key:pr-9-body', 1],
    ]);
    expect(createHash('sha256').update('body two').digest('hex')).toBe(b?.sha256);
  });
});

describe('#1074 review gate r2 — the store records uploads in the order their results arrived', () => {
  it('a slow snapshot of the first upload does not let the second become the earlier version', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    class SlowFirst extends ArtifactStore {
      async snapshot(cid: string, file: string | undefined) {
        const snap = await super.snapshot(cid, file);
        if (file?.includes('first')) await gate;
        return snap;
      }
    }
    store = new SlowFirst(path.join(root, 'store-slow'));
    const a = path.join(root, 'first-r.html');
    const b = path.join(root, 'second-r.html');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'B');
    const call = (id: string, file: string) => ({
      kind: 'tool',
      tool: 'mcp__slack-mcp__send_file',
      toolUseId: id,
      text: 'send_file',
      raw: JSON.stringify({ file_path: file, filename: 'r.html' }),
    });
    const result = (id: string, fileId: string) => ({
      kind: 'tool_result',
      tool: 'mcp__slack-mcp__send_file',
      toolUseId: id,
      ok: true,
      text: 'ok',
      raw: JSON.stringify({ uploaded: true, file_id: fileId, filename: 'r.html', size: 1 }),
    });
    void captureArtifactFromWorkLog('c', call('tu_a', a), store);
    const ra = captureArtifactFromWorkLog('c', result('tu_a', 'FA'), store);
    void captureArtifactFromWorkLog('c', call('tu_b', b), store);
    const rb = captureArtifactFromWorkLog('c', result('tu_b', 'FB'), store);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([ra, rb]);
    expect(store.list('c').map((r) => [r.slackFileId, r.version])).toEqual([
      ['FB', 2],
      ['FA', 1],
    ]);
  });
});

/**
 * #1074 T2/T3 — slack-mcp says the version in the upload itself.
 *
 * send_file / send_media take an optional `artifact_key`. Before the upload, the server reads the
 * session's artifact index (SOMA_ARTIFACT_INDEX, written by the daemon) and applies the daemon's own
 * rule (the shared artifact-version module): the comment posted with the file and the tool's
 * result say "version N · changed since the previous version", or "no changes".
 */

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commentWithVersion,
  planUploadVersion,
  readArtifactRows,
  UploadVersions,
  versionFields,
} from './helpers/artifact-version.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let dir: string;
let index: string;

async function file(name: string, body: string): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, body);
  return p;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join('/tmp', 'slack-mcp-version-'));
  index = path.join(dir, 'index.json');
  await fs.writeFile(
    index,
    JSON.stringify({
      version: 1,
      artifacts: [
        {
          id: 'A',
          name: 'html-weekly-20261109-100000.html',
          key: 'name:html-weekly.html',
          version: 1,
          sha256: sha('one'),
        },
        { id: 'B', name: 'notes.md', sha256: sha('n') }, // recorded before versions: key and version come from the rule
        { id: 'C', name: 'old.md', source: 'final_answer' },
      ],
    }),
  );
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('#1074 — the version an upload is, said before it is sent', () => {
  it('new content under a known name → version 2, changed (Korean and English comment)', async () => {
    const p = await file('html-weekly-20261109-120000.html', 'two');
    const v = await planUploadVersion({ indexPath: index, filePath: p, displayName: path.basename(p), lang: 'ko' });
    expect(v).toMatchObject({
      artifact_key: 'name:html-weekly.html',
      version: 2,
      changed: true,
      previous_version: 1,
      sha256: sha('two'),
      note: '판 2 · 이전 판 이후 바뀜',
    });
    const en = await planUploadVersion({ indexPath: index, filePath: p, displayName: path.basename(p), lang: 'en' });
    expect(en?.note).toBe('Version 2 · changed since the previous version');
  });

  it('the same content as the latest version → "no changes", the version stays', async () => {
    const p = await file('html-weekly-20261109-130000.html', 'one');
    const v = await planUploadVersion({ indexPath: index, filePath: p, displayName: path.basename(p), lang: 'ko' });
    expect(v).toMatchObject({ version: 1, changed: false, previous_version: 1, note: '판 1 · 바뀐 것 없음' });
  });

  it("the model's artifact_key wins over the name; a first version says nothing in the comment", async () => {
    const p = await file('html-weekly-20261109-140000.html', 'three');
    const v = await planUploadVersion({
      indexPath: index,
      filePath: p,
      displayName: path.basename(p),
      artifactKey: 'pr-1074-body',
      lang: 'ko',
    });
    expect(v).toMatchObject({
      artifact_key: 'key:pr-1074-body',
      version: 1,
      changed: null,
      previous_version: null,
      note: '',
    });
  });

  it('rows recorded before versions existed still count as version 1', async () => {
    const p = await file('notes.md', 'n2');
    const v = await planUploadVersion({ indexPath: index, filePath: p, displayName: 'notes.md', lang: 'ko' });
    expect(v).toMatchObject({ version: 2, changed: true });
    expect(readArtifactRows(index).find((r) => r.id === 'C')?.key).toBeUndefined();
  });

  it('no index configured → no version claim at all; a missing index file is a first upload', async () => {
    const p = await file('x.html', 'x');
    expect(await planUploadVersion({ filePath: p, displayName: 'x.html', lang: 'ko' })).toBeNull();
    const first = await planUploadVersion({
      indexPath: path.join(dir, 'nope', 'index.json'),
      filePath: p,
      displayName: 'x.html',
      lang: 'ko',
    });
    expect(first).toMatchObject({ version: 1, changed: null, note: '' });
  });

  it('a damaged index falls back to its .bak', async () => {
    const d = path.join(dir, 'damaged');
    await fs.mkdir(d);
    await fs.writeFile(path.join(d, 'index.json'), '{not json');
    await fs.writeFile(
      path.join(d, 'index.json.bak'),
      JSON.stringify({ artifacts: [{ id: 'Z', name: 'r.html', key: 'name:r.html', version: 4, sha256: sha('z') }] }),
    );
    const p = await file('r.html', 'z2');
    const v = await planUploadVersion({
      indexPath: path.join(d, 'index.json'),
      filePath: p,
      displayName: 'r.html',
      lang: 'ko',
    });
    expect(v).toMatchObject({ version: 5, changed: true });
  });

  it('the note goes first in the comment posted with the file', () => {
    expect(commentWithVersion('판 2 · 이전 판 이후 바뀜', 'live: http://x')).toBe(
      '판 2 · 이전 판 이후 바뀜\nlive: http://x',
    );
    expect(commentWithVersion('판 2 · 이전 판 이후 바뀜', undefined)).toBe('판 2 · 이전 판 이후 바뀜');
    expect(commentWithVersion('', 'live')).toBe('live');
    expect(commentWithVersion('', undefined)).toBeUndefined();
  });
});

describe('#1074 r1 — uploads this process made count before the daemon has recorded them', () => {
  it('two uploads of one key at once: serialized, the second plans against the first (2 then 3)', async () => {
    const versions = new UploadVersions();
    const order: string[] = [];
    const one = await file('html-weekly-20261109-150000.html', 'p1');
    const two = await file('html-weekly-20261109-150001.html', 'p2');
    const upload = (p: string, tag: string) =>
      versions.serialize('name:html-weekly.html', async () => {
        const v = await planUploadVersion({
          indexPath: index,
          filePath: p,
          displayName: path.basename(p),
          lang: 'ko',
          sent: versions.sent(),
        });
        order.push(`${tag}:plan`);
        await new Promise((r) => setTimeout(r, 20));
        if (v && v.changed !== false) versions.remember(`F-${tag}`, v);
        order.push(`${tag}:done`);
        return v;
      });
    const [a, b] = await Promise.all([upload(one, 'a'), upload(two, 'b')]);
    expect(order).toEqual(['a:plan', 'a:done', 'b:plan', 'b:done']);
    expect([a?.version, a?.note, b?.version, b?.note]).toEqual([
      2,
      '판 2 · 이전 판 이후 바뀜',
      3,
      '판 3 · 이전 판 이후 바뀜',
    ]);
  });

  it('a sent upload the daemon has since recorded is not counted twice (the index wins)', async () => {
    const d = path.join(dir, 'recorded');
    await fs.mkdir(d);
    await fs.writeFile(
      path.join(d, 'index.json'),
      JSON.stringify({
        artifacts: [{ id: 'X', name: 'r.html', slackFileId: 'FX', key: 'name:r.html', version: 1, sha256: sha('old') }],
      }),
    );
    const p = await file('r.html', 'new');
    // This process remembers FX as version 2 (say it raced); the index lists FX as version 1 — the index wins.
    const sent = [{ id: 'FX', slackFileId: 'FX', key: 'name:r.html', version: 2, sha256: sha('old') }];
    const v = await planUploadVersion({
      indexPath: path.join(d, 'index.json'),
      filePath: p,
      displayName: 'r.html',
      lang: 'ko',
      sent,
    });
    expect(v?.version).toBe(2);
    const unseen = [{ id: 'FY', slackFileId: 'FY', key: 'name:r.html', version: 2, sha256: sha('mid') }];
    const w = await planUploadVersion({
      indexPath: path.join(d, 'index.json'),
      filePath: p,
      displayName: 'r.html',
      lang: 'ko',
      sent: unseen,
    });
    expect(w?.version).toBe(3);
  });

  it('names over 200 characters are cut as the daemon cuts them', async () => {
    const long = `${'x'.repeat(220)}.md`;
    const p = await file('long.md', 'L');
    const v = await planUploadVersion({ indexPath: index, filePath: p, displayName: long, lang: 'ko' });
    expect(v?.artifact_key).toBe(`name:${long.slice(0, 200)}`);
  });

  it("the reply names the derived key version_key; artifact_key is only ever the model's own", () => {
    const fields = versionFields({
      artifact_key: 'name:r.html',
      version: 2,
      changed: true,
      previous_version: 1,
      sha256: 'a'.repeat(64),
      note: 'x',
    });
    expect(fields).toEqual({
      version_key: 'name:r.html',
      version: 2,
      changed: true,
      previous_version: 1,
      sha256: 'a'.repeat(64),
    });
  });
});

describe('#1074 — the tools take artifact_key and reply with the version', () => {
  it('send_file and send_media declare artifact_key; both replies carry the version fields', async () => {
    const src = await fs.readFile(path.resolve(__dirname, 'slack-mcp-server.ts'), 'utf-8');
    const sendFile = src.slice(src.indexOf("name: 'send_file'"), src.indexOf("name: 'send_media'"));
    const sendMedia = src.slice(src.indexOf("name: 'send_media'"), src.indexOf('async handleTool'));
    expect(sendFile).toContain('artifact_key');
    expect(sendMedia).toContain('artifact_key');
    expect(src.match(/\.\.\.versionFields\(version\)/g)?.length).toBe(2);
    expect(src.match(/await this\.uploadVersioned\(/g)?.length).toBe(2);
    expect(src).toContain('this.uploadVersions.serialize(uploadKey(displayName, artifactKey)');
    expect(src).toContain('SOMA_ARTIFACT_INDEX');
  });
});

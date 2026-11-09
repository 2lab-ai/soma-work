/**
 * SSOT 2026-11-09 — links are session artifacts too.
 *
 *   T3  a URL the session serves (a local page or app) or publishes (YouTube, a release asset) is posted to the
 *       thread with slack-mcp `send_link` and listed in the dashboard's 산출물; clicking it opens the URL
 *   T2  video and audio sent with send_media are listed and playable (kinds already classified)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backfillArtifactsFromWorkLog,
  type CaptureEntry,
  captureArtifactFromWorkLog,
  resetArtifactCaptureForTests,
  type WorkLogReader,
} from '../artifact-capture';
import { ArtifactStore, classifyArtifact, normalizeArtifactUrl } from '../artifacts';

let root: string;
let store: ArtifactStore;

beforeEach(() => {
  root = fs.mkdtempSync('/tmp/artifact-links-test-');
  store = new ArtifactStore(path.join(root, 'store'));
  resetArtifactCaptureForTests();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const TURN = 'C1:t1:1792733000000:uuid-1';
const call = (input: Record<string, unknown>, toolUseId = 'tu_l'): CaptureEntry => ({
  kind: 'tool',
  tool: 'mcp__slack-mcp__send_link',
  toolUseId,
  turnId: TURN,
  text: 'send_link',
  raw: JSON.stringify(input),
});
const reply = (body: Record<string, unknown>, toolUseId = 'tu_l', ok = true): CaptureEntry => ({
  kind: 'tool_result',
  tool: 'mcp__slack-mcp__send_link',
  toolUseId,
  turnId: TURN,
  ok,
  text: 'send_link ok',
  raw: JSON.stringify(body),
});

describe('T3 — a link the session served or published is an artifact', () => {
  it('records a link: kind link, the URL, no stored copy, the Slack message it was posted in', async () => {
    const a = await store.recordLink({
      conversationId: 'conv-1',
      url: 'http://192.168.0.10:8763/html-report-20261109.html',
      title: '보고서 (로컬 서빙)',
      messageTs: '1794212800.000100',
      permalink: 'https://example.slack.com/archives/C1/p1794212800000100',
      tool: 'send_link',
      turnId: TURN,
      now: 7,
    });
    expect(a).toMatchObject({
      kind: 'link',
      url: 'http://192.168.0.10:8763/html-report-20261109.html',
      name: '보고서 (로컬 서빙)',
      stored: false,
      size: 0,
      source: 'slack_link',
      permalink: 'https://example.slack.com/archives/C1/p1794212800000100',
      turnStartedAt: 1792733000000,
    });
    expect(store.list('conv-1')).toHaveLength(1);
    expect(store.summary('conv-1')).toMatchObject({ count: 1 });
    // Nothing to serve: the dashboard opens the URL itself.
    expect(store.blobPath('conv-1', a!.id)).toBeNull();
  });

  it('names an untitled link by its host and path', async () => {
    const a = await store.recordLink({ conversationId: 'c', url: 'https://youtu.be/rxkAcSqCG2Y', messageTs: '1.1' });
    expect(a?.name).toBe('youtu.be/rxkAcSqCG2Y');
  });

  it('the same Slack message is recorded once', async () => {
    await store.recordLink({ conversationId: 'c', url: 'https://a.example/x', messageTs: '1.1' });
    expect(await store.recordLink({ conversationId: 'c', url: 'https://a.example/x', messageTs: '1.1' })).toBeNull();
    expect(store.list('c')).toHaveLength(1);
  });

  it.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['data:text/html,<b>x</b>'],
    ['https://user:secret@example.com/'],
    ['not a url'],
    [''],
  ])('never records a link that is not a plain http(s) URL: %s', async (url) => {
    expect(await store.recordLink({ conversationId: 'c', url, messageTs: '2.2' })).toBeNull();
    expect(store.list('c')).toEqual([]);
  });

  it('normalizeArtifactUrl keeps http(s) only, without credentials, at most 2000 chars', () => {
    expect(normalizeArtifactUrl('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(normalizeArtifactUrl(' https://youtu.be/x ')).toBe('https://youtu.be/x');
    expect(normalizeArtifactUrl('ftp://host/x')).toBeNull();
    expect(normalizeArtifactUrl(`https://a.example/${'x'.repeat(2100)}`)).toBeNull();
  });
});

describe('T3 — captured from the work-log stream (send_link call + result)', () => {
  it('send_link call + result → a link artifact tagged with its turn', async () => {
    await captureArtifactFromWorkLog('conv-2', call({ url: 'http://localhost:3000/', title: '데모 앱' }), store);
    await captureArtifactFromWorkLog(
      'conv-2',
      reply({
        sent: true,
        url: 'http://localhost:3000/',
        title: '데모 앱',
        ts: '1794212800.000200',
        permalink: 'https://s/p',
      }),
      store,
    );
    const [a] = store.list('conv-2');
    expect(a).toMatchObject({
      kind: 'link',
      name: '데모 앱',
      url: 'http://localhost:3000/',
      tool: 'send_link',
      turnId: TURN,
      permalink: 'https://s/p',
    });
  });

  it('a failed send_link records nothing', async () => {
    await captureArtifactFromWorkLog('conv-3', call({ url: 'http://localhost:3000/' }, 'tu_x'), store);
    await captureArtifactFromWorkLog('conv-3', reply({ error: 'boom' }, 'tu_x', false), store);
    expect(store.list('conv-3')).toEqual([]);
  });

  it('backfill lists a past send_link once', async () => {
    const entries: CaptureEntry[] = [
      { ...call({ url: 'https://youtu.be/abc' }), toolUseId: undefined },
      { ...reply({ sent: true, url: 'https://youtu.be/abc', ts: '9.9' }), toolUseId: undefined },
    ];
    const stored = entries.map((e, i) => ({
      entry: { seq: i + 1, ts: 1000 + i, ...e, raw: undefined, rawBytes: e.raw!.length },
      raw: e.raw!,
    }));
    const reader: WorkLogReader = {
      readWorkLog: async (_cid, opts) => {
        const after = opts.afterSeq ?? 0;
        const page = stored.filter((s) => s.entry.seq > after);
        return { entries: page.map((s) => s.entry), hasMore: false };
      },
      readWorkLogRaw: async (_cid, seq) => {
        const hit = stored.find((s) => s.entry.seq === seq);
        return hit ? { raw: hit.raw } : null;
      },
    };
    await backfillArtifactsFromWorkLog('conv-4', store, reader);
    await backfillArtifactsFromWorkLog('conv-4', store, reader);
    expect(store.list('conv-4').map((a) => [a.kind, a.url])).toEqual([['link', 'https://youtu.be/abc']]);
  });
});

describe('T2 — video and audio are artifacts the dashboard can play', () => {
  it.each([
    ['launch.mp4', 'video'],
    ['clip.webm', 'video'],
    ['score.wav', 'audio'],
    ['narration.m4a', 'audio'],
    ['theme.mp3', 'audio'],
  ])('%s → %s', (name, kind) => {
    expect(classifyArtifact(name).kind).toBe(kind);
  });
});

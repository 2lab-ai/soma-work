/**
 * SSOT 2026-10-23 — dashboard artifacts, server half.
 *
 *   T1  the model's markdown final answers and the html/png it sends mid-turn are recorded per session
 *   T7  every file sent to Slack is listed — even one whose bytes could not be kept
 *   T8  html / png / wav are classified so the viewer can show or play them
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
import { ArtifactStore, answerExcerpt, classifyArtifact, isMarkdownAnswer } from '../artifacts';

let root: string;
let srcDir: string;
let store: ArtifactStore;

function srcFile(name: string, body: string | Buffer): string {
  const p = path.join(srcDir, name);
  fs.writeFileSync(p, body);
  return p;
}

beforeEach(() => {
  // Under /tmp on purpose: uploads (and so snapshots) are only ever read from /tmp.
  root = fs.mkdtempSync('/tmp/artifacts-test-');
  srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir);
  store = new ArtifactStore(path.join(root, 'store'));
  resetArtifactCaptureForTests();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('T8 — kinds the viewer can show or play', () => {
  it.each([
    ['report.html', 'html', 'text/html'],
    ['chart.png', 'image', 'image/png'],
    ['photo.JPG', 'image', 'image/jpeg'],
    ['voice.wav', 'audio', 'audio/wav'],
    ['tts.mp3', 'audio', 'audio/mpeg'],
    ['clip.mp4', 'video', 'video/mp4'],
    ['notes.md', 'markdown', 'text/markdown'],
    ['spec.pdf', 'pdf', 'application/pdf'],
    ['run.log', 'text', 'text/plain'],
    ['bundle.zip', 'file', 'application/octet-stream'],
  ])('%s → %s', (name, kind, mime) => {
    expect(classifyArtifact(name)).toEqual({ kind, mime });
  });
});

describe('T1 — markdown final answers', () => {
  it('counts block structure (heading, list, table, fence, quote) as markdown', () => {
    expect(isMarkdownAnswer('## 결과\n\n배포가 끝났습니다. 다음 단계를 확인하세요.')).toBe(true);
    expect(isMarkdownAnswer('변경 사항은 다음과 같습니다:\n- 라우트 추가\n- 테스트 추가')).toBe(true);
    expect(isMarkdownAnswer('| a | b |\n|---|---|\n| 1 | 2 |\n이 표가 전체 결과 요약입니다.')).toBe(true);
    expect(isMarkdownAnswer('코드는 아래와 같습니다.\n```ts\nconst a = 1;\n```')).toBe(true);
  });

  it('leaves a plain one-paragraph reply alone', () => {
    expect(isMarkdownAnswer('네, 확인했습니다. 지금 바로 진행하겠습니다. 끝나면 알려드릴게요.')).toBe(false);
    expect(isMarkdownAnswer('## 짧음')).toBe(false);
  });

  it('excerpt is the first heading, stripped of marks', () => {
    expect(answerExcerpt('intro line\n## **배포** 결과\n- a')).toBe('배포 결과');
    expect(answerExcerpt('- [링크](https://x.y) 하나\n- 둘')).toBe('링크 하나');
  });

  it('records a markdown answer once per turn and stores its text', async () => {
    const md = '## 요약\n- 라우트를 추가했습니다\n- 테스트를 추가했습니다';
    const a = await store.recordAnswer({ conversationId: 'conv-1', turnId: 'turn-1', markdown: md, now: 1000 });
    expect(a).toMatchObject({ kind: 'markdown', source: 'final_answer', stored: true, name: '요약', turnId: 'turn-1' });
    expect(await store.recordAnswer({ conversationId: 'conv-1', turnId: 'turn-1', markdown: md })).toBeNull();
    expect(fs.readFileSync(store.blobPath('conv-1', a!.id)!, 'utf-8')).toBe(md);
    expect(
      await store.recordAnswer({ conversationId: 'conv-1', turnId: 'turn-2', markdown: 'plain short reply' }),
    ).toBe(null);
  });
});

describe('T1/T7 — files sent to Slack', () => {
  it('copies the uploaded bytes so the preview outlives /tmp cleanup', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const p = srcFile('chart.png', png);
    const a = await store.recordSlackUpload({
      conversationId: 'conv-1',
      filePath: p,
      filename: 'chart.png',
      slackFileId: 'F1',
      permalink: 'https://example.slack.com/files/U/F1/chart.png',
      tool: 'send_media',
      now: 5,
    });
    fs.unlinkSync(p);
    expect(a).toMatchObject({ kind: 'image', mime: 'image/png', stored: true, size: 7, slackFileId: 'F1' });
    expect(fs.readFileSync(store.blobPath('conv-1', a!.id)!)).toEqual(png);
  });

  it('still lists a file whose bytes are gone — metadata and Slack link only', async () => {
    const a = await store.recordSlackUpload({
      conversationId: 'conv-1',
      filePath: path.join(srcDir, 'missing.wav'),
      filename: 'missing.wav',
      slackFileId: 'F2',
      size: 1234,
      permalink: 'https://example.slack.com/files/U/F2/missing.wav',
    });
    expect(a).toMatchObject({ kind: 'audio', stored: false, size: 1234 });
    expect(store.list('conv-1').map((x) => x.name)).toEqual(['missing.wav']);
    expect(store.blobPath('conv-1', a!.id)).toBeNull();
  });

  it('the same Slack file id is recorded once', async () => {
    const p = srcFile('a.html', '<h1>x</h1>');
    await store.recordSlackUpload({ conversationId: 'c', filePath: p, filename: 'a.html', slackFileId: 'F9' });
    await store.recordSlackUpload({ conversationId: 'c', filePath: p, filename: 'a.html', slackFileId: 'F9' });
    expect(store.list('c')).toHaveLength(1);
  });

  it('persists the index: a fresh store over the same directory sees the artifacts', async () => {
    const p = srcFile('r.html', '<p>r</p>');
    await store.recordSlackUpload({ conversationId: 'conv-9', filePath: p, filename: 'r.html', slackFileId: 'F3' });
    const again = new ArtifactStore(path.join(root, 'store'));
    expect(again.list('conv-9').map((a) => a.name)).toEqual(['r.html']);
  });

  it('summary for the card: count, files vs answers, newest files first then the latest answer', async () => {
    await store.recordSlackUpload({ conversationId: 'c', filename: 'one.png', slackFileId: 'A', now: 1 });
    await store.recordAnswer({
      conversationId: 'c',
      turnId: 't',
      markdown: '## 답\n- 하나\n- 둘\n- 셋 넷 다섯 여섯',
      now: 2,
    });
    await store.recordSlackUpload({ conversationId: 'c', filename: 'two.html', slackFileId: 'B', now: 3 });
    const s = store.summary('c')!;
    expect(s).toMatchObject({ count: 3, files: 2, answers: 1 });
    expect(s.recent.map((a) => a.name)).toEqual(['two.html', 'one.png', '답']);
    expect(store.summary('nothing-here')).toBeUndefined();
  });

  it('notifies listeners when an artifact is recorded (the live dashboard push)', async () => {
    const seen: string[] = [];
    store.onRecorded((a) => seen.push(`${a.conversationId}/${a.name}`));
    await store.recordSlackUpload({ conversationId: 'c', filename: 'x.wav', slackFileId: 'W' });
    expect(seen).toEqual(['c/x.wav']);
  });

  it('rejects unsafe ids instead of touching paths outside the store', async () => {
    expect(store.list('../../etc')).toEqual([]);
    expect(store.blobPath('c', '../index.json')).toBeNull();
  });
});

describe('T1/T7 — capture from the work-log stream', () => {
  let seq = 0;
  const tool = (name: string, input: Record<string, unknown>, toolUseId: string | undefined = `tu_${++seq}`) => ({
    kind: 'tool',
    tool: `mcp__slack-mcp__${name}`,
    ...(toolUseId ? { toolUseId } : {}),
    turnId: 'C1:t1:1792733000000:uuid-1',
    text: name,
    raw: JSON.stringify(input, null, 2),
  });
  const result = (name: string, reply: Record<string, unknown>, toolUseId?: string, ok = true) => ({
    kind: 'tool_result',
    tool: `mcp__slack-mcp__${name}`,
    ...(toolUseId ? { toolUseId } : {}),
    turnId: 'C1:t1:1792733000000:uuid-1',
    ok,
    text: `${name} ${ok ? 'ok' : 'error'}`,
    raw: JSON.stringify(reply),
  });

  it('send_file input + result → a stored html artifact, tagged with its turn', async () => {
    const p = srcFile('report.html', '<h1>보고서</h1>');
    await captureArtifactFromWorkLog('conv-1', tool('send_file', { file_path: p, title: '보고서' }, 'tu_a'), store);
    await captureArtifactFromWorkLog(
      'conv-1',
      result(
        'send_file',
        { uploaded: true, file_id: 'F10', filename: 'report.html', size: 22, permalink: 'https://s/F10' },
        'tu_a',
      ),
      store,
    );
    const [a] = store.list('conv-1');
    expect(a).toMatchObject({
      kind: 'html',
      name: 'report.html',
      title: '보고서',
      stored: true,
      slackFileId: 'F10',
      tool: 'send_file',
      turnId: 'C1:t1:1792733000000:uuid-1',
      turnStartedAt: 1792733000000,
    });
    expect(fs.readFileSync(store.blobPath('conv-1', a.id)!, 'utf-8')).toBe('<h1>보고서</h1>');
  });

  it('snapshots the bytes when the call is made — the file may be gone by the time the result lands', async () => {
    const p = srcFile('voice.wav', 'RIFF-original');
    await captureArtifactFromWorkLog('c', tool('send_media', { file_path: p }, 'tu_s'), store);
    fs.writeFileSync(p, 'RIFF-overwritten-after-upload');
    fs.unlinkSync(p);
    await captureArtifactFromWorkLog(
      'c',
      result('send_media', { uploaded: true, file_id: 'S', filename: 'voice.wav' }, 'tu_s'),
      store,
    );
    const [a] = store.list('c');
    expect(a.stored).toBe(true);
    expect(fs.readFileSync(store.blobPath('c', a.id)!, 'utf-8')).toBe('RIFF-original');
  });

  it('pairs call and result by tool-use id — two uploads with the same name stay distinct', async () => {
    const d1 = path.join(srcDir, 'one');
    const d2 = path.join(srcDir, 'two');
    fs.mkdirSync(d1);
    fs.mkdirSync(d2);
    fs.writeFileSync(path.join(d1, 'chart.png'), 'FIRST');
    fs.writeFileSync(path.join(d2, 'chart.png'), 'SECOND');
    await captureArtifactFromWorkLog('c', tool('send_media', { file_path: path.join(d1, 'chart.png') }, 'tu_1'), store);
    await captureArtifactFromWorkLog('c', tool('send_media', { file_path: path.join(d2, 'chart.png') }, 'tu_2'), store);
    await captureArtifactFromWorkLog(
      'c',
      result('send_media', { uploaded: true, file_id: 'B', filename: 'chart.png' }, 'tu_2'),
      store,
    );
    await captureArtifactFromWorkLog(
      'c',
      result('send_media', { uploaded: true, file_id: 'A', filename: 'chart.png' }, 'tu_1'),
      store,
    );
    const byId = Object.fromEntries(store.list('c').map((a) => [a.slackFileId, a]));
    expect(fs.readFileSync(store.blobPath('c', byId.A.id)!, 'utf-8')).toBe('FIRST');
    expect(fs.readFileSync(store.blobPath('c', byId.B.id)!, 'utf-8')).toBe('SECOND');
  });

  it('without ids (older entries) a result pairs with the pending call of the same display name', async () => {
    const png = srcFile('a.png', 'PNG');
    const wav = srcFile('b.wav', 'RIFF');
    await captureArtifactFromWorkLog('c', tool('send_media', { file_path: png }, ''), store);
    await captureArtifactFromWorkLog('c', tool('send_media', { file_path: wav, filename: 'voice.wav' }, ''), store);
    await captureArtifactFromWorkLog(
      'c',
      result('send_media', { uploaded: true, file_id: 'W', filename: 'voice.wav' }),
      store,
    );
    await captureArtifactFromWorkLog(
      'c',
      result('send_media', { uploaded: true, file_id: 'P', filename: 'a.png' }),
      store,
    );
    const byName = Object.fromEntries(store.list('c').map((a) => [a.name, a]));
    expect(fs.readFileSync(store.blobPath('c', byName['voice.wav'].id)!, 'utf-8')).toBe('RIFF');
    expect(fs.readFileSync(store.blobPath('c', byName['a.png'].id)!, 'utf-8')).toBe('PNG');
  });

  it('never copies outside /tmp, nor through a symlink — the file is listed, not stored', async () => {
    await captureArtifactFromWorkLog('c', tool('send_file', { file_path: '/etc/hosts' }, 'tu_x'), store);
    await captureArtifactFromWorkLog(
      'c',
      result('send_file', { uploaded: true, file_id: 'X', filename: 'hosts' }, 'tu_x'),
      store,
    );
    const link = path.join(srcDir, 'link.txt');
    fs.symlinkSync('/etc/hosts', link);
    await captureArtifactFromWorkLog('c', tool('send_file', { file_path: link }, 'tu_l'), store);
    await captureArtifactFromWorkLog(
      'c',
      result('send_file', { uploaded: true, file_id: 'L', filename: 'link.txt' }, 'tu_l'),
      store,
    );
    expect(store.list('c').map((a) => [a.name, a.stored])).toEqual([
      ['hosts', false],
      ['link.txt', false],
    ]);
  });

  it('a failed upload records nothing and leaves no snapshot behind; other tools are ignored', async () => {
    const p = srcFile('x.png', 'x');
    await captureArtifactFromWorkLog('c', tool('send_file', { file_path: p }, 'tu_f'), store);
    await captureArtifactFromWorkLog('c', result('send_file', { error: 'boom' }, 'tu_f', false), store);
    await captureArtifactFromWorkLog(
      'c',
      { kind: 'tool', tool: 'Write', text: 'Write', raw: '{"file_path":"/tmp/x"}' },
      store,
    );
    await captureArtifactFromWorkLog(
      'c',
      { kind: 'tool_result', tool: 'Write', ok: true, text: 'ok', raw: '{}' },
      store,
    );
    expect(store.list('c')).toEqual([]);
    const dir = path.join(root, 'store', 'c');
    const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.endsWith('.json')) : [];
    expect(left).toEqual([]);
  });

  it('a markdown final answer becomes an answer artifact; a plain one does not', async () => {
    await captureArtifactFromWorkLog(
      'c',
      { kind: 'final', turnId: 'k:1:u', text: '# 완료\n\n| 항목 | 상태 |\n|---|---|\n| 배포 | 완료 |', ts: 9 },
      store,
    );
    await captureArtifactFromWorkLog(
      'c',
      { kind: 'final', turnId: 'k:2:u', text: '알겠습니다, 바로 하겠습니다.' },
      store,
    );
    expect(store.list('c').map((a) => [a.kind, a.name, a.source])).toEqual([['markdown', '완료', 'final_answer']]);
  });
});

describe('T7 — uploads made before this feature: backfill from the work log', () => {
  function fakeLog(entries: Array<CaptureEntry>): WorkLogReader {
    const stored = entries.map((e, i) => {
      const { raw, ...rest } = e;
      return { entry: { seq: i + 1, ts: 1000 + i, ...rest, ...(raw ? { rawBytes: raw.length } : {}) }, raw };
    });
    return {
      readWorkLog: async (_cid: string, opts: { afterSeq?: number; limit?: number }) => {
        const after = opts.afterSeq ?? 0;
        const page = stored.filter((s) => s.entry.seq > after).slice(0, opts.limit ?? 500);
        const last = page.length ? page[page.length - 1].entry.seq : after;
        return { entries: page.map((s) => s.entry), hasMore: stored.some((s) => s.entry.seq > last) };
      },
      readWorkLogRaw: async (_cid: string, seq: number) => {
        const hit = stored.find((s) => s.entry.seq === seq);
        return hit?.raw ? { seq, raw: hit.raw, rawBytes: hit.raw.length, rawTruncated: false } : null;
      },
    };
  }

  it('lists every past upload and markdown answer once; bytes are kept when the file still exists', async () => {
    const still = srcFile('kept.png', 'PNG!');
    const reader = fakeLog([
      {
        kind: 'tool',
        tool: 'mcp__slack-mcp__send_media',
        text: 'send',
        turnId: 'K:1:a',
        raw: JSON.stringify({ file_path: still }),
      },
      {
        kind: 'tool_result',
        tool: 'mcp__slack-mcp__send_media',
        ok: true,
        text: 'ok',
        turnId: 'K:1:a',
        raw: JSON.stringify({ uploaded: true, file_id: 'F1', filename: 'kept.png' }),
      },
      {
        kind: 'tool',
        tool: 'mcp__slack-mcp__send_file',
        text: 'send',
        turnId: 'K:1:a',
        raw: JSON.stringify({ file_path: path.join(srcDir, 'gone.html') }),
      },
      {
        kind: 'tool_result',
        tool: 'mcp__slack-mcp__send_file',
        ok: true,
        text: 'ok',
        turnId: 'K:1:a',
        raw: JSON.stringify({ uploaded: true, file_id: 'F2', filename: 'gone.html', size: 99 }),
      },
      { kind: 'final', text: '## 끝\n- 하나\n- 둘 셋 넷 다섯 여섯 일곱', turnId: 'K:1:a' },
    ]);
    await backfillArtifactsFromWorkLog('conv-old', store, reader);
    await backfillArtifactsFromWorkLog('conv-old', store, reader); // idempotent
    expect(store.list('conv-old').map((a) => [a.name, a.kind, a.stored])).toEqual([
      ['kept.png', 'image', true],
      ['gone.html', 'html', false],
      ['끝', 'markdown', true],
    ]);
    expect(store.isBackfilled('conv-old')).toBe(true);
  });
});

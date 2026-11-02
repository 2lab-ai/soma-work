/**
 * 서버 위스퍼 live dictation — the stream policy (epic #737, #739).
 *
 *   S1  silence is never sent to Whisper (it makes words up there); speech is, every step while it lasts
 *   S2  words settle when two hypotheses in a row agree on them (LocalAgreement-2); the rest is still being heard
 *   S3  a pause after speech closes the segment: its last transcription is final, the next segment starts empty
 *   S4  a segment that runs too long is closed anyway
 *   S5  one transcription at a time; a finished stream finalizes what is left
 *   S6  Whisper's silence phrases are dropped; a failed transcription is reported and the stream goes on
 */

import { describe, expect, it, vi } from 'vitest';
import { DictationStream, type DictationText } from '../dictation-stream';

const RATE = 16000;
/** ms of audio: voiced (a 440 Hz tone at ~0.2) or silent. */
function audio(ms: number, voiced: boolean): Int16Array {
  const n = Math.round((RATE * ms) / 1000);
  const a = new Int16Array(n);
  if (voiced) for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.2 * 32767);
  return a;
}

function harness(answers: string[] | ((pcm: Int16Array, prompt: string) => string | Promise<string>)) {
  const calls: { samples: number; prompt: string }[] = [];
  const texts: DictationText[] = [];
  const errors: string[] = [];
  let i = 0;
  const transcribe = vi.fn(async (pcm: Int16Array, prompt: string) => {
    calls.push({ samples: pcm.length, prompt });
    if (typeof answers === 'function') return answers(pcm, prompt);
    const a = answers[Math.min(i, answers.length - 1)];
    i++;
    return a;
  });
  const stream = new DictationStream({
    transcribe,
    onText: (t) => texts.push(t),
    onError: (e) => errors.push(e),
  });
  const last = () => texts[texts.length - 1];
  return { stream, calls, texts, errors, transcribe, last };
}

/** Push ms of audio in 100 ms chunks, letting each step's transcription settle. */
async function feed(stream: DictationStream, ms: number, voiced: boolean) {
  for (let t = 0; t < ms; t += 100) {
    stream.push(audio(Math.min(100, ms - t), voiced));
    await vi.waitFor(() => !stream.busy, { timeout: 200 });
  }
}

describe('S1 — silence is never sent to Whisper', () => {
  it('a stream of silence transcribes nothing and says nothing', async () => {
    const h = harness(['감사합니다.']);
    await feed(h.stream, 3000, false);
    await h.stream.finish();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.texts.filter((t) => t.final || t.interim)).toEqual([]);
  });

  it('speech is transcribed every step while it lasts, with the start of the speech kept (pre-roll)', async () => {
    const h = harness(['대시보드', '대시보드 새', '대시보드 새 작업']);
    await feed(h.stream, 1000, false);
    await feed(h.stream, 1600, true);
    // a step is 500 ms of new audio: about three runs in 1.6 s of speech
    expect(h.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.calls.length).toBeLessThanOrEqual(4);
    // the segment holds the speech plus at most 300 ms of what came before it — not the whole second of silence
    const first = h.calls[0].samples;
    expect(first).toBeLessThanOrEqual(RATE * 0.8);
  });
});

describe('S2 — words settle when two hypotheses agree', () => {
  it('the common start of two hypotheses in a row is final; the rest is interim', async () => {
    const h = harness(['대시보드 새', '대시보드 새 작업 화면', '대시보드 새 작업 화면에서 실시간']);
    await feed(h.stream, 600, true);
    expect(h.last()).toEqual({ final: '', interim: '대시보드 새' });
    await feed(h.stream, 500, true);
    expect(h.last()).toEqual({ final: '대시보드 새', interim: '작업 화면' });
    await feed(h.stream, 500, true);
    // 화면 → 화면에서: the third word still agrees, the fourth does not
    expect(h.last()).toEqual({ final: '대시보드 새 작업', interim: '화면에서 실시간' });
  });

  it('settled words stay settled even when a later hypothesis rewrites them', async () => {
    const h = harness(['오늘 회의는', '오늘 회의는 세시', '오늘 회이는 세 시에', '오늘 회이는 세 시에 합니다']);
    await feed(h.stream, 2100, true);
    const t = h.last();
    expect(t.final.startsWith('오늘 회의는')).toBe(true);
    expect(t.final + ' ' + t.interim).toContain('합니다');
  });

  it('a re-spaced settled word does not show again as still heard (measured: whisper-base in Chrome)', async () => {
    const h = harness([
      '대시보드 실시간 받아쓰기를',
      '대시보드 실시간 받아쓰기를 테스트',
      '대시보드 실시간 받아 쓰기를 테스트하고 있습니다',
    ]);
    await feed(h.stream, 1600, true);
    expect(h.last()).toEqual({ final: '대시보드 실시간 받아쓰기를', interim: '테스트하고 있습니다' });
  });

  it('an earlier word heard with other letters does not repeat the last settled word (measured: whisper-small)', async () => {
    const h = harness([
      '대시 보듯의 작업 실시간 바다',
      '대시 보듯의 작업 실시간 바다 쓰기',
      '대시 보드 새로운 작업 실시간 바다 쓰기를 테스트하고',
    ]);
    await feed(h.stream, 1600, true);
    expect(h.last()).toEqual({ final: '대시 보듯의 작업 실시간 바다', interim: '쓰기를 테스트하고' });
  });

  it('punctuation does not stop agreement', async () => {
    const h = harness(['테스트하고 있습니다', '테스트하고 있습니다. 풀']);
    await feed(h.stream, 1100, true);
    expect(h.last()).toEqual({ final: '테스트하고 있습니다.', interim: '풀' });
  });
});

describe('S3 — a pause closes the segment', () => {
  it('after 800 ms of silence the segment is transcribed once more and all of it is final', async () => {
    const h = harness(['대시보드', '대시보드 새 작업', '대시보드 새 작업 화면에서.']);
    await feed(h.stream, 1100, true);
    await feed(h.stream, 1000, false);
    await vi.waitFor(() => !h.stream.busy);
    expect(h.last()).toEqual({ final: '대시보드 새 작업 화면에서.', interim: '' });
  });

  it('the next segment adds to what is final, with the end of it as the prompt', async () => {
    const h = harness((pcm, prompt) => (prompt ? '두 번째 문장' : '첫 번째 문장'));
    await feed(h.stream, 700, true);
    await feed(h.stream, 1000, false);
    await feed(h.stream, 700, true);
    await h.stream.finish();
    expect(h.last()).toEqual({ final: '첫 번째 문장 두 번째 문장', interim: '' });
    expect(h.calls[h.calls.length - 1]?.prompt).toBe('첫 번째 문장');
  });

  it('a short silence inside speech does not close it', async () => {
    const h = harness(['하나', '하나 둘', '하나 둘 셋', '하나 둘 셋 넷']);
    await feed(h.stream, 600, true);
    await feed(h.stream, 400, false);
    await feed(h.stream, 600, true);
    const t = h.last();
    expect(t.interim).not.toBe('');
  });
});

describe('S4 — a segment that runs too long is closed anyway', () => {
  it('at 25 s of speech the segment is finalized and a new one starts', async () => {
    let n = 0;
    const h = harness(() => `조각${++n}`);
    await feed(h.stream, 26000, true);
    await vi.waitFor(() => !h.stream.busy);
    expect(h.calls.some((c) => c.samples >= RATE * 24)).toBe(true);
    expect(Math.max(...h.calls.map((c) => c.samples))).toBeLessThanOrEqual(RATE * 25.5);
    expect(h.last().final).not.toBe('');
  });
});

describe('S5 — one transcription at a time; finishing finalizes what is left', () => {
  it('never runs two at once, however fast audio comes', async () => {
    let running = 0;
    let most = 0;
    const h = harness(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return '말';
    });
    for (let i = 0; i < 30; i++) h.stream.push(audio(100, true));
    await vi.waitFor(() => !h.stream.busy, { timeout: 2000 });
    expect(most).toBe(1);
  });

  it('finish() transcribes the open segment and resolves with everything final', async () => {
    const h = harness(['대시보드', '대시보드 새 작업']);
    await feed(h.stream, 700, true);
    const out = await h.stream.finish();
    expect(out.final).toBe('대시보드 새 작업');
    expect(h.last()).toEqual({ final: '대시보드 새 작업', interim: '' });
  });
});

describe('S6 — silence phrases and failures', () => {
  it.each([
    '감사합니다.',
    '시청해주셔서 감사합니다.',
    'MBC 뉴스 김성현입니다.',
    'Thank you.',
  ])('drops "%s" from a short burst', async (phrase) => {
    const h = harness([phrase]);
    await feed(h.stream, 400, true);
    await feed(h.stream, 1000, false);
    await h.stream.finish();
    expect(h.last()?.final ?? '').toBe('');
  });

  it('keeps a real 감사합니다 inside longer speech', async () => {
    const h = harness(['도와줘서 정말 감사합니다', '도와줘서 정말 감사합니다']);
    await feed(h.stream, 1800, true);
    await h.stream.finish();
    expect(h.last().final).toBe('도와줘서 정말 감사합니다');
  });

  it('a failed transcription is reported and the stream goes on', async () => {
    let n = 0;
    const h = harness(() => {
      n++;
      if (n === 1) throw new Error('worker exited');
      return '다시 들림';
    });
    await feed(h.stream, 1200, true);
    await h.stream.finish();
    expect(h.errors).toEqual(['worker exited']);
    expect(h.last().final).toBe('다시 들림');
  });
});

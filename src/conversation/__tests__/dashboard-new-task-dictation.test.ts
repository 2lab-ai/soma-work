/**
 * Dashboard "New task" — live dictation (SSOT 2026-11-01, voice memo).
 *
 * "음성 파일을 통째로 작업으로 넘기거든. 그렇게 하지 말고 … 실시간으로 음성 누르면 … 바로 글자로 변환해줘."
 *
 * The new task's mic no longer files an audio note the server may fail to transcribe: where the browser has a
 * speech recogniser (Web Speech API — Safari on iPhone, Chrome on Galaxy and desktop, Edge, Samsung Internet), a
 * 받아쓰기 tool writes what is said into the field while it is said, on the device when the browser can.
 *
 * Same harness as dashboard-new-task-client.test.ts: the shipped client functions are cut out of
 * renderDashboardPage()'s template literal, cooked as the browser receives them, and run against fakes.
 *
 * Test ids map to the INTENT-TASK-TREE: I1.1 live text · I1.2 no audio note where dictation works ·
 * I1.3 a dashboard task gets voice · I1.4 stops and reload guard · I2.1 on-device when available · I3.1 ko-KR.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
/** The functions, sharing one scope with the page globals they read (given as values, `let` so they can change). */
function loadWith<T>(fns: string[], globals: Record<string, unknown>): T {
  const names = Object.keys(globals);
  const body = `${names.map((n) => `let ${n} = __g.${n};`).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, __peek: function (k) { return eval(k); } };`;
  return new Function('__g', body)(globals) as T;
}

// ── Fakes ────────────────────────────────────────────────────────────

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

type Alt = { transcript: string };
type Result = Alt[] & { isFinal: boolean };
const final = (t: string): Result => Object.assign([{ transcript: t }], { isFinal: true });
const interim = (t: string): Result => Object.assign([{ transcript: t }], { isFinal: false });

class FakeRec {
  static made: FakeRec[] = [];
  static availability: string | null = null; // null: the browser has no available() (Safari, older Chrome)
  static asked: unknown[] = [];
  static installs: unknown[] = [];
  lang = '';
  interimResults = false;
  continuous = false;
  maxAlternatives = 0;
  processLocally: boolean | undefined;
  starts = 0;
  stops = 0;
  aborts = 0;
  onresult: ((e: { results: Result[]; resultIndex: number }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRec.made.push(this);
  }
  start() {
    this.starts++;
  }
  stop() {
    this.stops++;
  }
  abort() {
    this.aborts++;
  }
  // The page's view of one recognition session.
  say(results: Result[]) {
    this.onresult?.({ results, resultIndex: 0 });
  }
  end() {
    this.onend?.();
  }
}
/** A recogniser class; `availability` null = no available() (Safari, Android). `install` answers install(). */
function recClass(availability: string | null, install?: () => Promise<boolean>) {
  FakeRec.made = [];
  FakeRec.asked = [];
  FakeRec.installs = [];
  FakeRec.availability = availability;
  const C = class extends FakeRec {} as unknown as typeof FakeRec & {
    available?: (o: unknown) => Promise<string>;
    install?: (o: unknown) => Promise<boolean>;
  };
  if (availability !== null) {
    C.available = async (o: unknown) => {
      FakeRec.asked.push(o);
      return availability;
    };
    C.install = (o: unknown) => {
      FakeRec.installs.push(o);
      return install ? install() : Promise.resolve(false);
    };
  }
  return C;
}

type Page = {
  ntDictateStart(): Promise<void>;
  ntDictateStop(hard?: boolean): void;
  ntOnComposerTool(e: { detail?: { id?: string; pressed?: boolean } }): void;
  ntComposerData(): Record<string, any>;
  __peek(k: string): any;
};

function page(opts: { engine?: unknown; value?: string; destination?: string } = {}) {
  const composer = { value: opts.value ?? '', files: [] as unknown[] };
  const env = {
    composer,
    statuses: [] as string[],
    drafts: [] as string[],
    paints: 0,
    state: { destination: opts.destination ?? 'slack', prompt: '' },
  };
  const win: Record<string, unknown> = {};
  if (opts.engine !== undefined) win.webkitSpeechRecognition = opts.engine;
  const api = loadWith<Page>(
    [
      'ntDictationEngine',
      'ntDictationTool',
      'ntDictationText',
      'ntJoinSpoken',
      'ntDictationRead',
      'ntDictationErrorText',
      'ntWithin',
      'ntDictationLocal',
      'ntDictationStatus',
      'ntDictateStart',
      'ntDictationHeard',
      'ntDictationEnded',
      'ntDictationEnd',
      'ntDictateStop',
      'ntOnComposerTool',
      'ntComposerData',
      'ntReadDraft',
    ],
    {
      window: win,
      _ntDictation: null,
      NT_DICTATION_LANG: 'ko-KR',
      _ntValue: '',
      _ntBusy: false,
      _ntCtx: null,
      _ntState: env.state,
      NT_NO_FILES: 'application/x-soma-no-attachments',
      NT_DRAFT_KEY: 'k',
      localStorage: { getItem: () => null },
      ntEl: (id: string) => (id === 'nt-composer' ? composer : null),
      ntSetStatus: (t: string) => env.statuses.push(t || ''),
      ntSaveDraft: (t: string) => env.drafts.push(t),
      paintNtComposer: () => {
        env.paints++;
      },
    },
  );
  return { api, env };
}

// ── Pure pieces ──────────────────────────────────────────────────────

describe('I2.1 — the engine is the browser’s own recogniser (Web Speech API), or none', () => {
  it('takes the standard name first, then the WebKit-prefixed one (Safari, Chrome, Samsung Internet)', () => {
    const { api } = page();
    const fn = new Function(`${clientFn('ntDictationEngine')}; return ntDictationEngine;`)();
    const std = () => {};
    const wk = () => {};
    expect(fn({ SpeechRecognition: std, webkitSpeechRecognition: wk })).toBe(std);
    expect(fn({ webkitSpeechRecognition: wk })).toBe(wk);
    expect(fn({})).toBeNull(); // Firefox
    // An iPhone web app opened from the Home Screen cannot use it (WebKit bug 225298): the voice note stays.
    expect(fn({ webkitSpeechRecognition: wk, navigator: { standalone: true } })).toBeNull();
    expect(fn({ webkitSpeechRecognition: wk, navigator: { standalone: false } })).toBe(wk);
    expect(fn(null)).toBeNull();
    expect(api).toBeTruthy();
  });
});

describe('I1.1 — what is heard becomes the field’s text', () => {
  const read = (results: Result[]) =>
    new Function(`${clientFn('ntJoinSpoken')}\n${clientFn('ntDictationRead')}; return ntDictationRead;`)()(results);
  const text = (base: string, finals: string, heard: string) =>
    new Function(`${clientFn('ntJoinSpoken')}\n${clientFn('ntDictationText')}; return ntDictationText;`)()(
      base,
      finals,
      heard,
    );

  it('the field reads: what was there, the settled words, then the words still being heard', () => {
    expect(text('', '', '')).toBe('');
    expect(text('기존 지시', '', '')).toBe('기존 지시');
    expect(text('', '안녕하세요', ' soma')).toBe('안녕하세요 soma');
    expect(text('기존 지시', '안녕하세요', '')).toBe('기존 지시 안녕하세요');
    expect(text('기존 지시\n', '대시보드', ' 고쳐줘')).toBe('기존 지시\n대시보드 고쳐줘');
  });

  it('settled results add up, the interim one follows; a phrase is joined with one space', () => {
    expect(read([final('새 작업에서'), final(' 음성을'), interim(' 받아')])).toEqual({
      finals: '새 작업에서 음성을',
      interim: ' 받아',
    });
    // Android/iOS send no leading space between results: one is put in.
    expect(read([final('새 작업에서'), final('음성을')]).finals).toBe('새 작업에서 음성을');
  });

  it('Android Chrome repeats what it already settled (continuous mode): the longer copy replaces it, once', () => {
    expect(read([final('대시보드'), final('대시보드 받아쓰기'), interim('대시보드 받아쓰기 고쳐')])).toEqual({
      finals: '대시보드 받아쓰기',
      interim: ' 고쳐',
    });
  });
});

describe('I1.4 — errors end dictation in plain words; silence and a cancel say nothing', () => {
  const err = (code: string) =>
    new Function(`${clientFn('ntDictationErrorText')}; return ntDictationErrorText;`)()(code);
  it('maps the recogniser’s error codes', () => {
    expect(err('no-speech')).toBe('');
    expect(err('aborted')).toBe('');
    expect(err('not-allowed')).toContain('마이크');
    expect(err('service-not-allowed')).toContain('받아쓰기');
    expect(err('audio-capture')).toContain('마이크');
    expect(err('network')).toContain('연결');
    expect(err('language-not-supported')).toContain('한국어');
    expect(err('whatever')).toContain('받아쓰기');
  });
});

// ── The composer's data ──────────────────────────────────────────────

describe('I1.2 / I1.3 — the composer offers 받아쓰기 instead of the audio note, on both destinations', () => {
  it('with a recogniser: one mic — the dictation tool, not pressed; the audio voice note is off', () => {
    const { api } = page({ engine: recClass(null) });
    const d = api.ntComposerData();
    expect(d.voice).toBe(false);
    expect(d.tools).toEqual([{ id: 'dictate', label: '받아쓰기', icon: 'mic', pressed: false }]);
  });
  it('a dashboard task (no attachments) gets voice too: dictation is text', () => {
    const { api } = page({ engine: recClass(null), destination: 'task' });
    const d = api.ntComposerData();
    expect(d).toMatchObject({ attach: false, voice: false, camera: false });
    expect(d.tools).toEqual([{ id: 'dictate', label: '받아쓰기', icon: 'mic', pressed: false }]);
  });
  it('without a recogniser (Firefox): the old voice note stays, no dictation tool', () => {
    const { api } = page();
    const d = api.ntComposerData();
    expect(d).not.toHaveProperty('tools');
    expect(d).not.toHaveProperty('voice');
  });
});

// ── A dictation, end to end against a fake recogniser ────────────────

describe('I1.1 / I3.1 — pressing 받아쓰기 streams the words into the field', () => {
  it('starts a ko-KR recogniser with interim results, continuous; the tool shows pressed', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, value: '기존 지시' });
    api.ntOnComposerTool({ detail: { id: 'dictate', pressed: true } });
    await Promise.resolve();
    await Promise.resolve();
    const rec = FakeRec.made[0];
    expect(rec).toBeTruthy();
    expect(rec.lang).toBe('ko-KR');
    expect(rec.interimResults).toBe(true);
    expect(rec.continuous).toBe(true);
    expect(rec.starts).toBe(1);
    expect(api.ntComposerData().tools[0]).toMatchObject({ id: 'dictate', pressed: true, label: '받아쓰기 멈추기' });
    expect(env.paints).toBeGreaterThan(0);
    expect(last(env.statuses)).toContain('듣는 중');

    rec.say([interim('대시보드')]);
    expect(env.composer.value).toBe('기존 지시 대시보드');
    rec.say([final('대시보드 새 작업'), interim(' 고쳐')]);
    expect(env.composer.value).toBe('기존 지시 대시보드 새 작업 고쳐');
    // The draft and the dialog's state follow the field (the composer sends no ui-input for a value set by the page).
    expect(env.state.prompt).toBe('기존 지시 대시보드 새 작업 고쳐');
    expect(last(env.drafts)).toBe('기존 지시 대시보드 새 작업 고쳐');
  });

  it('a second press stops it; the words still on their way land, then it lets go', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.say([interim('작업 시작')]);
    api.ntOnComposerTool({ detail: { id: 'dictate', pressed: false } });
    expect(rec.stops).toBe(1);
    expect(api.ntComposerData().tools[0].pressed).toBe(false);
    rec.say([final('작업 시작해줘')]); // the recogniser settles what it heard before stop()
    expect(env.composer.value).toBe('작업 시작해줘');
    rec.end();
    expect(api.__peek('_ntDictation')).toBeNull();
    expect(rec.starts).toBe(1); // a stop is not restarted
    expect(last(env.statuses)).toBe('');
  });

  it('a hard stop (typing, closing, sending) drops what is still coming: the field keeps what it shows', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.say([interim('반쯤')]);
    api.ntDictateStop(true);
    expect(rec.aborts).toBe(1);
    expect(api.__peek('_ntDictation')).toBeNull();
    env.composer.value = '반쯤 직접 고침';
    rec.say([final('반쯤 들은 말')]);
    rec.end();
    expect(env.composer.value).toBe('반쯤 직접 고침');
  });

  it('the recogniser ends by itself (iOS after a pause, Chrome after a while): it listens again, keeping the words', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.say([final('첫 문장')]);
    rec.end();
    expect(rec.starts).toBe(2);
    rec.say([interim('둘째')]); // a new session: results start again from 0
    expect(env.composer.value).toBe('첫 문장 둘째');
  });

  it('three silent sessions in a row end it, in plain words (no restart loop)', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.end();
    rec.end();
    rec.end();
    expect(rec.starts).toBe(3);
    expect(api.__peek('_ntDictation')).toBeNull();
    expect(last(env.statuses)).toContain('들리지 않아');
  });

  it('a refused microphone ends it with why, and is not retried', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.onerror?.({ error: 'not-allowed' });
    rec.end();
    expect(rec.starts).toBe(1);
    expect(api.__peek('_ntDictation')).toBeNull();
    expect(last(env.statuses)).toContain('마이크');
  });

  it('a restart refused after the first session (iOS) is not called a missing permission', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.say([final('첫 문장')]);
    rec.end(); // listens again
    rec.onerror?.({ error: 'not-allowed' });
    rec.end();
    expect(api.__peek('_ntDictation')).toBeNull();
    expect(last(env.statuses)).toContain('다시 누르면 이어서');
    expect(env.composer.value).toBe('첫 문장');
  });

  it('other tools are not dictation', async () => {
    const Rec = recClass(null);
    const { api } = page({ engine: Rec });
    api.ntOnComposerTool({ detail: { id: 'camera', pressed: true } });
    await Promise.resolve();
    expect(FakeRec.made).toHaveLength(0);
  });
});

describe('I2.1 — on the device when the browser says it can (Chrome’s available() / install())', () => {
  const Q = { langs: ['ko-KR'], processLocally: true };
  it('Korean available on the device: the recogniser processes locally, and the status says so', async () => {
    const Rec = recClass('available');
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    expect(FakeRec.asked[0]).toEqual(Q);
    expect(FakeRec.installs).toHaveLength(0);
    expect(FakeRec.made[0].processLocally).toBe(true);
    expect(FakeRec.made[0].starts).toBe(1);
    expect(last(env.statuses)).toContain('이 기기에서 처리합니다');
  });
  it('downloadable (Chrome says so until the site asks once): install() in the press; already there → local', async () => {
    const Rec = recClass('downloadable', () => Promise.resolve(true));
    const { api } = page({ engine: Rec });
    await api.ntDictateStart();
    expect(FakeRec.installs[0]).toEqual(Q);
    expect(FakeRec.made[0].processLocally).toBe(true);
  });
  it('a real download goes on in the background; this dictation runs through the browser’s service, and says so', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass('downloadable', () => new Promise<boolean>(() => {}));
      const { api, env } = page({ engine: Rec });
      const run = api.ntDictateStart();
      await vi.advanceTimersByTimeAsync(1600);
      await run;
      expect(FakeRec.installs).toHaveLength(1);
      expect(FakeRec.made[0].processLocally).not.toBe(true);
      expect(FakeRec.made[0].starts).toBe(1);
      expect(last(env.statuses)).toContain('내려받는 중');
    } finally {
      vi.useRealTimers();
    }
  });
  it('unavailable, downloading, or an install that says no: the browser’s service, said as such', async () => {
    for (const [a, inst] of [
      ['unavailable', undefined],
      ['downloading', undefined],
      ['downloadable', () => Promise.resolve(false)],
    ] as Array<[string, (() => Promise<boolean>) | undefined]>) {
      const Rec = recClass(a, inst);
      const { api, env } = page({ engine: Rec });
      await api.ntDictateStart();
      expect(FakeRec.made[0].processLocally).not.toBe(true);
      expect(FakeRec.made[0].starts).toBe(1);
      expect(last(env.statuses)).toContain('브라우저의 음성 서비스로 처리합니다');
    }
  });
  it('no available() (Safari — Apple’s engine, on the device for Korean; Android): no question asked', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    expect(FakeRec.asked).toHaveLength(0);
    expect(FakeRec.made[0].processLocally).toBeUndefined();
    expect(last(env.statuses)).toContain('말하는 대로 적힙니다');
  });
});

describe('I1.4 — the dialog wires the stops; a live dictation counts as unsent input', () => {
  it('ui-tool starts and stops it; typing, sending and closing stop it hard', () => {
    const init = clientFn('ntInit');
    expect(init).toContain("composer.addEventListener('ui-tool', ntOnComposerTool);");
    expect(init).toMatch(
      /addEventListener\('ui-input', function \(e\) \{\n\s+if \(_ntDictation\) ntDictateStop\(true\);/,
    );
    expect(init).toMatch(
      /addEventListener\('ui-submit', function \(e\) \{\n\s+e\.preventDefault\(\);\n\s+ntDictateStop\(true\);/,
    );
    expect(clientFn('ntQuietComposer')).toContain('ntDictateStop(true);');
  });
  it('a new build does not reload the tab mid-sentence', () => {
    expect(clientFn('hasUnsentInput')).toContain('if (_ntDictation) return true;');
  });
});

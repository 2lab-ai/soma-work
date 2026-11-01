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

type Host = { id: string };
type Page = {
  ntDictateStart(host?: Host): Promise<void>;
  ntDictateStop(hard?: boolean): void;
  ntDictateStopIn(id: string): void;
  ntDictateAuto(): void;
  ntDictationLive(): string;
  ntDictationHost(id: string): Host;
  ntOnComposerTool(e: { detail?: { id?: string; pressed?: boolean } }, host?: Host): void;
  ntComposerData(): Record<string, any>;
  pcComposerData(takesFiles: boolean | undefined): Record<string, any>;
  __peek(k: string): any;
};

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  galaxy:
    'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0 Mobile Safari/537.36',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36',
};

function page(
  opts: {
    engine?: unknown;
    value?: string;
    destination?: string;
    ua?: string;
    remoteOk?: boolean;
    busy?: boolean;
  } = {},
) {
  const store = new Map<string, string>();
  if (opts.remoteOk) store.set('soma-nt-dictation-remote', 'ok');
  const composer = { value: opts.value ?? '', files: [] as unknown[] };
  const env = {
    composer,
    statuses: [] as string[],
    drafts: [] as string[],
    paints: 0,
    pcPaints: 0,
    toasts: [] as string[],
    pc: { value: '' },
    state: { destination: opts.destination ?? 'slack', prompt: '' },
  };
  // An iPhone by default: Apple's engine, on the device, no question asked.
  const win: Record<string, unknown> = { navigator: { userAgent: opts.ua ?? UA.iphone } };
  if (opts.engine !== undefined) win.webkitSpeechRecognition = opts.engine;
  const api = loadWith<Page>(
    [
      'ntDictationEngine',
      'ntDictationWide',
      'ntDictationTool',
      'ntDictationText',
      'ntJoinSpoken',
      'ntDictationRead',
      'ntDictationErrorText',
      'ntWithin',
      'ntDictationLocal',
      'ntDictationStatus',
      'ntIsAppleSpeech',
      'ntDictationRemoteOk',
      'ntDictationOffDevice',
      'ntDictateStart',
      'ntDictationHeard',
      'ntDictationEnded',
      'ntDictationEnd',
      'ntDictateStop',
      'ntOnComposerTool',
      'ntDictating',
      'ntDictateStopIn',
      'ntDictationHost',
      'ntDictateAuto',
      'ntDictationLive',
      'ntComposerData',
      'pcComposerData',
      'ntReadDraft',
    ],
    {
      window: win,
      _ntDictation: null,
      _ntDictationAsked: false,
      _ntDictationAutoOff: false,
      _pcSending: false,
      PC_LIMITS: { maxFiles: 10, maxFileBytes: 1, maxTotalBytes: 2 },
      PC_NO_FILES: 'application/x-soma-no-attachments',
      document: { getElementById: (id: string) => (id === 'pc-composer' ? env.pc : null) },
      dashToast: (input: { title: string }) => env.toasts.push(input.title),
      pcPaintComposer: () => {
        env.pcPaints++;
      },
      NT_DICTATION_LANG: 'ko-KR',
      NT_DICTATION_REMOTE_KEY: 'soma-nt-dictation-remote',
      _ntValue: '',
      _ntBusy: !!opts.busy,
      _ntCtx: null,
      _ntState: env.state,
      NT_NO_FILES: 'application/x-soma-no-attachments',
      NT_DRAFT_KEY: 'k',
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k) : null),
        setItem: (k: string, v: string) => store.set(k, v),
      },
      ntEl: (id: string) => (id === 'nt-composer' ? composer : null),
      ntSetStatus: (t: string) => env.statuses.push(t || ''),
      ntSaveDraft: (t: string) => env.drafts.push(t),
      paintNtComposer: () => {
        env.paints++;
      },
    },
  );
  return { api, env, store };
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
  const read = (results: Result[], cumulative = false) =>
    new Function(`${clientFn('ntJoinSpoken')}\n${clientFn('ntDictationRead')}; return ntDictationRead;`)()(
      results,
      cumulative,
    );
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

  it('Android Chrome repeats what it already settled (continuous mode): there the longer copy replaces it, once', () => {
    expect(read([final('대시보드'), final('대시보드 받아쓰기'), interim('대시보드 받아쓰기 고쳐')], true)).toEqual({
      finals: '대시보드 받아쓰기',
      interim: ' 고쳐',
    });
  });

  it('elsewhere results are separate segments: a phrase said twice, or a word that begins the next one, stays', () => {
    // astra review R1: "아니, 아니요 그건 지우지 마세요" lost its first "아니" when the Android fold ran everywhere.
    expect(read([final('아니'), final(' 아니요 그건 지우지 마세요')]).finals).toBe('아니 아니요 그건 지우지 마세요');
    expect(read([final('아니'), interim(' 아니요 그건')])).toEqual({ finals: '아니', interim: ' 아니요 그건' });
    expect(read([final('반복'), final(' 반복')]).finals).toBe('반복 반복');
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

describe('SSOT_3 — 받아쓰기 is added beside the voice note, which stays ("음성녹음은 두고")', () => {
  it('with a recogniser: the voice note is the element’s own (untouched) and 받아쓰기 is a labelled tool beside it', () => {
    const { api } = page({ engine: recClass(null) });
    const d = api.ntComposerData();
    expect(d).not.toHaveProperty('voice');
    expect(d.tools).toEqual([{ id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: false }]);
  });
  it('its word shows on a wide screen; on a phone the pencil carries it (no room beside the counter)', () => {
    const tool = (wide: boolean | undefined) =>
      new Function(
        'window',
        `${clientFn('ntDictationWide')}\n${clientFn('ntDictationTool')}; return ntDictationTool(false);`,
      )(wide === undefined ? {} : { matchMedia: () => ({ matches: wide }) });
    expect(tool(true)).toEqual({ id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: false, showLabel: true });
    expect(tool(false)).toEqual({ id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: false });
    expect(tool(undefined)).toEqual({ id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: false });
  });
  it('on a phone the counter gives way to the tool row (the limit is checked on send); on a wide screen it stays', () => {
    const lim = { maxPromptChars: 12000, maxFiles: 10, maxFileBytes: 1, maxTotalBytes: 2 };
    const data = (wide: boolean, engine: unknown) =>
      loadWith<{ ntComposerData(): Record<string, any> }>(
        ['ntComposerData', 'ntReadDraft', 'ntDictationEngine', 'ntDictationTool', 'ntDictationWide', 'ntDictating'],
        {
          window: {
            navigator: { userAgent: UA.iphone },
            matchMedia: () => ({ matches: wide }),
            webkitSpeechRecognition: engine,
          },
          _ntValue: '',
          _ntDictation: null,
          _ntBusy: false,
          _ntCtx: { limits: lim },
          _ntState: { destination: 'slack' },
          NT_NO_FILES: 'x',
          NT_DRAFT_KEY: 'k',
          localStorage: { getItem: () => null },
        },
      ).ntComposerData();
    expect(data(false, recClass(null))).not.toHaveProperty('maxLength');
    expect(data(true, recClass(null)).maxLength).toBe(12000);
    expect(data(false, undefined).maxLength).toBe(12000); // no 받아쓰기, room as before
    expect(clientFn('submitNewTask')).toContain('ntTooLong(_ntState.prompt)');
    const tooLong = new Function('_ntCtx', `${clientFn('ntTooLong')}; return ntTooLong;`)({ limits: lim });
    expect(tooLong('가'.repeat(12000))).toBe('');
    expect(tooLong('가'.repeat(12001))).toContain('12,000');
  });
  it('a dashboard task (no attachments, so no voice note) still gets 받아쓰기: it is text', () => {
    const { api } = page({ engine: recClass(null), destination: 'task' });
    const d = api.ntComposerData();
    expect(d).toMatchObject({ attach: false, voice: false, camera: false });
    expect(d.tools).toEqual([{ id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: false }]);
  });
  it('without a recogniser (Firefox): the voice note as before, no 받아쓰기', () => {
    const { api } = page();
    const d = api.ntComposerData();
    expect(d).not.toHaveProperty('tools');
    expect(d).not.toHaveProperty('voice');
  });
  it('the session panel composer gets the same 받아쓰기 tool, the voice note kept (a dashboard task’s card: no voice)', () => {
    const { api } = page({ engine: recClass(null) });
    expect(api.pcComposerData(undefined).tools).toEqual([
      { id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: false },
    ]);
    expect(api.pcComposerData(undefined)).not.toHaveProperty('voice');
    expect(api.pcComposerData(false)).toMatchObject({
      voice: false,
      tools: [{ id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: false }],
    });
    const none = page();
    expect(none.api.pcComposerData(undefined)).not.toHaveProperty('tools');
  });
});

describe('SSOT_2 — 받아쓰기 in the session panel composer (where the person types to a running session)', () => {
  it('its press writes what is said into the panel composer; the new task composer is untouched', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, value: '새 작업 글' });
    env.pc.value = '세션에';
    api.ntOnComposerTool({ detail: { id: 'dictate', pressed: true } }, api.ntDictationHost('pc'));
    await Promise.resolve();
    const rec = FakeRec.made[0];
    expect(rec.starts).toBe(1);
    rec.say([interim('보낼 말')]);
    expect(env.pc.value).toBe('세션에 보낼 말');
    expect(env.composer.value).toBe('새 작업 글');
    expect(api.pcComposerData(undefined).tools[0].pressed).toBe(true);
    expect(api.ntComposerData().tools[0].pressed).toBe(false);
    expect(env.pcPaints).toBeGreaterThan(0);
  });
  it('only one dictation at a time: pressing it in the other composer moves it there', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    api.ntOnComposerTool({ detail: { id: 'dictate', pressed: true } }, api.ntDictationHost('pc'));
    await Promise.resolve();
    expect(FakeRec.made[0].aborts).toBe(1);
    expect(FakeRec.made).toHaveLength(2);
    FakeRec.made[1].say([interim('패널로')]);
    expect(env.pc.value).toBe('패널로');
    expect(env.composer.value).toBe('');
  });
  it('its why (a refused mic) is a toast — the panel has no status line', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart(api.ntDictationHost('pc'));
    const rec = FakeRec.made[0];
    rec.onerror?.({ error: 'not-allowed' });
    rec.end();
    expect(last(env.toasts)).toContain('마이크');
    expect(env.statuses.every((t) => !t.includes('마이크'))).toBe(true);
  });
  it('ntDictateStopIn stops only the dictation of that composer', async () => {
    const Rec = recClass(null);
    const { api } = page({ engine: Rec });
    await api.ntDictateStart(api.ntDictationHost('pc'));
    api.ntDictateStopIn('nt');
    expect(api.__peek('_ntDictation')).not.toBeNull();
    api.ntDictateStopIn('pc');
    expect(api.__peek('_ntDictation')).toBeNull();
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
    expect(api.ntComposerData().tools[0]).toMatchObject({ id: 'dictate', pressed: true, label: '받아쓰기' });
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

  it('a recogniser that never confirms a stop (Edge) does not hold the tool: it is let go after 3 s', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      api.ntDictateStop(false);
      expect(api.__peek('_ntDictation')).not.toBeNull(); // waiting for the last words
      await vi.advanceTimersByTimeAsync(3100);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(rec.aborts).toBe(1);
      expect(last(env.statuses)).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pressed again while the last words are still settling: a new dictation starts at once', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, value: '' });
    await api.ntDictateStart();
    const first = FakeRec.made[0];
    first.say([interim('하나')]);
    api.ntOnComposerTool({ detail: { id: 'dictate', pressed: false } });
    api.ntOnComposerTool({ detail: { id: 'dictate', pressed: true } });
    await Promise.resolve();
    expect(first.aborts).toBe(1);
    expect(FakeRec.made).toHaveLength(2);
    FakeRec.made[1].say([interim('둘')]);
    expect(env.composer.value).toBe('하나 둘');
    first.say([final('하나 늦게')]); // the first one's late words are dropped
    expect(env.composer.value).toBe('하나 둘');
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

  it('not while the task is being sent (fable review R1, P3)', async () => {
    const Rec = recClass(null);
    const { api } = page({ engine: Rec, busy: true });
    await api.ntDictateStart();
    expect(FakeRec.made).toHaveLength(0);
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
      const { api, env } = page({ engine: Rec, ua: UA.chromeMac, remoteOk: true });
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
  it('unavailable, downloading, or an install that says no: the browser’s service, said as such (once allowed)', async () => {
    for (const [a, inst] of [
      ['unavailable', undefined],
      ['downloading', undefined],
      ['downloadable', () => Promise.resolve(false)],
    ] as Array<[string, (() => Promise<boolean>) | undefined]>) {
      const Rec = recClass(a, inst);
      const { api, env } = page({ engine: Rec, ua: UA.chromeMac, remoteOk: true });
      await api.ntDictateStart();
      expect(FakeRec.made[0].processLocally).not.toBe(true);
      expect(FakeRec.made[0].starts).toBe(1);
      expect(last(env.statuses)).toContain('브라우저의 음성 서비스로 처리합니다');
    }
  });
  it('no available() on an Apple device (Safari, iPhone Chrome = WebKit): Apple’s engine on the device, at once', async () => {
    for (const ua of [UA.iphone, UA.iphoneChrome, UA.macSafari]) {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua });
      const run = api.ntDictateStart();
      // No await before start(): Safari keeps the press (user activation) for the microphone.
      expect(FakeRec.made[0]?.starts).toBe(1);
      await run;
      expect(FakeRec.asked).toHaveLength(0);
      expect(FakeRec.made[0].processLocally).toBeUndefined();
      expect(last(env.statuses)).toContain('이 기기의 Apple 음성 인식으로 처리합니다');
    }
  });
});

describe('I2 — the voice leaves the device only when the person has said yes (astra review R1, P1)', () => {
  it('Galaxy (Chrome or Samsung Internet — Google’s service): the first press says so and starts nothing', async () => {
    for (const ua of [UA.galaxy, UA.samsung]) {
      const Rec = recClass(null);
      const { api, env, store } = page({ engine: Rec, ua });
      await api.ntDictateStart();
      expect(FakeRec.made).toHaveLength(0);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(last(env.statuses)).toContain('기기 밖');
      expect(last(env.statuses)).toContain('키보드의 마이크');
      expect(store.has('soma-nt-dictation-remote')).toBe(false);
    }
  });
  it('the second press is the yes: it starts (in that press), and the device remembers it', async () => {
    const Rec = recClass(null);
    const { api, env, store } = page({ engine: Rec, ua: UA.galaxy });
    await api.ntDictateStart();
    await api.ntDictateStart();
    expect(FakeRec.made).toHaveLength(1);
    expect(FakeRec.made[0].starts).toBe(1);
    expect(store.get('soma-nt-dictation-remote')).toBe('ok');
    expect(last(env.statuses)).toContain('기기 밖');
    expect(last(env.statuses)).toContain('다시 누르거나 키보드로 쓰면 멈춥니다');
  });
  it('remembered: it starts on the first press', async () => {
    const Rec = recClass(null);
    const { api } = page({ engine: Rec, ua: UA.galaxy, remoteOk: true });
    await api.ntDictateStart();
    expect(FakeRec.made[0].starts).toBe(1);
  });
  it('desktop Chrome without Korean on the device asks the same way; with Korean on it, it never asks', async () => {
    let Rec = recClass('unavailable');
    let p = page({ engine: Rec, ua: UA.chromeMac });
    await p.api.ntDictateStart();
    expect(FakeRec.made).toHaveLength(0);
    expect(last(p.env.statuses)).toContain('기기 밖');
    Rec = recClass('available');
    p = page({ engine: Rec, ua: UA.chromeMac });
    await p.api.ntDictateStart();
    expect(FakeRec.made[0].processLocally).toBe(true);
  });
  it('a Korean model still downloading: the first press says it will be on the device once it is in', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass('downloadable', () => new Promise<boolean>(() => {}));
      const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
      const run = api.ntDictateStart();
      await vi.advanceTimersByTimeAsync(1600);
      await run;
      expect(FakeRec.made).toHaveLength(0);
      expect(last(env.statuses)).toContain('내려받는 중');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SSOT_4 — with speech recognition on this device the new task opens listening; a key typed stops it', () => {
  it('opening the dialog starts it, inside the press (before the dialog awaits its context)', () => {
    const open = clientFn('openNewTask');
    expect(open).toContain('ntDictateAuto();');
    expect(open.indexOf('ntDictateAuto();')).toBeLessThan(open.indexOf('await ntLoadContext();'));
  });
  it('Apple’s engine (on the device): it opens listening, at once', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.iphone });
    api.ntDictateAuto();
    expect(FakeRec.made[0]?.starts).toBe(1);
    expect(last(env.statuses)).toContain('키보드로 쓰면 멈춥니다');
  });
  it('Chrome with Korean on the device: it opens listening, on the device', async () => {
    const Rec = recClass('available');
    const { api } = page({ engine: Rec, ua: UA.chromeMac });
    api.ntDictateAuto();
    await new Promise((r) => setTimeout(r, 0)); // past Chrome's available() answer
    expect(FakeRec.made[0]?.processLocally).toBe(true);
    expect(FakeRec.made[0]?.starts).toBe(1);
  });
  it('the voice would leave the device (Galaxy, Chrome without Korean): it stays off, says nothing, asks nothing', async () => {
    for (const [ua, avail] of [
      [UA.galaxy, null],
      [UA.chromeMac, 'unavailable'],
    ] as Array<[string, string | null]>) {
      const Rec = recClass(avail);
      const { api, env, store } = page({ engine: Rec, ua });
      api.ntDictateAuto();
      await new Promise((r) => setTimeout(r, 0)); // past Chrome's available() answer
      expect(FakeRec.made).toHaveLength(0);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(api.__peek('_ntDictationAsked')).toBe(false);
      expect(store.has('soma-nt-dictation-remote')).toBe(false);
      expect(env.statuses.every((t) => !t.includes('기기 밖'))).toBe(true);
    }
  });
  it('a refused microphone ends the automatic start for this page (no prompt on every open)', async () => {
    const Rec = recClass(null);
    const { api } = page({ engine: Rec, ua: UA.iphone });
    api.ntDictateAuto();
    const rec = FakeRec.made[0];
    rec.onerror?.({ error: 'not-allowed' });
    rec.end();
    expect(api.__peek('_ntDictationAutoOff')).toBe(true);
    api.ntDictateAuto();
    expect(FakeRec.made).toHaveLength(1);
  });
  it('a key typed stops it hard and the typing goes on (the composer’s ui-input)', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.iphone });
    api.ntDictateAuto();
    const rec = FakeRec.made[0];
    rec.say([interim('말하다가')]);
    env.composer.value = '말하다가 ㅌ'; // the key the person typed
    api.ntDictateStopIn('nt'); // what ntInit's ui-input listener does
    rec.say([final('말하다가 늦은 말')]);
    expect(env.composer.value).toBe('말하다가 ㅌ');
    expect(rec.aborts).toBe(1);
  });
  it('the context loading clears its own line, not the listening one', () => {
    const load = clientFn('ntLoadContext');
    expect(load).not.toContain("ntSetStatus('');");
    expect(load).toContain('ntSetStatus(ntDictationLive());');
  });
});

describe('I1.4 — the dialog wires the stops; a live dictation counts as unsent input', () => {
  it('ui-tool starts and stops it; typing, sending and closing stop it hard', () => {
    const init = clientFn('ntInit');
    expect(init).toContain("composer.addEventListener('ui-tool', ntOnComposerTool);");
    expect(init).toMatch(/addEventListener\('ui-input', function \(e\) \{\n\s+ntDictateStopIn\('nt'\);/);
    expect(init).toMatch(
      /addEventListener\('ui-submit', function \(e\) \{\n\s+e\.preventDefault\(\);\n\s+ntDictateStopIn\('nt'\);/,
    );
    expect(clientFn('ntQuietComposer')).toContain("ntDictateStopIn('nt');");
  });
  it('the session panel: its ui-tool and typing are wired; sending, closing and switching session stop it', () => {
    const init = clientFn('pcInit');
    expect(init).toContain(
      "host.addEventListener('ui-tool', function(e) { ntOnComposerTool(e, ntDictationHost('pc')); });",
    );
    expect(init).toContain("host.addEventListener('ui-input', function() { ntDictateStopIn('pc'); });");
    for (const fn of ['pcOnSubmit', 'pcReset', 'pcFreshSteer'])
      expect(clientFn(fn), fn).toContain("ntDictateStopIn('pc');");
    expect(clientFn('pcPaintComposer')).toContain("pcComposerSetup(document.getElementById('pc-composer')");
  });
  it('a new build does not reload the tab mid-sentence', () => {
    expect(clientFn('hasUnsentInput')).toContain('if (_ntDictation) return true;');
  });
});

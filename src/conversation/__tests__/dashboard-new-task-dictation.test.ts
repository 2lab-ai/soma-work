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
  static deaf = false; // an engine that never opens the microphone (no audiostart)
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
  onaudiostart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  constructor() {
    FakeRec.made.push(this);
  }
  start() {
    this.starts++;
    if (!FakeRec.deaf) this.onaudiostart?.(); // a real engine opens the microphone
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
  FakeRec.deaf = false;
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
    busy?: boolean;
    mic?: string; // the microphone permission navigator.permissions answers; none: it cannot say
    choice?: string; // Settings › 받아쓰기 on this device (dictation-pref.ts); default 기기 기본
    server?: unknown; // dictationServerStart (dictation-server-client.ts)
    win?: Record<string, unknown>; // more of window (mediaDevices, WebSocket)
  } = {},
) {
  const store = new Map<string, string>();
  const errorLine = { textContent: '' };
  const composer = { value: opts.value ?? '', files: [] as unknown[] };
  const env = {
    composer,
    statuses: [] as string[],
    errors: [] as string[],
    errorLine,
    drafts: [] as string[],
    paints: 0,
    pcPaints: 0,
    toasts: [] as string[],
    pc: { value: '' },
    state: { destination: opts.destination ?? 'slack', prompt: '' },
  };
  // An iPhone by default: Apple's engine, on the device, no question asked.
  const nav: Record<string, unknown> = { userAgent: opts.ua ?? UA.iphone };
  if (opts.mic) nav.permissions = { query: async () => ({ state: opts.mic }) };
  const win: Record<string, unknown> = { navigator: nav, ...(opts.win ?? {}) };
  if (opts.engine !== undefined) win.webkitSpeechRecognition = opts.engine;
  const api = loadWith<Page>(
    [
      'ntDictationEngine',
      'ntDictationChoice',
      'ntDictationUsable',
      'ntDictateStartServer',
      'ntDictationWide',
      'ntDictationNarrow',
      'ntDictationTool',
      'ntDictationText',
      'ntJoinSpoken',
      'ntDictationRead',
      'ntDictationErrorText',
      'ntWithin',
      'ntDictationLocal',
      'ntDictationStatus',
      'ntIsAppleSpeech',
      'ntIsAndroid',
      'ntDictationDeadText',
      'ntDictateStart',
      'ntDictationHeard',
      'ntDictationAnyWords',
      'ntDictationListen',
      'ntDictationFallback',
      'ntRecordingNow',
      'ntPageHidden',
      'ntDictationWatch',
      'ntDictationMicState',
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
      dictationEngineChoice: () => opts.choice ?? 'device',
      dictationServerStart: opts.server ?? (() => { throw new Error('the server engine was not chosen'); }),
      _ntDictation: null,
      _ntDictationAutoOff: false,
      _ntDictationError: '',
      _recording: [] as unknown[],
      _pcSending: false,
      PC_LIMITS: { maxFiles: 10, maxFileBytes: 1, maxTotalBytes: 2 },
      PC_NO_FILES: 'application/x-soma-no-attachments',
      document: {
        visibilityState: 'visible',
        getElementById: (id: string) => (id === 'pc-composer' ? env.pc : null),
      },
      NT_DICTATION_HIDDEN: '다른 화면으로 가서 받아쓰기를 멈췄습니다 — 다시 누르면 이어서 받아씁니다',
      dashToast: (input: { title: string }) => env.toasts.push(input.title),
      pcPaintComposer: () => {
        env.pcPaints++;
      },
      NT_DICTATION_LANG: 'ko-KR',
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
      ntEl: (id: string) => (id === 'nt-composer' ? composer : id === 'nt-error' ? errorLine : null),
      ntSetStatus: (t: string) => env.statuses.push(t || ''),
      ntSetError: (t: string) => {
        errorLine.textContent = t || '';
        env.errors.push(t || '');
      },
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
  it('on a Galaxy it names what to turn on there (Google’s speech app, the browser’s mic permission)', () => {
    const errOn = (code: string) =>
      new Function(`${clientFn('ntDictationErrorText')}; return ntDictationErrorText;`)()(code, true);
    expect(errOn('service-not-allowed')).toContain('Google 음성 인식 및 합성');
    expect(errOn('service-not-allowed')).not.toContain('iPhone');
    expect(errOn('not-allowed')).toContain('마이크');
    expect(errOn('not-allowed')).toContain('권한');
    expect(errOn('language-not-supported')).toContain('한국어');
    expect(errOn('no-speech')).toBe('');
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
        [
          'ntComposerData',
          'ntReadDraft',
          'ntDictationEngine',
          'ntDictationChoice',
          'ntDictationUsable',
          'ntDictateStartServer',
          'ntDictationTool',
          'ntDictationWide',
          'ntDictationNarrow',
          'ntDictating',
        ],
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
  it('under 360px (an older or zoomed-in phone) the send keeps only its arrow, so it does not cover 받아쓰기', () => {
    const at = (width: number, engine: unknown) =>
      loadWith<{ ntComposerData(): Record<string, any> }>(
        [
          'ntComposerData',
          'ntReadDraft',
          'ntDictationEngine',
          'ntDictationChoice',
          'ntDictationUsable',
          'ntDictateStartServer',
          'ntDictationTool',
          'ntDictationWide',
          'ntDictationNarrow',
          'ntDictating',
        ],
        {
          window: {
            navigator: { userAgent: UA.samsung },
            matchMedia: (q: string) => {
              const min = /min-width: (\d+)px/.exec(q);
              const max = /max-width: (\d+)px/.exec(q);
              return { matches: min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false };
            },
            webkitSpeechRecognition: engine,
          },
          _ntValue: '',
          _ntDictation: null,
          _ntBusy: false,
          _ntCtx: null,
          _ntState: { destination: 'slack' },
          NT_NO_FILES: 'x',
          NT_DRAFT_KEY: 'k',
          localStorage: { getItem: () => null },
        },
      ).ntComposerData();
    expect(at(320, recClass(null)).submitLabel).toBe('');
    expect(at(359, recClass(null)).submitLabel).toBe('');
    expect(at(360, recClass(null)).submitLabel).toBe('작업 시작');
    expect(at(412, recClass(null)).submitLabel).toBe('작업 시작');
    expect(at(320, undefined).submitLabel).toBe('작업 시작'); // no 받아쓰기: room as before
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
  it('where the voice leaves the device, the panel’s press says so in a toast (it has no status line)', async () => {
    const Rec = recClass('unavailable');
    const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
    await api.ntDictateStart(api.ntDictationHost('pc'));
    expect(FakeRec.made[0].starts).toBe(1);
    expect(last(env.toasts)).toContain('기기 밖');
    // A Galaxy (the phone's recogniser may use Google's servers): the toast says so too.
    const Rec3 = recClass(null);
    const p3 = page({ engine: Rec3, ua: UA.samsung });
    await p3.api.ntDictateStart(p3.api.ntDictationHost('pc'));
    expect(last(p3.env.toasts)).toContain('기기 밖');
    // On the device (Apple's engine): no toast for a press that just listens.
    const Rec2 = recClass(null);
    const p2 = page({ engine: Rec2, ua: UA.iphone });
    await p2.api.ntDictateStart(p2.api.ntDictationHost('pc'));
    expect(p2.env.toasts).toHaveLength(0);
  });
  it('its why (a refused mic) is a toast — the panel has no status line', async () => {
    const Rec = recClass(null);
    FakeRec.deaf = true; // a refused mic never opens
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

  it('a refused microphone ends it with why, on the red error line (not the small status line), and is not retried', async () => {
    const Rec = recClass(null);
    FakeRec.deaf = true; // a refused mic never opens
    const { api, env } = page({ engine: Rec });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.onerror?.({ error: 'not-allowed' });
    rec.end();
    expect(rec.starts).toBe(1);
    expect(api.__peek('_ntDictation')).toBeNull();
    expect(env.errorLine.textContent).toContain('마이크');
    expect(last(env.statuses)).toBe('');
  });

  it('real Chrome drops an utterance it never finalised when the next starts after a pause: the shown words stay', async () => {
    // Recorded from Google Chrome 156 (2026-11-01): interim only, a split into two results, then after a pause a
    // fresh list of one result — no isFinal, no end event in between.
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, value: '' });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.say([interim('대시보드 새 작업')]);
      vi.advanceTimersByTime(300);
      rec.say([interim('대시보드 새 작업 화면에서 실시간')]);
      vi.advanceTimersByTime(300);
      rec.say([interim('대시보드 새 작업 화면에서 실시간'), interim(' 받아쓰기')]);
      expect(env.composer.value).toBe('대시보드 새 작업 화면에서 실시간 받아쓰기');
      vi.advanceTimersByTime(4800); // a pause
      rec.say([interim('대')]);
      expect(env.composer.value).toBe('대시보드 새 작업 화면에서 실시간 받아쓰기 대');
      vi.advanceTimersByTime(300);
      rec.say([interim('대시보드 다시')]);
      expect(env.composer.value).toBe('대시보드 새 작업 화면에서 실시간 받아쓰기 대시보드 다시');
      // A quick revision inside one utterance is not a new one: no words doubled.
      vi.advanceTimersByTime(200);
      rec.say([interim('대시보드 다시 말해')]);
      vi.advanceTimersByTime(200);
      rec.say([interim('대시보드 다시 만해')]);
      expect(env.composer.value).toBe('대시보드 새 작업 화면에서 실시간 받아쓰기 대시보드 다시 만해');
      // A pause that only continues the same words: still one utterance.
      vi.advanceTimersByTime(2000);
      rec.say([interim('대시보드 다시 만해'), interim(' 주세요')]);
      expect(env.composer.value).toBe('대시보드 새 작업 화면에서 실시간 받아쓰기 대시보드 다시 만해 주세요');
    } finally {
      vi.useRealTimers();
    }
  });

  it('revisions are not new utterances: a revised final, a withdrawn interim, a quick 2→1 merge (astra R5, P1)', async () => {
    vi.useFakeTimers();
    try {
      const run = (steps: Array<[number, Result[]]>) => {
        const Rec = recClass(null);
        const { api, env } = page({ engine: Rec, value: '' });
        void api.ntDictateStart();
        const rec = FakeRec.made[0];
        for (const [wait, results] of steps) {
          vi.advanceTimersByTime(wait);
          rec.say(results);
        }
        return env.composer.value;
      };
      // An interim settles differently 1.5 s later — the settled first result stays: no doubling.
      expect(
        run([
          [0, [final('첫 문장.'), interim(' 파일을 삭제해')]],
          [1500, [final('첫 문장.'), final(' 파일을 삭제하지 마.')]],
        ]),
      ).toBe('첫 문장. 파일을 삭제하지 마.');
      // An interim the recogniser withdraws, after a pause: gone, and the final is not doubled.
      expect(
        run([
          [0, [final('첫 문장.'), interim(' 음')]],
          [1500, [final('첫 문장.')]],
        ]),
      ).toBe('첫 문장.');
      // Two interim results merged into one, quickly (the recorded Chrome log does this inside an utterance).
      expect(
        run([
          [0, [interim('대시보드 새 작업'), interim(' 화면')]],
          [200, [interim('대시보드 새 작업 화면에서')]],
        ]),
      ).toBe('대시보드 새 작업 화면에서');
      // astra's exact case: two interims merged and corrected in 200 ms.
      expect(
        run([
          [0, [interim('첫 문장'), interim(' 삭제해')]],
          [200, [interim('첫 문장 삭제하지 마')]],
        ]),
      ).toBe('첫 문장 삭제하지 마');
      // …and a withdrawn interim after a pause, the final kept.
      expect(
        run([
          [0, [final('첫 문장.'), interim(' 잘못 들은 말')]],
          [1500, [final('첫 문장.')]],
        ]),
      ).toBe('첫 문장.');
      // …and a 2→1 correction that is not a prefix, quickly: replaced, not doubled.
      expect(
        run([
          [0, [interim('대시보드 새 장업'), interim(' 화면')]],
          [200, [interim('대시보드 새 작업 화면')]],
        ]),
      ).toBe('대시보드 새 작업 화면');
      // A settled first result that vanishes from a fresh list: a new utterance — the shown words stay.
      expect(
        run([
          [0, [final('첫 문장.'), interim(' 둘째')]],
          [300, [interim('다음 말')]],
        ]),
      ).toBe('첫 문장. 둘째 다음 말');
    } finally {
      vi.useRealTimers();
    }
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

  // fable review R1 P3 held dictation while the task was sent — the dialog then still held that task. Since
  // SSOT 2026-11-02 T1 a launch leaves the dialog in the press: the emptied composer is the next task's.
  it('a launch on its way does not hold the next task’s dictation', async () => {
    const Rec = recClass(null);
    const { api } = page({ engine: Rec, busy: true });
    await api.ntDictateStart();
    expect(FakeRec.made).toHaveLength(1);
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
    const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
    await api.ntDictateStart();
    expect(FakeRec.asked[0]).toEqual(Q);
    expect(FakeRec.installs).toHaveLength(0);
    expect(FakeRec.made[0].processLocally).toBe(true);
    expect(FakeRec.made[0].starts).toBe(1);
    expect(last(env.statuses)).toContain('이 기기에서 처리합니다');
  });
  it('downloadable (Chrome says so until the site asks once): install() in the press; already there → local', async () => {
    const Rec = recClass('downloadable', () => Promise.resolve(true));
    const { api } = page({ engine: Rec, ua: UA.chromeMac });
    await api.ntDictateStart();
    expect(FakeRec.installs[0]).toEqual(Q);
    expect(FakeRec.made[0].processLocally).toBe(true);
  });
  it('a real download goes on in the background; this dictation runs through the browser’s service, and says so', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass('downloadable', () => new Promise<boolean>(() => {}));
      const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
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
      const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
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

describe('SSOT_5 — Samsung Internet and Chrome on a Galaxy: the first press listens ("삼성인터넷브라우저에서 작동안하잖아")', () => {
  it('Galaxy (Chrome or Samsung Internet): the press starts the phone’s recogniser at once — no second press, no question', async () => {
    for (const ua of [UA.galaxy, UA.samsung]) {
      const Rec = recClass(null);
      const { api, env, store } = page({ engine: Rec, ua });
      const run = api.ntDictateStart();
      // No await before start(): it runs inside the press.
      expect(FakeRec.made[0]?.starts).toBe(1);
      await run;
      expect(api.__peek('_ntDictation')).not.toBeNull();
      expect(last(env.statuses)).toContain('이 휴대폰의 음성 인식');
      expect(last(env.statuses)).toContain('다시 누르거나 키보드로 쓰면 멈춥니다');
      expect(store.size).toBe(0); // nothing to remember: there is no yes to give
      FakeRec.made[0].say([interim('삼성 인터넷에서 받아쓰기')]);
      expect(env.composer.value).toBe('삼성 인터넷에서 받아쓰기');
    }
  });
  it('Android listens one utterance per session (continuous is not kept there) and listens again with the words kept', async () => {
    for (const ua of [UA.galaxy, UA.samsung]) {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      expect(rec.continuous).toBe(false);
      expect(rec.interimResults).toBe(true);
      expect(rec.lang).toBe('ko-KR');
      rec.say([final('첫 문장')]);
      rec.end(); // the utterance is over: Android ends the session
      expect(rec.starts).toBe(2);
      rec.say([interim('둘째 문장')]);
      expect(env.composer.value).toBe('첫 문장 둘째 문장');
    }
  });
  it('a Galaxy Chrome that has available() is not asked: a page cannot keep Android’s recogniser on the device', async () => {
    const Rec = recClass('unavailable');
    const { api, env } = page({ engine: Rec, ua: UA.galaxy });
    await api.ntDictateStart();
    expect(FakeRec.asked).toHaveLength(0);
    expect(FakeRec.made[0].starts).toBe(1);
    expect(last(env.statuses)).toContain('이 휴대폰의 음성 인식');
  });
  it('desktop Chrome without Korean on the device: the first press starts it through the browser’s service, and says so', async () => {
    const Rec = recClass('unavailable');
    const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
    await api.ntDictateStart();
    expect(FakeRec.made[0].starts).toBe(1);
    expect(last(env.statuses)).toContain('기기 밖');
    expect(env.statuses.every((t) => !t.includes('한 번 더 누르세요'))).toBe(true);
  });
  it('a Korean model still downloading: the first press starts it now, and says the device takes over once it is in', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass('downloadable', () => new Promise<boolean>(() => {}));
      const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
      const run = api.ntDictateStart();
      await vi.advanceTimersByTimeAsync(1600);
      await run;
      expect(FakeRec.made[0].starts).toBe(1);
      expect(last(env.statuses)).toContain('내려받는 중');
    } finally {
      vi.useRealTimers();
    }
  });
  it('Google’s speech app turned off (service-not-allowed): the red error line says what to turn on, and it is not retried', async () => {
    for (const ua of [UA.galaxy, UA.samsung]) {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.onerror?.({ error: 'service-not-allowed' });
      rec.end();
      expect(rec.starts).toBe(1);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(env.errorLine.textContent).toContain('Google 음성 인식 및 합성');
    }
    // An iPhone keeps its own guidance (Settings › General › Keyboard).
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.iphone });
    await api.ntDictateStart();
    FakeRec.made[0].onerror?.({ error: 'service-not-allowed' });
    FakeRec.made[0].end();
    expect(env.errorLine.textContent).toContain('iPhone');
  });
  it('a recogniser that never opens the microphone: after two sessions the red line says so — not "말이 들리지 않아"', async () => {
    for (const ua of [UA.samsung, UA.chromeMac]) {
      const Rec = recClass(ua === UA.chromeMac ? 'unavailable' : null);
      FakeRec.deaf = true;
      const { api, env } = page({ engine: Rec, ua });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.end();
      rec.end();
      expect(rec.starts).toBe(2);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(env.errorLine.textContent).toContain('마이크를 열지 못했습니다');
      expect(env.statuses.every((t) => !t.includes('들리지 않아'))).toBe(true);
    }
  });
  it('sound heard but no words back, three sessions (a noisy room, or Samsung Internet showing "듣는 중" with no text): it stops saying what to try', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.samsung });
    api.ntDictateAuto();
    const rec = FakeRec.made[0];
    rec.onspeechstart?.(); // an utterance it could not match (a nomatch event, then the end)
    rec.end();
    rec.end(); // a silent one in between
    expect(api.__peek('_ntDictation')).not.toBeNull();
    rec.onspeechstart?.();
    rec.end();
    expect(rec.starts).toBe(3);
    expect(api.__peek('_ntDictation')).toBeNull();
    expect(last(env.statuses)).toContain('글자로 바뀐 것이 없어');
    expect(last(env.statuses)).toContain('Chrome');
    expect(env.statuses.every((t) => !t.includes('들리지 않아'))).toBe(true);
    // Not a broken recogniser for sure (a noisy room does this too): the red line stays clear, and the new task still
    // opens listening next time (grok review P1).
    expect(env.errorLine.textContent).toBe('');
    expect(api.__peek('_ntDictationAutoOff')).toBe(false);
  });
  it('words in between reset the run: empty sessions after words start counting again', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.samsung });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.onspeechstart?.();
    rec.end();
    rec.onspeechstart?.();
    rec.end();
    rec.say([final('들렸다')]);
    rec.end();
    rec.end();
    rec.end();
    expect(api.__peek('_ntDictation')).not.toBeNull();
    expect(rec.starts).toBe(6);
    rec.end(); // three silent ones since the words — silence, said as silence
    expect(api.__peek('_ntDictation')).toBeNull();
    expect(last(env.statuses)).toContain('들리지 않아');
  });
  it('a recogniser that never answers at all (Android shows a toast, no event reaches the page): after 12 s the red line says so', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      FakeRec.deaf = true;
      const { api, env } = page({ engine: Rec, ua: UA.samsung, mic: 'granted' });
      api.ntDictateAuto();
      const rec = FakeRec.made[0];
      // Before the mic ever opened it waits once more (iOS asks for speech recognition separately): 24 s.
      await vi.advanceTimersByTimeAsync(23000);
      expect(api.__peek('_ntDictation')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1500);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(rec.aborts).toBe(1);
      expect(env.errorLine.textContent).toContain('마이크를 열지 못했습니다');
      expect(api.__peek('_ntDictationAutoOff')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('while the browser still asks for the microphone (prompt) it waits — a late yes listens on (fable review P1)', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      FakeRec.deaf = true;
      const { api, env } = page({ engine: Rec, ua: UA.samsung, mic: 'prompt' });
      api.ntDictateAuto();
      const rec = FakeRec.made[0];
      await vi.advanceTimersByTimeAsync(40000); // the person reads the prompt
      expect(api.__peek('_ntDictation')).not.toBeNull();
      expect(rec.aborts).toBe(0);
      rec.onaudiostart?.(); // the yes: the microphone opens
      rec.say([interim('늦게 허용했다')]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(api.__peek('_ntDictation')).not.toBeNull();
      expect(env.composer.value).toBe('늦게 허용했다');
      expect(env.errorLine.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
  it('a prompt left unanswered for a minute ends it saying so — not "broken" — without turning the automatic start off', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      FakeRec.deaf = true;
      const { api, env } = page({ engine: Rec, ua: UA.samsung, mic: 'prompt' });
      api.ntDictateAuto();
      await vi.advanceTimersByTimeAsync(61000);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(last(env.statuses)).toContain('마이크 허용을 기다리다');
      expect(env.errorLine.textContent).toBe('');
      expect(api.__peek('_ntDictationAutoOff')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('a browser that cannot say waits once more the first time (24 s), then ends it without turning the automatic start off', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      FakeRec.deaf = true;
      const { api, env } = page({ engine: Rec, ua: UA.samsung });
      api.ntDictateAuto();
      await vi.advanceTimersByTimeAsync(13000);
      expect(api.__peek('_ntDictation')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(12000);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(env.errorLine.textContent).toContain('마이크를 열지 못했습니다');
      expect(api.__peek('_ntDictationAutoOff')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('a denied microphone the recogniser never reported: the red line names the permission', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      FakeRec.deaf = true;
      const { api, env } = page({ engine: Rec, ua: UA.samsung, mic: 'denied' });
      await api.ntDictateStart();
      await vi.advanceTimersByTimeAsync(24500);
      expect(env.errorLine.textContent).toContain('권한');
    } finally {
      vi.useRealTimers();
    }
  });
  it('once the mic has opened, a later session whose audiostart is late (under 30 s) is not cut off (grok R2 P1)', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua: UA.samsung, mic: 'granted' });
      api.ntDictateAuto();
      const rec = FakeRec.made[0];
      rec.say([final('첫 문장')]);
      FakeRec.deaf = true; // the next session's audiostart lags (the speech service coming back)
      rec.end();
      expect(rec.starts).toBe(2);
      await vi.advanceTimersByTimeAsync(25000);
      expect(api.__peek('_ntDictation')).not.toBeNull();
      expect(rec.aborts).toBe(0);
      expect(env.errorLine.textContent).toBe('');
      expect(api.__peek('_ntDictationAutoOff')).toBe(false);
      // Nor do two sessions that end before their audiostart: a silent run, not a broken recogniser.
      rec.end();
      expect(api.__peek('_ntDictation')).not.toBeNull();
      expect(env.errorLine.textContent).toBe('');
      rec.onaudiostart?.();
      rec.say([interim('늦게 열린 둘째')]);
      expect(env.composer.value).toBe('첫 문장 늦게 열린 둘째');
    } finally {
      vi.useRealTimers();
    }
  });
  it('once the mic has opened, a restart that never answers is let go after 30 s — status line, auto-start kept (astra R5)', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua: UA.samsung, mic: 'granted' });
      api.ntDictateAuto();
      const rec = FakeRec.made[0];
      rec.say([final('첫 문장')]);
      FakeRec.deaf = true;
      rec.end(); // the restart: no event at all from here
      await vi.advanceTimersByTimeAsync(29000);
      expect(api.__peek('_ntDictation')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1500);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(rec.aborts).toBe(1);
      expect(last(env.statuses)).toContain('다시 누르면 이어서');
      expect(env.errorLine.textContent).toBe('');
      expect(api.__peek('_ntDictationAutoOff')).toBe(false);
      expect(env.composer.value).toBe('첫 문장');
    } finally {
      vi.useRealTimers();
    }
  });
  it('result events whose words are all empty (Android’s on-device recogniser sends them between words) leave the shown words alone, and an utterance that ends without a final keeps them', async () => {
    // Recorded in Chrome 109 on Android 13 with Speech Services 2024-03 (2026-11-02): empty interim results between
    // words, then nomatch and the end — no final. The shown words vanished and were lost at the end.
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.samsung });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.say([interim('')]);
    expect(env.composer.value).toBe('');
    rec.say([interim('실시간')]);
    expect(env.composer.value).toBe('실시간');
    rec.say([interim('')]);
    expect(env.composer.value).toBe('실시간');
    rec.say([interim('실시간 받아쓰기를 테스트하고 있습니다')]);
    rec.say([interim('')]);
    expect(env.composer.value).toBe('실시간 받아쓰기를 테스트하고 있습니다');
    rec.end(); // nomatch, then the end: no final came
    expect(rec.starts).toBe(2);
    rec.say([interim('다음 문장')]);
    expect(env.composer.value).toBe('실시간 받아쓰기를 테스트하고 있습니다 다음 문장');
    // The words count as heard: that session was not a silent one.
    expect(api.__peek('_ntDictation')).not.toBeNull();
  });
  it('whitespace is not words: three sessions of it still end the dictation as silence (astra, PR #719)', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua: UA.samsung });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(1500);
        rec.say([interim('   ')]);
        rec.end();
      }
      expect(rec.starts).toBe(3);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(last(env.statuses)).toContain('들리지 않아');
    } finally {
      vi.useRealTimers();
    }
  });
  it('elsewhere an empty list is a withdrawal: the withdrawn words go (astra review, PR #719)', async () => {
    const Rec = recClass('unavailable');
    const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.say([interim('파일 삭제')]);
    rec.say([]);
    expect(env.composer.value).toBe('');
    rec.end();
    rec.say([interim('다음')]);
    expect(env.composer.value).toBe('다음');
  });
  it('on Android a placeholder still moves the time on: a quick correction replaces, it is not appended (astra, PR #719)', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua: UA.samsung });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.say([interim('오늘 회의를 모두 취소해 주세요')]);
      vi.advanceTimersByTime(1000);
      rec.say([interim('')]);
      vi.advanceTimersByTime(400);
      rec.say([final('아니요')]);
      expect(env.composer.value).toBe('아니요');
    } finally {
      vi.useRealTimers();
    }
  });
  it('on Android an empty result after a pause is still the boundary between utterances (astra, PR #719)', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua: UA.samsung });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.say([interim('첫 문장')]);
      vi.advanceTimersByTime(1500);
      rec.say([interim('')]);
      expect(env.composer.value).toBe('첫 문장');
      vi.advanceTimersByTime(300);
      rec.say([interim('다음 문장으로 넘어갑니다')]);
      expect(env.composer.value).toBe('첫 문장 다음 문장으로 넘어갑니다');
    } finally {
      vi.useRealTimers();
    }
  });
  it('a recogniser that answers is not cut off by that timer, in any session', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api } = page({ engine: Rec, ua: UA.samsung });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.say([final('첫 문장')]);
      rec.end();
      vi.advanceTimersByTime(30000);
      expect(api.__peek('_ntDictation')).not.toBeNull();
      expect(rec.aborts).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('Android refusing a restart (its recogniser still busy → not-allowed): one more try after a moment, words kept', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua: UA.samsung });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.say([final('첫 문장')]);
      rec.end(); // session 2
      rec.onerror?.({ error: 'not-allowed' });
      rec.end();
      expect(api.__peek('_ntDictation')).not.toBeNull();
      expect(rec.starts).toBe(2);
      vi.advanceTimersByTime(500);
      expect(rec.starts).toBe(3);
      rec.say([final('둘째')]);
      expect(env.composer.value).toBe('첫 문장 둘째');
      expect(env.errorLine.textContent).toBe('');
      // Words in between: a later refusal gets its one more try again.
      rec.end(); // session 4
      rec.onerror?.({ error: 'not-allowed' });
      rec.end();
      vi.advanceTimersByTime(500);
      expect(rec.starts).toBe(5);
      // Refused again right away, no words in between: that is the permission (revoked mid-way) — the red line names
      // it; the words stay.
      rec.onerror?.({ error: 'not-allowed' });
      rec.end();
      vi.advanceTimersByTime(1000);
      expect(rec.starts).toBe(5);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(env.errorLine.textContent).toContain('권한');
      expect(env.composer.value).toBe('첫 문장 둘째');
    } finally {
      vi.useRealTimers();
    }
  });
  it('a hard stop during that moment cancels the retry', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api } = page({ engine: Rec, ua: UA.galaxy });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.say([final('첫 문장')]);
      rec.end();
      rec.onerror?.({ error: 'not-allowed' });
      rec.end();
      api.ntDictateStop(true);
      vi.advanceTimersByTime(1000);
      expect(rec.starts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('another error already on the red line (the context failed to load) stays; the dictation’s why goes on the status line (fable P3)', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.galaxy });
    env.errorLine.textContent = '새 작업 정보를 불러오지 못했습니다';
    await api.ntDictateStart();
    FakeRec.made[0].onerror?.({ error: 'network' });
    FakeRec.made[0].end();
    expect(env.errorLine.textContent).toBe('새 작업 정보를 불러오지 못했습니다');
    expect(last(env.statuses)).toContain('연결');
    await api.ntDictateStart();
    expect(env.errorLine.textContent).toBe('새 작업 정보를 불러오지 못했습니다');
  });
  it('Android refusing the very first start (the dropped dictation still releasing the recogniser): one more try, not "no permission"', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      FakeRec.deaf = true;
      const { api, env } = page({ engine: Rec, ua: UA.samsung });
      api.ntDictateAuto();
      const rec = FakeRec.made[0];
      rec.onerror?.({ error: 'not-allowed' });
      rec.end();
      expect(api.__peek('_ntDictationAutoOff')).toBe(false);
      FakeRec.deaf = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(rec.starts).toBe(2);
      rec.say([interim('두 번째에 열렸다')]);
      expect(env.composer.value).toBe('두 번째에 열렸다');
      expect(env.errorLine.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
  it('an error with no end after it (Edge can go silent): the dictation lets go after 3 s, saying why', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
      await api.ntDictateStart();
      FakeRec.made[0].onerror?.({ error: 'network' });
      expect(api.__peek('_ntDictation')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(3100);
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(env.errorLine.textContent).toContain('연결');
      FakeRec.made[0].end(); // a late end changes nothing
      expect(FakeRec.made[0].starts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('an end that does come is not played twice by that fallback (no double restart)', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api } = page({ engine: Rec, ua: UA.samsung });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.say([final('첫 문장')]);
      rec.end(); // session 2
      rec.onerror?.({ error: 'not-allowed' }); // busy: retry armed, fallback armed
      rec.end();
      await vi.advanceTimersByTimeAsync(3500);
      expect(rec.starts).toBe(3); // the retry once, not again by the fallback
    } finally {
      vi.useRealTimers();
    }
  });
  it('the page goes to the background (Android aborts, then refuses a restart as not-allowed): it stops quietly, not "no permission"', async () => {
    for (const refusal of [true, false]) {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua: UA.samsung });
      api.ntDictateAuto();
      const rec = FakeRec.made[0];
      rec.say([final('나가기 전 말')]);
      api.__peek('document.visibilityState = "hidden"');
      rec.onerror?.({ error: 'aborted' }); // Blink aborts a hidden page's recognition
      if (refusal) rec.onerror?.({ error: 'not-allowed' });
      rec.end();
      expect(rec.starts).toBe(1); // no restart on a hidden page
      expect(api.__peek('_ntDictation')).toBeNull();
      expect(last(env.statuses)).toContain('다시 누르면 이어서');
      expect(env.errorLine.textContent).toBe('');
      expect(api.__peek('_ntDictationAutoOff')).toBe(false);
      expect(env.composer.value).toBe('나가기 전 말');
    }
  });
  it('desktop Chrome keeps listening in a background tab: a session that ends there restarts; its errors are its own (fable R2 P2)', async () => {
    const Rec = recClass('unavailable');
    const { api, env } = page({ engine: Rec, ua: UA.chromeMac });
    await api.ntDictateStart();
    const rec = FakeRec.made[0];
    rec.say([final('긴 지시 앞부분')]);
    api.__peek('document.visibilityState = "hidden"'); // the person reads a spec in another tab
    rec.end(); // Chrome ends the session by itself after a while
    expect(rec.starts).toBe(2);
    rec.say([interim('뒷부분')]);
    expect(env.composer.value).toBe('긴 지시 앞부분 뒷부분');
    rec.onerror?.({ error: 'network' });
    rec.end();
    expect(env.errorLine.textContent).toContain('연결');
    // Aborted by the browser while hidden: that one stops quietly.
    const Rec2 = recClass('unavailable');
    const p2 = page({ engine: Rec2, ua: UA.chromeMac });
    await p2.api.ntDictateStart();
    p2.api.__peek('document.visibilityState = "hidden"');
    FakeRec.made[0].onerror?.({ error: 'aborted' });
    FakeRec.made[0].end();
    expect(FakeRec.made[0].starts).toBe(1);
    expect(last(p2.env.statuses)).toContain('다시 누르면 이어서');
  });
  it('a soft stop in the moment before Android’s retry lets go at once (no session to settle)', async () => {
    vi.useFakeTimers();
    try {
      const Rec = recClass(null);
      const { api } = page({ engine: Rec, ua: UA.samsung });
      await api.ntDictateStart();
      const rec = FakeRec.made[0];
      rec.say([final('첫 문장')]);
      rec.end();
      rec.onerror?.({ error: 'not-allowed' }); // busy: the retry waits 400 ms
      rec.end();
      api.ntOnComposerTool({ detail: { id: 'dictate', pressed: false } });
      expect(api.__peek('_ntDictation')).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      expect(rec.starts).toBe(2); // the retry did not start after the stop
    } finally {
      vi.useRealTimers();
    }
  });
  it('a manual press while a voice note records: it says so and leaves the microphone to the voice note', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.samsung });
    api.__peek('_recording.push({ id: "pc-composer", isConnected: true })');
    await api.ntDictateStart();
    expect(FakeRec.made).toHaveLength(0);
    expect(last(env.statuses)).toContain('음성 녹음 중');
    // A composer swapped out mid-recording (its cancel never arrives) does not hold the microphone for good.
    api.__peek('_recording[0].isConnected = false');
    await api.ntDictateStart();
    expect(FakeRec.made).toHaveLength(1);
  });
  it('a broken recogniser found by a manual press also stops the automatic start (fable/astra P3)', async () => {
    const Rec = recClass(null);
    FakeRec.deaf = true;
    const { api } = page({ engine: Rec, ua: UA.samsung });
    await api.ntDictateStart(api.ntDictationHost('pc'));
    FakeRec.made[0].end();
    FakeRec.made[0].end();
    expect(api.__peek('_ntDictationAutoOff')).toBe(true);
  });
  it('a new press clears the dictation’s own error line, and leaves any other error alone', async () => {
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.galaxy });
    await api.ntDictateStart();
    FakeRec.made[0].onerror?.({ error: 'network' });
    FakeRec.made[0].end();
    expect(env.errorLine.textContent).toContain('연결');
    await api.ntDictateStart();
    expect(env.errorLine.textContent).toBe('');
    env.errorLine.textContent = '전송 실패 — 다시 시도해 주세요'; // the send's own error
    api.ntDictateStop(true);
    await api.ntDictateStart();
    expect(env.errorLine.textContent).toBe('전송 실패 — 다시 시도해 주세요');
  });
});

describe('SSOT_4 — with speech recognition on this device the new task opens listening; a key typed stops it', () => {
  it('opening the dialog starts it, inside the press (before the dialog awaits its context)', () => {
    const open = clientFn('openNewTask');
    expect(open).toContain('ntDictateAuto();');
    expect(open.indexOf('ntDictateAuto();')).toBeLessThan(open.indexOf('await ntLoadContext();'));
  });
  it('a dictation running in the session panel stops when the new task opens over it (astra R3, P1)', async () => {
    const open = clientFn('openNewTask');
    expect(open).toContain("ntDictateStopIn('pc');");
    expect(open.indexOf("ntDictateStopIn('pc');")).toBeLessThan(open.indexOf('ntDictateAuto();'));
    // …so the automatic start then takes the microphone for the new task.
    const Rec = recClass(null);
    const { api, env } = page({ engine: Rec, ua: UA.iphone });
    await api.ntDictateStart(api.ntDictationHost('pc'));
    api.ntDictateStopIn('pc'); // what openNewTask does first
    api.ntDictateAuto();
    expect(FakeRec.made[0].aborts).toBe(1);
    expect(FakeRec.made).toHaveLength(2);
    FakeRec.made[1].say([interim('새 작업으로 말한 지시')]);
    expect(env.composer.value).toBe('새 작업으로 말한 지시');
    expect(env.pc.value).toBe('');
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
  it('a Galaxy (Chrome or Samsung Internet): the phone’s recogniser — it opens listening, at once', async () => {
    for (const ua of [UA.galaxy, UA.samsung]) {
      const Rec = recClass(null);
      const { api, env } = page({ engine: Rec, ua });
      api.ntDictateAuto();
      expect(FakeRec.made[0]?.starts).toBe(1);
      expect(last(env.statuses)).toContain('이 휴대폰의 음성 인식');
    }
  });
  it('a Galaxy whose speech app is off: the opening shows why once on the red line, and stops opening listening', async () => {
    const Rec = recClass(null);
    FakeRec.deaf = true; // the recogniser is refused before the mic opens
    const { api, env } = page({ engine: Rec, ua: UA.samsung });
    api.ntDictateAuto();
    FakeRec.made[0].onerror?.({ error: 'service-not-allowed' });
    FakeRec.made[0].end();
    expect(env.errorLine.textContent).toContain('Google 음성 인식 및 합성');
    expect(api.__peek('_ntDictationAutoOff')).toBe(true);
    api.ntDictateAuto();
    expect(FakeRec.made).toHaveLength(1);
  });
  it('a recogniser that never opens the mic ends the automatic start for this page too', async () => {
    const Rec = recClass(null);
    FakeRec.deaf = true;
    const { api } = page({ engine: Rec, ua: UA.samsung });
    api.ntDictateAuto();
    FakeRec.made[0].end();
    FakeRec.made[0].end();
    expect(api.__peek('_ntDictationAutoOff')).toBe(true);
  });
  it('not while a voice note is recording (one microphone — the voice note keeps it)', async () => {
    const Rec = recClass(null);
    const { api } = page({ engine: Rec, ua: UA.samsung });
    api.__peek('_recording.push({ id: "pc-composer" })');
    api.ntDictateAuto();
    expect(FakeRec.made).toHaveLength(0);
    api.__peek('_recording.length = 0');
    api.ntDictateAuto();
    expect(FakeRec.made).toHaveLength(1);
  });
  it('the dialog repaints both composers when the width crosses 360px or 640px (rotation, a Fold opening)', () => {
    const init = clientFn('ntInit');
    expect(init).toContain("['(max-width: 359px)', '(min-width: 640px)'].forEach(");
    expect(init).toMatch(
      /addEventListener\('change', function \(\) \{\n\s+paintNtComposer\(\);\n\s+pcPaintComposer\(\);/,
    );
  });
  it('desktop Chrome without Korean on the device (the voice would leave it): it stays off and says nothing', async () => {
    const Rec = recClass('unavailable');
    const { api, env, store } = page({ engine: Rec, ua: UA.chromeMac });
    api.ntDictateAuto();
    await new Promise((r) => setTimeout(r, 0)); // past Chrome's available() answer
    expect(FakeRec.made).toHaveLength(0);
    expect(api.__peek('_ntDictation')).toBeNull();
    expect(store.size).toBe(0);
    expect(env.statuses.every((t) => !t.includes('기기 밖'))).toBe(true);
  });
  it('a refused microphone ends the automatic start for this page (no prompt on every open)', async () => {
    const Rec = recClass(null);
    FakeRec.deaf = true; // a refused mic never opens
    const { api } = page({ engine: Rec, ua: UA.iphone });
    api.ntDictateAuto();
    const rec = FakeRec.made[0];
    rec.onerror?.({ error: 'not-allowed' });
    rec.end();
    expect(api.__peek('_ntDictationAutoOff')).toBe(true);
    api.ntDictateAuto();
    expect(FakeRec.made).toHaveLength(1);
  });
  it('a restart refused after a pause (iOS) does not end the automatic start — only a refused mic does (fable R3, P2)', async () => {
    const Rec = recClass(null);
    const { api } = page({ engine: Rec, ua: UA.iphone });
    api.ntDictateAuto();
    const rec = FakeRec.made[0];
    rec.say([final('첫 문장')]);
    rec.end(); // listens again (session 2)
    rec.onerror?.({ error: 'not-allowed' });
    rec.end();
    expect(api.__peek('_ntDictationAutoOff')).toBe(false);
  });
  it('while Chrome is asked, the context loading keeps the "준비 중" line (fable R3, P3)', async () => {
    const Rec = recClass('available');
    const { api } = page({ engine: Rec, ua: UA.chromeMac });
    api.ntDictateAuto();
    expect(api.ntDictationLive()).toBe('받아쓰기 준비 중…');
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
  it('a voice note starting to record stops the dictation of its composer (astra R3, P2 — one microphone)', () => {
    const at = TEMPLATE.indexOf("document.addEventListener('ui-record', function(e) {");
    expect(at).toBeGreaterThan(0);
    const body = TEMPLATE.slice(at, TEMPLATE.indexOf('\n});\n', at));
    // Wherever it listens — the other composer's too (astra R4: a voice note whose mic prompt was open as the new
    // task opened listening).
    expect(body).toContain('if (_ntDictation) ntDictateStop(true);');
  });
  it('a new build does not reload the tab mid-sentence', () => {
    expect(clientFn('hasUnsentInput')).toContain('if (_ntDictation) return true;');
  });
});

// ── 서버 위스퍼 (epic #737, #739) ─────────────────────────────────────

type Srv = {
  cb: { onReady(m: string): void; onText(f: string, i: string): void; onError(c: string, m: string): void; onDone(f: string): void };
  stops: number;
  aborts: number;
};
function serverFake() {
  const made: Srv[] = [];
  const start = vi.fn((cb: Srv['cb']) => {
    const s: Srv = { cb, stops: 0, aborts: 0 };
    made.push(s);
    return { stop: () => s.stops++, abort: () => s.aborts++ };
  });
  return { start, made };
}

describe('#739 — 받아쓰기 through the server’s Whisper when this device chose it', () => {
  it('streams through the server: ready → the words as they settle → a press finishes → the tool lets go', async () => {
    const fake = serverFake();
    const { api, env } = page({ choice: 'server', server: fake.start, value: '메모: ' });
    await api.ntDictateStart();
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(last(env.statuses)).toBe('서버 위스퍼 준비 중…');
    const s = fake.made[0];
    s.cb.onReady('large-v3-turbo');
    expect(last(env.statuses)).toBe('듣는 중… 서버 위스퍼(large-v3-turbo)로 처리합니다 · 다시 누르거나 키보드로 쓰면 멈춥니다');
    s.cb.onText('', '대시보드 새');
    expect(env.composer.value).toBe('메모: 대시보드 새');
    s.cb.onText('대시보드 새 작업', '화면에서');
    expect(env.composer.value).toBe('메모: 대시보드 새 작업 화면에서');
    expect(last(env.drafts)).toBe('메모: 대시보드 새 작업 화면에서');
    api.ntDictateStop(false);
    expect(s.stops).toBe(1);
    expect(api.__peek('_ntDictation')).not.toBeNull(); // the last words are still coming
    s.cb.onText('대시보드 새 작업 화면에서 실시간', '');
    s.cb.onDone('대시보드 새 작업 화면에서 실시간');
    expect(env.composer.value).toBe('메모: 대시보드 새 작업 화면에서 실시간');
    expect(api.__peek('_ntDictation')).toBeNull();
  });

  it('a key typed (hard stop) drops what is still coming at once', async () => {
    const fake = serverFake();
    const { api, env } = page({ choice: 'server', server: fake.start });
    await api.ntDictateStart();
    fake.made[0].cb.onText('하나', '둘');
    api.ntDictateStop(true);
    expect(fake.made[0].aborts).toBe(1);
    expect(api.__peek('_ntDictation')).toBeNull();
    fake.made[0].cb.onText('하나 둘 셋', '');
    expect(env.composer.value).toBe('하나 둘');
  });

  it('a server that never confirms the finish does not hold the tool', async () => {
    vi.useFakeTimers();
    try {
      const fake = serverFake();
      const { api } = page({ choice: 'server', server: fake.start });
      await api.ntDictateStart();
      api.ntDictateStop(false);
      vi.advanceTimersByTime(4000);
      expect(fake.made[0].aborts).toBe(1);
      expect(api.__peek('_ntDictation')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('no Whisper on the server: the red line says why and where to switch back', async () => {
    const fake = serverFake();
    const { api, env } = page({ choice: 'server', server: fake.start });
    await api.ntDictateStart();
    fake.made[0].cb.onError('unavailable', '이 서버에는 위스퍼가 없습니다');
    expect(env.errorLine.textContent).toBe('이 서버에는 위스퍼가 없습니다 — 설정 › 받아쓰기에서 기기 기본으로 바꿀 수 있습니다');
    expect(api.__peek('_ntDictation')).toBeNull();
  });

  it('a dropped connection says a press continues, off the red line', async () => {
    const fake = serverFake();
    const { api, env } = page({ choice: 'server', server: fake.start });
    await api.ntDictateStart();
    fake.made[0].cb.onReady('large-v3-turbo');
    fake.made[0].cb.onError('closed', '서버 위스퍼 연결이 끊겼습니다 — 다시 누르면 이어서 받아씁니다');
    expect(env.errorLine.textContent).toBe('');
    expect(last(env.statuses)).toBe('서버 위스퍼 연결이 끊겼습니다 — 다시 누르면 이어서 받아씁니다');
  });

  it('works without a browser recogniser (Firefox) — the tool shows when the microphone can stream', async () => {
    const fake = serverFake();
    const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
    const media = { mediaDevices: { getUserMedia: () => Promise.resolve({}) } };
    const { api } = page({ choice: 'server', server: fake.start, ua: firefox, win: { WebSocket: function () {} } });
    // navigator is built by page(): give it the microphone
    Object.assign(api.__peek('window').navigator, media);
    expect(api.ntComposerData().tools?.[0]?.id).toBe('dictate');
    await api.ntDictateStart();
    expect(fake.start).toHaveBeenCalledTimes(1);
    const none = page({ choice: 'device', ua: firefox });
    expect(none.api.ntComposerData().tools).toBeUndefined();
  });

  it('the new task opens listening through the server too (the person chose it)', () => {
    const fake = serverFake();
    const { api } = page({ choice: 'server', server: fake.start });
    api.ntDictateAuto();
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it('the device engine stays the default', async () => {
    const fake = serverFake();
    const { api } = page({ engine: FakeRec, server: fake.start });
    await api.ntDictateStart();
    expect(fake.start).not.toHaveBeenCalled();
    expect(FakeRec.made.length).toBeGreaterThan(0);
  });
});

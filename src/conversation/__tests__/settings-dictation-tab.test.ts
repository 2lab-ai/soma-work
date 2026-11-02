/**
 * The settings page's 받아쓰기 tab (SSOT 2026-11-02, epic #737, #738) — its client script, run as shipped
 * (DICTATION_PREF_JS + DICTATION_CLIENT_JS) against fakes.
 *
 *   D1  the engine choice lives in this browser only — default 기기 기본, never sent anywhere
 *   D2  browser and system from the user-agent string (Chromium's frozen versions left out)
 *   D3  the 기기 기본 recogniser path is the dashboard's own split (ntDictationEngine · ntIsAppleSpeech · ntIsAndroid)
 *   D4  Chrome's on-device model per language; no answer, a failure and a slow answer each say so
 *   D5  this device's details, with client hints, WebGPU and the microphone permission
 *   D6  which engines this device can run, and the one 받아쓰기 falls back to
 *   D7  the settings page carries the tab
 *   D8  말해서 시험: the words while they are said, the time to the first word, or why nothing came
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DICTATION_ENGINE_KEY, DICTATION_PREF_JS } from '../dictation-pref';
import { DICTATION_CLIENT_JS, DICTATION_TAB_HTML } from '../settings-dictation-tab';
import { renderSettingsPage, SETTINGS_TABS } from '../settings-page';

type AnyFn = (...a: any[]) => any;
type Api = Record<string, AnyFn>;

function memStore(init: Record<string, string> = {}) {
  const data = { ...init };
  return {
    data,
    getItem: vi.fn((k: string) => (k in data ? data[k] : null)),
    setItem: vi.fn((k: string, v: string) => {
      data[k] = String(v);
    }),
  };
}

type El = Record<string, any>;
function fakeEl(id: string): El {
  return {
    id,
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    classList: {
      on: new Set<string>(),
      toggle(c: string, v: boolean) {
        v ? this.on.add(c) : this.on.delete(c);
      },
    },
    closest() {
      return null;
    },
    addEventListener() {},
  };
}
function fakeDoc() {
  const els: Record<string, El> = {};
  const el = (id: string) => (els[id] ??= fakeEl(id));
  const inputs = ['device', 'server', 'browser'].map((v) =>
    Object.assign(fakeEl('in-' + v), { value: v, name: 'dic-engine' }),
  );
  const whys: Record<string, El> = {};
  return {
    els,
    el,
    inputs,
    whys,
    getElementById: (id: string) => (id === 'dic-root' ? null : el(id)),
    querySelectorAll: (sel: string) => (sel === 'input[name="dic-engine"]' ? inputs : []),
    querySelector: (sel: string) => {
      const m = sel.match(/data-why="(\w+)"/);
      return m ? (whys[m[1]] ??= fakeEl('why-' + m[1])) : null;
    },
  };
}

/** The tab's script with the page's esc(), sharing one scope with a fake window and document. */
function load(win: Record<string, any> = {}, doc: Record<string, any> = fakeDoc()): Api {
  const body = `var window = __w, document = __d;
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
${DICTATION_PREF_JS}
${DICTATION_CLIENT_JS}
return { dictationEngineChoice, dictationSaveEngine, dicBrowser, dicOs, dicPath, dicLangState, dicMicState, dicInfo,
  dicEngines, dicEffective, dicInfoRows, dicPaintEngines, dicChoose, dicTestText, dicTestSummary, dicTestStart,
  __peek: function (k) { return eval(k); } };`;
  return new Function('__w', '__d', body)(win, doc) as Api;
}

// The dashboard's own split, cut out of renderDashboardPage()'s template as the browser receives it.
const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
function dashboardFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  const fragment = TEMPLATE.slice(start + 1, end + 2);
  return new Function(`return \`${fragment}\`;`)() as string;
}
const dashboard = new Function(
  `${['ntDictationEngine', 'ntIsAppleSpeech', 'ntIsAndroid'].map(dashboardFn).join('\n')}
return { ntDictationEngine, ntIsAppleSpeech, ntIsAndroid };`,
)() as Api;

const UA = {
  samsung:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.1 Chrome/136.0.0.0 Mobile Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
};

class FakeRec {
  static made: FakeRec[] = [];
  static available?: AnyFn;
  lang = '';
  interimResults = false;
  continuous = true;
  maxAlternatives = 0;
  processLocally: boolean | undefined;
  started = 0;
  stopped = 0;
  onresult: AnyFn | null = null;
  onerror: AnyFn | null = null;
  onend: AnyFn | null = null;
  constructor() {
    FakeRec.made.push(this);
  }
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
    this.onend?.();
  }
}
const res = (t: string, isFinal = false) => Object.assign([{ transcript: t }], { isFinal });

afterEach(() => {
  FakeRec.made = [];
  vi.useRealTimers();
});

describe('D1 — the engine choice lives in this browser only', () => {
  it('defaults to 기기 기본, reads a chosen engine, and treats anything else as the default', () => {
    const api = load();
    expect(api.dictationEngineChoice(memStore())).toBe('device');
    expect(api.dictationEngineChoice(memStore({ [DICTATION_ENGINE_KEY]: 'server' }))).toBe('server');
    expect(api.dictationEngineChoice(memStore({ [DICTATION_ENGINE_KEY]: 'browser' }))).toBe('browser');
    expect(api.dictationEngineChoice(memStore({ [DICTATION_ENGINE_KEY]: 'whisper-xl' }))).toBe('device');
    expect(api.dictationEngineChoice(null)).toBe('device');
    const refusing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(api.dictationEngineChoice(refusing)).toBe('device');
  });

  it('keeps a choice under one key and refuses what is not an engine', () => {
    const api = load();
    const store = memStore();
    expect(api.dictationSaveEngine(store, 'server')).toBe(true);
    expect(store.data).toEqual({ 'soma-dictation-engine': 'server' });
    expect(api.dictationSaveEngine(store, 'cloud')).toBe(false);
    expect(store.data).toEqual({ 'soma-dictation-engine': 'server' });
    const full = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(api.dictationSaveEngine(full, 'device')).toBe(false);
  });

  it('choosing in the tab writes this browser’s storage and sends nothing', () => {
    const store = memStore();
    const fetch = vi.fn();
    const doc = fakeDoc();
    const api = load({ localStorage: store, fetch, navigator: { sendBeacon: vi.fn() } }, doc);
    api.dicChoose('device');
    expect(store.setItem).toHaveBeenCalledWith('soma-dictation-engine', 'device');
    expect(fetch).not.toHaveBeenCalled();
    expect(doc.el('dic-engine-note').textContent).toContain('이 기기에 저장했습니다');
    // The tab has no request of its own: the choice is not a server setting.
    expect(DICTATION_CLIENT_JS + DICTATION_PREF_JS).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|\/api\//);
  });

  it('says so when the browser refuses to keep it', () => {
    const doc = fakeDoc();
    const api = load(
      {
        localStorage: {
          setItem: () => {
            throw new Error('denied');
          },
        },
      },
      doc,
    );
    api.dicChoose('device');
    expect(doc.el('dic-engine-note').textContent).toContain('저장을 막아');
  });
});

describe('D2 — browser and system from the user-agent string', () => {
  it.each([
    ['samsung', '삼성 인터넷', '29.1', 'Android', ''],
    ['chromeAndroid', 'Chrome', '120.0.0.0', 'Android', '13'],
    ['iphone', 'Safari', '17.5', 'iOS', '17.5'],
    ['iphoneChrome', 'Chrome (iOS)', '126.0.6478.54', 'iOS', '17.5'],
    ['ipad', 'Safari', '17.5', 'iPadOS', '17.5'],
    ['macSafari', 'Safari', '18.1', 'macOS', ''],
    ['macChrome', 'Chrome', '156.0.0.0', 'macOS', ''],
    ['edge', 'Edge', '130.0.2849.68', 'Windows', ''],
    ['firefox', 'Firefox', '132.0', 'Windows', ''],
  ] as const)('%s → %s %s on %s %s', (k, name, version, os, osVersion) => {
    const api = load();
    const nav = { userAgent: UA[k] };
    expect(api.dicBrowser(nav)).toEqual({ name, version });
    expect(api.dicOs(nav)).toEqual({ name: os, version: osVersion });
  });
});

describe('D3 — the 기기 기본 path is the dashboard’s own split', () => {
  const cases: Array<[keyof typeof UA, boolean, boolean]> = [];
  for (const k of Object.keys(UA) as Array<keyof typeof UA>)
    for (const rec of [true, false]) for (const available of [true, false]) cases.push([k, rec, available]);

  it.each(cases)('%s (recogniser %s, available() %s)', (k, rec, available) => {
    const Rec = rec ? Object.assign(function Rec() {}, available ? { available: () => 'available' } : {}) : undefined;
    const win = { navigator: { userAgent: UA[k] }, webkitSpeechRecognition: Rec };
    let expected: string;
    if (!dashboard.ntDictationEngine(win)) expected = 'none';
    else if (dashboard.ntIsAppleSpeech(win)) expected = 'apple';
    else if (dashboard.ntIsAndroid(win)) expected = 'android';
    else expected = available ? 'chrome' : 'service';
    expect(load().dicPath(win)).toBe(expected);
  });

  it('an iPhone Home Screen web app cannot use it, as on the dashboard', () => {
    const win = { navigator: { userAgent: UA.iphone, standalone: true }, webkitSpeechRecognition: function Rec() {} };
    expect(dashboard.ntDictationEngine(win)).toBeNull();
    expect(load().dicPath(win)).toBe('webapp');
  });

  it('Android from client hints alone (a reduced user-agent)', () => {
    const win = {
      navigator: { userAgent: UA.macChrome, userAgentData: { platform: 'Android' } },
      webkitSpeechRecognition: function Rec() {},
    };
    expect(dashboard.ntIsAndroid(win)).toBe(true);
    expect(load().dicPath(win)).toBe('android');
  });
});

describe('D4 — Chrome’s on-device model per language', () => {
  it('passes Chrome’s answer through, asking for that language on the device', async () => {
    const asked: unknown[] = [];
    const Rec = { available: (q: unknown) => (asked.push(q), Promise.resolve('downloadable')) };
    expect(await load().dicLangState(Rec, 'ko-KR')).toBe('downloadable');
    expect(asked).toEqual([{ langs: ['ko-KR'], processLocally: true }]);
  });

  it('unknown where the browser has no such question, or the question fails', async () => {
    const api = load();
    expect(await api.dicLangState({}, 'ko-KR')).toBe('unknown');
    expect(await api.dicLangState(null, 'ko-KR')).toBe('unknown');
    expect(await api.dicLangState({ available: () => Promise.reject(new Error('x')) }, 'ko-KR')).toBe('unknown');
    expect(
      await api.dicLangState(
        {
          available: () => {
            throw new Error('sync');
          },
        },
        'ko-KR',
      ),
    ).toBe('unknown');
  });

  it('timeout when Chrome does not answer', async () => {
    vi.useFakeTimers();
    const p = load().dicLangState({ available: () => new Promise(() => {}) }, 'ko-KR');
    await vi.advanceTimersByTimeAsync(1600);
    expect(await p).toBe('timeout');
  });
});

describe('D5 — this device’s details', () => {
  it('desktop Chrome: client hints, Korean on the device, English downloadable, WebGPU, permission', async () => {
    const Rec = Object.assign(function Rec() {}, {
      available: (q: { langs: string[] }) => Promise.resolve(q.langs[0] === 'ko-KR' ? 'available' : 'downloadable'),
    });
    const win = {
      isSecureContext: true,
      webkitSpeechRecognition: Rec,
      navigator: {
        userAgent: UA.macChrome,
        deviceMemory: 8,
        hardwareConcurrency: 18,
        userAgentData: {
          platform: 'macOS',
          getHighEntropyValues: () =>
            Promise.resolve({
              platformVersion: '15.1.0',
              model: '',
              fullVersionList: [{ brand: 'Google Chrome', version: '156.0.7500.12' }],
            }),
        },
        permissions: { query: () => Promise.resolve({ state: 'granted' }) },
        gpu: { requestAdapter: () => Promise.resolve({ info: { vendor: 'apple', architecture: 'metal-3' } }) },
      },
    };
    const api = load(win);
    const info = await api.dicInfo(win);
    expect(info).toMatchObject({
      browser: { name: 'Chrome', version: '156.0.7500.12' },
      os: { name: 'macOS', version: '15.1.0' },
      path: 'chrome',
      secure: true,
      langs: { 'ko-KR': 'available', 'en-US': 'downloadable' },
      mic: 'granted',
      gpu: { has: true, vendor: 'apple', arch: 'metal-3' },
      memory: 8,
      cores: 18,
    });
    const rows = api.dicInfoRows(info);
    const row = (label: string) => rows.find((r: string[]) => r[0] === label);
    expect(row('처리 위치')?.[1]).toContain('이 기기 안에서 처리');
    expect(row('한국어 기기용 모델')?.[1]).toBe('이 기기에 있음');
    expect(row('영어 기기용 모델')?.[3]).toBe('en-US'); // a download button
    expect(row('한국어 기기용 모델')?.[3]).toBe('');
    expect(row('WebGPU')?.[1]).toBe('있음 — apple · metal-3');
    expect(row('마이크 권한')?.[1]).toBe('허용됨');
  });

  it('Samsung Internet: the real Android version and phone model from client hints; the model name is not given', async () => {
    const win = {
      isSecureContext: true,
      webkitSpeechRecognition: function Rec() {},
      navigator: {
        userAgent: UA.samsung,
        userAgentData: {
          platform: 'Android',
          getHighEntropyValues: () =>
            Promise.resolve({
              platformVersion: '14.0.0',
              model: 'SM-S928N',
              fullVersionList: [{ brand: 'Samsung Internet', version: '29.1.2.37' }],
            }),
        },
      },
    };
    const api = load(win);
    const info = await api.dicInfo(win);
    expect(info).toMatchObject({
      browser: { name: '삼성 인터넷', version: '29.1.2.37' },
      os: { name: 'Android', version: '14.0.0' },
      model: 'SM-S928N',
      path: 'android',
    });
    expect(info.langs).toEqual({ 'ko-KR': 'unknown', 'en-US': 'unknown' });
    const rows = api.dicInfoRows(info);
    const engine = rows.find((r: string[]) => r[0] === '음성 인식기');
    expect(engine[1]).toContain('Google 음성 인식 및 합성');
    expect(engine[2]).toContain('브라우저가 페이지에 알려 주지 않습니다');
    expect(rows.find((r: string[]) => r[0] === '처리 위치')[1]).toContain('Google 서버로 보낼 수 있습니다');
    expect(rows.some((r: string[]) => r[3])).toBe(false); // no downloads to offer
  });

  it('iPhone Safari: no client hints, no permission query — said, not guessed', async () => {
    const win = {
      isSecureContext: true,
      webkitSpeechRecognition: function Rec() {},
      navigator: { userAgent: UA.iphone, permissions: { query: () => Promise.reject(new TypeError('microphone')) } },
    };
    const api = load(win);
    const info = await api.dicInfo(win);
    expect(info).toMatchObject({
      path: 'apple',
      mic: 'unknown',
      gpu: { has: false },
      os: { name: 'iOS', version: '17.5' },
    });
    const rows = api.dicInfoRows(info);
    expect(rows.find((r: string[]) => r[0] === '음성 인식기')[1]).toContain('Apple');
    expect(rows.find((r: string[]) => r[0] === '마이크 권한')[1]).toBe('이 브라우저는 알려 주지 않음');
    expect(rows.find((r: string[]) => r[0] === '메모리 · 코어')[1]).toBe('알 수 없음 · 알 수 없음');
  });

  it('Android with a frozen user-agent and no client hints says the version is hidden', async () => {
    const win = { webkitSpeechRecognition: function Rec() {}, navigator: { userAgent: UA.samsung } };
    const api = load(win);
    const rows = api.dicInfoRows(await api.dicInfo(win));
    expect(rows.find((r: string[]) => r[0] === '운영체제')[1]).toBe('Android (버전은 브라우저가 숨김)');
    expect(rows.find((r: string[]) => r[0] === '보안 연결 (HTTPS)')[1]).toContain('마이크를 쓸 수 없습니다');
  });
});

describe('D6 — which engines this device can run', () => {
  it('기기 기본 needs a recogniser; the server’s and the browser’s Whisper are not on this build yet', () => {
    const api = load();
    expect(api.dicEngines({ path: 'chrome' }).device).toEqual({ ok: true, why: '' });
    expect(api.dicEngines({ path: 'none' }).device.ok).toBe(false);
    expect(api.dicEngines({ path: 'none' }).device.why).toContain('음성 인식기가 없습니다');
    expect(api.dicEngines({ path: 'webapp' }).device.why).toContain('Safari에서 열어');
    expect(api.dicEngines({ path: 'apple' }).server).toEqual({ ok: false, why: '준비 중입니다' });
    expect(api.dicEngines({ path: 'apple' }).browser).toEqual({ ok: false, why: '준비 중입니다' });
  });

  it('a chosen engine this device cannot run falls back to 기기 기본, and the tab says so', () => {
    const doc = fakeDoc();
    const api = load({ localStorage: memStore({ [DICTATION_ENGINE_KEY]: 'server' }) }, doc);
    expect(api.dicEffective('server', api.dicEngines({ path: 'chrome' }))).toBe('device');
    api.dicPaintEngines({ path: 'chrome' });
    const [device, server, browser] = doc.inputs;
    expect([device.checked, server.checked, browser.checked]).toEqual([true, false, false]);
    expect([device.disabled, server.disabled, browser.disabled]).toEqual([false, true, true]);
    expect(doc.whys.server.textContent).toBe('준비 중입니다');
    expect(doc.whys.server.hidden).toBe(false);
    expect(doc.whys.device.hidden).toBe(true);
    expect(doc.el('dic-engine-note').textContent).toBe(
      '고른 엔진(서버 위스퍼)을 이 기기에서 쓸 수 없어 기기 기본 음성 인식으로 받아씁니다',
    );
  });
});

describe('D7 — the settings page carries the tab', () => {
  it('lists 받아쓰기 and renders its panel, three engines and the script', () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toContain('dictation');
    const html = renderSettingsPage();
    expect(html).toContain('data-tab="dictation"');
    for (const v of ['device', 'server', 'browser']) expect(html).toContain(`name="dic-engine" value="${v}"`);
    expect(html).toContain('function dictationEngineChoice(');
    expect(html).toContain('function loadDictationTab(');
    expect(html).toContain("if (id === 'dictation' && !_dicLoaded) loadDictationTab();");
    expect(DICTATION_TAB_HTML).toContain('이 기기의 이 브라우저에만 저장됩니다');
  });

  it('the shipped scripts have no template syntax (they go out byte for byte)', () => {
    for (const js of [DICTATION_PREF_JS, DICTATION_CLIENT_JS]) {
      expect(js).not.toContain('`');
      expect(js).not.toContain('${');
    }
  });
});

describe('D8 — 말해서 시험', () => {
  function testEnv(info: Record<string, unknown> = { path: 'chrome', langs: {} }, ua = UA.macChrome) {
    const doc = fakeDoc();
    const win = { navigator: { userAgent: ua }, webkitSpeechRecognition: FakeRec, localStorage: memStore() };
    const api = load(win, doc);
    if (info) api.__peek(`_dicInfo = ${JSON.stringify(info)}`);
    return { doc, win, api };
  }

  it('waits for this device’s details (where the speech may go is decided from them)', () => {
    const { doc, api } = testEnv(null as never);
    api.dicTestStart();
    expect(FakeRec.made).toEqual([]);
    expect(doc.el('dic-test-result').textContent).toContain('확인하는 중');
    expect(DICTATION_TAB_HTML).toContain('id="dic-test-btn" disabled');
  });

  it('the eight seconds start when the microphone opens; the words while said; the time to the first word', () => {
    vi.useFakeTimers();
    const { doc, api } = testEnv();
    api.dicTestStart();
    const rec = FakeRec.made[0];
    expect(rec).toMatchObject({ lang: 'ko-KR', interimResults: true, continuous: true, started: 1 });
    expect(doc.el('dic-test-result').textContent).toBe('마이크를 여는 중…');
    expect(doc.el('dic-test-btn').textContent).toBe('멈추기');
    vi.advanceTimersByTime(4000); // a permission prompt being read: not counted
    rec.onaudiostart?.();
    expect(doc.el('dic-test-result').textContent).toContain('듣는 중');
    vi.advanceTimersByTime(1200);
    rec.onresult?.({ results: [res('')] });
    vi.advanceTimersByTime(300);
    rec.onresult?.({ results: [res('대시보드')] });
    expect(doc.el('dic-test-live').textContent).toBe('대시보드');
    vi.advanceTimersByTime(900);
    rec.onresult?.({ results: [res('대시보드 새 작업', true)] });
    vi.advanceTimersByTime(5600); // eight seconds after the mic opened
    expect(rec.stopped).toBe(1);
    expect(doc.el('dic-test-live').textContent).toBe('대시보드 새 작업');
    expect(doc.el('dic-test-result').textContent).toBe('첫 글자까지 1.5초 · 8.0초 동안 들음 · 기기 기본 음성 인식');
    expect(doc.el('dic-test-btn').textContent).toBe('말해서 시험');
    expect(api.__peek('_dicTest')).toBeNull();
  });

  it('continuous where the recogniser keeps listening: one utterance does not end the test', () => {
    vi.useFakeTimers();
    const { doc, api } = testEnv();
    api.dicTestStart();
    const rec = FakeRec.made[0];
    rec.onaudiostart?.();
    rec.onresult?.({ results: [res('첫 문장.', true)] });
    vi.advanceTimersByTime(2000);
    rec.onresult?.({ results: [res('첫 문장.', true), res(' 두 번째', false)] });
    expect(doc.el('dic-test-live').textContent).toBe('첫 문장. 두 번째');
    expect(api.__peek('_dicTest')).not.toBeNull();
  });

  it('Android: one utterance per session, listened to again with the words kept; its longer copies do not double', () => {
    vi.useFakeTimers();
    const { doc, api } = testEnv({ path: 'android', langs: {} }, UA.samsung);
    api.dicTestStart();
    const rec = FakeRec.made[0];
    expect(rec.continuous).toBe(false);
    rec.onaudiostart?.();
    // Android Chrome resends what it settled inside a longer copy
    rec.onresult?.({ results: [res('대시보드', true), res('대시보드 새 작업', true)] });
    expect(doc.el('dic-test-live').textContent).toBe('대시보드 새 작업');
    vi.advanceTimersByTime(2000);
    rec.onend?.(); // the utterance ended with time left: listened to again
    expect(rec.started).toBe(2);
    rec.onresult?.({ results: [res('화면에서', true)] });
    expect(doc.el('dic-test-live').textContent).toBe('대시보드 새 작업 화면에서');
    vi.advanceTimersByTime(6000);
    expect(rec.stopped).toBe(1); // stop() ends it (the fake's end): no restart after the eight seconds
    expect(api.__peek('_dicTest')).toBeNull();
  });

  it('a stop or an error the recogniser never ends does not hold the test', () => {
    vi.useFakeTimers();
    const { doc, api } = testEnv();
    api.dicTestStart();
    const rec = FakeRec.made[0];
    rec.onaudiostart?.();
    rec.onerror?.({ error: 'network' }); // and no end
    vi.advanceTimersByTime(3000);
    expect(api.__peek('_dicTest')).toBeNull();
    expect(doc.el('dic-test-result').textContent).toBe(
      '글자가 나오지 않았습니다 — 음성 인식 서비스에 연결하지 못했습니다 · 기기 기본 음성 인식',
    );
  });

  it('a recogniser that never opens the microphone is stopped and said', () => {
    vi.useFakeTimers();
    const { doc, api } = testEnv();
    FakeRec.prototype.stop = function () {
      this.stopped++;
    }; // and it never ends either
    try {
      api.dicTestStart();
      vi.advanceTimersByTime(10000);
      expect(FakeRec.made[0].stopped).toBe(1);
      vi.advanceTimersByTime(3000);
      expect(doc.el('dic-test-result').textContent).toContain('마이크를 열지 않았습니다');
    } finally {
      FakeRec.prototype.stop = function () {
        this.stopped++;
        this.onend?.();
      };
    }
  });

  it('a press while it listens stops it', () => {
    const { api } = testEnv();
    api.dicTestStart();
    api.dicTestStart();
    expect(FakeRec.made[0].stopped).toBe(1);
  });

  it('says why nothing came', () => {
    const { doc, api } = testEnv();
    api.dicTestStart();
    const rec = FakeRec.made[0];
    rec.onaudiostart?.();
    rec.onerror?.({ error: 'not-allowed' });
    rec.onend?.();
    expect(doc.el('dic-test-result').textContent).toBe(
      '글자가 나오지 않았습니다 — 마이크 권한이 없습니다 · 기기 기본 음성 인식',
    );
  });

  it('keeps Korean on the device when Chrome has its model', () => {
    const { api } = testEnv({ path: 'chrome', langs: { 'ko-KR': 'available' } });
    api.dicTestStart();
    expect(FakeRec.made[0].processLocally).toBe(true);
  });

  it('nothing to test without a recogniser', () => {
    const doc = fakeDoc();
    const api = load({ navigator: { userAgent: UA.firefox }, localStorage: memStore() }, doc);
    api.__peek("_dicInfo = { path: 'none', langs: {} }");
    api.dicTestStart();
    expect(doc.el('dic-test-result').textContent).toBe('이 기기에서는 시험할 엔진이 없습니다');
  });

  it('the words of a result list: finals then what is still heard, spaced', () => {
    const api = load();
    expect(api.dicTestText([res('대시보드 ', true), res('새 작업')])).toBe('대시보드 새 작업');
    expect(api.dicTestText([res('대시보드', true), res('새 작업')])).toBe('대시보드 새 작업');
    expect(api.dicTestText([res('  ')])).toBe('');
    // Android's longer copy replaces what it repeats
    expect(api.dicTestText([res('하나', true), res('하나 둘', true), res('하나 둘 셋')], true)).toBe('하나 둘 셋');
    // elsewhere a phrase said twice stays as said
    expect(api.dicTestText([res('아니', true), res('아니요', true)], false)).toBe('아니 아니요');
  });
});

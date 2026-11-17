/**
 * .prd/30-phone-calls-spec.md §3.2–3.3 — phone calls in the dashboard chat, client half. Executes the shipped
 * client code cut out of renderDashboardPage()'s template literal, cooked exactly as the browser receives it:
 *
 *   card   a call is a card under the answer of the turn that placed it (title, number, length, state, the last
 *          lines — the other party left, the voice agent right); a call newer than the last turn rides that turn
 *   view   the card opens the call view: 통화 (the call as a chat) and 작업 (the call agent's work log)
 *   wire   the markup, the panel load, the live push and the deep link are in the page
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const re = new RegExp(`^(?:async function|function) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n !== 1) throw new Error(`client ${name} is declared ${n} times`);
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const PH_VARS = [
  'PH_LBL_PEER',
  'PH_LBL_AGENT',
  'PH_TAB_CALL',
  'PH_TAB_WORK',
  'PH_CUT',
  'PH_DIR_OUT',
  'PH_DIR_IN',
  'PH_EMPTY',
  'PH_LOADING',
  'PH_FAILED',
  'PH_SUMMARY',
  'PH_CLOSE',
  'PH_FIRST_TOKEN',
  'PH_FIRST_BYTE',
  'PH_SEC',
  'PH_STATUS',
  'PH_ENDED',
  'PH_WORK',
  'PH_WAVE',
];
const PH_FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'phoneNum',
  'phoneDur',
  'phoneStatus',
  'phoneLineHtml',
  'phoneCardHtml',
  'phoneCardsHtml',
  'phoneClock',
  'phoneTranscriptHtml',
  'phoneWorkText',
  'phoneWorkHtml',
  'phoneDialogHtml',
];
type Ph = {
  phoneNum(n: string): string;
  phoneDur(c: unknown, now?: number): string;
  phoneCardHtml(c: unknown, cid: string): string;
  phoneCardsHtml(list: unknown[], cid: string): string;
  phoneDialogHtml(v: unknown): string;
  phoneWorkText(w: unknown): string;
};
const ph = load<Ph>(PH_FNS, PH_VARS);

const T0 = Date.parse('2026-11-17T05:00:00Z');
const ENDED = {
  id: 'CAL123',
  env: '2lab-ai-dev',
  direction: 'outbound',
  peerNumber: '15446486',
  ourNumber: '07000000000',
  title: '반품 재통화',
  status: 'ended',
  endedStatus: 'completed',
  createdAt: T0,
  answeredAt: T0 + 5_000,
  durationSec: 164,
  tail: [
    { role: 'peer', text: '네.', at: T0 + 100_000 },
    { role: 'agent', text: '알겠습니다. 감사합니다.', at: T0 + 101_000, interrupted: true },
    { role: 'peer', text: '<b>네</b>', at: T0 + 102_000 },
  ],
  lines: 9,
  summary: '최종 거절당했습니다.',
};

describe('phone call card (.prd/30 §3.2)', () => {
  it('formats Korean numbers the way they are read', () => {
    expect(ph.phoneNum('01012345678')).toBe('010-1234-5678');
    expect(ph.phoneNum('0212345678')).toBe('02-1234-5678');
    expect(ph.phoneNum('021234567')).toBe('02-123-4567');
    expect(ph.phoneNum('15446486')).toBe('1544-6486');
    expect(ph.phoneNum('0311234567')).toBe('031-123-4567');
  });

  it('shows the server length when ended, the running length while up', () => {
    expect(ph.phoneDur(ENDED)).toBe('2:44');
    expect(ph.phoneDur({ status: 'active', answeredAt: T0 }, T0 + 65_000)).toBe('1:05');
    expect(ph.phoneDur({ status: 'dialing' })).toBe('0:00');
  });

  it('draws title, number, length, state, the last lines (peer left, agent right) and the summary', () => {
    const html = ph.phoneCardHtml(ENDED, 'conv-1');
    expect(html).toContain('반품 재통화');
    expect(html).toContain('1544-6486');
    expect(html).toContain('2:44');
    expect(html).toContain('통화 끝');
    expect(html).toContain('ph-line is-peer');
    expect(html).toContain('ph-line is-agent');
    expect(html).toContain('끊김');
    expect(html).toContain('최종 거절당했습니다.');
    // The other party's words are text, never markup.
    expect(html).toContain('&lt;b&gt;네&lt;/b&gt;');
    expect(html).not.toContain('<b>네</b>');
    // A click (and Enter) opens the call view for this call in this conversation — the ids are element data.
    expect(html).toContain('data-phone-call="CAL123" data-phone-cid="conv-1" onclick="openPhoneCallEl(this)"');
    expect(html).toContain('role="button"');
    expect(html).not.toContain('is-live');
  });

  it('marks a live call and its state', () => {
    const html = ph.phoneCardHtml({ ...ENDED, status: 'active', endedStatus: undefined, durationSec: undefined }, 'c');
    expect(html).toContain('ph-card is-live');
    expect(html).toContain('통화 중');
    expect(ph.phoneCardHtml({ ...ENDED, endedStatus: 'no-answer', tail: [] }, 'c')).toContain('안 받음');
  });

  it('draws nothing for an empty list', () => {
    expect(ph.phoneCardsHtml([], 'c')).toBe('');
    expect(ph.phoneCardsHtml([ENDED], 'c')).toContain('class="ph-cards"');
  });
});

describe('the call view (.prd/30 §3.3)', () => {
  const FULL = {
    ...ENDED,
    model: 'claude-sonnet-5-5',
    voice: 'cwon',
    transcript: [
      { role: 'agent', text: '안녕하세요, 소마예요.', at: T0 + 6_000 },
      { role: 'peer', text: '네, 말씀하세요.', at: T0 + 9_000 },
    ],
    work: [
      { kind: 'instruction', at: T0, text: '[통화 규칙]\n…' },
      { kind: 'stt', at: T0 + 9_000, text: '네, 말씀하세요.', ms: 812, audioMs: 1400 },
      {
        kind: 'reply',
        at: T0 + 9_900,
        text: '반품 건으로 연락드렸어요.',
        model: 'claude-sonnet-5-5',
        firstTokenMs: 640,
        ms: 1100,
      },
      { kind: 'tool', at: T0 + 160_000, name: 'hang_up', input: { reason: 'done' }, result: '말을 마치면 끊음' },
      { kind: 'tts', at: T0 + 10_000, text: '반품 건으로 연락드렸어요.', firstByteMs: 2300, audioMs: 2100 },
      { kind: 'error', at: T0 + 11_000, stage: 'stt', message: 'boom' },
    ],
  };

  it('통화: the call as a chat — agent right, other party left, with the summary on top', () => {
    const html = ph.phoneDialogHtml({ id: 'CAL123', cid: 'c', call: FULL, tab: 'call', state: 'ok' });
    expect(html).toContain('id="phone-dialog-title"');
    expect(html).toContain('건 전화 · 1544-6486 · 통화 끝 · 2:44 · claude-sonnet-5-5 · cwon');
    expect(html).toMatch(/ph-msg is-agent[\s\S]*안녕하세요, 소마예요\./);
    expect(html).toMatch(/ph-msg is-peer[\s\S]*네, 말씀하세요\./);
    expect(html).toContain('<b>요약</b> 최종 거절당했습니다.');
    expect(html).toContain('aria-selected="true" class="ph-tab is-on" onclick="phoneTab(\'call\')"');
  });

  it('작업: the call agent work log — instruction, STT, reply, tool, speech, errors', () => {
    const html = ph.phoneDialogHtml({ id: 'CAL123', cid: 'c', call: FULL, tab: 'work', state: 'ok' });
    for (const word of ['통화 지시', '받아쓰기', '모델 응답', '도구', '음성 합성', '오류'])
      expect(html).toContain(word);
    expect(html).toContain('<pre class="ph-pre">[통화 규칙]');
    expect(html).toContain('<span class="ph-count">6</span>');
    expect(ph.phoneWorkText(FULL.work[2])).toBe('반품 건으로 연락드렸어요. — claude-sonnet-5-5, 첫 토큰 640ms, 1100ms');
    expect(ph.phoneWorkText(FULL.work[3])).toBe('hang_up {"reason":"done"} → 말을 마치면 끊음');
    expect(ph.phoneWorkText(FULL.work[4])).toBe('반품 건으로 연락드렸어요. — 첫 소리 2300ms, 2.1초');
    expect(ph.phoneWorkText(FULL.work[1])).toBe('네, 말씀하세요. — 812ms (1.4초)');
  });

  it('says it is loading, or that it failed, before there is a call', () => {
    expect(ph.phoneDialogHtml({ id: 'x', cid: '', call: null, tab: 'call', state: 'loading' })).toContain(
      '불러오는 중',
    );
    expect(ph.phoneDialogHtml({ id: 'x', cid: '', call: null, tab: 'call', state: 'error' })).toContain(
      '불러오지 못했어요',
    );
  });

  it('an inbound call says so', () => {
    const html = ph.phoneDialogHtml({
      id: 'x',
      cid: '',
      call: { ...FULL, direction: 'inbound' },
      tab: 'call',
      state: 'ok',
    });
    expect(html).toContain('받은 전화 · 1544-6486');
  });
});

describe('the call in the chat (convTurnsOf)', () => {
  const CONV_FNS = [
    'esc',
    'toNum',
    'decodeSlackEntities',
    'formatTokens',
    'formatDuration',
    'sysOneLine',
    'sysBetween',
    'sysResumeContext',
    'sysTurnInfo',
    'cpState',
    'cpFacts',
    'cpDoneText',
    'estimateTokens',
    'splitInvokedSkills',
    'ansCacheKey',
    'artInTurn',
    'resumKey',
    'convSummaryOf',
    'convSysTurn',
    'convTurnsOf',
  ];
  const CONV_VARS = ['SYS_RESTART_HEADS', 'SYS_RESUME_CONTEXT', 'SYS_RETRY_MARK', 'CP_DEFAULT_EST_MS', 'CP_MAX_MS'];
  const STRINGS = new Function(
    `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
  )();
  type Built = { turns: Array<Record<string, unknown>>; slots: Array<Record<string, unknown>> };
  const conv = load<{ convTurnsOf(list: unknown[], c: Record<string, unknown>): Built }>(CONV_FNS, CONV_VARS, {
    STRINGS,
  });
  const ctx = (c: Record<string, unknown> = {}) => ({
    cid: 'conv-1',
    bot: 'Soma',
    now: T0 + 600_000,
    working: false,
    answers: {},
    failed: {},
    arts: [],
    ...c,
  });
  const turns = [
    { id: 'u1', role: 'user', timestamp: T0, userName: 'Z', rawContent: '전화 걸어줘', origin: { by: 'user' } },
    { id: 'a1', role: 'assistant', timestamp: T0 + 60_000 },
    { id: 'u2', role: 'user', timestamp: T0 + 120_000, userName: 'Z', rawContent: '결과는?', origin: { by: 'user' } },
  ];

  it('a call goes under the answer of the turn that placed it', () => {
    const b = conv.convTurnsOf(turns, ctx({ calls: [{ ...ENDED, createdAt: T0 + 10_000 }] }));
    const a1 = b.turns.find((t) => t.id === 'a1');
    expect(a1?.attachments).toBe(true);
    const slot = b.slots.find((s) => s.name === 'attachments-a1');
    expect((slot?.calls as Array<{ id: string }>).map((c) => c.id)).toEqual(['CAL123']);
  });

  it('a call newer than the last turn rides the last turn', () => {
    const b = conv.convTurnsOf(turns, ctx({ calls: [{ ...ENDED, createdAt: T0 + 300_000 }] }));
    const slot = b.slots.find((s) => s.name === 'media-u2');
    expect(slot?.kind).toBe('media');
    expect((slot?.calls as Array<{ id: string }>).map((c) => c.id)).toEqual(['CAL123']);
    expect(b.turns.find((t) => t.id === 'u2')?.media).toBe(true);
  });

  it('no calls → the slots are what they were', () => {
    const b = conv.convTurnsOf(turns, ctx());
    expect(b.slots).toEqual([]);
  });
});

describe('live state (.prd/31 §5)', () => {
  type Live = {
    ensurePhoneCalls(cid: string, force?: boolean): void;
    onPhoneCallUpdate(cid: string, call: Record<string, unknown>): void;
    phoneCallsOf(cid: string): Array<Record<string, unknown>>;
  };
  function live(fetchFn: (url: string) => Promise<unknown>) {
    return load<Live>(['phoneNewer', 'phoneMerge', 'phoneCallsOf', 'ensurePhoneCalls', 'onPhoneCallUpdate'], [], {
      _phoneCalls: Object.create(null),
      fetch: fetchFn,
      panelOpen: false,
      panelConvId: '',
      convPaintSoon: () => undefined,
      toNum: (v: unknown) => Number(v) || 0,
      _phoneView: null,
      phoneRefetchSoon: () => undefined,
    });
  }

  it('a list that arrives after a live update does not undo it (the call ended while the list loaded)', async () => {
    let respond!: (v: unknown) => void;
    const m = live(
      () =>
        new Promise((r) => {
          respond = r;
        }),
    );
    m.ensurePhoneCalls('c1');
    m.onPhoneCallUpdate('c1', { id: 'CA1', status: 'ended', updatedAt: 5, createdAt: 1 });
    respond({
      ok: true,
      json: async () => ({
        calls: [
          { id: 'CA1', status: 'dialing', updatedAt: 3, createdAt: 1 },
          { id: 'CA0', status: 'ended', updatedAt: 1, createdAt: 0 },
        ],
      }),
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(m.phoneCallsOf('c1').map((c) => `${c.id}:${c.status}`)).toEqual(['CA0:ended', 'CA1:ended']);
  });

  it('a newer list wins over an older live update', async () => {
    const m = live(async () => ({
      ok: true,
      json: async () => ({ calls: [{ id: 'CA1', status: 'ended', updatedAt: 9, createdAt: 1 }] }),
    }));
    m.onPhoneCallUpdate('c1', { id: 'CA1', status: 'active', updatedAt: 4, createdAt: 1 });
    m.ensurePhoneCalls('c1', true);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(m.phoneCallsOf('c1')[0].status).toBe('ended');
  });

  it('a reader who scrolled up the call is left where they were when a new line arrives', () => {
    let html = 'v1';
    let body = { scrollTop: 0, clientHeight: 100, scrollHeight: 1000 };
    const inner: Record<string, unknown> = {
      _html: '',
      querySelector: () => body,
      set innerHTML(_v: string) {
        body = { scrollTop: 0, clientHeight: 100, scrollHeight: body.scrollHeight + 50 }; // a new element
      },
    };
    const view = { id: 'CA1', tab: 'call' };
    const m = load<{ renderPhoneDialog(): void }>(['renderPhoneDialog'], [], {
      document: { getElementById: () => inner },
      _phoneView: view,
      phoneDialogHtml: () => html,
    });
    m.renderPhoneDialog();
    expect(body.scrollTop).toBe(body.scrollHeight); // a fresh view follows the newest line
    body.scrollTop = 200; // the reader scrolls up
    html = 'v2';
    m.renderPhoneDialog();
    expect(body.scrollTop).toBe(200);
    body.scrollTop = body.scrollHeight - body.clientHeight; // back at the bottom: follows again
    html = 'v3';
    m.renderPhoneDialog();
    expect(body.scrollTop).toBe(body.scrollHeight);
  });
});

describe('wiring (.prd/31 §5)', () => {
  it('the page has the call view, the panel load, the live push and the deep link', () => {
    expect(TEMPLATE).toContain('<dialog id="phone-call-dialog" class="phone-dialog"');
    expect(TEMPLATE).toContain('id="phone-dialog-body"');
    expect(TEMPLATE).toContain('ensurePhoneCalls(panelConvId, true)');
    expect(TEMPLATE).toMatch(/msg\.type === 'phone_call_update'/);
    expect(TEMPLATE).toContain("new URLSearchParams(location.search).get('phoneCall')");
    expect(clientFn('convSlots')).toContain('phoneCardsHtml(sl.calls, cid)');
    expect(
      cook(
        TEMPLATE.slice(
          TEMPLATE.indexOf('function convPaint('),
          TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('function convPaint(')),
        ),
      ),
    ).toContain('calls: typeof phoneCallsOf');
  });

  it('every phone client function and var is declared once', () => {
    for (const fn of [
      ...PH_FNS,
      'ensurePhoneCalls',
      'onPhoneCallUpdate',
      'openPhoneCall',
      'loadPhoneCall',
      'closePhoneCall',
      'phoneTab',
      'renderPhoneDialog',
      'phoneRefetchSoon',
      'phoneCallsOf',
      'phoneDialogEl',
    ]) {
      expect(() => clientFn(fn)).not.toThrow();
    }
  });
});

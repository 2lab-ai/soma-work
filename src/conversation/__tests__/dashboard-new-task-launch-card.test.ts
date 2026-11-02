/**
 * Dashboard "New task" — the launch leaves the dialog at once (SSOT 2026-11-02).
 *
 *   T1 — 작업 시작 closes the dialog at once and empties it for the next task; the board shows the launch as a
 *        temporary card in RUNNING, its status 시작 중, until the task's own card arrives. A launch that fails
 *        takes its card back and puts what was sent back in the dialog.
 *   T2 — 카드 열기 (the launch toast), or a press on the 시작 중 card, opens the launch's own card on the board
 *        with its detail card — never Slack. Not on the board yet: it opens as soon as it arrives.
 *
 * Same harness as the other dashboard client suites: the shipped client functions, cut out of
 * renderDashboardPage()'s template literal and cooked exactly as the browser receives them, sharing one scope
 * with the page globals they read (`let`, so they can change — read back with __peek).
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
function loadWith<T>(fns: string[], globals: Record<string, unknown>): T & { __peek(k: string): any } {
  const names = Object.keys(globals);
  const body = `${names.map((n) => `let ${n} = __g.${n};`).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, __peek: function (k) { return eval(k); }, __set: function (k, __v) { eval(k + ' = __v'); } };`;
  return new Function('__g', body)(globals) as T & { __peek(k: string): any };
}

const CTX = {
  defaultModel: 'opus[1m]',
  defaultEffort: 'xhigh',
  defaultChannelId: 'C_ALPHA',
  autogoalDefault: true,
  models: [{ nickname: 'opus[1m]', label: 'Opus' }],
  efforts: ['xhigh'],
  channels: [{ id: 'C_ALPHA', name: 'workspace-alpha' }],
};
const PENDING_CONSTS = {
  NT_PENDING_PREFIX: 'nt-launch:',
  NT_PENDING_MAX_MS: 120000,
  NT_PENDING_POLL_MS: 1000,
  NT_OPEN_WAIT_MS: 120000,
};
const PENDING_FNS = [
  'ntLaunchTitle',
  'ntPendingCardOf',
  'ntPendingSettle',
  'ntPendingInFlight',
  'ntPendingOf',
  'ntBoardIsViewers',
  'ntPendingPrune',
  'ntChannelName',
  'resolveDeepLinkKey',
];

function slackState(prompt: string) {
  return {
    model: 'opus[1m]',
    effort: 'xhigh',
    channelId: 'C_ALPHA',
    autogoal: true,
    autoz: false,
    prompt,
    destination: 'slack',
    folder: '',
  };
}

// ── T1 — the dialog closes at once ──────────────────────────────────

describe('T1 — 작업 시작 closes the dialog at once and leaves a 시작 중 card', () => {
  function page(
    state: Record<string, unknown>,
    composerFiles: unknown[] = [],
    read: Promise<void> = Promise.resolve(),
  ) {
    const calls: string[] = [];
    const posted: string[] = [];
    const composer = {
      value: String(state.prompt || ''),
      files: composerFiles,
      clear: vi.fn(() => calls.push('clear')),
    };
    const store = new Map<string, string>([['soma-nt-draft', '{"prompt":"x"}']]);
    const answers: Array<(v: unknown) => void> = [];
    const api = loadWith<{ submitNewTask(detail: unknown): Promise<void> }>(
      [
        'submitNewTask',
        'ntBeginLaunch',
        'ntTooLong',
        'ntCanSubmit',
        'ntBlockedHint',
        'ntBuildPayload',
        'ntStateAfterLaunch',
        'ntDefaultState',
        ...PENDING_FNS,
      ],
      {
        ...PENDING_CONSTS,
        NT_DRAFT_KEY: 'soma-nt-draft',
        _ntBusy: false,
        _ntCtx: CTX,
        _ntState: state,
        _ntRequestId: 'req-1',
        _ntValue: String(state.prompt || ''),
        _ntPending: [] as unknown[],
        _ntLaunchQueue: Promise.resolve(),
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => store.delete(k),
        },
        ntEl: (id: string) => (id === 'nt-composer' ? composer : null),
        ntNewRequestId: () => 'req-2',
        ntSetError: (t: string) => t && calls.push(`error:${t}`),
        ntSetStatus: () => {},
        ntRender: () => calls.push('render'),
        paintNtComposer: () => {},
        closeNewTask: () => calls.push('close'),
        ntPendingRepaint: () => calls.push('board'),
        ntPendingStatus: (_l: unknown, t: string) => calls.push(`status:${t}`),
        ntReadFile: async (f: { name: string }) => {
          await read;
          if (f.name === 'gone') throw new Error('read:gone');
          return { name: f.name, mimetype: 'image/png', data: 'AA' };
        },
        refreshCsrfToken: async () => {},
        // The server has not answered yet.
        ntPostTask: (b: string) => {
          posted.push(b);
          return new Promise((r) => {
            answers.push(r);
          });
        },
        ntOnLaunched: () => calls.push('launched'),
        ntLaunchFailed: () => calls.push('failed'),
      },
    );
    // Answers the oldest request still waiting.
    return { api, calls, posted, composer, store, answer: (v: unknown) => answers.shift()?.(v) };
  }

  it('closes and empties the dialog in the press itself — before the server answers', () => {
    const p = page(slackState('대시보드 개선해줘\n두 번째 줄'));
    void p.api.submitNewTask({ text: '대시보드 개선해줘\n두 번째 줄', files: [] });
    // Synchronously, before any await: the dialog is gone and empty, the board already has the card.
    expect(p.calls).toContain('close');
    expect(p.calls).toContain('clear');
    expect(p.calls).toContain('board');
    expect(p.calls).not.toContain('launched');
    expect(p.api.__peek('_ntValue')).toBe('');
    expect(p.store.has('soma-nt-draft')).toBe(false);
    // The next task starts clean: a new request id, the channel just used.
    expect(p.api.__peek('_ntRequestId')).toBe('req-2');
    expect(p.api.__peek('_ntState')).toMatchObject({ prompt: '', channelId: 'C_ALPHA', destination: 'slack' });
    // The launch is on its way, as a pending card holding what was sent.
    const pending = p.api.__peek('_ntPending');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: 'nt-launch:req-1',
      requestId: 'req-1',
      inFlight: true,
      sessionKey: '',
      state: { prompt: '대시보드 개선해줘\n두 번째 줄', channelId: 'C_ALPHA' },
    });
    expect(p.api.__peek('_ntBusy')).toBe(true);
  });

  it('sends what was submitted, under the launch’s own request id; the answer goes to ntOnLaunched', async () => {
    const p = page(slackState('go'));
    const run = p.api.submitNewTask({ text: 'go', files: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(p.posted[0])).toMatchObject({ requestId: 'req-1', prompt: 'go', channelId: 'C_ALPHA' });
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.2' },
    });
    await run;
    expect(p.calls).toContain('launched');
    expect(p.calls).not.toContain('failed');
  });

  it('a refused launch goes to ntLaunchFailed (the dialog is already closed)', async () => {
    const p = page(slackState('go'));
    const run = p.api.submitNewTask({ text: 'go', files: [] });
    await Promise.resolve();
    await Promise.resolve();
    p.answer({ status: 409, data: { error: '이미 실행 중' } });
    await run;
    expect(p.calls).toContain('failed');
    expect(p.calls).not.toContain('launched');
  });

  // Review (grok #747 R1 P1): the server takes one launch per user at a time (createNewTaskGate: 429 for a second
  // one in flight). The dialog no longer holds the first, so a second task is queued here, not refused there.
  it('a second launch while the first is on its way waits for its answer instead of meeting the 429', async () => {
    const p = page(slackState('A'));
    const runA = p.api.submitNewTask({ text: 'A', files: [] });
    const runB = p.api.submitNewTask({ text: 'B', files: [] });
    // Both left the dialog at once: two 시작 중 cards.
    expect(p.api.__peek('_ntPending').map((l: { state: { prompt: string } }) => l.state.prompt)).toEqual(['B', 'A']);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    // Only A is sent; B says on its card that it waits for A.
    expect(p.posted.map((b) => JSON.parse(b).prompt)).toEqual(['A']);
    expect(p.calls).toContain('status:앞 작업이 시작되면 올려요…');
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.1' },
    });
    await runA;
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(p.posted.map((b) => JSON.parse(b).prompt)).toEqual(['A', 'B']);
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.2' },
    });
    await runB;
    expect(p.calls.filter((c) => c === 'launched')).toHaveLength(2);
    expect(p.calls).not.toContain('failed');
  });

  // Review (grok #747 R2 P2): the card says it waits only while it really does — not when the launch before it was
  // answered while this one's files were read.
  it('a launch whose files are read while the one before it is answered never says it waits', async () => {
    let releaseRead!: () => void;
    const read = new Promise<void>((r) => {
      releaseRead = r;
    });
    const p = page(slackState('A'), [], read);
    const runA = p.api.submitNewTask({ text: 'A', files: [] });
    const runB = p.api.submitNewTask({ text: 'B', files: [{ name: 'big.mov' }] });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(p.calls).toContain('status:첨부 준비 중…');
    // A is answered while B's file is still being read.
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.1' },
    });
    await runA;
    releaseRead();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(p.posted.map((b) => JSON.parse(b).prompt)).toEqual(['A', 'B']);
    expect(p.calls).not.toContain('status:앞 작업이 시작되면 올려요…');
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.2' },
    });
    await runB;
  });

  it('a launch whose files are read before the one before it is answered says it waits, then posts', async () => {
    const p = page(slackState('A'));
    const runA = p.api.submitNewTask({ text: 'A', files: [] });
    const runB = p.api.submitNewTask({ text: 'B', files: [{ name: 'small.png' }] });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(p.calls).toContain('status:앞 작업이 시작되면 올려요…');
    expect(p.posted).toHaveLength(1);
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.1' },
    });
    await runA;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(p.posted).toHaveLength(2);
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.2' },
    });
    await runB;
  });

  // Review (fable #747 R2 N1): a launch that fails before its turn does not let the next one past the one in flight.
  it('a launch whose file cannot be read hands its turn on only after the launch before it', async () => {
    const p = page(slackState('A'));
    const runA = p.api.submitNewTask({ text: 'A', files: [] });
    const runB = p.api.submitNewTask({ text: 'B', files: [{ name: 'gone' }] });
    const runC = p.api.submitNewTask({ text: 'C', files: [] });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await runB;
    expect(p.calls).toContain('failed');
    for (let i = 0; i < 12; i++) await Promise.resolve();
    // A is still in flight: C waits.
    expect(p.posted.map((b) => JSON.parse(b).prompt)).toEqual(['A']);
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.1' },
    });
    await runA;
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(p.posted.map((b) => JSON.parse(b).prompt)).toEqual(['A', 'C']);
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.3' },
    });
    await runC;
  });

  it('the queue moves on after a launch that failed', async () => {
    const p = page(slackState('A'));
    const runA = p.api.submitNewTask({ text: 'A', files: [] });
    const runB = p.api.submitNewTask({ text: 'B', files: [] });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    p.answer({ status: 409, data: { error: '거절' } });
    await runA;
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(p.posted).toHaveLength(2);
    p.answer({
      status: 200,
      data: { ok: true, channel: 'C_ALPHA', status: 'running', sessionKey: 'work:C_ALPHA:1.3' },
    });
    await runB;
    expect(p.calls.filter((c) => c === 'failed')).toHaveLength(1);
    expect(p.calls.filter((c) => c === 'launched')).toHaveLength(1);
  });

  it('an instruction that cannot start keeps the dialog open with its reason — no card', () => {
    const p = page(slackState('   '));
    void p.api.submitNewTask({ text: '   ', files: [] });
    expect(p.calls).not.toContain('close');
    expect(p.calls.some((c) => c.startsWith('error:'))).toBe(true);
    expect(p.api.__peek('_ntPending')).toHaveLength(0);
  });
});

describe('T1 — the 시작 중 card (ntPendingCardOf)', () => {
  const fns = loadWith<{ ntPendingCardOf(launch: any, channelName: string | null): any }>(PENDING_FNS, {
    ...PENDING_CONSTS,
    _ntPending: [],
    _ntCtx: CTX,
  });

  it('RUNNING, its status 시작 중, the clock from the press; titled by the instruction’s first line', () => {
    const launch = {
      id: 'nt-launch:r1',
      at: 1_000,
      state: slackState('\n  대시보드 개선  \n둘째 줄'),
      files: [],
      phase: '',
    };
    expect(fns.ntPendingCardOf(launch, 'workspace-alpha')).toEqual({
      id: 'nt-launch:r1',
      title: '대시보드 개선',
      summary: '#workspace-alpha',
      status: 'running',
      statusText: '시작 중',
      since: 1_000,
      bodyMode: 'slot',
    });
  });

  it('says where it goes and what it is doing now', () => {
    const slack = { id: 'nt-launch:r1', at: 1, state: slackState('a'), files: [], phase: 'Slack에 작업을 올리는 중…' };
    expect(fns.ntPendingCardOf(slack, null).summary).toBe('#C_ALPHA · Slack에 작업을 올리는 중…');
    const task = { id: 'nt-launch:r2', at: 1, state: { destination: 'task', prompt: 'b' }, files: [], phase: '' };
    expect(fns.ntPendingCardOf(task, null).summary).toBe('대시보드 작업');
    const epic = {
      id: 'nt-launch:r3',
      at: 1,
      state: { destination: 'task', kind: 'epic', prompt: 'c' },
      files: [],
      phase: '',
    };
    expect(fns.ntPendingCardOf(epic, null).summary).toBe('대시보드 에픽');
  });

  it('a launch of files only is titled by them', () => {
    const files = { id: 'nt-launch:r4', at: 1, state: slackState(''), files: [{}, {}], phase: '' };
    expect(fns.ntPendingCardOf(files, 'a').title).toBe('첨부 2개');
  });

  it('a launch that did not start and waits to be taken back is a 시작 실패 card with its reason', () => {
    const failed = {
      id: 'nt-launch:r5',
      at: 1,
      failed: true,
      failedAt: 5,
      reason: '이미 실행 중',
      state: slackState('고쳐줘'),
      files: [],
    };
    expect(fns.ntPendingCardOf(failed, 'a')).toEqual({
      id: 'nt-launch:r5',
      title: '고쳐줘',
      summary: '이미 실행 중 · 눌러서 지시를 작성 창으로 가져오기',
      status: 'failed',
      statusText: '시작 실패',
      since: 5,
      bodyMode: 'slot',
    });
  });
});

describe('T1 — the board draws the launch cards: 시작 중 first in RUNNING, 시작 실패 first in NEEDS YOU', () => {
  function board(opts: { currentUserId?: string; viewer?: string; expired?: boolean } = {}) {
    const now = Date.now();
    const toasts: any[] = [];
    let watched = 0;
    const inFlight = {
      id: 'nt-launch:a',
      at: now,
      inFlight: true,
      sessionKey: '',
      state: slackState('A'),
      files: [],
      phase: '',
    };
    const arrived = {
      id: 'nt-launch:b',
      at: now,
      inFlight: false,
      sessionKey: 'work:C_ALPHA:1.2',
      answeredAt: now,
      state: slackState('B'),
      files: [],
      phase: '',
    };
    const waiting = {
      id: 'nt-launch:c',
      at: now,
      inFlight: false,
      sessionKey: 'task:t-9',
      answeredAt: opts.expired ? now - 120_001 : now,
      permalink: opts.expired ? 'https://slack.example/p9' : '',
      state: { destination: 'task', prompt: 'C' },
      files: [],
      phase: '',
    };
    const failed = {
      id: 'nt-launch:d',
      at: now,
      inFlight: false,
      failed: true,
      failedAt: now,
      reason: '거절',
      sessionKey: '',
      state: slackState('D'),
      files: [],
    };
    const maps = {
      _cardHost: {} as Record<string, unknown>,
      _cardCol: {} as Record<string, string>,
      _cardData: {} as Record<string, any>,
      _cardDrawn: {} as Record<string, boolean>,
    };
    const host = { id: 'kanban' };
    const api = loadWith<{ ntPendingPlace(host: unknown): { working: string[]; waiting: string[] } }>(
      ['ntPendingPlace', ...PENDING_FNS],
      {
        ...PENDING_CONSTS,
        ...maps,
        _ntPending: [inFlight, arrived, waiting, failed],
        // B's own card is on the board (this instance's prefix, #814).
        _sessionCache: { 'dev::work:C_ALPHA:1.2': { key: 'dev::work:C_ALPHA:1.2' } },
        SELF_INSTANCE_NAME: 'dev',
        currentUserId: opts.currentUserId ?? 'U1',
        _viewerUserId: opts.viewer ?? 'U1',
        _ntCtx: CTX,
        dashToast: (t: unknown) => toasts.push(t),
        ntPendingWatch: () => watched++,
      },
    );
    return { api, maps, host, toasts, watched: () => watched };
  }

  it('a launch whose card is on the board leaves; the rest are drawn — 시작 중 in RUNNING, 시작 실패 in NEEDS YOU', () => {
    const b = board();
    expect(b.api.ntPendingPlace(b.host)).toEqual({ working: ['nt-launch:a', 'nt-launch:c'], waiting: ['nt-launch:d'] });
    expect(b.api.__peek('_ntPending').map((p: { id: string }) => p.id)).toEqual([
      'nt-launch:a',
      'nt-launch:c',
      'nt-launch:d',
    ]);
    expect(b.maps._cardHost['nt-launch:a']).toBe(b.host);
    expect(b.maps._cardCol['nt-launch:a']).toBe('working');
    expect(b.maps._cardCol['nt-launch:d']).toBe('waiting');
    expect(b.maps._cardDrawn['nt-launch:c']).toBe(true);
    expect(b.maps._cardData['nt-launch:a']).toMatchObject({ title: 'A', status: 'running', statusText: '시작 중' });
    expect(b.maps._cardData['nt-launch:d']).toMatchObject({ title: 'D', status: 'failed', statusText: '시작 실패' });
    // The watch runs while a card is awaited.
    expect(b.watched()).toBe(1);
    expect(b.toasts).toEqual([]);
  });

  it('the All Users board draws them too', () => {
    const b = board({ currentUserId: '' });
    expect(b.api.ntPendingPlace(b.host).working).toEqual(['nt-launch:a', 'nt-launch:c']);
  });

  it('another user’s board draws none, drops none and watches nothing', () => {
    const b = board({ currentUserId: 'U2' });
    expect(b.api.ntPendingPlace(b.host)).toEqual({ working: [], waiting: [] });
    expect(b.api.__peek('_ntPending')).toHaveLength(4);
    expect(b.watched()).toBe(0);
  });

  it('a card that did not come within NT_PENDING_MAX_MS leaves with a toast that says so and links its thread', () => {
    const b = board({ expired: true });
    expect(b.api.ntPendingPlace(b.host).working).toEqual(['nt-launch:a']);
    expect(b.toasts).toEqual([
      {
        title: '작업 카드가 아직 보드에 오지 않았어요',
        description: 'C',
        tone: 'warning',
        link: { label: 'Slack에서 보기', href: 'https://slack.example/p9' },
      },
    ]);
  });

  it('renderBoard puts them at the head of their columns, after the per-render maps were reset; it ends in ntOpenArrivals', () => {
    const render = clientFn('renderBoard');
    const reset = render.indexOf('_cardDrawn = Object.create(null);');
    const place = render.indexOf('var pending = ntPendingPlace(kb);');
    expect(reset).toBeGreaterThan(0);
    expect(place).toBeGreaterThan(reset);
    expect(render).toContain("keys: pending.working.concat(keys(rest.working, 'working', kb))");
    expect(render).toContain("keys: pending.waiting.concat(keys(rest.waiting, 'waiting', kb))");
    expect(render.trimEnd().endsWith('ntOpenArrivals();\n}')).toBe(true);
  });
});

// SSOT 2026-11-02 (dev, 04:20Z): the launch answered 'starting' 11 s after the press and its card reached the board
// ~2 min 18 s later — after the 120 s the 시작 중 card and 카드 열기 waited, so the two never met. They now wait as long
// as an accepted launch can take to start.
describe('T1/T2 — the 시작 중 card and 카드 열기 wait as long as a launch can take to start', () => {
  it('NT_PENDING_MAX_MS is 10 minutes, and 카드 열기 waits as long', () => {
    expect(TEMPLATE).toContain('\nvar NT_PENDING_MAX_MS = 600000;');
    expect(TEMPLATE).toContain('\nvar NT_OPEN_WAIT_MS = NT_PENDING_MAX_MS;');
    expect(TEMPLATE).toContain('\nvar NT_PENDING_POLL_SLOW_MS = 5000;');
    expect(TEMPLATE).toContain('\nvar NT_PENDING_FAST_MS = 30000;');
  });
});

describe('T1 — a 시작 중 card waits for its card, not forever (ntPendingSettle)', () => {
  const fns = loadWith<{ ntPendingSettle(list: any[], keys: string[], self: string, now: number): any[] }>(
    PENDING_FNS,
    { ...PENDING_CONSTS, _ntPending: [], _ntCtx: CTX },
  );
  const now = 10_000_000;

  it('keeps a launch on its way however long it takes, and a 시작 실패 card until it is taken back', () => {
    const list = [
      { id: 'a', at: now - 600_000, sessionKey: '' },
      { id: 'f', at: now - 600_000, sessionKey: 'task:t-1', failed: true, answeredAt: now - 600_000 },
    ];
    expect(fns.ntPendingSettle(list, ['task:t-1'], 'dev', now)).toEqual(list);
  });

  it('drops an answered launch once its card is on the board — prefixed or not', () => {
    const list = [
      { id: 'a', at: now, answeredAt: now, sessionKey: 'work:C:1.2' },
      { id: 'b', at: now, answeredAt: now, sessionKey: 'task:t-1' },
      { id: 'c', at: now, answeredAt: now, sessionKey: 'task:t-2' },
    ];
    expect(fns.ntPendingSettle(list, ['dev::work:C:1.2', 'task:t-1'], 'dev', now).map((p) => p.id)).toEqual(['c']);
  });

  it('drops an answered launch whose card has not come within NT_PENDING_MAX_MS', () => {
    const list = [
      { id: 'old', at: now - 200_000, answeredAt: now - 120_001, sessionKey: 'work:C:9' },
      { id: 'new', at: now - 200_000, answeredAt: now - 1_000, sessionKey: 'work:C:8' },
    ];
    expect(fns.ntPendingSettle(list, [], 'dev', now).map((p) => p.id)).toEqual(['new']);
  });
});

// Review (#747 R1 — fable P2-2, astra Z5): the watch polls only the viewer's own board, and an ask that never
// answers does not hold it — the deadline still ends it.
describe('T1 — the watch: one tick at a time, never held by a hung ask, ended by the deadline (ntPendingWatch)', () => {
  function watch(opts: { currentUserId?: string; hang?: boolean; answeredAgo?: number } = {}) {
    let asks = 0;
    let renders = 0;
    const toasts: any[] = [];
    const now = Date.now();
    const launch = {
      id: 'nt-launch:a',
      at: now,
      inFlight: false,
      sessionKey: 'work:C_ALPHA:1.2',
      answeredAt: now - (opts.answeredAgo ?? 0),
      state: slackState('A'),
      files: [],
    };
    const api = loadWith<{ ntPendingWatch(): void }>(
      [
        'ntPendingWatch',
        'ntWatchDelay',
        'ntCardsAwaited',
        'ntBoardIsViewers',
        'ntPendingPrune',
        'ntOpenArrivals',
        ...PENDING_FNS,
      ],
      {
        ...PENDING_CONSTS,
        NT_PENDING_POLL_SLOW_MS: 5000,
        NT_PENDING_FAST_MS: 30000,
        _ntPending: [launch],
        _ntOpening: [] as unknown[],
        _ntPendingTimer: 0,
        _ntWatchAsk: null,
        NT_WATCH_ASK_STALE_MS: 30000,
        _ntCtx: CTX,
        _sessionCache: {},
        SELF_INSTANCE_NAME: 'dev',
        currentUserId: opts.currentUserId ?? 'U1',
        _viewerUserId: 'U1',
        loadSessions: () => {
          asks++;
          return opts.hang ? new Promise(() => {}) : Promise.resolve();
        },
        ntPendingRepaint: () => renders++,
        dashToast: (t: unknown) => toasts.push(t),
      },
    );
    return { api, asks: () => asks, renders: () => renders, toasts };
  }

  it('arms one timer however often it is asked, and asks the board every NT_PENDING_POLL_MS', async () => {
    vi.useFakeTimers();
    try {
      const w = watch();
      w.api.ntPendingWatch();
      w.api.ntPendingWatch();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.asks()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.asks()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ask that never answers is not asked again, the ticks go on, and the deadline ends the watch with a toast', async () => {
    vi.useFakeTimers();
    try {
      const w = watch({ hang: true });
      w.api.ntPendingWatch();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(w.asks()).toBe(1);
      expect(w.api.__peek('_ntPendingTimer')).not.toBe(0);
      // An ask out longer than NT_WATCH_ASK_STALE_MS no longer holds the next (fable #747 R2 N6).
      await vi.advanceTimersByTimeAsync(25_000);
      expect(w.asks()).toBe(2);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(w.api.__peek('_ntPending')).toHaveLength(0);
      expect(w.renders()).toBe(1);
      expect(w.toasts).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // SSOT 2026-11-02 (dev, 04:20Z): a starting Slack session took ~2 min to reach the board — the watch keeps asking,
  // every NT_PENDING_POLL_SLOW_MS once NT_PENDING_FAST_MS have passed since the answer (pushes bring it in between).
  it('30 s after the answer it asks every NT_PENDING_POLL_SLOW_MS', async () => {
    vi.useFakeTimers();
    try {
      const w = watch({ answeredAgo: 40_000 });
      w.api.ntPendingWatch();
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.asks()).toBe(0);
      await vi.advanceTimersByTimeAsync(4000);
      expect(w.asks()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('another user’s board is not watched', () => {
    vi.useFakeTimers();
    try {
      const w = watch({ currentUserId: 'U2' });
      w.api.ntPendingWatch();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T1 — a launch that fails: back to the dialog when it is free, else kept as a 시작 실패 card', () => {
  function page(
    composer: { value: string; files: unknown[] },
    opts: { recording?: boolean; dictating?: boolean } = {},
  ) {
    const toasts: Array<{ input: any; onAction?: () => void }> = [];
    const calls: string[] = [];
    const file = { name: 'a.png' };
    const launch = {
      id: 'nt-launch:req-1',
      requestId: 'req-1',
      at: 1,
      inFlight: true,
      sessionKey: '',
      state: slackState('대시보드 개선\n자세히'),
      files: [file],
      phase: '',
    };
    const el = { ...composer, addFiles: vi.fn((fs: unknown[]) => fs) };
    let dictating = !!opts.dictating;
    const api = loadWith<{
      ntLaunchFailed(launch: any, message: string): void;
      ntRetakeLaunch(launch: any): void;
    }>(
      [
        'ntLaunchFailed',
        'ntRestoreLaunch',
        'ntComposerPristine',
        'ntReopenWithError',
        'ntKeepFailed',
        'ntRetakeLaunch',
        'ntPendingUnsent',
        'ntPendingDrop',
        'ntReconcile',
        ...PENDING_FNS,
      ],
      {
        ...PENDING_CONSTS,
        NT_DRAFT_KEY: 'k',
        _ntPending: [launch],
        _ntBusy: true,
        _ntCtx: CTX,
        _ntState: slackState(''),
        _ntRequestId: 'req-2',
        _ntValue: '',
        ntEl: (id: string) => (id === 'nt-composer' ? el : id === 'nt-dialog' ? { open: false } : null),
        ntDictating: () => dictating,
        ntDictateStopIn: () => {
          dictating = false;
          calls.push('dictation-stopped');
        },
        ntRecordingNow: () => !!opts.recording,
        ntSaveDraft: (t: string) => calls.push(`draft:${t}`),
        ntRender: () => calls.push('render'),
        ntSetError: (t: string) => calls.push(`error:${t}`),
        ntPendingRepaint: () => calls.push('board'),
        openNewTask: () => calls.push('open'),
        dashToast: (input: any, onAction?: () => void) => toasts.push({ input, onAction }),
      },
    );
    return { api, toasts, calls, el, launch, file };
  }

  it('an empty dialog gets everything back: the text, the files, the choices and the same request id', () => {
    const p = page({ value: '', files: [] });
    p.api.ntLaunchFailed(p.launch, '이미 실행 중인 작업이 있어요');
    expect(p.api.__peek('_ntPending')).toHaveLength(0);
    expect(p.api.__peek('_ntBusy')).toBe(false);
    expect(p.calls).toContain('board');
    expect(p.api.__peek('_ntValue')).toBe('대시보드 개선\n자세히');
    expect(p.api.__peek('_ntState')).toMatchObject({ prompt: '대시보드 개선\n자세히', channelId: 'C_ALPHA' });
    // A retry under the same id never runs it twice (the server's request gate).
    expect(p.api.__peek('_ntRequestId')).toBe('req-1');
    expect(p.el.addFiles).toHaveBeenCalledWith([p.file]);
    expect(p.calls).toContain('draft:대시보드 개선\n자세히');
    expect(p.toasts).toHaveLength(1);
    expect(p.toasts[0].input).toMatchObject({
      title: '작업을 시작하지 못했어요',
      description: '이미 실행 중인 작업이 있어요',
      tone: 'error',
      action: { id: 'open', label: '다시 열기' },
    });
    // 다시 열기: the dialog, with the reason on its error line.
    p.toasts[0].onAction?.();
    expect(p.calls.slice(-2)).toEqual(['open', 'error:이미 실행 중인 작업이 있어요']);
  });

  it('an empty dialog with a dictation listening: the dictation stops and the launch comes back (fable P1-2)', () => {
    const p = page({ value: '', files: [] }, { dictating: true });
    p.api.ntLaunchFailed(p.launch, '거절');
    expect(p.calls).toContain('dictation-stopped');
    expect(p.api.__peek('_ntValue')).toBe('대시보드 개선\n자세히');
    expect(p.api.__peek('_ntPending')).toHaveLength(0);
  });

  // Review (#747 R1 — astra Z1, fable P1-2): nothing is lost and nothing is replaced.
  it('a dialog holding another instruction is left alone, and the failed one waits on a 시작 실패 card', () => {
    const p = page({ value: '다음 작업', files: [] });
    p.api.ntLaunchFailed(p.launch, '거절됨');
    expect(p.api.__peek('_ntPending')).toEqual([p.launch]);
    expect(p.launch).toMatchObject({ failed: true, reason: '거절됨', asNew: false, inFlight: false });
    // A reload would lose it: the page says so (hasUnsentInput reads _ntBusy).
    expect(p.api.__peek('_ntBusy')).toBe(true);
    expect(p.api.__peek('_ntRequestId')).toBe('req-2');
    expect(p.api.__peek('_ntValue')).toBe('');
    expect(p.el.addFiles).not.toHaveBeenCalled();
    expect(p.toasts[0].input).toEqual({
      title: '작업을 시작하지 못했어요',
      description: '거절됨 — 지시는 “시작 실패” 카드에 남겨 두었어요',
      tone: 'error',
      action: { id: 'open', label: '지시 가져오기' },
    });
    // Taken back while the dialog still holds the other one: the dialog says why, the card stays.
    p.toasts[0].onAction?.();
    expect(p.calls.slice(-2)).toEqual([
      'open',
      'error:새 작업 창에 쓰던 지시가 있어요 — 보내거나 비운 뒤 “시작 실패” 카드를 다시 눌러 주세요',
    ]);
    expect(p.api.__peek('_ntPending')).toEqual([p.launch]);
    // Once the dialog is free: everything comes back under the same request id, and the card leaves.
    p.el.value = '';
    p.api.ntRetakeLaunch(p.launch);
    expect(p.api.__peek('_ntPending')).toHaveLength(0);
    expect(p.api.__peek('_ntBusy')).toBe(false);
    expect(p.api.__peek('_ntValue')).toBe('대시보드 개선\n자세히');
    expect(p.api.__peek('_ntRequestId')).toBe('req-1');
    expect(p.el.addFiles).toHaveBeenCalledWith([p.file]);
    expect(p.calls.slice(-2)).toEqual(['open', 'error:거절됨']);
    // The toast pressed again after it was taken back: nothing (fable #747 R2 N5).
    const before = p.calls.length;
    p.toasts[0].onAction?.();
    expect(p.calls.length).toBe(before);
  });

  it('a voice note being recorded is input: the dialog is not free (astra Z4)', () => {
    const p = page({ value: '', files: [] }, { recording: true });
    p.api.ntLaunchFailed(p.launch, '거절');
    expect(p.el.addFiles).not.toHaveBeenCalled();
    expect(p.launch).toMatchObject({ failed: true });
    expect(p.api.__peek('_ntValue')).toBe('');
  });
});

// ── T2 — 카드 열기 opens the card, never Slack ───────────────────────

describe('T2 — 카드 열기 opens the launch’s card on the board, never Slack', () => {
  function page(opts: { onBoard: boolean; pendingOnBoard?: boolean; currentUserId?: string; showSleeping?: boolean }) {
    const pc = { value: '', files: [] as unknown[] };
    const key = 'dev::work:C_ALPHA:1.2';
    const opened: string[] = [];
    const revealed: Array<[string, unknown]> = [];
    const selected: string[] = [];
    const winOpen = vi.fn();
    const host = {
      reveal: (id: string, o?: unknown) => {
        revealed.push([id, o]);
        return true;
      },
    };
    const cache: Record<string, any> = opts.onBoard ? { [key]: { key, activityState: 'working' } } : {};
    const cardHost: Record<string, unknown> = opts.onBoard ? { [key]: host } : {};
    if (opts.pendingOnBoard) cardHost['nt-launch:req-1'] = host;
    const calls: string[] = [];
    const panel = { open: false, key: null as string | null };
    const api = loadWith<{
      ntOpenLaunch(launch: any, keepAsk?: boolean): void;
      ntOpenArrivals(): void;
      ntOnLaunched(data: any, submitted: any, launch: any): void;
    }>(
      [
        'ntOpenLaunch',
        'ntOpenArrived',
        'ntOpenArrivals',
        'ntPanelNow',
        'ntPanelHasInput',
        'ntBoardIsViewers',
        'ntOnLaunched',
        'ntLaunchToast',
        'ntKeepFailed',
        'ntPendingUnsent',
        'ntPendingDrop',
        ...PENDING_FNS,
      ],
      {
        ...PENDING_CONSTS,
        _ntPending: [] as unknown[],
        _ntOpening: [] as unknown[],
        _ntBusy: true,
        _ntCtx: CTX,
        _sessionCache: cache,
        _cardHost: cardHost,
        SELF_INSTANCE_NAME: 'dev',
        currentUserId: opts.currentUserId ?? 'U1',
        _viewerUserId: 'U1',
        panelOpen: false,
        panelSessionKey: null,
        _pcSending: false,
        _pcInFlight: 0,
        showArchives: false,
        showSleeping: opts.showSleeping ?? true,
        _revealedKey: null,
        window: { open: winOpen },
        document: { getElementById: (id: string) => (id === 'kanban' ? host : id === 'pc-composer' ? pc : null) },
        openPanel: (k: string) => {
          opened.push(k);
          panel.open = true;
          panel.key = k;
        },
        selectUser: (u: string) => selected.push(u),
        loadSessions: () => calls.push('load'),
        ntPendingRepaint: () => calls.push('board'),
        ntPendingWatch: () => calls.push('watch'),
        ntRetakeLaunch: () => calls.push('retake'),
        ntRestoreLaunch: () => true,
        dashToast: (input: any, onAction?: () => void) => {
          calls.push(`toast:${input.title}`);
          (api as any).__lastToast = { input, onAction };
        },
      },
    );
    // panelOpen / panelSessionKey are page globals the open reads: kept in step with `panel`.
    const syncPanel = () => {
      (api as any).__set('panelOpen', panel.open);
      (api as any).__set('panelSessionKey', panel.key);
    };
    const launch: Record<string, any> = {
      id: 'nt-launch:req-1',
      requestId: 'req-1',
      at: Date.now(),
      inFlight: false,
      sessionKey: 'work:C_ALPHA:1.2',
      answeredAt: Date.now(),
      state: slackState('A'),
      files: [],
      phase: '',
      permalink: 'https://slack.example/p1',
    };
    const arrive = () => {
      cache[key] = { key, activityState: 'working' };
      cardHost[key] = host;
    };
    return {
      api,
      key,
      opened,
      revealed,
      selected,
      winOpen,
      cache,
      cardHost,
      host,
      calls,
      launch,
      panel,
      syncPanel,
      arrive,
      pc,
    };
  }

  it('its card on the board: the card opens there with its detail card', () => {
    const p = page({ onBoard: true });
    p.api.ntOpenLaunch(p.launch);
    expect(p.revealed).toEqual([[p.key, undefined]]);
    expect(p.opened).toEqual([p.key]);
    expect(p.winOpen).not.toHaveBeenCalled();
    expect(p.api.__peek('_ntOpening')).toEqual([]);
  });

  it('not there yet: its 시작 중 card comes into view, and the card opens the moment a render brings it', () => {
    const p = page({ onBoard: false, pendingOnBoard: true });
    p.api.ntOpenLaunch(p.launch);
    expect(p.winOpen).not.toHaveBeenCalled();
    expect(p.opened).toEqual([]);
    expect(p.revealed).toEqual([['nt-launch:req-1', { open: false }]]);
    expect(p.calls).toContain('watch');
    expect(p.api.__peek('_ntOpening')).toEqual([p.launch]);
    expect(p.launch).toMatchObject({ wantOpen: true, openFrom: '' });
    // A render that does not bring it changes nothing.
    p.api.ntOpenArrivals();
    expect(p.opened).toEqual([]);
    // The card arrives (a poll / push renders the board, which ends in ntOpenArrivals).
    p.arrive();
    p.api.ntOpenArrivals();
    expect(p.revealed[p.revealed.length - 1]).toEqual([p.key, undefined]);
    expect(p.opened).toEqual([p.key]);
    expect(p.api.__peek('_ntOpening')).toEqual([]);
    expect(p.winOpen).not.toHaveBeenCalled();
  });

  // Review (#747 R1 — fable P2-1): a panel the reader moved to (and the note typed there) is never taken over.
  it('the reader opened another card meanwhile: the arriving card only comes into view, the panel stays theirs', () => {
    const p = page({ onBoard: false, pendingOnBoard: true });
    p.api.ntOpenLaunch(p.launch);
    p.panel.open = true;
    p.panel.key = 'dev::work:C_ALPHA:other';
    p.syncPanel();
    p.arrive();
    p.api.ntOpenArrivals();
    expect(p.revealed[p.revealed.length - 1]).toEqual([p.key, { open: false }]);
    expect(p.opened).toEqual([]);
    expect(p.api.__peek('_ntOpening')).toEqual([]);
  });

  // Review (fable #747 R2 N3): a note being written in the open card is not replaced either.
  it('the reader is writing in the same open card: the arriving card only comes into view', () => {
    const p = page({ onBoard: false, pendingOnBoard: true });
    p.panel.open = true;
    p.panel.key = 'dev::work:C_ALPHA:other';
    p.syncPanel();
    p.api.ntOpenLaunch(p.launch);
    p.pc.value = '쓰던 메모';
    p.arrive();
    p.api.ntOpenArrivals();
    expect(p.revealed[p.revealed.length - 1]).toEqual([p.key, { open: false }]);
    expect(p.opened).toEqual([]);
    // Nothing written there: it opens as asked.
    const q = page({ onBoard: false, pendingOnBoard: true });
    q.panel.open = true;
    q.panel.key = 'dev::work:C_ALPHA:other';
    q.syncPanel();
    q.api.ntOpenLaunch(q.launch);
    q.arrive();
    q.api.ntOpenArrivals();
    expect(q.opened).toEqual([q.key]);
  });

  // Review (fable #747 R2 N7): a card the 휴면 toggle hides is shown for this page load, then opened.
  it('its card hidden by the 휴면 toggle: shown just for this page load, and the board asked again', () => {
    const p = page({ onBoard: false, showSleeping: false });
    p.api.ntOpenLaunch(p.launch);
    p.cache[p.key] = { key: p.key, activityState: 'idle' };
    p.api.ntOpenArrivals();
    expect(p.api.__peek('_revealedKey')).toBe(p.key);
    expect(p.calls).toContain('load');
    expect(p.api.__peek('_ntOpening')).toEqual([p.launch]);
    p.cardHost[p.key] = p.host;
    p.api.ntOpenArrivals();
    expect(p.opened).toEqual([p.key]);
  });

  it('an ask past NT_OPEN_WAIT_MS is dropped', () => {
    const p = page({ onBoard: false });
    p.api.ntOpenLaunch(p.launch);
    p.launch.openUntil = Date.now() - 1;
    p.arrive();
    p.api.ntOpenArrivals();
    expect(p.opened).toEqual([]);
    expect(p.api.__peek('_ntOpening')).toEqual([]);
  });

  // Review (#747 R1 — astra Z3): the card lands on the viewer's own board.
  it('from another user’s board: the viewer’s own board comes first, and the card opens when it lands there', () => {
    const p = page({ onBoard: false, currentUserId: 'U2' });
    p.api.ntOpenLaunch(p.launch);
    expect(p.selected).toEqual(['U1']);
    expect(p.api.__peek('_ntOpening')).toEqual([p.launch]);
    (p.api as any).__set('currentUserId', 'U1');
    p.arrive();
    p.api.ntOpenArrivals();
    expect(p.opened).toEqual([p.key]);
  });

  it('a launch with no session key opens nothing — Slack least of all', () => {
    const p = page({ onBoard: false });
    p.api.ntOpenLaunch({ ...p.launch, sessionKey: '' });
    expect(p.winOpen).not.toHaveBeenCalled();
    expect(p.opened).toEqual([]);
  });

  it('a 시작 실패 card pressed is taken back, not opened', () => {
    const p = page({ onBoard: false });
    p.api.ntOpenLaunch({ ...p.launch, failed: true });
    expect(p.calls).toContain('retake');
    expect(p.opened).toEqual([]);
  });

  it('the launch toast’s 카드 열기 goes through ntOpenLaunch; a 시작 중 card pressed before the answer opens on it', () => {
    const p = page({ onBoard: true });
    const launch: Record<string, any> = { ...p.launch, inFlight: true, sessionKey: '', answeredAt: 0 };
    (p.api.__peek('_ntPending') as unknown[]).push(launch);
    // Pressed while on its way: nothing to open yet; the ask waits for the answer.
    p.api.ntOpenLaunch(launch);
    expect(p.opened).toEqual([]);
    p.api.ntOnLaunched(
      {
        ok: true,
        channel: 'C_ALPHA',
        status: 'running',
        sessionKey: 'work:C_ALPHA:1.2',
        permalink: 'https://slack.example/p1',
      },
      launch.state,
      launch,
    );
    // Answered: no longer in flight, waiting for its card under the key.
    expect(launch).toMatchObject({
      inFlight: false,
      sessionKey: 'work:C_ALPHA:1.2',
      permalink: 'https://slack.example/p1',
    });
    expect(p.api.__peek('_ntBusy')).toBe(false);
    expect(p.calls).toContain('toast:작업을 시작했어요');
    // Pressed while on its way: it opens as soon as it is answered (the card is on the board).
    expect(p.opened).toEqual([p.key]);
    // 카드 열기 on the toast: the card again — never window.open.
    const toast = (p.api as any).__lastToast;
    expect(toast.input.action).toEqual({ id: 'open', label: '카드 열기' });
    toast.onAction();
    expect(p.opened[p.opened.length - 1]).toBe(p.key);
    expect(p.winOpen).not.toHaveBeenCalled();
  });

  // Review (grok #747 R1 P2): a dashboard task created but not started is no task starting — its card leaves now.
  it('a task created but not started takes its 시작 중 card off at once (카드 열기 still opens the task)', () => {
    const p = page({ onBoard: false });
    const launch: Record<string, any> = { ...p.launch, inFlight: true, sessionKey: '', answeredAt: 0 };
    (p.api.__peek('_ntPending') as unknown[]).push(launch);
    p.api.ntOnLaunched(
      { ok: true, sessionKey: 'task:t-1', status: 'not-started', reason: 'busy' },
      launch.state,
      launch,
    );
    expect(p.api.__peek('_ntPending')).toHaveLength(0);
    // The board is asked once: the task's card comes without a 시작 중 card waiting for it.
    expect(p.calls).toContain('load');
    expect(p.calls).toContain('toast:작업을 만들었지만 아직 시작하지 못했어요');
    expect(launch.sessionKey).toBe('task:t-1');
  });

  it('a task made but not started whose instruction waits on a 시작 실패 card: the toast says 지시 가져오기 (R2 N8)', () => {
    const p = page({ onBoard: false });
    const t = (p.api as any).ntLaunchToast(
      { sessionKey: 'task:x', status: 'not-started', reason: 'busy' },
      null,
      false,
    );
    expect(t).toMatchObject({
      description: 'busy — 지시는 “시작 실패” 카드에 남겨 두었어요',
      action: { id: 'open', label: '지시 가져오기' },
    });
  });

  it('the page no longer falls back to the Slack thread from 카드 열기', () => {
    expect(TEMPLATE).not.toContain('function ntOpenLaunched(');
    expect(TEMPLATE).not.toContain('window.open(launch.permalink');
    // One mechanism opens a launch's card on arrival: not the URL deep link's.
    expect(clientFn('ntOpenLaunch')).not.toContain('_deepLinkSession');
  });

  it('a press on a 시작 중 or 시작 실패 card (no session) goes to ntOpenLaunch instead of doing nothing', () => {
    const wire = clientFn('wireInbox');
    expect(wire).toContain('var launch = ntPendingOf(key);');
    expect(wire).toContain('if (launch) ntOpenLaunch(launch);');
  });
});

// Review (fable #747 R2 N2): a POST that hangs is given up, so it never holds the launches queued behind it.
describe('T1 — a launch’s POST has a deadline that follows its upload (ntPostTask)', () => {
  function post() {
    const xhrs: any[] = [];
    class FakeXhr {
      upload: Record<string, any> = {};
      status = 0;
      responseText = '';
      onload: any;
      onerror: any;
      onabort: any;
      aborted = false;
      constructor() {
        xhrs.push(this);
      }
      open() {}
      setRequestHeader() {}
      send() {}
      abort() {
        this.aborted = true;
        this.onabort?.();
      }
    }
    const statuses: string[] = [];
    const api = loadWith<{ ntPostTask(body: string, launch: unknown): Promise<any> }>(['ntPostTask'], {
      XMLHttpRequest: FakeXhr,
      _csrfToken: 't',
      NT_POST_STALL_MS: 60000,
      NT_POST_ANSWER_MS: 60000,
      ntPendingStatus: (_l: unknown, t: string) => statuses.push(t),
    });
    return { api, xhrs, statuses };
  }

  it('no upload progress for NT_POST_STALL_MS: aborted and rejected; progress keeps it alive', async () => {
    vi.useFakeTimers();
    try {
      const p = post();
      const run = p.api.ntPostTask('{}', { state: { destination: 'slack' } });
      const settled = run.then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(50_000);
      p.xhrs[0].upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 });
      await vi.advanceTimersByTimeAsync(50_000);
      expect(p.xhrs[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(p.xhrs[0].aborted).toBe(true);
      expect(await settled).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the upload done, no answer for NT_POST_ANSWER_MS: aborted; an answer in time clears the deadline', async () => {
    vi.useFakeTimers();
    try {
      const late = post();
      const lateRun = late.api.ntPostTask('{}', { state: {} }).catch((e: Error) => e.message);
      late.xhrs[0].upload.onload();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await lateRun).toBe('timeout');
      const ok = post();
      const okRun = ok.api.ntPostTask('{}', { state: {} });
      ok.xhrs[0].upload.onload();
      ok.xhrs[0].status = 200;
      ok.xhrs[0].responseText = '{"ok":true}';
      ok.xhrs[0].onload();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(ok.xhrs[0].aborted).toBe(false);
      expect(await okRun).toEqual({ status: 200, data: { ok: true } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T1 — upload progress is said on the card, not in the closed dialog', () => {
  it('ntPostTask reports to the launch’s card', () => {
    const post = clientFn('ntPostTask');
    expect(post).toContain('function ntPostTask(body, launch)');
    expect(post).toContain("ntPendingStatus(launch, '업로드 중… '");
    expect(post).not.toContain('ntSetStatus(');
    // The destination is the launch's, not the dialog's next task.
    expect(post).not.toContain('_ntState');
  });
});

// Review (fable #747 R2 N4): 카드 열기 from another user's board switches the board — the picker shows it too.
describe('T2 — selectUser keeps the user picker on the board it shows', () => {
  it('sets the picker’s value when called from the page, before its title is read', () => {
    const sel: Record<string, any> = {
      value: 'U2',
      title: '',
      options: [
        { value: 'U1', textContent: '나' },
        { value: 'U2', textContent: '다른 사람' },
      ],
    };
    Object.defineProperty(sel, 'selectedIndex', {
      get() {
        return sel.options.findIndex((o: { value: string }) => o.value === sel.value);
      },
    });
    const api = loadWith<{ selectUser(u: string): void }>(['selectUser', 'syncUserSelectTitle'], {
      document: { getElementById: (id: string) => (id === 'user-select' ? sel : null) },
      currentUserId: 'U2',
      syncBoardScope: () => {},
      history: { replaceState: () => {} },
      paintTrail: () => {},
      loadSessions: () => {},
      loadStats: () => {},
      loadCronJobs: () => {},
    });
    api.selectUser('U1');
    expect(sel.value).toBe('U1');
    expect(sel.title).toBe('나');
    expect(api.__peek('currentUserId')).toBe('U1');
  });
});

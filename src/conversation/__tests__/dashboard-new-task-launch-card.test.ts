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
  const body = `${names.map((n) => `let ${n} = __g.${n};`).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, __peek: function (k) { return eval(k); } };`;
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
  NT_OPEN_WAIT_MS: 60000,
};
const PENDING_FNS = [
  'ntLaunchTitle',
  'ntPendingCardOf',
  'ntPendingSettle',
  'ntPendingInFlight',
  'ntPendingOf',
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
  function page(state: Record<string, unknown>, composerFiles: unknown[] = []) {
    const calls: string[] = [];
    const posted: string[] = [];
    const composer = {
      value: String(state.prompt || ''),
      files: composerFiles,
      clear: vi.fn(() => calls.push('clear')),
    };
    const store = new Map<string, string>([['soma-nt-draft', '{"prompt":"x"}']]);
    let answer!: (v: unknown) => void;
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
        ntPendingStatus: () => {},
        ntReadFile: async (f: { name: string }) => ({ name: f.name, mimetype: 'image/png', data: 'AA' }),
        refreshCsrfToken: async () => {},
        // The server has not answered yet.
        ntPostTask: (b: string) => {
          posted.push(b);
          return new Promise((r) => {
            answer = r;
          });
        },
        ntOnLaunched: () => calls.push('launched'),
        ntLaunchFailed: () => calls.push('failed'),
      },
    );
    return { api, calls, posted, composer, store, answer: (v: unknown) => answer(v) };
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
});

describe('T1 — the board draws the 시작 중 cards first in RUNNING (ntPendingPlace)', () => {
  function board(opts: { currentUserId?: string; viewer?: string } = {}) {
    const now = Date.now();
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
      answeredAt: now,
      state: { destination: 'task', prompt: 'C' },
      files: [],
      phase: '',
    };
    const maps = {
      _cardHost: {} as Record<string, unknown>,
      _cardCol: {} as Record<string, string>,
      _cardData: {} as Record<string, any>,
      _cardDrawn: {} as Record<string, boolean>,
    };
    const host = { id: 'kanban' };
    const api = loadWith<{ ntPendingPlace(host: unknown): string[] }>(['ntPendingPlace', ...PENDING_FNS], {
      ...PENDING_CONSTS,
      ...maps,
      _ntPending: [inFlight, arrived, waiting],
      // B's own card is on the board (this instance's prefix, #814).
      _sessionCache: { 'dev::work:C_ALPHA:1.2': { key: 'dev::work:C_ALPHA:1.2' } },
      SELF_INSTANCE_NAME: 'dev',
      currentUserId: opts.currentUserId ?? 'U1',
      _viewerUserId: opts.viewer ?? 'U1',
      _ntCtx: CTX,
    });
    return { api, maps, host };
  }

  it('a launch whose card is on the board leaves; the rest are drawn as RUNNING cards', () => {
    const b = board();
    expect(b.api.ntPendingPlace(b.host)).toEqual(['nt-launch:a', 'nt-launch:c']);
    expect(b.api.__peek('_ntPending').map((p: { id: string }) => p.id)).toEqual(['nt-launch:a', 'nt-launch:c']);
    expect(b.maps._cardHost['nt-launch:a']).toBe(b.host);
    expect(b.maps._cardCol['nt-launch:a']).toBe('working');
    expect(b.maps._cardDrawn['nt-launch:c']).toBe(true);
    expect(b.maps._cardData['nt-launch:a']).toMatchObject({ title: 'A', status: 'running', statusText: '시작 중' });
  });

  it('the All Users board draws them too', () => {
    const b = board({ currentUserId: '' });
    expect(b.api.ntPendingPlace(b.host)).toEqual(['nt-launch:a', 'nt-launch:c']);
  });

  it('another user’s board draws none — and drops none', () => {
    const b = board({ currentUserId: 'U2' });
    expect(b.api.ntPendingPlace(b.host)).toEqual([]);
    expect(b.api.__peek('_ntPending')).toHaveLength(3);
  });

  it('renderBoard puts them at the head of RUNNING, after the per-render maps were reset', () => {
    const render = clientFn('renderBoard');
    const reset = render.indexOf('_cardDrawn = Object.create(null);');
    const place = render.indexOf('var pendingKeys = ntPendingPlace(kb);');
    expect(reset).toBeGreaterThan(0);
    expect(place).toBeGreaterThan(reset);
    expect(render).toContain("keys: pendingKeys.concat(keys(rest.working, 'working', kb))");
  });
});

describe('T1 — a 시작 중 card waits for its card, not forever (ntPendingSettle)', () => {
  const fns = loadWith<{ ntPendingSettle(list: any[], keys: string[], self: string, now: number): any[] }>(
    PENDING_FNS,
    { ...PENDING_CONSTS, _ntPending: [], _ntCtx: CTX },
  );
  const now = 10_000_000;

  it('keeps a launch on its way however long it takes (a failure takes it back itself)', () => {
    const list = [{ id: 'a', at: now - 600_000, sessionKey: '' }];
    expect(fns.ntPendingSettle(list, [], 'dev', now)).toEqual(list);
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

describe('T1 — a launch that fails takes its card back and gives the instruction back (ntLaunchFailed)', () => {
  function page(composer: { value: string; files: unknown[] }) {
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
    const api = loadWith<{
      ntLaunchFailed(launch: any, message: string): void;
    }>(
      ['ntLaunchFailed', 'ntRestoreLaunch', 'ntComposerPristine', 'ntReopenWithError', 'ntReconcile', ...PENDING_FNS],
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
        ntDictating: () => false,
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

  it('a dialog holding a new instruction is left alone — the toast names the one that failed', () => {
    const p = page({ value: '다음 작업', files: [] });
    p.api.ntLaunchFailed(p.launch, '거절됨');
    expect(p.api.__peek('_ntPending')).toHaveLength(0);
    expect(p.api.__peek('_ntRequestId')).toBe('req-2');
    expect(p.api.__peek('_ntValue')).toBe('');
    expect(p.el.addFiles).not.toHaveBeenCalled();
    expect(p.toasts[0].input).toMatchObject({ title: '작업을 시작하지 못했어요', tone: 'error' });
    expect(p.toasts[0].input.description).toBe('거절됨 · 대시보드 개선');
    expect(p.toasts[0].input.action).toBeUndefined();
  });
});

// ── T2 — 카드 열기 opens the card, never Slack ───────────────────────

describe('T2 — 카드 열기 opens the launch’s card on the board, never Slack', () => {
  function page(opts: { onBoard: boolean; pendingOnBoard?: boolean }) {
    const key = 'dev::work:C_ALPHA:1.2';
    const opened: string[] = [];
    const revealed: Array<[string, unknown]> = [];
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
    const api = loadWith<{
      ntOpenLaunch(launch: any): void;
      openDeepLinkedSession(): void;
      ntOnLaunched(data: any, submitted: any, launch: any): void;
    }>(['ntOpenLaunch', 'openDeepLinkedSession', 'ntOnLaunched', 'ntLaunchToast', ...PENDING_FNS], {
      ...PENDING_CONSTS,
      _ntPending: [] as unknown[],
      _ntBusy: true,
      _ntCtx: CTX,
      _deepLinkSession: null,
      _deepLinkDeadline: 0,
      _deepLinkWaiting: false,
      _sessionCache: cache,
      _cardHost: cardHost,
      _cronRevealKey: null,
      _cronLaneRevealed: false,
      _revealedKey: null,
      _lastBoardData: null,
      showArchives: false,
      showSleeping: true,
      panelOpen: false,
      panelSessionKey: null,
      SELF_INSTANCE_NAME: 'dev',
      window: { open: winOpen, customElements: null },
      document: { getElementById: (id: string) => (id === 'kanban' ? host : null) },
      openPanel: (k: string) => opened.push(k),
      applySectionState: () => {},
      renderBoard: () => {},
      loadSessions: () => calls.push('load'),
      ntPendingRepaint: () => calls.push('board'),
      ntPendingWatch: () => calls.push('watch'),
      ntRestoreLaunch: () => true,
      dashToast: (input: any, onAction?: () => void) => {
        calls.push(`toast:${input.title}`);
        (api as any).__lastToast = { input, onAction };
      },
    });
    const launch = {
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
    return { api, key, opened, revealed, winOpen, cache, cardHost, host, calls, launch };
  }

  it('its card on the board: the card opens there with its detail card', () => {
    const p = page({ onBoard: true });
    p.api.ntOpenLaunch(p.launch);
    expect(p.revealed).toEqual([[p.key, undefined]]);
    expect(p.opened).toEqual([p.key]);
    expect(p.winOpen).not.toHaveBeenCalled();
    expect(p.api.__peek('_deepLinkSession')).toBeNull();
  });

  it('not there yet: its 시작 중 card comes into view, and the card opens the moment it arrives', () => {
    const p = page({ onBoard: false, pendingOnBoard: true });
    p.api.ntOpenLaunch(p.launch);
    expect(p.winOpen).not.toHaveBeenCalled();
    expect(p.opened).toEqual([]);
    expect(p.revealed).toEqual([['nt-launch:req-1', { open: false }]]);
    expect(p.calls).toContain('watch');
    // Armed for the next renders (the deep link's path), for NT_OPEN_WAIT_MS.
    expect(p.api.__peek('_deepLinkSession')).toBe('work:C_ALPHA:1.2');
    expect(p.api.__peek('_deepLinkDeadline')).toBeGreaterThan(Date.now() + 50_000);
    // The card arrives (a poll / push renders the board, which ends in openDeepLinkedSession).
    p.cache[p.key] = { key: p.key, activityState: 'working' };
    p.cardHost[p.key] = p.host;
    p.api.openDeepLinkedSession();
    expect(p.revealed[p.revealed.length - 1]).toEqual([p.key, undefined]);
    expect(p.opened).toEqual([p.key]);
    expect(p.winOpen).not.toHaveBeenCalled();
  });

  it('a launch with no session key opens nothing — Slack least of all', () => {
    const p = page({ onBoard: false });
    p.api.ntOpenLaunch({ ...p.launch, sessionKey: '' });
    expect(p.winOpen).not.toHaveBeenCalled();
    expect(p.opened).toEqual([]);
  });

  it('the launch toast’s 카드 열기 goes through ntOpenLaunch; a 시작 중 card pressed before the answer opens on it', () => {
    const p = page({ onBoard: true });
    const launch = { ...p.launch, inFlight: true, sessionKey: '', answeredAt: 0, wantOpen: true };
    (p.api.__peek('_ntPending') as unknown[]).push(launch);
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
    expect(launch).toMatchObject({ inFlight: false, sessionKey: 'work:C_ALPHA:1.2' });
    expect(p.api.__peek('_ntBusy')).toBe(false);
    expect(p.calls).toContain('toast:작업을 시작했어요');
    // Pressed while on its way (wantOpen): it opens as soon as it is answered.
    expect(p.opened).toEqual([p.key]);
    // 카드 열기 on the toast: the card again — never window.open.
    const toast = (p.api as any).__lastToast;
    expect(toast.input.action).toEqual({ id: 'open', label: '카드 열기' });
    toast.onAction();
    expect(p.opened).toEqual([p.key, p.key]);
    expect(p.winOpen).not.toHaveBeenCalled();
  });

  it('the page no longer falls back to the Slack thread from 카드 열기', () => {
    expect(TEMPLATE).not.toContain('function ntOpenLaunched(');
    expect(TEMPLATE).not.toContain('window.open(launch.permalink');
  });

  it('a press on a 시작 중 card (no session yet) arms the same open instead of doing nothing', () => {
    const wire = clientFn('wireInbox');
    expect(wire).toContain('var launch = ntPendingOf(key);');
    expect(wire).toContain('if (launch) ntOpenLaunch(launch);');
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

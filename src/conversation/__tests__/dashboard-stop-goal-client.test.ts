/**
 * SSOT 2026-11-19 (Z), the page half — run from the shipped client code cut out of renderDashboardPage()'s template
 * literal (the server half: slack-handler.followup.test.ts `pauseGoalForStop`, task-stop.test.ts, dashboard-goal.test.ts):
 *
 *   "작업 카드 중지누르면 현재 진행중이 골이 있으면 골때문에 중지가 안됨 그래서 작업 카드 눌렀을때 진행중인 goal이 있으면
 *    진행중인 goal을 puase하고 중지하겠냐고 한번더 물어보고 최종 확인 받으면, goal부터 pause 처리하고 작업 중지처리해줘"
 *
 *   Q1  Stop on a session whose goal runs asks first (askStopGoal) — nothing is sent, nothing is busy
 *   Q2  the question names the goal and says what happens to the goals queued behind it
 *   Q3  취소 sends nothing; the yes sends the stop with the goal to pause (pauseGoalId), and the toast says both happened
 *   Q4  no goal runs: Stop stops at once, with no body, as before
 *   Q5  a refusal says why; its Retry asks again on fresh data instead of resending a stale goal id
 *   I1  every Korean string the change shows has an English entry (en-page catalog)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageText, registerPageCatalog, scanPage } from '@soma/common/i18n-page';
import { describe, expect, it, vi } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';

registerPageCatalog(
  JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'),
      'utf8',
    ),
  ),
);

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
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));

const KEY = 'inst::C1:t1';
const GOAL = { goalId: 'g1', objective: '릴리즈 <준비>', status: 'active', continuationCount: 1, maxContinuations: 10 };
const withGoal = (current: Record<string, unknown> | null, queue: unknown[] = []) => ({
  key: KEY,
  title: '배포 작업',
  ...(current ? { goal: { current, queue, paused: [], history: [], completedCount: 0 } } : {}),
});

type Toast = { title: string; description?: string; tone?: string };
type Page = {
  doAction(k: string, a: string, opts?: { pauseGoalId?: string }): Promise<void>;
  stopGoalOf(s: unknown): { goalId: string; objective: string; queued: number } | null;
  askStopGoal(k: string, g: unknown): void;
  confirmStopGoal(): void;
  closeStopGoalDialog(): void;
  isBusy(k: string, op: string): boolean;
};

function rig(session: unknown, res: { ok: boolean; status: number; body?: unknown } = { ok: true, status: 200 }) {
  const toasts: Array<[Toast, (() => void) | undefined]> = [];
  const calls: Array<{ url: string; init: any }> = [];
  const dialog = { show: vi.fn(), hide: vi.fn() };
  const body = { innerHTML: '' };
  const env: Record<string, unknown> = {
    _busy: Object.create(null),
    _csrfToken: 't',
    _sessionCache: { [KEY]: session },
    panelOpen: false,
    panelSessionKey: null,
    refreshCard: vi.fn(),
    renderPanelHead: vi.fn(),
    refreshCsrfToken: vi.fn(),
    loadSessions: vi.fn(),
    BOARD_LOAD_TIMEOUT_MS: 20000,
    console: { error: () => {} },
    dashToast: (t: Toast, fn?: () => void) => toasts.push([t, fn]),
    document: {
      getElementById: (id: string) => (id === 'stop-goal-dialog' ? dialog : id === 'stop-goal-body' ? body : null),
    },
    window: {},
    fetch: vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: res.ok, status: res.status, json: async () => res.body ?? {} };
    }),
  };
  const page = load<Page>(
    [
      'esc',
      'toNum',
      'isBusy',
      'setBusy',
      'stopGoalOf',
      'stopGoalHtml',
      'askStopGoal',
      'closeStopGoalDialog',
      'confirmStopGoal',
      'doAction',
    ],
    ['_stopGoalPick', 'DA_LABEL', 'DA_DONE', 'DA_DONE_GOAL_PAUSED'],
    env,
  );
  return { page, toasts, calls, dialog, body, env };
}

describe('stopGoalOf — the goal a stop must pause first', () => {
  const { page } = rig(null);
  it('a running goal, with how many goals wait behind it', () => {
    expect(page.stopGoalOf(withGoal(GOAL, [{ goalId: 'g2' }, { goalId: 'g3' }]))).toEqual({
      goalId: 'g1',
      objective: '릴리즈 <준비>',
      queued: 2,
    });
  });
  it.each([
    ['no goal', withGoal(null)],
    ['a paused goal', withGoal({ ...GOAL, status: 'paused' })],
    ['a completed goal', withGoal({ ...GOAL, status: 'complete' })],
    ['no session', undefined],
  ])('%s: nothing to pause', (_label, s) => {
    expect(page.stopGoalOf(s)).toBeNull();
  });
});

describe('Q1/Q2 — Stop on a session whose goal runs asks first', () => {
  it('nothing is sent and nothing is busy; the question opens, naming the goal (escaped)', async () => {
    const r = rig(withGoal(GOAL));
    await r.page.doAction(KEY, 'stop');
    expect(r.calls).toEqual([]);
    expect(r.page.isBusy(KEY, 'action')).toBe(false);
    expect(r.dialog.show).toHaveBeenCalledTimes(1);
    expect(r.body.innerHTML).toContain('진행 중인 goal이 있어요');
    expect(r.body.innerHTML).toContain('릴리즈 &lt;준비&gt;');
    expect(r.body.innerHTML).not.toContain('대기 중인 goal');
  });

  it('goals queued behind it: the question says they do not start', async () => {
    const r = rig(withGoal(GOAL, [{ goalId: 'g2' }]));
    await r.page.doAction(KEY, 'stop');
    expect(r.body.innerHTML).toContain('대기 중인 goal 1개는 시작하지 않고 그대로 기다립니다.');
  });

  it('the dialog element is not upgraded yet: it asks once it is — nothing is sent meanwhile', async () => {
    const r = rig(withGoal(GOAL));
    const late = { show: vi.fn(), hide: vi.fn() } as { show?: unknown; hide: unknown };
    const show = late.show;
    delete late.show;
    let defined: () => void = () => {};
    (r.env.window as any).customElements = {
      whenDefined: vi.fn(() => new Promise<void>((res) => (defined = res))),
    };
    (r.env.document as any).getElementById = (id: string) =>
      id === 'stop-goal-dialog' ? late : id === 'stop-goal-body' ? r.body : null;
    await r.page.doAction(KEY, 'stop');
    expect(r.calls).toEqual([]);
    expect((r.env.window as any).customElements.whenDefined).toHaveBeenCalledWith('ui-dialog');
    late.show = show;
    defined();
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(r.calls).toEqual([]);
  });

  it('Close and Trash never ask', async () => {
    const r = rig(withGoal(GOAL));
    await r.page.doAction(KEY, 'close');
    await r.page.doAction(KEY, 'trash');
    expect(r.dialog.show).not.toHaveBeenCalled();
    expect(r.calls.map((c) => c.url)).toEqual([
      `/api/dashboard/session/${encodeURIComponent(KEY)}/close`,
      `/api/dashboard/session/${encodeURIComponent(KEY)}/trash`,
    ]);
  });
});

describe('Q3 — 취소 sends nothing; the yes pauses the goal and stops', () => {
  it('취소: the question closes, nothing is sent', async () => {
    const r = rig(withGoal(GOAL));
    await r.page.doAction(KEY, 'stop');
    r.page.closeStopGoalDialog();
    r.page.confirmStopGoal(); // a stray press after 취소 has nothing to confirm
    expect(r.dialog.hide).toHaveBeenCalled();
    expect(r.calls).toEqual([]);
  });

  it('the yes: one stop carrying the goal to pause, then a toast that says both happened', async () => {
    const r = rig(withGoal(GOAL));
    await r.page.doAction(KEY, 'stop');
    r.page.confirmStopGoal();
    await vi.waitFor(() => expect(r.toasts).toHaveLength(1));

    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe(`/api/dashboard/session/${encodeURIComponent(KEY)}/stop`);
    expect(r.calls[0].init.method).toBe('POST');
    expect(JSON.parse(r.calls[0].init.body)).toEqual({ pauseGoalId: 'g1' });
    expect(r.calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-CSRF-Token': 't' });
    expect(r.toasts[0][0]).toEqual({
      title: 'goal을 일시정지하고 세션을 중지했어요',
      description: '배포 작업',
      tone: 'success',
    });
  });
});

describe('Q4 — no goal runs: Stop stops at once, as before', () => {
  it('one stop with no body, no question', async () => {
    const r = rig(withGoal(null));
    await r.page.doAction(KEY, 'stop');
    expect(r.dialog.show).not.toHaveBeenCalled();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].init.body).toBeUndefined();
    expect(r.toasts[0][0]).toMatchObject({ title: '세션을 중지했어요', tone: 'success' });
  });
});

describe('Q6 — a card that did not know its goal runs (stale board): the server says so, the card asks', () => {
  it('a plain stop answered 409 with the goal: the question opens, no error toast', async () => {
    const r = rig(withGoal(null), {
      ok: false,
      status: 409,
      body: { error: 'A goal is running', goal: { goalId: 'g9', objective: '방금 시작한 goal', queued: 0 } },
    });
    await r.page.doAction(KEY, 'stop');

    expect(r.calls).toHaveLength(1);
    expect(r.toasts).toEqual([]);
    expect(r.dialog.show).toHaveBeenCalledTimes(1);
    expect(r.body.innerHTML).toContain('방금 시작한 goal');
    expect(r.page.isBusy(KEY, 'action')).toBe(false);
    // The yes pauses that goal.
    r.page.confirmStopGoal();
    await vi.waitFor(() => expect(r.calls).toHaveLength(2));
    expect(JSON.parse(r.calls[1].init.body)).toEqual({ pauseGoalId: 'g9' });
  });

  it('a 409 without a goal (another refusal) is still an error toast', async () => {
    const r = rig(withGoal(null), { ok: false, status: 409, body: { error: '닫는 중이에요' } });
    await r.page.doAction(KEY, 'stop');
    expect(r.dialog.show).not.toHaveBeenCalled();
    expect(r.toasts[0][0]).toMatchObject({ title: '중지 실패', tone: 'error' });
  });
});

describe('Q5 — a refusal says why, and Retry asks again', () => {
  it('the server refused the pause: the toast carries the reason; Retry re-asks instead of resending g1', async () => {
    const reason = 'Another goal is running now — refresh and try again';
    const r = rig(withGoal(GOAL), { ok: false, status: 409, body: { error: reason } });
    await r.page.doAction(KEY, 'stop', { pauseGoalId: 'g1' });

    expect(r.toasts[0][0]).toMatchObject({ title: '중지 실패', description: `${reason} · 배포 작업`, tone: 'error' });
    r.toasts[0][1]?.();
    await Promise.resolve();
    // Asked again (the goal may have changed), not sent again with the stale id.
    expect(r.calls).toHaveLength(1);
    expect(r.dialog.show).toHaveBeenCalledTimes(1);
  });

  it('a pause refused with another status (503) still says why', async () => {
    const r = rig(withGoal(GOAL), { ok: false, status: 503, body: { error: 'Session not found' } });
    await r.page.doAction(KEY, 'stop', { pauseGoalId: 'g1' });
    expect(r.toasts[0][0].description).toBe('Session not found · 배포 작업');
  });
});

describe('the question on the page', () => {
  const dialog = PAGE.slice(
    PAGE.indexOf('<ui-dialog id="stop-goal-dialog"'),
    PAGE.indexOf('</ui-dialog>', PAGE.indexOf('id="stop-goal-dialog"')),
  );

  it('a dialog with the body slot, 취소 and the red yes', () => {
    expect(dialog).toContain('heading="진행 중인 goal이 있어요"');
    expect(dialog).toContain('id="stop-goal-body"');
    expect(dialog).toMatch(/<button type="button" class="ui-btn" onclick="closeStopGoalDialog\(\)">취소<\/button>/);
    expect(dialog).toMatch(
      /<button type="button" class="ui-btn is-danger" id="stop-goal-confirm" onclick="confirmStopGoal\(\)">goal 일시정지하고 중지<\/button>/,
    );
  });

  it('I1 — every Korean string of the change has its English', () => {
    const script = `${dialog}</ui-dialog>\n<script>\n${['stopGoalHtml', 'askStopGoal', 'doAction'].map(clientFn).join('\n')}\n${clientVar('DA_DONE_GOAL_PAUSED')}\n</script>`;
    const missing = scanPage(script)
      .filter((seg) => !seg.skip && pageText(seg.key) === undefined)
      .map((seg) => seg.key);
    expect(missing).toEqual([]);
  });
});

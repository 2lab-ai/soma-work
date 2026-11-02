/**
 * Who may do what on a board card (SSOT 2026-11-02) — the page half, run from the shipped template
 * (each function is cut out of renderDashboardPage()'s template literal and evaluated as the browser
 * receives it; the harness of dashboard-star-revive-client.test.ts).
 *
 *   T1  "내 태스크" is the signed-in viewer's task in every view — the All Users board (filter '') and
 *       another user's board too — never the board filter's user
 *   T2  an admin with 관리자 모드 on manages every task (stop · close · trash · star · revive · compact)
 *   T3  every signed-in user instructs every task (the composer, a question's answer) — as in a Slack
 *       thread; closing someone else's task stays the owner's or an admin's in 관리자 모드
 *
 * The server re-checks every write (dashboard-task-permissions.test.ts); this is UX only.
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
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const VIEWER_FNS = ['viewerOwns', 'viewerCanManage', 'viewerCanInstruct'];
const FNS = [
  ...VIEWER_FNS,
  'toNum',
  'pendingAutoResume',
  'isBusy',
  'isSiblingSession',
  'sessionActionsOf',
  'pcModeOf',
  'cwCanCompact',
  'acQuestionLock',
  'isPermissionRequester',
];

type Action = { id: string; lock: string };
type Page = {
  viewerOwns(s: unknown): boolean;
  viewerCanManage(s: unknown): boolean;
  viewerCanInstruct(s: unknown): boolean;
  sessionActionsOf(s: unknown, col: string): Action[];
  pcModeOf(s: unknown): string;
  cwCanCompact(s: unknown): string;
  acQuestionLock(s: unknown): string;
  isPermissionRequester(p: unknown): boolean;
};

/** The page as `viewer` sees it, on the board of `board` ('' = All Users), admin mode on or off. */
function page(viewer: string, board: string, opts: { admin?: boolean; adminMode?: boolean } = {}): Page {
  return load<Page>(FNS, [], {
    _busy: Object.create(null),
    currentUserId: board,
    _viewerUserId: viewer,
    _viewerIsAdmin: !!opts.admin,
    _isAdminModeOn: () => !!opts.adminMode,
    SELF_INSTANCE_NAME: '',
    READ_ONLY_MSG: 'ro',
    OWNER_ONLY_MSG: 'owner-only',
  });
}
const mine = (over: Record<string, unknown> = {}) => ({
  key: 'C1:t1',
  ownerId: 'U1',
  sessionState: 'MAIN',
  activityState: 'idle',
  ...over,
});
const locks = (p: Page, s: unknown, col = 'idle') =>
  Object.fromEntries(p.sessionActionsOf(s, col).map((a) => [a.id, a.lock]));

describe('T1 — my task is mine in every view', () => {
  it('All Users board (filter empty): my card offers star, close and the composer, unlocked', () => {
    const p = page('U1', '');
    expect(locks(p, mine())).toEqual({ star: '', close: '' });
    expect(locks(p, mine(), 'working')).toEqual({ star: '', stop: '' });
    expect(p.pcModeOf(mine())).toBe('open');
    expect(p.cwCanCompact(mine({ contextWindow: 1 }))).toBe('');
    expect(p.acQuestionLock(mine())).toBe('');
  });

  it('All Users board: my permission prompt is mine to answer', () => {
    const p = page('U1', '');
    expect(p.isPermissionRequester({ requesterId: 'U1' })).toBe(true);
    expect(p.isPermissionRequester({ requesterId: 'U2' })).toBe(false);
  });

  it("another user's board is not mine: their card's close is locked (the board filter is not the viewer)", () => {
    const p = page('U1', 'U2');
    const theirs = mine({ ownerId: 'U2' });
    expect(p.viewerOwns(theirs)).toBe(false);
    expect(locks(p, theirs).close).not.toBe('');
    expect(p.isPermissionRequester({ requesterId: 'U2' })).toBe(false);
  });

  it('a card with no owner is nobody’s (fail closed)', () => {
    const p = page('U1', '');
    expect(p.viewerOwns(mine({ ownerId: undefined }))).toBe(false);
    expect(page('', '').viewerOwns(mine())).toBe(false);
  });
});

describe('T2 — an admin in 관리자 모드 manages every task', () => {
  const theirs = mine({ ownerId: 'U2' });

  it('admin mode on: stop, close, trash, star and 살리기 unlock on someone else’s task', () => {
    const p = page('UA', '', { admin: true, adminMode: true });
    expect(p.viewerCanManage(theirs)).toBe(true);
    expect(locks(p, theirs)).toEqual({ star: '', close: '' });
    expect(locks(p, theirs, 'working')).toEqual({ star: '', stop: '' });
    expect(locks(p, { ...theirs, terminated: true, sessionState: 'TERMINATED' }, 'closed')).toEqual({
      star: '',
      revive: '',
      trash: '',
    });
    expect(p.cwCanCompact({ ...theirs, contextWindow: 1 })).toBe('');
  });

  it('admin mode off: the admin is a user like any other — no closing someone else’s task', () => {
    const p = page('UA', '', { admin: true, adminMode: false });
    expect(p.viewerCanManage(theirs)).toBe(false);
    expect(locks(p, theirs).close).toBe('owner-only');
  });

  it('a non-admin with a stale admin-mode flag manages nothing', () => {
    const p = page('U3', '', { admin: false, adminMode: true });
    expect(p.viewerCanManage(theirs)).toBe(false);
  });
});

describe('T3 — every signed-in user instructs every task; only the owner or 관리자 모드 closes it', () => {
  const theirs = mine({ ownerId: 'U2' });

  it("someone else's task: the composer is open and a question can be answered", () => {
    const p = page('U3', '');
    expect(p.viewerCanInstruct(theirs)).toBe(true);
    expect(p.pcModeOf(theirs)).toBe('open');
    expect(p.acQuestionLock(theirs)).toBe('');
    // A closed task keeps its closed composer.
    expect(p.pcModeOf({ ...theirs, terminated: true })).toBe('closed');
  });

  it("someone else's task: stop, close, trash, star and compact stay locked, with the reason", () => {
    const p = page('U3', '');
    expect(locks(p, theirs)).toEqual({ star: 'owner-only', close: 'owner-only' });
    expect(locks(p, theirs, 'working')).toEqual({ star: 'owner-only', stop: 'owner-only' });
    expect(locks(p, { ...theirs, terminated: true, sessionState: 'TERMINATED' }, 'closed').trash).toBe('owner-only');
    expect(p.cwCanCompact({ ...theirs, contextWindow: 1 })).toBe('owner-only');
  });

  it('a dashboard task too: anyone signed in instructs it', () => {
    const p = page('U3', '');
    expect(p.pcModeOf({ ...theirs, slackless: true })).toBe('open');
  });

  it('someone else’s DM with the bot: only its owner or an admin in admin mode instructs it (as in Slack)', () => {
    const dm = mine({ ownerId: 'U2', channelId: 'D0DM' });
    expect(page('U3', '').pcModeOf(dm)).toBe('readonly');
    expect(page('U2', '').pcModeOf(dm)).toBe('open');
    expect(page('UA', '', { admin: true, adminMode: true }).pcModeOf(dm)).toBe('open');
    expect(page('U3', '').pcModeOf(mine({ ownerId: 'U2', channelId: 'C0CHAN' }))).toBe('open');
  });

  it('nobody signed in (a viewer token): a Slack session takes instructions only in admin mode, a task never', () => {
    expect(page('', '').pcModeOf(theirs)).toBe('readonly');
    const token = page('', '', { admin: true, adminMode: true });
    expect(token.pcModeOf(theirs)).toBe('open');
    expect(token.pcModeOf({ ...theirs, slackless: true })).toBe('readonly');
  });
});

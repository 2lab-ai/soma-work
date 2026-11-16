// @vitest-environment happy-dom
/**
 * .prd/28 §3 (owner 2026-11-16) — the tab bar's two ends in a DOM: the page's own region markup, filled by the page's
 * own renderPanelUserActions, under the page's own CSS (THE TAB BAR's hide rule) — what is displayed while the bar's
 * tabs are closed, while 작업 계획 or 사용자 작업 is open, and while another tab is; and the 사용자 작업 tab following
 * the session live (the page's repaintPanelSession → renderPanelMidbar · renderPanelUserActions).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HTMLElement, Window } from 'happy-dom';
import { inspectUserActionScript } from 'somalib/user-action/user-action';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const cook = (fragment: string): string => new Function(`return \`${fragment}\`;`)() as string;
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function clientVar(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} =`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf(';\n', start) + 2));
}
// THE TAB BAR's hide rule, as shipped: from its first selector to its declaration.
const RULE_START = DASHBOARD_TS.indexOf('.slide-panel:not([data-midtab="plan"]) #panel-plan,');
const RULE = DASHBOARD_TS.slice(RULE_START, DASHBOARD_TS.indexOf('}', RULE_START) + 1);
const markup = (id: string) =>
  DASHBOARD_TS.split('\n')
    .find((l) => l.includes(`id="${id}"`) && l.includes('<div'))!
    .trim();

const g = globalThis as unknown as Window;
const byId = (id: string) => g.document.getElementById(id) as HTMLElement;
const shows = (el: HTMLElement) => g.getComputedStyle(el).display !== 'none';

const UA_VARS = ['UA_STATUS_LABEL', 'UA_VERDICT_LABEL', 'UA_VERDICT_ICON', 'UA_LEVEL_ICON'];
const UA_FNS = [
  'esc',
  'escAttr',
  'userActionCheckHtml',
  'userActionItemHtml',
  'panelUserActionsHtml',
  'renderPanelUserActions',
];
const render = new Function(
  'document',
  `${UA_VARS.map(clientVar).join('\n')}
  ${UA_FNS.map(clientFn).join('\n')}
  function writePanelPart(el, html) { el.innerHTML = html; }
  return renderPanelUserActions;`,
)(g.document) as (s: unknown) => void;

const script = "open 'https://example.com/verify'";
const userAction = (id: string, status: string) => ({
  id,
  title: '인증 페이지 열기',
  host: 'owner-mac',
  script,
  shell: 'bash',
  effects: '페이지를 연다.',
  status,
  inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
});

describe('the bar’s ends in a DOM: 작업 계획 and 사용자 작업 show only while their tab is open', () => {
  it('closed → neither displayed; each tab shows its own; another tab → neither', () => {
    expect(RULE).toContain('.slide-panel:not([data-midtab="useractions"]) #panel-user-actions,');
    expect(RULE.trim().endsWith('{ display: none !important; }')).toBe(true);
    const ua = markup('panel-user-actions');
    const plan = markup('panel-plan');
    expect(ua).toContain(' hidden></div>');
    g.document.head.innerHTML = `<style>${RULE}</style>`;
    g.document.body.innerHTML = `<div class="slide-panel" id="slide-panel" data-midtab="">${plan}${ua}</div>`;
    const panel = byId('slide-panel');
    const region = byId('panel-user-actions');
    const planBox = byId('panel-plan');
    render({ userActions: [userAction('ua_1', 'pending')] });
    // The page's render shows the region (its hidden attribute goes) and fills it; the plan box is shown by its own render.
    expect(region.hidden).toBe(false);
    expect(region.innerHTML).toContain('인증 페이지 열기');
    planBox.hidden = false;
    expect([shows(planBox), shows(region)]).toEqual([false, false]);
    panel.setAttribute('data-midtab', 'useractions');
    expect([shows(planBox), shows(region)]).toEqual([false, true]);
    panel.setAttribute('data-midtab', 'plan');
    expect([shows(planBox), shows(region)]).toEqual([true, false]);
    panel.setAttribute('data-midtab', 'goal');
    expect([shows(planBox), shows(region)]).toEqual([false, false]);
    // No user task: the render hides the region whatever the tab.
    panel.setAttribute('data-midtab', 'useractions');
    render({});
    expect(region.hidden).toBe(true);
  });
});

// Review P2 (#1311): the tab's content is reachable only through the tab, so the tab must follow the session live —
// a session's push (sessionUpdated: the cache entry replaced, then repaintPanelSession) enables it on the first task,
// badges the waiting one, and clears the badge when it is done.
describe('사용자 작업 follows the session live (the page’s repaintPanelSession → the bar and the region)', () => {
  const PANEL_STUBS = [
    'renderPanelHead',
    'renderPanelTitleActions',
    'renderPanelOwner',
    'renderPanelInfo',
    'renderPanelGoal',
    'renderPanelControls',
    'renderPanelComposer',
    'renderPanelPlan',
    'renderPanelNext',
    'renderPanelFamily',
    'repaintPanelScope',
    'convPaint',
    'restorePanelLiveAnchor',
    'rdReset',
    'sizePanelSections',
  ];
  const panel = new Function(
    'document',
    '_sessionCache',
    `${[...UA_VARS, 'MID_TAB_LABEL', 'MID_TAB_PANEL', 'TASK_PLAN_STATE_LABEL', 'TASK_PLAN_TONE'].map(clientVar).join('\n')}
    var _panelMid = '';
    var panelSessionKey = 'k1';
    ${[
      ...UA_FNS,
      'toNum',
      'userActionsWaiting',
      'panelBarTabIds',
      'panelMidTabsOf',
      'panelMidTabHtml',
      'renderPanelMidbar',
      'selectPanelMid',
      'repaintPanelSession',
    ]
      .map(clientFn)
      .join('\n')}
    ${PANEL_STUBS.map((n) => `function ${n}() {}`).join('\n')}
    function panelLiveAnchor() { return null; }
    function panelMidContext() { return {}; }
    function viewSpec() { return { detail: { tabs: ['goal', 'info'] } }; }
    function writePanelPart(el, html) { el.innerHTML = html; }
    return { repaintPanelSession: repaintPanelSession };`,
  );

  it('a session without user tasks → the first instruct_user → the tab opens it with a badge → done → the badge clears', () => {
    g.document.head.innerHTML = `<style>${RULE}</style>`;
    g.document.body.innerHTML = `<div class="slide-panel" id="slide-panel" data-midtab="">${markup('panel-midbar')}${markup('panel-user-actions')}</div>`;
    const cache: Record<string, unknown> = { k1: { key: 'k1' } };
    const m = panel(g.document, cache) as { repaintPanelSession(): void };
    // What the page does with a session's push for the open card (the WebSocket's sessionUpdated).
    const push = (session: Record<string, unknown>) => {
      cache.k1 = session;
      m.repaintPanelSession();
    };
    const tab = () => byId('panel-midbar').querySelector('.pm-tab[data-mid="useractions"]') as HTMLElement;
    const region = byId('panel-user-actions');
    const badge = () => tab().querySelector('.pm-wait');
    push({ key: 'k1' });
    expect(tab().hasAttribute('disabled')).toBe(true);
    expect(badge()).toBeNull();
    expect(region.hidden).toBe(true);
    // A press on the disabled tab opens nothing.
    tab().dispatchEvent(new g.MouseEvent('click', { bubbles: true }));
    expect(byId('slide-panel').getAttribute('data-midtab')).toBe('');
    // The model asks the user for a task: the tab is enabled with its waiting badge, and a press shows the task.
    push({ key: 'k1', userActions: [userAction('ua_1', 'pending')] });
    expect(tab().hasAttribute('disabled')).toBe(false);
    expect(badge()?.textContent).toBe('1');
    expect(badge()?.getAttribute('aria-label')).toBe('사용자 할 일 대기 1');
    expect(shows(region)).toBe(false);
    tab().dispatchEvent(new g.MouseEvent('click', { bubbles: true }));
    expect(byId('slide-panel').getAttribute('data-midtab')).toBe('useractions');
    expect(tab().getAttribute('aria-expanded')).toBe('true');
    expect(shows(region)).toBe(true);
    expect(region.innerHTML).toContain('인증 페이지 열기');
    // The user reports it done: the badge clears, the tab stays open on the finished task.
    push({ key: 'k1', userActions: [userAction('ua_1', 'done')] });
    expect(badge()).toBeNull();
    expect(tab().textContent).toContain('사용자 작업');
    expect(tab().getAttribute('aria-expanded')).toBe('true');
    expect(shows(region)).toBe(true);
    expect(region.innerHTML).toContain('완료');
  });
});

// .prd/29 §6 — the open 변경점 tab follows the session's issue tree on every push (repaintPanelSession).
describe('a push repaints the 변경점 tab’s issue tree while that tab is open', () => {
  it('chgNoteTree runs on the changes tab, not on another', () => {
    const stubs = [
      'renderPanelHead',
      'renderPanelTitleActions',
      'renderPanelOwner',
      'renderPanelMidbar',
      'renderPanelInfo',
      'renderPanelGoal',
      'renderPanelControls',
      'renderPanelComposer',
      'renderPanelPlan',
      'renderPanelUserActions',
      'renderPanelNext',
      'renderPanelFamily',
      'repaintPanelScope',
      'convPaint',
      'restorePanelLiveAnchor',
    ];
    const run = new Function(
      'section',
      `var panelSessionKey = 'k1'; var _sessionCache = { k1: {} }; var _psec = section; var noted = 0;
      ${clientFn('repaintPanelSession')}
      ${stubs.map((n) => `function ${n}() {}`).join('\n')}
      function panelLiveAnchor() { return null; }
      function chgNoteTree() { noted++; }
      repaintPanelSession();
      return noted;`,
    ) as (section: string) => number;
    expect(run('changes')).toBe(1);
    expect(run('conv')).toBe(0);
  });
});

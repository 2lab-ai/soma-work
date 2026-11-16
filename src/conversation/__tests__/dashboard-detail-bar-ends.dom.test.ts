// @vitest-environment happy-dom
/**
 * .prd/28 §3 (owner 2026-11-16) — the tab bar's two ends in a DOM: the page's own region markup, filled by the page's
 * own renderPanelUserActions, under the page's own CSS (THE TAB BAR's hide rule) — what is displayed while the bar's
 * tabs are closed, while 작업 계획 or 사용자 작업 is open, and while another tab is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

interface Node {
  hidden: boolean;
  innerHTML: string;
  setAttribute(k: string, v: string): void;
}
const g = globalThis as unknown as {
  document: { body: Node; head: Node; getElementById(id: string): Node | null };
  getComputedStyle(el: Node): { display: string };
};

const render = new Function(
  'document',
  `${['UA_STATUS_LABEL', 'UA_VERDICT_LABEL', 'UA_VERDICT_ICON', 'UA_LEVEL_ICON'].map(clientVar).join('\n')}
  ${['esc', 'escAttr', 'userActionCheckHtml', 'userActionItemHtml', 'panelUserActionsHtml', 'renderPanelUserActions']
    .map(clientFn)
    .join('\n')}
  function writePanelPart(el, html) { el.innerHTML = html; }
  return renderPanelUserActions;`,
)(g.document) as (s: unknown) => void;

describe('the bar’s ends in a DOM: 작업 계획 and 사용자 작업 show only while their tab is open', () => {
  it('closed → neither displayed; each tab shows its own; another tab → neither', () => {
    expect(RULE).toContain('.slide-panel:not([data-midtab="useractions"]) #panel-user-actions,');
    expect(RULE.trim().endsWith('{ display: none !important; }')).toBe(true);
    const ua = markup('panel-user-actions');
    const plan = markup('panel-plan');
    expect(ua).toContain(' hidden></div>');
    g.document.head.innerHTML = `<style>${RULE}</style>`;
    g.document.body.innerHTML = `<div class="slide-panel" id="slide-panel" data-midtab="">${plan}${ua}</div>`;
    const panel = g.document.getElementById('slide-panel')!;
    const region = g.document.getElementById('panel-user-actions')!;
    const planBox = g.document.getElementById('panel-plan')!;
    const script = "open 'https://example.com/verify'";
    render({
      userActions: [
        {
          id: 'ua_1',
          title: '인증 페이지 열기',
          host: 'owner-mac',
          script,
          shell: 'bash',
          effects: '페이지를 연다.',
          status: 'pending',
          inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
        },
      ],
    });
    // The page's render shows the region (its hidden attribute goes) and fills it; the plan box is shown by its own render.
    expect(region.hidden).toBe(false);
    expect(region.innerHTML).toContain('인증 페이지 열기');
    planBox.hidden = false;
    const shows = (el: Node) => g.getComputedStyle(el).display !== 'none';
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

// @vitest-environment happy-dom
/**
 * .prd/28 §3 (review P2 on #1311) — 사용자 할 일 in the 목표 tab, in a DOM: the page's own region markup, filled by the
 * page's own renderPanelUserActions, under the page's own CSS rule — its computed display while the tab is closed,
 * open, replaced by another tab, and in a layout without the 목표 tab.
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
const RULE = DASHBOARD_TS.split('\n').find((l) => l.includes('#panel-user-actions { display: none !important; }'))!;
const REGION = DASHBOARD_TS.split('\n')
  .find((l) => l.includes('id="panel-user-actions"') && l.includes('<div'))!
  .trim();

interface Node {
  hidden: boolean;
  innerHTML: string;
  setAttribute(k: string, v: string): void;
  querySelector(sel: string): Node | null;
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

describe('사용자 할 일 follows the 목표 tab (page markup + renderPanelUserActions + the page’s CSS, in a DOM)', () => {
  it('closed → not displayed; 목표 open → displayed; another tab → not; no 목표 tab in the layout → displayed', () => {
    expect(REGION).toContain(' hidden></div>');
    g.document.head.innerHTML = `<style>${RULE}</style>`;
    g.document.body.innerHTML = `<div class="slide-panel" id="slide-panel" data-midtab="">${REGION}</div>`;
    const panel = g.document.getElementById('slide-panel')!;
    const region = g.document.getElementById('panel-user-actions')!;
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
    // The page's render shows the region (its hidden attribute goes) and fills it.
    expect(region.hidden).toBe(false);
    expect(region.innerHTML).toContain('인증 페이지 열기');
    const shown = () => g.getComputedStyle(region).display;
    g.document.body.setAttribute('data-detail', 'agenttabs goaltab sections');
    expect(shown()).toBe('none');
    panel.setAttribute('data-midtab', 'goal');
    expect(shown()).not.toBe('none');
    panel.setAttribute('data-midtab', 'tasks');
    expect(shown()).toBe('none');
    panel.setAttribute('data-midtab', '');
    g.document.body.setAttribute('data-detail', 'agenttabs sections');
    expect(shown()).not.toBe('none');
    // No user task: the render hides the region whatever the tab.
    render({});
    expect(region.hidden).toBe(true);
  });
});

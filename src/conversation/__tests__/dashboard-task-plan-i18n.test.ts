/**
 * Plan mode in the display language (#771–#773): an en user's dashboard is the
 * page run through the English page catalog (`translatePage`). Every Korean
 * string of the plan-mode client and markup — the 작업 계획 switch, the card,
 * the detail card's plan and bars, the quick-answer buttons — has its English, so
 * a new Korean string without one fails here, not on an English user's screen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageText, registerPageCatalog, scanPage } from '@soma/common/i18n-page';
import { describe, expect, it } from 'vitest';

const CATALOG = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog');
registerPageCatalog(JSON.parse(readFileSync(join(CATALOG, 'en-page.json'), 'utf8')));

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const cook = (fragment: string): string => new Function(`return \`${fragment}\`;`)() as string;

/** The plan-mode client functions (U1–U8 of dashboard-task-plan-client.test.ts) and the state labels. */
const PLAN_CLIENT = [
  'taskPlanCardHtml',
  'planButtonsHtml',
  'planHeadActions',
  'planBarHtml',
  'panelPlanHtml',
  'renderPanelPlan',
  'loadPanelPlan',
  'doPlanDecision',
  'planDirectInput',
  'planShownLag',
  'planLock',
  'quickChoicesOf',
  'quickChoiceHtml',
  'cardQuickAnswer',
  'autoOpenDecisions',
];
function clientFn(name: string): string {
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function clientVar(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} =`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf(';\n', start) + 2));
}
/** The plan-mode markup of the page body: the composer switch and the detail card's two plan regions. */
function element(id: string): string {
  const at = TEMPLATE.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`#${id} not found`);
  const start = TEMPLATE.lastIndexOf('<', at);
  const tag = /^<([a-z][\w-]*)/.exec(TEMPLATE.slice(start))![1];
  return cook(TEMPLATE.slice(start, TEMPLATE.indexOf(`</${tag}>`, at) + tag.length + 3));
}

const untranslated = (html: string) =>
  scanPage(html)
    .filter((seg) => !seg.skip && pageText(seg.key) === undefined)
    .map((seg) => seg.key);

describe('plan mode — every Korean string has its English (#773)', () => {
  it('the plan-mode client: the card, the detail card, the bars, the toasts, the quick answers', () => {
    const script = `<script>\n${clientVar('TASK_PLAN_STATE_LABEL')}\n${PLAN_CLIENT.map(clientFn).join('\n')}\n</script>`;
    expect(scanPage(script).filter((seg) => !seg.skip).length).toBeGreaterThan(30);
    expect(untranslated(script)).toEqual([]);
  });

  it('the markup: the 작업 계획 switch and the detail card plan regions', () => {
    const markup = ['nt-plan-wrap', 'panel-plan', 'panel-plan-bar'].map(element).join('\n');
    expect(markup).toContain('작업 계획');
    expect(untranslated(markup)).toEqual([]);
  });

  it('the face asks in English: Task plan vN — start it?', () => {
    expect(pageText('작업 계획 v')).toBe('Task plan v');
    expect(pageText(' — 시작할까요?')).toBe(' — start it?');
    expect(pageText('▶ 시작')).toBe('▶ Start');
  });
});

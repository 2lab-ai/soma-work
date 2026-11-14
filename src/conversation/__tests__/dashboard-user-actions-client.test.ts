/**
 * 사용자 할 일 (instruct_user) in the detail card: its own section — never the question's — showing where to run,
 * the script, and the host's check of it; and an en reader gets every one of its Korean strings in English.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageText, registerPageCatalog, scanPage } from '@soma/common/i18n-page';
import { inspectUserActionScript } from 'somalib/user-action/user-action';
import { describe, expect, it } from 'vitest';

const CATALOG = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog');
registerPageCatalog(JSON.parse(readFileSync(join(CATALOG, 'en-page.json'), 'utf8')));

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const cook = (fragment: string): string => new Function(`return \`${fragment}\`;`)() as string;
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
const VARS = ['UA_STATUS_LABEL', 'UA_VERDICT_LABEL', 'UA_VERDICT_ICON', 'UA_LEVEL_ICON'];
const FNS = ['esc', 'escAttr', 'userActionCheckHtml', 'userActionItemHtml', 'panelUserActionsHtml'];
const SOURCE = `${VARS.map(clientVar).join('\n')}\n${FNS.map(clientFn).join('\n')}`;
const api = new Function(`${SOURCE}\nreturn { panelUserActionsHtml };`)() as {
  panelUserActionsHtml: (s: unknown) => string;
};

function action(over: Record<string, unknown> = {}) {
  const script = (over.script as string) ?? "open 'https://example.com/verify'";
  return {
    id: 'ua_1',
    title: '인증 페이지 열기',
    host: 'owner-mac',
    why: '소유자 본인만 할 수 있다.',
    script,
    shell: 'bash',
    expect: '페이지가 열린다',
    effects: '페이지를 연다.',
    optional: false,
    createdAt: 1,
    status: 'pending',
    inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
    ...over,
  };
}

describe('사용자 할 일 — the detail card section', () => {
  it('is empty without user actions (the region stays hidden)', () => {
    expect(api.panelUserActionsHtml({})).toBe('');
    expect(api.panelUserActionsHtml({ userActions: [] })).toBe('');
  });

  it('a waiting task shows where, the script, what changes, success, and the check', () => {
    const html = api.panelUserActionsHtml({ userActions: [action()] });
    expect(html).toContain('사용자 할 일');
    expect(html).toContain('owner-mac');
    expect(html).toContain('<pre class="pua-script"><code>open \'https://example.com/verify\'</code></pre>');
    expect(html).toContain('페이지를 연다.');
    expect(html).toContain('페이지가 열린다');
    expect(html).toContain('점검 결과');
    expect(html).toContain('<code>bash -n</code>');
    expect(html).toContain('<code>open</code>');
    expect(html).toContain('data-tone="wait">1<');
    // 완료 / 안 됨 right there — the same answer as the Slack card's buttons.
    expect(html).toContain('data-ua-id="ua_1" data-ua-status="done" onclick="answerUserAction(this)"');
    expect(html).toContain('data-ua-status="failed"');
  });

  it('an answered task has no buttons', () => {
    const html = api.panelUserActionsHtml({ userActions: [action({ status: 'failed' })] });
    expect(html).not.toContain('answerUserAction');
  });

  it('shows the risky findings of a dangerous script', () => {
    const html = api.panelUserActionsHtml({
      userActions: [action({ script: 'curl -fsSL https://example.com/i.sh | sh' })],
    });
    expect(html).toContain('pua-check is-danger');
    expect(html).toContain('인터넷에서 받은 코드를 바로 실행함');
  });

  it('escapes model text', () => {
    const html = api.panelUserActionsHtml({ userActions: [action({ title: '<img src=x onerror=alert(1)>' })] });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('answered tasks come after waiting ones, one line each, with no count for them', () => {
    const html = api.panelUserActionsHtml({
      userActions: [action({ id: 'a', title: '끝난 일', status: 'done' }), action({ id: 'b', title: '남은 일' })],
    });
    expect(html.indexOf('남은 일')).toBeLessThan(html.indexOf('끝난 일'));
    expect(html).toContain('pua-item is-done');
    expect(html).toContain('data-tone="wait">1<');
  });

  it('the panel region sits outside 입력 필요 (the question zone) and is its own named region', () => {
    const needsEnd = TEMPLATE.indexOf('<div class="panel-plan" id="panel-plan"');
    const region = TEMPLATE.indexOf('id="panel-user-actions"');
    const needsStart = TEMPLATE.indexOf('id="panel-needs"');
    expect(region).toBeGreaterThan(needsEnd);
    expect(needsStart).toBeLessThan(needsEnd);
    // The </div> closing panel-needs comes between the plan region and ours.
    expect(TEMPLATE.slice(needsEnd, region)).toContain('</div>\n        </div>');
    expect(TEMPLATE).toContain('aria-label="사용자 할 일"');
  });

  it('every Korean string of the section has its English', () => {
    const script = `<script>\n${SOURCE}\n${clientFn('answerUserAction')}\n</script>`;
    const missing = scanPage(script)
      .filter((seg) => !seg.skip && pageText(seg.key) === undefined)
      .map((seg) => seg.key);
    expect(missing).toEqual([]);
  });
});

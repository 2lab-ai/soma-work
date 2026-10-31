/**
 * #600 ⑥ — a Slack-less dashboard task on its card and in its panel (shipped
 * client functions, cut out of renderDashboardPage()'s template and cooked as
 * the browser receives them):
 *   - the card says how the task's last turn ended, why, and when recording it
 *     failed (the server has sent `lastTurnOutcome` since ④c; nothing drew it);
 *   - the composer offers only what a task takes: no attachments (D8), no
 *     "compact now" (a task turn refuses commands).
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
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} =`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const end = TEMPLATE.indexOf(';\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}

type Fns = {
  taskOutcomeHtml(s: unknown): string;
  taskNoticeFailHtml(s: unknown): string;
  cwCanCompact(s: unknown): string;
  pcToolsOpen(s: unknown, mode: string): boolean;
};
const fns = new Function(
  'currentUserId',
  'isSiblingSession',
  'READ_ONLY_MSG',
  `${clientVar('TASK_OUTCOME_LABEL')}\n${clientVar('TASK_NOTICE_LABEL')}\n${[
    'esc',
    'escAttr',
    'taskOutcomeHtml',
    'taskNoticeFailHtml',
    'cwCanCompact',
    'pcToolsOpen',
  ]
    .map(clientFn)
    .join('\n')}\nreturn { taskOutcomeHtml, taskNoticeFailHtml, cwCanCompact, pcToolsOpen };`,
)('U1', () => false, 'read only') as Fns;

const task = (over: Record<string, unknown> = {}) => ({ key: 'task:a', slackless: true, ownerId: 'U1', ...over });

describe('a task card’s last turn (#600 ⑥)', () => {
  it('says how it ended and why', () => {
    const html = fns.taskOutcomeHtml(
      task({ lastTurnOutcome: { outcome: 'cancelled', category: 'Cancel', reason: 'stopped by user', at: 1 } }),
    );
    expect(html).toContain('data-outcome="cancelled"');
    expect(html).toContain('중지됨');
    expect(html).toContain('stopped by user');
    expect(html).not.toContain('cto-warn');
  });

  it('a recording failure is shown as a warning; model text is escaped', () => {
    const html = fns.taskOutcomeHtml(
      task({
        lastTurnOutcome: {
          outcome: 'interrupted',
          category: 'Exception',
          reason: '<img src=x onerror=alert(1)>',
          recordFailure: 'outcome not saved: ENOSPC',
          at: 1,
        },
      }),
    );
    expect(html).toContain('중단됨');
    expect(html).toContain('role="alert"');
    expect(html).toContain('outcome not saved: ENOSPC');
    expect(html).not.toContain('<img');
  });

  it('nothing for a Slack session or a task that has not run', () => {
    expect(fns.taskOutcomeHtml({ key: 'work:C1:1', lastTurnOutcome: { outcome: 'completed', at: 1 } })).toBe('');
    expect(fns.taskOutcomeHtml(task())).toBe('');
  });
});

describe('a task card’s undelivered thread notices (E2 ⑤)', () => {
  it('says which notice the Slack thread did not get, and why — escaped', () => {
    const html = fns.taskNoticeFailHtml(task({ noticeFailures: [{ kind: 'result', error: 'channel_not_found <b>' }] }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('결과');
    expect(html).toContain('channel_not_found &lt;b&gt;');
  });

  it('nothing when every notice got through, or for a Slack session', () => {
    expect(fns.taskNoticeFailHtml(task())).toBe('');
    expect(fns.taskNoticeFailHtml(task({ noticeFailures: [] }))).toBe('');
    expect(fns.taskNoticeFailHtml({ key: 'work:C1:1', noticeFailures: [{ kind: 'result', error: 'x' }] })).toBe('');
  });
});

describe('a task’s composer offers only what a task takes (#600 ⑥)', () => {
  it('no "compact now" on a task (a task turn refuses commands); a Slack session is unchanged', () => {
    expect(fns.cwCanCompact(task())).toMatch(/대시보드 작업/);
    expect(fns.cwCanCompact({ key: 'work:C1:1', ownerId: 'U1' })).toBe('');
  });

  it('no attach / image / mic on a task (D8); an open Slack session keeps them', () => {
    expect(fns.pcToolsOpen(task(), 'open')).toBe(false);
    expect(fns.pcToolsOpen({ key: 'work:C1:1' }, 'open')).toBe(true);
    expect(fns.pcToolsOpen({ key: 'work:C1:1' }, 'readonly')).toBe(false);
  });
});

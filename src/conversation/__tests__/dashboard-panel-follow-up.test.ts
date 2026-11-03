import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #846 item 3 — the session panel's 입력 필요 lists the follow-up the last Executive Summary left.
 *
 * The card moves to NEEDS YOU with "후속 작업 필요: …", but the panel's head count and list ignored
 * `pendingFollowUp`, so a user who opened the card saw nothing to do. The follow-up is now one read-only row
 * (the reason, and where the steps are) and one in the count. A sleeping or closed session shows none: the server
 * keeps sending `pendingFollowUp` for it, and its board column is closed.
 */

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const FOLLOW_UP = { reason: 'PR #12 not merged — <needs> a maintainer approval', at: 1_790_000_000_000 };
const awake = (extra: Record<string, unknown> = {}) => ({
  key: 'k',
  activityState: 'waiting',
  sessionState: 'MAIN',
  pendingFollowUp: FOLLOW_UP,
  ...extra,
});

type Row = { panelFollowUpShown(s: unknown): boolean; acFollowUpHtml(s: unknown): string };
const row = () => load<Row>(['esc', 'panelFollowUpShown', 'acFollowUpHtml']);

describe('panel — the follow-up row', () => {
  it('shows the reason (escaped) and where the steps are', () => {
    const html = row().acFollowUpHtml(awake());
    expect(html).toContain('data-pf="followup"');
    expect(html).toContain('후속 작업 필요');
    expect(html).toContain('PR #12 not merged — &lt;needs&gt; a maintainer approval');
    expect(html).toContain('처리 방법은 Executive Summary 맨 아래 ⚠️ 섹션에 있어요');
    expect(html).not.toContain('<ui-approval-card');
  });

  it.each([
    ['a sleeping session', awake({ sessionState: 'SLEEPING' })],
    ['a closed session', awake({ terminated: true })],
    ['no follow-up', awake({ pendingFollowUp: undefined })],
    ['a blank reason', awake({ pendingFollowUp: { reason: '  ', at: 1 } })],
    ['no session', null],
  ])('none for %s', (_label, s) => {
    expect(row().panelFollowUpShown(s)).toBe(false);
    expect(row().acFollowUpHtml(s)).toBe('');
  });
});

type El = { hidden?: boolean; textContent?: string };
describe('panel — the 입력 필요 head counts it', () => {
  it('one for the follow-up, next to the prompts; none hides the head', () => {
    const els: Record<string, El> = { 'panel-needs-head': { hidden: true }, 'panel-needs-count': { textContent: '' } };
    const m = load<{ renderPanelNeedsHead(s: unknown): void }>(
      ['panelQuestionShown', 'panelFollowUpShown', 'renderPanelNeedsHead'],
      { document: { getElementById: (id: string) => els[id] ?? null } },
    );
    m.renderPanelNeedsHead(awake({ pendingPermissions: [{ approvalId: 'a' }] }));
    expect(els['panel-needs-head'].hidden).toBe(false);
    expect(els['panel-needs-count'].textContent).toBe('2');
    m.renderPanelNeedsHead(awake({ sessionState: 'SLEEPING' }));
    expect(els['panel-needs-head'].hidden).toBe(true);
  });

  it('the list renders it after the prompts and announces a new one', () => {
    const fn = clientFn('renderPanelPermission');
    expect(fn).toContain('acInstructionApprovalsHtml(s) + acFollowUpHtml(s)');
    expect(fn).toMatch(/ids\['f\|' \+ /);
    expect(fn).toContain("said.push('후속 작업 필요 — ' + ");
  });
});

describe('panel — English page', () => {
  it('translates the new strings', () => {
    const en = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'),
        'utf-8',
      ),
    );
    expect(en['후속 작업 필요']).toBe('Follow-up needed');
    expect(en['후속 작업 필요 — ']).toBe('Follow-up needed — ');
    expect(en['처리 방법은 Executive Summary 맨 아래 ⚠️ 섹션에 있어요']).toBe(
      'The steps are in the ⚠️ section at the end of the Executive Summary',
    );
  });
});

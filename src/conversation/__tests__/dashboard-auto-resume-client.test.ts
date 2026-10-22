/**
 * Client half of the "waiting out an automatic resume" card (dev fleet,
 * 2026-10-22). Executes the shipped card code — each function cut out of
 * renderDashboardPage()'s template literal and cooked exactly as the browser
 * receives it (same harness as dashboard-agent-inbox-client.test.ts).
 *
 * A RUNNING card whose session is idle because a retry timer or a goal
 * re-check will start it again shows: when it resumes, which attempt, and the
 * error behind it — never the "Running" spinner, and never a Stop button for a
 * turn that is not running.
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
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

interface Card {
  pendingAutoResume(s: unknown, col: string): unknown;
  autoResumeLabel(r: unknown): string;
  renderCardStatus(s: unknown, col: string): string;
  cardSummary(s: unknown, col: string, headline: string): string;
  renderCardResume(s: unknown, col: string): string;
}

const card = load<Card>(
  [
    'esc',
    'escAttr',
    'formatTaskTime',
    'pendingAutoResume',
    'autoResumeLabel',
    'renderCardStatus',
    'cardSummary',
    'renderCardResume',
  ],
  ['WAIT_SVG', 'RESUME_SVG'],
  // The task row is hidden here, so the summary line names the running task.
  { dhShow: () => false },
);

const AT = Date.UTC(2026, 9, 22, 10, 24);
const RATE_LIMIT = 'Claude pool rate-limited (surfaced as turn content): All 10 eligible accounts are rate-limited';
const atText = new Date(AT).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

function resuming(autoResume: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    key: 'self::C1:t1',
    activityState: 'idle',
    activeAccumulatedMs: 3_485_924,
    tasks: [{ content: 'T2.1 지도 마무리', status: 'pending' }],
    autoResume,
    ...overrides,
  };
}

describe('a RUNNING card waiting out an automatic resume (shipped card renderers)', () => {
  it('a 429 turn retry: resume time, attempt n/3 and the error — no Running spinner', () => {
    const s = resuming({ kind: 'error-retry', at: AT, attempt: 1, maxAttempts: 3, reason: RATE_LIMIT });
    const html = card.renderCardStatus(s, 'working');

    expect(html).toContain('is-resume');
    expect(html).toContain(`${atText} 자동 재개 · 시도 1/3`);
    expect(html).toContain(`title="${RATE_LIMIT}"`);
    expect(html).not.toContain('spinner');
    expect(html).not.toContain('Running');

    expect(card.cardSummary(s, 'working', 'headline')).toBe(`오류: ${RATE_LIMIT}`);
    const row = card.renderCardResume(s, 'working');
    expect(row).toContain('class="card-resume"');
    expect(row).toContain(`${atText} 자동 재개 · 시도 1/3`);
    expect(row).toContain(RATE_LIMIT);
  });

  it('a goal completion check re-run after a dispatch failure', () => {
    const s = resuming({
      kind: 'goal-eval-retry',
      at: AT,
      attempt: 2,
      maxAttempts: 3,
      reason: 'one-shot dispatch aborted during pool rate-limit retry wait',
    });
    expect(card.renderCardStatus(s, 'working')).toContain(`${atText} Goal 판정 재시도 · 시도 2/3`);
  });

  it('a goal completion check running now has no clock and no error line', () => {
    const s = resuming({ kind: 'goal-eval' });
    expect(card.autoResumeLabel(s.autoResume)).toBe('Goal 완료 판정 중');
    expect(card.renderCardStatus(s, 'working')).toContain('Goal 완료 판정 중');
    expect(card.cardSummary(s, 'working', 'headline')).not.toContain('오류');
    expect(card.renderCardResume(s, 'working')).not.toContain('cr-reason');
  });

  it('a turn that is actually running wins over an armed retry: spinner, current task, no resume row', () => {
    const s = resuming(
      { kind: 'error-retry', at: AT, attempt: 1, maxAttempts: 3, reason: RATE_LIMIT },
      { activityState: 'working', tasks: [{ content: 'T1.5 변이 실행', status: 'in_progress' }] },
    );
    expect(card.pendingAutoResume(s, 'working')).toBeNull();
    expect(card.renderCardStatus(s, 'working')).toContain('spinner');
    expect(card.cardSummary(s, 'working', 'headline')).toBe('T1.5 변이 실행');
    expect(card.renderCardResume(s, 'working')).toBe('');
  });

  it('outside the RUNNING column an autoResume field changes nothing', () => {
    const s = resuming({ kind: 'error-retry', at: AT, attempt: 1, maxAttempts: 3, reason: RATE_LIMIT });
    expect(card.pendingAutoResume(s, 'idle')).toBeNull();
    expect(card.renderCardStatus(s, 'idle')).toContain('Done in');
  });

  it('a hostile error line is text, never markup', () => {
    const bad = '"><img src=x onerror=alert(1)>';
    const s = resuming({ kind: 'error-retry', at: AT, attempt: 1, maxAttempts: 3, reason: bad });
    for (const html of [card.renderCardStatus(s, 'working'), card.renderCardResume(s, 'working')]) {
      expect(html).not.toContain('<img');
      expect(html).not.toMatch(/="\s*onerror/);
    }
  });

  it('the open card offers Close, not Stop, while it waits (no turn to stop)', () => {
    const body = TEMPLATE.slice(TEMPLATE.indexOf('\nfunction renderCardBody('));
    expect(body).toContain("} else if (col === 'working' && !pendingAutoResume(s, col)) {");
    expect(body).toContain("} else if (col === 'waiting' || col === 'idle' || col === 'working') {");
    expect(body).toContain('+ renderCardResume(s, col)');
  });

  it('an open panel re-renders its tasks on every board push (a finished turn stops spinning)', () => {
    const ws = TEMPLATE.slice(TEMPLATE.indexOf('\nfunction connectWs('));
    expect(ws).toContain('renderPanelTasks(panelS.tasks);');
  });
});

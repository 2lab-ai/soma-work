/**
 * Client half of the "waiting out an automatic resume" card (dev fleet,
 * 2026-10-22). Executes the shipped card code — each function cut out of
 * renderDashboardPage()'s template literal and cooked exactly as the browser
 * receives it (same harness as dashboard-agent-inbox-client.test.ts).
 *
 * A RUNNING card whose session is idle because a retry timer or a goal
 * re-check will start it again shows: when it resumes, which attempt, and the
 * error behind it — never the running status, and never a Stop button for a
 * turn that is not running. The face is the board element's (@2lab.ai/ui
 * <ui-agent-inbox>); the page hands it the card data (cardOf).
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

// The face is now @2lab.ai/ui <ui-agent-inbox>'s: the page hands it the card
// data (cardOf) — status, statusText and summary as text, escaped by the
// element ('escapes every user and model string'). The open card's resume row
// (renderCardResume) is still the page's.
const CARD_OF_FNS = [
  'toNum',
  'formatTokens',
  'formatTaskTime',
  'permissionSummary',
  'cardSummary',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardCurrentTask',
  'cardTaskRow',
  'agentStatusOf',
  'agentCounts',
  'agentDotOf',
  'cardTotalTokens',
  'ctxLevel',
  'ctxPercent',
  'cardCtxTitle',
  'cardPrMetric',
  '_hashStr',
  'ownerBadgeHue',
  'isSiblingSession',
  'cardOf',
];
const CARD_OF_VARS = ['PR_STATE_LABEL', 'PR_STATE_TONE', 'AGENT_STATUS_LABEL', 'OWNER_BADGE_HUES'];

interface Card {
  pendingAutoResume(s: unknown, col: string): unknown;
  autoResumeLabel(r: unknown): string;
  cardSummary(s: unknown, col: string, headline: string): string;
  cardOf(s: unknown, col: string): Record<string, unknown>;
}

const card = load<Card>(CARD_OF_FNS, CARD_OF_VARS, {
  // The task row is hidden here, so the summary line names the running task.
  dhShow: () => false,
  dhTruncate: () => null,
  currentUserId: 'U1',
  _ownerIndex: null,
  SELF_INSTANCE_NAME: '',
});
const resumeRow = load<{ renderCardResume(s: unknown, col: string): string }>(
  ['esc', 'toNum', 'formatTaskTime', 'pendingAutoResume', 'autoResumeLabel', 'renderCardResume'],
  ['RESUME_SVG'],
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

describe('a RUNNING card waiting out an automatic resume (cardOf + the open card’s resume row)', () => {
  it('a 429 turn retry: the wait status, resume time, attempt n/3 and the error — no Running clock', () => {
    const s = resuming({ kind: 'error-retry', at: AT, attempt: 1, maxAttempts: 3, reason: RATE_LIMIT });
    const c = card.cardOf(s, 'working');

    expect(c.status).toBe('waiting');
    expect(c.statusText).toBe(`${atText} 자동 재개 · 시도 1/3`);
    expect(c.since).toBeUndefined();
    expect(c.elapsedMs).toBeUndefined();
    expect(c.summary).toBe(`오류: ${RATE_LIMIT}`);

    expect(card.cardSummary(s, 'working', 'headline')).toBe(`오류: ${RATE_LIMIT}`);
    const row = resumeRow.renderCardResume(s, 'working');
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
    expect(card.cardOf(s, 'working')).toMatchObject({
      status: 'waiting',
      statusText: `${atText} Goal 판정 재시도 · 시도 2/3`,
    });
  });

  it('a goal completion check running now has no clock and no error line', () => {
    const s = resuming({ kind: 'goal-eval' });
    expect(card.autoResumeLabel(s.autoResume)).toBe('Goal 완료 판정 중');
    expect(card.cardOf(s, 'working')).toMatchObject({ status: 'waiting', statusText: 'Goal 완료 판정 중' });
    expect(card.cardSummary(s, 'working', 'headline')).not.toContain('오류');
    expect(resumeRow.renderCardResume(s, 'working')).not.toContain('cr-reason');
  });

  it('a turn that is actually running wins over an armed retry: running, current task, no resume row', () => {
    const s = resuming(
      { kind: 'error-retry', at: AT, attempt: 1, maxAttempts: 3, reason: RATE_LIMIT },
      { activityState: 'working', tasks: [{ content: 'T1.5 변이 실행', status: 'in_progress' }] },
    );
    expect(card.pendingAutoResume(s, 'working')).toBeNull();
    const c = card.cardOf(s, 'working');
    expect(c.status).toBe('running');
    expect(c.statusText).toBeUndefined();
    expect(card.cardSummary(s, 'working', 'headline')).toBe('T1.5 변이 실행');
    expect(resumeRow.renderCardResume(s, 'working')).toBe('');
  });

  it('outside the RUNNING column an autoResume field changes nothing', () => {
    const s = resuming({ kind: 'error-retry', at: AT, attempt: 1, maxAttempts: 3, reason: RATE_LIMIT });
    expect(card.pendingAutoResume(s, 'idle')).toBeNull();
    // "Done in <active time>": the element words it from status done + elapsedMs.
    const c = card.cardOf(s, 'idle');
    expect(c).toMatchObject({ status: 'done', elapsedMs: 3_485_924 });
    expect(c.statusText).toBeUndefined();
  });

  it('a hostile error line is text, never markup', () => {
    const bad = '"><img src=x onerror=alert(1)>';
    const s = resuming({ kind: 'error-retry', at: AT, attempt: 1, maxAttempts: 3, reason: bad });
    // The face carries it as plain text; the element escapes it ('escapes every user and model string').
    expect(card.cardOf(s, 'working').summary).toBe(`오류: ${bad}`);
    const html = resumeRow.renderCardResume(s, 'working');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/="\s*onerror/);
  });

  it('the open card offers Close, not Stop, while it waits (no turn to stop); a running card keeps Stop', () => {
    const body = load<{ renderCardBody(s: unknown, col: string): string }>(
      [
        'esc',
        'escAttr',
        'escJs',
        'toNum',
        'formatTaskTime',
        'pendingAutoResume',
        'autoResumeLabel',
        // SSOT 2026-10-29 T4: the summary reads the running task through the face's own helper.
        'cardCurrentTask',
        'cardSummary',
        'renderCardResume',
        'isBusy',
        'sessionActionHtml',
        'cardGoalLine',
        'renderCardBody',
      ],
      ['RESUME_SVG', 'SESSION_ACTION_ARIA', 'GOAL_STATUS_LABELS', 'GOAL_SVG', '_busy'],
      {
        effortLabel: (e: string) => e,
        dhShow: () => false,
        formatTokens: () => '0',
        formatNmSSs: () => '0',
        safeHref: (u: string) => u,
        getEnvBadgeColor: () => '#000',
        _envCount: () => 1,
        isSiblingSession: () => false,
        renderCardIo: () => '',
        renderCardArtifacts: () => '',
        renderAgentTree: () => '',
        renderMultiChoiceCard: () => '',
        acPermissionsHtml: () => '',
        acQuestionHtml: () => '',
        renderCardGoal: () => '',
        renderTimeline: () => '',
        renderModelNote: () => '',
        renderModelPicker: () => '',
        renderEffortPicker: () => '',
        cardTotalTokens: () => 0,
        currentUserId: 'U1',
        SELF_INSTANCE_NAME: '',
        READ_ONLY_MSG: 'read only',
      },
    );
    const waiting = {
      ...resuming({ kind: 'error-retry', at: AT, attempt: 1, maxAttempts: 3, reason: RATE_LIMIT }),
      ownerId: 'U1',
      model: 'claude-opus',
      lastActivity: '2026-10-22T09:24:00Z',
    };
    const waitingHtml = body.renderCardBody(waiting, 'working');
    expect(waitingHtml).toContain('btn-close');
    expect(waitingHtml).not.toContain('btn-stop');
    expect(waitingHtml).toContain('class="card-resume"');

    const runningHtml = body.renderCardBody({ ...waiting, activityState: 'working' }, 'working');
    expect(runningHtml).toContain('btn-stop');
    expect(runningHtml).not.toContain('class="card-resume"');
  });

  it('an open panel re-renders its tasks on every board push (a finished turn stops spinning)', () => {
    const ws = TEMPLATE.slice(TEMPLATE.indexOf('\nfunction connectWs('));
    // Spec 12: the tasks of the agent the panel shows (the main agent by default) —
    // spec 13: through the one live path (repaintPanelSession → repaintPanelScope → repaintPanelTasks).
    expect(ws).toContain('repaintPanelSession();');
    expect(TEMPLATE.slice(TEMPLATE.indexOf('\nfunction repaintPanelScope('))).toContain('repaintPanelTasks();');
    // SSOT 2026-10-29 T5: with the work no task got (the main agent's 태스크 밖 row).
    expect(TEMPLATE.slice(TEMPLATE.indexOf('\nfunction repaintPanelTasks('))).toContain(
      'renderPanelTasks(panelAgentTasks(), panelAgentLabel(), panelAgentEarlier(), panelAgentOutside());',
    );
    // …which rides the task_update push with the list (null clears it; a server without it leaves it).
    expect(ws).toContain(
      "if ('tasksOutside' in msg) _sessionCache[msg.sessionKey].tasksOutside = msg.tasksOutside || undefined;",
    );
  });
});

// SSOT 2026-10-29 T4: the face names one task — the one in progress (card.task, the task row).
// The summary line used to fall back to the last completed task (or the last in the list), which
// read as a second task next to the running one.
describe('the card summary never names a task other than the running one (SSOT 2026-10-29 T4)', () => {
  const shown = load<Card>(CARD_OF_FNS, CARD_OF_VARS, {
    // The task row is shown: it names the running task, the summary does not repeat it.
    dhShow: () => true,
    dhTruncate: () => null,
    currentUserId: 'U1',
    _ownerIndex: null,
    SELF_INSTANCE_NAME: '',
  });
  const tasks = [
    { id: 'T1', content: 'Read the spec', status: 'completed' },
    { id: 'T2', content: 'Write the parser', status: 'in_progress', startedAt: AT },
    { id: 'T3', content: 'Ship it', status: 'pending' },
  ];

  it('a running task and a completed task: the completed task never reaches the summary', () => {
    const s = { key: 'k', displayHeadline: 'Headline', activityState: 'working', tasks };
    // Task row hidden: the summary is the running task.
    expect(card.cardOf(s, 'working').summary).toBe('Write the parser');
    // Task row shown: the row is the running task; the summary falls to the session's own titles — or nothing.
    const face = shown.cardOf(s, 'working');
    expect(face.task).toEqual({ label: 'Write the parser', id: 'T2', startedAt: AT });
    expect(face.summary).toBeUndefined();
    expect(shown.cardSummary({ ...s, summaryTitle: 'Parser work' }, 'working', 'Headline')).toBe('Parser work');
    expect(shown.cardSummary({ ...s, title: 'Thread title' }, 'working', 'Headline')).toBe('Thread title');
    for (const m of [card, shown]) {
      for (const col of ['working', 'waiting', 'idle', 'closed']) {
        const text = JSON.stringify(m.cardOf(s, col));
        expect(text, col).not.toContain('Read the spec');
        expect(text, col).not.toContain('Ship it');
      }
    }
  });

  it('no running task (done, or waiting on its next step): no task text at all — not the last done, not the last listed', () => {
    const idle = { key: 'k', activityState: 'idle', tasks: tasks.map((t) => ({ ...t, status: 'completed' })) };
    expect(card.cardSummary(idle, 'idle', 'Headline')).toBe('');
    expect(card.cardSummary({ ...idle, title: 'Thread title' }, 'idle', 'Headline')).toBe('Thread title');
    // A title that is the headline is not said twice.
    expect(card.cardSummary({ ...idle, title: 'Headline' }, 'idle', 'Headline')).toBe('');
    const between = { key: 'k', activityState: 'working', tasks: [tasks[0], tasks[2]] };
    expect(card.cardSummary(between, 'working', 'Headline')).toBe('');
    expect(card.cardOf(between, 'working').summary).toBeUndefined();
  });
});

// @vitest-environment happy-dom
/**
 * The board's 작업 큐 section (.prd/36 v2 §4.3, SSOT_4): under the CRON lane, `작업 큐 | 개인별 큐`; a card that waits
 * in a lane leaves the board's columns for its lane; each lane's history shows it ran one at a time. Executes the
 * shipped client code (work-queue-client.ts) as the browser receives it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORK_QUEUE_CLIENT_JS, WORK_QUEUE_CSS } from '../work-queue-client';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');

function fnSource(name: string): string {
  const start = WORK_QUEUE_CLIENT_JS.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = WORK_QUEUE_CLIENT_JS.indexOf('\n}\n', start);
  return WORK_QUEUE_CLIENT_JS.slice(start + 1, end + 2);
}
function varSource(name: string): string {
  const m = WORK_QUEUE_CLIENT_JS.match(new RegExp(`^var ${name} = .*?;$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return m[0];
}
function load<T>(fns: string[], vars: string[] = []): T {
  const body = `${vars.map(varSource).join('\n')}\n${fns.map(fnSource).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(body)() as T;
}

const HOUR = 60 * 60 * 1000;

describe('wqSplitBoard — a card that waits in a lane moves to its lane', () => {
  const { wqSplitBoard } = load<any>(['wqSplitBoard']);
  const s = (key: string, queueWait?: unknown) => ({ key, ...(queueWait ? { queueWait } : {}) });

  it('takes the queued cards out of every column, by lane, in their order; the rest stay', () => {
    const rest = {
      working: [
        s('a', { kind: 'queued', queue: 'qa-dev2', position: 2 }),
        s('b'),
        s('c', { kind: 'running', queue: 'qa-dev2' }),
        s('d', { kind: 'queued', queue: 'qa-dev2', position: 1 }),
      ],
      waiting: [s('e', { kind: 'env', owner: 'env:x' })],
      idle: [s('f', { kind: 'queued', queue: 'deploy-dev2', position: 1 })],
      closed: [],
      extra: 7,
    };
    const out = wqSplitBoard(rest);
    expect(out.board.working.map((x: any) => x.key)).toEqual(['b', 'c']);
    expect(out.board.waiting.map((x: any) => x.key)).toEqual(['e']);
    expect(out.board.idle).toEqual([]);
    expect(out.board.extra).toBe(7);
    expect(Object.keys(out.byLane).sort()).toEqual(['deploy-dev2', 'qa-dev2']);
    expect(out.byLane['qa-dev2'].map((x: any) => x.key)).toEqual(['d', 'a']);
  });

  it('a card that needs an answer (or works) stays on the board even with a lane entry waiting', () => {
    const out = wqSplitBoard({
      waiting: [{ key: 'w', activityState: 'waiting', queueWait: { kind: 'queued', queue: 'qa-dev2', position: 1 } }],
      working: [{ key: 'r', activityState: 'working', queueWait: { kind: 'queued', queue: 'qa-dev2', position: 2 } }],
      idle: [],
      closed: [],
    });
    expect(out.board.waiting.map((x: any) => x.key)).toEqual(['w']);
    expect(out.board.working.map((x: any) => x.key)).toEqual(['r']);
    expect(out.byLane).toEqual({});
  });
});

describe('wqActionsFor — who may do what to a lane entry', () => {
  const { wqActionsFor } = load<any>(['wqActionsFor']);
  const e = (state: string, ownerId = 'U1') => ({ id: 'wq-1', state, task: { ownerId } });
  it('an admin (admin mode): 먼저 진행 and 빼기 on a waiting entry, 돌려놓기 on a running one', () => {
    expect(wqActionsFor(e('waiting'), true, 'U9')).toEqual(['first', 'cancel']);
    expect(wqActionsFor(e('running'), true, 'U9')).toEqual(['release']);
  });
  it('the entry’s owner: 빼기 on their waiting entry only; anyone else: nothing', () => {
    expect(wqActionsFor(e('waiting', 'U1'), false, 'U1')).toEqual(['cancel']);
    expect(wqActionsFor(e('running', 'U1'), false, 'U1')).toEqual([]);
    expect(wqActionsFor(e('waiting', 'U1'), false, 'U2')).toEqual([]);
    expect(wqActionsFor(e('waiting', 'U1'), false, undefined)).toEqual([]);
  });
});

describe('wqCardButtonsHtml — the open card of a lane-waiting card', () => {
  const build = (map: Record<string, unknown>) =>
    new Function(
      'map',
      `var _wqEntryByCard = map;
       function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
       function escJs(s) { return esc(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }
       ${varSource('WQ_CARD_BUTTONS')}
       ${fnSource('wqCardButtonsHtml')}
       return wqCardButtonsHtml;`,
    )(map) as (key: string) => string;

  it('an admin (admin mode) gets 먼저 진행 and 대기에서 빼기; each press reaches wqCardAction with the card key', () => {
    const html = build({ 'h:1::work:C1:t1': { id: 'wq-6', queue: 'qa-x', can: ['first', 'cancel'] } })(
      'h:1::work:C1:t1',
    );
    const { document } = globalThis as unknown as { document: any };
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const btns: any[] = [...holder.querySelectorAll('button')];
    expect(btns.map((b) => [b.textContent, b.dataset.action])).toEqual([
      ['먼저 진행', 'wq-first'],
      ['대기에서 빼기', 'wq-cancel'],
    ]);
    const calls: unknown[][] = [];
    for (const b of btns) {
      new Function('event', 'wqCardAction', b.getAttribute('onclick') as string)(
        { stopPropagation() {} },
        (...a: unknown[]) => calls.push(a),
      );
    }
    expect(calls).toEqual([
      ['h:1::work:C1:t1', 'wq-first'],
      ['h:1::work:C1:t1', 'wq-cancel'],
    ]);
  });

  it('the owner gets 대기에서 빼기 only; a card with no lane entry, or nothing allowed, gets nothing', () => {
    const fn = build({ a: { id: 'wq-1', queue: 'q', can: ['cancel'] }, b: { id: 'wq-2', queue: 'q', can: [] } });
    expect(fn('a')).toContain('대기에서 빼기');
    expect(fn('a')).not.toContain('먼저 진행');
    expect(fn('b')).toBe('');
    expect(fn('c')).toBe('');
  });
});

describe('the history — one at a time', () => {
  const { wqStripBars, wqRecordText } = load<any>(
    ['wqStripBars', 'wqRecordText', 'wqReason', 'wqDur', 'wqClock'],
    ['WQ_DAY_MS', 'WQ_END_LABEL', 'WQ_END_GLYPH'],
  );
  const now = 100 * HOUR;
  const rec = (id: string, startedAt: number | undefined, endedAt: number, end = 'done') => ({
    id,
    end,
    keys: ['ABC-1'],
    enteredAt: (startedAt ?? endedAt) - HOUR,
    ...(startedAt !== undefined ? { startedAt } : {}),
    endedAt,
    task: { title: `task ${id}` },
  });

  it('the strip draws each run of the last 24 hours and the running one — bars that never overlap', () => {
    const q = {
      recent: [
        rec('wq-3', now - 3 * HOUR, now - 2 * HOUR),
        rec('wq-2', now - 6 * HOUR, now - 4 * HOUR, 'released'),
        rec('wq-1', now - 30 * HOUR, now - 29 * HOUR),
        rec('wq-x', undefined, now - HOUR, 'cancelled'),
      ],
      running: [{ id: 'wq-4', startedAt: now - HOUR, task: { title: 'now' } }],
    };
    const bars = wqStripBars(q, now);
    expect(bars.map((b: any) => [b.id, b.kind])).toEqual([
      ['wq-2', 'released'],
      ['wq-3', 'done'],
      ['wq-4', 'run'],
    ]);
    const spans = bars.map((b: any) => [b.left, b.left + b.width]).sort((a: number[], b: number[]) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1] - 0.01);
    expect(bars[2].left + bars[2].width).toBeCloseTo(100, 1);
  });

  it('short runs back to back keep their bars apart (the minimum width never runs into the next run)', () => {
    const q = {
      recent: [
        rec('b', now - 2 * HOUR + 60_000, now - 2 * HOUR + 120_000),
        rec('a', now - 2 * HOUR, now - 2 * HOUR + 60_000),
      ],
      running: [],
    };
    const bars = wqStripBars(q, now).sort((x: any, y: any) => x.left - y.left);
    expect(bars).toHaveLength(2);
    expect(bars[0].left + bars[0].width).toBeLessThanOrEqual(bars[1].left + 1e-9);
  });

  it('a history line says how it ended, when it ran, and why it was given back', () => {
    const t = wqRecordText({ ...rec('wq-2', 2 * HOUR, 3 * HOUR, 'released'), reason: 'admin:U9' });
    expect(t).toMatchObject({ end: '돌려놓음', label: 'task wq-2', keys: ' · ABC-1', why: ' — 관리자' });
    expect(t.when).toMatch(/→ .* \(1시간\)$/);
    expect(wqRecordText({ ...rec('r', undefined, 5 * HOUR, 'refused') }).end).toBe('같은 작업이라 거절');
    expect(wqRecordText({ ...rec('r', undefined, 5 * HOUR, 'refused'), reason: 'same-work' }).why).toBe(
      ' — 같은 키가 다른 스레드에서 진행 중이거나 대기 중',
    );
    expect(wqRecordText({ ...rec('s', undefined, 5 * HOUR, 'started') }).when).toMatch(/시작 \(대기 1시간\)/);
  });
});

describe('the summary', () => {
  const { wqSummary } = load<any>(['wqSummary']);
  it('lanes, what runs and waits in them, and what waits per person', () => {
    expect(
      wqSummary(
        [
          { running: [1], waiting: [1, 2] },
          { running: [], waiting: [] },
        ],
        [{ waiting: [1] }],
      ),
    ).toBe('레인 2개 · 진행 1 · 대기 2 | 개인별 대기 1');
  });
});

describe('the page', () => {
  const page = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

  it('the section sits right under the CRON lane and above the board, with the 작업 큐 | 개인별 큐 tabs', () => {
    const cron = page.indexOf('id="cron-lane"');
    const wq = page.indexOf('id="wq-section"');
    const board = page.indexOf('<ui-agent-inbox id="kanban"');
    expect(cron).toBeGreaterThan(0);
    expect(wq).toBeGreaterThan(cron);
    expect(wq).toBeLessThan(board);
    const markup = page.slice(wq, page.indexOf('</ui-tabs>', wq));
    expect(markup).toContain('<ui-tabs class="wq-tabs" id="wq-tabs"');
    expect(markup).toContain('slot="lanes"');
    expect(markup).toContain('slot="people"');
    expect(WORK_QUEUE_CLIENT_JS).toContain("label: '작업 큐'");
    expect(WORK_QUEUE_CLIENT_JS).toContain("label: '개인별 큐'");
  });

  it('ships the script and its sheet; the board moves the queued cards before painting the columns', () => {
    expect(page).toContain('${WORK_QUEUE_CLIENT_JS}');
    expect(page).toContain('<style id="work-queue-css">\n${WORK_QUEUE_CSS}\n</style>');
    expect(WORK_QUEUE_CSS).toContain('.wq-section');
    const render = page.slice(
      page.indexOf('\nfunction renderBoard('),
      page.indexOf('\n}\n', page.indexOf('\nfunction renderBoard(')),
    );
    expect(render.indexOf('wqSplitBoard(rest)')).toBeLessThan(render.indexOf("keys(rest.working, 'working', kb)"));
    expect(render).toContain('paintWorkQueues(wqSplit.byLane, uq.line)');
  });

  it("a lane card's open card leads its actions bar with the lane buttons (the body is the page's, not the element's)", () => {
    const body = page.slice(page.indexOf('\nfunction renderCardBody('));
    const bar = body.slice(body.indexOf('const laneBtns'), body.indexOf('const needsHtml'));
    expect(bar).toContain('wqCardButtonsHtml(s.key)');
    expect(bar.indexOf('laneBtns + sessionActionHtml(')).toBeGreaterThan(0);
    expect(WORK_QUEUE_CLIENT_JS).toContain("'/api/dashboard/work-queues/'");
  });

  it('the script is plain ES5 with no template syntax (it reaches the browser byte for byte)', () => {
    expect(WORK_QUEUE_CLIENT_JS).not.toContain('`');
    expect(WORK_QUEUE_CLIENT_JS).not.toContain('${');
    expect(
      () => new Function(WORK_QUEUE_CLIENT_JS.replace(/\(function wqWire\(\) \{[\s\S]*\}\)\(\);\s*$/, '')),
    ).not.toThrow();
  });
});

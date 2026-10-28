/**
 * SSOT 2026-10-21 T2/T3 — the work item's goal list, client half. Executes the
 * shipped card code (cut out of renderDashboardPage()'s template literal and
 * cooked exactly as the browser receives it, same harness as
 * dashboard-agent-inbox-client.test.ts): what the card shows, which controls it
 * offers to whom, what each control sends, and that a goal being typed survives
 * the card's live re-render.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
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
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, __errors: typeof _goalErrors !== 'undefined' ? _goalErrors : undefined };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

interface GoalCard {
  renderCardGoal(s: any, col: string, canEdit: boolean): string;
}

const RENDER_FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'formatTokens',
  'formatDuration',
  'formatGoalTime',
  'renderGoalHistory',
  'isBusy',
  'setBusy',
  'renderCardGoal',
];
const RENDER_VARS = ['GOAL_STATUS_LABELS', 'GOAL_VIA_LABELS', '_goalHistoryOpen', '_goalErrors', '_busy'];

function card(overrides: Record<string, any> = {}) {
  return {
    key: 'self::C1:t1',
    terminated: false,
    goal: {
      current: {
        goalId: 'g1',
        objective: '대시보드 개선',
        status: 'active',
        continuationCount: 2,
        maxContinuations: 10,
        lastEvalReason: '테스트가 없다',
      },
      queue: [
        { goalId: 'g2', objective: '두번째' },
        { goalId: 'g3', objective: '세번째' },
      ],
      completedCount: 1,
    },
    ...overrides,
  };
}

/** Run every inline handler of the rendered HTML against a recording `goalAction`. */
function clickTargets(html: string): any[][] {
  const calls: any[][] = [];
  const goalAction = (...args: any[]) => calls.push(args);
  const event = { stopPropagation() {} };
  for (const m of html.matchAll(/onclick="([^"]*)"/g)) {
    const js = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    // The completed-goals toggle (T6) only opens a list — not a goal action.
    new Function('event', 'goalAction', 'toggleGoalHistory', js)(event, goalAction, () => {});
  }
  return calls;
}

describe('work item goal list — rendering (T2)', () => {
  const { renderCardGoal } = load<GoalCard>(RENDER_FNS, RENDER_VARS);

  it('shows the current goal, its state and progress, what is missing, the queue and the done count', () => {
    const html = renderCardGoal(card(), 'working', true);

    expect(html).toContain('대시보드 개선');
    expect(html).toContain('진행 중');
    expect(html).toContain('2/10');
    expect(html).toContain('남은 것: 테스트가 없다');
    expect(html).toContain('대기 중인 goal 2개');
    expect(html.indexOf('두번째')).toBeLessThan(html.indexOf('세번째'));
    expect(html).toContain('완료된 goal 1개');
  });

  it.each([
    ['paused', '일시정지'],
    ['complete', '완료'],
  ])('labels a %s goal', (status, label) => {
    const html = renderCardGoal(
      card({ goal: { current: { ...card().goal.current, status }, queue: [], completedCount: 0 } }),
      'idle',
      true,
    );
    expect(html).toContain(label);
    expect(html).not.toContain('남은 것');
  });

  it('escapes objectives and ids', () => {
    const html = renderCardGoal(
      card({
        goal: {
          current: {
            goalId: "g'1",
            objective: '<img src=x onerror=alert(1)>',
            status: 'active',
            continuationCount: 0,
            maxContinuations: 10,
          },
          queue: [{ goalId: 'g2', objective: '<script>x</script>' }],
          completedCount: 0,
        },
      }),
      'working',
      true,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    // The quote in the id cannot break out of the handler string.
    expect(clickTargets(html)[0][1]).toEqual({ action: 'delete', goalId: "g'1", expect: 'current' });
  });

  it('offers no goal block to a read-only viewer of a session without goals, and to a closed one', () => {
    expect(renderCardGoal(card({ goal: undefined }), 'working', false)).toBe('');
    expect(renderCardGoal(card({ goal: undefined }), 'closed', true)).toBe('');
  });

  it('offers an empty owner card the add box (현재 goal 없음)', () => {
    const html = renderCardGoal(card({ goal: undefined }), 'idle', true);
    expect(html).toContain('현재 goal 없음');
    expect(html).toContain('class="cg-add-input"');
    expect(html).toContain('바로 시작');
  });
});

describe('work item goal list — controls (T3)', () => {
  const { renderCardGoal } = load<GoalCard>(RENDER_FNS, RENDER_VARS);

  it('deletes the current goal (next starts) and each queued goal, naming where it was seen', () => {
    const html = renderCardGoal(card(), 'working', true);

    expect(html).toContain('현재 goal 삭제 · 다음 시작');
    expect(clickTargets(html)).toEqual([
      ['self::C1:t1', { action: 'delete', goalId: 'g1', expect: 'current' }, expect.anything()],
      ['self::C1:t1', { action: 'delete', goalId: 'g2', expect: 'queued' }, expect.anything()],
      ['self::C1:t1', { action: 'delete', goalId: 'g3', expect: 'queued' }, expect.anything()],
    ]);
    expect(html).toContain('현재 goal 다음에 시작');
  });

  it('says plain "현재 goal 삭제" when nothing is queued behind it', () => {
    const html = renderCardGoal(card({ goal: { ...card().goal, queue: [] } }), 'working', true);
    expect(html).toContain('>현재 goal 삭제<');
  });

  it('disables every control for a non-owner and on a closed session, and drops the add box', () => {
    for (const [col, canEdit] of [
      ['working', false],
      ['closed', true],
    ] as const) {
      const html = renderCardGoal(card(), col, canEdit);
      const all = html.match(/<button[^>]*>/g) ?? [];
      // Opening the completed goals (T6) is reading, so it stays enabled.
      const buttons = all.filter((b) => !b.includes('cg-history-toggle'));
      expect(all.filter((b) => b.includes('cg-history-toggle'))).toEqual([expect.not.stringContaining(' disabled')]);
      expect(buttons.length).toBe(3);
      for (const b of buttons) expect(b).toContain(' disabled');
      expect(html).not.toContain('cg-add-input');
    }
  });

  it('posts the action as JSON with the CSRF token, and retries once after a token refresh', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 403, ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ ok: true }) });
    let token = 'old';
    const env = {
      fetch,
      refreshCsrfToken: async () => {
        token = 'new';
      },
    };
    const { postGoalAction } = new Function(
      'fetch',
      'refreshCsrfToken',
      'getToken',
      `${clientFn('postGoalAction').replace(/_csrfToken/g, 'getToken()')}\nreturn { postGoalAction };`,
    )(env.fetch, env.refreshCsrfToken, () => token);

    const r = await postGoalAction('self::C1:t1', { action: 'add', objective: '새 목표' });

    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/dashboard/session/self%3A%3AC1%3At1/goal');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ action: 'add', objective: '새 목표' });
    expect(init.headers['X-CSRF-Token']).toBe('old');
    expect(fetch.mock.calls[1][1].headers['X-CSRF-Token']).toBe('new');
  });

  it('shows a refused action on the card until the next success', async () => {
    const refreshCard = vi.fn();
    const loadSessions = vi.fn();
    const postGoalAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'The current goal has changed — refresh and try again' })
      .mockResolvedValueOnce({ ok: true, error: '' });
    const mod = load<any>(['setGoalError', 'goalAction', ...RENDER_FNS], RENDER_VARS, {
      refreshCard,
      loadSessions,
      postGoalAction,
      // Spec 13: the goal editor's home is the panel — a write re-renders it there too.
      panelOpen: false,
      panelSessionKey: null,
      renderPanelGoal: () => {},
    });

    await mod.goalAction('self::C1:t1', { action: 'delete', goalId: 'g1', expect: 'current' }, null);
    expect(mod.renderCardGoal(card(), 'working', true)).toContain('The current goal has changed');

    await mod.goalAction('self::C1:t1', { action: 'delete', goalId: 'g1', expect: 'current' }, null);
    expect(mod.renderCardGoal(card(), 'working', true)).not.toContain('cg-error');
    expect(loadSessions).toHaveBeenCalledTimes(2);
  });
});

describe('work item goal list — the goal being typed survives a live re-render', () => {
  function fakeCard(activeIsInput: boolean, value: string) {
    const input = { classList: { contains: (c: string) => c === 'cg-add-input' }, value };
    const body: any = {
      innerHTML: '<old>',
      contains: (node: unknown) => node === input,
      querySelector: (sel: string) => (sel === '.cg-add-input' ? body._input : null),
      _input: input,
    };
    const document = { activeElement: activeIsInput ? input : null };
    const el: any = {
      attrs: { 'data-col': 'working', 'data-state': 'working' },
      getAttribute(n: string) {
        return this.attrs[n];
      },
      setAttribute(n: string, v: string) {
        this.attrs[n] = v;
      },
      _faceEl: { innerHTML: '' },
      _faceHtml: 'face',
      _bodyEl: body,
      _bodyHtml: 'old-body',
    };
    return { el, body, input, document };
  }
  const parts = { col: 'working', state: 'working', face: 'face', body: 'new-body', cid: null };

  it('does not replace the body while the goal input has focus (typing / IME untouched)', () => {
    const { el, body, document } = fakeCard(true, '쓰는 중');
    const { applyCardParts } = load<any>(
      ['isEditingGoal', 'isPickingModel', 'captureGoalDraft', 'restoreGoalDraft', 'applyCardParts'],
      [],
      {
        document,
        updateTimersIn: () => {},
        animateCountersIn: () => {},
        // The browser morphs the body; this fake body rebuilds on write.
        morphInnerHtml: (b: { innerHTML: string }, html: string) => {
          b.innerHTML = html;
        },
        acHydrate: () => {}, // affectUI batch 1: the body's approval cards take their data
        atHydrate: () => {}, // affectUI batch 2: the body's agent tree takes its data
      },
    );

    applyCardParts(el, parts);

    expect(body.innerHTML).toBe('<old>');
    expect(el._bodyHtml).toBe('old-body');
  });

  it('carries an unfocused draft into the new body', () => {
    const { el, body, document } = fakeCard(false, '나중에 보낼 goal');
    const fresh = { classList: { contains: () => true }, value: '' };
    const { applyCardParts } = load<any>(
      ['isEditingGoal', 'isPickingModel', 'captureGoalDraft', 'restoreGoalDraft', 'applyCardParts'],
      [],
      {
        document,
        updateTimersIn: () => {},
        animateCountersIn: () => {},
        // The browser morphs the body; this fake body rebuilds on write.
        morphInnerHtml: (b: { innerHTML: string }, html: string) => {
          b.innerHTML = html;
        },
        acHydrate: () => {}, // affectUI batch 1: the body's approval cards take their data
        atHydrate: () => {}, // affectUI batch 2: the body's agent tree takes its data
      },
    );
    // innerHTML assignment builds a fresh, empty input.
    Object.defineProperty(body, 'innerHTML', {
      set(v: string) {
        body._html = v;
        body._input = fresh;
      },
      get() {
        return body._html;
      },
    });

    applyCardParts(el, parts);

    expect(body._html).toBe('new-body');
    expect(fresh.value).toBe('나중에 보낼 goal');
  });
});

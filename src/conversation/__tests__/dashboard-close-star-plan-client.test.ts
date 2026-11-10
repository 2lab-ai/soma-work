/**
 * SSOT 2026-11-10 (Z), the page half — run from the shipped client code cut out of renderDashboardPage()'s template
 * literal (the server half, the close that froze everything: src/__tests__/session-registry-close-nonblocking.test.ts):
 *
 *   T1 "작업 카드에서 닫기 누르면 너무 오래 걸림 - 즉시 반응하고 닫는중 빨갛게 표시하고 비동기로 처리해줘야함."
 *      C1  from the confirmed press the card's face reads 닫는 중 in the red (failed) tone — no clock, no NEEDS YOU cue
 *      C2  the close button reads 닫는 중 and is busy on both surfaces (the open card, the panel's status bar)
 *      C3  doAction marks the close before the request goes out; on success it holds until the board has reloaded,
 *          on a failure it lets go at once
 *   T2 "디테일 작업 카드에서 즐겨 찾기를 작업 카드처럼 표시해줘 즐겨 찾기 레이블 필요 없음 이름 오른쪽에 작업 카드 처럼 표시해줘."
 *      S1  the detail card's title row holds a star toggle right after the title text — a glyph, no label
 *      S2  the status bar no longer carries a 즐겨찾기 button
 *      S3  the toggle paints like the board card's (cardStarOf): pressed + filled amber when on, inert with the reason
 *      S4  a press stars / unstars the open card (doStar); an inert one does nothing
 *   T3 "닫기 버튼은 항상 빨갛게 표시해주고 한번 컨펌해줘."
 *      K1  Close is the danger tone on the open card and in the status bar (whose danger actions take two presses)
 *      K2  on the open card the first press arms it (한 번 더 눌러 닫기), the second closes, 4 s without one disarms
 *   T4 "계획모든느 디폴트러 꺼줘."
 *      P1  a new task starts with 작업 계획 off; only an explicit on plans first
 *   I1 every Korean string the change shows has an English entry (en-page catalog)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const EN_PAGE = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'), 'utf-8'),
) as Record<string, string>;

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
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  ({ fns, inject } = viewerScope(fns, inject));
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);

const KEY = 'inst::C1:t1';
const session = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  ownerId: 'U1',
  sessionState: 'MAIN',
  activityState: 'idle',
  title: 'task',
  ...over,
});
type Action = { id: string; label: string; busy?: boolean; tone?: string; armed?: boolean; lock?: string };

const ACTION_FNS = ['esc', 'escAttr', 'escJs', 'toNum', 'pendingAutoResume', 'isBusy', 'sessionActionsOf'];
const actions = (busy: Record<string, boolean> = {}, inject: Record<string, unknown> = {}) =>
  load<{
    sessionActionsOf(s: unknown, col: string): Action[];
    sessionActionHtml(s: unknown, col: string, noStar?: boolean): string;
  }>([...ACTION_FNS, 'sessionActionHtml'], ['SESSION_ACTION_TONE'], {
    _busy: Object.assign(Object.create(null), busy),
    currentUserId: 'U1',
    SELF_INSTANCE_NAME: '',
    READ_ONLY_MSG: 'read only',
    rbOn: () => false,
    ...inject,
  });

type BarData = { actions: Array<{ id: string; label: string; tone?: string; busy?: boolean; disabled?: unknown }> };
const head = (s: unknown, col: string, busy: Record<string, boolean> = {}, inject: Record<string, unknown> = {}) =>
  load<{ panelHeadData(s: unknown, col: string): BarData }>(
    [...ACTION_FNS, 'formatTaskTime', 'autoResumeLabel', 'rootStatusOf', 'planHeadActions', 'panelHeadData'],
    ['AGENT_STATUS_LABEL', 'PS_BAR_STATUS', 'SESSION_ACTION_ARIA'],
    {
      currentUserId: 'U1',
      SELF_INSTANCE_NAME: '',
      READ_ONLY_MSG: 'read only',
      _busy: Object.assign(Object.create(null), busy),
      _rb: null,
      rbOn: () => false,
      ...inject,
    },
  ).panelHeadData(s, col);

afterEach(() => {
  vi.useRealTimers();
});

describe('T1 — a close shows at once: 닫는 중, in red, until the board has it closed', () => {
  it('C1 — the face reads 닫는 중 in the failed (red) tone while the close runs: no clock, no NEEDS YOU cue', () => {
    const face = (busy: Record<string, boolean>) =>
      load<{ viewCardOf(s: unknown, col: string): Record<string, unknown> }>(['isBusy', 'viewCardOf'], [], {
        _busy: Object.assign(Object.create(null), busy),
        cardOf: () => ({ id: KEY, title: 'task', status: 'waiting', since: 5, elapsedMs: 9, attention: true }),
        cardStarOf: () => undefined,
        cardTldrOf: () => null,
        cardFollowupsOf: () => [],
        cardAsks: () => false,
        viewSpec: () => ({ face: {} }),
        faceOf: (c: Record<string, unknown>) => c,
      }).viewCardOf(session(), 'waiting');
    const closing = face({ [`${KEY}|closing`]: true });
    expect(closing.status).toBe('failed');
    expect(closing.statusText).toBe('닫는 중');
    expect(closing.since).toBeUndefined();
    expect(closing.elapsedMs).toBeUndefined();
    expect(closing.attention).toBeUndefined();
    // Not closing: the face as it was.
    const plain = face({});
    expect(plain.status).toBe('waiting');
    expect(plain.statusText).toBeUndefined();
    expect(plain.since).toBe(5);
  });

  it('C2 — the close button reads 닫는 중 and is busy, on the open card and in the status bar', () => {
    const busy = { [`${KEY}|closing`]: true, [`${KEY}|action`]: true };
    const close = actions(busy)
      .sessionActionsOf(session(), 'idle')
      .find((a) => a.id === 'close');
    expect(close).toMatchObject({ label: '닫는 중', busy: true });
    const html = actions(busy).sessionActionHtml(session(), 'idle');
    expect(html).toMatch(
      /<button class="ui-btn is-danger" data-action="close" disabled aria-busy="true"[^>]*>닫는 중<\/button>/,
    );
    const bar = head(session(), 'idle', busy).actions.find((a) => a.id === 'close');
    expect(bar).toMatchObject({ label: '닫는 중', busy: true, tone: 'danger' });
  });

  describe('C3 — doAction holds 닫는 중 from before the request until the board reloads', () => {
    const run = (ok: boolean) => {
      const seen: { closingAtFetch?: boolean } = {};
      let finishReload: () => void = () => {};
      const reload = new Promise<void>((r) => {
        finishReload = r;
      });
      const busy = Object.create(null);
      const env: Record<string, unknown> = {
        _busy: busy,
        _csrfToken: 't',
        _sessionCache: { [KEY]: { title: 'task' } },
        panelOpen: false,
        panelSessionKey: null,
        refreshCard: vi.fn(),
        renderPanelHead: vi.fn(),
        refreshCsrfToken: vi.fn(),
        dashToast: vi.fn(),
        loadSessions: vi.fn(() => reload),
        BOARD_LOAD_TIMEOUT_MS: 20000,
        console: { error: () => {} },
        fetch: vi.fn(async () => {
          seen.closingAtFetch = !!busy[`${KEY}|closing`];
          return { ok, status: ok ? 200 : 500, json: async () => ({}) };
        }),
      };
      const m = load<{ doAction(k: string, a: string): Promise<void>; isBusy(k: string, op: string): boolean }>(
        ['isBusy', 'setBusy', 'doAction'],
        ['DA_LABEL', 'DA_DONE'],
        env,
      );
      return { m, seen, finishReload, env };
    };

    it('success: marked before the request, held until the reload answers, then let go', async () => {
      const { m, seen, finishReload, env } = run(true);
      const done = m.doAction(KEY, 'close');
      // Marked at the press, before the request goes out: the card repaints red at once.
      expect(m.isBusy(KEY, 'closing')).toBe(true);
      expect(env.refreshCard).toHaveBeenCalledWith(KEY);
      await vi.waitFor(() => expect(env.loadSessions).toHaveBeenCalled());
      expect(seen.closingAtFetch).toBe(true);
      // The answer came; the board has not reloaded yet — still 닫는 중 (no flash back to the old face).
      expect(m.isBusy(KEY, 'closing')).toBe(true);
      expect(m.isBusy(KEY, 'action')).toBe(true);
      finishReload();
      await done;
      expect(m.isBusy(KEY, 'closing')).toBe(false);
      expect(m.isBusy(KEY, 'action')).toBe(false);
    });

    it('a reload that never answers lets go after the board-load bound', async () => {
      vi.useFakeTimers();
      const { m } = run(true);
      const done = m.doAction(KEY, 'close');
      await vi.advanceTimersByTimeAsync(19_999);
      expect(m.isBusy(KEY, 'closing')).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(m.isBusy(KEY, 'closing')).toBe(false);
      expect(m.isBusy(KEY, 'action')).toBe(false);
    });

    it('failure: let go at once, with the toast that offers a retry', async () => {
      const { m, finishReload, env } = run(false);
      finishReload();
      await m.doAction(KEY, 'close');
      expect(m.isBusy(KEY, 'closing')).toBe(false);
      expect(m.isBusy(KEY, 'action')).toBe(false);
      expect(env.dashToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }), expect.any(Function));
    });

    it('stop and trash never read 닫는 중', async () => {
      const { m, finishReload } = run(true);
      finishReload();
      const p = m.doAction(KEY, 'stop');
      expect(m.isBusy(KEY, 'closing')).toBe(false);
      await p;
    });
  });
});

describe('T2 — the detail card’s star sits right of the title, as on the board card', () => {
  const titleRow = PAGE.slice(PAGE.indexOf('<div class="panel-title-row">'), PAGE.indexOf('id="panel-title-sub"'));

  it('S1 — the title row: title text, then the star toggle (a glyph, no label), then 퍼머링크', () => {
    const title = titleRow.indexOf('id="panel-title"');
    const star = titleRow.indexOf('id="panel-star"');
    const link = titleRow.indexOf('id="panel-permalink"');
    expect(star).toBeGreaterThan(title);
    expect(link).toBeGreaterThan(star);
    const btn = titleRow.match(/<button [^>]*id="panel-star"[^>]*>(.*?)<\/button>/);
    expect(btn).not.toBeNull();
    expect(btn?.[0]).toMatch(/type="button"/);
    expect(btn?.[0]).toMatch(/aria-pressed="false"/);
    expect(btn?.[0]).toMatch(/\shidden[\s>]/);
    // The glyph alone — no 즐겨찾기 label on screen (its name is the aria-label).
    expect(btn?.[1]).toBe('<i data-ui-icon="star"></i>');
    expect(btn?.[0]).toMatch(/aria-label="즐겨찾기"/);
  });

  it('S2 — the status bar carries no 즐겨찾기 button any more', () => {
    for (const [s, col] of [
      [session(), 'idle'],
      [session({ starred: true }), 'idle'],
      [session({ terminated: true }), 'closed'],
      [session({ activityState: 'working' }), 'working'],
    ] as const) {
      expect(head(s, col).actions.map((a) => a.id)).not.toContain('star');
    }
    // 살리기 stays where it was.
    expect(head(session({ terminated: true }), 'closed').actions.map((a) => a.id)).toContain('revive');
  });

  type El = {
    hidden: boolean;
    title: string;
    attrs: Record<string, string>;
    classes: Set<string>;
    setAttribute(k: string, v: string): void;
    removeAttribute(k: string): void;
    getAttribute(k: string): string | null;
    classList: { toggle(c: string, on: boolean): void };
  };
  const fakeEl = (): El => {
    const el: El = {
      hidden: true,
      title: '',
      attrs: {},
      classes: new Set(),
      setAttribute(k, v) {
        el.attrs[k] = String(v);
      },
      removeAttribute(k) {
        delete el.attrs[k];
      },
      getAttribute(k) {
        return k in el.attrs ? el.attrs[k] : null;
      },
      classList: {
        toggle(c, on) {
          if (on) el.classes.add(c);
          else el.classes.delete(c);
        },
      },
    };
    return el;
  };
  const star = (el: El, inject: Record<string, unknown> = {}) =>
    load<{ renderPanelStar(s: unknown, col: string): void; panelStarPress(): void }>(
      [...ACTION_FNS, 'cardStarOf', 'renderPanelStar', 'panelStarPress'],
      [],
      {
        _busy: Object.create(null),
        currentUserId: 'U1',
        SELF_INSTANCE_NAME: '',
        READ_ONLY_MSG: 'read only',
        rbOn: () => false,
        document: { getElementById: (id: string) => (id === 'panel-star' ? el : null) },
        panelSessionKey: KEY,
        _sessionCache: {},
        doStar: vi.fn(),
        ...inject,
      },
    );

  it('S3 — on: pressed and filled; off: not; anyone but the owner: inert with the reason; no card: hidden', () => {
    const el = fakeEl();
    const m = star(el);
    m.renderPanelStar(session({ starred: true }), 'idle');
    expect(el.hidden).toBe(false);
    expect(el.attrs['aria-pressed']).toBe('true');
    expect(el.classes.has('is-on')).toBe(true);
    expect(el.title).toBe('즐겨찾기 해제 — 다시 자동 sleep·보관 대상이 돼요');
    expect(el.attrs['aria-disabled']).toBeUndefined();
    m.renderPanelStar(session(), 'idle');
    expect(el.attrs['aria-pressed']).toBe('false');
    expect(el.classes.has('is-on')).toBe(false);
    expect(el.title).toBe('즐겨찾기 — 항상 맨 위, 자동 sleep·보관 안 함');
    m.renderPanelStar(session({ ownerId: 'U9', starred: true }), 'idle');
    expect(el.attrs['aria-disabled']).toBe('true');
    expect(el.title).toBe('read only');
    m.renderPanelStar(null, '');
    expect(el.hidden).toBe(true);
  });

  it('S4 — a press stars or unstars the open card; an inert one does nothing', () => {
    const el = fakeEl();
    const doStar = vi.fn();
    const cache: Record<string, unknown> = { [KEY]: session({ starred: true }) };
    const m = star(el, { doStar, _sessionCache: cache });
    m.renderPanelStar(cache[KEY], 'idle');
    m.panelStarPress();
    expect(doStar).toHaveBeenCalledWith(KEY, false);
    cache[KEY] = session();
    m.panelStarPress();
    expect(doStar).toHaveBeenLastCalledWith(KEY, true);
    el.setAttribute('aria-disabled', 'true');
    m.panelStarPress();
    expect(doStar).toHaveBeenCalledTimes(2);
    expect(TEMPLATE).toContain('onclick="panelStarPress()"');
    // Painted with the head: every repaint of the bar (a star write starting / ending) repaints the toggle.
    expect(clientFn('renderPanelHead')).toContain('renderPanelStar(s, col);');
  });

  it('S3 — the look is the board card’s: muted outline, the filled amber star when on', () => {
    expect(CSS).toMatch(/\.panel-title-row > \.panel-star\.is-on \{[^}]*color: var\(--yellow\)/);
    expect(CSS).toMatch(/\.panel-title-row > \.panel-star\.is-on svg \{[^}]*fill: currentColor/);
  });
});

describe('T3 — Close is always red and asks once', () => {
  it('K1 — the open card’s Close is the danger tone; the status bar’s too (its danger actions take two presses)', () => {
    const html = actions().sessionActionHtml(session(), 'idle');
    expect(html).toMatch(/<button class="ui-btn is-danger" data-action="close"/);
    expect(html).toContain(`pressClose('${KEY}')`);
    expect(html).not.toContain(`doAction('${KEY}','close')`);
    // A sleeping card's Close too.
    expect(actions().sessionActionHtml(session(), 'closed')).toMatch(/class="ui-btn is-danger" data-action="close"/);
    expect(head(session(), 'idle').actions.find((a) => a.id === 'close')?.tone).toBe('danger');
    expect(head(session(), 'closed').actions.find((a) => a.id === 'close')?.tone).toBe('danger');
  });

  it('K1 — an arm on one session’s status bar never carries over to the next session the bar shows (astra P1)', () => {
    // <ui-status-bar> keeps an armed danger action whose id the new data still has; the page clears it when the bar
    // moves to another session (the deck moved, the card left) — a synchronous render with no data (renderNow).
    const seen: unknown[] = [];
    const el: Record<string, unknown> = {
      _wired: true,
      renderNow: vi.fn(() => seen.push(`render:${JSON.stringify(el.data)}`)),
    };
    let dataValue: unknown;
    Object.defineProperty(el, 'data', {
      get: () => dataValue,
      set: (v) => {
        dataValue = v;
        seen.push(`data:${v === null ? 'null' : (v as { key: string }).key}`);
      },
    });
    const sessions: Record<string, unknown> = { A: session({ key: 'A' }), B: session({ key: 'B' }) };
    const env: Record<string, unknown> = {
      document: { getElementById: (id: string) => (id === 'panel-status' ? el : null) },
      panelSessionKey: 'A',
      _sessionCache: sessions,
      wlSyncRewinds: () => {},
      sessionColOf: () => 'idle',
      renderPanelStar: () => {},
      writePanelPart: () => {},
      panelHeadNoteHtml: () => '',
      panelHeadData: (s: { key: string }) => ({ key: s.key }),
      onPanelHeadAction: () => {},
    };
    const names = Object.keys(env);
    const m = new Function(
      ...names,
      `${clientFn('renderPanelHead')}\nreturn { renderPanelHead, __set: function(v) { panelSessionKey = v; } };`,
    )(...names.map((n) => env[n])) as { renderPanelHead(): void; __set(v: string): void };
    m.renderPanelHead();
    m.renderPanelHead(); // the same session again: nothing to clear
    expect(el.renderNow).not.toHaveBeenCalled();
    m.__set('B');
    m.renderPanelHead();
    expect(seen).toEqual(['data:A', 'data:null', 'render:null', 'data:B']);
  });

  it('K2 — armed: the button asks for the second press', () => {
    const html = actions({ [`${KEY}|close-armed`]: true }).sessionActionHtml(session(), 'idle');
    expect(html).toMatch(
      /<button class="ui-btn is-danger" data-action="close" data-armed[^>]*>한 번 더 눌러 닫기<\/button>/,
    );
    expect(CSS).toMatch(/\.ui-btn\.is-danger\[data-armed\] \{[^}]*border-color: var\(--st-fail\)/);
  });

  it('K2 — the first press arms, the second closes; 4 s without one disarms', () => {
    vi.useFakeTimers();
    const doAction = vi.fn();
    const refreshCard = vi.fn();
    const m = load<{ pressClose(k: string): void; isBusy(k: string, op: string): boolean }>(
      ['isBusy', 'setBusy', 'pressClose'],
      ['CLOSE_ARM_MS', '_closeArmTimer'],
      { _busy: Object.create(null), doAction, refreshCard },
    );
    m.pressClose(KEY);
    expect(doAction).not.toHaveBeenCalled();
    expect(m.isBusy(KEY, 'close-armed')).toBe(true);
    expect(refreshCard).toHaveBeenCalledWith(KEY);
    m.pressClose(KEY);
    expect(doAction).toHaveBeenCalledWith(KEY, 'close');
    expect(m.isBusy(KEY, 'close-armed')).toBe(false);
    // Armed again, and left: it disarms by itself.
    m.pressClose(KEY);
    expect(m.isBusy(KEY, 'close-armed')).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(m.isBusy(KEY, 'close-armed')).toBe(false);
    m.pressClose(KEY);
    expect(doAction).toHaveBeenCalledTimes(1);
  });
});

describe('T4 — 작업 계획 is off by default', () => {
  const ctx = { defaultModel: 'opus', defaultEffort: 'high', defaultChannelId: 'C1', autogoalDefault: false };
  const m = load<{ ntDefaultState(c: unknown, d: unknown): any; ntBuildPayload(s: any, a: any[], r: string): any }>(
    ['ntDefaultState', 'ntBuildPayload'],
    [],
  );

  it('P1 — a new task starts with the plan off; only an explicit on plans first', () => {
    const state = m.ntDefaultState(ctx, null);
    expect(state.plan).toBe(false);
    expect(m.ntBuildPayload({ ...state, destination: 'task', prompt: 'x' }, [], 'r')).toMatchObject({ plan: false });
    expect(m.ntBuildPayload({ ...state, prompt: 'x' }, [], 'r')).toMatchObject({ plan: false });
    // A state without the field (an older draft) is off too.
    const { plan: _drop, ...noPlan } = state;
    expect(m.ntBuildPayload({ ...noPlan, prompt: 'x', autogoal: true }, [], 'r')).toMatchObject({
      plan: false,
      autogoal: true,
    });
    expect(m.ntBuildPayload({ ...state, prompt: 'x', plan: true, autogoal: true }, [], 'r')).toMatchObject({
      plan: true,
      autogoal: false,
    });
  });

  it('P1 — the composer’s switch shows off unless turned on; autogoal / autoz lock only while it is on', () => {
    const data = (state: unknown) =>
      load<{ ntComposerData(): any }>(['ntComposerData', 'cmTriggersFor'], [], {
        _cmMenus: null,
        _ntState: state,
        _ntCtx: null,
        _ntValue: '',
        ntReadDraft: () => null,
        NT_NO_FILES: '',
        ntDictationUsable: () => false,
        ntSendNarrow: () => false,
        window: {},
      }).ntComposerData();
    expect(data({}).mode.on).toBe(false);
    expect(data(null).mode.on).toBe(false);
    expect(data({ plan: true }).mode.on).toBe(true);
    expect(clientFn('ntRender')).toContain('var planning = _ntState.plan === true;');
  });
});

describe('I1 — every Korean string the change shows has an English entry', () => {
  it.each(['닫는 중', '한 번 더 눌러 닫기'])('%s', (ko) => {
    expect(TEMPLATE).toContain(ko);
    expect(EN_PAGE[ko], ko).toBeTruthy();
  });
});

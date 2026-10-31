/**
 * re-context-window D5–D20 (.prd/affectui/re-context-window.md §4.2–4.10) —
 * the context block at the top of the panel's open 세션 정보 is @2lab.ai/ui
 * <ui-context-window>. The element owns the drawing and its own interaction:
 * the 216-cell field, the parts in prompt order, the auto-compact mark, the
 * level, the tray line and its live region, hover, the rolling figure, the
 * two-press confirm (Esc / focus leaving disarm), the done button's exit, the
 * warn contrast — pinned by the library's own suite (ui
 * src/components/context-window/context-window.test.ts: "cell math", "draws
 * 216 cells, the parts list and the mark row", "needs two presses within 4s to
 * emit ui-compact; Esc disarms", "disarms when focus leaves the armed button",
 * "lets the done button leave for 400 ms", "renders in place …", "says
 * “timeout” in the fail tone …", "keeps warn text at ≥4.5:1 in light …").
 * This suite pins the host contract: the slot, the card → data mapping, the
 * compactState machine, owner gating, and the request route.
 * Executes the shipped client code cut out of renderDashboardPage()'s template
 * literal, cooked exactly as the browser receives it (the harness of
 * dashboard-three-surfaces-client.test.ts).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UI_LIB_FILE, uiLibDistDir } from '../dashboard';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
function clientFn(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/** The page's chrome words (STRINGS), as served: the board's Korean words live there (D2 group 6). */
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const extraNames = extra.map((src) => /^function (\w+)/.exec(src)?.[1] ?? '').filter(Boolean);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${[...fns, ...extraNames].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The page's CSS as written in the template (the <style> block). */
const CSS = TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>')));
const HEAD = TEMPLATE.slice(0, TEMPLATE.indexOf('<style>'));

const NOW = 1_800_000_000_000;
/** The page's own non-owner reason (one constant: compact, the action buttons, the subtitle, a question card). */
const READ_ONLY = /^const READ_ONLY_MSG = '([^']*)';$/m.exec(TEMPLATE)?.[1] ?? '';
const CW_FNS = ['esc', 'escAttr', 'toNum', 'formatTokens', 'cwPhase', 'cwCanCompact', 'cwData', 'cwSlotHtml'];
const CW_VARS = ['CW_DONE_MS', 'CW_SAVED_MS', 'CW_FAIL_MS', 'CW_CEIL_MS', '_cw'];
const STATE = ['function cwTestState() { return _cw; }', 'function cwTestSet(o) { _cw = o; }'];
type CwState = Record<string, number | string | boolean>;
type CwData = {
  window: number;
  parts?: Record<string, number>;
  unsplit?: { tokens: number; kind: string };
  autoCompactAt?: number;
  model?: string;
  compactPending?: boolean;
  lastCompact?: { preTokens: number; postTokens: number };
  canCompact?: boolean | string;
  compactState?: string;
};
type Cw = {
  cwPhase(s: unknown, now: number): string;
  cwCanCompact(s: unknown): string;
  cwData(s: unknown, now: number): CwData | null;
  cwSlotHtml(s: unknown): string;
  cwTestState(): CwState;
  cwTestSet(o: CwState): void;
};
const ENV = {
  currentUserId: 'U1',
  READ_ONLY_MSG: READ_ONLY,
  isSiblingSession: (s: { environment?: { instanceName?: string } }) =>
    !!s.environment && s.environment.instanceName === 'other',
};
const cw = () => load<Cw>(CW_FNS, CW_VARS, ENV, STATE);
const freshState = (key = 'inst::C1:t1', extra: CwState = {}): CwState => ({
  key,
  gen: 1,
  count: 0,
  reqId: 0,
  req: '',
  reqAt: 0,
  obsInReq: false,
  queued: false,
  doneAt: 0,
  observedAt: 0,
  savedWait: 0,
  usedAtRise: 0,
  lcSeen: '',
  lcAtRise: '',
  savedAt: 0,
  failAt: 0,
  timedOutAt: 0,
  ...extra,
});

/** A live session: the last request read 412,000 tokens of a 1M window; compacts at 750K. */
const sess = (over: Record<string, unknown> = {}, parts: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  ownerId: 'U1',
  model: 'claude-opus-5-5[1m]',
  activityState: 'idle',
  compactionCount: 0,
  tokenUsage: { totalInputTokens: 900_000, contextUsagePercent: 41.2 },
  contextTokens: 412_000,
  autoCompactTokens: 750_000,
  contextParts: { window: 1_000_000, cacheRead: 354_320, cacheWrite: 16_480, input: 32_960, output: 8_240, ...parts },
  ...over,
});
/** cwData with the request state set first. */
const data = (over: Record<string, unknown> = {}, st?: CwState, now = NOW, parts: Record<string, unknown> = {}) => {
  const c = cw();
  if (st) c.cwTestSet(freshState('inst::C1:t1', st));
  return c.cwData(sess(over, parts), now) as CwData;
};

describe('D5 — the slot: <ui-context-window> first in the open 세션 정보, served from the dashboard origin', () => {
  it('a token wrapper keyed by the session and its start, the element in Korean, a light-DOM line until it loads', () => {
    const c = cw();
    c.cwTestSet(freshState('inst::C1:t1', { gen: 7 }));
    expect(c.cwSlotHtml(sess())).toBe(
      '<div class="ui-tok cw-slot" data-mk="cw|inst::C1:t1|7"><ui-context-window lang="ko" data-cw-key="inst::C1:t1">' +
        '<span class="cw-fallback">컨텍스트 412.0K / 1.0M 토큰</span></ui-context-window></div>',
    );
  });

  it('no window on the card (archived, no usage): no block', () => {
    expect(cw().cwSlotHtml(sess({ contextParts: undefined }))).toBe('');
    expect(cw().cwSlotHtml(sess({}, { window: 0 }))).toBe('');
    expect(cw().cwData(sess({ contextParts: undefined }), NOW)).toBeNull();
  });

  it('panelInfoHtml opens the body with the slot from one call; the old bar line is gone (D18)', () => {
    const src = clientFn('panelInfoHtml');
    expect(src).toContain(`'<div class="pi-body" id="panel-info-body">' + cwSlotHtml(s) + body`);
    expect(src.split('cwSlotHtml(').length - 1).toBe(1);
    expect(src).not.toContain('context-bar');
    expect(src).not.toContain('pi-ctx');
    expect(CSS).not.toContain('.pi-ctx');
  });

  it('renderPanelInfo observes the session, writes 세션 정보, then hands the element its data', () => {
    const src = clientFn('renderPanelInfo');
    const at = (n: string) => src.indexOf(n);
    expect(at('if (s) cwObserve(s, now);')).toBeGreaterThan(0);
    expect(
      at(
        "writePanelPart(el, s ? panelInfoHtml(s, _panelInfoOpen === true, sessionColOf(panelSessionKey), _panelInfoOpen === 'folding') : '');",
      ),
    ).toBeGreaterThan(at('cwObserve('));
    expect(at("if (s) cwPaint(el.querySelector('ui-context-window'), s, now);")).toBeGreaterThan(at('writePanelPart('));
  });

  it('the page loads the element as a module script; the installed package carries it and its chunks', () => {
    expect(HEAD).toContain(
      `<script type="module" src="/dashboard/ui/context-window.js?v=\${UI_LIB_VERSION}"></script>`,
    );
    const dir = uiLibDistDir();
    expect(dir).toBeTruthy();
    expect(existsSync(join(dir as string, 'context-window.js'))).toBe(true);
    const imports =
      readFileSync(join(dir as string, 'context-window.js'), 'utf-8').match(/from\s*"\.\/([^"]+)"/g) ?? [];
    for (const imp of imports) {
      const file = /"\.\/([^"]+)"/.exec(imp)?.[1] as string;
      expect(UI_LIB_FILE.test(file), file).toBe(true);
      expect(existsSync(join(dir as string, file)), file).toBe(true);
    }
  });

  it('the inline renderer, its CSS and its hover/arming code are gone (the element owns them)', () => {
    for (const gone of [
      'contextBlockHtml',
      'cwShort',
      'cwParts',
      'cwCells',
      'cwMarkIndex',
      'cwSay',
      'cwCompactHtml',
      'cwRoll',
      'cwApply',
      'cwBind',
    ])
      expect(declarationCount(gone), gone).toBe(0);
    for (const gone of [
      'CW_CELLS',
      'CW_ROLL_MS',
      'CW_ARM_MS',
      'CW_LEAVE_MS',
      'CW_PARTS',
      'CW_ANNOUNCE',
      '_cwHot',
      '_cwRoll',
    ])
      expect(TEMPLATE, gone).not.toContain(gone);
    for (const gone of ['.cw {', '.cw-field', '.cw-cell', '.cw-compact', '.cw-say', '@keyframes cw-'])
      expect(CSS, gone).not.toContain(gone);
    // The panel's measure: the element sits at most 560px wide.
    expect(CSS).toContain('.cw-slot > ui-context-window { display: block; max-width: 560px; }');
  });
});

describe('D1–D7 — the card’s context as the element’s data', () => {
  it('the window, the four parts in prompt order, the auto-compact point, the model without claude- and its date', () => {
    expect(data({ model: 'claude-opus-4-5-20251101' })).toEqual({
      window: 1_000_000,
      parts: { cacheRead: 354_320, cacheWrite: 16_480, input: 32_960, output: 8_240 },
      autoCompactAt: 750_000,
      model: 'opus-4-5',
      compactState: 'idle',
      canCompact: true,
    });
    expect(Object.keys(data().parts ?? {})).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
    expect(data().model).toBe('opus-5-5[1m]');
  });

  it('an unknown model and an unknown point are left out; a scheduled compact is passed on', () => {
    const d = data({ model: 'unknown', autoCompactTokens: 0, compactPending: true });
    expect(d).not.toHaveProperty('model');
    expect(d).not.toHaveProperty('autoCompactAt');
    expect(d.compactPending).toBe(true);
    expect(data()).not.toHaveProperty('compactPending');
  });

  it('D6 — one unsplit total is one part said as what it is, never as a cache category', () => {
    const unsplit = { cacheRead: 0, cacheWrite: 0, input: 64_000, output: 0 };
    const compacted = data({ contextTokens: 64_000 }, undefined, NOW, { ...unsplit, unsplit: 'compact' });
    expect(compacted.unsplit).toEqual({ tokens: 64_000, kind: 'compact' });
    expect(compacted).not.toHaveProperty('parts');
    expect(data({}, undefined, NOW, { ...unsplit, unsplit: 'unknown' }).unsplit).toEqual({
      tokens: 64_000,
      kind: 'unknown',
    });
    expect(data({}, undefined, NOW, { ...unsplit, unsplit: 'odd' }).unsplit?.kind).toBe('unknown');
  });
});

describe('D10/D12 — compactState: one state, the most urgent first', () => {
  it('sending; sent; queued behind a running turn', () => {
    expect(data({}, { req: 'sending', reqAt: NOW - 10 }).compactState).toBe('sending');
    expect(data({}, { req: 'sent', reqAt: NOW - 10 }).compactState).toBe('sent');
    expect(data({}, { req: 'sent', reqAt: NOW - 10, queued: true }).compactState).toBe('queued');
  });

  it('failed and timeout for 4s each (fail tone in the element), then back to idle', () => {
    expect(data({}, { req: 'failed', failAt: NOW - 3_999 }).compactState).toBe('failed');
    expect(data({}, { req: 'failed', failAt: NOW - 4_000 }).compactState).toBe('idle');
    expect(data({}, { timedOutAt: NOW - 100 }).compactState).toBe('timeout');
    expect(data({}, { timedOutAt: NOW - 4_000 }).compactState).toBe('idle');
    // A failure outranks a compaction seen meanwhile, as the tray said it.
    expect(data({}, { failAt: NOW - 100, observedAt: NOW - 100, savedWait: NOW - 100 }).compactState).toBe('failed');
  });

  it('observed: this request done (1.5s), a count rise still waiting for its counts, or within 3.2s of it', () => {
    expect(data({}, { doneAt: NOW - 1_499 }).compactState).toBe('observed');
    expect(data({}, { savedWait: NOW - 60_000 }).compactState).toBe('observed');
    expect(data({}, { observedAt: NOW - 3_199 }).compactState).toBe('observed');
    expect(data({}, { observedAt: NOW - 3_200 }).compactState).toBe('idle');
    // Another session's state never shows here.
    const c = cw();
    c.cwTestSet(freshState('other', { req: 'sending', reqAt: NOW - 10 }));
    expect(c.cwData(sess(), NOW)?.compactState).toBe('idle');
  });

  it('the saving: lastCompact only once THAT compaction’s counts arrived (savedAt), for 3.2s', () => {
    const lastCompact = { preTokens: 812_000, postTokens: 64_000, trigger: 'manual' };
    const saved = data({ lastCompact, contextTokens: 64_000 }, { savedAt: NOW - 100 }, NOW, { cacheRead: 40_000 });
    expect(saved.compactState).toBe('observed');
    expect(saved.lastCompact).toEqual({ preTokens: 812_000, postTokens: 64_000 });
    // Counts already on the card (an earlier compaction's) are not this saving.
    expect(data({ lastCompact }, { observedAt: NOW - 100, savedWait: NOW - 100 })).not.toHaveProperty('lastCompact');
    expect(data({ lastCompact }, { savedAt: NOW - 3_300, observedAt: NOW - 3_400 })).toMatchObject({
      compactState: 'idle',
    });
    expect(data({ lastCompact }, { savedAt: NOW - 3_300 })).not.toHaveProperty('lastCompact');
  });

  it('phase: sending, sent, done for 1.5s — arming is the element’s (no host state for it)', () => {
    const c = cw();
    const s = sess();
    expect(c.cwPhase(s, NOW)).toBe('idle');
    c.cwTestSet(freshState('inst::C1:t1', { req: 'sending', reqAt: NOW - 10 }));
    expect(c.cwPhase(s, NOW)).toBe('sending');
    c.cwTestSet(freshState('inst::C1:t1', { req: 'sent', reqAt: NOW - 10 }));
    expect(c.cwPhase(s, NOW)).toBe('sent');
    c.cwTestSet(freshState('inst::C1:t1', { doneAt: NOW - 1_499 }));
    expect(c.cwPhase(s, NOW)).toBe('done');
    c.cwTestSet(freshState('inst::C1:t1', { doneAt: NOW - 1_500 }));
    expect(c.cwPhase(s, NOW)).toBe('idle');
    expect(TEMPLATE).not.toContain('armedAt');
  });
});

describe('D12 — 지금 압축: owner-gated (canCompact), confirmed by the element, sent as `compact --yes`', () => {
  it('the owner may: true', () => {
    expect(data().canCompact).toBe(true);
  });

  // #547 review P3: the element's title says the reason — in Korean, like every other reason here.
  it('the non-owner reason is Korean like the others, and the one constant every surface uses', () => {
    expect(READ_ONLY).toBe('읽기 전용 — 내 세션이 아닙니다');
    expect(data({ ownerId: 'U2' }).canCompact).toBe('읽기 전용 — 내 세션이 아닙니다');
    // The question card's lock says the same through the same constant (no second copy of the words).
    expect(clientFn('acQuestionLock')).toContain(': READ_ONLY_MSG;');
    expect(TEMPLATE.split('읽기 전용 — 내 세션이 아닙니다').length - 1).toBe(1);
    expect(TEMPLATE).not.toContain('Read-only — not your session');
  });

  it('disabled with the reason: not the owner (fails closed), another instance, a switch waiting on a compact, a compact already scheduled', () => {
    expect(data({ ownerId: 'U2' }).canCompact).toBe(READ_ONLY);
    expect(data({ ownerId: undefined }).canCompact).toBe(READ_ONLY);
    expect(data({ environment: { instanceName: 'other', host: 'h', port: 1 } }).canCompact).toBe(
      'Open other (h:1) to act on this session',
    );
    expect(data({ pendingModel: 'fable[1m]' }).canCompact).toBe('모델 전환이 압축을 기다리는 중');
    expect(data({ compactPending: true }).canCompact).toBe('다음 입력 때 자동 압축됩니다');
  });

  it('no action: a closed or sleeping session, a compaction observed that is not this request’s, nothing added since the last one', () => {
    expect(data({ terminated: true }).canCompact).toBe(false);
    // PR review R1 (P2): a sleeping session is closed, as for the composer — pressing would wake it.
    expect(data({ sessionState: 'SLEEPING', activityState: 'sleeping' }).canCompact).toBe(false);
    expect(data({ terminated: true }, { req: 'sent', reqAt: NOW - 10 }).canCompact).toBe(false);
    // An auto / Slack compaction: the tray says it was observed, no button claims it.
    expect(data({}, { observedAt: NOW - 100, savedWait: NOW - 100 })).toMatchObject({
      compactState: 'observed',
      canCompact: false,
    });
    const lastCompact = { preTokens: 812_000, postTokens: 64_000 };
    const small = { cacheRead: 40_000, cacheWrite: 0, input: 24_000, output: 0 };
    expect(data({ lastCompact }, undefined, NOW, small).canCompact).toBe(false);
    expect(data({ lastCompact }, undefined, NOW, { ...small, input: 50_000 }).canCompact).toBe(true);
    // Its counts still on the way (savedWait) after a failed request: still no action.
    expect(data({}, { failAt: NOW - 100, savedWait: NOW - 100 }).canCompact).toBe(false);
  });

  it('while the request runs and its ✓ shows: true (busy and done carry no reason tooltip)', () => {
    expect(data({ compactPending: true }, { req: 'sending', reqAt: NOW - 10 }).canCompact).toBe(true);
    expect(data({ ownerId: 'U2' }, { req: 'sent', reqAt: NOW - 10 }).canCompact).toBe(true);
    expect(data({}, { doneAt: NOW - 100, observedAt: NOW - 100, savedWait: NOW - 100 })).toMatchObject({
      compactState: 'observed',
      canCompact: true,
    });
  });

  it('after the ✓ (1.5s) the action goes — the element plays its 400ms exit (library: "lets the done button leave")', () => {
    const st = { doneAt: NOW - 1_600, observedAt: NOW - 1_600, savedWait: NOW - 1_600 };
    expect(data({}, st)).toMatchObject({ compactState: 'observed', canCompact: false });
    expect(clientFn('cwObserve')).not.toContain('CW_DONE_MS + ');
  });

  type Flow = {
    cwCompact(): Promise<void>;
    cwObserve(s: unknown, now: number): void;
    cwTestState(): CwState;
    cwTestSet(o: CwState): void;
  };
  type Res = { ok: boolean; status: number };
  function flow(responses: (Res | Promise<Res>)[], over: Record<string, unknown> = {}) {
    const fetchSpy = vi.fn(async () => (await responses.shift()) ?? { ok: true, status: 200 });
    const render = vi.fn();
    const refresh = vi.fn(async () => {});
    const later = vi.fn();
    const s = sess(over);
    const c = load<Flow>(
      ['toNum', 'cwCanCompact', 'cwObserve', 'cwCompact'],
      ['_cw', '_cwSeq', '_cwCeil', 'CW_DONE_MS', 'CW_SAVED_MS', 'CW_FAIL_MS', 'CW_CEIL_MS'],
      {
        panelSessionKey: s.key,
        _sessionCache: { [s.key]: s },
        currentUserId: 'U1',
        READ_ONLY_MSG: READ_ONLY,
        isSiblingSession: () => false,
        fetch: fetchSpy,
        _csrfToken: 'tok',
        refreshCsrfToken: refresh,
        renderPanelInfo: render,
        cwLater: later,
      },
      STATE,
    );
    return { c, fetchSpy, render, refresh, later, s };
  }
  const deferred = () => {
    let resolve: (r: Res) => void = () => {};
    const p = new Promise<Res>((r) => {
      resolve = r;
    });
    return { p, resolve };
  };

  it('ui-compact (the element’s second press) sends compact --yes to the owner-gated command route', async () => {
    const { c, fetchSpy, later, render } = flow([{ ok: true, status: 200 }]);
    await c.cwCompact();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/dashboard/session/inst%3A%3AC1%3At1/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' },
      body: '{"message":"compact --yes"}',
    });
    // Taken by the server: sent (not "compacted"); the 5-minute ceiling is armed.
    expect(c.cwTestState().req).toBe('sent');
    expect(Number(c.cwTestState().reqId)).toBeGreaterThan(0);
    expect(c.cwTestState().queued).toBe(false);
    expect(later).toHaveBeenCalledWith(300_000);
    expect(render).toHaveBeenCalledTimes(2);
  });

  // #547 review P3: each request armed a 5-minute repaint and none was ever cancelled.
  it('one 5-minute ceiling per request: a new request lets the previous one’s timer go', async () => {
    const timers = new Map<number, number>();
    let next = 0;
    const cleared: number[] = [];
    const s = sess();
    const c = load<Flow>(
      ['toNum', 'cwCanCompact', 'cwObserve', 'cwLater', 'cwCompact'],
      ['_cw', '_cwSeq', '_cwCeil', 'CW_DONE_MS', 'CW_SAVED_MS', 'CW_FAIL_MS', 'CW_CEIL_MS'],
      {
        panelSessionKey: s.key,
        panelOpen: true,
        _sessionCache: { [s.key]: s },
        currentUserId: 'U1',
        READ_ONLY_MSG: READ_ONLY,
        isSiblingSession: () => false,
        fetch: async () => ({ ok: false, status: 500 }),
        _csrfToken: 'tok',
        refreshCsrfToken: async () => {},
        renderPanelInfo: () => {},
        setTimeout: (_fn: () => void, ms: number) => {
          timers.set(++next, ms);
          return next;
        },
        clearTimeout: (id: number) => {
          cleared.push(id);
          timers.delete(id);
        },
      },
      STATE,
    );
    const ceilings = () => [...timers.values()].filter((ms) => ms === 300_020).length;
    await c.cwCompact(); // fails: the button is back at once for the next press
    expect(c.cwTestState().req).toBe('failed');
    expect(ceilings()).toBe(1);
    await c.cwCompact();
    await c.cwCompact();
    expect(Number(c.cwTestState().reqId)).toBe(3);
    // Three requests, one ceiling left: each new one cancelled the one before it.
    expect(ceilings()).toBe(1);
    expect(cleared.filter((id) => id > 0)).toHaveLength(2); // (the first request had none to clear)
  });

  it('gating is checked again at press time: a non-owner, a sleeping session or a request in flight sends nothing', async () => {
    for (const over of [{ ownerId: 'U2' }, { sessionState: 'SLEEPING', activityState: 'sleeping' }]) {
      const f = flow([{ ok: true, status: 200 }], over);
      await f.c.cwCompact();
      expect(f.fetchSpy).not.toHaveBeenCalled();
    }
    const d = deferred();
    const busy = flow([d.p]);
    const first = busy.c.cwCompact();
    await busy.c.cwCompact();
    expect(busy.fetchSpy).toHaveBeenCalledTimes(1);
    d.resolve({ ok: true, status: 200 });
    await first;
  });

  it('a turn that holds the slot queues the request — running or waiting on a permission prompt', async () => {
    for (const activityState of ['working', 'waiting']) {
      const { c } = flow([{ ok: true, status: 200 }], { activityState });
      await c.cwCompact();
      expect(c.cwTestState().queued, activityState).toBe(true);
    }
  });

  it('a 403 refreshes the CSRF token and retries once; a failure ends the busy state for 4s', async () => {
    const a = flow([
      { ok: false, status: 403 },
      { ok: true, status: 200 },
    ]);
    await a.c.cwCompact();
    expect(a.refresh).toHaveBeenCalledTimes(1);
    expect(a.fetchSpy).toHaveBeenCalledTimes(2);
    expect(a.c.cwTestState().req).toBe('sent');
    const b = flow([{ ok: false, status: 500 }]);
    await b.c.cwCompact();
    expect(b.c.cwTestState().req).toBe('failed');
    expect(Number(b.c.cwTestState().failAt)).toBeGreaterThan(0);
    expect(b.later).toHaveBeenCalledWith(4000);
    const thrown = flow([Promise.reject(new Error('offline'))]);
    await thrown.c.cwCompact();
    expect(thrown.c.cwTestState().req).toBe('failed');
  });

  // PR review R1 (astra P1): the request's own outcome is kept apart from what was observed,
  // and an answer only ever updates the request it belongs to.
  it('a compaction seen while the request is in flight never hides that request failing', async () => {
    const d = deferred();
    const { c, s } = flow([d.p]);
    const sending = c.cwCompact();
    expect(c.cwTestState().req).toBe('sending');
    c.cwObserve({ ...s, compactionCount: 1 }, Date.now());
    expect(c.cwTestState()).toMatchObject({ req: 'sending', obsInReq: true });
    d.resolve({ ok: false, status: 500 });
    await sending;
    expect(c.cwTestState().req).toBe('failed');
    expect(Number(c.cwTestState().failAt)).toBeGreaterThan(0);
    // The same race with a request the server took: done, nothing left waiting.
    const e = deferred();
    const ok = flow([e.p]);
    const sent = ok.c.cwCompact();
    ok.c.cwObserve({ ...ok.s, compactionCount: 1 }, Date.now());
    e.resolve({ ok: true, status: 200 });
    await sent;
    expect(ok.c.cwTestState().req).toBe('');
    expect(Number(ok.c.cwTestState().doneAt)).toBeGreaterThan(0);
    expect(ok.later).toHaveBeenCalledWith(1500);
  });

  it('A → B → A: the first request’s late failure leaves the new request alone, and the new answer lands', async () => {
    const first = deferred();
    const second = deferred();
    const { c, s } = flow([first.p, second.p]);
    const old = c.cwCompact();
    c.cwObserve({ ...s, key: 'inst::C2:t2' }, Date.now());
    c.cwObserve(s, Date.now());
    expect(c.cwTestState()).toMatchObject({ key: s.key, req: '', reqId: 0 });
    const fresh = c.cwCompact();
    const id = c.cwTestState().reqId;
    first.resolve({ ok: false, status: 500 });
    await old;
    expect(c.cwTestState()).toMatchObject({ reqId: id, req: 'sending', failAt: 0 });
    second.resolve({ ok: true, status: 200 });
    await fresh;
    expect(c.cwTestState()).toMatchObject({ reqId: id, req: 'sent' });
  });

  // Trinity R1 (P1): the card carries no correlation between the request and a
  // compaction — a count rise is "a compaction was observed", and its saving is
  // shown only from THAT compaction's own counts.
  const observer = () =>
    load<Cw & { cwObserve(s: unknown, now: number): void }>(
      [...CW_FNS, 'cwObserve'],
      CW_VARS,
      { ...ENV, cwLater: () => {} },
      STATE,
    );
  const OLD = { preTokens: 500_000, postTokens: 40_000 };
  const NEW = { preTokens: 812_000, postTokens: 64_000 };

  it('(1) an unrelated compaction lands first: observed, not claimed; its old counts are not this saving', () => {
    const c = observer();
    c.cwTestSet(
      freshState('inst::C1:t1', { count: 2, req: 'sent', reqAt: NOW - 5_000, queued: true, lcSeen: '500000/40000' }),
    );
    const rose = sess({ compactionCount: 3, lastCompact: OLD });
    c.cwObserve(rose, NOW);
    expect(c.cwTestState()).toMatchObject({
      count: 3,
      req: '',
      doneAt: NOW,
      observedAt: NOW,
      savedWait: NOW,
      savedAt: 0,
    });
    const d = c.cwData(rose, NOW) as CwData;
    expect(d).toMatchObject({ compactState: 'observed', canCompact: true });
    expect(d).not.toHaveProperty('lastCompact');
  });

  it('(2) the count arrives before the counts: observed, no saving yet', () => {
    const c = observer();
    c.cwTestSet(freshState('inst::C1:t1', { count: 2, req: 'sent', reqAt: NOW - 5_000 }));
    const rose = sess({ compactionCount: 3 });
    c.cwObserve(rose, NOW);
    expect(c.cwTestState()).toMatchObject({ req: '', savedWait: NOW, savedAt: 0 });
    expect(c.cwData(rose, NOW + 100)).toMatchObject({ compactState: 'observed' });
    expect(c.cwData(rose, NOW + 100)).not.toHaveProperty('lastCompact');
  });

  it('(3) the counts arrive later: the data then carries what that compaction saved', () => {
    const c = observer();
    c.cwTestSet(freshState('inst::C1:t1', { count: 2, req: 'sent', reqAt: NOW - 5_000, lcSeen: '500000/40000' }));
    c.cwObserve(sess({ compactionCount: 3, lastCompact: OLD }), NOW);
    const later = sess({ compactionCount: 3, lastCompact: NEW, contextTokens: 64_000 });
    c.cwObserve(later, NOW + 800);
    expect(c.cwTestState()).toMatchObject({ savedWait: 0, savedAt: NOW + 800 });
    expect(c.cwData(later, NOW + 900)).toMatchObject({ compactState: 'observed', lastCompact: NEW });
    // Missing counts never hang the line: the next context sample ends the wait.
    const d = observer();
    d.cwTestSet(freshState('inst::C1:t1', { count: 2, usedAtRise: 0 }));
    d.cwObserve(sess({ compactionCount: 3 }), NOW);
    d.cwObserve(sess({ compactionCount: 3, contextTokens: 70_000 }), NOW + 900);
    expect(d.cwTestState()).toMatchObject({ savedWait: 0, savedAt: 0 });
  });

  it('a request never answered ends at the 5-minute ceiling: timeout', () => {
    const c = observer();
    c.cwTestSet(freshState('inst::C1:t1', { count: 3, req: 'sent', reqAt: NOW - 300_000 }));
    c.cwObserve(sess({ compactionCount: 3 }), NOW);
    expect(c.cwTestState()).toMatchObject({ req: '', timedOutAt: NOW });
    expect(c.cwData(sess({ compactionCount: 3 }), NOW + 100)).toMatchObject({
      compactState: 'timeout',
      canCompact: true,
    });
  });

  it('another session or /new · /renew (the count goes down): everything starts over on a fresh element (new gen)', () => {
    const c = observer();
    c.cwTestSet(
      freshState('inst::C1:t1', { gen: 4, count: 3, req: 'sent', reqAt: NOW - 1_000, lcSeen: '812000/64000' }),
    );
    c.cwObserve(sess({ compactionCount: 0, contextTokens: 20_000 }), NOW);
    expect(c.cwTestState()).toMatchObject({ gen: 5, count: 0, req: '', reqId: 0, lcSeen: '' });
    expect(c.cwSlotHtml(sess())).toContain('data-mk="cw|inst::C1:t1|5"');
    const rose = sess({ compactionCount: 1, contextTokens: 20_000 });
    c.cwObserve(rose, NOW + 100);
    expect(c.cwTestState()).toMatchObject({ gen: 5, count: 1, observedAt: NOW + 100, timedOutAt: 0 });
    expect(c.cwData(rose, NOW + 200)).toMatchObject({ compactState: 'observed' });
    c.cwObserve(sess({ key: 'inst::C2:t2' }), NOW + 300);
    expect(c.cwTestState()).toMatchObject({ key: 'inst::C2:t2', gen: 6 });
  });
});

describe('the host glue: paint where the data changed; ui-compact only from the panel session’s element', () => {
  it('cwPaint sets data once per change; no element or no window writes nothing', () => {
    const c = load<{ cwPaint(el: unknown, s: unknown, now: number): void }>([...CW_FNS, 'cwPaint'], CW_VARS, ENV);
    let sets = 0;
    const el = new (class {
      _cwSig?: string;
      #d?: CwData;
      set data(v: CwData | undefined) {
        sets++;
        this.#d = v;
      }
      get data(): CwData | undefined {
        return this.#d;
      }
    })();
    c.cwPaint(el, sess(), NOW);
    c.cwPaint(el, sess(), NOW + 50);
    expect(sets).toBe(1);
    expect(el.data?.window).toBe(1_000_000);
    c.cwPaint(el, sess({ contextTokens: 420_000 }, { output: 16_240 }), NOW + 100);
    expect(sets).toBe(2);
    expect(el.data?.parts?.output).toBe(16_240);
    c.cwPaint(null, sess(), NOW);
    c.cwPaint(el, sess({ contextParts: undefined }), NOW);
    expect(sets).toBe(2);
  });

  it('the document listener sends only for the panel session’s own <ui-context-window>', () => {
    const start = TEMPLATE.indexOf("\ndocument.addEventListener('ui-compact',");
    expect(start).toBeGreaterThan(0);
    const src = cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n});\n', start) + 4));
    let handler: (e: unknown) => void = () => {};
    const compact = vi.fn();
    const doc = {
      addEventListener: (_n: string, h: (e: unknown) => void) => {
        handler = h;
      },
    };
    new Function('document', 'panelSessionKey', 'cwCompact', src)(doc, 'inst::C1:t1', compact);
    const target = (tag: string, key: string) => ({ target: { tagName: tag, getAttribute: () => key } });
    handler(target('UI-COMPACT-BREAKDOWN', 'inst::C1:t1'));
    handler(target('UI-CONTEXT-WINDOW', 'inst::C2:t2'));
    handler({ target: null });
    expect(compact).not.toHaveBeenCalled();
    handler(target('UI-CONTEXT-WINDOW', 'inst::C1:t1'));
    expect(compact).toHaveBeenCalledTimes(1);
  });
});

describe('D8/D9 — the level against the auto-compact point (face and summary; the element measures the same)', () => {
  const lv = () =>
    load<{ ctxLevel(pct: unknown, used?: unknown, auto?: unknown, pending?: unknown): string }>(
      ['toNum', 'ctxLevel'],
      [],
    );
  it('ctxLevel keeps the 1-argument window bands exactly', () => {
    const c = lv();
    expect(c.ctxLevel(12)).toBe('');
    expect(c.ctxLevel(61)).toBe('ctx-warn');
    expect(c.ctxLevel(81)).toBe('ctx-danger');
    expect(c.ctxLevel('x')).toBe('');
  });

  it('with the auto-compact point: warn from 0.8 of it, full from 0.95, a scheduled compact is full', () => {
    const c = lv();
    expect(c.ctxLevel(41, 599_999, 750_000)).toBe('');
    expect(c.ctxLevel(41, 600_000, 750_000)).toBe('ctx-warn');
    expect(c.ctxLevel(71, 712_499, 750_000)).toBe('ctx-warn');
    expect(c.ctxLevel(71, 712_500, 750_000)).toBe('ctx-danger');
    // conv-run2 of the preview: 76% of the window but 475% of its 160K point.
    expect(c.ctxLevel(76, 760_000, 160_000)).toBe('ctx-danger');
    expect(c.ctxLevel(10, 100_000, 750_000, true)).toBe('ctx-danger');
    // Point unknown: the window bands.
    expect(c.ctxLevel(70, 700_000, 0)).toBe('ctx-warn');
  });

  it('the summary’s amber ctx % has a dark and a light value; the light one is the 4.5:1 yellow', () => {
    expect(CSS.match(/--cw-warn:/g)?.length).toBe(2);
    expect(CSS).toContain(':root { --cw-warn: var(--st-wait); }');
    expect(CSS).toContain('[data-theme="light"] { --cw-warn: var(--yellow); }');
    expect(CSS).toContain('.pi-cs.ctx-warn { color: var(--cw-warn); }');
  });
});

// The face's ctx metric (D16) — the face is <ui-agent-inbox>'s; the board's card mapper (cardOf) hands it the
// level (contextLevel) and the tooltip (titles.context), the element rounds and caps the % it draws.
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
const CARD_OF_VARS = [
  'PR_STATE_LABEL',
  'PR_STATE_TONE',
  'AGENT_STATUS_LABEL',
  'AGENT_STATUS_TONE',
  'AGENT_STATUS_GLYPH',
  'OWNER_BADGE_HUES',
];
const CARD_ENV = {
  dhShow: () => true,
  dhTruncate: () => null,
  currentUserId: 'U1',
  _ownerIndex: null,
  SELF_INSTANCE_NAME: '',
};

describe('D16 — the face ctx metric and the summary line use the same level and say the distance', () => {
  const face = load<{ cardOf(s: unknown, col: string): Record<string, unknown> & { titles?: { context?: string } } }>(
    CARD_OF_FNS,
    CARD_OF_VARS,
    CARD_ENV,
  );
  const card = (over: Record<string, unknown>) => ({
    key: 'inst::C1:t1',
    displayHeadline: 'Context',
    ownerId: 'U1',
    activityState: 'idle',
    activeAccumulatedMs: 0,
    lastActivity: '2026-10-26T10:00:00.000Z',
    autoCompactTokens: 750_000,
    ...over,
  });
  const ctx = (pct: number, used?: number, extra: Record<string, unknown> = {}) => {
    const c = face.cardOf(
      card({ tokenUsage: { totalInputTokens: 1, contextUsagePercent: pct }, contextTokens: used, ...extra }),
      'idle',
    );
    return [c.contextLevel, c.titles?.context];
  };

  it('point known: the level against it, the tooltip says how far', () => {
    expect(ctx(41.2, 412_000)).toEqual(['', '컨텍스트 41% · 자동 압축 750K까지 338K']);
    expect(ctx(62, 620_000)).toEqual(['warn', '컨텍스트 62% · 자동 압축 750K까지 130K']);
    expect(ctx(72, 720_000)).toEqual(['danger', '컨텍스트 72% · 자동 압축 750K까지 30K']);
    expect(ctx(76, 760_000, { compactPending: true })).toEqual(['danger', '컨텍스트 76% · 다음 입력 때 자동 압축']);
    expect(ctx(80, 800_000)[1]).toBe('컨텍스트 80% · 자동 압축 지점을 넘음');
  });

  it('point unknown: the window bands and the old words, unchanged', () => {
    expect(ctx(65)).toEqual(['warn', 'Context window used']);
    expect(ctx(90)).toEqual(['danger', 'Context window used — 80% 넘게 찼다']);
    // PR review R1 (P3): the "over 80%" words follow the number, not the level (a scheduled compact is danger at 50%).
    expect(ctx(50, undefined, { compactPending: true, autoCompactTokens: 0 })).toEqual([
      'danger',
      'Context window used',
    ]);
  });

  it('one percent everywhere (PR review R1 P2): face, 세션 정보 summary and the block pill round and cap at 100', () => {
    // The block's pill is <ui-context-window>'s: Σparts / window (the server's contextUsagePercent formula), rounded, capped.
    // The face's % is <ui-agent-inbox>'s: Math.round(Math.min(contextPct, 100)) — the same rule (ctxPercent).
    for (const fn of ['cardCtxTitle', 'panelInfoHtml']) expect(clientFn(fn), fn).toContain('ctxPercent(');
    expect(ctx(104.6, 1_000_000, { autoCompactTokens: 900_000 })[1]).toBe('컨텍스트 100% · 자동 압축 지점을 넘음');
    const info = load<{ panelInfoHtml(s: unknown, open: boolean): string }>(
      [
        ...CW_FNS,
        'ctxLevel',
        'ctxPercent',
        'pendingAutoResume',
        'rootStatusOf',
        'elapsedHtml',
        'activeTimeHtml',
        'agoHtml',
        'panelDetailsHtml',
        'panelInfoHtml',
      ],
      [...CW_VARS],
      { ...ENV, formatNmSSs: (n: number) => `${n}ms`, cardTotalTokens: () => 1, safeHref: (u: string) => u },
    ).panelInfoHtml;
    const over = sess({ tokenUsage: { totalInputTokens: 1, contextUsagePercent: 104.6 }, lastActivity: NOW });
    expect(info(over, false)).toContain('>ctx 100%</span>');
    expect(info(over, true)).toContain('<ui-context-window lang="ko"');
  });

  it('세션 정보 summary: ctx N% carries the same class; the open grid says the totals are cumulative (D17)', () => {
    const info = load<{ panelInfoHtml(s: unknown, open: boolean): string }>(
      [
        ...CW_FNS,
        'ctxLevel',
        'ctxPercent',
        'pendingAutoResume',
        'rootStatusOf',
        'elapsedHtml',
        'activeTimeHtml',
        'agoHtml',
        'panelDetailsHtml',
        'panelInfoHtml',
      ],
      [...CW_VARS],
      { ...ENV, formatNmSSs: (n: number) => `${n}ms`, cardTotalTokens: () => 1, safeHref: (u: string) => u },
    ).panelInfoHtml;
    const s = sess({
      contextTokens: 620_000,
      tokenUsage: { totalInputTokens: 1, contextUsagePercent: 62 },
      lastActivity: NOW,
    });
    expect(info(s, false)).toContain('<span class="pi-cs ctx-warn">ctx 62%</span>');
    const open = info(s, true);
    const body = open.slice(open.indexOf('class="pi-body"'));
    expect(body.indexOf('<div class="ui-tok cw-slot"')).toBeGreaterThan(0);
    expect(body.indexOf('<div class="ui-tok cw-slot"')).toBeLessThan(body.indexOf('class="ui-dl pi-grid"'));
    for (const label of ['누적 입력', '누적 출력', '누적 캐시 읽기', '누적 캐시 쓰기'])
      expect(body).toContain(`<dt>${label}</dt>`);
  });
});

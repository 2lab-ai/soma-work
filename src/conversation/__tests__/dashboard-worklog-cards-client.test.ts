/**
 * 작업 로그 — a tool call and its result as one @2lab.ai/ui <ui-tool-call-card>.
 * Executes the shipped client code (cut out of renderDashboardPage()'s template
 * literal and cooked as the browser receives it — the harness of
 * dashboard-agent-inbox-client.test.ts) plus the server half (the same-origin
 * route that serves the library build).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_LIB_FILE, uiLibDistDir } from '../dashboard';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (plain < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', plain);
  return cook(TEMPLATE.slice(plain + 1, end + 2));
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

type Entry = Record<string, unknown> & { seq: number };
type Pairs = { resultOf: Record<number, Entry>; callOf: Record<number, number> };
const PAIR_FNS = ['wlPairKey', 'wlPairTools', 'wlPairsOf', 'wlCardHidden', 'wlVisible'];

describe('pairing a result with its call (shipped wlPairTools)', () => {
  const { wlPairTools } = load<{ wlPairTools(e: Entry[]): Pairs }>(PAIR_FNS, []);

  it('pairs by the SDK tool-use id — parallel calls whose results come back in another order', () => {
    const p = wlPairTools([
      { seq: 1, kind: 'tool', tool: 'Read', toolUseId: 'a' },
      { seq: 2, kind: 'tool', tool: 'Read', toolUseId: 'b' },
      { seq: 3, kind: 'tool_result', tool: 'Read', toolUseId: 'b', ok: true },
      { seq: 4, kind: 'tool_result', tool: 'Read', toolUseId: 'a', ok: false },
    ]);
    expect(p.resultOf[1].seq).toBe(4);
    expect(p.resultOf[2].seq).toBe(3);
    expect(p.callOf).toEqual({ 3: 2, 4: 1 });
  });

  it('a log written before the id was kept pairs by agent + tool name, oldest unanswered call first', () => {
    const p = wlPairTools([
      { seq: 1, kind: 'tool', tool: 'Grep' },
      { seq: 2, kind: 'tool', tool: 'Grep', agentId: 'toolu_sub' },
      { seq: 3, kind: 'tool', tool: 'Grep' },
      { seq: 4, kind: 'tool_result', tool: 'Grep', ok: true },
      { seq: 5, kind: 'tool_result', tool: 'Grep', agentId: 'toolu_sub', ok: true },
      { seq: 6, kind: 'tool_result', tool: 'Grep', ok: true },
    ]);
    expect(p.callOf).toEqual({ 4: 1, 5: 2, 6: 3 });
  });

  it("a window that starts after a call (older page not loaded) leaves that call's result unpaired — review P0", () => {
    // A1's call is on the older page: R1 must not be pinned on A2, nor R2 on A3.
    const p = wlPairTools([
      { seq: 12, kind: 'tool', tool: 'Read' },
      { seq: 13, kind: 'tool', tool: 'Read' },
      { seq: 14, kind: 'tool_result', tool: 'Read', ok: true },
      { seq: 15, kind: 'tool_result', tool: 'Read', ok: true },
      { seq: 16, kind: 'tool_result', tool: 'Read', ok: true },
    ]);
    expect(p.callOf).toEqual({ 15: 12, 16: 13 });
    // Once the older page is in, every result has its own call.
    const all = wlPairTools([
      { seq: 11, kind: 'tool', tool: 'Read' },
      { seq: 12, kind: 'tool', tool: 'Read' },
      { seq: 13, kind: 'tool', tool: 'Read' },
      { seq: 14, kind: 'tool_result', tool: 'Read', ok: true },
      { seq: 15, kind: 'tool_result', tool: 'Read', ok: true },
      { seq: 16, kind: 'tool_result', tool: 'Read', ok: true },
    ]);
    expect(all.callOf).toEqual({ 14: 11, 15: 12, 16: 13 });
  });

  it("a second call with an id already seen does not take over the first one's result", () => {
    const p = wlPairTools([
      { seq: 1, kind: 'tool', tool: 'Bash', toolUseId: 'x' },
      { seq: 2, kind: 'tool', tool: 'Bash', toolUseId: 'x' },
      { seq: 3, kind: 'tool_result', tool: 'Bash', toolUseId: 'x', ok: true },
    ]);
    expect(p.callOf).toEqual({ 3: 1 });
  });

  it('a result whose call is not in the log, or a second result for one id, stays unpaired', () => {
    const p = wlPairTools([
      { seq: 7, kind: 'tool_result', tool: 'Bash', toolUseId: 'gone', ok: true },
      { seq: 8, kind: 'tool', tool: 'Bash', toolUseId: 'x' },
      { seq: 9, kind: 'tool_result', tool: 'Bash', toolUseId: 'x', ok: true },
      { seq: 10, kind: 'tool_result', tool: 'Bash', toolUseId: 'x', ok: true },
      { seq: 11, kind: 'tool_result', tool: 'Bash', toolUseId: '__proto__', ok: true },
    ]);
    expect(p.callOf).toEqual({ 9: 8 });
  });
});

describe('what each card shows (shipped wlCardData)', () => {
  function make(session: Record<string, unknown> | null) {
    return load<{
      wlCardData(st: unknown, key: number): Record<string, unknown> | null;
      wlCardSig(d: unknown): string;
    }>([...PAIR_FNS, 'wlEntryBySeq', 'wlToolSummary', 'wlCallLive', 'wlCardData', 'wlCardSig'], [], {
      panelSessionKey: session ? 'S1' : null,
      _sessionCache: session ? { S1: session } : {},
    });
  }
  const call = { seq: 1, ts: 1000, kind: 'tool', tool: 'Read', text: 'Read src/app.ts', toolUseId: 'a', turnId: 't2' };

  it('a call and its result: done, the time between them, the summary, the clock time', () => {
    const st = { entries: [call, { seq: 2, ts: 3450, kind: 'tool_result', tool: 'Read', ok: true, toolUseId: 'a' }] };
    expect(make(null).wlCardData(st, 1)).toEqual({
      name: 'Read',
      summary: 'src/app.ts',
      status: 'success',
      open: false,
      at: 1000,
      startedAt: 1000,
      duration: 2450,
    });
  });

  it('a failed call: status error, a placeholder message until its output is loaded, then the output', () => {
    const st: Record<string, unknown> = {
      entries: [call, { seq: 2, ts: 1500, kind: 'tool_result', tool: 'Read', ok: false, toolUseId: 'a' }],
    };
    const m = make(null);
    expect(m.wlCardData(st, 1)).toMatchObject({ status: 'error', error: expect.stringContaining('툴이 오류') });
    st.cardDetail = { 1: { loading: false, result: 'ENOENT: no such file' } };
    expect(m.wlCardData(st, 1)).toMatchObject({
      status: 'error',
      error: 'ENOENT: no such file',
      result: 'ENOENT: no such file',
    });
  });

  it('no result: running only while its session works on that turn, otherwise it ended without one', () => {
    const later = { seq: 5, ts: 9000, kind: 'narration', text: 'x', turnId: 't3' };
    expect(make({ activityState: 'working' }).wlCardData({ entries: [call] }, 1)?.status).toBe('running');
    expect(make({ activityState: 'waiting' }).wlCardData({ entries: [call] }, 1)?.status).toBe('running');
    expect(make({ activityState: 'idle' }).wlCardData({ entries: [call] }, 1)?.status).toBe('interrupted');
    expect(make(null).wlCardData({ entries: [call] }, 1)?.status).toBe('interrupted');
    // The session works on a newer turn: this call's run is over.
    expect(make({ activityState: 'working' }).wlCardData({ entries: [call, later] }, 1)?.status).toBe('interrupted');
  });

  it('a result on its own (its call is not loaded) is a card of its own', () => {
    const st = { entries: [{ seq: 9, ts: 2000, kind: 'tool_result', tool: 'Glob', ok: true }] };
    expect(make(null).wlCardData(st, 9)).toEqual({ name: 'Glob', status: 'success', open: false });
  });

  it('open state and the fetched detail come from the list; no focusable flag — the log roves the card (D3-GAPS G2-3)', () => {
    const st = {
      entries: [call],
      open: new Set([1]),
      cardDetail: {
        1: {
          loading: false,
          args: '{"file_path":"a"}',
          note: '결과: 원본 출력이 저장되어 있지 않습니다',
          detailError: 'x',
        },
      },
    };
    const d = make(null).wlCardData(st, 1);
    expect(d).not.toHaveProperty('focusable');
    expect(d).toMatchObject({
      open: true,
      args: '{"file_path":"a"}',
      note: '결과: 원본 출력이 저장되어 있지 않습니다',
      detailError: 'x',
    });
    expect(make(null).wlCardData(st, 42)).toBeNull();
  });

  it('the signature follows what the card shows and the load that produced its output (review P1)', () => {
    const { wlCardSig } = make(null) as unknown as { wlCardSig(d: unknown, rev?: number): string };
    const a = { name: 'Read', status: 'success', result: 'x'.repeat(1000) };
    // Same-length but different output from a newer load: a new revision, so the card is repainted.
    expect(wlCardSig(a, 1)).not.toBe(wlCardSig({ ...a, result: 'y'.repeat(1000) }, 2));
    expect(wlCardSig(a, 1)).toBe(wlCardSig(a, 1));
    expect(wlCardSig(a, 1)).not.toBe(wlCardSig({ ...a, status: 'error' }, 1));
    expect(wlCardSig(a, 1)).not.toBe(wlCardSig({ ...a, open: true }, 1));
  });

  it('an older page never re-pairs what is on screen (legacy pairing runs from the newest back)', () => {
    const { wlPairTools } = load<{ wlPairTools(e: Entry[]): Pairs }>(PAIR_FNS, []);
    const latest: Entry[] = [
      { seq: 13, kind: 'tool', tool: 'Read' },
      { seq: 14, kind: 'tool_result', tool: 'Read', ok: true },
      { seq: 15, kind: 'tool_result', tool: 'Read', ok: true },
    ];
    expect(wlPairTools(latest).callOf).toEqual({ 15: 13 });
    const withOlder = wlPairTools([{ seq: 12, kind: 'tool', tool: 'Read' }, ...latest]);
    expect(withOlder.callOf).toEqual({ 14: 12, 15: 13 });
  });

  it('when the entries change a pairing, the card drops the output it loaded for its old pair', () => {
    const m = load<{ wlPairsOf(st: Record<string, unknown>): Pairs }>(PAIR_FNS, []);
    const st: Record<string, unknown> = {
      entries: [
        { seq: 13, kind: 'tool', tool: 'Read', toolUseId: 'a' },
        { seq: 14, kind: 'tool_result', tool: 'Read', ok: true, toolUseId: 'a' },
      ],
    };
    expect(m.wlPairsOf(st).resultOf[13]?.seq).toBe(14);
    st.cardDetail = { 13: { loading: false, result: 'loaded for 13 + 14', rev: 1 }, 99: { loading: false, rev: 2 } };
    // An older page brings the first call of that id: it owns the result now.
    st.entries = [{ seq: 12, kind: 'tool', tool: 'Read', toolUseId: 'a' }, ...(st.entries as Entry[])];
    expect(m.wlPairsOf(st).resultOf[12]?.seq).toBe(14);
    expect(m.wlPairsOf(st).resultOf[13]).toBeUndefined();
    expect((st.cardDetail as Record<number, unknown>)[13]).toBeUndefined();
    expect((st.cardDetail as Record<number, unknown>)[99]).toBeDefined(); // untouched pairs keep theirs
  });
});

describe('opening a card fetches its input and output (shipped wlToggleCard + wlLoadCardDetail)', () => {
  function rig(raws: Record<number, unknown>) {
    const painted: number[] = [];
    const loads: number[] = [];
    const st: Record<string, unknown> = {
      entries: [
        { seq: 1, ts: 0, kind: 'tool', tool: 'Bash', text: 'Bash ls', toolUseId: 'a', rawBytes: 20 },
        { seq: 2, ts: 5, kind: 'tool_result', tool: 'Bash', ok: true, toolUseId: 'a', rawBytes: 300000 },
      ],
    };
    const card = { getAttribute: (n: string) => (n === 'data-key' ? '1' : null) };
    const m = load<{
      wlToggleCard(st: unknown, el: unknown, open: boolean): void;
      wlLoadCardDetail(st: unknown, key: number): void;
    }>(
      [...PAIR_FNS, 'wlEntryBySeq', 'wlPartLoad', 'wlLoadCardDetail', 'wlToggleCard'],
      ['WL_RAW_MISSING_MSG', 'WL_RAW_ERROR_MSG', 'WL_RAW_DAMAGED_MSG', 'WL_FORBIDDEN_MSG', '_wlDetailRev'],
      {
        _wl: st,
        toNum: (v: unknown) => Number(v) || 0,
        formatBytes: (n: number) => `${Math.round(n / 1024)} KiB`,
        wlFetchJson: () => Promise.reject(new Error('not used')),
        wlRawLoad: (_s: unknown, seq: number) => {
          loads.push(seq);
          return Promise.resolve(raws[seq]);
        },
        wlCardEl: () => card,
        wlPaintCard: (_s: unknown, el: unknown) => {
          if (el) painted.push(painted.length);
        },
      },
    );
    return { m, st, card, loads, painted };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('loads both raws once, marks a cut-short output, and keeps the card open across repaints', async () => {
    const r = rig({
      1: { status: 'ok', raw: '{"command":"ls"}', bytes: 20, truncated: false },
      2: { status: 'ok', raw: 'a\nb', bytes: 300000, truncated: true },
    });
    r.m.wlToggleCard(r.st, r.card, true);
    expect((r.st.open as Set<number>).has(1)).toBe(true);
    expect((r.st.cardDetail as Record<number, unknown>)[1]).toMatchObject({ loading: true });
    await flush();
    expect(r.loads).toEqual([1, 2]);
    expect((r.st.cardDetail as Record<number, unknown>)[1]).toEqual({
      loading: false,
      rev: expect.any(Number),
      args: '{"command":"ls"}',
      result: 'a\nb',
      note: '결과: 저장된 앞 256 KiB만 표시 — 원본 293 KiB',
    });
    // Closing and opening again does not fetch again.
    r.m.wlToggleCard(r.st, r.card, false);
    expect((r.st.open as Set<number>).has(1)).toBe(false);
    r.m.wlToggleCard(r.st, r.card, true);
    expect(r.loads).toEqual([1, 2]);
  });

  it('not stored / owner-only → a note; a failed load → an error the card offers to retry', async () => {
    const r = rig({ 1: { status: 'missing' }, 2: { status: 'error' } });
    r.m.wlToggleCard(r.st, r.card, true);
    await flush();
    expect((r.st.cardDetail as Record<number, unknown>)[1]).toEqual({
      loading: false,
      rev: expect.any(Number),
      note: '입력: 원본 출력이 저장되어 있지 않습니다',
      detailError: '원본 출력을 불러오지 못했어요',
    });
    // A failed load is fetched again on the next opening.
    r.m.wlToggleCard(r.st, r.card, false);
    r.m.wlToggleCard(r.st, r.card, true);
    expect(r.loads).toEqual([1, 2, 1, 2]);
    const denied = rig({ 1: { status: 'denied' }, 2: { status: 'ok', raw: 'x', bytes: 1 } });
    denied.m.wlToggleCard(denied.st, denied.card, true);
    await flush();
    // Owner-only is a final answer: a note, not a retry that would only get the same answer.
    const deniedDet = (denied.st.cardDetail as Record<number, Record<string, unknown>>)[1];
    expect(deniedDet.note).toBe('작업 로그는 세션 소유자만 볼 수 있어요');
    expect(deniedDet.detailError).toBeUndefined();
  });

  it('a late answer for a conversation no longer shown is dropped', async () => {
    const r = rig({ 1: { status: 'ok', raw: 'x', bytes: 1 }, 2: { status: 'ok', raw: 'y', bytes: 1 } });
    r.m.wlToggleCard(r.st, r.card, true);
    r.st.closed = true;
    await flush();
    expect((r.st.cardDetail as Record<number, unknown>)[1]).toMatchObject({ loading: true });
  });

  it('a load superseded by a newer one (or dropped by a re-pairing) does not land', async () => {
    const r = rig({ 1: { status: 'ok', raw: 'old', bytes: 3 }, 2: { status: 'ok', raw: 'old', bytes: 3 } });
    r.m.wlLoadCardDetail(r.st, 1);
    delete (r.st.cardDetail as Record<number, unknown>)[1]; // the pairing changed meanwhile
    await flush();
    expect((r.st.cardDetail as Record<number, unknown>)[1]).toBeUndefined();
  });
});

describe('a live result fills its call card instead of adding a row (shipped wlLogData + wlCardSlots + paintWorkLog)', () => {
  it('the call is one card entry (its slot holds the page’s card); its result is not an entry — it goes to that card', () => {
    const st = {
      entries: [
        { seq: 1, ts: 0, kind: 'tool', tool: 'Read', text: 'Read a', toolUseId: 'a' },
        { seq: 2, ts: 9, kind: 'tool_result', tool: 'Read', ok: true, toolUseId: 'a' },
      ],
      loaded: true,
      latestOk: true,
    };
    const m = load<{ wlLogData(st: unknown): { groups: Array<{ entries: Array<Record<string, unknown>> }> } }>(
      [
        ...PAIR_FNS,
        'wlEntryBySeq',
        'wlCallLive',
        'wlCardData',
        'wlGroupOf',
        'wlGroupOpen',
        'wlGroupsOf',
        'wlToolSummary',
        'wlEntryOf',
        'wlLogData',
        'decodeSlackEntities',
      ],
      ['WL_LABELS', 'WL_EMPTY_MSG', 'WL_FORBIDDEN_MSG'],
      {
        _panelAgent: '',
        panelSessionKey: null,
        _sessionCache: {},
        wlScopeEntries: (e: unknown[]) => e,
        wlLegacyMixed: () => false,
        wlTaskInfo: () => null,
        wlAgentOf: (id: string) => ({ id }),
      },
    );
    const d = m.wlLogData(st);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].entries).toEqual([
      { id: '1', at: 0, kind: 'tool', tool: { name: 'Read', status: 'success', summary: 'a' } },
    ]);
    // A live result arrives: paintWorkLog routes it to its call's card (wlOnToolResult), then paints.
    const paint = clientFn('paintWorkLog');
    expect(paint).toContain('if (e && wlCardHidden(state, e)) wlOnToolResult(state, e);');
    expect(paint.indexOf('wlOnToolResult')).toBeLessThan(paint.indexOf('wlPaint();'));
  });
});

describe('a task group’s meta line (shipped wlTaskMeta; D3-GAPS G2-2 — the element’s WorkGroup.meta)', () => {
  const m = load<{ wlTaskMeta(t: Record<string, unknown>): unknown[] }>(
    ['toNum', 'formatDuration', 'taskFateOf', 'wlTaskMeta'],
    ['TASK_FATE_LABEL'],
  );
  it('done: its time and 툴 N회; running / paused / replaced: the fate word (no live clock in a head); pending: nothing', () => {
    expect(m.wlTaskMeta({ status: 'completed', startedAt: 1000, completedAt: 181000, toolCalls: 3.4 })).toEqual([
      '3분 00초 만에 완료',
      { label: '툴', value: '3회' },
    ]);
    expect(m.wlTaskMeta({ status: 'completed', toolCalls: 0 })).toEqual(['완료', { label: '툴', value: '0회' }]);
    expect(m.wlTaskMeta({ status: 'in_progress', startedAt: 1000, toolCalls: 2 })).toEqual([
      '진행 중',
      { label: '툴', value: '2회' },
    ]);
    expect(m.wlTaskMeta({ status: 'pending', startedAt: 1000, toolCalls: 1 })).toEqual([
      '멈춤',
      { label: '툴', value: '1회' },
    ]);
    expect(m.wlTaskMeta({ dropped: 'started', startedAt: 1000, removedAt: 61000, toolCalls: 5 })).toEqual([
      '교체됨 1분 00초',
      { label: '툴', value: '5회' },
    ]);
    expect(m.wlTaskMeta({ status: 'pending' })).toEqual([]);
    expect(m.wlTaskMeta({ dropped: 'unstarted' })).toEqual(['실행 안 됨']);
  });
});
describe('a slotted card is a row on the log’s arrow path (0.12.0 head-tabindex); it handles its own Enter / Space (shipped wlCardSlots, initWorkLog)', () => {
  it('no card is made a stop of its own: no data-stop, no focusable in its data (D3-GAPS G2-3 closed)', () => {
    expect(clientFn('wlCardSlots')).not.toContain('data-stop');
    expect(clientFn('wlPaintCard')).toContain('var d = wlCardData(state, key);');
    expect(clientFn('wlCardData')).not.toContain('focusable');
    expect(clientFn('wlCardSig')).not.toContain('focusable');
    expect(TEMPLATE).not.toContain('data-stop');
  });

  it('the page answers a card’s ui-toggle (its open state and detail) and ui-reload; the rest is the element’s', () => {
    const init = TEMPLATE.slice(TEMPLATE.indexOf('(function initWorkLog() {'));
    const body = init.slice(0, init.indexOf('\n})();'));
    expect(body).toContain('if (wlIsCard(e.target)) {');
    expect(body).toContain('wlToggleCard(st, e.target, !!(e.detail && e.detail.open));');
    expect(body).toContain("el.addEventListener('ui-reload', function(e) {");
  });
});

describe('the library build is served from the dashboard origin (server half)', () => {
  it('the page loads <ui-tool-call-card> from /dashboard/ui, a module script', () => {
    // Versioned: the entry file is not content-hashed and is cached for an hour.
    expect(TEMPLATE).toContain(
      '<script type="module" src="/dashboard/ui/tool-call-card.js?v=${UI_LIB_VERSION}"></script>',
    );
  });

  it('the cards take the dashboard tokens from their wrapper, never on the element (a custom-property cycle)', () => {
    const css = (sel: string) => {
      const i = TEMPLATE.indexOf(`\n${sel} {`);
      expect(i, sel).toBeGreaterThan(0);
      return TEMPLATE.slice(i, TEMPLATE.indexOf('}', i));
    };
    // One mapping for every library element's wrapper (.ui-tok: the section boxes hold the log and its cards).
    const wrapper = css('.ui-tok');
    for (const t of ['border', 'surface', 'text', 'st-done', 'st-fail', 'st-run'])
      expect(wrapper).toContain(`--ui-${t}: var(--${t});`);
    expect(css('.worklog-list ui-tool-call-card')).not.toContain('--ui-');
  });

  it('only flat dist/*.js names are served', () => {
    for (const ok of ['tool-call-card.js', 'html-CPp-eEeP.js', 'index.js', 'format_1.js'])
      expect(UI_LIB_FILE.test(ok), ok).toBe(true);
    for (const bad of ['../package.json', '..%2Fx.js', '.js', '-x.js', 'a/b.js', 'x.mjs', 'x.js.map', 'x.d.ts', '']) {
      expect(UI_LIB_FILE.test(bad), bad).toBe(false);
    }
  });

  it('the installed @2lab.ai/ui carries the element file and its chunks', () => {
    const dir = uiLibDistDir();
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir as string, 'tool-call-card.js'))).toBe(true);
    const imports =
      readFileSync(join(dir as string, 'tool-call-card.js'), 'utf-8').match(/from\s+"\.\/([^"]+)"/g) ?? [];
    for (const imp of imports) {
      const file = /\.\/([^"]+)/.exec(imp)?.[1] ?? '';
      expect(UI_LIB_FILE.test(file), file).toBe(true);
      expect(existsSync(join(dir as string, file)), file).toBe(true);
    }
  });
});

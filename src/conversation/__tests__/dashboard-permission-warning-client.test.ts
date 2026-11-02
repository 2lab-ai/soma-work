/**
 * SSOT_2 #3 (T8.3): "이거 슬랙 메세지랑 대시보드 채팅창에도 그대로 해줘." The dashboard
 * shows the auto-mode permission WARNING with nothing to answer — a badge row in
 * the work log (opens to the full command) and a system line in 지시와 답변 at
 * its time (command, matched rules, the model's reason, no answer needed). The
 * shipped client functions are cut out of renderDashboardPage()'s template
 * literal and cooked exactly as the browser receives them.
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
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientLine(prefix: string): string {
  const start = TEMPLATE.indexOf(`\n${prefix}`);
  if (start < 0) throw new Error(`client line ${prefix} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n', start + 1)));
}
function load<T>(fns: string[], lines: string[], inject: Record<string, unknown>): T {
  const names = Object.keys(inject);
  const body = `${lines.map(clientLine).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const T0 = Date.UTC(2026, 10, 2, 3, 0, 0);
const WARNING = {
  seq: 7,
  ts: T0 + 60_000,
  kind: 'permission_warning',
  tool: 'Bash',
  text: 'rm -rf /tmp/scratch <img src=x onerror=alert(1)>',
  warning: {
    reason: 'owner asked to clean scratch',
    rules: [{ id: 'rm-recursive', label: 'recursive delete', description: 'rm with -r' }],
  },
};

interface WarnTurn {
  id: string;
  role: string;
  kind: string;
  label: string;
  text: string;
  at?: number;
  facts?: Array<[string, string]>;
  raw?: string;
}

describe('permissionWarningTurns — the chat line for each warning', () => {
  const { permissionWarningTurns } = load<{ permissionWarningTurns(entries: unknown[]): WarnTurn[] }>(
    ['sysOneLine', 'permissionWarningTurns'],
    [],
    {},
  );

  it('is a system line: badge, the command, the rules, the model reason, nothing to answer', () => {
    const [t] = permissionWarningTurns([WARNING]);
    expect(t).toMatchObject({ id: 'pw-7', role: 'system', kind: 'permission', label: '퍼미션 경고', at: WARNING.ts });
    expect(t.text).toContain('rm -rf /tmp/scratch');
    const facts = Object.fromEntries(t.facts ?? []);
    expect(facts['걸린 규칙']).toContain('rm-recursive');
    expect(facts['모델 판단']).toBe('owner asked to clean scratch');
    expect(facts['응답']).toMatch(/필요 없음/);
    expect(t.raw).toBe(WARNING.text); // the element escapes text; the raw is the command as run
  });

  it("skips other kinds and a subagent's warnings (the main conversation only)", () => {
    expect(permissionWarningTurns([{ ...WARNING, kind: 'notice' }, { ...WARNING, agentId: 'a1' }, null])).toEqual([]);
  });
});

describe('convTurnsOf — warnings filed among the turns by time', () => {
  const api = load<{
    convTurnsOf(list: unknown[], c: Record<string, unknown>): { turns: Array<{ id: string; role: string }> };
  }>(['toNum', 'convTurnsOf'], [], {
    sysTurnInfo: () => null,
    convSysTurn: () => ({}),
    splitInvokedSkills: (t: string) => ({ text: t, skills: [] }),
    decodeSlackEntities: (t: string) => t,
    convSummaryOf: () => ({}),
    ansCacheKey: (c: string, id: string) => `${c}|${id}`,
    artInTurn: () => false,
  });
  const c = (extra: Record<string, unknown> = {}) => ({
    cid: 'c1',
    bot: 'bot',
    now: T0,
    working: false,
    answers: {},
    failed: {},
    resum: {},
    arts: [],
    titles: {},
    ...extra,
  });
  const turns = [
    { id: 'u1', role: 'user', timestamp: T0, rawContent: 'clean it' },
    { id: 'a1', role: 'assistant', timestamp: T0 + 120_000 },
  ];
  const w = (seq: number, ts: number) => ({ id: `pw-${seq}`, role: 'system', kind: 'permission', at: ts });

  it('goes before the first turn after it', () => {
    const out = api.convTurnsOf(turns, c({ warnings: [w(7, T0 + 60_000)] }));
    expect(out.turns.map((t) => t.id)).toEqual(['u1', 'pw-7', 'a1']);
  });

  it('goes last when it is newer than every turn (the turn still running)', () => {
    const out = api.convTurnsOf(turns, c({ warnings: [w(8, T0 + 300_000)] }));
    expect(out.turns.map((t) => t.id)).toEqual(['u1', 'a1', 'pw-8']);
  });

  it('waits for the older page when it is older than every loaded turn', () => {
    const out = api.convTurnsOf(turns, c({ warnings: [w(1, T0 - 1)], hasMore: true }));
    expect(out.turns.map((t) => t.id)).toEqual(['u1', 'a1']);
    // With no older page left, it is the first line.
    expect(api.convTurnsOf(turns, c({ warnings: [w(1, T0 - 1)] })).turns.map((t) => t.id)).toEqual([
      'pw-1',
      'u1',
      'a1',
    ]);
  });

  it('orders several warnings by time, then seq', () => {
    const out = api.convTurnsOf(turns, c({ warnings: [w(9, T0 + 60_000), w(8, T0 + 60_000), w(5, T0 + 30_000)] }));
    expect(out.turns.map((t) => t.id)).toEqual(['u1', 'pw-5', 'pw-8', 'pw-9', 'a1']);
  });

  it('without warnings the turns are unchanged', () => {
    expect(api.convTurnsOf(turns, c()).turns.map((t) => t.id)).toEqual(['u1', 'a1']);
  });
});

describe('wlEntryOf — the work-log row for a permission_warning entry', () => {
  const { wlEntryOf } = load<{ wlEntryOf(st: unknown, e: unknown): Record<string, unknown> }>(
    ['toNum', 'sysOneLine', 'wlEntryOf'],
    ['var WL_LABELS = ', 'var WL_PERMISSION_LABELS = '],
    { wlRawView: () => ({ state: 'ready', text: 'full' }) },
  );

  it('is a badge row naming the rules, openable to the full command', () => {
    const x = wlEntryOf({ open: new Set([7]) }, WARNING);
    expect(x).toMatchObject({ id: '7', kind: 'system', system: { kind: 'permission', label: '퍼미션 경고' } });
    expect(String(x.text)).toContain('rm-recursive');
    expect(String(x.text)).toContain('rm -rf /tmp/scratch');
    expect(x.hasRaw).toBe(true);
    expect(x.raw).toEqual({ state: 'ready', text: 'full' });
  });
});

describe('paintWorkLog / showWorkLogDenied — the chat follows the log', () => {
  function harness(psec: string) {
    const convPaintSoon = vi.fn();
    const state = { entries: [] as unknown[], painted: true, closed: false };
    const m = load<{ paintWorkLog(s: unknown, added: unknown[]): void; showWorkLogDenied(s: unknown): void }>(
      ['paintWorkLog', 'showWorkLogDenied'],
      [],
      {
        _wl: state,
        _psec: psec,
        _panelAgent: '',
        convPaintSoon,
        wlNamesNewAgent: () => false,
        renderPanelAgents: () => {},
        paintTreeTab: () => {},
        renderAgentConv: () => {},
        wlCardHidden: () => false,
        wlOnToolResult: () => {},
        wlPaint: () => {},
      },
    );
    return { m, state, convPaintSoon };
  }

  it('a warning arriving while 지시와 답변 is shown repaints the chat', () => {
    const { m, state, convPaintSoon } = harness('conv');
    m.paintWorkLog(state, [{ entry: WARNING, index: 0 }]);
    expect(convPaintSoon).toHaveBeenCalled();
  });

  it('other entries do not repaint the chat', () => {
    const { m, state, convPaintSoon } = harness('conv');
    m.paintWorkLog(state, [{ entry: { seq: 1, kind: 'tool', text: 'x' }, index: 0 }]);
    expect(convPaintSoon).not.toHaveBeenCalled();
  });

  it('a denied log takes its warnings out of the chat too', () => {
    const { m, state, convPaintSoon } = harness('conv');
    state.entries = [WARNING];
    m.showWorkLogDenied(state);
    expect(state.entries).toEqual([]);
    expect(convPaintSoon).toHaveBeenCalled();
  });
});

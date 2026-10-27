/**
 * SSOT_2 #3 (T8.3): "이거 슬랙 메세지랑 대시보드 채팅창에도 그대로 해줘." The dashboard
 * shows the auto-mode permission WARNING with the permission request card's look
 * and nothing to answer — in the work log and filed into the panel chat at its
 * time. The shipped client functions are cut out of renderDashboardPage()'s
 * template literal and cooked exactly as the browser receives them.
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
function clientLine(prefix: string): string {
  const start = TEMPLATE.indexOf(`\n${prefix}`);
  if (start < 0) throw new Error(`client line ${prefix} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n', start + 1)));
}

const FNS = ['esc', 'escAttr', 'renderPermissionWarningCard', 'permissionWarningSlot', 'renderWorkLogEntry'] as const;
interface Client {
  renderPermissionWarningCard(e: unknown): string;
  permissionWarningSlot(
    nodes: Array<{ ts: number; seq: number | null }>,
    ts: number,
    seq: number,
    hasOlder: boolean,
  ): number | null;
  renderWorkLogEntry(e: unknown): string;
}
const client = new Function(
  'decodeSlackEntities',
  'wlChildBlock',
  `${clientLine('var WL_LABELS = ')}\n${FNS.map(clientFn).join('\n')}\nreturn { ${FNS.join(', ')} };`,
)(
  (t: string) => t,
  () => '',
) as Client;

const ENTRY = {
  seq: 7,
  ts: Date.UTC(2026, 9, 27, 3, 0, 0),
  kind: 'permission_warning',
  tool: 'Bash',
  text: 'rm -rf /tmp/scratch <img src=x onerror=alert(1)>',
  warning: {
    reason: 'owner asked to clean scratch',
    rules: [{ id: 'rm-recursive', label: 'recursive delete', description: 'rm with -r' }],
  },
};

describe('dashboard permission warning card', () => {
  const html = client.renderPermissionWarningCard(ENTRY);

  it('has the permission card look: header, command, matched rules, the model reason', () => {
    expect(html).toContain('perm-request perm-warning');
    expect(html).toContain('Permission Warning');
    expect(html).toContain('<code>Bash</code>');
    expect(html).toContain('<code>rm-recursive</code> &mdash; recursive delete: rm with -r');
    expect(html).toContain('owner asked to clean scratch');
    expect(html).toContain('응답 필요 없음');
  });

  it('asks nothing: no buttons, no approval id', () => {
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-perm-decision');
  });

  it('escapes the command', () => {
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('is the work-log row for a permission_warning entry, openable to the full command', () => {
    const row = client.renderWorkLogEntry(ENTRY);
    expect(row).toContain('wl-entry wl-permission_warning');
    expect(row).toContain('data-seq="7"');
    expect(row).toContain('perm-warning');
    // Review gate r1 (astra P2): the row opens the stored raw like every other row.
    expect(row).toContain('class="wl-row');
    expect(row).toContain('id="wl-detail-7"');
    // Review gate r2: toggleWorkLogEntry finds .wl-row and .wl-detail INSIDE the
    // .wl-entry — the detail must sit at depth 1 (inside the entry, after the row).
    const before = row.slice(0, row.indexOf('class="wl-detail"'));
    const depth = (before.match(/<div\b/g) ?? []).length - (before.match(/<\/div>/g) ?? []).length;
    expect(depth).toBe(2); // entry open + the detail's own <div
    expect(row.endsWith('</div></div>')).toBe(true);
  });

  it('says when the command was cut and where the full text is', () => {
    expect(client.renderPermissionWarningCard({ ...ENTRY, text: `${'x'.repeat(3999)}…`, rawBytes: 9000 })).toContain(
      '전체 원문',
    );
    expect(client.renderPermissionWarningCard({ ...ENTRY, rawBytes: 50 })).not.toContain('전체 원문');
    expect(client.renderPermissionWarningCard(ENTRY)).not.toContain('전체 원문');
  });
});

// Review gate r1 (astra P2): warnings merge with turns AND with the warnings
// already filed, by time then seq — a backfilled older warning lands before a
// newer one, not after it.
type Node = { ts: number; seq: number | null };
describe('permissionWarningSlot — filing a warning into the chat at its time', () => {
  const turns = (...ts: number[]): Node[] => ts.map((t) => ({ ts: t, seq: null }));
  it('goes before the first turn after it', () => {
    expect(client.permissionWarningSlot(turns(10, 20, 30), 25, 1, false)).toBe(2);
    expect(client.permissionWarningSlot(turns(10, 20, 30), 5, 1, false)).toBe(0);
  });
  it('goes after every turn when it is the newest (the turn still running)', () => {
    expect(client.permissionWarningSlot(turns(10, 20), 25, 1, false)).toBe(-1);
    expect(client.permissionWarningSlot([], 25, 1, false)).toBe(-1);
  });
  it('waits for older pages when it is older than every loaded turn', () => {
    expect(client.permissionWarningSlot(turns(10, 20), 5, 1, true)).toBeNull();
    expect(client.permissionWarningSlot(turns(10, 20), 15, 1, true)).toBe(1);
  });
  it('orders against warnings already filed, by time then seq', () => {
    const nodes: Node[] = [
      { ts: 10, seq: null },
      { ts: 25, seq: 9 },
      { ts: 30, seq: null },
    ];
    expect(client.permissionWarningSlot(nodes, 15, 4, false)).toBe(1); // before the warning at 25
    expect(client.permissionWarningSlot(nodes, 25, 3, false)).toBe(1); // same time, lower seq first
    expect(client.permissionWarningSlot(nodes, 25, 12, false)).toBe(2);
  });
});

// A minimal DOM: enough for placePermissionWarnings to file nodes into #panel-turns.
function fakeDom() {
  type El = { className: string; attrs: Record<string, string>; innerHTML: string };
  const children: El[] = [];
  const el = (className: string, attrs: Record<string, string>): El => ({ className, attrs, innerHTML: '' });
  const api = (n: El) =>
    Object.assign(n, {
      getAttribute: (k: string) => n.attrs[k] ?? null,
      hasAttribute: (k: string) => k in n.attrs,
      setAttribute: (k: string, v: string) => {
        n.attrs[k] = v;
      },
      remove: () => {
        const at = children.indexOf(n);
        if (at >= 0) children.splice(at, 1);
      },
    });
  const turnsEl = {
    querySelector: (sel: string) => {
      const m = /data-warn-seq="(\d+)"/.exec(sel);
      return children.find((c) => m && c.attrs['data-warn-seq'] === m[1]) ?? null;
    },
    querySelectorAll: (sel: string) =>
      children
        .filter((c) => (sel === '.perm-warning-turn' ? 'data-warn-seq' in c.attrs : 'data-ts' in c.attrs))
        .map(api),
    appendChild: (n: El) => children.push(n),
    insertBefore: (n: El, ref: El) => children.splice(children.indexOf(ref), 0, n),
  };
  const document = {
    getElementById: (id: string) => (id === 'panel-turns' ? turnsEl : null),
    createElement: () => api(el('', {})),
  };
  const addTurn = (ts: number, at?: number) => {
    const n = api(el('turn', { 'data-ts': String(ts) }));
    if (at === undefined) children.push(n);
    else children.splice(at, 0, n);
  };
  const order = () =>
    children.map((c) => (c.attrs['data-warn-seq'] ? `w${c.attrs['data-warn-seq']}` : `t${c.attrs['data-ts']}`));
  return { document, addTurn, order };
}

describe('placePermissionWarnings — incremental filing into the chat', () => {
  it('keeps chat order when an older warning is backfilled after a newer one', () => {
    const dom = fakeDom();
    dom.addTurn(10);
    dom.addTurn(30);
    const state = { convId: 'c1', entries: [] as unknown[] };
    const place = new Function(
      'document',
      'decodeSlackEntities',
      'wlChildBlock',
      'toNum',
      'state',
      `var _wl = state; var panelConvId = 'c1'; var _panelTurnsHasMore = false;
${clientFn('esc')}
${clientFn('escAttr')}
${clientFn('renderPermissionWarningCard')}
${clientFn('permissionWarningSlot')}
${clientFn('removePermissionWarnings')}
${clientFn('placePermissionWarnings')}
return placePermissionWarnings;`,
    )(
      dom.document,
      (t: string) => t,
      () => '',
      (v: unknown) => Number(v) || 0,
      state,
    ) as () => void;
    state.entries.push({ ...ENTRY, seq: 9, ts: 25 });
    place();
    state.entries.push({ ...ENTRY, seq: 4, ts: 15 });
    place();
    place(); // idempotent
    expect(dom.order()).toEqual(['t10', 'w4', 'w9', 't30']);
  });
});

// Review gate r2 (astra P2): a turn that lands later in the middle (a settled
// steer with an earlier timestamp) re-files the warnings around it.
describe('placePermissionWarnings — reconciles when turns change', () => {
  it('moves an existing warning after a late-arriving earlier turn', () => {
    const dom = fakeDom();
    dom.addTurn(10);
    const state = { convId: 'c1', entries: [{ ...ENTRY, seq: 9, ts: 25 }] as unknown[] };
    const place = new Function(
      'document',
      'decodeSlackEntities',
      'wlChildBlock',
      'toNum',
      'state',
      `var _wl = state; var panelConvId = 'c1'; var _panelTurnsHasMore = false;
${clientFn('esc')}
${clientFn('escAttr')}
${clientFn('renderPermissionWarningCard')}
${clientFn('permissionWarningSlot')}
${clientFn('removePermissionWarnings')}
${clientFn('placePermissionWarnings')}
return placePermissionWarnings;`,
    )(
      dom.document,
      (t: string) => t,
      () => '',
      (v: unknown) => Number(v) || 0,
      state,
    ) as () => void;
    place();
    expect(dom.order()).toEqual(['t10', 'w9']);
    dom.addTurn(20, 2); // appended after the warning, though it is older
    place();
    expect(dom.order()).toEqual(['t10', 't20', 'w9']);
  });
});

describe('showWorkLogDenied — the chat copies go too', () => {
  it('removes every warning card from the chat when the log is denied', () => {
    const removed: string[] = [];
    const nodes = [{ remove: () => removed.push('a') }, { remove: () => removed.push('b') }];
    const turnsEl = { querySelectorAll: (sel: string) => (sel === '.perm-warning-turn' ? nodes : []) };
    const list = { innerHTML: '' };
    const document = {
      getElementById: (id: string) => (id === 'panel-turns' ? turnsEl : id === 'worklog-list' ? list : null),
    };
    const state = { closed: false, entries: [1] };
    new Function(
      'document',
      'state',
      'setTextIfChanged',
      `var _wl = state; var WL_FORBIDDEN_MSG = 'x';
${clientFn('esc')}
${clientFn('removePermissionWarnings')}
${clientFn('showWorkLogDenied')}
showWorkLogDenied(state);`,
    )(document, state, () => {});
    expect(removed).toEqual(['a', 'b']);
    expect(state.entries).toEqual([]);
  });
});

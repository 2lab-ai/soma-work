/**
 * Dashboard surface layouts (SSOT 2026-11-02, .prd/21): the model behind the 대시보드 화면 editor.
 *
 *   L1  the built-in presets are .prd/20 §5, cell for cell, and every list holds its whole catalog
 *   L2  a saved document is checked: wrong shapes refused, unknown ids dropped, a missing item takes the
 *       built-in's state at the built-in's place (an item added later shows as its preset meant)
 *   L6  작업 카드의 연결 (SSOT 2026-11-02): the links row (issues · PRs · wikis with their states) is on in every
 *       preset and mode; the PR chip it covers is off; a saved card without it gets it
 *   L3  each surface resolves to its preset — the user's default per surface, else the quick switch, else 1
 *   L4  the thread card follows the task card by default; theme keeps the server's Slack theme; custom is its own
 *   L7  미니멀 상세 카드: the chat is a tab view with the work log (대화 · 작업 로그) — on in every minimal preset,
 *       off in advanced (which has the whole strip); a detail card saved before the switch existed takes its
 *       preset's state
 *   L8  상세 카드 세 구역 (SSOT 2026-11-03): the title bar's metrics after the time (model · cost · tokens · tok/s …,
 *       each on/off), 입력 필요 fixed right under it, the tab bar (목표 · 작업 · 에이전트 …, closed until pressed, its
 *       tabs on/off and in order), the bottom (대화 · 작업 로그); a card saved before the tab bar takes its preset's
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  CARD_CHIPS,
  CARD_ROWS,
  type DashboardLayoutDoc,
  DETAIL_HEAD,
  DETAIL_TABS,
  followThreadLayout,
  LAYOUT_CATALOG,
  LayoutError,
  normalizeLayoutDoc,
  OPEN_PARTS,
  PRESET_IDS,
  resolveLayouts,
  THREAD_INFO,
  THREAD_NAV,
  threadCardLines,
  VIEW_MODES,
} from '../view-layout';

const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();
const shown = (xs: Array<{ id: string; on: boolean }>) => xs.filter((x) => x.on).map((x) => x.id);

describe('L1 — built-in presets', () => {
  it('every preset and mode holds every catalog item once (a hidden one keeps its place)', () => {
    for (const p of PRESET_IDS)
      for (const m of VIEW_MODES) {
        const l = BUILTIN_PRESETS[p][m];
        expect(ids(l.card.rows), `${p} ${m} rows`).toEqual([...CARD_ROWS].sort());
        expect(ids(l.card.foot), `${p} ${m} foot`).toEqual([...CARD_CHIPS].sort());
        expect(ids(l.open.parts), `${p} ${m} open`).toEqual([...OPEN_PARTS].sort());
        expect(ids(l.detail.head), `${p} ${m} detail head`).toEqual([...DETAIL_HEAD].sort());
        expect(ids(l.detail.tabs), `${p} ${m} detail tabs`).toEqual([...DETAIL_TABS].sort());
      }
  });

  it('they are .prd/20 §5 with .prd/22: minimal 1안 = task · 연결 · artifacts (3); cost · model; links + model switch; checklist 34%', () => {
    const m1 = BUILTIN_PRESETS['1'].minimal;
    expect(shown(m1.card.rows)).toEqual(['summary', 'task', 'links', 'arts']);
    expect(m1.card.rows[0].opt).toBe('asks');
    expect(m1.card.rows.find((r) => r.id === 'arts')!.opt).toBe('3');
    // SSOT 2026-11-05: every built-in face leads its foot with where the work happens — 레포 · 채널.
    expect(shown(m1.card.foot)).toEqual(['repo', 'channel', 'cost', 'model']);
    expect(shown(m1.open.parts)).toEqual(['refs', 'model']);
    expect(m1.open.star).toBe(false);
    expect([m1.detail.tasks, m1.detail.tasksMax, m1.detail.open]).toEqual(['list', 34, false]);
    expect(shown(BUILTIN_PRESETS['2'].minimal.card.foot)).toEqual([
      'repo',
      'channel',
      'steps',
      'arts',
      'cost',
      'model',
    ]);
    expect(BUILTIN_PRESETS['2'].minimal.detail).toMatchObject({ tasks: 'list', tasksMax: 50, controls: true });
    expect(shown(BUILTIN_PRESETS['3'].minimal.card.foot)).toEqual(['repo', 'channel', 'cost', 'model']);
    expect(BUILTIN_PRESETS['3'].minimal.detail.tasks).toBe('line');
    // advanced 2안 원본: the ✦, no model, the ☆ button, every section unfolded.
    const a2 = BUILTIN_PRESETS['2'].advanced;
    expect(a2.card.kind).toBe(false);
    expect(shown(a2.card.foot)).toEqual(['repo', 'channel', 'steps', 'ctx', 'media']);
    expect(a2.open.star).toBe(true);
    expect(a2.detail.open).toBe(true);
    expect(a2.open.byCol?.work).toEqual(['tasks', 'agents', 'io', 'goal', 'refs', 'model']);
    expect(BUILTIN_PRESETS['3'].advanced.detail.open).toBe(false);
    expect(shown(BUILTIN_PRESETS['3'].advanced.open.parts)).toEqual(['goal', 'refs', 'model']);
  });

  it('the editor’s catalog names every item of every list', () => {
    expect(LAYOUT_CATALOG.card.rows.map((x) => x.id)).toEqual([...CARD_ROWS]);
    expect(LAYOUT_CATALOG.card.foot.map((x) => x.id)).toEqual([...CARD_CHIPS]);
    expect(LAYOUT_CATALOG.open.parts.map((x) => x.id)).toEqual([...OPEN_PARTS]);
    expect(LAYOUT_CATALOG.detail.head.map((x) => x.id)).toEqual([...DETAIL_HEAD]);
    expect(LAYOUT_CATALOG.detail.tabs.map((x) => x.id)).toEqual([...DETAIL_TABS]);
    expect(LAYOUT_CATALOG.thread.info.map((x) => x.id)).toEqual([...THREAD_INFO]);
    expect(LAYOUT_CATALOG.thread.nav.map((x) => x.id)).toEqual([...THREAD_NAV]);
    for (const e of [...LAYOUT_CATALOG.card.rows, ...LAYOUT_CATALOG.card.foot]) expect(e.label).toBeTruthy();
  });
});

describe('L2 — a saved document is checked', () => {
  it('nothing saved is the empty document', () => {
    expect(normalizeLayoutDoc(undefined)).toEqual({ v: 1 });
    expect(normalizeLayoutDoc(null)).toEqual({ v: 1 });
  });

  it('wrong shapes at the top are refused (a 400)', () => {
    for (const bad of [
      'x',
      [],
      { v: 2 },
      { presets: [] },
      { presets: { '4': {} } },
      { presets: { '1': { pro: {} } } },
      { active: { card: '9' } },
      { thread: { mode: 'loud' } },
    ])
      expect(() => normalizeLayoutDoc(bad), JSON.stringify(bad)).toThrow(LayoutError);
  });

  it('a list keeps its order, drops unknown ids and repeats; what it misses takes the built-in’s state and place', () => {
    const doc = normalizeLayoutDoc({
      presets: {
        '2': {
          minimal: {
            card: {
              kind: false,
              rows: [
                { id: 'arts', on: true, opt: '2' },
                { id: 'nope', on: true },
                { id: 'task', on: true },
                { id: 'arts', on: false },
              ],
              foot: [{ id: 'model', on: true }],
            },
          },
        },
      },
    });
    const card = doc.presets!['2']!.minimal!.card!;
    expect(card.kind).toBe(false);
    expect(card.star).toBe(true);
    // 2안 minimal's built-in rows: summary · task · links · agents · usage · arts — each missing one goes after the
    // built-in item before it (or first), as on or off as the built-in has it.
    expect(card.rows.map((r) => [r.id, r.on])).toEqual([
      ['summary', true],
      ['arts', true],
      ['task', true],
      ['links', true],
      ['agents', false],
      ['usage', false],
    ]);
    expect(card.rows[1].opt).toBe('2');
    // A missing summary takes its built-in rule; a bad option takes the built-in's.
    expect(card.rows.find((r) => r.id === 'summary')!.opt).toBe('all');
    // 레포 · 채널 (SSOT 2026-11-05) were not in the saved list: they lead it, on, as the built-in has them.
    expect(card.foot.map((c) => [c.id, c.on])).toEqual([
      ['repo', true],
      ['channel', true],
      ['steps', true],
      ['arts', true],
      ['cost', true],
      ['model', true],
      ['ctx', false],
      ['media', false],
      ['pr', false],
      ['tokens', false],
    ]);
    expect(card.foot).toHaveLength(CARD_CHIPS.length);
    // Only what was edited is kept: the other surfaces stay the built-in.
    expect(Object.keys(doc.presets!['2']!.minimal!)).toEqual(['card']);
  });

  it('the detail card: the list height is clamped; an edited open card loses the per-column order', () => {
    const doc = normalizeLayoutDoc({
      presets: {
        '1': {
          advanced: {
            detail: { tabs: [{ id: 'tasks', on: true }], tasks: 'line', tasksMax: 999 },
            open: { parts: [{ id: 'model', on: true }] },
          },
        },
      },
    });
    const d = doc.presets!['1']!.advanced!.detail!;
    expect(d.tabs.map((x) => x.id)).toEqual([...DETAIL_TABS]);
    expect(d.tasks).toBe('line');
    expect(d.tasksMax).toBe(70);
    const o = doc.presets!['1']!.advanced!.open!;
    expect(o.byCol).toBeUndefined();
    // The saved part is kept; the parts it misses take the built-in's state and place.
    expect(o.parts.find((x) => x.id === 'model')).toEqual({ id: 'model', on: true });
    expect(o.parts.map((x) => x.id).sort()).toEqual([...OPEN_PARTS].sort());
    expect(
      o.parts
        .filter((x) => x.on)
        .map((x) => x.id)
        .sort(),
    ).toEqual(
      BUILTIN_PRESETS['1'].advanced.open.parts
        .filter((x) => x.on || x.id === 'model')
        .map((x) => x.id)
        .sort(),
    );
  });

  it('the defaults per surface and the thread card', () => {
    expect(normalizeLayoutDoc({ active: { card: '2', detail: null } })).toEqual({ v: 1, active: { card: '2' } });
    expect(normalizeLayoutDoc({ thread: { mode: 'follow' } })).toEqual({ v: 1, thread: { mode: 'follow' } });
    const custom = normalizeLayoutDoc({ thread: { mode: 'custom', custom: { info: [{ id: 'cost', on: true }] } } });
    expect(custom.thread!.custom!.info[0]).toEqual({ id: 'cost', on: true });
    expect(custom.thread!.custom!.nav.map((x) => x.id)).toEqual([...THREAD_NAV]);
  });
});

describe('L3 — each surface resolves to its preset', () => {
  it('the user’s default per surface, else the quick switch (dashboardPlan), else 1', () => {
    expect(resolveLayouts(undefined, 'minimal').card).toBe(BUILTIN_PRESETS['1'].minimal.card);
    expect(resolveLayouts(undefined, 'minimal', '3').detail).toBe(BUILTIN_PRESETS['3'].minimal.detail);
    const doc: DashboardLayoutDoc = { v: 1, active: { card: '2', detail: '3' } };
    const r = resolveLayouts(doc, 'advanced', '1');
    expect(r.card).toBe(BUILTIN_PRESETS['2'].advanced.card);
    expect(r.open).toBe(BUILTIN_PRESETS['2'].advanced.open);
    expect(r.detail).toBe(BUILTIN_PRESETS['3'].advanced.detail);
  });

  it('a preset the user edited wins over the built-in, surface by surface', () => {
    const doc = normalizeLayoutDoc({ presets: { '1': { minimal: { card: { kind: false } } } } });
    const r = resolveLayouts(doc, 'minimal');
    expect(r.card.kind).toBe(false);
    expect(r.open).toBe(BUILTIN_PRESETS['1'].minimal.open);
  });
});

describe('L4 — the thread card (스레드 태스크 카드)', () => {
  it('follows the task card by default: the title, then what the face shows that Slack can, then the way back', () => {
    const lines = threadCardLines(undefined, 'minimal')!;
    expect(lines[0]).toEqual({ block: 'header', fields: [{ field: 'title', show: true, truncate: 150 }] });
    // minimal 1안's face: task · PR · cost · model, and the owner.
    expect(lines[1].fields.map((f) => f.field)).toEqual(['owner', 'task', 'cost', 'model']);
    expect(lines[2].fields.map((f) => f.field)).toEqual(['dashboardLink', 'linkhistory']);
    expect(lines[3].fields.map((f) => f.field)).toEqual(['status']);
  });

  it('the face’s order is the thread card’s; tokens · cost come from the usage row; no PR → no link history', () => {
    const face = {
      ...BUILTIN_PRESETS['1'].minimal.card,
      owner: false,
      rows: [
        { id: 'usage' as const, on: true },
        { id: 'task' as const, on: true },
      ],
      foot: [
        { id: 'model' as const, on: true },
        { id: 'ctx' as const, on: true },
        { id: 'steps' as const, on: true },
      ],
    };
    const t = followThreadLayout(face);
    expect(t.info.filter((x) => x.on).map((x) => x.id)).toEqual(['tokens', 'cost', 'task', 'model', 'ctx', 'steps']);
    expect(t.nav.filter((x) => x.on).map((x) => x.id)).toEqual(['dashboardLink', 'status']);
  });

  it('theme keeps the server’s Slack theme (no lines); custom is its own', () => {
    expect(threadCardLines({ v: 1, thread: { mode: 'theme' } }, 'minimal')).toBeUndefined();
    const doc = normalizeLayoutDoc({
      thread: {
        mode: 'custom',
        custom: {
          info: [
            { id: 'steps', on: true },
            { id: 'owner', on: true },
          ],
          nav: [{ id: 'links', on: true }],
        },
      },
    });
    const lines = threadCardLines(doc, 'advanced')!;
    expect(lines.map((l) => l.fields.map((f) => f.field))).toEqual([['title'], ['steps', 'owner'], ['links']]);
  });
});

describe('L6 — 작업 카드의 연결: issues · PRs · wikis on every card by default', () => {
  it('the links row is on in every preset and mode, right after the task; the PR chip it covers is off', () => {
    for (const p of PRESET_IDS)
      for (const m of VIEW_MODES) {
        const card = BUILTIN_PRESETS[p][m].card;
        const ids = card.rows.map((r) => r.id);
        expect(card.rows.find((r) => r.id === 'links')?.on, `${p} ${m}`).toBe(true);
        expect(ids.indexOf('links'), `${p} ${m}`).toBe(ids.indexOf('task') + 1);
        expect(card.foot.find((c) => c.id === 'pr')?.on, `${p} ${m}`).toBe(false);
      }
    expect(LAYOUT_CATALOG.card.rows.find((r) => r.id === 'links')?.label).toBe('연결 — 이슈 · PR · 위키');
  });

  it('a card saved before the row existed gets it, on, after its task', () => {
    const saved = {
      kind: true,
      star: true,
      owner: true,
      rows: [
        { id: 'summary', on: true, opt: 'asks' },
        { id: 'task', on: false },
        { id: 'arts', on: false, opt: '3' },
        { id: 'agents', on: false },
        { id: 'usage', on: false },
      ],
      foot: CARD_CHIPS.map((id) => ({ id, on: id === 'cost' })),
    };
    const doc = normalizeLayoutDoc({ v: 1, presets: { '3': { minimal: { card: saved } } } });
    const rows = doc.presets!['3']!.minimal!.card!.rows;
    expect(rows.map((r) => [r.id, r.on])).toEqual([
      ['summary', true],
      ['task', false],
      ['links', true],
      ['arts', false],
      ['agents', false],
      ['usage', false],
    ]);
  });

  it('the thread card follows: the links row brings the link history (issues · PRs · docs with their states)', () => {
    const face = BUILTIN_PRESETS['1'].minimal.card;
    expect(followThreadLayout(face).nav.find((x) => x.id === 'linkhistory')?.on).toBe(true);
    const off = { ...face, rows: face.rows.map((r) => (r.id === 'links' ? { ...r, on: false } : r)) };
    expect(followThreadLayout(off).nav.find((x) => x.id === 'linkhistory')?.on).toBe(false);
  });
});

describe('L7 — 미니멀 상세 카드: the chat is a tab view with the work log (대화 · 작업 로그)', () => {
  it('every minimal preset has the 대화 · 작업 로그 tabs; advanced keeps the full strip (대화 · 작업 로그 · 에이전트 트리)', () => {
    for (const p of PRESET_IDS) {
      expect(BUILTIN_PRESETS[p].minimal.detail.logtab, `${p} minimal`).toBe(true);
      expect(BUILTIN_PRESETS[p].minimal.detail.sections, `${p} minimal`).toBe(false);
      expect(BUILTIN_PRESETS[p].advanced.detail.logtab, `${p} advanced`).toBe(false);
      expect(BUILTIN_PRESETS[p].advanced.detail.sections, `${p} advanced`).toBe(true);
    }
  });

  it('a detail card saved before the switch existed gets its preset’s state: on in minimal, off in advanced', () => {
    const saved = (d: Record<string, unknown>) => {
      const { logtab: _drop, ...rest } = d;
      return JSON.parse(JSON.stringify(rest));
    };
    const doc = normalizeLayoutDoc({
      v: 1,
      presets: {
        '1': { minimal: { detail: saved(BUILTIN_PRESETS['1'].minimal.detail as unknown as Record<string, unknown>) } },
        '3': {
          advanced: { detail: saved(BUILTIN_PRESETS['3'].advanced.detail as unknown as Record<string, unknown>) },
        },
      },
    });
    expect(doc.presets!['1']!.minimal!.detail!.logtab).toBe(true);
    expect(doc.presets!['3']!.advanced!.detail!.logtab).toBe(false);
    // The user's own choice is kept.
    const off = normalizeLayoutDoc({ v: 1, presets: { '2': { minimal: { detail: { logtab: false } } } } });
    expect(off.presets!['2']!.minimal!.detail!.logtab).toBe(false);
  });

  it('the editor’s switch comes last, so the switches before it keep their places', () => {
    expect(LAYOUT_CATALOG.detail.toggles.map((t) => t.id)).toEqual([
      'subtitle',
      'agenthead',
      'sections',
      'controls',
      'open',
      'logtab',
    ]);
    expect(LAYOUT_CATALOG.detail.toggles[5].label).toBe('대화 · 작업 로그 탭');
  });
});

describe('L5 — the client’s thread card mapping is the server’s (view-layout-client.ts parity)', () => {
  it('followThreadLayout gives the same thread card for every built-in face and for edited ones', async () => {
    const { VIEW_LAYOUT_CLIENT_JS } = await import('../conversation/view-layout-client');
    const client = new Function(`${VIEW_LAYOUT_CLIENT_JS}\nreturn followThreadLayout;`)() as (f: unknown) => unknown;
    const faces = [];
    for (const p of PRESET_IDS) for (const m of VIEW_MODES) faces.push(BUILTIN_PRESETS[p][m].card);
    const base = BUILTIN_PRESETS['1'].advanced.card;
    faces.push({ ...base, owner: false, rows: [...base.rows].reverse(), foot: [...base.foot].reverse() });
    faces.push({ ...base, foot: base.foot.map((c) => ({ ...c, on: !c.on })) });
    for (const f of faces) expect(client(f)).toEqual(followThreadLayout(f));
  });
});

describe('L8 — 상세 카드 세 구역: title bar · 입력 필요 · tab bar · 대화 | 작업 로그 (SSOT 2026-11-03)', () => {
  it('the title bar shows the model, the cost, the tokens and the speed after the time in every built-in', () => {
    for (const p of PRESET_IDS) {
      expect(shown(BUILTIN_PRESETS[p].minimal.detail.head), `${p} minimal`).toEqual([
        'model',
        'cost',
        'tokens',
        'speed',
      ]);
      // 어드밴스드 carries the rest of the old 세션 정보 line there too.
      expect(shown(BUILTIN_PRESETS[p].advanced.detail.head), `${p} advanced`).toEqual([...DETAIL_HEAD]);
    }
  });

  it('the tab bar: 목표 · 작업 · 에이전트 · 산출물 in every built-in, 세부 (the full record) in advanced', () => {
    for (const p of PRESET_IDS) {
      expect(shown(BUILTIN_PRESETS[p].minimal.detail.tabs), `${p} minimal`).toEqual([
        'goal',
        'tasks',
        'agents',
        'artifacts',
      ]);
      expect(shown(BUILTIN_PRESETS[p].advanced.detail.tabs), `${p} advanced`).toEqual([...DETAIL_TABS]);
    }
  });

  it('the user orders and switches the title bar’s items and the tabs; unknown ids drop, missing ones take the preset', () => {
    const doc = normalizeLayoutDoc({
      v: 1,
      presets: {
        '1': {
          minimal: {
            detail: {
              head: [
                { id: 'tokens', on: true },
                { id: 'model', on: false },
                { id: 'nope', on: true },
              ],
              tabs: [
                { id: 'agents', on: true },
                { id: 'goal', on: false },
              ],
            },
          },
        },
      },
    });
    const d = doc.presets!['1']!.minimal!.detail!;
    const at = (id: string) => d.head.findIndex((x) => x.id === id);
    // The saved order holds (a missing item goes after its preset neighbour — .prd/22 §5).
    expect(at('tokens')).toBeLessThan(at('model'));
    expect(d.head.find((x) => x.id === 'model')!.on).toBe(false);
    expect(d.head.map((x) => x.id).sort()).toEqual([...DETAIL_HEAD].sort());
    expect(d.head.find((x) => x.id === 'cost')!.on).toBe(true);
    expect(d.tabs.findIndex((x) => x.id === 'agents')).toBeLessThan(d.tabs.findIndex((x) => x.id === 'goal'));
    expect(d.tabs.find((x) => x.id === 'goal')!.on).toBe(false);
    expect(shown(d.tabs).sort()).toEqual(['agents', 'artifacts', 'tasks']);
  });

  it('a detail card saved before the tab bar gets its preset’s title bar and tabs; a hidden task list is the 작업 tab off', () => {
    const legacy = {
      top: [
        { id: 'info', on: false },
        { id: 'goal', on: false },
        { id: 'needs', on: true },
        { id: 'artifacts', on: false },
      ],
      tasks: 'none',
      tasksMax: 50,
      agents: 'none',
      agenthead: false,
      sections: false,
      logtab: true,
      controls: false,
      subtitle: false,
      open: false,
    };
    const d = normalizeLayoutDoc({ v: 1, presets: { '2': { minimal: { detail: legacy } } } }).presets!['2']!.minimal!
      .detail!;
    expect(d.head).toEqual(BUILTIN_PRESETS['2'].minimal.detail.head);
    expect(shown(d.tabs)).toEqual(['goal', 'agents', 'artifacts']);
    expect(d.tasks).toBe('list');
    expect(d.tasksMax).toBe(50);
    expect(d.controls).toBe(false);
    expect(Object.keys(d).sort()).toEqual(
      ['head', 'tabs', 'tasks', 'tasksMax', 'agenthead', 'sections', 'logtab', 'controls', 'subtitle', 'open'].sort(),
    );
  });

  it('the editor names the fixed parts: the head, the chat, the composer, and 입력 필요 under the head', () => {
    expect(LAYOUT_CATALOG.detail.fixed.map((x) => x.id)).toEqual(['head', 'chat', 'composer', 'needs']);
    expect(LAYOUT_CATALOG.detail.fixed.every((x) => x.locked)).toBe(true);
    expect(LAYOUT_CATALOG.detail.tasks.map((x) => x.value)).toEqual(['runs', 'list', 'line']);
  });
});

describe('L9 — a device copy saved before the zones reads as the server migrates it (view-layout-client.ts parity, review P2)', () => {
  it('layoutOf gives a legacy detail card its preset’s title bar and tab bar; a hidden task list is the 작업 tab off', async () => {
    const { VIEW_LAYOUT_CLIENT_JS } = await import('../conversation/view-layout-client');
    const client = new Function(`${VIEW_LAYOUT_CLIENT_JS}\nreturn { layoutOf, detailSpecOf };`)() as {
      layoutOf(doc: unknown, b: unknown, p: string, m: string, s: string): unknown;
      detailSpecOf(d: unknown): unknown;
    };
    const legacy = (tasks: string) => ({
      top: [{ id: 'info', on: true }],
      tasks,
      tasksMax: 50,
      agents: 'all',
      agenthead: true,
      sections: true,
      logtab: false,
      controls: true,
      subtitle: false,
      open: true,
    });
    for (const p of PRESET_IDS)
      for (const m of VIEW_MODES)
        for (const tasks of ['none', 'list', 'runs']) {
          const doc = { v: 1, presets: { [p]: { [m]: { detail: legacy(tasks) } } } };
          const server = normalizeLayoutDoc(doc).presets![p]![m]!.detail;
          const local = client.layoutOf(doc, BUILTIN_PRESETS, p, m, 'detail');
          expect(client.detailSpecOf(local), `${p} ${m} ${tasks}`).toEqual(client.detailSpecOf(server));
        }
  });
});

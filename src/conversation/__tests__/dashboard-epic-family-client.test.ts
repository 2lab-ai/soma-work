/**
 * #1021 — an epic and its children read as one family on the dashboard (@2lab.ai/ui 0.37.0), client side.
 * Executes the shipped client code cut out of renderDashboardPage()'s template literal, cooked as the browser
 * receives it, with injected fakes — no DOM.
 *
 *   F1 an epic card carries its children (card.children): each child's key, headline and status as its own card
 *      reads it; an epic without children carries none.
 *   F2 a child drawn under its epic carries its epic (card.parent) from the board's placement map; a child not
 *      drawn under it (no underEpic) and a plain card carry none.
 *   F3 the placement map is written where the board places children (withEpicChildren) and where a push brings
 *      them (applyEpicPush).
 *   F4 the face keeps both whatever rows the layout picked (faceOf).
 *   F5 the detail card's family line: an epic folded is one line (count, names), open it lists every child as a
 *      button carrying its key; a child shows its epic; anything else shows nothing; every string escaped.
 *   F6 a press on a child (ui-child) or a family button opens that session's detail card, only for a known one;
 *      the panel repaints the line and a new opening starts folded.
 *   F7 the page runs @2lab.ai/ui 0.37.0.
 *   F8 (#1030 review) the placement map holds only what the board placed now: each render starts it empty, and a push
 *      forgets a child that left the epic's bundle.
 *   F9 (#1030 review) a bundled child the board does not show (a filter, 휴면) reads its own column, not 'idle' — its
 *      detail card offers Stop to a running child.
 *   F10 (#1030 review) each listed child is its own row to the morph (data-mk, escaped): a focused row stays on its
 *      child when the list changes.
 *   F11 (#1030 review) one family everywhere: the epic's face, its list and its detail card read the whole bundle,
 *      not the copy the board's filters kept.
 *   F12 (#1030 review) the family line is no sticky header.
 *   F13 (dev check) the family region sits inside the panel's inset like the sections around it (16px a side),
 *      not against the panel's edge.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const n = (TEMPLATE.match(new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm')) ?? []).length;
  if (n !== 1) throw new Error(`client ${name} is declared ${n} times`);
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
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const CARD_OF_FNS = [
  'toNum',
  'esc',
  'escAttr',
  'epicStateOf',
  'dhShow',
  'cardSummary',
  'pendingAutoResume',
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
  'cardLinksFace',
  'cardRepoOf',
  'cardChannelOf',
  '_hashStr',
  'ownerBadgeHue',
  'isSiblingSession',
  'cardOf',
];
const CARD_OF_VARS = [
  'PR_STATE_LABEL',
  'CARD_LINK_KIND',
  'CARD_LINK_TONES',
  'PR_STATE_TONE',
  'AGENT_STATUS_LABEL',
  'AGENT_STATUS_TONE',
  'AGENT_STATUS_GLYPH',
  'OWNER_BADGE_HUES',
  'EPIC_STATE_LABEL',
];
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
const BASE = { ownerId: 'U1', ownerName: 'Z', activityState: 'idle', lastActivity: '2026-11-06T10:00:00.000Z' };
const child = (key: string, over: Record<string, unknown> = {}) => ({
  ...BASE,
  key,
  title: key,
  parentTaskId: 'e',
  planNodeId: key,
  sessionState: 'MAIN',
  ...over,
});
const epic = (key: string, children: unknown[], over: Record<string, unknown> = {}) => ({
  ...BASE,
  key,
  title: `Epic ${key}`,
  kind: 'epic',
  epic: { state: 'running', progress: { accepted: 0, total: 2, byStatus: {} }, nodes: [], children },
  ...over,
});

function cardHarness(parentOf: Record<string, string> = {}, cache: Record<string, unknown> = Object.create(null)) {
  const map = Object.assign(Object.create(null), parentOf);
  const { cardOf } = load<{ cardOf(s: unknown, col: string): Record<string, any> }>(
    // dhShow/dhTruncate come injected (the layout's title rules); not cut out.
    CARD_OF_FNS.filter((f) => f !== 'dhShow' && f !== 'esc' && f !== 'escAttr' && f !== 'toNum').concat(['toNum']),
    CARD_OF_VARS,
    {
      STRINGS: PAGE_STRINGS,
      dhShow: () => true,
      dhTruncate: () => null,
      currentUserId: 'U1',
      _ownerIndex: null,
      SELF_INSTANCE_NAME: 'inst',
      _epicParentOf: map,
      _sessionCache: cache,
    },
  );
  return cardOf;
}

describe('F1, F2 — the card carries the family', () => {
  it('F1 — an epic card lists its children: key, headline, and the status its own card reads', () => {
    const cardOf = cardHarness();
    const card = cardOf(
      epic('task:e', [
        child('task:a', { activityState: 'working', displayHeadline: 'Split the <invoices> table' }),
        child('task:b', { activityState: 'waiting' }),
        child('task:c', { sessionState: 'SLEEPING' }),
        { title: 'no key' },
      ]),
      'working',
    );
    expect(card.children).toEqual([
      expect.objectContaining({ id: 'task:a', title: 'Split the <invoices> table', status: 'running' }),
      expect.objectContaining({ id: 'task:b', title: 'task:b', status: 'waiting' }),
      expect.objectContaining({ id: 'task:c', status: 'idle' }),
    ]);
    // Titles go to the element raw: it escapes them (the face never carries markup).
    expect(cardOf(epic('task:e', []), 'working').children).toBeUndefined();
    expect(cardOf({ ...BASE, key: 'task:p', title: 'P' }, 'idle').children).toBeUndefined();
  });

  it('F2 — a child drawn under its epic is tied to it; one not drawn there, and a plain card, are not', () => {
    const cardOf = cardHarness({ 'task:a': 'task:e' });
    expect(cardOf(child('task:a', { underEpic: true }), 'working').parent).toBe('task:e');
    // Not under its epic (its own column, an archive): no tie, only its #node lead.
    expect(cardOf(child('task:a'), 'working').parent).toBeUndefined();
    // Under an epic the map does not know (no render placed it yet): no tie.
    expect(cardOf(child('task:z', { underEpic: true }), 'working').parent).toBeUndefined();
    expect(cardOf({ ...BASE, key: 'task:p', title: 'P', underEpic: true }, 'idle').parent).toBeUndefined();
  });
});

describe('F3 — the placement map', () => {
  it('withEpicChildren records each placed child under its epic', () => {
    const map: Record<string, string> = Object.create(null);
    const m = load<{ withEpicChildren(items: unknown[]): unknown[] }>(
      ['epicChildCol', 'epicChildrenOf', 'epicKidsShown', 'withEpicChildren'],
      [],
      { _epicParentOf: map },
    );
    m.withEpicChildren([
      { s: epic('task:e', [child('task:a'), child('task:b')]), col: 'working' },
      { s: { key: 'p' } },
    ]);
    expect({ ...map }).toEqual({ 'task:a': 'task:e', 'task:b': 'task:e' });
  });

  it('applyEpicPush records each pushed child under its epic, even before a board is drawn', () => {
    const map: Record<string, string> = Object.create(null);
    const cache: Record<string, unknown> = Object.create(null);
    const m = load<{ applyEpicPush(s: unknown): void }>(['epicChildrenOf', 'epicChildOf', 'applyEpicPush'], [], {
      _epicParentOf: map,
      _sessionCache: cache,
      _lastBoardData: null,
      followupReconcile: () => {},
    });
    m.applyEpicPush(epic('task:e', [child('task:a')]));
    expect({ ...map }).toEqual({ 'task:a': 'task:e' });
    expect(cache['task:a']).toBeTruthy();
  });
});

describe('F4 — the face keeps the family whatever rows the layout picked', () => {
  const faceOf = new Function(`${VIEW_LAYOUT_CLIENT_JS}\nreturn faceOf;`)() as (
    card: Record<string, unknown>,
    model: unknown,
    face: unknown,
  ) => Record<string, unknown>;
  it('children and parent survive an empty layout; absent stays absent', () => {
    const kids = [{ id: 'a', title: 'A', status: 'running' }];
    const face = faceOf({ id: 'e', title: 'E', status: 'running', children: kids }, null, { rows: [], foot: [] });
    expect(face.children).toBe(kids);
    expect(faceOf({ id: 'a', title: 'A', status: 'running', parent: 'e' }, null, { rows: [], foot: [] }).parent).toBe(
      'e',
    );
    const plain = faceOf({ id: 'p', title: 'P', status: 'idle', children: [] }, null, { rows: [], foot: [] });
    expect('children' in plain).toBe(false);
    expect('parent' in plain).toBe(false);
  });
});

describe('F5 — the detail card’s family line', () => {
  function familyHarness(cache: Record<string, unknown>, parentOf: Record<string, string> = {}) {
    const cardOf = cardHarness(parentOf);
    return load<{ panelFamilyHtml(s: unknown, open: boolean): string }>(
      [
        'epicChildCol',
        'epicChildrenOf',
        'epicFamilyOf',
        'epicChildFace',
        'epicChildOf',
        'epicOfChild',
        'panelFamilyHtml',
      ],
      ['PANEL_FAMILY_DOT', 'PANEL_FAMILY_STATUS'],
      {
        cardOf,
        esc: (t: unknown) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        escAttr: (t: unknown) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
        _sessionCache: cache,
        _epicParentOf: Object.assign(Object.create(null), parentOf),
      },
    );
  }
  const E = epic('task:e', [
    child('task:a', { activityState: 'working', title: 'A <b>bold</b>' }),
    child('task:b', { activityState: 'waiting' }),
  ]);

  it('an epic folded: one line — the count and every child’s name, aria-expanded false, no list', () => {
    const { panelFamilyHtml } = familyHarness({ 'task:e': E });
    const html = panelFamilyHtml(E, false);
    expect(html).toContain('자식 작업 2');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('A &lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>bold');
    expect(html).not.toContain('pf-list');
    expect(html).toContain('onclick="togglePanelFamily()"');
  });

  it('an epic open: every child as a button with its key and its status word', () => {
    const { panelFamilyHtml } = familyHarness({ 'task:e': E });
    const html = panelFamilyHtml(E, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="panel-family-list"');
    expect(html.match(/class="pf-kid"/g)).toHaveLength(2);
    expect(html).toContain('data-family-key="task:a"');
    expect(html).toContain('data-family-key="task:b"');
    expect(html).toContain('실행 중');
    expect(html).toContain('입력 대기');
    // No value in inline script: the key is a data attribute the handler reads.
    expect(html).not.toMatch(/onclick="[^"]*task:/);
  });

  it('a child shows its epic, which opens on a press; a plain card or an epic with no children shows nothing', () => {
    const a = (E.epic.children as Array<Record<string, unknown>>)[0];
    const { panelFamilyHtml } = familyHarness({ 'task:e': E, 'task:a': a }, { 'task:a': 'task:e' });
    const html = panelFamilyHtml(a, false);
    expect(html).toContain('에픽');
    expect(html).toContain('Epic task:e');
    expect(html).toContain('data-family-key="task:e"');
    // Found through the cached epic's bundle when the board did not place it (a deep link).
    const deep = familyHarness({ 'task:e': E, 'task:a': a });
    expect(deep.panelFamilyHtml(a, false)).toContain('data-family-key="task:e"');
    expect(panelFamilyHtml({ ...BASE, key: 'task:p', title: 'P' }, false)).toBe('');
    expect(panelFamilyHtml(epic('task:x', []), true)).toBe('');
    expect(panelFamilyHtml(null, false)).toBe('');
  });
});

describe('F6 — opening a family member', () => {
  it('opens a known session’s detail card, ignores an unknown or empty key', () => {
    const openPanel = vi.fn();
    const m = load<{ openFamilyCardKey(key: string): void; openFamilyCard(btn: unknown): void }>(
      ['openFamilyCardKey', 'openFamilyCard'],
      [],
      { openPanel, _sessionCache: { 'task:a': { key: 'task:a' } } },
    );
    m.openFamilyCardKey('task:a');
    m.openFamilyCardKey('task:zz');
    m.openFamilyCardKey('');
    m.openFamilyCard({ getAttribute: () => 'task:a' });
    m.openFamilyCard(null);
    expect(openPanel.mock.calls).toEqual([['task:a'], ['task:a']]);
  });

  it('the board sends ui-child there, the panel repaints the line, and a new opening starts folded', () => {
    const wire = clientFn('wireInbox');
    expect(wire).toMatch(
      /addEventListener\('ui-child', function\(e\) \{\s*if \(e\.target !== host \|\| !e\.detail\) return;\s*openFamilyCardKey\(String\(e\.detail\.childId\)\);/,
    );
    expect(clientFn('repaintPanelSession')).toContain('renderPanelFamily();');
    expect(clientFn('resetPanelSections')).toContain('_panelFamilyOpen = false;');
    expect(TEMPLATE).toContain('id="panel-family"');
  });
});

describe('F7 — the page runs @2lab.ai/ui 0.37.0', () => {
  it('package.json pins it', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
    expect(pkg.dependencies['@2lab.ai/ui']).toBe('0.37.0');
  });
});

describe('F8 — the placement map holds only what the board placed now', () => {
  it('each render starts the map empty, as it does the drawn children', () => {
    const render = clientFn('renderBoard');
    expect(render).toMatch(/_epicKidsDrawn = Object\.create\(null\);\s*_epicParentOf = Object\.create\(null\);/);
  });

  it('a push forgets a child that left the epic’s bundle, and keeps every other epic’s', () => {
    const map: Record<string, string> = Object.assign(Object.create(null), {
      'task:a': 'task:e',
      'task:gone': 'task:e',
      'task:y': 'task:other',
    });
    const m = load<{ applyEpicPush(s: unknown): void }>(['epicChildrenOf', 'epicChildOf', 'applyEpicPush'], [], {
      _epicParentOf: map,
      _sessionCache: Object.create(null),
      _lastBoardData: null,
      followupReconcile: () => {},
    });
    m.applyEpicPush(epic('task:e', [child('task:a'), child('task:b')]));
    expect({ ...map }).toEqual({ 'task:a': 'task:e', 'task:b': 'task:e', 'task:y': 'task:other' });
    m.applyEpicPush(epic('task:e', []));
    expect({ ...map }).toEqual({ 'task:y': 'task:other' });
  });
});

describe('F9 — a bundled child the board does not show reads its own column', () => {
  function colHarness(cardCol: Record<string, string>, board: unknown, cache: Record<string, unknown>) {
    return load<{ sessionColOf(key: string): string }>(['epicChildCol', 'epicChildOf', 'sessionColOf'], [], {
      _cardCol: cardCol,
      _lastBoardData: board,
      _sessionCache: cache,
    }).sessionColOf;
  }
  const a = child('task:a', { activityState: 'working', underEpic: true });
  const s = child('task:s', { sessionState: 'SLEEPING', underEpic: true });
  const E = epic('task:e', [a, s]);
  const board = { working: [E], waiting: [], idle: [], closed: [] };

  it('from its epic’s bundle on the board: a running child is working, a sleeping one closed', () => {
    const col = colHarness({}, board, { 'task:e': E, 'task:a': a, 'task:s': s });
    expect(col('task:a')).toBe('working');
    expect(col('task:s')).toBe('closed');
    expect(col('task:e')).toBe('working');
    expect(col('task:nobody')).toBe('idle');
  });

  it('a drawn card’s own column still wins; before any board a cached child reads its own activity', () => {
    expect(colHarness({ 'task:a': 'waiting' }, board, { 'task:a': a })('task:a')).toBe('waiting');
    const w = child('task:w', { activityState: 'waiting', underEpic: true });
    expect(colHarness({}, null, { 'task:w': w })('task:w')).toBe('waiting');
    // A card that is no bundled child and sits nowhere is idle, as before.
    expect(colHarness({}, null, { 'task:p': { ...BASE, key: 'task:p', activityState: 'working' } })('task:p')).toBe(
      'idle',
    );
  });
});

describe('F10 — each listed child is its own row to the morph', () => {
  it('every list row carries its child’s key as data-mk, escaped', () => {
    const cardOf = cardHarness();
    const E = epic('task:e', [child('task:a'), child('task:"q<')]);
    const m = load<{ panelFamilyHtml(s: unknown, open: boolean): string }>(
      [
        'epicChildCol',
        'epicChildrenOf',
        'epicFamilyOf',
        'epicChildFace',
        'epicChildOf',
        'epicOfChild',
        'panelFamilyHtml',
      ],
      ['PANEL_FAMILY_DOT', 'PANEL_FAMILY_STATUS'],
      {
        cardOf,
        esc: (t: unknown) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        escAttr: (t: unknown) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
        _sessionCache: { 'task:e': E },
      },
    );
    const html = m.panelFamilyHtml(E, true);
    expect(html).toContain('<li data-mk="pf:task:a">');
    expect(html).toContain('<li data-mk="pf:task:&quot;q&lt;">');
    expect(html).not.toContain('data-mk="pf:task:"q');
  });
});

describe('F11 — one family everywhere: the whole bundle, not the filtered copy', () => {
  const a = child('task:a', { activityState: 'working' });
  const b = child('task:b', { activityState: 'waiting' });
  const whole = epic('task:e', [a, b]);
  // What the board's filters hand the columns (boardViewOf): a copy holding only the children it draws.
  const kept = { ...whole, epic: { ...whole.epic, children: [a] } };

  it('the epic’s face lists every child although the filters kept one under its card', () => {
    const cardOf = cardHarness({}, { 'task:e': whole });
    expect((cardOf(kept, 'working').children as Array<{ id: string }>).map((k) => k.id)).toEqual(['task:a', 'task:b']);
    // No cached epic (a card the page never cached): its own bundle.
    expect((cardHarness()(kept, 'working').children as Array<{ id: string }>).map((k) => k.id)).toEqual(['task:a']);
  });

  it('the detail card’s line counts the same family', () => {
    const cardOf = cardHarness({}, { 'task:e': whole });
    const m = load<{ panelFamilyHtml(s: unknown, open: boolean): string }>(
      [
        'epicChildCol',
        'epicChildrenOf',
        'epicFamilyOf',
        'epicChildFace',
        'epicChildOf',
        'epicOfChild',
        'panelFamilyHtml',
      ],
      ['PANEL_FAMILY_DOT', 'PANEL_FAMILY_STATUS'],
      { cardOf, esc: String, escAttr: String, _sessionCache: { 'task:e': whole } },
    );
    expect(m.panelFamilyHtml(kept, false)).toContain('자식 작업 2');
  });
});

describe('F12 — the family line is no sticky header', () => {
  it('every family line is static (the task line it borrows from sticks to the top)', () => {
    expect(TEMPLATE).toContain('.pf-line { position: static; }');
  });
});

describe('F13 — the family region sits inside the panel’s inset', () => {
  it('16px a side, as the task line and the goal around it', () => {
    expect(TEMPLATE).toContain('.panel-family { padding: 4px 16px 8px; }');
    expect(TEMPLATE).not.toContain('.panel-family { margin: 4px 0 8px; }');
  });
});

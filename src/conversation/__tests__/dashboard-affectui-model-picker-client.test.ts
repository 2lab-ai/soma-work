/**
 * affectUI Model Picker → the dashboard's model · effort picker, client half
 * (.prd/affectui/re-model-picker.md §4 D1–D18). The trigger and its menu are
 * @2lab.ai/ui <ui-model-picker> — the element the inline menu was ported to.
 * Executes the shipped page code cut out of renderDashboardPage()'s template
 * literal and cooked exactly as the browser receives it, with injected fakes:
 * the host contract.
 *
 *   slot      the owner's element per surface (card strip, panel composer) in a
 *             token wrapper; read-only viewers keep the plain text
 *   data      mpData — the representative models keyed by nickname, the
 *             session's model (outside the list: its short id), the levels its
 *             model runs, the context, the writes in flight, the last refusal
 *   events    ui-change → changeModel / changeEffort (cancelled: the server
 *             decides), ui-open-change (closed) → the held surfaces repaint
 *   guards    one write per session and operation, an open menu holds its
 *             surface still while its data follows the session
 *
 * What the element itself does — the listbox and its keys, Tab past the last
 * stop going home (D9), the meters, the tray and its roll, placement, closing
 * when its trigger moves or leaves the view, the effort radiogroup, locked rows,
 * the error and waiting lines, motion and touch sizes — is owned by the
 * library's suite (@2lab.ai/ui src/components/model-picker/model-picker.test.ts);
 * the list at the end names the library test that now covers each moved test.
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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const STYLE = TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>')));
const HEAD = TEMPLATE.slice(0, TEMPLATE.indexOf('<style>'));

const MODELS = [
  {
    nickname: 'opus[1m]',
    model: 'claude-opus-5-5[1m]',
    label: 'Opus 5.5 (1M)',
    contextWindow: 1_000_000,
    autoCompactTokens: 750_000,
    price: { input: 5, output: 25 },
  },
  {
    nickname: 'sonnet[1m]',
    model: 'claude-sonnet-4-6[1m]',
    label: 'Sonnet 4.6 (1M)',
    contextWindow: 1_000_000,
    autoCompactTokens: 750_000,
    price: { input: 3, output: 15 },
  },
  {
    nickname: 'grok[1m]',
    model: 'grok-4.6',
    label: 'Grok 4.6 (500k)',
    contextWindow: 500_000,
    autoCompactTokens: 450_000,
  },
];
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const KEY = 'inst::C1:t1';
const sess = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  model: 'claude-opus-5-5[1m]',
  effort: 'high',
  contextTokens: 500_000,
  ...over,
});

type Data = {
  models: Array<Record<string, unknown>>;
  value: Record<string, unknown>;
  contextTokens: number;
  busy: { model: boolean | string; effort: boolean };
  error?: string;
};
function mapper(notes: Record<string, unknown> = {}) {
  return load<{
    mpData(s: unknown): Data;
    setBusy(k: string, op: string, on: boolean): void;
    renderModelPicker(s: unknown, can: boolean, short: string, surface?: string): string;
    renderModelNote(s: unknown, picker?: boolean): string;
  }>(
    [
      'esc',
      'escAttr',
      'toNum',
      'isBusy',
      'setBusy',
      'mpShort',
      'mpEffortLevels',
      'mpData',
      'renderModelPicker',
      'renderModelNote',
    ],
    ['_busy'],
    { REPRESENTATIVE_MODELS: MODELS, EFFORT_LEVELS: LEVELS, _modelNotes: notes },
  );
}

// ── D1 — the slot ──
describe('D1 — one <ui-model-picker> per surface for the owner; others read the text', () => {
  it('the owner gets the element in a token wrapper, named by its session and surface', () => {
    const m = mapper();
    const card = m.renderModelPicker(sess(), true, 'opus-5-5[1m]', 'card');
    expect(card).toBe(
      `<span class="ui-tok mp-slot" data-mk="mp|card|${KEY}"><ui-model-picker lang="ko" data-mp-key="${KEY}" data-mp-surface="card">` +
        '<span class="mp-fallback">opus-5-5[1m]</span></ui-model-picker></span>',
    );
    expect(card).not.toContain('<select');
    // The composer's menu opens above its trigger.
    expect(m.renderModelPicker(sess(), true, 'opus-5-5[1m]', 'panel')).toContain(
      `<ui-model-picker lang="ko" side="top" data-mp-key="${KEY}" data-mp-surface="panel">`,
    );
  });

  it('the key is attribute-escaped; an unnamed model reads 모델 until the library loads', () => {
    const m = mapper();
    const html = m.renderModelPicker(sess({ key: 'self::C1:t\'1"' }), true, '', 'card');
    expect(html).toContain('data-mk="mp|card|self::C1:t&#39;1&quot;"');
    expect(html).toContain('data-mp-key="self::C1:t&#39;1&quot;"');
    expect(html).toContain('<span class="mp-fallback">모델</span>');
  });

  it('read-only viewers keep the plain text, byte for byte', () => {
    expect(mapper().renderModelPicker(sess(), false, 'opus-5-5[1m]', 'card')).toBe(
      '<span class="cb-model-name">opus-5-5[1m]</span>',
    );
  });

  it('the card strip: the owner gets the element alone, others the text and the level', () => {
    const body = clientFn('renderCardBody');
    expect(body).toContain("if (canSwitchModel) modelParts.push(renderModelPicker(s, true, modelShort, 'card'));");
    expect(body).toContain('if (s.effort) modelParts.push(renderEffortPicker(s));');
    expect(body).toContain('const modelNote = renderModelNote(s, canSwitchModel);');
    // The owner's control: a live, non-sibling session (the server re-checks owner / admin on both routes).
    expect(body).toContain(
      "const canSwitchModel = isOwner && col !== 'closed' && !s.terminated && !isSiblingSession(s);",
    );
  });
});

// ── D3–D8 / D11 — the data the dashboard maps the session onto ──
describe('mpData — the session as the element’s data', () => {
  it('the representative models in server order, keyed by nickname; no price stays unknown', () => {
    const d = mapper().mpData(sess());
    expect(d.models).toEqual([
      {
        id: 'opus[1m]',
        label: 'Opus 5.5 (1M)',
        short: 'opus[1m]',
        window: 1_000_000,
        autoCompactAt: 750_000,
        price: { input: 5, output: 25 },
      },
      {
        id: 'sonnet[1m]',
        label: 'Sonnet 4.6 (1M)',
        short: 'sonnet[1m]',
        window: 1_000_000,
        autoCompactAt: 750_000,
        price: { input: 3, output: 15 },
      },
      {
        id: 'grok[1m]',
        label: 'Grok 4.6 (500k)',
        short: 'grok[1m]',
        window: 500_000,
        autoCompactAt: 450_000,
        price: null,
      },
    ]);
    expect(d.contextTokens).toBe(500_000);
  });

  it('value: the nickname of the row the session runs, the level set and the level that runs', () => {
    const d = mapper().mpData(sess({ model: 'claude-sonnet-4-6[1m]', effort: 'max', effortEffective: 'high' }));
    expect(d.value).toEqual({ model: 'sonnet[1m]', effort: 'max', effectiveEffort: 'high', effortLevels: LEVELS });
  });

  it('a model outside the list is named by its short id (the element’s first, unselectable row)', () => {
    const d = mapper().mpData(sess({ model: 'claude-haiku-4-5-20251001' }));
    expect(d.value.model).toBe('haiku-4-5');
    expect(d.models.map((x) => x.id)).not.toContain('haiku-4-5');
  });

  it('value.effortLevels: the levels the session’s model runs (catalog ∩ levels), all five without a menu — also outside the list', () => {
    const m = mapper();
    expect(m.mpData(sess({ effortLevels: ['high', 'low'] })).value.effortLevels).toEqual(['low', 'high']);
    expect(
      m.mpData(sess({ model: 'claude-haiku-4-5-20251001', effortLevels: ['low', 'medium', 'high'] })).value,
    ).toMatchObject({ model: 'haiku-4-5', effortLevels: ['low', 'medium', 'high'] });
    expect(m.mpData(sess()).value.effortLevels).toEqual(LEVELS);
    expect(m.mpData(sess({ effortLevels: [] })).value.effortLevels).toEqual(LEVELS);
    expect(m.mpData(sess({ effortLevels: ['ultra'] })).value.effortLevels).toEqual(LEVELS);
  });

  it('busy: a switch waiting for its compaction says so; a write in flight locks its part', () => {
    const m = mapper();
    expect(m.mpData(sess()).busy).toEqual({ model: false, effort: false });
    expect(m.mpData(sess({ pendingModel: 'grok[1m]' })).busy.model).toBe('compact 후 grok[1m](으)로 전환 대기 중');
    m.setBusy(KEY, 'model', true);
    expect(m.mpData(sess()).busy).toEqual({ model: true, effort: false });
    m.setBusy(KEY, 'model', false);
    m.setBusy(KEY, 'effort', true);
    expect(m.mpData(sess()).busy).toEqual({ model: false, effort: true });
  });

  it('error: the last refused write only — an info note is the host’s line', () => {
    const notes: Record<string, unknown> = {};
    const m = mapper(notes);
    expect(m.mpData(sess())).not.toHaveProperty('error');
    notes[KEY] = { text: 'sonnet[1m](으)로 전환 · autocompact 750.0K', error: false };
    expect(m.mpData(sess())).not.toHaveProperty('error');
    notes[KEY] = { text: '실행 중인 턴이 있어 전환할 수 없습니다', error: true };
    expect(m.mpData(sess()).error).toBe('실행 중인 턴이 있어 전환할 수 없습니다');
  });

  it('renderModelNote: beside the picker only the info note — the element says waiting and refusals itself', () => {
    const notes: Record<string, unknown> = {};
    const m = mapper(notes);
    const waiting = sess({ pendingModel: 'grok[1m]' });
    expect(m.renderModelNote(waiting, true)).toBe('');
    // D7 (A-08): the note is the kit's status line (.ui-status-line), a refusal in the fail tone.
    expect(m.renderModelNote(waiting, false)).toBe(
      '<div class="ui-status-line cb-model-note" role="status">compact 후 grok[1m](으)로 전환합니다…</div>',
    );
    notes[KEY] = { text: 'HTTP 409', error: true };
    expect(m.renderModelNote(sess(), true)).toBe('');
    expect(m.renderModelNote(sess(), false)).toBe(
      '<div class="ui-status-line cb-model-note" data-tone="fail" role="alert">HTTP 409</div>',
    );
    notes[KEY] = { text: '이미 opus[1m]입니다', error: false };
    expect(m.renderModelNote(sess(), true)).toBe(
      '<div class="ui-status-line cb-model-note" role="status">이미 opus[1m]입니다</div>',
    );
  });
});

// ── D12 — the data follows the session ──
describe('mpHydrate — every picker under a root takes its session’s data, only where it changed', () => {
  function setup() {
    const cache: Record<string, unknown> = { [KEY]: sess() };
    const el = (key: string) => {
      const sets: unknown[] = [];
      const node: Record<string, unknown> = {
        getAttribute: (n: string) => (n === 'data-mp-key' ? key : null),
        sets,
      };
      Object.defineProperty(node, 'data', { set: (v) => sets.push(v), get: () => sets[sets.length - 1] });
      return node as { sets: unknown[]; data: Data };
    };
    const a = el(KEY);
    const gone = el('gone::C9:t9');
    let selector = '';
    const root = {
      querySelectorAll: (sel: string) => {
        selector = sel;
        return [a, gone];
      },
    };
    const m = load<{ mpHydrate(root: unknown): void; setBusy(k: string, op: string, on: boolean): void }>(
      ['toNum', 'isBusy', 'setBusy', 'mpShort', 'mpEffortLevels', 'mpData', 'mpDataSig', 'mpHydrate'],
      ['_busy'],
      { REPRESENTATIVE_MODELS: MODELS, EFFORT_LEVELS: LEVELS, _modelNotes: {}, _sessionCache: cache },
    );
    return { m, a, gone, root, cache, selector: () => selector };
  }

  it('sets the data once; a pass that changes nothing writes nothing; a change writes again', () => {
    const { m, a, gone, root, cache, selector } = setup();
    m.mpHydrate(root);
    expect(selector()).toBe('ui-model-picker[data-mp-key]');
    expect(a.sets).toHaveLength(1);
    expect(a.data.value.model).toBe('opus[1m]');
    expect(gone.sets).toHaveLength(0); // no session, no data
    m.mpHydrate(root);
    expect(a.sets).toHaveLength(1);
    cache[KEY] = sess({ model: 'claude-sonnet-4-6[1m]' });
    m.mpHydrate(root);
    expect(a.sets).toHaveLength(2);
    expect(a.data.value.model).toBe('sonnet[1m]');
    m.setBusy(KEY, 'effort', true);
    m.mpHydrate(root);
    expect(a.data.busy.effort).toBe(true);
    m.mpHydrate(null);
  });

  // #546 review P3: a field-tuple signature, not JSON.stringify(mpData(s)) on every card render.
  it('mpData is built only when a field it reads changed (mpDataSig) — every such field writes again', () => {
    let built = 0;
    const cache: Record<string, Record<string, unknown>> = { [KEY]: sess() };
    const notes: Record<string, { text: string; error: boolean }> = {};
    const sets: unknown[] = [];
    const node: Record<string, unknown> = { getAttribute: (n: string) => (n === 'data-mp-key' ? KEY : null) };
    Object.defineProperty(node, 'data', { set: (v) => sets.push(v) });
    const root = { querySelectorAll: () => [node] };
    const m = load<{ mpHydrate(root: unknown): void; setBusy(k: string, op: string, on: boolean): void }>(
      ['toNum', 'isBusy', 'setBusy', 'mpDataSig', 'mpHydrate'],
      ['_busy'],
      {
        _sessionCache: cache,
        _modelNotes: notes,
        mpData: () => {
          built++;
          return { n: built };
        },
      },
    );
    m.mpHydrate(root);
    m.mpHydrate(root);
    expect([built, sets.length]).toEqual([1, 1]);
    const changes: Array<() => void> = [
      () => (cache[KEY] = sess({ model: 'claude-sonnet-4-6[1m]' })),
      () => (cache[KEY] = { ...cache[KEY], effort: 'max' }),
      () => (cache[KEY] = { ...cache[KEY], effortEffective: 'high' }),
      () => (cache[KEY] = { ...cache[KEY], pendingModel: 'fable[1m]' }),
      () => (cache[KEY] = { ...cache[KEY], contextTokens: 600_000 }),
      () => (cache[KEY] = { ...cache[KEY], effortLevels: ['low', 'high'] }),
      () => m.setBusy(KEY, 'model', true),
      () => m.setBusy(KEY, 'effort', true),
      () => (notes[KEY] = { text: '전환 실패', error: true }),
      () => (notes[KEY] = { text: '다른 실패', error: true }),
    ];
    for (const [i, change] of changes.entries()) {
      change();
      m.mpHydrate(root);
      m.mpHydrate(root);
      expect([built, sets.length], `change ${i}`).toEqual([i + 2, i + 2]);
    }
    // An info note is the host's line, not the picker's data: nothing to write.
    notes[KEY] = { text: 'effort 높음 · 다음 턴부터 적용', error: false };
    m.mpHydrate(root);
    expect(built).toBe(changes.length + 2);
    expect(clientFn('mpHydrate')).not.toContain('JSON.stringify');
  });

  it('runs on every open card body paint and every panel-controls pass — also while an open menu holds them', () => {
    const morphs: string[] = [];
    const hydrated: unknown[] = [];
    let picking = false;
    const body = { parentNode: null as unknown, setAttribute: () => {} };
    const host = {
      appendChild: (k: typeof body) => {
        k.parentNode = host;
      },
    };
    const cache: Record<string, unknown> = { [KEY]: sess() };
    const expanded = new Set<string>();
    const m = load<{ paintCardBody(k: string): void }>(['cardBodyShown', 'paintCardBody'], [], {
      _cardHost: { [KEY]: host },
      _cardCol: { [KEY]: 'working' },
      _cardDrawn: { [KEY]: true },
      _cardBodies: {},
      _sessionCache: cache,
      _expanded: expanded,
      _cardClosing: {},
      document: { createElement: () => body },
      renderCardBody: (s: { model: string }) => `[BODY:${s.model}]`,
      isAdvanced: () => true,
      // The view plan (.prd/20): advanced 2안 원본 — no spec, the open card and the face as they were.
      viewSpec: () => ({
        detail: {
          show: ['subtitle', 'info', 'goal', 'artifacts', 'agenthead', 'agenttabs', 'sections', 'controls'],
          tasks: 'runs',
          open: true,
        },
      }),
      detailShows: () => true,
      faceOf: (c: unknown) => c,
      isPickingModel: () => picking,
      morphInnerHtml: (_e: unknown, h: string) => morphs.push(h),
      updateTimersIn: () => {},
      acHydrate: () => {},
      cardTaskPlanHydrate: () => {},
      mpHydrate: (root: unknown) => hydrated.push(root),
      atCardData: () => null,
      atHydrate: () => {},
    });
    // #548: a collapsed card has no body, so no picker to hydrate.
    m.paintCardBody(KEY);
    expect(hydrated).toHaveLength(0);
    expanded.add(KEY);
    m.paintCardBody(KEY);
    expect(morphs).toEqual(['[BODY:claude-opus-5-5[1m]]']);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toBe(body);
    // An open menu holds the body still; its picker still takes the session's data.
    picking = true;
    cache[KEY] = sess({ model: 'claude-sonnet-4-6[1m]' });
    m.paintCardBody(KEY);
    expect(morphs).toHaveLength(1);
    expect(hydrated).toHaveLength(2);
    expect(hydrated[1]).toBe(body);
    // Closed (ui-open-change → refreshCard): the held body catches up.
    picking = false;
    m.paintCardBody(KEY);
    expect(morphs).toEqual(['[BODY:claude-opus-5-5[1m]]', '[BODY:claude-sonnet-4-6[1m]]']);
    const panel = clientFn('renderPanelControls');
    expect(panel.trim().endsWith('mpHydrate(el);\n}')).toBe(true);
  });
});

// ── D11 / D15–D17 — the element's events ──
describe('ui-change → the existing writes; the server decides', () => {
  function setup() {
    const changeModel = vi.fn();
    const changeEffort = vi.fn();
    const m = load<{ mpOnChange(e: unknown): void }>(['mpOnChange'], [], { changeModel, changeEffort });
    const picker = { tagName: 'UI-MODEL-PICKER', getAttribute: (n: string) => (n === 'data-mp-key' ? KEY : null) };
    const fire = (detail: unknown, target: unknown = picker) => {
      const e = { target, detail, preventDefault: vi.fn() };
      m.mpOnChange(e);
      return e;
    };
    return { changeModel, changeEffort, fire };
  }

  it('a model pick is cancelled (no optimistic value) and posted for its session', () => {
    const { changeModel, changeEffort, fire } = setup();
    const e = fire({ model: 'grok[1m]', effort: 'high', changed: 'model' });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(changeModel).toHaveBeenCalledWith(KEY, 'grok[1m]');
    expect(changeEffort).not.toHaveBeenCalled();
  });

  it('a level pick is cancelled and posted as effort', () => {
    const { changeModel, changeEffort, fire } = setup();
    const e = fire({ model: 'opus[1m]', effort: 'low', changed: 'effort' });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(changeEffort).toHaveBeenCalledWith(KEY, 'low');
    expect(changeModel).not.toHaveBeenCalled();
  });

  it('another element’s ui-change (the usage breakdown) is not the picker’s', () => {
    const { changeModel, changeEffort, fire } = setup();
    const e = fire({ value: 'user' }, { tagName: 'UI-COMPACT-BREAKDOWN', id: 'usage-cb', getAttribute: () => null });
    expect(e.preventDefault).not.toHaveBeenCalled();
    fire(null);
    expect(changeModel).not.toHaveBeenCalled();
    expect(changeEffort).not.toHaveBeenCalled();
  });

  it('the page listens once, at the document (the events are composed)', () => {
    expect(TEMPLATE).toContain("\ndocument.addEventListener('ui-change', mpOnChange);\n");
    expect(TEMPLATE).toContain("\ndocument.addEventListener('ui-open-change', mpOnOpenChange);\n");
    expect(declarationCount('mpOnChange')).toBe(1);
    expect(declarationCount('mpOnOpenChange')).toBe(1);
  });
});

describe('ui-open-change — a closed menu lets its surfaces catch up (D12)', () => {
  it('closed: the card and the panel controls repaint; opened: nothing', () => {
    const refreshCard = vi.fn();
    const repaintPanelControlsFor = vi.fn();
    const m = load<{ mpOnOpenChange(e: unknown): void }>(['mpOnOpenChange'], [], {
      refreshCard,
      repaintPanelControlsFor,
    });
    const picker = { tagName: 'UI-MODEL-PICKER', getAttribute: (n: string) => (n === 'data-mp-key' ? KEY : null) };
    m.mpOnOpenChange({ target: picker, detail: { open: true } });
    expect(refreshCard).not.toHaveBeenCalled();
    m.mpOnOpenChange({ target: picker, detail: { open: false } });
    expect(refreshCard).toHaveBeenCalledWith(KEY);
    expect(repaintPanelControlsFor).toHaveBeenCalledWith(KEY);
    m.mpOnOpenChange({ target: { tagName: 'UI-AGENT-TREE', getAttribute: () => KEY }, detail: { open: false } });
    expect(refreshCard).toHaveBeenCalledTimes(1);
  });
});

describe('D11 — one write per session and operation, by value', () => {
  it('a second model switch while the first is pending is refused; the peer surface shows busy at once', async () => {
    let release: (v: unknown) => void = () => {};
    const posts: string[] = [];
    const peer: boolean[] = [];
    const notes: Record<string, unknown> = {};
    const m = load<{ changeModel(k: string, n: string): Promise<void>; isBusy(k: string, op: string): boolean }>(
      ['isBusy', 'setBusy', 'modelSwitchNote', 'changeModel'],
      ['_busy'],
      {
        postModelSwitch: (_k: string, nick: string) => {
          posts.push(nick);
          return new Promise((r) => (release = r));
        },
        _modelNotes: notes,
        formatTokens: String,
        refreshCard: () => {},
        repaintPanelControlsFor: () => peer.push(m.isBusy('k', 'model')),
        loadSessions: () => {},
      },
    );
    const first = m.changeModel('k', 'sonnet[1m]');
    expect(peer).toEqual([true]);
    await m.changeModel('k', 'fable[1m]');
    expect(posts).toEqual(['sonnet[1m]']);
    release({ ok: true, result: { status: 'switched', nickname: 'sonnet[1m]', autoCompactTokens: 750000 } });
    await first;
    expect(m.isBusy('k', 'model')).toBe(false);
    expect(notes.k).toEqual({ text: 'sonnet[1m](으)로 전환 · 자동 압축 750000', error: false });
  });

  it('an effort change the server accepted is the session’s level at once (the open menu does not wait for the poll)', async () => {
    const cache: Record<string, { key: string; effort: string; effortEffective?: string }> = {
      k: { key: 'k', effort: 'max', effortEffective: 'high' },
    };
    const repaints: string[] = [];
    const m = load<{ changeEffort(k: string, l: string): Promise<void> }>(
      ['isBusy', 'setBusy', 'effortLabel', 'effortSwitchNote', 'mpApplyEffort', 'changeEffort'],
      ['_busy', 'EFFORT_LABELS'],
      {
        postEffortSwitch: async () => ({ ok: true, result: { status: 'switched', effort: 'low', effective: 'low' } }),
        _modelNotes: {},
        _sessionCache: cache,
        // Both surfaces hydrate their pickers on repaint (also a held one).
        refreshCard: () => repaints.push(`card:${cache.k.effort}`),
        repaintPanelControlsFor: () => repaints.push(`panel:${cache.k.effort}`),
        loadSessions: () => {},
      },
    );
    await m.changeEffort('k', 'low');
    expect(cache.k.effort).toBe('low');
    expect(cache.k.effortEffective).toBeUndefined();
    expect(repaints).toEqual(['card:max', 'panel:max', 'card:low', 'panel:low']);
  });
});

// ── D12 — live repaint guards ──
describe('D12 — an open menu holds its surface still', () => {
  it('isPickingModel sees an open picker inside the root', () => {
    const m = load<{ isPickingModel(root: unknown): boolean }>(['isPickingModel'], []);
    expect(m.isPickingModel({ querySelector: (s: string) => (s === 'ui-model-picker[open]' ? {} : null) })).toBe(true);
    expect(m.isPickingModel({ querySelector: () => null })).toBe(false);
    expect(m.isPickingModel(null)).toBe(false);
  });

  it('the panel controls: the element after "이 세션" for the owner, text for others; held while open, the data still set', () => {
    const writes: string[] = [];
    const hydrated: unknown[] = [];
    let open = false;
    const picker = { getAttribute: (n: string) => (n === 'data-mp-key' ? 'k' : null) };
    const el = { _html: '', querySelector: (s: string) => (open && s === 'ui-model-picker[open]' ? picker : null) };
    const m = load<{ renderPanelControls(s: unknown): void }>(['isPickingModel', 'renderPanelControls'], [], {
      document: { getElementById: (id: string) => (id === 'panel-controls' ? el : null) },
      currentUserId: 'U1',
      isSiblingSession: () => false,
      esc: (x: string) => x,
      renderModelPicker: (_s: unknown, can: boolean, _short: string, surface: string) => `[M:${can}:${surface}]`,
      renderEffortPicker: () => '[E]',
      renderModelNote: (_s: unknown, picker: boolean) => `[NOTE:${picker}]`,
      morphInnerHtml: (_e: unknown, h: string) => writes.push(h),
      mpHydrate: (root: unknown) => hydrated.push(root),
    });
    m.renderPanelControls({ key: 'k', ownerId: 'U1', model: 'claude-opus-5-5[1m]', effort: 'high' });
    expect(writes[writes.length - 1]).toBe('<span class="pc-scope">이 세션</span>[M:true:panel][NOTE:true]');
    m.renderPanelControls({ key: 'k2', ownerId: 'U2', model: 'claude-opus-5-5[1m]', effort: 'high' });
    expect(writes[writes.length - 1]).toBe('<span class="pc-scope">이 세션</span>[M:false:panel][E][NOTE:false]');
    // A sleeping or terminated session reads the text.
    m.renderPanelControls({ key: 'k', ownerId: 'U1', model: 'm', sessionState: 'SLEEPING' });
    expect(writes[writes.length - 1]).toContain('[M:false:panel]');
    open = true;
    const before = writes.length;
    const passes = hydrated.length;
    m.renderPanelControls({ key: 'k', ownerId: 'U1', model: 'claude-fable-5-1[1m]', effort: 'low' });
    expect(writes.length).toBe(before);
    expect(hydrated.length).toBe(passes + 1); // the open menu follows the session through its data
    expect(hydrated[hydrated.length - 1]).toBe(el);
  });

  // #546 review P3: openPanel from a deep link (?session=) can move the panel to another session
  // while the menu is open — the held picker is the OLD session's, so it is not held.
  it('the panel moved to another session under an open menu: that menu closes and the controls follow the new session', () => {
    const writes: string[] = [];
    const hydrated: unknown[] = [];
    const picker: Record<string, unknown> = {
      open: true,
      getAttribute: (n: string) => (n === 'data-mp-key' ? 'old' : null),
    };
    const el = {
      _html: '',
      querySelector: (s: string) => (picker.open && s === 'ui-model-picker[open]' ? picker : null),
    };
    const m = load<{ renderPanelControls(s: unknown): void }>(['isPickingModel', 'renderPanelControls'], [], {
      document: { getElementById: (id: string) => (id === 'panel-controls' ? el : null) },
      currentUserId: 'U1',
      isSiblingSession: () => false,
      esc: (x: string) => x,
      renderModelPicker: (s: { key: string }, can: boolean, _short: string, surface: string) =>
        `[M:${s.key}:${can}:${surface}]`,
      renderEffortPicker: () => '[E]',
      renderModelNote: () => '',
      morphInnerHtml: (_e: unknown, h: string) => writes.push(h),
      mpHydrate: (root: unknown) => hydrated.push(root),
    });
    // Its own session: held (no write).
    m.renderPanelControls({ key: 'old', ownerId: 'U1', model: 'claude-opus-5-5[1m]' });
    expect(writes).toEqual([]);
    expect(picker.open).toBe(true);
    // Another session: the old menu is closed (no ui-open-change) and the controls are written for the new one.
    m.renderPanelControls({ key: 'new', ownerId: 'U1', model: 'claude-opus-5-5[1m]' });
    expect(picker.open).toBe(false);
    expect(writes).toEqual(['<span class="pc-scope">이 세션</span>[M:new:true:panel]']);
    expect(hydrated).toEqual([el, el]);
  });
});

// ── the page ──
describe('the page loads the element; the inline menu is gone', () => {
  it('model-picker.js is a module script next to the other elements, served from the installed library', () => {
    expect(HEAD).toContain(`<script type="module" src="/dashboard/ui/model-picker.js?v=\${UI_LIB_VERSION}"></script>`);
    const dir = uiLibDistDir();
    expect(dir).toBeTruthy();
    expect(existsSync(join(dir as string, 'model-picker.js'))).toBe(true);
    const imports = readFileSync(join(dir as string, 'model-picker.js'), 'utf-8').match(/from\s*"\.\/([^"]+)"/g) ?? [];
    for (const imp of imports) {
      const file = /"\.\/([^"]+)"/.exec(imp)?.[1] as string;
      expect(UI_LIB_FILE.test(file), file).toBe(true);
      expect(existsSync(join(dir as string, file)), file).toBe(true);
    }
  });

  it('the slot takes no box and hands the element the dashboard tokens', () => {
    expect(STYLE).toContain('.mp-slot { display: contents; }');
    expect(STYLE).toMatch(/\.ui-tok \{[^}]*--ui-ib-seg: var\(--ib-seg\)/);
  });

  it('no inline menu: its renderer, state, body host, styles and folds are gone', () => {
    for (const gone of [
      'mpOpen',
      'mpClose',
      'mpRepaint',
      'mpPlace',
      'mpHost',
      'mpMenuKey',
      'mpWatch',
      'renderModelMenu',
      'renderEffortControl',
      '_mp',
      'MP_EFFORT_SHORT',
      'MP_ROLL_MS',
      'MP_WATCH_MS',
    ]) {
      expect(declarationCount(gone), gone).toBe(0);
    }
    expect(TEMPLATE).not.toContain("'mp-menu'");
    expect(STYLE).not.toContain('.mp-pop');
    expect(STYLE).not.toContain('.mp-trigger');
    expect(STYLE).not.toContain('--mp-well');
    for (const gone of [
      'cfb-model-toggle',
      'pc-toggle',
      'pc-pick',
      'toggleCardModel',
      '_cardModelOpen',
      'cb-model-select',
    ]) {
      expect(TEMPLATE.includes(gone), gone).toBe(false);
    }
  });

  // Moved to the library (@2lab.ai/ui src/components/model-picker/model-picker.test.ts), which owns them now:
  //   D1 trigger: glyph · model · “· level” · chevron, aria   → 'draws one trigger: avatar letter, model, “· effort”, chevron — closed and inert menu'
  //   D1 busy trigger, never disabled                          → 'locks rows while a model write runs and levels while an effort write runs'
  //   D3 listbox: rows in order, ✓ current, outside first row  → 'lists every model with meters, ✓ on the current one, and a tray for it'
  //   D3 the switch rule (compact 후 전환)                      → 'marks a row whose auto-compact point is below the context as switching after compaction'
  //   D3/D11 locked rows while a switch waits or runs          → 'locks rows while a model write runs and levels while an effort write runs'
  //   D4 meters round(5v/max), — when unknown                  → 'fills 1–5 segments against the largest value, 0 when unknown', 'measures window · compaction · cost per model; …'
  //   D7 effort radiogroup, capped level, only the model's     → 'offers only the levels the model runs; arrows select at once and keep the menu open'
  //   D7 the session model's levels, also outside the list     → 'value.effortLevels: the session model’s own levels win over the row’s, also outside the list'
  //   D8 tray, dollars, live region, roll                      → 'formats tokens and dollars the way the dashboard menu does', 'says “—” for an unknown price and never guesses one'
  //   D2 placement under / over, flip, 12px                    → 'places the menu under the trigger, flips when there is no room, keeps 12px inside'
  //   D2 a moved or scrolled-away anchor closes the menu       → 'counts only a layout move above 2px as moved' (+ the 150 ms watch in model-picker.ts #tick)
  //   D9 keys: arrows, Home / End, Enter, Esc, ↓ on trigger    → 'opens from the trigger click and from ↓, …', 'moves with ↑ ↓ (wrapping) · Home · End …', 'Esc closes, returns focus to the trigger and stops there'
  //   D9 Tab past the last stop goes home (R1 grok P1)         → 'Tab: list → checked level, Shift+Tab back; past either end the menu closes onto the trigger (D9)', 'Tab from the list goes home when the model has no effort levels'
  //   D9 the pointed row is its model (R1 astra P1)            → 'remembers the pointed row by model, not by position'
  //   D9 the current row only closes (R1 fable P3)             → 'closes on the current row without a change; a click picks by data-k'
  //   D9 every open starts on the session's model (R1 grok P3) → 'opens from the trigger click and from ↓, focusing the list on the current model'
  //   D17 no optimistic value when the host prevents           → 'keeps data.value when the host prevents ui-change'
  //   D18 one menu: a press outside closes it                  → 'a press outside closes it; a press inside does not'
  //   a failed write: alert in the menu, else under trigger    → 'announces an error: in the open menu, else under the trigger'
  //   Korean strings                                           → 'speaks Korean with lang="ko"'
  //   D13–D15 motion, light tokens, touch sizes, reduced motion → the element's styles (model-picker/styles.ts, the ported block)
});

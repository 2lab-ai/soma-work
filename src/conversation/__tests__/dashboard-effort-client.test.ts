/**
 * SSOT 2026-10-23 T1 + T6 — client half. Executes the shipped page code (cut
 * out of renderDashboardPage()'s template literal and cooked exactly as the
 * browser receives it, same harness as dashboard-goal-client.test.ts):
 *   T1  the card / panel effort picker — who gets it, what it sends;
 *   T6  the top-bar default model / effort chips — what a pick saves, and that
 *       "이 세션에도 적용" also switches the open session.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';

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
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

/** The page's chrome words (STRINGS — tone pass P8: Korean, "…", no emoji), as served. */
const STRINGS_START = TEMPLATE.indexOf('var STRINGS = {');
const STRINGS = new Function(
  `${cook(TEMPLATE.slice(STRINGS_START, TEMPLATE.indexOf('\n};\n', STRINGS_START) + 3))}\nreturn STRINGS;`,
)() as Record<string, string>;

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('card effort picker (T1)', () => {
  // The owner's level is a control of <ui-model-picker> (.prd/affectui/re-model-picker.md D7): the
  // dashboard hands it value.effortLevels (mpData — dashboard-affectui-model-picker-client.test.ts) and
  // the library's suite owns the radiogroup ('offers only the levels the model runs; arrows select at
  // once and keep the menu open'). Others read the level as text.
  const { renderEffortPicker } = load<{ renderEffortPicker(s: Record<string, unknown>): string }>(
    ['esc', 'escAttr', 'effortLabel', 'effortWord', 'renderEffortPicker'],
    ['EFFORT_LABELS'],
    { STRINGS },
  );

  it('a non-owner sees the level as text, with the level the model really runs', () => {
    const html = renderEffortPicker({ key: 'k', effort: 'max', effortEffective: 'high' });
    expect(html).not.toContain('<select');
    expect(html).toContain(
      '<span class="ui-effort" data-effort="max">최대</span> &rarr; <span class="ui-effort" data-effort="high">높음</span>',
    );
    expect(html).toContain('이 모델은 높음까지 실행합니다');
    expect(renderEffortPicker({ key: 'k', effort: 'high' })).toBe(
      // Tone pass P8: the tooltip is Korean chrome (STRINGS.effortTitle) — was "Reasoning effort".
      '<span class="meta-effort" title="추론 강도"><span class="ui-effort" data-effort="high">높음</span></span>',
    );
  });

  it('every effort word carries its level for the kit’s look — XHigh red, Max and Ultra foil; ultra reads 울트라', () => {
    expect(renderEffortPicker({ key: 'k', effort: 'ultra' })).toContain(
      '<span class="ui-effort" data-effort="ultra">울트라</span>',
    );
    expect(renderEffortPicker({ key: 'k', effort: 'xhigh' })).toContain(
      '<span class="ui-effort" data-effort="xhigh">매우 높음</span>',
    );
  });
});

describe('postEffortSwitch / effortSwitchNote (T1)', () => {
  it('posts the level with the CSRF token and retries once after a 403', async () => {
    let token = 'old';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { error: 'CSRF' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true, result: { status: 'switched', effort: 'low', effective: 'low' } }),
      );
    const refreshCsrfToken = vi.fn(async () => {
      token = 'new';
    });
    const { postEffortSwitch } = new Function(
      'fetch',
      'refreshCsrfToken',
      'getToken',
      `${clientFn('postEffortSwitch').replace(/_csrfToken/g, 'getToken()')}\nreturn { postEffortSwitch };`,
    )(fetch, refreshCsrfToken, () => token);
    const r = await postEffortSwitch('self::C1:t1', 'low');
    expect(fetch.mock.calls[0][0]).toBe('/api/dashboard/session/self%3A%3AC1%3At1/effort');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ effort: 'low' });
    expect(fetch.mock.calls[0][1].headers['X-CSRF-Token']).toBe('old');
    expect(fetch.mock.calls[1][1].headers['X-CSRF-Token']).toBe('new');
    expect(r).toMatchObject({ ok: true, result: { status: 'switched' } });
  });

  it('says when the change applies and what the model caps it to', () => {
    const { effortSwitchNote } = load<{ effortSwitchNote(r: any): { text: string; error: boolean } }>(
      ['effortLabel', 'effortSwitchNote'],
      ['EFFORT_LABELS'],
    );
    expect(effortSwitchNote({ ok: true, result: { status: 'switched', effort: 'max', effective: 'high' } })).toEqual({
      text: '추론 강도 최대 · 다음 턴부터 적용 (이 모델은 높음까지 실행)',
      error: false,
    });
    expect(effortSwitchNote({ ok: false, error: '종료된 세션' })).toEqual({ text: '종료된 세션', error: true });
  });
});

describe('top-bar defaults: one <ui-model-picker> sets the default model and effort together (T6)', () => {
  const ALL = [...LEVELS, 'ultra'];
  const REPS = [
    {
      nickname: 'opus[1m]',
      model: 'claude-opus-5-5[1m]',
      label: 'Opus 5.5 (1M)',
      contextWindow: 1_000_000,
      autoCompactTokens: 750_000,
      effortLevels: LEVELS,
    },
    {
      nickname: 'sol[1m]',
      model: 'gpt-6.1-sol[1m]',
      label: 'Sol 6.1 (1M)',
      contextWindow: 1_000_000,
      autoCompactTokens: 600_000,
      effortLevels: ALL,
    },
    {
      nickname: 'grok[1m]',
      model: 'grok-4.6',
      label: 'Grok 4.6',
      contextWindow: 500_000,
      autoCompactTokens: 450_000,
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
    },
  ];
  const defaults = (model = 'sol[1m]', effort = 'ultra', levels: string[] = ALL) => ({
    model: {
      key: 'defaultModel',
      value: model,
      options: REPS.map((r) => ({ value: r.nickname, label: r.label, description: r.model })),
    },
    effort: { key: 'defaultEffort', value: effort, options: levels.map((l) => ({ value: l, label: l })) },
  });
  const pickerFns = ['toNum', 'mpLevelsOf', 'mpRows', 'defaultsPickerData'];
  const pickerEnv = (myDefaults: unknown, over: Record<string, unknown> = {}) => ({
    REPRESENTATIVE_MODELS: REPS,
    EFFORT_LEVELS: ALL,
    SDK_EFFORT_LEVELS: LEVELS,
    _myDefaults: myDefaults,
    _tdBusy: { model: false, effort: false },
    _tdError: '',
    ...over,
  });

  it('the bar holds one picker — no separate model and effort chips, no menu of its own', () => {
    const box = TEMPLATE.slice(
      TEMPLATE.indexOf('<div class="topbar-defaults"'),
      TEMPLATE.indexOf('</div>', TEMPLATE.indexOf('<div class="topbar-defaults"')),
    );
    expect(box).toContain('<ui-model-picker id="td-picker" class="td-picker" lang="ko"');
    expect(box).not.toContain('id="td-model"');
    expect(box).not.toContain('id="td-effort"');
    expect(box).not.toContain('<ui-menu');
    expect(box).not.toContain('<select');
  });

  it('the data: every representative model with the levels it runs; the default model and effort; the levels the server offers for it', () => {
    const { defaultsPickerData } = load<{ defaultsPickerData(): any }>(pickerFns, [], pickerEnv(defaults()));
    const d = defaultsPickerData();
    expect(d.heading).toBe('새 세션 기본값');
    expect(d.models.map((m: any) => [m.id, m.effortLevels])).toEqual([
      ['opus[1m]', LEVELS],
      ['sol[1m]', ALL],
      ['grok[1m]', ['low', 'medium', 'high', 'xhigh']],
    ]);
    expect(d.value).toEqual({ model: 'sol[1m]', effort: 'ultra', effortLevels: ALL });
    expect(d.busy).toEqual({ model: false, effort: false });
    expect(d).not.toHaveProperty('error');
    // A default outside the representatives (the element's first, current row) keeps the levels the server offers.
    const outside = load<{ defaultsPickerData(): any }>(
      pickerFns,
      [],
      pickerEnv(defaults('claude-haiku-4-5', 'high', ['low', 'medium', 'high'])),
    );
    expect(outside.defaultsPickerData().value).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'high',
      effortLevels: ['low', 'medium', 'high'],
    });
    // A write in flight and the last refusal are the element's to show.
    const busy = load<{ defaultsPickerData(): any }>(
      pickerFns,
      [],
      pickerEnv(defaults(), { _tdBusy: { model: true, effort: false }, _tdError: '저장하지 못했습니다: HTTP 400' }),
    );
    expect(busy.defaultsPickerData()).toMatchObject({
      busy: { model: true, effort: false },
      error: '저장하지 못했습니다: HTTP 400',
    });
  });

  it('a pick is the page’s: cancelled, then saved by what changed (model or effort)', () => {
    const init = TEMPLATE.slice(
      TEMPLATE.indexOf('(function initDefaultsPicker()'),
      TEMPLATE.indexOf('})();', TEMPLATE.indexOf('(function initDefaultsPicker()')),
    );
    expect(init).toContain("document.getElementById('td-picker')");
    expect(init).toContain("el.addEventListener('ui-change'");
    expect(init).toContain('e.preventDefault();');
    expect(init).toContain("if (e.detail.changed === 'model') pickDefault('model', String(e.detail.model || ''));");
    expect(init).toContain(
      "else if (e.detail.changed === 'effort') pickDefault('effort', String(e.detail.effort || ''));",
    );
  });

  it('only an owned, live, local open session is a scope target', () => {
    const run = (panel: any, cache: any) =>
      new Function(
        'panelOpen',
        'panelSessionKey',
        '_sessionCache',
        '_viewerUserId',
        'isSiblingSession',
        `${clientFn('viewerOwns')}\n${clientFn('defaultsScopeSession')}\nreturn defaultsScopeSession();`,
      )(panel.open, panel.key, cache, 'U1', (s: any) => !!s.sibling);
    const s = { key: 'k', ownerId: 'U1' };
    expect(run({ open: true, key: 'k' }, { k: s })).toBe(s);
    expect(run({ open: false, key: 'k' }, { k: s })).toBeNull();
    expect(run({ open: true, key: 'k' }, { k: { ...s, ownerId: 'U2' } })).toBeNull();
    expect(run({ open: true, key: 'k' }, { k: { ...s, terminated: true } })).toBeNull();
    expect(run({ open: true, key: 'k' }, { k: { ...s, sibling: true } })).toBeNull();
  });

  it('"열린 세션에도" shows only while a session the owner may switch is open (panel open / close repaint it)', () => {
    const sw: any = { hidden: true, title: '' };
    const run = (scope: unknown) =>
      load<{ paintDefaultsScope(): void }>(['paintDefaultsScope'], [], {
        document: { getElementById: () => sw },
        _myDefaults: defaults(),
        defaultsScopeSession: () => scope,
      }).paintDefaultsScope();
    run(null);
    expect(sw.hidden).toBe(true);
    run({ key: 'k', displayHeadline: '대시보드 개선' });
    expect(sw.hidden).toBe(false);
    expect(sw.title).toContain('대시보드 개선');
    expect(clientFn('openPanel')).toContain('paintDefaultsScope();');
    expect(clientFn('closePanel')).toContain('paintDefaultsScope();');
  });

  function pickEnv(over: Record<string, unknown> = {}) {
    const status: any = { textContent: '', setAttribute: vi.fn(), removeAttribute: vi.fn() };
    const myDefaults: any = defaults('opus[1m]', 'max', LEVELS);
    const patchSetting = vi.fn(async (key: string, value: string) => ({
      ok: true,
      setting: { key, value, options: [{ value, label: value.toUpperCase() }] },
    }));
    const env: Record<string, unknown> = {
      document: { getElementById: () => status },
      EFFORT_LEVELS: ALL,
      SDK_EFFORT_LEVELS: LEVELS,
      _myDefaults: myDefaults,
      _modelNotes: {} as Record<string, unknown>,
      _tdBusy: { model: false, effort: false },
      _tdError: '',
      _tdAlsoSession: true,
      patchSetting,
      postEffortSwitch: vi.fn(async (_k: string, effort: string) => ({
        ok: true,
        result: { status: 'switched', effort },
      })),
      postModelSwitch: vi.fn(async () => ({ ok: true, result: { status: 'switched' } })),
      defaultsScopeSession: () => ({ key: 'self::C1:t1', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      renderDefaultsPicker: vi.fn(),
      refreshDefaultEffort: vi.fn(async () => {
        myDefaults.effort = { key: 'defaultEffort', value: 'xhigh', options: [{ value: 'xhigh', label: 'XHIGH' }] };
      }),
      optionLabel: (row: any, v: string) => (row.options.find((o: any) => o.value === v) || {}).label || v,
      effortLabel: (l: string) => l,
      modelSwitchNote: () => ({ text: 'ok', error: false }),
      effortSwitchNote: () => ({ text: 'ok', error: false }),
      mpApplyEffort: vi.fn(),
      refreshCard: vi.fn(),
      repaintPanelControlsFor: vi.fn(),
      loadSessions: vi.fn(),
      REPRESENTATIVE_MODELS: REPS,
      ...over,
    };
    const fns = load<{ pickDefault(kind: string, value: string): Promise<void> }>(
      [
        'isBusy',
        'setBusy',
        'setDefaultsStatus',
        'mpLevelsOf',
        'mpEffortLevels',
        'fitEffortLevel',
        'sessionAcceptsModel',
        'pickDefault',
      ],
      ['_busy'],
      env,
    );
    return { ...fns, env, status, myDefaults, patchSetting };
  }

  it('an effort pick saves the default and, with the switch on, sets the open session to the nearest level its model runs', async () => {
    const { pickDefault, env, status, myDefaults, patchSetting } = pickEnv();
    await pickDefault('effort', 'ultra');
    expect(patchSetting).toHaveBeenCalledWith('defaultEffort', 'ultra');
    expect(myDefaults.effort.value).toBe('ultra');
    // The open session's model stops at max: it gets max, never a level it cannot run.
    expect(env.postEffortSwitch).toHaveBeenCalledWith('self::C1:t1', 'max');
    expect(status.textContent).toBe('기본 추론 강도 → ULTRA (새 세션부터) · 열린 세션에도 적용 (max)');
    // The switch off: the session is left alone.
    const off = pickEnv({ _tdAlsoSession: false });
    await off.pickDefault('effort', 'high');
    expect(off.env.postEffortSwitch).not.toHaveBeenCalled();
  });

  it('a model pick saves the default model, reads back the effort the server carried over, and switches the open session', async () => {
    const { pickDefault, env, status, myDefaults, patchSetting } = pickEnv();
    await pickDefault('model', 'grok[1m]');
    expect(patchSetting).toHaveBeenCalledWith('defaultModel', 'grok[1m]');
    expect(env.refreshDefaultEffort).toHaveBeenCalledTimes(1);
    expect(myDefaults.effort.value).toBe('xhigh');
    expect(env.postModelSwitch).toHaveBeenCalledWith('self::C1:t1', 'grok[1m]');
    expect(status.textContent).toBe('기본 모델 → GROK[1M] (새 세션부터) · 추론 강도 XHIGH · 열린 세션에도 적용');
  });

  it('a refused save says why (under the picker too) and leaves the session alone', async () => {
    const { pickDefault, env, status } = pickEnv({
      patchSetting: async () => ({
        ok: false,
        error: 'Grok 4.6은(는) effort ultra를 지원하지 않습니다 — low, medium, high, xhigh 중 하나',
      }),
    });
    await pickDefault('effort', 'ultra');
    expect(status.textContent).toContain('저장하지 못했습니다');
    expect(env.renderDefaultsPicker).toHaveBeenCalled(); // the picker shows the refusal (its data's error)
    expect(env.postEffortSwitch).not.toHaveBeenCalled();
  });
});

describe('top-bar chips stay clickable while a session panel is open (T6, review P1)', () => {
  function zIndexOf(selector: string): number {
    const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
    const block = re.exec(DASHBOARD_TS)?.[1] ?? '';
    const z = /z-index:\s*(\d+)/.exec(block);
    return z ? Number(z[1]) : Number.NaN;
  }

  it('the defaults group is positioned above the docked drawer (its layer: --ui-drawer-z); the sheet is the element’s modal, over everything by design', () => {
    const block = /^\.slide-panel\s*\{([^}]*)\}/m.exec(DASHBOARD_TS)?.[1] ?? '';
    const panel = Number(/--ui-drawer-z:\s*(\d+)/.exec(block)?.[1]);
    const chips = zIndexOf('.topbar .topbar-defaults');
    expect(panel).toBe(100);
    expect(chips).toBeGreaterThan(panel);
    expect(DASHBOARD_TS).not.toContain('.slide-panel-overlay');
  });

  it('a model outside the session switch list is saved as the default only (a representative nickname is required)', () => {
    const only = load<{ sessionAcceptsModel(v: string): boolean }>(['sessionAcceptsModel'], [], {
      REPRESENTATIVE_MODELS: [{ nickname: 'opus[1m]' }],
    });
    expect([only.sessionAcceptsModel('opus[1m]'), only.sessionAcceptsModel('claude-sonnet-4-6')]).toEqual([
      true,
      false,
    ]);
    expect(clientFn('pickDefault')).toContain(
      "var skipSession = !!session && kind === 'model' && !sessionAcceptsModel(value);",
    );
  });
});

describe('top-bar chips for a user without admin acceptance (T6, review P3)', () => {
  it('stay hidden — the server would refuse every save', async () => {
    const box: any = { hidden: true };
    const { loadMyDefaults } = load<{ loadMyDefaults(): Promise<void> }>(['loadMyDefaults'], [], {
      document: { getElementById: () => box },
      fetch: async () => ({
        ok: true,
        json: async () => ({ accepted: false, settings: [{ key: 'defaultModel' }, { key: 'defaultEffort' }] }),
      }),
      renderDefaultsPicker: () => {},
    });
    await loadMyDefaults();
    expect(box.hidden).toBe(true);
  });
});

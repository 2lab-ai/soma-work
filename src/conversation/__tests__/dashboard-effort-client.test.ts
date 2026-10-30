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
    ['esc', 'escAttr', 'effortLabel', 'renderEffortPicker'],
    ['EFFORT_LABELS'],
    { STRINGS },
  );

  it('a non-owner sees the level as text, with the level the model really runs', () => {
    const html = renderEffortPicker({ key: 'k', effort: 'max', effortEffective: 'high' });
    expect(html).not.toContain('<select');
    expect(html).toContain('Max &rarr; High');
    expect(html).toContain('이 모델은 High까지 실행합니다');
    expect(renderEffortPicker({ key: 'k', effort: 'high' })).toBe(
      // Tone pass P8: the tooltip is Korean chrome (STRINGS.effortTitle) — was "Reasoning effort".
      '<span class="meta-effort" title="추론 강도">High</span>',
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
      text: 'effort Max · 다음 턴부터 적용 (이 모델은 High까지 실행)',
      error: false,
    });
    expect(effortSwitchNote({ ok: false, error: '종료된 세션' })).toEqual({ text: '종료된 세션', error: true });
  });
});

describe('top-bar default chips (T6)', () => {
  const defaults = () => ({
    model: {
      key: 'defaultModel',
      value: 'opus[1m]',
      options: [
        { value: 'opus[1m]', label: 'Opus 5.5', description: 'claude-opus-5-5[1m]' },
        { value: 'grok[1m]', label: 'Grok 4.6', description: 'grok-4.6' },
      ],
    },
    effort: {
      key: 'defaultEffort',
      value: 'xhigh',
      options: LEVELS.map((l) => ({ value: l, label: l })),
    },
  });

  it('the menu lists the options with the current one checked; the open owned session gets the scope box', () => {
    // D1 (A-07): the defaults menu is @2lab.ai/ui <ui-menu> — the page hands it rows (data), never markup.
    type Item = { kind: string; value?: string; label?: string; description?: string; checked?: boolean };
    const scope = vi.fn();
    const fns = load<{ defaultsMenuData(kind: string): { label: string; items: Item[] } }>(
      ['defaultsMenuData'],
      ['TD_ALSO_SESSION', '_tdAlsoSession'],
      { _myDefaults: defaults(), defaultsScopeSession: scope },
    );
    scope.mockReturnValue(null);
    let d = fns.defaultsMenuData('model');
    expect(d.label).toBe('새 세션 기본 모델');
    expect(d.items[0]).toEqual({ kind: 'heading', label: '새 세션 기본 모델' });
    const radios = d.items.filter((it) => it.kind === 'radio');
    expect(radios.map((it) => it.value)).toEqual(['opus[1m]', 'grok[1m]']);
    expect(radios.filter((it) => it.checked)).toHaveLength(1);
    expect(d.items.some((it) => it.kind === 'checkbox')).toBe(false);
    // A pick arrives as the element's ui-select (values as data, never inside inline JS) and is saved by kind.
    expect(TEMPLATE).toContain("if (d.kind === 'radio' && _tdMenuKind) pickDefault(_tdMenuKind, d.value);");
    expect(TEMPLATE).not.toContain('pickDefaultFrom');

    scope.mockReturnValue({ key: 'self::C1:t1', displayHeadline: '대시보드 개선' });
    d = fns.defaultsMenuData('effort');
    expect(d.items.at(-1)).toEqual({
      kind: 'checkbox',
      value: 'td-also-session',
      label: '열린 세션에도 적용',
      description: '대시보드 개선',
      checked: true,
    });
    // The box is answered too (a checkbox row keeps the menu open), and it is on again each time the menu opens.
    expect(TEMPLATE).toContain("if (d.kind === 'checkbox' && d.value === TD_ALSO_SESSION) { _tdAlsoSession = !!d.checked; return; }");
    expect(clientFn('openDefaultsMenu')).toContain('_tdAlsoSession = true;');
  });

  it('only an owned, live, local open session is a scope target', () => {
    const run = (panel: any, cache: any) =>
      new Function(
        'panelOpen',
        'panelSessionKey',
        '_sessionCache',
        'currentUserId',
        'isSiblingSession',
        `${clientFn('defaultsScopeSession')}\nreturn defaultsScopeSession();`,
      )(panel.open, panel.key, cache, 'U1', (s: any) => !!s.sibling);
    const s = { key: 'k', ownerId: 'U1' };
    expect(run({ open: true, key: 'k' }, { k: s })).toBe(s);
    expect(run({ open: false, key: 'k' }, { k: s })).toBeNull();
    expect(run({ open: true, key: 'k' }, { k: { ...s, ownerId: 'U2' } })).toBeNull();
    expect(run({ open: true, key: 'k' }, { k: { ...s, terminated: true } })).toBeNull();
    expect(run({ open: true, key: 'k' }, { k: { ...s, sibling: true } })).toBeNull();
  });

  it('a pick saves the default, and with the scope box checked also switches the open session', async () => {
    const patchSetting = vi.fn(async (key: string, value: string) => ({
      ok: true,
      setting: { key, value, options: [{ value, label: value.toUpperCase() }] },
    }));
    const postEffortSwitch = vi.fn(async () => ({ ok: true, result: { status: 'switched', effort: 'low' } }));
    const postModelSwitch = vi.fn();
    const status: any = { textContent: '', classList: { toggle: vi.fn() } };
    const document = { getElementById: () => status };
    const myDefaults: any = defaults();
    const env = {
      document,
      _myDefaults: myDefaults,
      _modelNotes: {} as Record<string, unknown>,
      patchSetting,
      postEffortSwitch,
      postModelSwitch,
      defaultsScopeSession: () => ({ key: 'self::C1:t1' }),
      closeDefaultsMenu: vi.fn(),
      renderDefaultsChips: vi.fn(),
      optionLabel: (row: any, v: string) => (row.options.find((o: any) => o.value === v) || {}).label || v,
      modelSwitchNote: vi.fn(),
      effortSwitchNote: () => ({ text: 'ok', error: false }),
      refreshCard: vi.fn(),
      loadSessions: vi.fn(),
    };
    // Spec 13: the session branch takes the per-session busy lock and repaints the panel's picker.
    // The scope box's state is the page's (_tdAlsoSession, answered from <ui-menu>'s ui-select).
    const withBox = (on: boolean) =>
      load<{ pickDefault(kind: string, value: string): Promise<void> }>(
        ['isBusy', 'setBusy', 'setDefaultsStatus', 'pickDefault'],
        ['_busy'],
        { ...env, _tdAlsoSession: on, repaintPanelControlsFor: vi.fn() },
      ).pickDefault;
    await withBox(true)('effort', 'low');
    expect(patchSetting).toHaveBeenCalledWith('defaultEffort', 'low');
    expect(postEffortSwitch).toHaveBeenCalledWith('self::C1:t1', 'low');
    expect(postModelSwitch).not.toHaveBeenCalled();
    expect(myDefaults.effort.value).toBe('low');
    expect(status.textContent).toBe('기본 effort → LOW (새 세션부터) · 열린 세션에도 적용');

    postEffortSwitch.mockClear();
    await withBox(false)('effort', 'high');
    expect(postEffortSwitch).not.toHaveBeenCalled();
  });

  it('a refused save says why and leaves the session alone', async () => {
    const status: any = { textContent: '', classList: { toggle: vi.fn() } };
    const postEffortSwitch = vi.fn();
    const { pickDefault } = load<{ pickDefault(kind: string, value: string): Promise<void> }>(
      ['setDefaultsStatus', 'pickDefault'],
      [],
      {
        document: { getElementById: () => status },
        _tdAlsoSession: true,
        _myDefaults: defaults(),
        patchSetting: async () => ({ ok: false, error: 'effort는 low, medium, high, xhigh, max 중 하나여야 합니다' }),
        postEffortSwitch,
        postModelSwitch: vi.fn(),
        defaultsScopeSession: () => ({ key: 'k' }),
        closeDefaultsMenu: () => {},
        renderDefaultsChips: () => {},
      },
    );
    await pickDefault('effort', 'turbo');
    expect(status.textContent).toContain('저장하지 못했습니다');
    expect(postEffortSwitch).not.toHaveBeenCalled();
  });
});

describe('top-bar chips stay clickable while a session panel is open (T6, review P1)', () => {
  function zIndexOf(selector: string): number {
    const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
    const block = re.exec(DASHBOARD_TS)?.[1] ?? '';
    const z = /z-index:\s*(\d+)/.exec(block);
    return z ? Number(z[1]) : Number.NaN;
  }

  it('the defaults group is positioned above the full-screen overlay and the panel', () => {
    const overlay = zIndexOf('.slide-panel-overlay');
    const panel = zIndexOf('.slide-panel');
    const chips = zIndexOf('.topbar .topbar-defaults');
    expect(overlay).toBe(99);
    expect(chips).toBeGreaterThan(Math.max(overlay, panel));
  });

  it('the model scope box is offered only for a model the session switch accepts (a representative nickname)', () => {
    const fns = load<{ defaultsMenuData(kind: string): { items: { kind: string }[] } }>(
      ['defaultsMenuData'],
      ['TD_ALSO_SESSION', '_tdAlsoSession'],
      {
        _myDefaults: {
          model: {
            value: 'claude-sonnet-4-6',
            options: [
              { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
              { value: 'opus[1m]', label: 'Opus 5.5' },
            ],
          },
        },
        defaultsScopeSession: () => ({ key: 'k', displayHeadline: 'x' }),
        REPRESENTATIVE_MODELS: [{ nickname: 'opus[1m]' }],
      },
    );
    expect(fns.defaultsMenuData('model').items.some((it) => it.kind === 'checkbox')).toBe(true);
    const picks: string[] = [];
    const only = load<{ sessionAcceptsModel(v: string): boolean }>(['sessionAcceptsModel'], [], {
      REPRESENTATIVE_MODELS: [{ nickname: 'opus[1m]' }],
    });
    picks.push(String(only.sessionAcceptsModel('opus[1m]')), String(only.sessionAcceptsModel('claude-sonnet-4-6')));
    expect(picks).toEqual(['true', 'false']);
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
      renderDefaultsChips: () => {},
    });
    await loadMyDefaults();
    expect(box.hidden).toBe(true);
  });
});

/**
 * 2026-11-26 — "신규 goal 추가시 한줄로 나옴 여기에 마우스로 클릭해서 포커스를 받으면 이 창이 지시창 처럼 변경해서
 * 모든 기능 쓸수 있도록해줘": the goal card's add slot holds a @2lab.ai/ui <ui-composer collapse> — one line while
 * idle, the whole composer on focus (the library's, composer.test.ts "<ui-composer collapse>"). Executes the shipped
 * client code (cut out of renderDashboardPage()'s template literal, as dashboard-goal-client.test.ts does): what the
 * composer is given, that one element per session is slotted into whichever card the panel shows, that its send
 * is a goal add carrying the files, and that the page reorders its own copy of the queue on a move.
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
/** The goal composer's listeners (ui-submit, ui-tool, ui-input), as the page registers them on document. */
const COMPOSER_LISTENERS = (() => {
  const start = TEMPLATE.indexOf(
    "document.addEventListener('ui-submit', function(e) {\n  var c = e.target;\n  if (!isGoalComposer(c)) return;",
  );
  const end = TEMPLATE.indexOf("// A goal's queue order changed", start);
  if (start < 0 || end < 0) throw new Error('goal composer listeners not found');
  return cook(TEMPLATE.slice(start, end));
})();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, __get: function(n) { return eval(n); }, __set: function(n, v) { eval(n + ' = v'); } };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const VARS = ['GOAL_OBJECTIVE_MAX', 'GOAL_COUNT_FROM', 'PC_LIMITS', '_goalBusy', '_gcComposer', '_gcSending'];

/** A light-DOM element double: attributes, a parent, children, the composer API the page calls. */
function el(tag: string): any {
  const attrs: Record<string, string> = {};
  const node: any = {
    tagName: tag.toUpperCase(),
    slot: '',
    className: '',
    parentNode: null,
    children: [] as any[],
    writes: [] as unknown[],
    value: '',
    isConnected: true,
    setAttribute: (n: string, v: string) => {
      attrs[n] = v;
    },
    getAttribute: (n: string) => attrs[n] ?? null,
    appendChild(child: any) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = node;
      node.children.push(child);
    },
    removeChild(child: any) {
      node.children = node.children.filter((c: any) => c !== child);
      child.parentNode = null;
    },
    cancelRecording: vi.fn(),
    pause: vi.fn(),
    clear: vi.fn(),
    set data(d: unknown) {
      node.writes.push(d);
    },
  };
  return node;
}

/** The 지시창's session menus as GET /api/dashboard/composer-menus hands them (one loaded set). */
const MENUS = [
  {
    char: '/',
    at: 'start',
    label: '명령어',
    items: [{ value: '/model' }, { value: '/compact --yes' }, { value: '!' }],
  },
  { char: '%', at: 'start', label: '세션 설정', items: [{ value: '%effort' }] },
  { char: '$', at: 'word', label: '스킬', items: [{ value: '$z' }] },
];

function composerRig(
  opts: { busy?: Record<string, unknown>; dictation?: boolean; menus?: unknown; picking?: boolean } = {},
) {
  const made: any[] = [];
  const ctls: any[] = [];
  let menus: unknown = opts.menus === undefined ? MENUS : opts.menus;
  const morphInnerHtml = vi.fn((node: any, html: string) => {
    node.innerHTML = html;
  });
  const mpHydrate = vi.fn();
  const panelPickerHtml = vi.fn((s: { key: string }) => `<picker ${s.key}>`);
  const repaintPanelGoalFor = vi.fn();
  const document = {
    documentElement: { lang: 'ko' },
    // The composers in made, the model · effort controls (a div) in ctls.
    createElement: (tag: string) => {
      const n = el(tag);
      (tag === 'div' ? ctls : made).push(n);
      return n;
    },
  };
  const quietDictation = vi.fn();
  const m = load<{
    goalComposerData(s: unknown): any;
    paintGoalComposer(card: unknown, s: unknown, canEdit: boolean): void;
    gcCountFollow(c: unknown): void;
    goalComposerReset(): void;
    __get(n: string): any;
    __set(n: string, v: unknown): void;
  }>(
    [
      'goalComposerData',
      'gcNearCap',
      'gcCountFollow',
      'goalComposerQuiet',
      'gcTriggers',
      'paintGoalComposerControls',
      'paintGoalComposer',
      'goalComposerReset',
    ],
    VARS,
    {
      document,
      window: {},
      ntDictationUsable: () => opts.dictation ?? false,
      ntDictationTool: (on: boolean) => ({ id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: !!on }),
      ntDictating: () => false,
      ntDictateStopIn: quietDictation,
      cmTriggersFor: (where: string) => (where === 'session' ? menus : null),
      panelPickerHtml,
      isPickingModel: () => !!opts.picking,
      morphInnerHtml,
      mpHydrate,
      repaintPanelGoalFor,
    },
  );
  if (opts.busy) Object.assign(m.__get('_goalBusy'), opts.busy);
  const loadMenus = (next: unknown) => {
    menus = next;
  };
  return { m, made, ctls, quietDictation, morphInnerHtml, mpHydrate, panelPickerHtml, loadMenus, repaintPanelGoalFor };
}

const session = (key: string, current: unknown = { goalId: 'g1', objective: 'x', status: 'active' }) => ({
  key,
  goal: current ? { current, queue: [] } : null,
});

describe('the goal composer — what <ui-composer collapse> in the card’s add slot is given', () => {
  it('the instruction composer’s file limits, a worded 추가, the key hint; one line until focused; no counter yet', () => {
    const { m } = composerRig();
    const d = m.goalComposerData(session('k'));
    expect(d).toMatchObject({
      label: '목표 추가',
      placeholder: '목표 추가 — 지금 목표 다음에 시작',
      submitLabel: '추가',
      hint: true,
      minRows: 2,
      maxRows: 8,
      maxFiles: 10,
      maxFileSize: 20971520,
      maxTotalBytes: 31457280,
      busy: false,
    });
    // Files, images and voice are the element's defaults (attach / image / voice on).
    expect('attach' in d || 'image' in d || 'voice' in d || 'accept' in d).toBe(false);
    // The menus are added at paint (by identity, not serialized into the change signature).
    expect(d.triggers).toBeUndefined();
    // The counter comes near the cap (gcNearCap) — below it the row keeps its room for model · effort.
    expect('maxLength' in d).toBe(false);
  });

  it('the counter at the route cap (4,000) once its words reach 3,200; typing across it either way repaints it', () => {
    const rig = composerRig();
    const card = el('ui-goal-card');
    rig.m.paintGoalComposer(card, session('k'), true);
    const c = rig.made[0];
    c.value = 'x'.repeat(3199);
    rig.m.gcCountFollow(c);
    expect(rig.repaintPanelGoalFor).not.toHaveBeenCalled();
    c.value = 'x'.repeat(3200);
    rig.m.gcCountFollow(c);
    expect(rig.repaintPanelGoalFor).toHaveBeenCalledWith('k');
    rig.m.paintGoalComposer(card, session('k'), true);
    expect((c.writes.at(-1) as any).maxLength).toBe(4000);
    rig.m.gcCountFollow(c);
    expect(rig.repaintPanelGoalFor).toHaveBeenCalledTimes(1);
    // Cleared after an add (no ui-input): the next paint drops the counter, and the next crossing shows it again.
    c.value = '';
    rig.m.paintGoalComposer(card, session('k'), true);
    expect('maxLength' in (c.writes.at(-1) as any)).toBe(false);
    c.value = 'x'.repeat(3300);
    rig.m.gcCountFollow(c);
    expect(rig.repaintPanelGoalFor).toHaveBeenCalledTimes(2);
    // Another element (a stale one) is not followed.
    rig.m.gcCountFollow(el('ui-composer'));
    expect(rig.repaintPanelGoalFor).toHaveBeenCalledTimes(2);
  });

  it('with no goal running (none, or the last one complete) the placeholder says it starts now', () => {
    const { m } = composerRig();
    expect(m.goalComposerData(session('k', null)).placeholder).toBe('목표 추가 — 바로 시작');
    expect(m.goalComposerData(session('k', { goalId: 'g', status: 'complete' })).placeholder).toBe(
      '목표 추가 — 바로 시작',
    );
    expect(m.goalComposerData(session('k', { goalId: 'g', status: 'paused' })).placeholder).toBe(
      '목표 추가 — 지금 목표 다음에 시작',
    );
  });

  it('받아쓰기 where this device can dictate; the send spins while this session’s add is out (not another write)', () => {
    const { m } = composerRig({ dictation: true, busy: { k: { op: 'add', id: '' }, j: { op: 'delete', id: 'g' } } });
    expect(m.goalComposerData(session('k')).tools).toEqual([
      { id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: false },
    ]);
    expect(m.goalComposerData(session('k')).busy).toBe(true);
    expect(m.goalComposerData(session('j')).busy).toBe(false);
  });
});

describe('the goal composer — one element per session, slotted into whichever card the panel shows', () => {
  it('the owner’s card gets a <ui-composer collapse slot="add">, keyed by session, lang ko; data only when it changed', () => {
    const { m, made } = composerRig();
    const card = el('ui-goal-card');
    const s = session('k');
    m.paintGoalComposer(card, s, true);
    m.paintGoalComposer(card, s, true);
    expect(made).toHaveLength(1);
    const c = made[0];
    expect(c.tagName).toBe('UI-COMPOSER');
    expect(c.slot).toBe('add');
    expect(c.getAttribute('collapse')).toBe('');
    expect(c.getAttribute('lang')).toBe('ko');
    expect(c.getAttribute('data-goal-key')).toBe('k');
    expect(card.children).toEqual([c]);
    expect(c.writes).toHaveLength(1);
  });

  it('a new opening of the same session (a fresh card): the same element moves over — its text and files stay', () => {
    const { m, made } = composerRig();
    const first = el('ui-goal-card');
    const second = el('ui-goal-card');
    m.paintGoalComposer(first, session('k'), true);
    m.paintGoalComposer(second, session('k'), true);
    expect(made).toHaveLength(1);
    expect(first.children).toEqual([]);
    expect(second.children).toEqual([made[0]]);
  });

  it('another session: a fresh element; the old one is quieted (recording discarded, dictation ended) and taken out', () => {
    const { m, made, quietDictation } = composerRig();
    const card = el('ui-goal-card');
    m.paintGoalComposer(card, session('k'), true);
    m.paintGoalComposer(card, session('j'), true);
    expect(made).toHaveLength(2);
    expect(made[0].cancelRecording).toHaveBeenCalled();
    expect(made[0].parentNode).toBeNull();
    expect(quietDictation).toHaveBeenCalledWith('gc');
    expect(card.children).toEqual([made[1]]);
    expect(made[1].getAttribute('data-goal-key')).toBe('j');
  });

  it('read-only (a viewer, a closed session): no composer in the card', () => {
    const { m, made } = composerRig();
    const card = el('ui-goal-card');
    m.paintGoalComposer(card, session('k'), true);
    m.paintGoalComposer(card, session('k'), false);
    expect(card.children).toEqual([]);
    expect(made[0].cancelRecording).toHaveBeenCalled();
  });

  it('the panel closing quiets it: no microphone stays open in a closed drawer', () => {
    const { m, made } = composerRig();
    m.paintGoalComposer(el('ui-goal-card'), session('k'), true);
    m.goalComposerReset();
    expect(made[0].cancelRecording).toHaveBeenCalled();
    expect(made[0].pause).toHaveBeenCalled();
    expect(clientFn('closePanel')).toContain("if (typeof goalComposerReset === 'function') goalComposerReset();");
  });

  it('renderPanelGoal paints it after the card’s data, and takes it out (quiet) when there is no card', () => {
    const src = clientFn('renderPanelGoal');
    expect(src).toContain('paintGoalComposer(card, s, canEdit);');
    expect(src).toContain('paintGoalComposer(null, s, false);');
    const { m, made } = composerRig();
    const card = el('ui-goal-card');
    m.paintGoalComposer(card, session('k'), true);
    m.paintGoalComposer(null, null, false);
    expect(card.children).toEqual([]);
    expect(made[0].cancelRecording).toHaveBeenCalled();
  });

  it('leaving the 목표 tab quiets it (a recording or dictation does not go on out of sight)', () => {
    const src = clientFn('selectPanelMid');
    expect(src).toContain("var wasGoal = _panelMid === 'goal';");
    expect(src).toContain(
      "if (wasGoal && _panelMid !== 'goal' && typeof goalComposerReset === 'function') goalComposerReset();",
    );
  });
});

describe('the goal composer — its send is a goal add with the files', () => {
  function sendRig(ok = true) {
    const goalAction = vi.fn().mockResolvedValue(ok);
    const dashToast = vi.fn();
    const setGoalError = vi.fn();
    const ntReadFile = vi.fn(async (f: { name: string }) => ({ name: f.name, mimetype: 'image/png', data: 'QUJD' }));
    const m = load<{ addGoalFromComposer(key: string, text: string, files: unknown[], c: unknown): Promise<boolean> }>(
      ['addGoalFromComposer'],
      [],
      { goalAction, dashToast, setGoalError, ntReadFile },
    );
    return { m, goalAction, dashToast, setGoalError, ntReadFile };
  }
  const composer = (key: string, value: string) => {
    const c = el('ui-composer');
    c.setAttribute('data-goal-key', key);
    c.value = value;
    return c;
  };

  it('the trimmed words are the objective; the files go as base64 attachments; the composer clears once it went through', async () => {
    const r = sendRig();
    const c = composer('k', '  스크린샷 보고 고쳐줘 ');
    const ok = await r.m.addGoalFromComposer('k', '스크린샷 보고 고쳐줘', [{ name: 'a.png' }, { name: 'b.png' }], c);
    expect(ok).toBe(true);
    expect(r.goalAction).toHaveBeenCalledWith('k', {
      action: 'add',
      objective: '스크린샷 보고 고쳐줘',
      attachments: [
        { name: 'a.png', mimetype: 'image/png', data: 'QUJD' },
        { name: 'b.png', mimetype: 'image/png', data: 'QUJD' },
      ],
    });
    expect(c.clear).toHaveBeenCalled();
  });

  it('no files: no attachments key', async () => {
    const r = sendRig();
    await r.m.addGoalFromComposer('k', '목표', [], composer('k', '목표'));
    expect(r.goalAction).toHaveBeenCalledWith('k', { action: 'add', objective: '목표' });
  });

  it('files without words are not a goal: a toast, nothing sent, the composer keeps them', async () => {
    const r = sendRig();
    const c = composer('k', '');
    expect(await r.m.addGoalFromComposer('k', '   ', [{ name: 'a.png' }], c)).toBe(false);
    expect(r.goalAction).not.toHaveBeenCalled();
    expect(r.dashToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '목표를 글로 적어 주세요', tone: 'error' }),
    );
    expect(c.clear).not.toHaveBeenCalled();
  });

  it('a refusal keeps the words and files; words changed meanwhile, or another session’s composer, are not cleared', async () => {
    const refused = sendRig(false);
    const c = composer('k', '목표');
    await refused.m.addGoalFromComposer('k', '목표', [], c);
    expect(c.clear).not.toHaveBeenCalled();
    const r = sendRig();
    const edited = composer('k', '목표 — 더 적는 중');
    await r.m.addGoalFromComposer('k', '목표', [], edited);
    expect(edited.clear).not.toHaveBeenCalled();
    const other = composer('j', '목표');
    await r.m.addGoalFromComposer('k', '목표', [], other);
    expect(other.clear).not.toHaveBeenCalled();
  });

  it('a file that cannot be read: the card says so, nothing is sent', async () => {
    const r = sendRig();
    r.ntReadFile.mockRejectedValueOnce(new Error('read:a.png'));
    expect(await r.m.addGoalFromComposer('k', '목표', [{ name: 'a.png' }], composer('k', '목표'))).toBe(false);
    expect(r.setGoalError).toHaveBeenCalledWith('k', expect.stringContaining('첨부 파일'));
    expect(r.goalAction).not.toHaveBeenCalled();
  });
});

describe('the goal composer — its events on document (executed)', () => {
  function listeners() {
    const on: Record<string, (e: any) => void> = {};
    const addGoalFromComposer = vi.fn();
    const commandFromGoalComposer = vi.fn();
    const gcCountFollow = vi.fn();
    const gcIsCommand = (t: string) => String(t).startsWith('/model');
    const ntDictateStopIn = vi.fn();
    const ntOnComposerTool = vi.fn();
    const ntDictationHost = vi.fn((id: string) => ({ id }));
    const isGoalComposer = new Function(`${clientFn('isGoalComposer')}\nreturn isGoalComposer;`)();
    new Function(
      'document',
      '_sessionCache',
      'addGoalFromComposer',
      'ntDictateStopIn',
      'ntOnComposerTool',
      'ntDictationHost',
      'isGoalComposer',
      'gcIsCommand',
      'commandFromGoalComposer',
      'gcCountFollow',
      COMPOSER_LISTENERS,
    )(
      { addEventListener: (t: string, fn: (e: any) => void) => (on[t] = fn) },
      { k: { key: 'k' } },
      addGoalFromComposer,
      ntDictateStopIn,
      ntOnComposerTool,
      ntDictationHost,
      isGoalComposer,
      gcIsCommand,
      commandFromGoalComposer,
      gcCountFollow,
    );
    const goalComposer = (key = 'k') => {
      const c = el('ui-composer');
      c.slot = 'add';
      c.setAttribute('data-goal-key', key);
      return c;
    };
    const fire = (type: string, target: unknown, detail: unknown = {}) => {
      const e = {
        target,
        detail,
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      on[type](e);
      return e;
    };
    return {
      on,
      addGoalFromComposer,
      commandFromGoalComposer,
      gcCountFollow,
      ntDictateStopIn,
      ntOnComposerTool,
      ntDictationHost,
      goalComposer,
      fire,
    };
  }

  it('ui-submit from the goal composer is prevented (it keeps its words) and becomes a goal add with its files', () => {
    const l = listeners();
    expect(Object.keys(l.on).sort()).toEqual(['ui-input', 'ui-submit', 'ui-tool']);
    const c = l.goalComposer();
    const files = [{ name: 'a.png' }];
    const e = l.fire('ui-submit', c, { text: '목표', files });
    expect(e.prevented).toBe(true);
    expect(l.ntDictateStopIn).toHaveBeenCalledWith('gc');
    expect(l.addGoalFromComposer).toHaveBeenCalledWith('k', '목표', files, c);
    expect(l.commandFromGoalComposer).not.toHaveBeenCalled();
  });

  it('a command (gcIsCommand) is sent as the instruction composer sends it — not added as a goal', () => {
    const l = listeners();
    const c = l.goalComposer();
    const files = [{ name: 'a.png' }];
    const e = l.fire('ui-submit', c, { text: '/model opus', files });
    expect(e.prevented).toBe(true);
    expect(l.commandFromGoalComposer).toHaveBeenCalledWith('k', '/model opus', files, c);
    expect(l.addGoalFromComposer).not.toHaveBeenCalled();
  });

  it('the panel’s instruction composer and the new-task composer are not the goal’s: their sends pass untouched', () => {
    const l = listeners();
    const pc = el('ui-composer');
    pc.slot = 'composer';
    expect(l.fire('ui-submit', pc, { text: 'x', files: [] }).prevented).toBe(false);
    const nt = el('ui-composer');
    expect(l.fire('ui-submit', nt, { text: 'x', files: [] }).prevented).toBe(false);
    expect(l.addGoalFromComposer).not.toHaveBeenCalled();
  });

  it('a session the page no longer knows: the send is held (prevented), nothing is added', () => {
    const l = listeners();
    expect(l.fire('ui-submit', l.goalComposer('gone'), { text: 'x', files: [] }).prevented).toBe(true);
    expect(l.addGoalFromComposer).not.toHaveBeenCalled();
  });

  it('받아쓰기: the tool press goes to the goal dictation host; typing stops it', () => {
    const l = listeners();
    const c = l.goalComposer();
    const e = l.fire('ui-tool', c, { id: 'dictate', pressed: true });
    expect(l.ntDictationHost).toHaveBeenCalledWith('gc');
    expect(l.ntOnComposerTool).toHaveBeenCalledWith(e, { id: 'gc' });
    l.fire('ui-input', c, { value: 'a' });
    expect(l.ntDictateStopIn).toHaveBeenCalledWith('gc');
    expect(l.gcCountFollow).toHaveBeenCalledWith(c);
  });

  it('the dictation host writes into the goal composer and repaints the goal section', () => {
    const repaintPanelGoalFor = vi.fn();
    const gcCountFollow = vi.fn();
    const composerEl = el('ui-composer');
    const m = load<{ ntDictationHost(id: string): any }>(['ntDictationHost'], [], {
      _gcComposer: { key: 'k', el: composerEl },
      repaintPanelGoalFor,
      gcCountFollow,
      panelSessionKey: 'k',
      dashToast: vi.fn(),
    });
    const h = m.ntDictationHost('gc');
    expect(h.id).toBe('gc');
    expect(h.el()).toBe(composerEl);
    h.paint();
    expect(repaintPanelGoalFor).toHaveBeenCalledWith('k');
    // Dictated words reach the counter (a value write sends no ui-input).
    h.text('…');
    expect(gcCountFollow).toHaveBeenCalledWith(composerEl);
  });
});

describe('a move — the page’s copy of the queue takes the new order at once', () => {
  const m = load<{ goalQueueReorder(s: any, order: unknown): boolean }>(['goalQueueReorder'], []);
  const s = () => ({ goal: { queue: [{ goalId: 'g2' }, { goalId: 'g3' }, { goalId: 'g4' }] } });

  it('reorders by the element’s ids (the same goal objects)', () => {
    const x = s();
    const [g2, g3, g4] = x.goal.queue;
    expect(m.goalQueueReorder(x, ['g4', 'g2', 'g3'])).toBe(true);
    expect(x.goal.queue).toEqual([g4, g2, g3]);
  });

  it('an order that does not name the same goals changes nothing (the server reload decides)', () => {
    for (const order of [['g2', 'g3'], ['g2', 'g3', 'gX'], 'nope']) {
      const x = s();
      expect(m.goalQueueReorder(x, order)).toBe(false);
      expect(x.goal.queue.map((g) => g.goalId)).toEqual(['g2', 'g3', 'g4']);
    }
    expect(m.goalQueueReorder({}, ['g2'])).toBe(false);
  });
});

// Second pass (goal evaluation 2026-11-26: "모든 기능" — the menus and model · effort were left out): the goal composer
// has every feature of the instruction composer.
describe('the goal composer — the instruction composer’s menus and model · effort', () => {
  it('the session menus (/ commands, % settings, $ skills) — the same loaded set the instruction composer has', () => {
    const { m, made } = composerRig();
    m.paintGoalComposer(el('ui-goal-card'), session('k'), true);
    expect(made[0].writes).toHaveLength(1);
    expect((made[0].writes[0] as any).triggers).toBe(MENUS);
  });

  it('before the menus load there are none; when they load, the next paint hands them over (once)', () => {
    const rig = composerRig({ menus: null });
    const card = el('ui-goal-card');
    rig.m.paintGoalComposer(card, session('k'), true);
    const c = rig.made[0];
    expect('triggers' in (c.writes[0] as any)).toBe(false);
    rig.loadMenus(MENUS);
    rig.m.paintGoalComposer(card, session('k'), true);
    rig.m.paintGoalComposer(card, session('k'), true);
    expect(c.writes).toHaveLength(2);
    expect((c.writes[1] as any).triggers).toBe(MENUS);
  });

  it('model · effort on its row: a slot="end" control with the session picker, hydrated; written only when it changed', () => {
    const rig = composerRig();
    const card = el('ui-goal-card');
    rig.m.paintGoalComposer(card, session('k'), true);
    expect(rig.ctls).toHaveLength(1);
    const ctl = rig.ctls[0];
    expect(ctl.slot).toBe('end');
    expect(ctl.className).toBe('panel-controls gc-controls');
    expect(ctl.getAttribute('aria-label')).toBe('이 세션의 모델과 추론 강도');
    expect(ctl.parentNode).toBe(rig.made[0]);
    expect(rig.panelPickerHtml).toHaveBeenCalledWith(expect.objectContaining({ key: 'k' }), 'goal');
    expect(ctl.innerHTML).toBe('<picker k>');
    expect(rig.mpHydrate).toHaveBeenCalledWith(ctl);
    rig.m.paintGoalComposer(card, session('k'), true);
    expect(rig.morphInnerHtml).toHaveBeenCalledTimes(1);
    expect(rig.mpHydrate).toHaveBeenCalledTimes(2);
  });

  it('an open model menu holds its trigger: no rewrite while picking (its data still follows)', () => {
    const rig = composerRig({ picking: true });
    rig.m.paintGoalComposer(el('ui-goal-card'), session('k'), true);
    expect(rig.morphInnerHtml).not.toHaveBeenCalled();
    expect(rig.mpHydrate).toHaveBeenCalled();
  });

  it('the goal surface draws the panel’s picker compact always (its row is shorter), the panel’s only when narrow', () => {
    const m = load<{ renderModelPicker(...a: unknown[]): string; __set(n: string, v: unknown): void }>(
      ['renderModelPicker'],
      ['_pcCompact'],
      { escAttr: (v: string) => String(v) },
    );
    const s = { key: 'k' };
    const goal = m.renderModelPicker(s, true, 'opus', 'goal', '');
    expect(goal).toContain(' compact');
    expect(goal).toContain('data-mp-surface="panel"');
    expect(goal).toContain(' side="top"');
    expect(m.renderModelPicker(s, true, 'opus', 'panel', '')).not.toContain(' compact');
    m.__set('_pcCompact', true);
    expect(m.renderModelPicker(s, true, 'opus', 'panel', '')).toContain(' compact');
    expect(m.renderModelPicker(s, true, 'opus', 'goal', '').split(' compact').length - 1).toBe(1);
    expect(m.renderModelPicker(s, true, 'opus', 'card', '')).not.toContain(' compact');
  });

  it('its send spins while this session’s goal composer sends a command', () => {
    const { m } = composerRig();
    m.__set('_gcSending', 'k');
    expect(m.goalComposerData(session('k')).busy).toBe(true);
    expect(m.goalComposerData(session('j')).busy).toBe(false);
  });

  it('the instruction composer’s picker paint and fit carry the goal composer’s; menus loading repaint it', () => {
    expect(clientFn('repaintPanelControlsFor')).toContain(
      'if (_gcComposer && _gcComposer.key === key) paintGoalComposerControls(_gcComposer, _sessionCache[key]);',
    );
    expect(clientFn('cmLoadMenus')).toContain("if (typeof gcRepaint === 'function') gcRepaint();");
    // The goal composer's picker uses the panel's switch rule.
    const rule = "viewerCanManage(s) && !s.terminated && s.sessionState !== 'SLEEPING' && !isSiblingSession(s)";
    expect(clientFn('renderPanelControls')).toContain(rule);
    expect(clientFn('panelCanSwitch')).toContain(rule);
  });
});

describe('the goal composer — a command is not a goal (gcIsCommand)', () => {
  const rig = (menus: unknown) =>
    load<{ gcIsCommand(t: string): boolean }>(['gcIsCommand'], [], {
      cmTriggersFor: (where: string) => (where === 'session' ? menus : null),
    });

  it('% settings, ! stop, and a / command the menu offers (by its first word) are commands', () => {
    const m = rig(MENUS);
    for (const t of [
      '%effort high',
      '%',
      '!',
      '! 이거 말고 테스트부터',
      '/model opus',
      '  /model',
      '/compact',
      '/compact --yes',
    ])
      expect(m.gcIsCommand(t), t).toBe(true);
  });

  it('a goal is not: plain words, a $skill (it runs on the goal’s first turn), a path or a / word the menu does not offer', () => {
    const m = rig(MENUS);
    for (const t of ['', '릴리즈 노트 써줘', '배포 $z proceed', '$z proceed', '/tmp 정리해줘', '/models', 'a/b 고쳐줘'])
      expect(m.gcIsCommand(t), t).toBe(false);
  });

  it('before the menus load: a /word is a command, a path is not', () => {
    const m = rig(null);
    expect(m.gcIsCommand('/model opus')).toBe(true);
    expect(m.gcIsCommand('/tmp/foo 정리')).toBe(false);
    expect(m.gcIsCommand('%effort high')).toBe(true);
  });
});

describe('the goal composer — a command goes the instruction composer’s way (executed)', () => {
  function cmdRig(opts: { sent?: unknown; mode?: string; pcSending?: boolean; panelKey?: string } = {}) {
    let busyDuring: unknown = null;
    const m: any = load<any>(['commandFromGoalComposer'], ['_gcSending'], {
      _sessionCache: { k: { key: 'k' } },
      panelSessionKey: opts.panelKey ?? 'k',
      _pcSending: !!opts.pcSending,
      pcModeOf: () => opts.mode ?? 'open',
      dashToast: vi.fn(),
      repaintPanelGoalFor: vi.fn(),
      sendCommand: vi.fn(async () => {
        busyDuring = m.__get('_gcSending');
        return opts.sent === undefined ? true : opts.sent;
      }),
    });
    return { m, busyDuring: () => busyDuring };
  }
  const composer = (key: string, value: string) => {
    const c = el('ui-composer');
    c.setAttribute('data-goal-key', key);
    c.value = value;
    return c;
  };

  it('sent through sendCommand with its files, marked from the goal composer; it spins meanwhile and clears once sent', async () => {
    const r = cmdRig();
    const c = composer('k', '/model opus ');
    const files = [{ name: 'a.png' }];
    expect(await r.m.commandFromGoalComposer('k', ' /model opus ', files, c)).toBe(true);
    const inj = r.m.__get('sendCommand');
    expect(inj).toHaveBeenCalledWith('/model opus', '', files, 'gc');
    expect(r.busyDuring()).toBe('k');
    expect(r.m.__get('_gcSending')).toBe('');
    expect(r.m.__get('repaintPanelGoalFor')).toHaveBeenCalledTimes(2);
    expect(c.clear).toHaveBeenCalled();
  });

  it('not sent (refused, or a file that could not be read — sendCommand answers false or nothing): the words stay', async () => {
    for (const sent of [false, null]) {
      const r = cmdRig({ sent });
      const c = composer('k', '%effort high');
      expect(await r.m.commandFromGoalComposer('k', '%effort high', [], c)).toBe(false);
      expect(c.clear).not.toHaveBeenCalled();
      expect(r.m.__get('_gcSending')).toBe('');
    }
  });

  it('a session the instruction composer cannot send to (closed, asleep, read-only): a toast, nothing sent', async () => {
    for (const mode of ['closed', 'readonly']) {
      const r = cmdRig({ mode });
      expect(await r.m.commandFromGoalComposer('k', '/model opus', [], composer('k', '/model opus'))).toBe(false);
      expect(r.m.__get('sendCommand')).not.toHaveBeenCalled();
      expect(r.m.__get('dashToast')).toHaveBeenCalledWith(
        expect.objectContaining({ title: '이 세션에는 지금 명령을 보낼 수 없어요', tone: 'error' }),
      );
    }
  });

  it('one send at a time across both composers; never for a session the panel no longer shows', async () => {
    for (const r of [cmdRig({ pcSending: true }), cmdRig({ panelKey: 'j' })]) {
      expect(await r.m.commandFromGoalComposer('k', '/model opus', [], composer('k', '/model opus'))).toBe(false);
      expect(r.m.__get('sendCommand')).not.toHaveBeenCalled();
    }
  });

  it('sendCommand from the goal composer gives nothing back to the instruction composer (the goal composer keeps its words)', () => {
    const src = clientFn('sendCommand');
    expect(src).toContain("var giveBack = from === 'gc' ? function() {} : pcGiveBack;");
    expect(src).not.toMatch(/pcGiveBack\(el/);
  });
});

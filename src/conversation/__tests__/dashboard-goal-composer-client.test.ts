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

const VARS = ['GOAL_OBJECTIVE_MAX', 'PC_LIMITS', '_goalBusy', '_gcComposer'];

/** A light-DOM element double: attributes, a parent, children, the composer API the page calls. */
function el(tag: string): any {
  const attrs: Record<string, string> = {};
  const node: any = {
    tagName: tag.toUpperCase(),
    slot: '',
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

function composerRig(opts: { busy?: Record<string, unknown>; dictation?: boolean } = {}) {
  const made: any[] = [];
  const document = {
    documentElement: { lang: 'ko' },
    createElement: (tag: string) => {
      const n = el(tag);
      made.push(n);
      return n;
    },
  };
  const quietDictation = vi.fn();
  const m = load<{
    goalComposerData(s: unknown): any;
    paintGoalComposer(card: unknown, s: unknown, canEdit: boolean): void;
    goalComposerReset(): void;
    __get(n: string): any;
  }>(['goalComposerData', 'goalComposerQuiet', 'paintGoalComposer', 'goalComposerReset'], VARS, {
    document,
    window: {},
    ntDictationUsable: () => opts.dictation ?? false,
    ntDictationTool: (on: boolean) => ({ id: 'dictate', label: '받아쓰기', icon: 'edit', pressed: !!on }),
    ntDictating: () => false,
    ntDictateStopIn: quietDictation,
  });
  if (opts.busy) Object.assign(m.__get('_goalBusy'), opts.busy);
  return { m, made, quietDictation };
}

const session = (key: string, current: unknown = { goalId: 'g1', objective: 'x', status: 'active' }) => ({
  key,
  goal: current ? { current, queue: [] } : null,
});

describe('the goal composer — what <ui-composer collapse> in the card’s add slot is given', () => {
  it('the instruction composer’s file limits, a counter at the route cap, a worded 추가, the key hint; one line until focused', () => {
    const { m } = composerRig();
    const d = m.goalComposerData(session('k'));
    expect(d).toMatchObject({
      label: '목표 추가',
      placeholder: '목표 추가 — 지금 목표 다음에 시작',
      submitLabel: '추가',
      hint: true,
      minRows: 2,
      maxRows: 8,
      maxLength: 4000,
      maxFiles: 10,
      maxFileSize: 20971520,
      maxTotalBytes: 31457280,
      busy: false,
    });
    // Files, images and voice are the element's defaults (attach / image / voice on).
    expect('attach' in d || 'image' in d || 'voice' in d || 'accept' in d).toBe(false);
    // No command menus: a goal's words run as written.
    expect(d.triggers).toBeUndefined();
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
      COMPOSER_LISTENERS,
    )(
      { addEventListener: (t: string, fn: (e: any) => void) => (on[t] = fn) },
      { k: { key: 'k' } },
      addGoalFromComposer,
      ntDictateStopIn,
      ntOnComposerTool,
      ntDictationHost,
      isGoalComposer,
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
    return { on, addGoalFromComposer, ntDictateStopIn, ntOnComposerTool, ntDictationHost, goalComposer, fire };
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
  });

  it('the dictation host writes into the goal composer and repaints the goal section', () => {
    const repaintPanelGoalFor = vi.fn();
    const composerEl = el('ui-composer');
    const m = load<{ ntDictationHost(id: string): any }>(['ntDictationHost'], [], {
      _gcComposer: { key: 'k', el: composerEl },
      repaintPanelGoalFor,
      panelSessionKey: 'k',
      dashToast: vi.fn(),
    });
    const h = m.ntDictationHost('gc');
    expect(h.id).toBe('gc');
    expect(h.el()).toBe(composerEl);
    h.paint();
    expect(repaintPanelGoalFor).toHaveBeenCalledWith('k');
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

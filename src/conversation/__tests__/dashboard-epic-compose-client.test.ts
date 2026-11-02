/**
 * E4 ⑨b (.prd/19 D12) — the composer's "에픽": a dashboard task made as an epic, offered only when the
 * new-task context says the user may make one (their epicTasks flag; the server checks it again).
 * Runs the shipped client code cut out of renderDashboardPage()'s template, with fakes — no DOM.
 *
 *   C1 the task body carries kind: 'epic' only for an epic; a Slack body never does.
 *   C2 the chip toggles only for a dashboard task with the flag; leaving the task destination drops it.
 *   C3 ntRender shows the chip only for a dashboard task with the flag, pressed when chosen.
 *   C4 a launch that did not start keeps the epic choice; a started one does not.
 *   C5 the markup carries the chip in the destination row.
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
function load<T>(fns: string[], inject: Record<string, unknown> = {}, seam = ''): T {
  const names = Object.keys(inject);
  const seamName = /^function (\w+)/.exec(seam)?.[1];
  const body = `${fns.map(clientFn).join('\n')}\n${seam}\nreturn { ${[...fns, ...(seamName ? [seamName] : [])].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const ctx = { defaultModel: 'opus', defaultEffort: 'high', defaultChannelId: 'C1', autogoalDefault: false };

describe('C1 — the request body', () => {
  const m = load<{ ntDefaultState(c: unknown, d: unknown): any; ntBuildPayload(s: any, a: any[], r: string): any }>([
    'ntDefaultState',
    'ntBuildPayload',
  ]);
  const task = (over: Record<string, unknown> = {}) => ({
    ...m.ntDefaultState(ctx, null),
    destination: 'task',
    prompt: '로그인 고쳐줘',
    ...over,
  });
  it('an epic task says so; a plain task and a Slack launch never do', () => {
    expect(m.ntBuildPayload(task({ kind: 'epic' }), [], 'req-1')).toEqual({
      requestId: 'req-1',
      destination: 'task',
      prompt: '로그인 고쳐줘',
      model: 'opus',
      kind: 'epic',
    });
    expect(m.ntBuildPayload(task(), [], 'req-1').kind).toBeUndefined();
    expect(m.ntBuildPayload(task({ kind: 'bogus' }), [], 'req-1').kind).toBeUndefined();
    expect(m.ntBuildPayload({ ...task({ kind: 'epic' }), destination: 'slack' }, [], 'req-1').kind).toBeUndefined();
  });
});

type Chip = { hidden: boolean; attrs: Record<string, string>; setAttribute(k: string, v: string): void };
const chip = (): Chip => {
  const c: Chip = {
    hidden: true,
    attrs: {},
    setAttribute(k, v) {
      c.attrs[k] = v;
    },
  };
  return c;
};

function composer(ntCtx: Record<string, unknown>, state: Record<string, unknown>) {
  let renders = 0;
  const m = load<{
    ntToggleEpic(): void;
    ntSetDestination(d: string): void;
    get(): { state: any };
  }>(
    ['ntToggleEpic', 'ntSetDestination'],
    {
      _ntState: state,
      _ntCtx: ntCtx,
      ntRender: () => {
        renders++;
      },
      ntSetError: () => {},
      ntBlockedHint: () => '',
      ntComposerFiles: () => [],
    },
    'function get() { return { state: _ntState }; }',
  );
  return { m, renders: () => renders };
}

describe('C2 — the chip toggles only where an epic can be made', () => {
  it('a dashboard task with the flag toggles epic on and off', () => {
    const state = { destination: 'task' } as Record<string, unknown>;
    const c = composer({ taskFolders: [], epicTasks: true }, state);
    c.m.ntToggleEpic();
    expect(state.kind).toBe('epic');
    c.m.ntToggleEpic();
    expect(state.kind).toBe('');
    expect(c.renders()).toBe(2);
  });
  it('no flag, or a Slack launch: nothing changes', () => {
    const noFlag = { destination: 'task' } as Record<string, unknown>;
    composer({ taskFolders: [] }, noFlag).m.ntToggleEpic();
    expect(noFlag.kind).toBeUndefined();
    const slack = { destination: 'slack' } as Record<string, unknown>;
    composer({ taskFolders: [], epicTasks: true }, slack).m.ntToggleEpic();
    expect(slack.kind).toBeUndefined();
  });
  it('leaving the task destination drops the epic; staying keeps it', () => {
    const state = { destination: 'task', kind: 'epic' } as Record<string, unknown>;
    const c = composer({ taskFolders: [], epicTasks: true }, state);
    c.m.ntSetDestination('task');
    expect(state.kind).toBe('epic');
    c.m.ntSetDestination('slack');
    expect(state.destination).toBe('slack');
    expect(state.kind).toBe('');
  });
});

describe('C3 — ntRender shows and presses the chip', () => {
  const body = clientFn('ntRender');
  it('hidden unless a dashboard task with the flag; pressed when chosen', () => {
    const block = body.slice(body.indexOf("var epicChip = ntEl('nt-kind-epic');"), body.indexOf('var folderSel'));
    expect(block).toContain('epicChip.hidden = !(isTask && _ntCtx.epicTasks);');
    expect(block).toContain("isTask && _ntCtx.epicTasks && _ntState.kind === 'epic' ? 'true' : 'false'");
    // Executed: the four cases.
    const run = new Function('ntEl', 'isTask', '_ntCtx', '_ntState', `${block}\nreturn true;`);
    for (const [isTask, flag, kind, hidden, pressed] of [
      [true, true, 'epic', false, 'true'],
      [true, true, '', false, 'false'],
      [true, false, 'epic', true, 'false'],
      [false, true, 'epic', true, 'false'],
    ] as const) {
      const c = chip();
      run((id: string) => (id === 'nt-kind-epic' ? c : null), isTask, { epicTasks: flag }, { kind });
      expect([c.hidden, c.attrs['aria-pressed']]).toEqual([hidden, pressed]);
    }
  });
});

describe('C4 — after a launch', () => {
  const m = load<{ ntDefaultState(c: unknown, d: unknown): any; ntStateAfterLaunch(p: any, d: any, c: any): any }>([
    'ntDefaultState',
    'ntStateAfterLaunch',
  ]);
  const taskCtx = { ...ctx, taskFolders: [] };
  it('a task that did not start keeps the epic choice; a started one starts fresh', () => {
    const prev = { ...m.ntDefaultState(taskCtx, null), destination: 'task', kind: 'epic', prompt: 'x' };
    expect(m.ntStateAfterLaunch(prev, { status: 'not-started' }, taskCtx).kind).toBe('epic');
    expect(m.ntStateAfterLaunch(prev, { status: 'running' }, taskCtx).kind).toBeUndefined();
    const slackPrev = { ...prev, destination: 'slack' };
    expect(m.ntStateAfterLaunch(slackPrev, { status: 'not-started' }, taskCtx).kind).toBeUndefined();
  });
});

describe('C6 — reconcile: an epic only while it is offered (grok, fable #707 R1)', () => {
  const m = load<{ ntDefaultState(c: unknown, d: unknown): any; ntReconcile(s: any, c: any): void }>(
    ['ntDefaultState', 'ntReconcile', 'mpLevelsOf', 'fitEffortLevel'],
    {
      EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      SDK_EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  );
  const offered = {
    ...ctx,
    models: [{ nickname: 'opus' }],
    efforts: ['high'],
    channels: [{ id: 'C1' }],
    taskFolders: [],
    epicTasks: true,
  };
  const epicTask = () => ({ ...m.ntDefaultState(offered, null), destination: 'task', kind: 'epic' });
  it('kept while the flag is on and the destination is a dashboard task', () => {
    const s = epicTask();
    m.ntReconcile(s, offered);
    expect(s.kind).toBe('epic');
  });
  it('dropped when the flag is gone, or the dashboard task is no longer offered', () => {
    const noFlag = epicTask();
    m.ntReconcile(noFlag, { ...offered, epicTasks: undefined });
    expect(noFlag.kind).toBe('');
    const noTasks = epicTask();
    m.ntReconcile(noTasks, { ...offered, taskFolders: undefined });
    expect(noTasks.destination).toBe('slack');
    expect(noTasks.kind).toBe('');
  });
});

describe('C5 — the markup', () => {
  it('the chip sits in the destination row, hidden until offered', () => {
    const row = TEMPLATE.slice(TEMPLATE.indexOf('id="nt-dest"'), TEMPLATE.indexOf('id="nt-dest"') + 1200);
    expect(row).toContain('id="nt-kind-epic" aria-pressed="false" hidden');
    expect(row).toContain('onclick="ntToggleEpic()"');
    expect(row.indexOf('id="nt-kind-epic"')).toBeGreaterThan(row.indexOf('id="nt-dest-task"'));
  });
});

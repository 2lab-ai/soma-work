/**
 * E4 ⑨b (.prd/19 D12) — the composer's "에픽", offered only when the new-task context says the user
 * may make one (their epicTasks flag; the server checks it again). Since #854 an epic is a Slack
 * task like any other: the chip rides the Slack destination.
 * Runs the shipped client code cut out of renderDashboardPage()'s template, with fakes — no DOM.
 *
 *   C1 the Slack body carries epic: true only for an epic.
 *   C2 the chip toggles with the flag, whatever the destination; no flag, nothing changes.
 *   C3 ntRender shows the chip with the flag, pressed when chosen; the row (with the plan switch)
 *      shows while the destination chips wait for task folders that are no longer offered.
 *   C4 a launch that did not start keeps the epic choice; a started one does not.
 *   C5 the markup carries the chip in the row with the plan switch.
 *   C6 reconcile keeps an epic only while the flag is on.
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
  const slack = (over: Record<string, unknown> = {}) => ({
    ...m.ntDefaultState(ctx, null),
    prompt: '로그인 고쳐줘',
    ...over,
  });
  it('an epic Slack task says so; a plain one never does', () => {
    expect(m.ntBuildPayload(slack({ kind: 'epic' }), [], 'req-1')).toMatchObject({
      requestId: 'req-1',
      prompt: '로그인 고쳐줘',
      channelId: 'C1',
      epic: true,
      plan: true, // plan mode is on by default; an epic plans before it makes children
    });
    expect(m.ntBuildPayload(slack(), [], 'req-1').epic).toBeUndefined();
    expect(m.ntBuildPayload(slack({ kind: 'bogus' }), [], 'req-1').epic).toBeUndefined();
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
  it('with the flag, a Slack task toggles epic on and off', () => {
    const state = { destination: 'slack' } as Record<string, unknown>;
    const c = composer({ epicTasks: true }, state);
    c.m.ntToggleEpic();
    expect(state.kind).toBe('epic');
    c.m.ntToggleEpic();
    expect(state.kind).toBe('');
    expect(c.renders()).toBe(2);
  });
  it('no flag: nothing changes', () => {
    const noFlag = { destination: 'slack' } as Record<string, unknown>;
    composer({}, noFlag).m.ntToggleEpic();
    expect(noFlag.kind).toBeUndefined();
  });
  it('the destination never drops the epic (one kind of work session); no task folders → Slack', () => {
    const state = { destination: 'slack', kind: 'epic' } as Record<string, unknown>;
    const c = composer({ epicTasks: true }, state);
    c.m.ntSetDestination('task');
    expect(state.destination).toBe('slack');
    expect(state.kind).toBe('epic');
  });
});

describe('C3 — ntRender shows and presses the chip', () => {
  const body = clientFn('ntRender');
  it('hidden unless the flag is on; pressed when chosen — any destination', () => {
    const block = body.slice(body.indexOf("var epicChip = ntEl('nt-kind-epic');"), body.indexOf('var folderSel'));
    expect(block).toContain('epicChip.hidden = !_ntCtx.epicTasks;');
    expect(block).toContain("_ntCtx.epicTasks && _ntState.kind === 'epic' ? 'true' : 'false'");
    // Executed: the four cases.
    const run = new Function('ntEl', 'isTask', '_ntCtx', '_ntState', `${block}\nreturn true;`);
    for (const [isTask, flag, kind, hidden, pressed] of [
      [false, true, 'epic', false, 'true'],
      [false, true, '', false, 'false'],
      [false, false, 'epic', true, 'false'],
      [true, true, 'epic', false, 'true'],
    ] as const) {
      const c = chip();
      run((id: string) => (id === 'nt-kind-epic' ? c : null), isTask, { epicTasks: flag }, { kind });
      expect([c.hidden, c.attrs['aria-pressed']]).toEqual([hidden, pressed]);
    }
  });
});

describe('C3b — the row with the plan switch and the epic chip shows; the destination chips do not (#854)', () => {
  it('the row is never hidden; the two destination chips wait for task folders, no longer offered', () => {
    const body = clientFn('ntRender');
    const block = body.slice(
      body.indexOf("var dest = ntEl('nt-dest');"),
      body.indexOf("var folderChip = ntEl('nt-folder-chip');"),
    );
    const run = new Function('ntEl', 'isTask', '_ntCtx', `${block}\nreturn true;`);
    const els: Record<string, Chip> = { 'nt-dest': chip(), 'nt-dest-slack': chip(), 'nt-dest-task': chip() };
    els['nt-dest'].hidden = true;
    els['nt-dest-slack'].hidden = false;
    run((id: string) => els[id] ?? null, false, {});
    expect(els['nt-dest'].hidden).toBe(false);
    expect(els['nt-dest-slack'].hidden).toBe(true);
    expect(els['nt-dest-task'].hidden).toBe(true);
  });
});

describe('C4 — after a launch', () => {
  const m = load<{ ntDefaultState(c: unknown, d: unknown): any; ntStateAfterLaunch(p: any, d: any, c: any): any }>([
    'ntDefaultState',
    'ntStateAfterLaunch',
  ]);
  const taskCtx = { ...ctx, taskFolders: [] };
  it('a task that did not start keeps the epic choice while the flag is on; a started one starts fresh', () => {
    const epicCtx = { ...taskCtx, epicTasks: true };
    const prev = { ...m.ntDefaultState(epicCtx, null), kind: 'epic', prompt: 'x' };
    expect(m.ntStateAfterLaunch(prev, { status: 'not-started' }, epicCtx).kind).toBe('epic');
    expect(m.ntStateAfterLaunch(prev, { status: 'running' }, epicCtx).kind).toBeUndefined();
    expect(m.ntStateAfterLaunch(prev, { status: 'not-started' }, taskCtx).kind).toBeUndefined();
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
  const epicTask = () => ({ ...m.ntDefaultState(offered, null), kind: 'epic' });
  it('kept while the flag is on — a Slack task too; no task folders → the Slack destination', () => {
    const s = epicTask();
    m.ntReconcile(s, { ...offered, taskFolders: undefined });
    expect(s.kind).toBe('epic');
    expect(s.destination).toBe('slack');
  });
  it('dropped when the flag is gone', () => {
    const noFlag = epicTask();
    m.ntReconcile(noFlag, { ...offered, epicTasks: undefined });
    expect(noFlag.kind).toBe('');
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

/**
 * The settings page 작업 큐 tab, client half: a knob per person, turned like a volume dial (1 to 10, then ∞), that
 * says what it is to a screen reader, turns by drag, wheel and keys, and saves the step it rests on. Functions are cut
 * out of the shipped script.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderSettingsPage, SETTINGS_CLIENT_JS, SETTINGS_TABS } from '../settings-page';
import { TASK_QUEUE_CLIENT_JS, TASK_QUEUE_TAB_HTML } from '../settings-task-queue-tab';

const ALL_JS = `${TASK_QUEUE_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`;

function clientFn(name: string): string {
  const plain = ALL_JS.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : ALL_JS.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = ALL_JS.indexOf('\n}\n', start);
  return ALL_JS.slice(start + 1, end + 2);
}
const VARS =
  'var TQ_MAX = 10; var TQ_SWEEP = 270; var TQ_PX_PER_STEP = 14; var _tq = null; var _tqSaveTimers = { U1: 7 }; var _tqWriteSeq = {}; var _tqWriteChain = {}; var _tqCpuSeq = {}; var _tqCpuChain = {};';
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${VARS}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, setTq: function (v) { _tq = v; } };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const KNOB = [
  'tqStepOf',
  'tqSettingOf',
  'tqLabel',
  'tqClamp',
  'tqAngle',
  'tqPoint',
  'tqArc',
  'tqStepFromKey',
  'tqStepFromDrag',
  'tqKnobSvg',
  'tqRow',
  'tqCpuLabel',
  'tqCpuHtml',
  'esc',
  'escAttr',
];

describe('the knob', () => {
  const k = load<any>(KNOB);

  it('1..10 are themselves; no limit is the step past 10 (∞)', () => {
    expect(k.tqStepOf(1)).toBe(1);
    expect(k.tqStepOf(7)).toBe(7);
    expect(k.tqStepOf(null)).toBe(11);
    expect(k.tqStepOf('unlimited')).toBe(11);
    expect(k.tqSettingOf(3)).toBe(3);
    expect(k.tqSettingOf(11)).toBe('unlimited');
    expect(k.tqLabel(1)).toBe('1개');
    expect(k.tqLabel(11)).toBe('무제한');
  });

  it('turns from the lower left (1) to the lower right (∞) like a volume knob', () => {
    expect(k.tqAngle(1)).toBe(-135);
    expect(k.tqAngle(11)).toBe(135);
    expect(k.tqAngle(6)).toBe(0);
  });

  it('keys: arrows step, Page keys jump 3, Home is 1, End is ∞; never past the ends', () => {
    expect(k.tqStepFromKey(1, 'ArrowUp')).toBe(2);
    expect(k.tqStepFromKey(1, 'ArrowRight')).toBe(2);
    expect(k.tqStepFromKey(1, 'ArrowDown')).toBe(1);
    expect(k.tqStepFromKey(5, 'PageUp')).toBe(8);
    expect(k.tqStepFromKey(5, 'PageDown')).toBe(2);
    expect(k.tqStepFromKey(5, 'Home')).toBe(1);
    expect(k.tqStepFromKey(5, 'End')).toBe(11);
    expect(k.tqStepFromKey(11, 'ArrowUp')).toBe(11);
    expect(k.tqStepFromKey(5, 'a')).toBe(5);
  });

  it('a drag up or right turns it up, down or left turns it down — 14px a step', () => {
    expect(k.tqStepFromDrag(1, 0, -28)).toBe(3);
    expect(k.tqStepFromDrag(1, 42, 0)).toBe(4);
    expect(k.tqStepFromDrag(5, 0, 30)).toBe(3);
    expect(k.tqStepFromDrag(5, 0, 5)).toBe(5);
    expect(k.tqStepFromDrag(5, 0, -1000)).toBe(11);
  });

  it('a row is a labelled slider with its value said in words', () => {
    const html = k.tqRow(
      { id: 'U1', name: 'Alice', admin: false, limit: 3, setting: 3, defaultLimit: 1, running: 1, waiting: 2 },
      true,
    );
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Alice 동시 작업 한도"');
    expect(html).toContain('aria-valuemin="1" aria-valuemax="11"');
    expect(html).toContain('aria-valuenow="3" aria-valuetext="3개"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('진행 중 1 · 대기 2');
    expect(html).toContain('기본값으로');
    expect(html).toContain('<svg');
  });

  it('a row at the default says so; without admin mode the knob is inert', () => {
    const html = k.tqRow(
      { id: 'UA', name: 'Admin', admin: true, limit: null, setting: null, defaultLimit: null, running: 0, waiting: 0 },
      false,
    );
    expect(html).toContain('is-default');
    expect(html).toContain('기본값 (무제한)');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).not.toContain('기본값으로');
    expect(html).toContain('관리자 · ');
  });
});

describe('saving', () => {
  it('a turn writes the step it rests on; the answer replaces the row', async () => {
    const apiWrite = vi.fn().mockResolvedValue({
      ok: true,
      data: { user: { id: 'U1', name: 'Alice', limit: null, setting: 'unlimited', defaultLimit: 1 } },
    });
    const tqStatus = vi.fn();
    const tqRefreshRow = vi.fn();
    const k = load<any>(['tqPut', 'tqUser', 'tqLabel', 'tqStepOf'], {
      apiWrite,
      tqStatus,
      tqRefreshRow,
      encodeURIComponent,
    });
    k.setTq({ users: [{ id: 'U1', name: 'Alice', limit: 1 }] });
    await k.tqPut('U1', 'unlimited');
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/settings/task-limits/U1', { limit: 'unlimited' });
    expect(tqStatus).toHaveBeenCalledWith('Alice: 동시 작업 무제한로 저장했습니다');
    expect(tqRefreshRow).toHaveBeenCalledWith('U1');
  });

  it('a refusal is said as an error and the knob goes back', async () => {
    const apiWrite = vi
      .fn()
      .mockResolvedValue({ ok: false, error: '관리자 모드를 켜야 작업 큐 한도를 바꿀 수 있습니다' });
    const tqStatus = vi.fn();
    const tqRefreshRow = vi.fn();
    const k = load<any>(['tqPut', 'tqUser', 'tqLabel', 'tqStepOf'], {
      apiWrite,
      tqStatus,
      tqRefreshRow,
      encodeURIComponent,
    });
    k.setTq({ users: [] });
    await k.tqPut('U1', 2);
    expect(tqStatus.mock.calls[0][1]).toBe(true);
    expect(tqRefreshRow).toHaveBeenCalledWith('U1');
  });
});

describe('writes in order', () => {
  it('기본값으로 drops a turn of the knob still waiting to be saved', () => {
    const tqPut = vi.fn();
    const clear = vi.fn();
    // _tqSaveTimers holds a pending save for U1 (timer 7, the knob's debounce).
    const k = load<any>(['tqReset'], { tqPut, clearTimeout: clear });
    k.tqReset({ getAttribute: () => 'U1' });
    expect(clear).toHaveBeenCalledWith(7);
    expect(tqPut).toHaveBeenCalledWith('U1', null);
  });

  it('one person’s writes reach the server in the order they were made', async () => {
    const order: unknown[] = [];
    let resolveFirst!: (v: unknown) => void;
    const apiWrite = vi.fn((_m: string, _u: string, body: { limit: unknown }) => {
      order.push(body.limit);
      return order.length === 1
        ? new Promise((r) => (resolveFirst = r))
        : Promise.resolve({
            ok: true,
            data: { user: { id: 'U1', name: 'Alice', limit: 2, setting: 2, defaultLimit: 1 } },
          });
    });
    const k = load<any>(['tqPut', 'tqUser', 'tqLabel', 'tqStepOf'], {
      apiWrite,
      tqStatus: vi.fn(),
      tqRefreshRow: vi.fn(),
      encodeURIComponent,
    });
    k.setTq({ users: [{ id: 'U1', name: 'Alice', limit: 1 }] });
    const first = k.tqPut('U1', 5);
    const second = k.tqPut('U1', 2);
    await new Promise((r) => setTimeout(r, 0));
    // The second write waits for the first to be answered.
    expect(order).toEqual([5]);
    resolveFirst({ ok: true, data: { user: { id: 'U1', name: 'Alice', limit: 5, setting: 5, defaultLimit: 1 } } });
    await first;
    await second;
    expect(order).toEqual([5, 2]);
  });

  it('an answer to a write a later one replaced moves nothing', async () => {
    let resolveFirst!: (v: unknown) => void;
    const apiWrite = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({
        ok: true,
        data: { user: { id: 'U1', name: 'Alice', limit: null, setting: null, defaultLimit: 1 } },
      });
    const tqStatus = vi.fn();
    const tqRefreshRow = vi.fn();
    const k = load<any>(['tqPut', 'tqUser', 'tqLabel', 'tqStepOf'], {
      apiWrite,
      tqStatus,
      tqRefreshRow,
      encodeURIComponent,
    });
    k.setTq({ users: [{ id: 'U1', name: 'Alice', limit: 1 }] });
    const first = k.tqPut('U1', 5);
    const second = k.tqPut('U1', null);
    await new Promise((r) => setTimeout(r, 0));
    resolveFirst({ ok: true, data: { user: { id: 'U1', name: 'Alice', limit: 5, setting: 5, defaultLimit: 1 } } });
    await first;
    await second;
    expect(tqStatus).toHaveBeenCalledTimes(1);
    expect(tqStatus.mock.calls[0][0]).toContain('기본값');
  });
});

describe('the tab', () => {
  it('is listed for admins only and ships its panel, sheet and script', () => {
    expect(SETTINGS_TABS.find((t) => t.id === 'task-queue')).toEqual({
      id: 'task-queue',
      label: '작업 큐',
      icon: 'list',
      adminOnly: true,
    });
    const html = renderSettingsPage();
    expect(html).toContain('<div slot="task-queue" data-tab="task-queue" class="page" hidden>');
    expect(html).toContain('.tq-knob');
    expect(html).toContain('function loadTaskQueue()');
    expect(html).toContain("if (id === 'task-queue' && !_tqLoaded) loadTaskQueue();");
  });

  it('the shipped script has no template holes', () => {
    expect(TASK_QUEUE_CLIENT_JS).not.toContain('${');
    expect(TASK_QUEUE_CLIENT_JS).not.toContain('`');
  });
});

describe('the CPU cap', () => {
  it('each row picks the cap on one of the person’s tasks: 기본값 (100%), the choices, 무제한; what applies now is said', () => {
    const k = load<any>(KNOB);
    k.setTq({ cpuChoices: [50, 100, 200, 400, 800] });
    const html = k.tqCpuHtml({ id: 'U1', name: 'Alice', cpu: { limit: 200, setting: 200, defaultLimit: 100 } }, true);
    expect(html).toContain('<option value="">기본값 (100%)</option>');
    expect(html).toContain('<option value="200" selected>200%</option>');
    expect(html).toContain('<option value="unlimited">무제한</option>');
    expect(html).toContain('onchange="tqCpuChange(this)"');
    expect(html).toContain('<span>지금 200%</span>');
    expect(html).toContain('aria-label="Alice 작업 하나의 CPU 한도"');
    // An admin at the default: 무제한; without admin mode the choice is inert.
    const admin = k.tqCpuHtml(
      { id: 'U2', name: 'Admin', cpu: { limit: null, setting: null, defaultLimit: null } },
      false,
    );
    expect(admin).toContain('<option value="" selected>기본값 (무제한)</option>');
    expect(admin).toContain('disabled');
    expect(admin).not.toContain('onchange');
    // No cap wiring: nothing.
    expect(k.tqCpuHtml({ id: 'U3', name: 'x' }, true)).toBe('');
  });

  it('a change writes the cap (null for 기본값, a number, or unlimited) and says what it saved', async () => {
    const writes: Array<[string, string, unknown]> = [];
    const statuses: string[] = [];
    // The server's row for each request: what it now enforces.
    const rowFor = (cpu: unknown) =>
      cpu === null
        ? { limit: 100, setting: null, defaultLimit: 100 }
        : cpu === 'unlimited'
          ? { limit: null, setting: 'unlimited', defaultLimit: 100 }
          : { limit: cpu, setting: cpu, defaultLimit: 100 };
    const k = load<any>([...KNOB, 'tqUser', 'tqCpuChange', 'tqCpuLabel'], {
      apiWrite: async (m: string, u: string, b: { cpu: unknown }) => {
        writes.push([m, u, b]);
        return { ok: true, data: { user: { id: 'U1', name: 'Alice', cpu: rowFor(b.cpu) } } };
      },
      tqStatus: (t: string) => {
        statuses.push(t);
      },
      tqRefreshRow: () => {},
    });
    const tq = { users: [{ id: 'U1', name: 'Alice' }] as Array<{ id: string; name: string; cpu?: unknown }> };
    k.setTq(tq);
    const sel = (value: string) => ({ value, getAttribute: () => 'U1' });
    await k.tqCpuChange(sel('400'));
    expect(statuses[statuses.length - 1]).toBe('Alice: 작업 하나의 CPU 한도 400%(으)로 저장했습니다');
    expect(tq.users[0].cpu).toEqual(rowFor(400));
    await k.tqCpuChange(sel(''));
    expect(statuses[statuses.length - 1]).toBe('Alice: 작업 하나의 CPU 한도 100% (기본값)(으)로 저장했습니다');
    expect(tq.users[0].cpu).toEqual(rowFor(null));
    await k.tqCpuChange(sel('unlimited'));
    expect(statuses[statuses.length - 1]).toBe('Alice: 작업 하나의 CPU 한도 무제한(으)로 저장했습니다');
    expect(tq.users[0].cpu).toEqual(rowFor('unlimited'));
    expect(writes).toEqual([
      ['PUT', '/api/settings/cpu-limits/U1', { cpu: 400 }],
      ['PUT', '/api/settings/cpu-limits/U1', { cpu: null }],
      ['PUT', '/api/settings/cpu-limits/U1', { cpu: 'unlimited' }],
    ]);
  });

  it('a later change that fails falls back to the last one the server took, not to what the page loaded with', async () => {
    let n = 0;
    const refreshed: unknown[] = [];
    const tq = {
      users: [{ id: 'U1', name: 'Alice', cpu: { limit: 100, setting: null, defaultLimit: 100 } }] as Array<{
        id: string;
        name: string;
        cpu?: unknown;
      }>,
    };
    const k = load<any>([...KNOB, 'tqUser', 'tqCpuChange', 'tqCpuLabel'], {
      apiWrite: async (_m: string, _u: string, b: { cpu: unknown }) => {
        n++;
        if (n === 1)
          return { ok: true, data: { user: { id: 'U1', name: 'Alice', cpu: { limit: 400, setting: 400 } } } };
        void b;
        return { ok: false, error: 'HTTP 500' };
      },
      tqStatus: () => {},
      tqRefreshRow: () => {
        refreshed.push(JSON.parse(JSON.stringify(tq.users[0].cpu)));
      },
    });
    k.setTq(tq);
    const sel = (value: string) => ({ value, getAttribute: () => 'U1' });
    const first = k.tqCpuChange(sel('400'));
    const second = k.tqCpuChange(sel('50'));
    await Promise.all([first, second]);
    // The 400% write was replaced on the page by the 50% one, which failed: the row shows 400% (what is enforced).
    expect(tq.users[0].cpu).toEqual({ limit: 400, setting: 400 });
    expect(refreshed[refreshed.length - 1]).toEqual({ limit: 400, setting: 400 });
  });

  it('a CPU save takes only the CPU fields: the row’s task limit (a knob save’s) is left as it is', async () => {
    const tq = { users: [{ id: 'U1', name: 'Alice', limit: 3, setting: 3, cpu: { limit: 100, setting: null } }] };
    const k = load<any>([...KNOB, 'tqUser', 'tqCpuChange', 'tqCpuLabel'], {
      // The CPU route answers a row whose task limit is stale (read before the knob's save landed).
      apiWrite: async () => ({
        ok: true,
        data: { user: { id: 'U1', name: 'Alice', limit: 1, setting: null, cpu: { limit: 200, setting: 200 } } },
      }),
      tqStatus: () => {},
      tqRefreshRow: () => {},
    });
    k.setTq(tq);
    await k.tqCpuChange({ value: '200', getAttribute: () => 'U1' });
    expect(tq.users[0]).toEqual({ id: 'U1', name: 'Alice', limit: 3, setting: 3, cpu: { limit: 200, setting: 200 } });
  });

  it('changes for one person are written in the order they were made: a slow first write never lands last', async () => {
    const started: unknown[] = [];
    const finish: Array<() => void> = [];
    const k = load<any>([...KNOB, 'tqUser', 'tqCpuChange'], {
      apiWrite: (_m: string, _u: string, b: { cpu: unknown }) => {
        started.push(b.cpu);
        return new Promise((resolve) => {
          finish.push(() =>
            resolve({ ok: true, data: { user: { id: 'U1', name: 'Alice', cpu: { limit: b.cpu, setting: b.cpu } } } }),
          );
        });
      },
      tqStatus: () => {},
      tqRefreshRow: () => {},
    });
    k.setTq({ users: [{ id: 'U1', name: 'Alice' }] });
    const sel = (value: string) => ({ value, getAttribute: () => 'U1' });
    const first = k.tqCpuChange(sel('400'));
    const second = k.tqCpuChange(sel('50'));
    await new Promise((r) => setTimeout(r, 0));
    // The second waits for the first: only one write is out.
    expect(started).toEqual([400]);
    finish[0]();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([400, 50]);
    finish[1]();
    await second;
  });
});

describe('.prd/36 v2 — the lanes, one at a time', () => {
  const HOUR = 60 * 60 * 1000;
  const lane = {
    id: 'qa-dev2',
    title: 'qa-dev2',
    kind: 'lane',
    capacity: 1,
    running: [
      {
        id: 'wq-3',
        state: 'running',
        position: 0,
        keys: ['ABC-3'],
        enteredAt: 0,
        startedAt: Date.now() - HOUR,
        task: { title: 'third', ownerName: 'Ann' },
      },
    ],
    waiting: [
      {
        id: 'wq-4',
        state: 'waiting',
        position: 1,
        keys: ['ABC-4'],
        enteredAt: Date.now() - 600_000,
        task: { title: '<b>fourth</b>', ownerName: 'Bob' },
      },
    ],
    recent: [
      {
        id: 'wq-2',
        end: 'done',
        keys: ['ABC-2'],
        enteredAt: 3 * HOUR,
        startedAt: 4 * HOUR,
        endedAt: 5 * HOUR,
        task: { title: 'second' },
      },
      {
        id: 'wq-1',
        end: 'released',
        reason: 'admin:U9',
        keys: ['ABC-1'],
        enteredAt: HOUR,
        startedAt: HOUR,
        endedAt: 3 * HOUR,
        task: { title: 'first' },
      },
    ],
  };
  const esc = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
    );
  const { tqLaneHtml } = load<any>(['tqClock', 'tqDur', 'wqReason', 'tqLaneHtml'], {
    esc,
    TQ_END: { done: '완료', cancelled: '취소', released: '차례 끝남' },
  });

  it('says how many run at once, what runs and waits now, and the history oldest first — each run after the last ended', () => {
    const html = tqLaneHtml(lane);
    expect(html).toContain('한 번에 1개 · 진행 1 · 대기 1');
    expect(html).toContain('▶ 진행 중: third');
    expect(html).toContain('⏳ 대기 #1: &lt;b&gt;fourth&lt;/b&gt;');
    expect(html.indexOf('wq-1')).toBeLessThan(html.indexOf('wq-2'));
    expect(html).toContain('차례 끝남');
    expect(html).toContain('(2시간)');
  });

  it("why an entry left says it in the reader's words, as the board's section does (관리자, not admin:U9)", () => {
    const html = tqLaneHtml(lane);
    expect(html).toContain('차례 끝남 <span class="tq-sub">관리자</span>');
    expect(html).not.toContain('admin:U9');
  });
});

describe('the tab speaks the settings grammar (2026-11-26, owner: "ui마다 개성을 뽐내고 있음")', () => {
  it('two section.group cards, each with its header (h2 + p) inside, and a side nav that jumps to them', () => {
    const groups = [
      ...TASK_QUEUE_TAB_HTML.matchAll(
        /<section class="group" id="([\w-]+)" aria-labelledby="([\w-]+)">\s*<header><h2 id="([\w-]+)">([^<]+)<\/h2><p>/g,
      ),
    ];
    expect(groups.map((m) => [m[1], m[2] === m[3], m[4]])).toEqual([
      ['tq-sec-lanes', true, '작업 큐 — 한 번에 하나씩'],
      ['tq-sec-people', true, '개인별 큐 — 사람마다 동시 작업 수'],
    ]);
    expect(TASK_QUEUE_TAB_HTML).toContain(`onclick="tqJump('tq-sec-lanes')">작업 큐 (레인)</button>`);
    expect(TASK_QUEUE_TAB_HTML).toContain(`onclick="tqJump('tq-sec-people')">개인별 큐</button>`);
    expect(TASK_QUEUE_TAB_HTML).not.toContain('tq-h');
    expect(TASK_QUEUE_TAB_HTML).not.toContain('레인 큐');
  });

  it('a lane with nothing in it and no history is one line', () => {
    const esc = (v: unknown) => String(v);
    const { tqLaneHtml } = load<any>(['tqClock', 'tqDur', 'wqReason', 'tqLaneHtml'], {
      esc,
      TQ_END: { done: '완료', cancelled: '취소', released: '차례 끝남' },
    });
    const html = tqLaneHtml({ id: 'qa-x', title: 'qa-x', capacity: 1, running: [], waiting: [], recent: [] });
    expect(html).toBe(
      '<div class="tq-lane is-idle"><div class="tq-lane-h"><span class="tq-lane-name">qa-x</span><span class="tq-sub">비어 있음 · 아직 내역 없음</span></div></div>',
    );
  });
});

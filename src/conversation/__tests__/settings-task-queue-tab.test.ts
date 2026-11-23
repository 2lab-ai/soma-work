/**
 * The settings page 작업 큐 tab, client half: a knob per person, turned like a volume dial (1 to 10, then ∞), that
 * says what it is to a screen reader, turns by drag, wheel and keys, and saves the step it rests on. Functions are cut
 * out of the shipped script.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderSettingsPage, SETTINGS_CLIENT_JS, SETTINGS_TABS } from '../settings-page';
import { TASK_QUEUE_CLIENT_JS } from '../settings-task-queue-tab';

const ALL_JS = `${TASK_QUEUE_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`;

function clientFn(name: string): string {
  const plain = ALL_JS.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : ALL_JS.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = ALL_JS.indexOf('\n}\n', start);
  return ALL_JS.slice(start + 1, end + 2);
}
const VARS = 'var TQ_MAX = 10; var TQ_SWEEP = 270; var TQ_PX_PER_STEP = 14; var _tq = null; var _tqSaveTimers = {};';
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

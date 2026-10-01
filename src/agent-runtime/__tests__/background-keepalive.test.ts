/**
 * Which background tasks hold a turn open, and for how long (#257).
 *
 * A turn that launched a `run_in_background` agent must keep its input open
 * until the agent reports back, or the CLI exits and the agent dies with it.
 * The liveness signal is the `system`/`background_tasks_changed` level frame
 * (full live set, REPLACE semantics — SDK 0.3.284); only live, non-ambient
 * agents count.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_BG_KEEPALIVE_MAX_MS, liveAgentIds, parseBgKeepaliveMaxMs } from '../background-keepalive';

function level(tasks: unknown): Record<string, unknown> {
  return { type: 'system', subtype: 'background_tasks_changed', tasks, session_id: 'sess-1', uuid: 'u' };
}

const task = (task_id: string, task_type: string, extra: Record<string, unknown> = {}) => ({
  task_id,
  task_type,
  description: task_id,
  ...extra,
});

describe('liveAgentIds (#257)', () => {
  it('returns the ids of the live local_agent tasks', () => {
    expect(liveAgentIds(level([task('a1', 'local_agent'), task('a2', 'local_agent')]))).toEqual(['a1', 'a2']);
  });

  it('returns an empty list for an empty level (every agent settled)', () => {
    expect(liveAgentIds(level([]))).toEqual([]);
  });

  it('ignores shells, workflows, MCP tasks and monitors', () => {
    const ids = liveAgentIds(
      level([
        task('b1', 'local_bash'),
        task('w1', 'local_workflow'),
        task('m1', 'mcp_task'),
        task('mon1', 'monitor'),
        task('a1', 'local_agent'),
      ]),
    );
    expect(ids).toEqual(['a1']);
  });

  it('ignores an ambient agent', () => {
    expect(liveAgentIds(level([task('a1', 'local_agent', { ambient: true })]))).toEqual([]);
    expect(liveAgentIds(level([task('a1', 'local_agent', { ambient: false })]))).toEqual(['a1']);
  });

  it('skips malformed entries rather than counting them', () => {
    const ids = liveAgentIds(
      level([null, 'a0', { task_type: 'local_agent' }, task('', 'local_agent'), task('a1', 'local_agent')]),
    );
    expect(ids).toEqual(['a1']);
  });

  it('answers undefined for a level frame without a tasks array (no information, keep the current set)', () => {
    expect(liveAgentIds(level(undefined))).toBeUndefined();
    expect(liveAgentIds(level('a1'))).toBeUndefined();
  });

  it.each([
    ['system/task_started', { type: 'system', subtype: 'task_started', task_id: 'a1' }],
    ['system/task_notification', { type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' }],
    ['system/init', { type: 'system', subtype: 'init' }],
    ['assistant', { type: 'assistant', message: { content: [] } }],
    ['result', { type: 'result', subtype: 'success', tasks: [task('a1', 'local_agent')] }],
  ])('answers undefined for %s', (_label, frame) => {
    expect(liveAgentIds(frame as Record<string, unknown>)).toBeUndefined();
  });
});

describe('parseBgKeepaliveMaxMs (#257)', () => {
  const ok = (value: number) => ({ value, invalid: false, clamped: false });

  it('defaults to 30 minutes when unset, empty or whitespace', () => {
    expect(DEFAULT_BG_KEEPALIVE_MAX_MS).toBe(1_800_000);
    expect(parseBgKeepaliveMaxMs(undefined)).toEqual(ok(1_800_000));
    expect(parseBgKeepaliveMaxMs('')).toEqual(ok(1_800_000));
    // `Number('   ')` is 0 — whitespace must not read as "disabled".
    expect(parseBgKeepaliveMaxMs('   ')).toEqual(ok(1_800_000));
  });

  it.each([
    '30m',
    'abc',
    'Infinity',
    'NaN',
    '-1',
    '-60000',
  ])('falls back to the default and flags %s as invalid', (raw) => {
    expect(parseBgKeepaliveMaxMs(raw)).toEqual({ value: 1_800_000, invalid: true, clamped: false });
  });

  it('treats 0 as disabled', () => {
    expect(parseBgKeepaliveMaxMs('0')).toEqual(ok(0));
    expect(parseBgKeepaliveMaxMs(' 0 ')).toEqual(ok(0));
  });

  it('honours a positive value in ms, floored to at least 1', () => {
    expect(parseBgKeepaliveMaxMs('60000')).toEqual(ok(60_000));
    expect(parseBgKeepaliveMaxMs(' 120000 ')).toEqual(ok(120_000));
    expect(parseBgKeepaliveMaxMs('1500.9')).toEqual(ok(1500));
    expect(parseBgKeepaliveMaxMs('0.5')).toEqual(ok(1));
  });

  it('clamps a value above the largest setTimeout delay instead of letting the timer overflow', () => {
    expect(parseBgKeepaliveMaxMs('2147483647')).toEqual(ok(2_147_483_647));
    expect(parseBgKeepaliveMaxMs('99999999999')).toEqual({ value: 2_147_483_647, invalid: false, clamped: true });
  });
});

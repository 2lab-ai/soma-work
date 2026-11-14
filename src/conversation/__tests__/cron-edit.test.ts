/**
 * #1080 — the dashboard's cron editor, server half: a job's whole content for
 * the cron drawer (cronJobDetail) and the change its form sends
 * (buildCronEditPatch), by the rules of the Slack edit modal and the cron MCP
 * server's cron_update.
 */

import type { CronJob } from 'somalib/cron/cron-storage';
import { describe, expect, it } from 'vitest';
import { buildCronEditPatch, CRON_PROMPT_MAX, cronJobDetail } from '../cron-edit';

const NOW = Date.parse('2026-11-09T08:30:00Z');

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'nightly-qa',
    expression: '0 9 * * 1-5',
    prompt: 'run the QA pass',
    owner: 'U_OWNER',
    channel: 'C0001',
    threadTs: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastRunAt: null,
    lastRunMinute: null,
    ...over,
  };
}

function patchOf(body: unknown, j: CronJob = job()) {
  const r = buildCronEditPatch(body, j);
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.patch;
}
function refusal(body: unknown, j: CronJob = job()) {
  const r = buildCronEditPatch(body, j);
  if (r.ok) throw new Error(`accepted: ${JSON.stringify(r.patch)}`);
  return r;
}

describe('cronJobDetail — the whole job, prompt included', () => {
  it('every field, with the overrides read as the scheduler reads them', () => {
    const d = cronJobDetail(job(), NOW);
    expect(d).toEqual({
      id: 'job-1',
      name: 'nightly-qa',
      expression: '0 9 * * 1-5',
      prompt: 'run the QA pass',
      owner: 'U_OWNER',
      channel: 'C0001',
      threadTs: null,
      mode: 'default',
      target: 'channel',
      model: { type: 'default' },
      runAllowlist: [],
      createdAt: Date.parse('2026-10-01T00:00:00.000Z'),
      scheduleChangedAt: null,
      lastRunAt: null,
      // Monday 2026-11-09 09:00 UTC is the next weekday 09:00 after 08:30.
      nextRunAt: Date.parse('2026-11-09T09:00:00Z'),
    });
  });

  it('carries the overrides, the anchor, the grants and the times it has', () => {
    const d = cronJobDetail(
      job({
        threadTs: '1700000000.000100',
        mode: 'fastlane',
        target: 'thread',
        modelConfig: { type: 'custom', model: 'claude-sonnet-4-20250514' },
        runAllowlist: ['U_FRIEND'],
        scheduleChangedAt: '2026-11-01T00:00:00.000Z',
        lastRunAt: '2026-11-08T09:00:00.000Z',
      }),
      NOW,
    );
    expect(d).toMatchObject({
      threadTs: '1700000000.000100',
      mode: 'fastlane',
      target: 'thread',
      model: { type: 'custom', model: 'claude-sonnet-4-20250514' },
      runAllowlist: ['U_FRIEND'],
      scheduleChangedAt: Date.parse('2026-11-01T00:00:00.000Z'),
      lastRunAt: Date.parse('2026-11-08T09:00:00.000Z'),
    });
    expect(cronJobDetail(job({ modelConfig: { type: 'opus' } }), NOW).model).toEqual({ type: 'opus' });
  });
});

describe('buildCronEditPatch — what the form may change', () => {
  it('each field as the storage takes it: trimmed, the schedule one space apart, default = no override', () => {
    expect(
      patchOf({
        name: '  morning-qa ',
        expression: ' 0  0 * *   1-5 ',
        prompt: '  keep my spaces  ',
        channel: ' C0002 ',
        mode: 'fastlane',
        model: { type: 'custom', model: ' claude-sonnet-4-20250514 ' },
      }),
    ).toEqual({
      name: 'morning-qa',
      expression: '0 0 * * 1-5',
      prompt: '  keep my spaces  ',
      channel: 'C0002',
      mode: 'fastlane',
      modelConfig: { type: 'custom', model: 'claude-sonnet-4-20250514' },
    });
    expect(patchOf({ mode: 'default' })).toEqual({ mode: null });
    expect(patchOf({ model: { type: 'default' } })).toEqual({ modelConfig: null });
    for (const type of ['opus', 'fable', 'fast'] as const)
      expect(patchOf({ model: { type } })).toEqual({ modelConfig: { type } });
  });

  it('refuses a bad name, schedule, prompt or channel, naming the field', () => {
    expect(refusal({ name: 'has space' }).field).toBe('name');
    expect(refusal({ name: '' }).field).toBe('name');
    expect(refusal({ name: 'x'.repeat(65) }).field).toBe('name');
    expect(refusal({ expression: '0 9 * *' }).field).toBe('expression');
    expect(refusal({ expression: '61 9 * * *' }).field).toBe('expression');
    expect(refusal({ expression: 5 }).field).toBe('expression');
    expect(refusal({ prompt: '' }).field).toBe('prompt');
    expect(refusal({ prompt: '   \n ' }).field).toBe('prompt');
    expect(refusal({ prompt: 'x'.repeat(CRON_PROMPT_MAX + 1) }).field).toBe('prompt');
    expect(patchOf({ prompt: 'x'.repeat(CRON_PROMPT_MAX) }).prompt).toHaveLength(CRON_PROMPT_MAX);
    expect(refusal({ channel: 'general' }).field).toBe('channel');
    expect(refusal({ channel: 'X0001' }).field).toBe('channel');
    expect(refusal({ channel: 'C 0001' }).field).toBe('channel');
    expect(refusal({ mode: 'turbo' }).field).toBe('mode');
    expect(refusal({ target: 'email' }).field).toBe('target');
    expect(refusal({ model: { type: 'gpt' } }).field).toBe('model');
    expect(refusal({ model: { type: 'custom' } }).field).toBe('model');
    expect(refusal({ model: { type: 'custom', model: '  ' } }).field).toBe('model');
    expect(refusal({ model: 'opus' }).field).toBe('model');
    // Every refusal says why, in words.
    expect(refusal({ name: 'has space' }).error).toMatch(/\S/);
  });

  it('refuses what the form never sends: an unknown field, a body that is no object, an empty one', () => {
    expect(refusal({ owner: 'U_OTHER' }).field).toBe('owner');
    expect(refusal({ threadTs: '1700000000.000100' }).field).toBe('threadTs');
    expect(refusal(null).ok).toBe(false);
    expect(refusal(['name']).ok).toBe(false);
    expect(refusal({}).ok).toBe(false);
  });

  it('a channel change drops the thread anchor of the old channel (the Slack modal’s rule)', () => {
    expect(patchOf({ channel: 'C0002' }, job({ threadTs: '1700.1' }))).toEqual({
      channel: 'C0002',
      target: null,
      threadTs: null,
    });
    expect(patchOf({ channel: 'C0002' }, job({ threadTs: '1700.1', target: 'thread' }))).toEqual({
      channel: 'C0002',
      target: null,
      threadTs: null,
    });
    // No anchor, or the same channel: nothing else moves.
    expect(patchOf({ channel: 'C0002' })).toEqual({ channel: 'C0002' });
    expect(patchOf({ channel: 'C0001' }, job({ threadTs: '1700.1' }))).toEqual({ channel: 'C0001' });
    // A target sent with the move wins over the drop.
    expect(patchOf({ channel: 'C0002', target: 'dm' }, job({ threadTs: '1700.1', target: 'thread' }))).toEqual({
      channel: 'C0002',
      target: 'dm',
      threadTs: null,
    });
  });

  it('target as cron_update maps it; a thread reply needs the anchor the job already has', () => {
    expect(patchOf({ target: 'dm' }, job({ threadTs: '1700.1' }))).toEqual({ target: 'dm', threadTs: null });
    expect(patchOf({ target: 'channel' }, job({ target: 'dm' }))).toEqual({ target: null, threadTs: null });
    // A thread reply turned into a run keeps its thread: the thread it posted in is the one whose session runs it.
    expect(patchOf({ target: 'channel' }, job({ target: 'thread', threadTs: '1700.1' }))).toEqual({ target: null });
    expect(patchOf({ target: 'thread' }, job({ threadTs: '1700.1' }))).toEqual({ target: 'thread' });
    // The dashboard cannot pick a Slack thread.
    expect(refusal({ target: 'thread' }).field).toBe('target');
    // Moving the job takes the anchor with it, so a thread reply cannot follow.
    expect(refusal({ channel: 'C0002', target: 'thread' }, job({ threadTs: '1700.1', target: 'thread' })).field).toBe(
      'target',
    );
    // The target it already had keeps the anchor a channel job runs in (its session's thread).
    expect(patchOf({ target: 'channel', name: 'nightly-qa' }, job({ threadTs: '1700.1' }))).toEqual({
      name: 'nightly-qa',
    });
  });
});

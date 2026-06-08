import { describe, expect, it } from 'vitest';
import { AgentTaskLifecycleTracker, contentToText, parseBackgroundLaunchId } from './background-task-tracker';

const SK = 'C1:thread';

describe('parseBackgroundLaunchId (fallback add)', () => {
  it('prefers structured backgroundTaskId/shellId', () => {
    expect(parseBackgroundLaunchId({ backgroundTaskId: 'b1' })).toBe('b1');
    expect(parseBackgroundLaunchId([{ type: 'text', text: 'x', shellId: 'b2' }])).toBe('b2');
  });
  it('falls back to the "with ID:" text form (== SDK task_id)', () => {
    expect(parseBackgroundLaunchId('Command running in background with ID: bb818onz1. Output...')).toBe('bb818onz1');
  });
  it('returns undefined when no id present', () => {
    expect(parseBackgroundLaunchId('done')).toBeUndefined();
  });
});

describe('contentToText', () => {
  it('handles string, text-block arrays, and objects', () => {
    expect(contentToText('hi')).toBe('hi');
    expect(
      contentToText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
    expect(contentToText(null)).toBe('');
  });
});

describe('AgentTaskLifecycleTracker', () => {
  it('starts live on task_started and drains on task_notification (authoritative)', () => {
    const t = new AgentTaskLifecycleTracker();
    t.trackStart(SK, 'bb818onz1', { toolUseId: 'u1', taskType: 'bash' });
    expect(t.liveCount(SK)).toBe(1);
    expect(t.liveTasks(SK)).toEqual([
      { taskId: 'bb818onz1', toolUseId: 'u1', taskType: 'bash', outputFile: undefined },
    ]);

    // progress (not modeled here) keeps it live; settle drains.
    t.trackSettled(SK, 'bb818onz1');
    expect(t.liveCount(SK)).toBe(0);
  });

  it('is idempotent on duplicate starts and merges late metadata', () => {
    const t = new AgentTaskLifecycleTracker();
    // fallback spawn-ack add first (no taskType), then authoritative task_started.
    t.trackStart(SK, 'b1', { toolUseId: 'u1' });
    t.trackStart(SK, 'b1', { taskType: 'bash', outputFile: '/tmp/b1.out' });
    expect(t.liveCount(SK)).toBe(1);
    expect(t.liveTasks(SK)[0]).toEqual({ taskId: 'b1', toolUseId: 'u1', taskType: 'bash', outputFile: '/tmp/b1.out' });
  });

  it('tombstones a settled task so a late/reordered start cannot resurrect it', () => {
    const t = new AgentTaskLifecycleTracker();
    // settle arrives BEFORE start (SDK reorder, or fallback add racing the settle)
    t.trackSettled(SK, 'b1');
    expect(t.liveCount(SK)).toBe(0);
    t.trackStart(SK, 'b1', { taskType: 'bash' });
    expect(t.liveCount(SK)).toBe(0); // stayed dead
  });

  it('duplicate settle is a no-op', () => {
    const t = new AgentTaskLifecycleTracker();
    t.trackStart(SK, 'b1');
    t.trackSettled(SK, 'b1');
    t.trackSettled(SK, 'b1');
    expect(t.liveCount(SK)).toBe(0);
  });

  it('tracks multiple tasks and drains them independently', () => {
    const t = new AgentTaskLifecycleTracker();
    t.trackStart(SK, 'b1');
    t.trackStart(SK, 'b2');
    t.trackStart(SK, 'b3');
    expect(t.liveCount(SK)).toBe(3);
    t.trackSettled(SK, 'b2');
    expect(t.liveCount(SK)).toBe(2);
    expect(t.liveSignature(SK)).toBe('b1,b3');
  });

  it('liveSignature is stable/sorted and empty when nothing is live', () => {
    const t = new AgentTaskLifecycleTracker();
    expect(t.liveSignature(SK)).toBe('');
    t.trackStart(SK, 'z');
    t.trackStart(SK, 'a');
    expect(t.liveSignature(SK)).toBe('a,z');
  });

  it('is session-scoped (one session does not affect another)', () => {
    const t = new AgentTaskLifecycleTracker();
    t.trackStart('s1', 'b1');
    t.trackStart('s2', 'b1');
    t.trackSettled('s1', 'b1');
    expect(t.liveCount('s1')).toBe(0);
    expect(t.liveCount('s2')).toBe(1);
  });

  it('drain clears live AND tombstones for the session (teardown re-arms)', () => {
    const t = new AgentTaskLifecycleTracker();
    t.trackSettled(SK, 'b1'); // tombstone
    t.drain(SK);
    // after teardown, the same id can be live again (fresh session lifecycle)
    t.trackStart(SK, 'b1');
    expect(t.liveCount(SK)).toBe(1);
  });

  it('ignores empty sessionKey/taskId', () => {
    const t = new AgentTaskLifecycleTracker();
    t.trackStart('', 'b1');
    t.trackStart(SK, '');
    expect(t.liveCount(SK)).toBe(0);
  });
});

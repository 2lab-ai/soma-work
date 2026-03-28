/**
 * CronScheduler — Contract tests
 * Trace: docs/cron-scheduler/trace.md, Scenarios 4-6
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CronScheduler, CronSchedulerDeps, SyntheticMessageEvent } from './cron-scheduler';
import { CronStorage, CronJob } from './cron-storage';
import { SessionRegistry } from './session-registry';
import { ConversationSession } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function createTestJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'test-id-1',
    name: 'test-cron',
    expression: '* * * * *', // every minute
    prompt: 'Run the scheduled task',
    owner: 'U123',
    channel: 'C456',
    threadTs: null,
    createdAt: '2026-03-28T00:00:00Z',
    lastRunAt: null,
    lastRunMinute: null,
    ...overrides,
  };
}

function createMockDeps(storage: CronStorage): {
  deps: CronSchedulerDeps;
  injectedMessages: SyntheticMessageEvent[];
  createdThreads: Array<{ channel: string; text: string }>;
} {
  const injectedMessages: SyntheticMessageEvent[] = [];
  const createdThreads: Array<{ channel: string; text: string }> = [];
  const sessionRegistry = new SessionRegistry();

  const deps: CronSchedulerDeps = {
    storage,
    sessionRegistry,
    messageInjector: vi.fn(async (event: SyntheticMessageEvent) => {
      injectedMessages.push(event);
    }),
    threadCreator: vi.fn(async (channel: string, text: string) => {
      createdThreads.push({ channel, text });
      return 'new-thread-ts';
    }),
  };

  return { deps, injectedMessages, createdThreads };
}

// Scenario 4: Idle Session Injection
describe('CronScheduler — Idle Session Injection', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-test-${Date.now()}.json`);
  });

  // Trace: S4, Section 3 — Happy Path
  it('fires cron when session is idle and expression matches', async () => {
    const storage = new CronStorage(tmpFile);
    const job = storage.addJob({
      name: 'idle-test', expression: '* * * * *', prompt: 'Hello from cron',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);

    // Create an idle session
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].text).toContain('[cron:idle-test]');
    expect(injectedMessages[0].text).toContain('Hello from cron');
    expect(injectedMessages[0].channel).toBe('C456');
    expect(injectedMessages[0].thread_ts).toBe('thread-1');
  });

  // Trace: S4, Section 3a — Sad Path
  it('does not fire when expression does not match current time', async () => {
    const storage = new CronStorage(tmpFile);
    // Expression for minute 99 (never matches)
    storage.addJob({
      name: 'no-match', expression: '99 99 * * *', prompt: 'nope',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(0);
  });

  // Trace: S4, Section 3a — Contract (dedup)
  it('does not fire same job twice on same date', async () => {
    const storage = new CronStorage(tmpFile);
    const job = storage.addJob({
      name: 'dedup-test', expression: '* * * * *', prompt: 'once',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);

    // First tick
    await scheduler.tick();
    expect(injectedMessages).toHaveLength(1);

    // Reset activity to idle for second tick
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'working');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    // Second tick — should skip because lastRunMinute matches current minute
    await scheduler.tick();
    expect(injectedMessages).toHaveLength(1); // Still 1, not 2
  });

  // Trace: S4, Section 4 — Side-Effect
  it('updates lastRunMinute after successful injection', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'run-track', expression: '* * * * *', prompt: 'track',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    const updated = storage.getAll()[0];
    expect(updated.lastRunMinute).toBe(new Date().toISOString().slice(0, 16));
    expect(updated.lastRunAt).toBeDefined();
  });

  // Trace: S4, Section 3c — Contract
  it('injects synthetic message with cron prompt as text', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'format-test', expression: '* * * * *', prompt: 'Do the thing',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages[0].text).toBe('[cron:format-test] Do the thing');
    expect(injectedMessages[0].user).toBe('U123');
  });
});

// Scenario 5: Busy Session Queue + Idle Drain
describe('CronScheduler — Busy Queue + Idle Drain', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-test-${Date.now()}.json`);
  });

  // Trace: S5, Section 3a — Happy Path
  it('queues cron when session is busy', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'busy-test', expression: '* * * * *', prompt: 'wait for me',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    // Session is working, not idle
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'working');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // Should NOT inject immediately
    expect(injectedMessages).toHaveLength(0);
    // Should be in pending queue
    expect(scheduler.getPendingQueueSize('C456-thread-1')).toBe(1);
  });

  // Trace: S5, Section 3b-3d — Happy Path
  it('drains queue on idle transition', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'drain-test', expression: '* * * * *', prompt: 'drained!',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'working');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(0);

    // Transition to idle → triggers drain via onIdle callback
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    // Allow async to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].text).toContain('[cron:drain-test]');
  });

  // Trace: S5, Section 3d — Contract (one per idle)
  it('drains one job per idle transition', async () => {
    const storage = new CronStorage(tmpFile);
    // Create two jobs with different names
    storage.addJob({
      name: 'job-a', expression: '* * * * *', prompt: 'first',
      owner: 'U123', channel: 'C456', threadTs: null,
    });
    storage.addJob({
      name: 'job-b', expression: '* * * * *', prompt: 'second',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'working');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // Both jobs queued
    expect(scheduler.getPendingQueueSize('C456-thread-1')).toBe(2);

    // First idle → drains one job
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(injectedMessages).toHaveLength(1);

    // Set back to working then idle again → drains second job
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'working');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(injectedMessages).toHaveLength(2);
  });

  // Trace: S5, Section 5 — Side-Effect (orphan cleanup)
  it('orphaned queue cleaned on session removal', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'orphan-test', expression: '* * * * *', prompt: 'orphaned',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'working');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();
    expect(scheduler.getPendingQueueSize('C456-thread-1')).toBe(1);

    // Simulate session cleanup
    scheduler.clearPendingQueue('C456-thread-1');
    expect(scheduler.getPendingQueueSize('C456-thread-1')).toBe(0);
  });
});

// Scenario 5 — SessionRegistry onIdle hook
describe('SessionRegistry — onIdle callbacks', () => {
  // Trace: S5, Section 3b — Contract
  it('registerOnIdle callback fires on setActivityState idle', () => {
    const registry = new SessionRegistry();
    registry.createSession('U1', 'Test', 'C1', 't1');
    registry.transitionToMain('C1', 't1', 'default');
    registry.setActivityState('C1', 't1', 'working');

    const fired: string[] = [];
    registry.registerOnIdle('C1-t1', () => fired.push('cb1'));
    registry.registerOnIdle('C1-t1', () => fired.push('cb2'));

    // Transition to idle → callbacks fire
    registry.setActivityState('C1', 't1', 'idle');

    expect(fired).toEqual(['cb1', 'cb2']);
  });

  it('callbacks cleared after drain', () => {
    const registry = new SessionRegistry();
    registry.createSession('U1', 'Test', 'C1', 't1');
    registry.transitionToMain('C1', 't1', 'default');
    registry.setActivityState('C1', 't1', 'working');

    const fired: string[] = [];
    registry.registerOnIdle('C1-t1', () => fired.push('once'));

    registry.setActivityState('C1', 't1', 'idle');
    expect(fired).toEqual(['once']);

    // Second idle → should NOT fire again
    fired.length = 0;
    registry.setActivityState('C1', 't1', 'working');
    registry.setActivityState('C1', 't1', 'idle');
    expect(fired).toEqual([]);
  });

  it('callback error does not break others', () => {
    const registry = new SessionRegistry();
    registry.createSession('U1', 'Test', 'C1', 't1');
    registry.transitionToMain('C1', 't1', 'default');
    registry.setActivityState('C1', 't1', 'working');

    const fired: string[] = [];
    registry.registerOnIdle('C1-t1', () => { throw new Error('boom'); });
    registry.registerOnIdle('C1-t1', () => fired.push('survived'));

    registry.setActivityState('C1', 't1', 'idle');
    expect(fired).toEqual(['survived']);
  });
});

// Scenario 6: No Session → New Thread
describe('CronScheduler — No Session New Thread', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-test-${Date.now()}.json`);
  });

  // Trace: S6, Section 3 — Happy Path
  it('creates new thread when no session exists', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'new-thread', expression: '* * * * *', prompt: 'Start fresh',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages, createdThreads } = createMockDeps(storage);
    // No session created — empty registry

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(createdThreads).toHaveLength(1);
    expect(createdThreads[0].channel).toBe('C456');
    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].thread_ts).toBe('new-thread-ts');
    expect(injectedMessages[0].text).toContain('[cron:new-thread]');
  });

  // Trace: S6, Section 5 — Sad Path
  it('skips gracefully on Slack API failure', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'fail-thread', expression: '* * * * *', prompt: 'should fail',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    // Override threadCreator to fail
    deps.threadCreator = vi.fn(async () => { throw new Error('Slack API error'); });

    const scheduler = new CronScheduler(deps);
    await scheduler.tick(); // should not throw

    expect(injectedMessages).toHaveLength(0);
  });

  // Trace: S6, Section 3c — Contract
  it('new thread receives cron prompt as first message', async () => {
    const isolatedFile = path.join(os.tmpdir(), `cron-sched-isolated-${Date.now()}.json`);
    const storage = new CronStorage(isolatedFile);
    storage.addJob({
      name: 'prompt-check', expression: '* * * * *', prompt: 'Scheduled report',
      owner: 'U999', channel: 'CABC', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages[0].text).toBe('[cron:prompt-check] Scheduled report');
    expect(injectedMessages[0].user).toBe('U999');
    expect(injectedMessages[0].channel).toBe('CABC');
  });
});

// --- Hardening tests (Codex review findings) ---

describe('CronScheduler — Hardening', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-hardening-${Date.now()}.json`);
  });

  it('threadTs-specific cron targets exact session among multiple', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'thread-specific', expression: '* * * * *', prompt: 'For thread-2 only',
      owner: 'U123', channel: 'C456', threadTs: 'thread-2',
    });

    const { deps, injectedMessages } = createMockDeps(storage);

    // Two sessions in same channel for same user
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-2');
    deps.sessionRegistry.transitionToMain('C456', 'thread-2', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-2', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].thread_ts).toBe('thread-2');
  });

  it('messageInjector throw still marks lastRunMinute (no retry storm)', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'throw-test', expression: '* * * * *', prompt: 'boom',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps } = createMockDeps(storage);
    deps.messageInjector = vi.fn(async () => { throw new Error('injector failed'); });

    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick(); // should not throw

    const updated = storage.getAll()[0];
    expect(updated.lastRunMinute).toBe(new Date().toISOString().slice(0, 16));
  });

  it('overlapping ticks are skipped via isRunning guard', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'overlap-test', expression: '* * * * *', prompt: 'slow',
      owner: 'U123', channel: 'C456', threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);

    // Make messageInjector slow
    let resolveInjector: () => void;
    deps.messageInjector = vi.fn(() => new Promise<void>(resolve => { resolveInjector = resolve; }));

    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    const tick1 = scheduler.tick(); // starts, blocks on messageInjector
    await new Promise(resolve => setTimeout(resolve, 5));

    await scheduler.tick(); // should be skipped (isRunning)

    resolveInjector!(); // unblock first tick
    await tick1;

    expect(deps.messageInjector).toHaveBeenCalledTimes(1); // Only once, second tick was skipped
  });
});

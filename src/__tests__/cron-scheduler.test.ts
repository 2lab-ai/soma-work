/**
 * CronScheduler — Contract tests
 * Trace: docs/cron-scheduler/trace.md, Scenarios 4-6
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type CronJob, CronStorage } from 'somalib/cron/cron-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CronScheduler,
  type CronSchedulerDeps,
  resolveModelOverride,
  type SyntheticMessageEvent,
} from '../cron-scheduler';
import { SessionRegistry } from '../session-registry';
import { ConversationSession } from '../types';

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
      name: 'idle-test',
      expression: '* * * * *',
      prompt: 'Hello from cron',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
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
      name: 'no-match',
      expression: '99 99 * * *',
      prompt: 'nope',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
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
      name: 'dedup-test',
      expression: '* * * * *',
      prompt: 'once',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
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
      name: 'run-track',
      expression: '* * * * *',
      prompt: 'track',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
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
      name: 'format-test',
      expression: '* * * * *',
      prompt: 'Do the thing',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages[0].text).toBe('[cron:format-test] Do the thing');
    expect(injectedMessages[0].user).toBe('U123');
    expect(injectedMessages[0].synthetic).toBe(true);
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
      name: 'busy-test',
      expression: '* * * * *',
      prompt: 'wait for me',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
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
      name: 'drain-test',
      expression: '* * * * *',
      prompt: 'drained!',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
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
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].text).toContain('[cron:drain-test]');
    expect(injectedMessages[0].synthetic).toBe(true);
  });

  // Trace: S5, Section 3d — Contract (one per idle)
  it('drains one job per idle transition', async () => {
    const storage = new CronStorage(tmpFile);
    // Create two jobs with different names
    storage.addJob({
      name: 'job-a',
      expression: '* * * * *',
      prompt: 'first',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });
    storage.addJob({
      name: 'job-b',
      expression: '* * * * *',
      prompt: 'second',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(injectedMessages).toHaveLength(1);

    // Set back to working then idle again → drains second job
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'working');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(injectedMessages).toHaveLength(2);
  });

  // Trace: S5, Section 5 — Side-Effect (orphan cleanup)
  it('orphaned queue cleaned on session removal', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'orphan-test',
      expression: '* * * * *',
      prompt: 'orphaned',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
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
    registry.registerOnIdle('C1-t1', () => {
      throw new Error('boom');
    });
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
      name: 'new-thread',
      expression: '* * * * *',
      prompt: 'Start fresh',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
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
    expect(injectedMessages[0].synthetic).toBe(true);
  });

  // Trace: S6, Section 5 — Sad Path
  it('skips gracefully on Slack API failure', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'fail-thread',
      expression: '* * * * *',
      prompt: 'should fail',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    // Override threadCreator to fail
    deps.threadCreator = vi.fn(async () => {
      throw new Error('Slack API error');
    });

    const scheduler = new CronScheduler(deps);
    await scheduler.tick(); // should not throw

    expect(injectedMessages).toHaveLength(0);
  });

  // Trace: S6, Section 3c — Contract
  it('new thread receives cron prompt as first message', async () => {
    const isolatedFile = path.join(os.tmpdir(), `cron-sched-isolated-${Date.now()}.json`);
    const storage = new CronStorage(isolatedFile);
    storage.addJob({
      name: 'prompt-check',
      expression: '* * * * *',
      prompt: 'Scheduled report',
      owner: 'U999',
      channel: 'CABC',
      threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages[0].text).toBe('[cron:prompt-check] Scheduled report');
    expect(injectedMessages[0].user).toBe('U999');
    expect(injectedMessages[0].channel).toBe('CABC');
  });
});

// --- B2 test: start() should tick immediately ---
describe('CronScheduler — Immediate tick on start', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-b2-${Date.now()}.json`);
  });

  it('B2: start() invokes tick() synchronously before returning', () => {
    const storage = new CronStorage(tmpFile);
    const { deps } = createMockDeps(storage);

    const scheduler = new CronScheduler(deps);
    // Spy on tick to verify it's called during start()
    const tickSpy = vi.spyOn(scheduler, 'tick').mockResolvedValue(undefined);

    scheduler.start();

    // tick() should have been called exactly once — synchronously during start()
    expect(tickSpy).toHaveBeenCalledTimes(1);

    scheduler.stop();
    tickSpy.mockRestore();
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
      name: 'thread-specific',
      expression: '* * * * *',
      prompt: 'For thread-2 only',
      owner: 'U123',
      channel: 'C456',
      threadTs: 'thread-2',
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
      name: 'throw-test',
      expression: '* * * * *',
      prompt: 'boom',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });

    const { deps } = createMockDeps(storage);
    deps.messageInjector = vi.fn(async () => {
      throw new Error('injector failed');
    });

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
      name: 'overlap-test',
      expression: '* * * * *',
      prompt: 'slow',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);

    // Make messageInjector slow
    let resolveInjector: () => void;
    deps.messageInjector = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInjector = resolve;
        }),
    );

    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    const tick1 = scheduler.tick(); // starts, blocks on messageInjector
    await new Promise((resolve) => setTimeout(resolve, 5));

    await scheduler.tick(); // should be skipped (isRunning)

    resolveInjector!(); // unblock first tick
    await tick1;

    expect(deps.messageInjector).toHaveBeenCalledTimes(1); // Only once, second tick was skipped
  });
});

// --- Fastlane mode + Model selection ---
describe('CronScheduler — Fastlane Mode', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-fastlane-${Date.now()}.json`);
  });

  it('fastlane mode always creates new thread even when idle session exists', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'fastlane-test',
      expression: '* * * * *',
      prompt: 'Execute immediately',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      mode: 'fastlane',
    });

    const { deps, createdThreads, injectedMessages } = createMockDeps(storage);

    // Idle session exists — default mode would inject into it
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'existing-thread');
    deps.sessionRegistry.transitionToMain('C456', 'existing-thread', 'default');
    deps.sessionRegistry.setActivityState('C456', 'existing-thread', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // Should create new thread, NOT inject into existing session
    expect(createdThreads).toHaveLength(1);
    expect(createdThreads[0].channel).toBe('C456');
    // Should still inject the message into the new thread
    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].thread_ts).toBe('new-thread-ts');
  });

  it('fastlane mode creates new thread even when session is busy', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'fastlane-busy',
      expression: '* * * * *',
      prompt: 'Do not queue',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      mode: 'fastlane',
    });

    const { deps, createdThreads } = createMockDeps(storage);

    // Busy session — default mode would enqueue
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'busy-thread');
    deps.sessionRegistry.transitionToMain('C456', 'busy-thread', 'default');
    deps.sessionRegistry.setActivityState('C456', 'busy-thread', 'working');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // Fastlane should NOT queue — should create new thread directly
    expect(createdThreads).toHaveLength(1);
    expect(scheduler.getPendingQueueSize('C456-busy-thread')).toBe(0);
  });

  it('default mode (no mode field) behaves as before — injects into idle session', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'default-mode',
      expression: '* * * * *',
      prompt: 'Normal behavior',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      // No mode field — backward compatible
    });

    const { deps, injectedMessages, createdThreads } = createMockDeps(storage);

    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'idle-thread');
    deps.sessionRegistry.transitionToMain('C456', 'idle-thread', 'default');
    deps.sessionRegistry.setActivityState('C456', 'idle-thread', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // Should inject into existing session, NOT create new thread
    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].thread_ts).toBe('idle-thread');
    expect(createdThreads).toHaveLength(0);
  });
});

describe('CronScheduler — Model Override', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-model-${Date.now()}.json`);
  });

  it('fast model type sets modelOverride to sonnet', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'fast-model',
      expression: '* * * * *',
      prompt: 'Quick task',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      modelConfig: { type: 'fast' },
    });

    const { deps, injectedMessages } = createMockDeps(storage);

    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].modelOverride).toBe('claude-sonnet-4-20250514');
  });

  it('custom model type sets modelOverride to specified model', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'custom-model',
      expression: '* * * * *',
      prompt: 'Custom task',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      modelConfig: { type: 'custom', model: 'claude-opus-4-6-20250414' },
    });

    const { deps, injectedMessages } = createMockDeps(storage);

    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].modelOverride).toBe('claude-opus-4-6-20250414');
  });

  it('default model type has no modelOverride', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'default-model',
      expression: '* * * * *',
      prompt: 'Default task',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      // No modelConfig — default
    });

    const { deps, injectedMessages } = createMockDeps(storage);

    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].modelOverride).toBeUndefined();
  });

  it('model override passes through to new_thread path', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'new-thread-model',
      expression: '* * * * *',
      prompt: 'New thread with fast model',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      mode: 'fastlane',
      modelConfig: { type: 'fast' },
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    // No sessions — will create new thread

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].modelOverride).toBe('claude-sonnet-4-20250514');
  });
});

// --- Duplicate Root Regression ---
describe('CronScheduler — Duplicate Root Regression', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-duproot-${Date.now()}.json`);
  });

  it('synthetic events carry routeContext.skipAutoBotThread to prevent duplicate root', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'duproot-test',
      expression: '* * * * *',
      prompt: 'Should not create duplicate root',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].routeContext?.skipAutoBotThread).toBe(true);
  });

  it('new-thread path synthetic event also has skipAutoBotThread', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'newthread-skip',
      expression: '* * * * *',
      prompt: 'New thread should not double-post',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    // No session → new thread path

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].routeContext?.skipAutoBotThread).toBe(true);
  });

  it('drain-queue path synthetic event also has skipAutoBotThread', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'drain-skip',
      expression: '* * * * *',
      prompt: 'Queued then drained',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
    });

    const { deps, injectedMessages } = createMockDeps(storage);
    deps.sessionRegistry.createSession('U123', 'TestUser', 'C456', 'thread-1');
    deps.sessionRegistry.transitionToMain('C456', 'thread-1', 'default');
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'working');

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // Drain on idle
    deps.sessionRegistry.setActivityState('C456', 'thread-1', 'idle');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0].routeContext?.skipAutoBotThread).toBe(true);
  });
});

// --- DM Target ---
describe('CronScheduler — DM Target', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-dm-${Date.now()}.json`);
  });

  it('dm target sends DM to job owner', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'dm-test',
      expression: '* * * * *',
      prompt: 'DM content',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      target: 'dm',
    });

    const sentDms: Array<{ userId: string; text: string }> = [];
    const { deps, injectedMessages, createdThreads } = createMockDeps(storage);
    deps.dmSender = vi.fn(async (userId: string, text: string) => {
      sentDms.push({ userId, text });
    });

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // DM sent, no thread created, no injection
    expect(sentDms).toHaveLength(1);
    expect(sentDms[0].userId).toBe('U123');
    expect(sentDms[0].text).toContain('[cron:dm-test]');
    expect(createdThreads).toHaveLength(0);
    expect(injectedMessages).toHaveLength(0);
  });

  it('dm target falls back to new thread if dmSender not configured', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'dm-fallback',
      expression: '* * * * *',
      prompt: 'DM fallback',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      target: 'dm',
    });

    const { deps, createdThreads, injectedMessages } = createMockDeps(storage);
    // No dmSender configured

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // Falls back to new thread
    expect(createdThreads).toHaveLength(1);
    expect(injectedMessages).toHaveLength(1);
  });
});

// --- Thread Target ---
describe('CronScheduler — Thread Target', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-thread-${Date.now()}.json`);
  });

  it('thread target posts reply in existing thread', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'thread-reply-test',
      expression: '* * * * *',
      prompt: 'Thread reply content',
      owner: 'U123',
      channel: 'C456',
      threadTs: 'existing-thread-ts',
      target: 'thread',
    });

    const sentReplies: Array<{ channel: string; threadTs: string; text: string }> = [];
    const { deps, injectedMessages, createdThreads } = createMockDeps(storage);
    deps.threadReplier = vi.fn(async (channel: string, threadTs: string, text: string) => {
      sentReplies.push({ channel, threadTs, text });
    });

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(sentReplies).toHaveLength(1);
    expect(sentReplies[0].channel).toBe('C456');
    expect(sentReplies[0].threadTs).toBe('existing-thread-ts');
    expect(sentReplies[0].text).toContain('[cron:thread-reply-test]');
    expect(createdThreads).toHaveLength(0);
    expect(injectedMessages).toHaveLength(0);
  });

  it('thread target without threadTs fails with error (no fallback)', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'thread-no-ts',
      expression: '* * * * *',
      prompt: 'Missing threadTs',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      target: 'thread',
    });

    const sentReplies: Array<{ channel: string; threadTs: string; text: string }> = [];
    const { deps, injectedMessages, createdThreads } = createMockDeps(storage);
    deps.threadReplier = vi.fn(async (channel: string, threadTs: string, text: string) => {
      sentReplies.push({ channel, threadTs, text });
    });

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // Should NOT fallback to new thread — should record failure
    expect(sentReplies).toHaveLength(0);
    expect(createdThreads).toHaveLength(0);
    expect(injectedMessages).toHaveLength(0);

    // Verify lastRunMinute updated to prevent retry storm
    const updated = storage.getAll()[0];
    expect(updated.lastRunMinute).toBe(new Date().toISOString().slice(0, 16));
  });

  it('thread target falls back to new thread if threadReplier not configured', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'thread-no-replier',
      expression: '* * * * *',
      prompt: 'No replier configured',
      owner: 'U123',
      channel: 'C456',
      threadTs: 'some-thread',
      target: 'thread',
    });

    const { deps, createdThreads, injectedMessages } = createMockDeps(storage);
    // No threadReplier configured

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    // Falls back to new thread
    expect(createdThreads).toHaveLength(1);
    expect(injectedMessages).toHaveLength(1);
  });
});

// --- Error Path Tests ---
describe('CronScheduler — Error Paths', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-sched-errors-${Date.now()}.json`);
  });

  it('dm sender error is caught gracefully', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'dm-error',
      expression: '* * * * *',
      prompt: 'DM will fail',
      owner: 'U123',
      channel: 'C456',
      threadTs: null,
      target: 'dm',
    });

    const { deps } = createMockDeps(storage);
    deps.dmSender = vi.fn(async () => {
      throw new Error('DM channel not found');
    });

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(deps.dmSender).toHaveBeenCalledOnce();
  });

  it('thread replier error is caught gracefully', async () => {
    const storage = new CronStorage(tmpFile);
    storage.addJob({
      name: 'thread-error',
      expression: '* * * * *',
      prompt: 'Thread will fail',
      owner: 'U123',
      channel: 'C456',
      threadTs: 'existing-ts',
      target: 'thread',
    });

    const { deps } = createMockDeps(storage);
    deps.threadReplier = vi.fn(async () => {
      throw new Error('channel_not_found');
    });

    const scheduler = new CronScheduler(deps);
    await scheduler.tick();

    expect(deps.threadReplier).toHaveBeenCalledOnce();
  });
});

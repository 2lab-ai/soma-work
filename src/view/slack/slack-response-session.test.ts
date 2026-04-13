/**
 * SlackResponseSession tests (Issue #409)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlackConversationRef } from './slack-refs.js';
import { type SlackResponseDeps, SlackResponseSession } from './slack-response-session.js';

// ─── Helpers ─────────────────────────────────────────────────────

function createMockDeps(): SlackResponseDeps {
  return {
    slackApi: {
      postMessage: vi.fn().mockResolvedValue({ ts: '1700000000.000100', channel: 'C123' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    },
    addReaction: vi.fn().mockResolvedValue(true),
    removeReaction: vi.fn().mockResolvedValue(undefined),
  };
}

const CONV_REF: SlackConversationRef = { channel: 'C123', threadTs: '1700000000.000000' };

// ─── Tests ───────────────────────────────────────────────────────

describe('SlackResponseSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts initial message on first flush', async () => {
    const deps = createMockDeps();
    const session = new SlackResponseSession(CONV_REF, deps);

    session.appendText('Hello');
    await vi.advanceTimersByTimeAsync(500); // Trigger debounce

    expect(deps.slackApi.postMessage).toHaveBeenCalledWith('C123', 'Hello', {
      threadTs: '1700000000.000000',
    });
  });

  it('updates existing message on subsequent flushes', async () => {
    const deps = createMockDeps();
    const session = new SlackResponseSession(CONV_REF, deps);

    session.appendText('First');
    await vi.advanceTimersByTimeAsync(500);

    session.appendText(' Second');
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.slackApi.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.updateMessage).toHaveBeenCalledWith('C123', '1700000000.000100', 'First Second');
  });

  it('complete() flushes final state and returns handle', async () => {
    const deps = createMockDeps();
    const session = new SlackResponseSession(CONV_REF, deps);

    session.appendText('Done');
    const handle = await session.complete();

    expect(handle.platform).toBe('slack');
    expect(deps.slackApi.postMessage).toHaveBeenCalled();
  });

  it('complete() throws if called twice', async () => {
    const deps = createMockDeps();
    const session = new SlackResponseSession(CONV_REF, deps);

    session.appendText('x');
    await session.complete();

    await expect(session.complete()).rejects.toThrow('already finalized');
  });

  it('abort() prevents further updates', async () => {
    const deps = createMockDeps();
    const session = new SlackResponseSession(CONV_REF, deps);

    session.appendText('Start');
    session.abort('cancelled');

    // Should not trigger any API calls after abort
    session.appendText('More');
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.slackApi.postMessage).not.toHaveBeenCalled();
    expect(deps.slackApi.updateMessage).not.toHaveBeenCalled();
  });

  it('appendText is ignored after complete', async () => {
    const deps = createMockDeps();
    const session = new SlackResponseSession(CONV_REF, deps);

    session.appendText('Final');
    await session.complete();

    session.appendText('Should be ignored');
    await vi.advanceTimersByTimeAsync(500);

    // Only 1 postMessage call (from complete), no updates after
    expect(deps.slackApi.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.updateMessage).not.toHaveBeenCalled();
  });

  it('replacePart appends to output', async () => {
    const deps = createMockDeps();
    const session = new SlackResponseSession(CONV_REF, deps);

    session.appendText('Main text');
    session.replacePart('tool-output', { type: 'text', text: 'Tool result here' });
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.slackApi.postMessage).toHaveBeenCalledWith('C123', 'Main text\nTool result here', expect.any(Object));
  });

  it('replacePart replaces existing part', async () => {
    const deps = createMockDeps();
    const session = new SlackResponseSession(CONV_REF, deps);

    session.appendText('Main');
    session.replacePart('status', { type: 'status', phase: 'Running' });
    session.replacePart('status', { type: 'status', phase: 'Done' });

    const _handle = await session.complete();

    // The 'Running' status should be replaced by 'Done'
    const lastCall = (deps.slackApi.postMessage as any).mock.calls[0];
    expect(lastCall[1]).toContain('Done');
    expect(lastCall[1]).not.toContain('Running');
  });

  it('debounces rapid updates', async () => {
    const deps = createMockDeps();
    const session = new SlackResponseSession(CONV_REF, deps);

    // Rapid fire
    session.appendText('A');
    session.appendText('B');
    session.appendText('C');

    // Only one flush should be scheduled
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.slackApi.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.postMessage).toHaveBeenCalledWith('C123', 'ABC', expect.any(Object));
  });
});

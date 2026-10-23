import { describe, expect, it } from 'vitest';
import type { FollowupItem, FollowupQueueSnapshot } from '../followup-queue';
import { parseFollowupQueueSnapshot } from '../followup-queue-store';
import type { MessageEvent } from '../pipeline/types';

/**
 * Dashboard "New task" (SSOT 2026-10-23 T4/T6): a dashboard task's message
 * carries `effortOverride` / `autoGoalOverride`. If that message is parked in
 * the follow-up queue (another turn held the slot) and replayed after a
 * restart, the per-task choices must come back with it — the store validates
 * the stored message but never rebuilds it.
 */

const SESSION = 'C1:1700.000000';

function item(message: MessageEvent): FollowupItem {
  return {
    id: `${SESSION}#1`,
    sessionKey: SESSION,
    seq: 1,
    epoch: 0,
    state: 'queued',
    eventKey: `${message.channel}:${message.ts}`,
    message,
    context: { workingDirectory: '/repo' },
    enqueuedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function snapshot(items: FollowupItem[]): FollowupQueueSnapshot {
  return { version: 1, sessions: [{ sessionKey: SESSION, nextSeq: 2, turnEpoch: 0, items }] };
}

describe('follow-up queue keeps a dashboard task’s per-task choices', () => {
  it('effortOverride / autoGoalOverride / modelOverride survive a persisted round-trip verbatim', () => {
    const message = {
      user: 'U1',
      channel: 'C1',
      thread_ts: '1700.000000',
      ts: '1700.000000',
      text: '대시보드 개선해줘\n\n$autoz',
      modelOverride: 'claude-opus-5-5[1m]',
      effortOverride: 'high',
      autoGoalOverride: false,
      routeContext: { skipAutoBotThread: true },
    } as MessageEvent;
    const parsed = parseFollowupQueueSnapshot(JSON.parse(JSON.stringify(snapshot([item(message)]))));
    expect(parsed.sessions[0].items[0].message).toEqual(message);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { FollowupItem } from '../followup-queue';
import { FOLLOWUP_QUEUE_TITLE, type FollowupQueueView } from '../followup-queue-blocks';
import type { MessageEvent } from '../pipeline/types';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * Panel height, surface level — everything ABOVE the `Queue` section fits in
 * four blocks (2026-09-17: "좀더 컴팩트하게 보여줘").
 *
 * Budget: header · identity context · link history · status+timers. The queue
 * and the controls are what the user acts on, so the chrome above them is the
 * part that has to shrink; this test is the ceiling, not a snapshot — it fails
 * when a new line is added above the queue, which is exactly when someone
 * should have to justify it.
 */

const KEY = 'C1:1700.000000';

function event(over: Partial<MessageEvent> = {}): MessageEvent {
  return { user: 'U2', channel: 'C1', ts: '1700.000100', text: 'hello', ...over };
}

function item(seq = 1): FollowupItem {
  return {
    id: `${KEY}#${seq}`,
    sessionKey: KEY,
    seq,
    epoch: 3,
    state: 'queued',
    eventKey: `C1:1700.0001${seq}`,
    message: event({ ts: `1700.0001${seq}`, text: `message ${seq}` }),
    context: { workingDirectory: '/w' },
    enqueuedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function makeSession(): ConversationSession {
  return {
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: '1700.000000',
    threadRootTs: '1700.000000',
    threadModel: 'user-initiated',
    ownerId: 'U1',
    ownerName: 'zhuge',
    title: 'compact demo',
    workflow: 'default',
    model: 'claude-opus-4-6-20250414',
    usage: { contextWindow: 200_000, inputTokens: 10_000, outputTokens: 1_000 },
    links: { pr: { url: 'https://github.com/o/r/pull/1', label: 'PR #1', provider: 'github' } },
    linkHistory: { prs: [{ url: 'https://github.com/o/r/pull/1', label: 'PR #1', provider: 'github' }] },
    isActive: true,
    terminated: false,
    logVerbosity: 0,
    activityState: 'working',
    actionPanel: {
      channelId: 'C1',
      messageTs: 'panel-ts',
      agentPhase: '결과 반영 중',
      lastProgressAt: 1_700_000_000_000,
      turnSummary: '⏱ 4:02 · 🛠 17',
    },
  } as ConversationSession;
}

function textOf(block: any): string {
  return JSON.stringify(block ?? {});
}

describe('ThreadSurface — the chrome above the Queue stays inside four blocks', () => {
  it('renders at most four blocks before the Queue section', async () => {
    const session = makeSession();
    const updates: Array<{ blocks: any[] }> = [];
    const slackApi = {
      getClient: vi.fn().mockReturnValue({}),
      getPermalink: vi.fn().mockResolvedValue('https://slack.example/p'),
      updateMessage: vi.fn(async (_channel: string, _ts: string, _text: string, blocks: any[]) => {
        updates.push({ blocks });
      }),
      postMessage: vi.fn(async () => ({ ts: 'posted-ts' })),
    };
    const view: FollowupQueueView = { sessionKey: KEY, items: [item(1), item(2)], turnEpoch: 3 };
    const deps: ThreadSurfaceDeps = {
      slackApi: slackApi as any,
      claudeHandler: { getSessionByKey: vi.fn().mockReturnValue(session) } as any,
      requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(true) } as any,
      todoManager: { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() } as any,
      getFollowupView: () => view,
    };

    await new ThreadSurface(deps).updatePanel(session, KEY);

    const blocks = updates.at(-1)?.blocks ?? [];
    const queueIndex = blocks.findIndex((block) => textOf(block).includes(FOLLOWUP_QUEUE_TITLE));
    expect(queueIndex).toBeGreaterThan(0);
    expect(queueIndex).toBeLessThanOrEqual(4);

    // …and the status area is still ONE of those blocks, carrying both lines.
    const status = blocks.find((block) => /🟢|🟡|⚪/.test(textOf(block)) && block.type === 'section');
    expect(String(status?.text?.text ?? status?.fields?.[0]?.text).split('\n')).toHaveLength(2);
  });
});

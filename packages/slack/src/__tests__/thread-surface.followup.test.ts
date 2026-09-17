import { describe, expect, it, vi } from 'vitest';
import type { FollowupItem } from '../followup-queue';
import {
  FOLLOWUP_CANCEL_ACTION_ID,
  FOLLOWUP_ITEM_MENU_ACTION_ID,
  FOLLOWUP_PAGE_NEXT_ACTION_ID,
  FOLLOWUP_PAGE_PREV_ACTION_ID,
  FOLLOWUP_QUEUE_TITLE,
  FOLLOWUP_SEND_NOW_ACTION_ID,
  FOLLOWUP_SEND_NOW_LABEL,
  FOLLOWUP_STEERED_COUNT_LABEL,
  type FollowupItemMenuValue,
  type FollowupQueueView,
  parseFollowupMenuValue,
} from '../followup-queue-blocks';
import type { MessageEvent } from '../pipeline/types';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * U9 — the surface-level guards the follow-up queue depends on: turn-epoch gated
 * writes (A12/A28) and the duplicate surface-message bug on a transient
 * `chat.update` failure — plus the A39 contract that the queue itself is NOT on
 * this surface any more (it is one message per item, in the thread).
 *
 * These tests drive the real `ThreadSurface` against a fake Slack API that
 * records the exact `chat.update` / `chat.postMessage` payloads, so every
 * assertion is about the bytes a user would actually receive.
 */

const KEY = 'C1:1700.000000';
const MAX_BLOCKS = 50;

function event(over: Partial<MessageEvent> = {}): MessageEvent {
  return { user: 'U2', channel: 'C1', ts: '1700.000100', text: 'hello', ...over };
}

function item(over: Partial<FollowupItem> = {}): FollowupItem {
  const seq = over.seq ?? 1;
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
    ...over,
  };
}

function makeSession(over: Partial<ConversationSession> = {}): ConversationSession {
  return {
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: '1700.000000',
    threadRootTs: '1700.000000',
    threadModel: 'user-initiated',
    ownerId: 'U1',
    ownerName: 'zhuge',
    title: 'queue demo',
    isActive: true,
    terminated: false,
    actionPanel: { channelId: 'C1', messageTs: 'panel-ts' },
    ...over,
  } as ConversationSession;
}

interface Captured {
  channel: string;
  ts?: string;
  text: string;
  blocks: any[];
}

function makeSlackApi(overrides: { updateMessage?: any } = {}) {
  const updates: Captured[] = [];
  const posts: Captured[] = [];
  const api = {
    updates,
    posts,
    getClient: vi.fn().mockReturnValue({}),
    getPermalink: vi.fn().mockResolvedValue('https://slack.example/p'),
    updateMessage:
      overrides.updateMessage ??
      vi.fn(async (channel: string, ts: string, text: string, blocks: any[]) => {
        updates.push({ channel, ts, text, blocks });
      }),
    postMessage: vi.fn(async (channel: string, text: string, options: any) => {
      posts.push({ channel, text, blocks: options?.blocks ?? [] });
      return { ts: 'posted-ts' };
    }),
  };
  return api;
}

function makeDeps(
  session: ConversationSession,
  slackApi: ReturnType<typeof makeSlackApi>,
  followup: Partial<Pick<ThreadSurfaceDeps, 'getFollowupView' | 'getFollowupError'>> = {},
): ThreadSurfaceDeps & { slackApi: ReturnType<typeof makeSlackApi> } {
  return {
    slackApi: slackApi as any,
    claudeHandler: { getSessionByKey: vi.fn().mockReturnValue(session) } as any,
    requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
    todoManager: { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() } as any,
    ...followup,
  };
}

function view(over: Partial<FollowupQueueView> = {}): FollowupQueueView {
  return { sessionKey: KEY, items: [item()], ...over };
}

/** Every `{type, text}` object anywhere in the payload. */
function textObjects(node: unknown, out: Array<{ type: string; text: string }> = []) {
  if (Array.isArray(node)) {
    for (const child of node) textObjects(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (typeof record.type === 'string' && typeof record.text === 'string') {
      out.push({ type: record.type, text: record.text });
    }
    for (const value of Object.values(record)) textObjects(value, out);
  }
  return out;
}

function buttons(blocks: unknown[]): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (record.type === 'button') found.push(record);
      for (const value of Object.values(record)) walk(value);
    }
  };
  walk(blocks);
  return found;
}

function actionIds(blocks: unknown[]): string[] {
  return buttons(blocks).map((b) => String(b.action_id));
}

/**
 * Every overflow-menu option in the payload, with its decoded value.
 *
 * Decoded through the queue builder's OWN parser: the option wire form is short
 * -keyed to fit Slack's 150-char option `value`, and these surface tests must
 * assert what the coordinates MEAN (which item, which turn epoch), not which
 * letters the renderer currently spells them with.
 */
function menuOptions(blocks: unknown[]): Array<{ actionId: string; value: FollowupItemMenuValue }> {
  const found: Array<{ actionId: string; value: FollowupItemMenuValue }> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (record.type === 'overflow' && Array.isArray(record.options)) {
        for (const option of record.options as Array<Record<string, unknown>>) {
          const value = parseFollowupMenuValue(String(option.value));
          // An unparseable option is a queue-builder concern, not a surface one.
          if (value) found.push({ actionId: String(record.action_id), value });
        }
      }
      for (const value of Object.values(record)) walk(value);
    }
  };
  walk(blocks);
  return found;
}

/**
 * Where the embedded queue starts. Layout-agnostic on purpose: the queue
 * builder owns whether its header is a section or a one-line context
 * (`followup-queue-blocks.ts` compact layout), and these are SURFACE tests —
 * they pin where the queue sits inside the combined message, not how the
 * queue draws itself.
 */
function queueTitleIndex(blocks: any[]): number {
  return blocks.findIndex((b) => JSON.stringify(b ?? {}).includes(FOLLOWUP_QUEUE_TITLE));
}

/** The item-scoped `Send now` control, whichever widget currently carries it. */
function sendNowValue(blocks: unknown[]): Partial<FollowupItemMenuValue> | undefined {
  const button = buttons(blocks).find((b) => b.action_id === FOLLOWUP_SEND_NOW_ACTION_ID);
  if (button) return JSON.parse(String(button.value)) as Partial<FollowupItemMenuValue>;
  return menuOptions(blocks).find((option) => option.value.op === 'send_now')?.value;
}

/**
 * A39 — the Queue left the panel.
 *
 * The user reads a queued item where they typed it (one bot message per queued
 * message, `slack-handler.ts` `enqueueFollowup`), so the combined panel renders
 * NO queue section and no queue-derived counts any more. What it must keep is
 * everything else it ever did: the header, the control rows, and the queue READ
 * it needs for the turn-epoch gate (next describe) — dropping the section is a
 * rendering change, not the removal of the queue wiring.
 */
describe('ThreadSurface — the combined panel no longer renders the Queue (A39)', () => {
  /** Every queue-owned action id the panel used to be able to emit. */
  const QUEUE_ACTION_IDS = [
    FOLLOWUP_SEND_NOW_ACTION_ID,
    FOLLOWUP_CANCEL_ACTION_ID,
    FOLLOWUP_ITEM_MENU_ACTION_ID,
    FOLLOWUP_PAGE_PREV_ACTION_ID,
    FOLLOWUP_PAGE_NEXT_ACTION_ID,
  ];

  function panelWith(followup: Partial<Pick<ThreadSurfaceDeps, 'getFollowupView' | 'getFollowupError'>>) {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, followup));
    return { session, slackApi, surface };
  }

  function expectNoQueue(captured: Captured): void {
    const payload = JSON.stringify(captured.blocks ?? []);
    expect(payload).not.toContain(FOLLOWUP_QUEUE_TITLE);
    expect(payload).not.toContain(FOLLOWUP_SEND_NOW_LABEL);
    for (const actionId of QUEUE_ACTION_IDS) expect(payload).not.toContain(actionId);
    expect(actionIds(captured.blocks)).not.toContain(FOLLOWUP_SEND_NOW_ACTION_ID);
    expect(menuOptions(captured.blocks)).toHaveLength(0);
    expect(sendNowValue(captured.blocks)).toBeUndefined();
  }

  it('renders the panel without a Queue section even when the queue is full of live items', async () => {
    const items = [
      item({ seq: 1 }),
      item({ seq: 2, state: 'steered', stateReason: 'steered' }),
      item({ seq: 3, state: 'paused' }),
    ];
    const { session, slackApi, surface } = panelWith({ getFollowupView: () => view({ items, turnEpoch: 4 }) });

    await surface.updatePanel(session, KEY);

    expect(slackApi.updates).toHaveLength(1);
    expect(slackApi.posts).toHaveLength(0);
    expectNoQueue(slackApi.updates[0]);
    // Not a queued message's text either — the item message carries it now.
    expect(textObjects(slackApi.updates[0].blocks).some((t) => t.text.includes('message 1'))).toBe(false);
    // The panel itself is untouched: header + control rows still render.
    expect(textObjects(slackApi.updates[0].blocks).some((t) => t.text.includes('queue demo'))).toBe(true);
    expect(
      slackApi.updates[0].blocks.some((b: any) => b?.type === 'actions' && b?.block_id === 'control_actions'),
    ).toBe(true);
  });

  it('keeps the queue out of the closed render too', async () => {
    const { session, slackApi, surface } = panelWith({
      getFollowupView: () =>
        view({
          items: [item({ seq: 1, state: 'cancelled' }), item({ seq: 2, state: 'paused' })],
          freeze: { reason: 'session ended', at: 1 },
        }),
    });

    await surface.close(session, KEY);

    const closed = slackApi.updates.at(-1);
    expect(closed).toBeDefined();
    expectNoQueue(closed as Captured);
  });

  it('drops the queued/전달 breakdown from the accessible fallback text', async () => {
    const { session, slackApi, surface } = panelWith({
      getFollowupView: () =>
        view({
          items: [item({ seq: 1 }), item({ seq: 2, state: 'steered', stateReason: 'steered' })],
          freeze: { reason: 'stopped by <!channel>', at: 1 },
        }),
    });

    await surface.updatePanel(session, KEY);
    const text = slackApi.updates[0].text;

    // The owner/title line is the whole fallback again.
    expect(text).toContain('zhuge');
    expect(text).toContain('queue demo');
    expect(text).not.toContain(FOLLOWUP_QUEUE_TITLE);
    expect(text).not.toContain('2 item(s)');
    expect(text).not.toContain('queued 1');
    expect(text).not.toContain(FOLLOWUP_STEERED_COUNT_LABEL);
    expect(text).not.toContain('stopped by');
  });

  it('says nothing about a degraded queue on the panel — there is no queue on it to degrade', async () => {
    const { session, slackApi, surface } = panelWith({
      getFollowupView: () => undefined,
      getFollowupError: () => 'snapshot load failed',
    });

    await surface.updatePanel(session, KEY);

    expect(JSON.stringify(slackApi.updates[0].blocks)).not.toContain('snapshot load failed');
    expect(slackApi.updates[0].text).not.toContain('snapshot load failed');
  });

  it('still renders the panel when the queue provider itself raises', async () => {
    const { session, slackApi, surface } = panelWith({
      getFollowupView: () => {
        throw new Error('store exploded');
      },
    });

    await expect(surface.updatePanel(session, KEY)).resolves.toBeUndefined();
    expect(JSON.stringify(slackApi.updates[0].blocks)).not.toContain('store exploded');
    expect(textObjects(slackApi.updates[0].blocks).some((t) => t.text.includes('queue demo'))).toBe(true);
  });

  it('stays within Slack’s 50-block cap with the summary the queue used to compete with', async () => {
    const session = makeSession();
    session.actionPanel!.summaryBlocks = Array.from({ length: 40 }, (_, i) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `summary ${i}` },
    }));
    const slackApi = makeSlackApi();
    const items = Array.from({ length: 100 }, (_, i) => item({ seq: i + 1 }));
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ items }) }));

    await surface.updatePanel(session, KEY);
    const blocks = slackApi.updates[0].blocks;

    expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(blocks.some((b: any) => b?.type === 'actions' && b?.block_id === 'control_actions')).toBe(true);
  });
});

describe('ThreadSurface — turn-epoch gated writes (A12/A28)', () => {
  it('rejects a write stamped with a stale turn epoch, leaving state and Slack untouched', async () => {
    const session = makeSession();
    session.actionPanel!.agentPhase = 'live phase';
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 5 }) }));

    await surface.setStatus(session, KEY, { agentPhase: 'stale phase' }, { expectedTurnEpoch: 4 });

    expect(slackApi.updates).toHaveLength(0);
    expect(slackApi.posts).toHaveLength(0);
    expect(session.actionPanel?.agentPhase).toBe('live phase');
  });

  it('accepts a write stamped with the current turn epoch', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 5 }) }));

    await surface.setStatus(session, KEY, { agentPhase: 'fresh phase' }, { expectedTurnEpoch: 5 });

    expect(slackApi.updates).toHaveLength(1);
    expect(session.actionPanel?.agentPhase).toBe('fresh phase');
  });

  it('is unaffected when no epoch is supplied (existing callers)', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 5 }) }));

    await surface.setStatus(session, KEY, { agentPhase: 'legacy' });
    await surface.updatePanel(session, KEY);

    expect(session.actionPanel?.agentPhase).toBe('legacy');
    expect(slackApi.updates.length).toBeGreaterThan(0);
  });

  // Review round 1: the epoch was read through the RENDER-filtered view, which
  // returns null for an empty unfrozen queue — i.e. the guard was inert for the
  // ordinary case of a turn with nothing queued. The epoch must be read from
  // the raw provider, independently of whether the Queue renders.
  it('gates writes even when the queue is empty (epoch read must not depend on rendering)', async () => {
    const session = makeSession();
    session.actionPanel!.agentPhase = 'live phase';
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, { getFollowupView: () => view({ items: [], turnEpoch: 5 }) }),
    );

    await surface.setStatus(session, KEY, { agentPhase: 'stale phase' }, { expectedTurnEpoch: 4 });
    await surface.updatePanel(session, KEY, { expectedTurnEpoch: 4 });
    await surface.finalizeOnEndTurn(session, KEY, { reason: 'end_turn', timestamp: 1 }, false, {
      expectedTurnEpoch: 4,
    });

    expect(slackApi.updates).toHaveLength(0);
    expect(slackApi.posts).toHaveLength(0);
    expect(session.actionPanel?.agentPhase).toBe('live phase');
  });

  it('still renders nothing for an empty queue while the epoch guard stays live', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, { getFollowupView: () => view({ items: [], turnEpoch: 5 }) }),
    );

    await surface.updatePanel(session, KEY, { expectedTurnEpoch: 5 });

    expect(slackApi.updates).toHaveLength(1);
    expect(queueTitleIndex(slackApi.updates[0].blocks)).toBe(-1);
  });

  // External review: a write that CARRIES an epoch is a write that claims to
  // belong to a specific turn generation. If the store is degraded and the
  // current generation cannot be read, allowing it means a superseded turn can
  // repaint the live turn's surface precisely when the queue is least
  // trustworthy. An unverifiable claim is rejected (fail-CLOSED); writes that
  // carry no epoch at all are the legacy/no-queue path and stay unaffected.
  it('rejects the epoch-stamped write when the view carries no turnEpoch at all (unverifiable = fail-closed)', async () => {
    const session = makeSession();
    session.actionPanel!.agentPhase = 'live phase';
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: undefined }) }),
    );

    await surface.setStatus(session, KEY, { agentPhase: 'stale phase' }, { expectedTurnEpoch: 4 });

    expect(slackApi.updates).toHaveLength(0);
    expect(session.actionPanel?.agentPhase).toBe('live phase');
  });

  it('rejects the epoch-stamped write when the queue view read throws (store degraded)', async () => {
    const session = makeSession();
    session.actionPanel!.agentPhase = 'live phase';
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, {
        getFollowupView: () => {
          throw new Error('store unavailable');
        },
      }),
    );

    await surface.setStatus(session, KEY, { agentPhase: 'stale phase' }, { expectedTurnEpoch: 4 });

    expect(slackApi.updates).toHaveLength(0);
    expect(session.actionPanel?.agentPhase).toBe('live phase');
  });

  it('rejects the epoch-stamped write when no queue provider is wired at all', async () => {
    const session = makeSession();
    session.actionPanel!.agentPhase = 'live phase';
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi));

    await surface.setStatus(session, KEY, { agentPhase: 'stale phase' }, { expectedTurnEpoch: 4 });

    expect(slackApi.updates).toHaveLength(0);
    expect(session.actionPanel?.agentPhase).toBe('live phase');
  });

  // A degraded store rejects EVERY write of the turn; one warn per session is
  // the operator signal, a warn per write is a log flood.
  it('warns exactly once per session when the epoch is unverifiable', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: undefined }) }),
    );
    const warnSpy = vi.fn();
    (surface as unknown as { logger: { warn: unknown } }).logger.warn = warnSpy;

    await surface.setStatus(session, KEY, { agentPhase: 'a' }, { expectedTurnEpoch: 4 });
    await surface.setStatus(session, KEY, { agentPhase: 'b' }, { expectedTurnEpoch: 5 });
    await surface.updatePanel(session, KEY, { expectedTurnEpoch: 6 });

    const unverifiable = warnSpy.mock.calls.filter((call) => String(call[0]).includes('unverifiable'));
    expect(unverifiable).toHaveLength(1);
    expect(unverifiable[0][1]).toMatchObject({ sessionKey: KEY, expected: 4 });
  });

  // The other half of the rule: no epoch claimed → nothing to verify → the
  // legacy/no-queue path keeps writing even with a degraded store.
  it('still allows an UNSTAMPED write when the epoch is unverifiable (legacy path)', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: undefined }) }),
    );

    await surface.setStatus(session, KEY, { agentPhase: 'legacy phase' });

    expect(slackApi.updates).toHaveLength(1);
    expect(session.actionPanel?.agentPhase).toBe('legacy phase');
  });

  it('still rejects when the view carries a REAL epoch that disagrees', async () => {
    const session = makeSession();
    session.actionPanel!.agentPhase = 'live phase';
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 5 }) }));

    await surface.setStatus(session, KEY, { agentPhase: 'stale phase' }, { expectedTurnEpoch: 4 });

    expect(slackApi.updates).toHaveLength(0);
    expect(session.actionPanel?.agentPhase).toBe('live phase');
  });

  it('treats a genuine epoch 0 as a real value, not as unknown', async () => {
    const session = makeSession();
    session.actionPanel!.agentPhase = 'live phase';
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 0 }) }));

    await surface.setStatus(session, KEY, { agentPhase: 'stale phase' }, { expectedTurnEpoch: 4 });
    expect(slackApi.updates).toHaveLength(0);

    await surface.setStatus(session, KEY, { agentPhase: 'matching phase' }, { expectedTurnEpoch: 0 });
    expect(slackApi.updates).toHaveLength(1);
    expect(session.actionPanel?.agentPhase).toBe('matching phase');
  });

  it('gates updatePanel on the same epoch', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 5 }) }));

    await surface.updatePanel(session, KEY, { expectedTurnEpoch: 1 });
    expect(slackApi.updates).toHaveLength(0);
  });

  // The end-of-turn finalizer is the LAST write a dying turn performs, and it
  // lands after teardown — exactly the window in which `Send now` has already
  // started a new turn. Without the gate it repaints the new turn's status line
  // with the old turn's "사용자 액션 대기".
  it('gates finalizeOnEndTurn so a superseded turn cannot repaint the new turn', async () => {
    const session = makeSession();
    session.actionPanel!.agentPhase = '작업 중';
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 5 }) }));

    await surface.finalizeOnEndTurn(session, KEY, { reason: 'end_turn', timestamp: 1 }, false, {
      expectedTurnEpoch: 4,
    });

    expect(slackApi.updates).toHaveLength(0);
    expect(session.actionPanel?.agentPhase).toBe('작업 중');
  });

  it('applies finalizeOnEndTurn when the epoch still matches', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 5 }) }));

    await surface.finalizeOnEndTurn(session, KEY, { reason: 'end_turn', timestamp: 1 }, false, {
      expectedTurnEpoch: 5,
    });

    expect(slackApi.updates).toHaveLength(1);
    expect(session.actionPanel?.agentPhase).toBe('사용자 액션 대기');
  });

  it('keeps finalizeOnEndTurn unguarded for existing callers that pass no options', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 5 }) }));

    await surface.finalizeOnEndTurn(session, KEY, { reason: 'max_tokens', timestamp: 1 }, false);

    expect(slackApi.updates).toHaveLength(1);
    expect(session.actionPanel?.agentPhase).toBe('토큰 한도 도달');
  });
});

describe('ThreadSurface — U9 real progress vs liveness', () => {
  it('does NOT stamp lastProgressAt from a generic lifecycle setStatus', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi));

    await surface.setStatus(session, KEY, { agentPhase: '작업 중', activeTool: 'Bash' });

    // The lifecycle heartbeat is recorded...
    expect(session.actionPanel?.statusUpdatedAt).toBeGreaterThan(0);
    // ...but it is NOT evidence that the work moved.
    expect(session.actionPanel?.lastProgressAt).toBeUndefined();
  });

  it('records lastProgressAt only when the caller supplies a real progress event', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi));

    await surface.setStatus(session, KEY, { agentPhase: '작업 중', lastProgressAt: 1_700_000_000_000 });
    expect(session.actionPanel?.lastProgressAt).toBe(1_700_000_000_000);

    // A later generic call must not move or clear the recorded progress.
    await surface.setStatus(session, KEY, { agentPhase: '분석 중' });
    expect(session.actionPanel?.lastProgressAt).toBe(1_700_000_000_000);
  });

  it('carries the phase and progress age into the rendered surface', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi));

    session.activityState = 'working';
    await surface.setStatus(session, KEY, {
      agentPhase: '코드 수정 중',
      lastProgressAt: Date.now() - 5000,
    });

    const rendered = textObjects(slackApi.updates.at(-1)?.blocks ?? [])
      .map((t) => t.text)
      .join('\n');
    expect(rendered).toContain('코드 수정 중');
    expect(rendered).toMatch(/마지막 활동 \d+초 전/);
  });

  it('renders the unknown-progress marker when nothing real has been reported', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi));

    session.activityState = 'working';
    await surface.setStatus(session, KEY, { agentPhase: '코드 수정 중' });

    const rendered = textObjects(slackApi.updates.at(-1)?.blocks ?? [])
      .map((t) => t.text)
      .join('\n');
    expect(rendered).toContain('실제 활동 기록 없음');
  });
});

describe('ThreadSurface — transient chat.update failure must not duplicate the surface', () => {
  it('retains messageTs and posts nothing on a non-404 update error (user-initiated thread)', async () => {
    const session = makeSession({ threadModel: 'user-initiated' });
    const updateMessage = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ratelimited'), { data: { error: 'ratelimited' } }));
    const slackApi = makeSlackApi({ updateMessage });
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view() }));

    await surface.updatePanel(session, KEY);

    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.posts).toHaveLength(0);
    expect(session.actionPanel?.messageTs).toBe('panel-ts');
  });

  it('still recreates the surface when the message is really gone (message_not_found)', async () => {
    const session = makeSession({ threadModel: 'user-initiated' });
    const updateMessage = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('message_not_found'), { data: { error: 'message_not_found' } }));
    const slackApi = makeSlackApi({ updateMessage });
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view() }));

    await surface.updatePanel(session, KEY);

    expect(slackApi.posts).toHaveLength(1);
    expect(session.actionPanel?.messageTs).toBe('posted-ts');
  });
});

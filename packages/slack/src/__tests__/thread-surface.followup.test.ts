import { describe, expect, it, vi } from 'vitest';
import type { FollowupItem } from '../followup-queue';
import {
  FOLLOWUP_PAGE_NEXT_ACTION_ID,
  FOLLOWUP_PAGE_PREV_ACTION_ID,
  FOLLOWUP_QUEUE_TITLE,
  FOLLOWUP_SEND_NOW_ACTION_ID,
  FOLLOWUP_SEND_NOW_LABEL,
  type FollowupItemMenuValue,
  type FollowupQueueView,
  parseFollowupMenuValue,
} from '../followup-queue-blocks';
import type { MessageEvent } from '../pipeline/types';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * U3/U9 — the follow-up `Queue` rendered inside the EXISTING combined header
 * surface (`.prd/slack-agent-ui/loop.md:47`), plus the surface-level guards the
 * same change depends on: turn-epoch gated writes (A12/A28) and the duplicate
 * surface-message bug on a transient `chat.update` failure.
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

describe('ThreadSurface — U3/U9 Queue inside the combined header surface', () => {
  it('renders Queue in the SAME combined message, after the header and before the action rows', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ turnEpoch: 4 }) }));

    await surface.updatePanel(session, KEY);

    // One combined message — no second message for the queue.
    expect(slackApi.updates).toHaveLength(1);
    expect(slackApi.posts).toHaveLength(0);

    const blocks = slackApi.updates[0].blocks;
    const titleAt = queueTitleIndex(blocks);
    expect(titleAt).toBeGreaterThan(0); // after the header, never first

    // Header still present in the same payload.
    expect(textObjects(blocks).some((t) => t.text.includes('queue demo'))).toBe(true);

    // Queue sits before the existing action rows (close/control buttons).
    const firstActionsAt = blocks.findIndex((b: any) => b?.type === 'actions' && b?.block_id);
    expect(firstActionsAt).toBeGreaterThan(titleAt);
  });

  it('offers `Send now` carrying the session turn epoch, and never mints a mention from the raw message', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const raw = 'ping <!channel> now';
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, {
        getFollowupView: () => view({ items: [item({ message: event({ text: raw }) })], turnEpoch: 9 }),
      }),
    );

    await surface.updatePanel(session, KEY);
    const blocks = slackApi.updates[0].blocks;

    // The control is `Send now` whichever widget the queue builder currently
    // uses for it (button, or an option of the compact overflow menu) — what
    // the surface must not lose is the turn epoch it carries.
    expect(sendNowValue(blocks)?.turnEpoch).toBe(9);
    const labels = textObjects(blocks).map((t) => t.text);
    expect(labels).toContain(FOLLOWUP_SEND_NOW_LABEL);

    // The original content reaches the user, and can never address anybody:
    // `plain_text` is inert; an mrkdwn rendering must arrive escaped.
    const carrying = textObjects(blocks).filter((t) => t.text.includes('ping'));
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying.every((t) => t.type === 'plain_text' || !t.text.includes(raw))).toBe(true);
    expect(labels.some((text) => text.includes('<!channel>') && !text.includes('&lt;!channel&gt;'))).toBe(false);
  });

  it('keeps the Queue in the closed render so cancelled / paused history stays visible', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, {
        getFollowupView: () =>
          view({
            items: [item({ seq: 1, state: 'cancelled' }), item({ seq: 2, state: 'paused' })],
            freeze: { reason: 'session ended', at: 1 },
          }),
      }),
    );

    await surface.close(session, KEY);

    const blocks = slackApi.updates.at(-1)?.blocks ?? [];
    expect(queueTitleIndex(blocks)).toBeGreaterThan(0);
    const texts = textObjects(blocks).map((t) => t.text);
    expect(texts.some((t) => t.includes('cancelled'))).toBe(true);
    expect(texts.some((t) => t.includes('paused'))).toBe(true);
  });

  it('pages the backlog so every item is reachable via setFollowupPage', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const items = Array.from({ length: 12 }, (_, i) => item({ seq: i + 1 }));
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ items }) }));

    await surface.updatePanel(session, KEY);
    const page1 = textObjects(slackApi.updates[0].blocks).map((t) => t.text);
    expect(page1.some((t) => t.includes('message 1'))).toBe(true);
    expect(page1.some((t) => t.includes('message 6'))).toBe(false);
    expect(actionIds(slackApi.updates[0].blocks)).toContain(FOLLOWUP_PAGE_NEXT_ACTION_ID);

    const applied = await surface.setFollowupPage(KEY, 2);
    expect(applied).toBe(2);

    const page2Blocks = slackApi.updates.at(-1)?.blocks ?? [];
    const page2 = textObjects(page2Blocks).map((t) => t.text);
    expect(page2.some((t) => t.includes('message 6'))).toBe(true);
    expect(page2.some((t) => t.includes('message 1.'))).toBe(false);
    expect(actionIds(page2Blocks)).toContain(FOLLOWUP_PAGE_PREV_ACTION_ID);
  });

  it('clamps an out-of-range page instead of rendering an empty queue', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const items = Array.from({ length: 7 }, (_, i) => item({ seq: i + 1 }));
    const surface = new ThreadSurface(makeDeps(session, slackApi, { getFollowupView: () => view({ items }) }));

    expect(await surface.setFollowupPage(KEY, 0)).toBe(1);
    expect(await surface.setFollowupPage(KEY, 99)).toBe(2);

    const texts = textObjects(slackApi.updates.at(-1)?.blocks ?? []).map((t) => t.text);
    expect(texts.some((t) => t.includes('message 6'))).toBe(true);
  });

  it('stays within Slack’s 50-block cap by trimming the optional summary, never the controls', async () => {
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
    // Core controls survive the trim.
    expect(sendNowValue(blocks)).toBeDefined();
    expect(blocks.some((b: any) => b?.type === 'actions' && b?.block_id === 'control_actions')).toBe(true);
    // Optional summary is what gave way.
    const summaryCount = textObjects(blocks).filter((t) => t.text.startsWith('summary ')).length;
    expect(summaryCount).toBeLessThan(40);
  });

  it('extends the accessible fallback text with queue counts, states and a sanitized freeze reason', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, {
        getFollowupView: () =>
          view({
            items: [item({ seq: 1 }), item({ seq: 2, state: 'paused' })],
            freeze: { reason: 'stopped by <!channel>', at: 1 },
          }),
      }),
    );

    await surface.updatePanel(session, KEY);
    const text = slackApi.updates[0].text;

    expect(text).toContain('zhuge');
    expect(text).toContain('queue demo');
    expect(text).toContain(FOLLOWUP_QUEUE_TITLE);
    expect(text).toContain('2 item(s)');
    expect(text).toContain('queued 1');
    expect(text).toContain('paused 1');
    // Untrusted reason must not be able to smuggle a broadcast mention.
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('&lt;!channel&gt;');
  });

  it('degrades visibly when the queue cannot be read instead of showing an empty queue', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, {
        getFollowupView: () => undefined,
        getFollowupError: () => 'snapshot load failed',
      }),
    );

    await surface.updatePanel(session, KEY);
    const blocks = slackApi.updates[0].blocks;

    expect(queueTitleIndex(blocks)).toBeGreaterThan(0);
    const texts = textObjects(blocks).map((t) => t.text);
    expect(texts.some((t) => t.includes('snapshot load failed'))).toBe(true);
    expect(slackApi.updates[0].text).toContain('snapshot load failed');
  });

  it('degrades instead of throwing when the queue provider itself raises', async () => {
    const session = makeSession();
    const slackApi = makeSlackApi();
    const surface = new ThreadSurface(
      makeDeps(session, slackApi, {
        getFollowupView: () => {
          throw new Error('store exploded');
        },
      }),
    );

    await expect(surface.updatePanel(session, KEY)).resolves.toBeUndefined();
    const texts = textObjects(slackApi.updates[0].blocks).map((t) => t.text);
    expect(texts.some((t) => t.includes('store exploded'))).toBe(true);
  });
});

describe('ThreadSurface — the embedded Queue is budgeted in COMPACT blocks', () => {
  /**
   * White-box on purpose: the block budget is computed from the rest of the
   * surface, and the interesting case is a TIGHT budget (a tall status panel),
   * which cannot be produced from the public render path without pinning the
   * unrelated block counts of the header and the action panel.
   */
  function embed(
    surface: ThreadSurface,
    budget: number,
    followup: { view?: FollowupQueueView; error?: string },
  ): unknown[] {
    return (
      surface as unknown as {
        buildFollowupBlocks(key: string, budget: number, followup: unknown): unknown[];
      }
    ).buildFollowupBlocks(KEY, budget, followup);
  }

  const backlog = Array.from({ length: 12 }, (_, i) => item({ seq: i + 1 }));

  function surfaceFor(items = backlog) {
    return new ThreadSurface(makeDeps(makeSession(), makeSlackApi(), { getFollowupView: () => view({ items }) }));
  }

  // The compact layout spends ONE block per item (plus a header context and, at
  // most, a freeze line and a nav row). Budgeting it at two blocks per item
  // halved the page for no reason.
  it('fills the page at one block per item, so 8 blocks carry a full page', () => {
    const blocks = embed(surfaceFor(), 8, { view: view({ items: backlog }) });

    const rows = blocks.filter((b) => JSON.stringify(b ?? {}).includes('message '));
    expect(rows).toHaveLength(5); // the embed's hard cap, now actually reachable
    expect(blocks.length).toBeLessThanOrEqual(8);
  });

  it('never spends more blocks than the budget it was handed', () => {
    for (const budget of [2, 3, 4, 5, 6, 7, 10, 20, 45]) {
      const blocks = embed(surfaceFor(), budget, { view: view({ items: backlog }) });
      expect(blocks.length).toBeLessThanOrEqual(budget);
    }
  });

  it('keeps the freeze line and the degradation note inside the same budget', () => {
    const frozen = view({ items: backlog, freeze: { reason: 'stop requested', at: 1 } });
    const blocks = embed(surfaceFor(), 6, { view: frozen, error: 'partial read' });

    expect(blocks.length).toBeLessThanOrEqual(6);
    const rendered = textObjects(blocks).map((t) => t.text);
    expect(rendered.some((t) => t.includes('stop requested'))).toBe(true);
    expect(rendered.some((t) => t.includes('partial read'))).toBe(true);
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

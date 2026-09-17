import type { App } from '@slack/bolt';
import {
  type DispatchRequest,
  FollowupDispatcher,
  type FollowupDispatcherDeps,
  type SendNowResult,
} from '@soma/slack/followup-dispatcher';
import { type FollowupItem, FollowupQueue } from '@soma/slack/followup-queue';
import {
  encodeFollowupItemActionValue,
  encodeFollowupPageActionValue,
  FOLLOWUP_PAGE_NEXT_ACTION_ID,
  FOLLOWUP_RESUME_ACTION_ID,
  FOLLOWUP_RETRY_ACTION_ID,
  FOLLOWUP_SEND_NOW_ACTION_ID,
} from '@soma/slack/followup-queue-blocks';
import { describe, expect, it, vi } from 'vitest';
import { type FollowupActionSession, type FollowupActionsDeps, registerFollowupActions } from '../followup-actions';

/**
 * U7 action handlers — the trust boundary between a Slack click and the
 * follow-up queue (`.prd/slack-agent-ui/loop.md:45`, A12/A13/A29/A30).
 *
 * What these tests actually assert, beyond "the happy path works":
 *   - the 3s ack is sent BEFORE any authorization/dispatch await (a hung
 *     `canInterrupt` must not turn into a Slack timeout);
 *   - a forged payload (session / channel / thread / epoch) is refused, and the
 *     refusal says the item was RETAINED — never something success-shaped;
 *   - the clicker is an authorization subject only: the dispatched request still
 *     carries the ORIGINAL author (A30).
 *
 * The last group runs against the REAL `FollowupQueue` + `FollowupDispatcher`
 * so the CAS/turn-epoch semantics are the shipped ones, not a mock of them.
 */

const CHANNEL = 'C-SESSION';
const THREAD = '1700.000000';
const SESSION_KEY = `${CHANNEL}:${THREAD}`;
const AUTHOR = 'U-AUTHOR';
const CLICKER = 'U-CLICKER';
const SURFACE_TS = '1700.000500';

type Listener = (args: {
  ack: () => Promise<void>;
  body: unknown;
  respond: (message: Record<string, unknown>) => Promise<unknown>;
}) => Promise<void>;

/** Flush pending microtasks + the macrotask queue: detached jobs settle here. */
function tick(times = 3): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return chain;
}

function session(over: Partial<FollowupActionSession> = {}): FollowupActionSession {
  return { channelId: CHANNEL, threadTs: THREAD, ...over };
}

function clickBody(value: string | undefined, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'block_actions',
    user: { id: CLICKER },
    channel: { id: CHANNEL },
    container: { type: 'message', channel_id: CHANNEL, message_ts: SURFACE_TS, thread_ts: THREAD },
    message: { ts: SURFACE_TS, thread_ts: THREAD },
    actions: [{ type: 'button', action_id: 'x', value }],
    ...over,
  };
}

function itemValue(over: Partial<{ sessionKey: string; itemId: string; epoch: number; turnEpoch: number }> = {}) {
  return encodeFollowupItemActionValue({
    sessionKey: SESSION_KEY,
    itemId: `${SESSION_KEY}#1`,
    epoch: 0,
    ...over,
  });
}

/**
 * The overflow menu that replaces the per-item button row (U3 rework). The id
 * and the `{op,s,n,e,t}` payload are the OTHER side of the contract — this file
 * writes them by hand on purpose: a test that encoded the value with the
 * renderer's own helper could only prove the module agrees with itself, not
 * that it reads what Slack actually delivers.
 *
 * Short keys and `n` = the item's seq, not its id: an option `value` is capped
 * at 150 chars and a real `work:<channel>:<threadTs>` key spelled out twice
 * (once as the key, once inside the id) nearly exhausted it.
 */
const MENU_ACTION_ID = 'followup_item_menu_v1';

function menuValue(
  op: string,
  over: Partial<{ sessionKey: string; itemId: string; epoch: number; turnEpoch: number }> = {},
): string {
  const sessionKey = over.sessionKey ?? SESSION_KEY;
  const itemId = over.itemId ?? `${sessionKey}#1`;
  const payload: Record<string, unknown> = {
    op,
    s: sessionKey,
    n: Number(itemId.slice(itemId.lastIndexOf('#') + 1)),
    e: over.epoch ?? 0,
  };
  if (over.turnEpoch !== undefined) payload.t = over.turnEpoch;
  return JSON.stringify(payload);
}

/** An overflow click carries its payload in `selected_option`, not in `value`. */
function menuBody(value: string | undefined, over: Record<string, unknown> = {}): Record<string, unknown> {
  return clickBody(undefined, {
    actions: [{ type: 'overflow', action_id: MENU_ACTION_ID, selected_option: { value } }],
    ...over,
  });
}

function queuedItem(over: Partial<FollowupItem> = {}): FollowupItem {
  return {
    id: `${SESSION_KEY}#1`,
    sessionKey: SESSION_KEY,
    seq: 1,
    epoch: 0,
    state: 'queued',
    eventKey: `${CHANNEL}:1700.000100`,
    message: { user: AUTHOR, channel: CHANNEL, ts: '1700.000100', text: '배포 상태 알려줘' },
    context: {},
    enqueuedAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function harness(over: Partial<FollowupActionsDeps> = {}) {
  const routes = new Map<string, Listener>();
  const app = {
    action(id: string, listener: Listener) {
      routes.set(id, listener);
    },
  } as unknown as App;

  /** Call order across the ack / authorize / dispatch boundary. */
  const order: string[] = [];
  const responses: Array<Record<string, unknown>> = [];
  const respond = vi.fn(async (message: Record<string, unknown>) => {
    responses.push(message);
    return undefined;
  });

  const queue = {
    get: vi.fn((_s: string, _i: string) => queuedItem() as FollowupItem | undefined),
    resume: vi.fn((_s: string) => {
      order.push('resume');
    }),
    retry: vi.fn((_s: string, _i: string, _e: number) => ({ ok: true as const, item: queuedItem() })),
    cancelItem: vi.fn((_s: string, _i: string, _e: number, _r?: string) => {
      order.push('cancelItem');
      return { ok: true as const, item: queuedItem({ state: 'cancelled' }) };
    }),
    freezeReason: vi.fn((_s: string) => undefined as string | undefined),
  };
  const dispatcher = {
    sendNow: vi.fn(async (..._args: unknown[]) => {
      order.push('sendNow');
      return { status: 'rejected', reason: 'not-found', detail: 'stub' } as SendNowResult;
    }),
    clearDrainHalt: vi.fn((_s: string, _t: string) => {
      order.push('clearDrainHalt');
    }),
    isBusy: vi.fn((_s: string) => false),
  };

  /** The host's SDK-backed cancel for a steered item — the queue cannot dequeue the SDK copy. */
  const cancelSteered = vi.fn(async (_s: string, _i: string, _e: number, _u: string) => {
    order.push('cancelSteered');
    return 'cancelled' as 'cancelled' | 'already-delivered' | 'failed';
  });

  const deps: FollowupActionsDeps = {
    queue,
    dispatcher,
    cancelSteered,
    getSessionByKey: vi.fn((_key: string) => session() as FollowupActionSession | undefined),
    canInterrupt: vi.fn(async (_s: string, _u: string) => {
      order.push('canInterrupt');
      return true;
    }),
    refresh: vi.fn(async (_s: string, _p?: number) => {
      order.push('refresh');
    }),
    runDrain: vi.fn(async (_s: string) => {
      order.push('runDrain');
    }),
    sweepSteered: vi.fn(async (_s: string) => {
      order.push('sweepSteered');
    }),
    reportError: vi.fn(),
    ...over,
  };

  registerFollowupActions(app, deps);

  async function click(actionId: string, body: Record<string, unknown>): Promise<void> {
    const listener = routes.get(actionId);
    if (!listener) throw new Error(`no listener registered for ${actionId}`);
    const ack = vi.fn(async () => {
      order.push('ack');
    });
    await listener({ ack, body, respond });
    expect(ack).toHaveBeenCalledTimes(1);
  }

  return { app, routes, deps, queue, dispatcher, cancelSteered, respond, responses, order, click };
}

/** Every refusal must read as a refusal — and must never claim the item ran. */
function expectRefusal(responses: Array<Record<string, unknown>>): string {
  expect(responses.length).toBeGreaterThan(0);
  const last = responses[responses.length - 1];
  expect(last.response_type).toBe('ephemeral');
  expect(last.replace_original).toBe(false);
  const text = String(last.text);
  expect(text.toLowerCase()).toMatch(/rejected|ignored|could not/);
  expect(text.toLowerCase()).not.toMatch(/\bsent\b|\bqueued now\b|\bdone\b/);
  return text;
}

/** Shape-only assertion, for the Korean menu replies `expectRefusal` cannot read. */
function lastEphemeral(responses: Array<Record<string, unknown>>): string {
  expect(responses.length).toBeGreaterThan(0);
  const last = responses[responses.length - 1];
  expect(last.response_type).toBe('ephemeral');
  expect(last.replace_original).toBe(false);
  return String(last.text);
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

describe('registerFollowupActions — routes', () => {
  it('binds every follow-up action id exactly once', () => {
    const { routes } = harness();
    expect([...routes.keys()].sort()).toEqual(
      [
        'followup_page_next_v1',
        'followup_page_prev_v1',
        MENU_ACTION_ID,
        FOLLOWUP_RESUME_ACTION_ID,
        FOLLOWUP_RETRY_ACTION_ID,
        FOLLOWUP_SEND_NOW_ACTION_ID,
      ].sort(),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Ack ordering
 * ------------------------------------------------------------------ */

describe('ack contract', () => {
  it('acks before an authorization that never resolves (resume)', async () => {
    const h = harness({
      canInterrupt: vi.fn(() => new Promise<boolean>(() => {})),
    });
    await h.click(FOLLOWUP_RESUME_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.deps.canInterrupt).toHaveBeenCalledTimes(1);
    expect(h.order[0]).toBe('ack');
    expect(h.queue.resume).not.toHaveBeenCalled();
  });

  it('acks before a sendNow that never resolves', async () => {
    const h = harness();
    h.dispatcher.sendNow.mockImplementation(async () => {
      h.order.push('sendNow');
      return new Promise<SendNowResult>(() => {});
    });
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick();
    expect(h.order.slice(0, 2)).toEqual(['ack', 'sendNow']);
  });
});

/* ------------------------------------------------------------------ *
 * Payload is never identity
 * ------------------------------------------------------------------ */

describe('click verification', () => {
  it('rejects a click whose session does not exist', async () => {
    const h = harness({ getSessionByKey: vi.fn(() => undefined) });
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('rejects a click whose channel is not the session channel', async () => {
    const h = harness();
    await h.click(
      FOLLOWUP_SEND_NOW_ACTION_ID,
      clickBody(itemValue({ turnEpoch: 0 }), {
        channel: { id: 'C-ATTACKER' },
        container: { channel_id: 'C-ATTACKER', message_ts: SURFACE_TS, thread_ts: THREAD },
      }),
    );
    await tick();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('rejects a click from a different thread in the right channel', async () => {
    const h = harness();
    await h.click(
      FOLLOWUP_SEND_NOW_ACTION_ID,
      clickBody(itemValue({ turnEpoch: 0 }), {
        message: { ts: '1700.999999', thread_ts: '1700.999000' },
        container: { channel_id: CHANNEL, message_ts: '1700.999999', thread_ts: '1700.999000' },
      }),
    );
    await tick();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('rejects a click with no verifiable thread instead of trusting the payload', async () => {
    const h = harness();
    await h.click(
      FOLLOWUP_SEND_NOW_ACTION_ID,
      clickBody(itemValue({ turnEpoch: 0 }), {
        message: undefined,
        container: { channel_id: CHANNEL },
      }),
    );
    await tick();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('accepts a bot-initiated thread anchored on threadRootTs', async () => {
    const h = harness({
      getSessionByKey: vi.fn(() => session({ threadTs: undefined, threadRootTs: THREAD })),
    });
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick();
    expect(h.dispatcher.sendNow).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed button value', async () => {
    const h = harness();
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody('not-json'));
    await tick();
    expect(h.deps.getSessionByKey).not.toHaveBeenCalled();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('rejects a Send now whose turn epoch is not a safe integer', async () => {
    const h = harness();
    const forged = `{"sessionKey":"${SESSION_KEY}","itemId":"${SESSION_KEY}#1","epoch":0,"turnEpoch":1e21}`;
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(forged));
    await tick();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('rejects a Send now with no turn epoch at all', async () => {
    const h = harness();
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('rejects a stale item generation and leaves the item alone', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ epoch: 4 }));
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ epoch: 0, turnEpoch: 0 })));
    await tick();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    const text = expectRefusal(h.responses);
    expect(text.toLowerCase()).toContain('queue');
  });

  it('rejects an item that belongs to another session', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ sessionKey: 'C-OTHER:1' }));
    await h.click(FOLLOWUP_RESUME_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.resume).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });
});

/* ------------------------------------------------------------------ *
 * Resume
 * ------------------------------------------------------------------ */

describe('resume', () => {
  it('denies a clicker the interrupt policy rejects and retains the item', async () => {
    const h = harness({ canInterrupt: vi.fn(async () => false) });
    await h.click(FOLLOWUP_RESUME_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.resume).not.toHaveBeenCalled();
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
    expect(h.deps.runDrain).not.toHaveBeenCalled();
    const text = expectRefusal(h.responses);
    expect(text.toLowerCase()).toMatch(/stays|remains|retained/);
  });

  it('refuses to release the queue while a choice is still pending', async () => {
    const h = harness({
      getSessionByKey: vi.fn(() => session({ actionPanel: { waitingForChoice: true } })),
    });
    await h.click(FOLLOWUP_RESUME_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.resume).not.toHaveBeenCalled();
    expect(h.deps.runDrain).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('refuses to release the queue while an approval is recorded on the panel', async () => {
    const h = harness({
      getSessionByKey: vi.fn(() =>
        session({
          actionPanel: { pendingChoice: { turnId: 't1', kind: 'single', formIds: [], question: {}, createdAt: 1 } },
        }),
      ),
    });
    await h.click(FOLLOWUP_RESUME_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.resume).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('resumes, clears the halt and drains when nothing is running', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'paused' }));
    await h.click(FOLLOWUP_RESUME_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.resume).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.dispatcher.clearDrainHalt).toHaveBeenCalledWith(SESSION_KEY, 'resume');
    expect(h.deps.runDrain).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.order.indexOf('resume')).toBeLessThan(h.order.indexOf('clearDrainHalt'));
    expect(h.order.indexOf('clearDrainHalt')).toBeLessThan(h.order.indexOf('runDrain'));
  });

  it('does not drain while a dispatch is in flight — and never blind-retries', async () => {
    const h = harness();
    h.dispatcher.isBusy.mockReturnValue(true);
    h.queue.get.mockReturnValue(queuedItem({ state: 'paused' }));
    await h.click(FOLLOWUP_RESUME_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.resume).toHaveBeenCalledTimes(1);
    expect(h.deps.runDrain).not.toHaveBeenCalled();
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
  });

  /**
   * `queue.resume` only moves `paused` items back to `queued` — an `uncertain`
   * item is untouched by it. Clicking Resume ON that item and then hearing
   * nothing reads as "it will run now", which is the A29 conflation: the
   * session was released, this item was not, and only Retry moves it.
   */
  it('tells an uncertain item that the session resumed but it did not', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'uncertain' }));
    await h.click(FOLLOWUP_RESUME_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.resume).toHaveBeenCalledWith(SESSION_KEY);
    expect(lastEphemeral(h.responses)).toBe(
      '세션은 재개했지만 이 항목은 실행 여부 확인이 필요합니다 — Retry로 다시 실행하세요.',
    );
  });

  it('stays silent when the resumed item was merely paused', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'paused' }));
    await h.click(FOLLOWUP_RESUME_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.responses).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Retry
 * ------------------------------------------------------------------ */

describe('retry', () => {
  it('denies a retry on a frozen session — Resume is the only release', async () => {
    const h = harness();
    h.queue.freezeReason.mockReturnValue('stop');
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed' }));
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.retry).not.toHaveBeenCalled();
    expect(h.queue.resume).not.toHaveBeenCalled();
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
    const text = expectRefusal(h.responses);
    expect(text.toLowerCase()).toContain('resume');
  });

  it('denies a retry the interrupt policy rejects', async () => {
    const h = harness({ canInterrupt: vi.fn(async () => false) });
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed' }));
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.retry).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('refuses a retry while a question is already pending on the session', async () => {
    const h = harness({
      getSessionByKey: vi.fn(() => session({ actionPanel: { waitingForChoice: true } })),
    });
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed' }));
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.retry).not.toHaveBeenCalled();
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
    expect(h.deps.runDrain).not.toHaveBeenCalled();
    const text = expectRefusal(h.responses);
    expect(text.toLowerCase()).toMatch(/question|pending/);
  });

  it('refuses a retry when the ASK appears while the authorization await is in flight', async () => {
    const h = harness();
    (h.deps.getSessionByKey as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(session())
      .mockReturnValueOnce(session({ actionPanel: { waitingForChoice: true } }));
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed' }));
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.retry).not.toHaveBeenCalled();
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
    expect(h.deps.runDrain).not.toHaveBeenCalled();
    const text = expectRefusal(h.responses);
    expect(text.toLowerCase()).toMatch(/question|pending/);
  });

  it('refuses a retry when the session disappears while the authorization await is in flight', async () => {
    const h = harness();
    (h.deps.getSessionByKey as ReturnType<typeof vi.fn>).mockReturnValueOnce(session()).mockReturnValueOnce(undefined);
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed' }));
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.queue.retry).not.toHaveBeenCalled();
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
    expect(h.deps.runDrain).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('requeues, clears the halt and drains', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'uncertain', epoch: 2 }));
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue({ epoch: 2 })));
    await tick();
    expect(h.queue.retry).toHaveBeenCalledWith(SESSION_KEY, `${SESSION_KEY}#1`, 2);
    expect(h.dispatcher.clearDrainHalt).toHaveBeenCalledWith(SESSION_KEY, 'retry');
    expect(h.deps.runDrain).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('renders a capacity refusal explicitly and keeps the failed item', async () => {
    // `failed` is terminal, so a retry re-enters the pending budget and a full
    // queue can refuse it (U1). The user must be told WHY, not just "no".
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed' }));
    h.queue.retry.mockReturnValue({ ok: false, reason: 'capacity' } as never);
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue()));
    await tick();
    const text = expectRefusal(h.responses);
    expect(text.toLowerCase()).toContain('capacity');
    expect(text).toContain('failed');
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
    expect(h.deps.runDrain).not.toHaveBeenCalled();
  });

  it('names the anomaly when capacity refuses an uncertain item that already holds a slot', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'uncertain' }));
    h.queue.retry.mockReturnValue({ ok: false, reason: 'capacity' } as never);
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue()));
    await tick();
    const text = expectRefusal(h.responses);
    expect(text.toLowerCase()).toContain('capacity');
    expect(text.toLowerCase()).toContain('pending slot');
  });

  it('refuses an unknown queue rejection code instead of falling through', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed' }));
    h.queue.retry.mockReturnValue({ ok: false, reason: 'some-future-code' } as never);
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue()));
    await tick();
    const text = expectRefusal(h.responses);
    expect(text).toContain('some-future-code');
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
  });

  it('surfaces a queue-level refusal instead of retrying blindly', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed' }));
    h.queue.retry.mockReturnValue({ ok: false, reason: 'invalid-state' } as never);
    await h.click(FOLLOWUP_RETRY_ACTION_ID, clickBody(itemValue()));
    await tick();
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
    expect(h.deps.runDrain).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });
});

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

describe('pagination', () => {
  it('is read-only: refreshes the requested page and mutates nothing', async () => {
    const h = harness();
    await h.click(
      FOLLOWUP_PAGE_NEXT_ACTION_ID,
      clickBody(encodeFollowupPageActionValue({ sessionKey: SESSION_KEY, page: 3 })),
    );
    await tick();
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY, 3);
    expect(h.queue.resume).not.toHaveBeenCalled();
    expect(h.queue.retry).not.toHaveBeenCalled();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
    expect(h.responses).toHaveLength(0);
  });

  it('applies the same thread ACL as the item controls', async () => {
    const h = harness();
    await h.click(
      FOLLOWUP_PAGE_NEXT_ACTION_ID,
      clickBody(encodeFollowupPageActionValue({ sessionKey: SESSION_KEY, page: 2 }), {
        channel: { id: 'C-ATTACKER' },
        container: { channel_id: 'C-ATTACKER', message_ts: SURFACE_TS, thread_ts: THREAD },
      }),
    );
    await tick();
    expect(h.deps.refresh).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('rejects a non-integer page', async () => {
    const h = harness();
    await h.click(FOLLOWUP_PAGE_NEXT_ACTION_ID, clickBody(`{"sessionKey":"${SESSION_KEY}","page":1.5}`));
    await tick();
    expect(h.deps.refresh).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });
});

/* ------------------------------------------------------------------ *
 * Overflow menu — one control, four ops
 * ------------------------------------------------------------------ */

describe('item overflow menu', () => {
  it('acks before the work, like every other listener', async () => {
    const h = harness({ canInterrupt: vi.fn(() => new Promise<boolean>(() => {})) });
    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel')));
    await tick();
    expect(h.order[0]).toBe('ack');
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
  });

  it('routes send_now into the dispatcher transaction, turn epoch and all', async () => {
    const h = harness();
    await h.click(MENU_ACTION_ID, menuBody(menuValue('send_now', { turnEpoch: 0 })));
    await tick();
    expect(h.dispatcher.sendNow).toHaveBeenCalledWith(SESSION_KEY, `${SESSION_KEY}#1`, 0, CLICKER, 0);
  });

  it('routes send_now through the SAME turn-epoch fence as the button', async () => {
    const h = harness();
    await h.click(MENU_ACTION_ID, menuBody(menuValue('send_now')));
    await tick();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('routes retry into the retry flow (halt cleared, drain reopened)', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed', epoch: 2 }));
    await h.click(MENU_ACTION_ID, menuBody(menuValue('retry', { epoch: 2 })));
    await tick();
    expect(h.queue.retry).toHaveBeenCalledWith(SESSION_KEY, `${SESSION_KEY}#1`, 2);
    expect(h.dispatcher.clearDrainHalt).toHaveBeenCalledWith(SESSION_KEY, 'retry');
    expect(h.deps.runDrain).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('keeps the retry pendingApproval gate when the op arrives through the menu', async () => {
    const h = harness({
      getSessionByKey: vi.fn(() => session({ actionPanel: { waitingForChoice: true } })),
    });
    h.queue.get.mockReturnValue(queuedItem({ state: 'failed' }));
    await h.click(MENU_ACTION_ID, menuBody(menuValue('retry')));
    await tick();
    expect(h.queue.retry).not.toHaveBeenCalled();
    const text = expectRefusal(h.responses);
    expect(text.toLowerCase()).toMatch(/question|pending/);
  });

  it('routes resume into the resume flow', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'paused' }));
    await h.click(MENU_ACTION_ID, menuBody(menuValue('resume')));
    await tick();
    expect(h.queue.resume).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.dispatcher.clearDrainHalt).toHaveBeenCalledWith(SESSION_KEY, 'resume');
    expect(h.deps.runDrain).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('applies the thread ACL to a menu click too', async () => {
    const h = harness();
    await h.click(
      MENU_ACTION_ID,
      menuBody(menuValue('cancel'), {
        channel: { id: 'C-ATTACKER' },
        container: { channel_id: 'C-ATTACKER', message_ts: SURFACE_TS, thread_ts: THREAD },
      }),
    );
    await tick();
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
    lastEphemeral(h.responses);
  });

  it('refuses an unreadable menu payload without touching the queue', async () => {
    const h = harness();
    await h.click(MENU_ACTION_ID, menuBody('not-json'));
    await tick();
    expect(h.deps.getSessionByKey).not.toHaveBeenCalled();
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
    expectRefusal(h.responses);
  });

  it('refuses an operation it does not implement instead of guessing', async () => {
    const h = harness();
    await h.click(MENU_ACTION_ID, menuBody(menuValue('delete_everything')));
    await tick();
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
    expect(h.dispatcher.sendNow).not.toHaveBeenCalled();
    expect(h.queue.retry).not.toHaveBeenCalled();
    expect(h.queue.resume).not.toHaveBeenCalled();
    lastEphemeral(h.responses);
  });
});

/* ------------------------------------------------------------------ *
 * Cancel
 * ------------------------------------------------------------------ */

describe('cancel', () => {
  it('cancels with the clicker recorded as the reason, then repaints — and never drains', async () => {
    const h = harness();
    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel')));
    await tick();
    expect(h.queue.cancelItem).toHaveBeenCalledWith(
      SESSION_KEY,
      `${SESSION_KEY}#1`,
      0,
      `<@${CLICKER}> 님이 취소했습니다`,
    );
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.deps.runDrain).not.toHaveBeenCalled();
    expect(h.dispatcher.clearDrainHalt).not.toHaveBeenCalled();
    expect(h.order.indexOf('cancelItem')).toBeLessThan(h.order.indexOf('refresh'));
  });

  it('confirms a successful cancel ephemerally instead of answering only with a repaint', async () => {
    // The panel repaint is not a receipt: from an overflow menu the clicker
    // cannot tell "cancelled" from "the click never arrived", and every refusal
    // branch in this handler already speaks. Success must too.
    const h = harness();
    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel')));
    await tick();
    const text = lastEphemeral(h.responses);
    expect(text).toContain('취소했습니다');
    expect(text).toContain('기록으로 남습니다');
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('denies a clicker the interrupt policy rejects and keeps the item', async () => {
    const h = harness({ canInterrupt: vi.fn(async () => false) });
    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel')));
    await tick();
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
    const text = lastEphemeral(h.responses);
    expect(text).toContain('권한');
  });

  it('refuses to cancel a running item and points at the stop button', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'dispatched' }));
    h.queue.cancelItem.mockReturnValue({ ok: false, reason: 'invalid-state' } as never);
    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel')));
    await tick();
    const text = lastEphemeral(h.responses);
    expect(text).toContain('실행 중인 항목은 취소할 수 없습니다');
    expect(text).toContain('중지');
  });

  it('answers a stale generation with a repaint instead of cancelling the newer item', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ epoch: 4 }));
    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel', { epoch: 0 })));
    await tick();
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
    expect(lastEphemeral(h.responses)).toContain('이미 바뀐 항목입니다');
  });

  it('answers an item that is no longer in the queue with a repaint', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(undefined);
    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel')));
    await tick();
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
    lastEphemeral(h.responses);
  });

  it('reports a stale-epoch lost at the queue itself as a repaint too', async () => {
    const h = harness();
    h.queue.cancelItem.mockReturnValue({ ok: false, reason: 'stale-epoch' } as never);
    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel')));
    await tick();
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
    expect(lastEphemeral(h.responses)).toContain('이미 바뀐 항목입니다');
  });
});

/*
 * Cancel of a STEERED item (06 §3.4). The message is already sitting in the
 * SDK's own input queue, so `cancelItem` would only rewrite our row while the
 * model still reads it — the queue answers `invalid-state` there on purpose.
 * The only honest cancel goes through the host, which asks the SDK first.
 */
describe('cancel — steered item', () => {
  const steeredItem = () => queuedItem({ state: 'steered', epoch: 1, steerUuid: 'uuid-1' });

  it('routes a steered item through deps.cancelSteered instead of queue.cancelItem', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(steeredItem());

    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel', { epoch: 1 })));
    await tick();

    expect(h.cancelSteered).toHaveBeenCalledWith(SESSION_KEY, `${SESSION_KEY}#1`, 1, 'uuid-1');
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('tells the user it was withdrawn before the model saw it', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(steeredItem());

    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel', { epoch: 1 })));
    await tick();

    expect(lastEphemeral(h.responses)).toBe('취소했습니다 — 모델에 전달되기 전에 회수했습니다.');
  });

  it('says the message is already running when the SDK had dequeued it', async () => {
    const h = harness({ cancelSteered: vi.fn(async () => 'already-delivered' as const) });
    h.queue.get.mockReturnValue(steeredItem());

    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel', { epoch: 1 })));
    await tick();

    expect(lastEphemeral(h.responses)).toBe('취소하지 못했습니다 — 이미 모델에 전달되어 실행 중입니다.');
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
  });

  /**
   * The SDK could not be asked at all, so the item went back to `queued`. That
   * is neither a cancel nor a delivery: the user is told the truth AND that the
   * control still works.
   */
  it('says the item went back to the queue when delivery could not be determined', async () => {
    const h = harness({ cancelSteered: vi.fn(async () => 'returned-to-queue' as const) });
    h.queue.get.mockReturnValue(steeredItem());

    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel', { epoch: 1 })));
    await tick();

    expect(lastEphemeral(h.responses)).toBe(
      '취소하지 못했습니다 — 전달 여부를 확인할 수 없어 큐로 되돌렸습니다. 다시 Cancel 할 수 있습니다.',
    );
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
  });

  it('falls back to the ordinary refusal wording when the cancel itself failed', async () => {
    const h = harness({ cancelSteered: vi.fn(async () => 'failed' as const) });
    h.queue.get.mockReturnValue(steeredItem());

    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel', { epoch: 1 })));
    await tick();

    const text = lastEphemeral(h.responses);
    expect(text).toContain('취소가 거부되었습니다');
    expect(text).toContain('failed');
  });

  it('never claims a cancel when the host hook throws', async () => {
    const h = harness({
      cancelSteered: vi.fn(async () => {
        throw new Error('sdk gone');
      }),
    });
    h.queue.get.mockReturnValue(steeredItem());

    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel', { epoch: 1 })));
    await tick();

    expect(h.queue.cancelItem).not.toHaveBeenCalled();
    expect(lastEphemeral(h.responses)).toMatch(/취소|could not/);
  });

  it('refuses a steered row that carries no uuid — nothing can address the SDK copy', async () => {
    const h = harness();
    h.queue.get.mockReturnValue(queuedItem({ state: 'steered', epoch: 1, steerUuid: undefined }));

    await h.click(MENU_ACTION_ID, menuBody(menuValue('cancel', { epoch: 1 })));
    await tick();

    expect(h.cancelSteered).not.toHaveBeenCalled();
    expect(h.queue.cancelItem).not.toHaveBeenCalled();
    expect(lastEphemeral(h.responses)).toContain('취소');
  });
});

/* ------------------------------------------------------------------ *
 * Steer artifacts — `Send now` is the one path that takes an item out of
 * `steered` without the host ever seeing a uuid.
 * ------------------------------------------------------------------ */

describe('Send now — steer artifacts', () => {
  it('tells the host the item may have left `steered`, so it can drop what it held', async () => {
    const onItemLeftSteer = vi.fn();
    const h = harness({ onItemLeftSteer });

    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick();

    expect(onItemLeftSteer).toHaveBeenCalledWith(SESSION_KEY, `${SESSION_KEY}#1`);
  });

  it('never fails the click when the host hook throws', async () => {
    const h = harness({
      onItemLeftSteer: vi.fn(() => {
        throw new Error('map gone');
      }),
    });

    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick();

    expect(h.dispatcher.sendNow).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Detached failures
 * ------------------------------------------------------------------ */

describe('detached failures', () => {
  it('catches a late dispatcher rejection and tells the user', async () => {
    const h = harness();
    h.dispatcher.sendNow.mockRejectedValue(new Error('boom'));
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick();
    expect(h.deps.reportError).toHaveBeenCalledTimes(1);
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
    expectRefusal(h.responses);
  });

  it('catches a drain failure after the run settled and still refreshes', async () => {
    const h = harness();
    h.dispatcher.sendNow.mockResolvedValue({
      status: 'dispatched',
      run: {
        runId: 1,
        turnEpoch: 1,
        itemId: `${SESSION_KEY}#1`,
        settled: Promise.resolve({
          sessionKey: SESSION_KEY,
          runId: 1,
          turnEpoch: 1,
          kind: 'send-now',
          itemId: `${SESSION_KEY}#1`,
          outcome: { result: 'safe' },
          itemDisposition: 'resolved',
          canDrain: true,
        }),
      },
    } as SendNowResult);
    (h.deps.runDrain as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('drain exploded'));
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick(5);
    expect(h.deps.reportError).toHaveBeenCalled();
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
    // The message already sent before `runDrain` blew up — the follow-through
    // failure must not claim nothing was dispatched or that the item stayed
    // in the queue (that would invert a completed send into a non-send).
    const last = h.responses[h.responses.length - 1];
    const text = String(last.text).toLowerCase();
    expect(text).not.toMatch(/nothing was dispatched/);
    expect(text).not.toMatch(/stays in the queue/);
  });

  it('does not drain a run that did not end safely', async () => {
    const h = harness();
    h.dispatcher.sendNow.mockResolvedValue({
      status: 'dispatched',
      run: {
        runId: 1,
        turnEpoch: 1,
        itemId: `${SESSION_KEY}#1`,
        settled: Promise.resolve({
          sessionKey: SESSION_KEY,
          runId: 1,
          turnEpoch: 1,
          kind: 'send-now',
          itemId: `${SESSION_KEY}#1`,
          outcome: { result: 'blocked', reason: 'permission' },
          itemDisposition: 'none',
          canDrain: false,
        }),
      },
    } as SendNowResult);
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick(5);
    expect(h.deps.runDrain).not.toHaveBeenCalled();
    expect(h.deps.refresh).toHaveBeenCalledWith(SESSION_KEY);
  });

  /**
   * The drain is gated on `canDrain`, and the sweep must NOT be: a turn that
   * ended aborted / blocked / parked on a question is exactly the turn whose
   * steered rows got no settlement frame, and `runDrain` — the only other thing
   * on this path that sweeps — is the branch that just did not run. Without an
   * unconditional sweep those rows sit `steered` until some later message
   * happens to start a turn.
   */
  it('sweeps steered rows even when the interrupted turn did not end safely', async () => {
    const h = harness();
    h.dispatcher.sendNow.mockResolvedValue({
      status: 'dispatched',
      run: {
        runId: 1,
        turnEpoch: 1,
        itemId: `${SESSION_KEY}#1`,
        settled: Promise.resolve({
          sessionKey: SESSION_KEY,
          runId: 1,
          turnEpoch: 1,
          kind: 'send-now',
          itemId: `${SESSION_KEY}#1`,
          outcome: { result: 'blocked', reason: 'permission' },
          itemDisposition: 'none',
          canDrain: false,
        }),
      },
    } as SendNowResult);
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick(5);
    expect(h.deps.sweepSteered).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.deps.runDrain).not.toHaveBeenCalled();
  });

  /**
   * Order is load-bearing the other way too: the drain claims `queued` rows, so
   * a row the sweep has not returned yet is invisible to the loop that follows.
   * Sweeping after the drain would delay it by a whole turn.
   */
  it('sweeps before the drain it gates on a safe outcome', async () => {
    const h = harness();
    h.dispatcher.sendNow.mockResolvedValue({
      status: 'dispatched',
      run: {
        runId: 1,
        turnEpoch: 1,
        itemId: `${SESSION_KEY}#1`,
        settled: Promise.resolve({
          sessionKey: SESSION_KEY,
          runId: 1,
          turnEpoch: 1,
          kind: 'send-now',
          itemId: `${SESSION_KEY}#1`,
          outcome: { result: 'safe' },
          itemDisposition: 'resolved',
          canDrain: true,
        }),
      },
    } as SendNowResult);
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick(5);
    expect(h.order.indexOf('sweepSteered')).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf('sweepSteered')).toBeLessThan(h.order.indexOf('runDrain'));
  });

  /**
   * A host sweep that throws is a bookkeeping failure, not the user's answer:
   * the message was already delivered, so it is reported and the follow-through
   * carries on into the drain it would otherwise have skipped.
   */
  it('reports a throwing sweep without failing the follow-through', async () => {
    const h = harness();
    (h.deps.sweepSteered as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('sweep exploded'));
    h.dispatcher.sendNow.mockResolvedValue({
      status: 'dispatched',
      run: {
        runId: 1,
        turnEpoch: 1,
        itemId: `${SESSION_KEY}#1`,
        settled: Promise.resolve({
          sessionKey: SESSION_KEY,
          runId: 1,
          turnEpoch: 1,
          kind: 'send-now',
          itemId: `${SESSION_KEY}#1`,
          outcome: { result: 'safe' },
          itemDisposition: 'resolved',
          canDrain: true,
        }),
      },
    } as SendNowResult);
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick(5);
    expect(h.deps.reportError).toHaveBeenCalled();
    expect(h.deps.runDrain).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('reports a dispatcher rejection as a retention, not a send', async () => {
    const h = harness();
    h.dispatcher.sendNow.mockResolvedValue({
      status: 'rejected',
      reason: 'stale-turn-epoch',
      detail: 'control rendered at turn 0, session is at 3',
    });
    await h.click(FOLLOWUP_SEND_NOW_ACTION_ID, clickBody(itemValue({ turnEpoch: 0 })));
    await tick();
    const text = expectRefusal(h.responses);
    expect(text).toContain('stale-turn-epoch');
    expect(h.deps.runDrain).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Against the real queue + dispatcher
 * ------------------------------------------------------------------ */

describe('against the real queue and dispatcher', () => {
  function realHarness() {
    const queue = new FollowupQueue();
    const requests: DispatchRequest[] = [];
    const dispatcherDeps: FollowupDispatcherDeps = {
      queue,
      dispatch: async (request) => {
        requests.push(request);
        return { result: 'safe' };
      },
      interrupt: () => {},
      authorizeInterrupt: () => ({ allowed: true }),
      authorizeDispatch: () => ({ allowed: true }),
    };
    const dispatcher = new FollowupDispatcher(dispatcherDeps);
    const routes = new Map<string, Listener>();
    const app = {
      action(id: string, listener: Listener) {
        routes.set(id, listener);
      },
    } as unknown as App;
    const respond = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => {});
    const runDrain = vi.fn(async () => {});
    registerFollowupActions(app, {
      queue,
      dispatcher,
      cancelSteered: async () => 'failed',
      getSessionByKey: () => session(),
      canInterrupt: () => true,
      refresh,
      runDrain,
    });
    async function click(actionId: string, body: Record<string, unknown>): Promise<void> {
      const listener = routes.get(actionId);
      if (!listener) throw new Error(`no listener registered for ${actionId}`);
      await listener({ ack: async () => {}, body, respond });
    }
    return { queue, dispatcher, requests, respond, refresh, runDrain, click };
  }

  it('accepts the shipped FollowupQueue and FollowupDispatcher as its injected ports', () => {
    // A COMPILE-TIME assertion with a runtime witness: `deps` is annotated, so
    // any drift between the real classes and the declared ports (e.g. `sendNow`
    // making `expectedTurnEpoch` required) fails the type gate here rather than
    // at the host wiring site.
    const queue = new FollowupQueue();
    const dispatcher = new FollowupDispatcher({
      queue,
      dispatch: async () => ({ result: 'safe' }),
      interrupt: () => {},
      authorizeInterrupt: () => ({ allowed: true }),
      authorizeDispatch: () => ({ allowed: true }),
    });
    const deps: FollowupActionsDeps = {
      queue,
      dispatcher,
      cancelSteered: async () => 'failed',
      getSessionByKey: () => session(),
      canInterrupt: () => true,
      refresh: () => {},
      runDrain: () => {},
    };
    expect(deps.queue).toBe(queue);
    expect(deps.dispatcher).toBe(dispatcher);
    expect(typeof deps.dispatcher.sendNow).toBe('function');
    expect(deps.dispatcher.isBusy(SESSION_KEY)).toBe(false);
  });

  it('passes the ORIGINAL author through and the clicker only as requestedBy', async () => {
    const h = realHarness();
    const enqueued = h.queue.enqueue(SESSION_KEY, {
      user: AUTHOR,
      channel: CHANNEL,
      ts: '1700.000100',
      text: '배포 상태 알려줘',
    });
    if (enqueued.status !== 'queued') throw new Error(`enqueue failed: ${enqueued.status}`);

    await h.click(
      FOLLOWUP_SEND_NOW_ACTION_ID,
      clickBody(itemValue({ itemId: enqueued.item.id, epoch: enqueued.item.epoch, turnEpoch: 0 })),
    );
    await tick(6);

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].message.user).toBe(AUTHOR);
    expect(h.requests[0].message.text).toBe('배포 상태 알려줘');
    expect(h.requests[0].requestedBy).toBe(CLICKER);
    expect(h.requests[0].kind).toBe('send-now');
    expect(h.runDrain).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.refresh).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('refuses a Send now minted in an older turn generation', async () => {
    const h = realHarness();
    const enqueued = h.queue.enqueue(SESSION_KEY, {
      user: AUTHOR,
      channel: CHANNEL,
      ts: '1700.000100',
      text: 'stale click',
    });
    if (enqueued.status !== 'queued') throw new Error(`enqueue failed: ${enqueued.status}`);
    h.queue.beginTurn(SESSION_KEY);
    h.queue.beginTurn(SESSION_KEY);

    await h.click(
      FOLLOWUP_SEND_NOW_ACTION_ID,
      clickBody(itemValue({ itemId: enqueued.item.id, epoch: enqueued.item.epoch, turnEpoch: 0 })),
    );
    await tick(6);

    expect(h.requests).toHaveLength(0);
    expect(h.queue.get(SESSION_KEY, enqueued.item.id)?.state).toBe('queued');
    expect(h.respond).toHaveBeenCalled();
  });

  it('retry on the real queue moves a failed item back to queued', async () => {
    const h = realHarness();
    const enqueued = h.queue.enqueue(SESSION_KEY, {
      user: AUTHOR,
      channel: CHANNEL,
      ts: '1700.000100',
      text: 'retry me',
    });
    if (enqueued.status !== 'queued') throw new Error(`enqueue failed: ${enqueued.status}`);
    const claimed = h.queue.claimNext(SESSION_KEY);
    if (!claimed.ok) throw new Error('claim failed');
    // `claimed` has no direct exit to `failed` (05 §5) — a real failure happens
    // after dispatch, so the fixture walks that edge.
    const dispatched = h.queue.markDispatched(SESSION_KEY, claimed.item.id, claimed.item.epoch);
    if (!dispatched.ok) throw new Error('markDispatched failed');
    const settled = h.queue.settle(SESSION_KEY, dispatched.item.id, dispatched.item.epoch, 'failed', 'boom');
    if (!settled.ok) throw new Error('settle failed');

    await h.click(
      FOLLOWUP_RETRY_ACTION_ID,
      clickBody(itemValue({ itemId: settled.item.id, epoch: settled.item.epoch })),
    );
    await tick(4);

    expect(h.queue.get(SESSION_KEY, settled.item.id)?.state).toBe('queued');
    expect(h.runDrain).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('cancel on the real queue moves a queued item to cancelled and repaints', async () => {
    const h = realHarness();
    const enqueued = h.queue.enqueue(SESSION_KEY, {
      user: AUTHOR,
      channel: CHANNEL,
      ts: '1700.000100',
      text: 'cancel me',
    });
    if (enqueued.status !== 'queued') throw new Error(`enqueue failed: ${enqueued.status}`);

    await h.click(
      MENU_ACTION_ID,
      menuBody(menuValue('cancel', { itemId: enqueued.item.id, epoch: enqueued.item.epoch })),
    );
    await tick(4);

    expect(h.queue.get(SESSION_KEY, enqueued.item.id)?.state).toBe('cancelled');
    expect(h.refresh).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.runDrain).not.toHaveBeenCalled();
  });

  it('cancel on the real queue leaves a dispatched item exactly where it is', async () => {
    const h = realHarness();
    const enqueued = h.queue.enqueue(SESSION_KEY, {
      user: AUTHOR,
      channel: CHANNEL,
      ts: '1700.000100',
      text: 'already running',
    });
    if (enqueued.status !== 'queued') throw new Error(`enqueue failed: ${enqueued.status}`);
    const claimed = h.queue.claimNext(SESSION_KEY);
    if (!claimed.ok) throw new Error('claim failed');
    const dispatched = h.queue.markDispatched(SESSION_KEY, claimed.item.id, claimed.item.epoch);
    if (!dispatched.ok) throw new Error('markDispatched failed');

    await h.click(
      MENU_ACTION_ID,
      menuBody(menuValue('cancel', { itemId: dispatched.item.id, epoch: dispatched.item.epoch })),
    );
    await tick(4);

    expect(h.queue.get(SESSION_KEY, dispatched.item.id)?.state).toBe('dispatched');
    expect(h.respond).toHaveBeenCalled();
  });
});

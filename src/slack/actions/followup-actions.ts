import type { App } from '@slack/bolt';
import type { SendNowResult } from '@soma/slack/followup-dispatcher';
import type { FollowupItem, FollowupItemState, FollowupOpResult } from '@soma/slack/followup-queue';
import {
  FOLLOWUP_ITEM_MENU_ACTION_ID,
  FOLLOWUP_PAGE_NEXT_ACTION_ID,
  FOLLOWUP_PAGE_PREV_ACTION_ID,
  FOLLOWUP_RESUME_ACTION_ID,
  FOLLOWUP_RETRY_ACTION_ID,
  FOLLOWUP_SEND_NOW_ACTION_ID,
  type FollowupItemActionValue,
  parseFollowupItemActionValue,
  parseFollowupMenuValue,
  parseFollowupPageActionValue,
} from '@soma/slack/followup-queue-blocks';
import { Logger } from '../../logger';

/**
 * Follow-up queue action handlers — U7 of `.prd/slack-agent-ui`
 * (`loop.md:45`: single winner, stale-epoch reject, click-time `canInterrupt`
 * plus dispatch-time authorization; A12/A13/A29/A30).
 *
 * This module is the TRUST BOUNDARY between a Slack button click and the queue.
 * Everything it needs is injected (`FollowupActionsDeps`) — it owns no queue, no
 * session registry, no Slack client, and it starts no drain loop of its own. The
 * host wires it once with `registerFollowupActions(app, deps)`.
 *
 * Three rules shape every handler in here:
 *
 * 1. **Ack first, then work.** Slack kills an unacked interaction after 3s
 *    (docs/misc/reference/slack-block-kit.md, https://docs.slack.dev/interactivity/handling-user-interaction).
 *    Authorization and dispatch are unbounded (a `Send now` waits for the
 *    interrupted turn's FULL teardown), so the listener acks and hands the rest
 *    to a DETACHED job. That job must therefore catch its own failures and say
 *    so through `respond` — a rejection that only reaches the log is, from the
 *    user's seat, indistinguishable from success.
 *
 * 2. **The payload is coordinates, never identity.** A button `value` carries
 *    `{sessionKey,itemId,epoch}` (+`turnEpoch` on `Send now`) and nothing else
 *    (`followup-queue-blocks.ts:113-126`). Anyone who can see a button can forge
 *    one, so every click is re-derived from server state: the session must
 *    exist, the click's channel must BE the session's channel, and the clicked
 *    message must sit in the session's thread. A body that cannot prove its
 *    thread is refused rather than trusted. The clicker is an authorization
 *    subject only — no queue field is ever rewritten with the clicker's values
 *    (A30), which is why the dispatcher replays `item.message` verbatim.
 *
 * 3. **A refusal says "rejected" and "retained", never something
 *    success-shaped** (A13/A29). A denied item keeps its place in the queue; a
 *    frozen session stays frozen until an explicit Resume. The two are never
 *    collapsed into one sentence.
 *
 * Out of scope on purpose: rendering (U3 owns the blocks), the drain loop (the
 * host owns `runDrain`), and freeze/resume policy beyond calling the queue.
 *
 * The per-item controls now arrive through ONE overflow menu
 * (`FOLLOWUP_ITEM_MENU_ACTION_ID`) whose selected option carries an extra `op`
 * alongside the same coordinates. The menu is a TRANSPORT, not a second policy:
 * `send_now`/`retry`/`resume` are routed into the very handlers the buttons use
 * (same verification, same authorization, same drain rules), and `cancel` is the
 * only op with no button equivalent.
 */

const logger = new Logger('FollowupActions');

/** Ephemeral, in-thread, never a new post — a click can never speak to a channel. */
const EPHEMERAL = { response_type: 'ephemeral', replace_original: false } as const;

export type FollowupRespond = (message: Record<string, unknown>) => Promise<unknown>;

/**
 * The queue slice this module touches. Structural on purpose: the real
 * `FollowupQueue` satisfies it as-is, and a test can pass either.
 */
export interface FollowupActionsQueuePort {
  get(sessionKey: string, itemId: string): FollowupItem | undefined;
  /** The only exit from `paused` (A17). Clears the session freeze too. */
  resume(sessionKey: string): void;
  retry(sessionKey: string, itemId: string, expectedEpoch: number): FollowupOpResult;
  /**
   * Explicit, user-initiated cancellation of ONE item. Allowed from the states
   * where nothing is running (`queued`/`paused`/`failed`/`uncertain`); anything
   * in flight is `invalid-state`, because stopping a RUNNING turn is the stop
   * control's job and not a queue edit. `reason` is recorded on the item so the
   * panel can say who cancelled it.
   */
  cancelItem(sessionKey: string, itemId: string, expectedEpoch: number, reason?: string): FollowupOpResult;
  freezeReason(sessionKey: string): string | undefined;
}

/** The dispatcher slice this module touches; `FollowupDispatcher` satisfies it. */
export interface FollowupActionsDispatcherPort {
  /**
   * Owns the whole `Send now` transaction INCLUDING both authorization checks
   * (`authorizeInterrupt` at click time, `authorizeDispatch` on the ORIGINAL
   * author). This module therefore does not run its own `canInterrupt` here —
   * a second, differently-shaped check would be a second policy.
   *
   * `expectedTurnEpoch` is REQUIRED, matching
   * `packages/slack/src/followup-dispatcher.ts:436-441`. Making it optional here
   * would let a caller omit the one fence that stops a control minted in an
   * earlier generation from steering the current turn (A12/A28).
   */
  sendNow(
    sessionKey: string,
    itemId: string,
    expectedEpoch: number,
    requestedBy: string,
    expectedTurnEpoch: number,
  ): Promise<SendNowResult>;
  clearDrainHalt(sessionKey: string, trigger: 'resume' | 'retry'): void;
  isBusy(sessionKey: string): boolean;
}

/**
 * The session facts a click is verified against. `ConversationSession`
 * (`src/types.ts:321`) is assignable as-is.
 */
export interface FollowupActionSession {
  channelId: string;
  threadTs?: string;
  /** Bot-initiated threads anchor on the root message instead (`src/types.ts:451`). */
  threadRootTs?: string;
  actionPanel?: {
    waitingForChoice?: boolean;
    pendingChoice?: unknown;
  };
}

/**
 * What a cancel of a `steered` item could do (06 §3.4). Four outcomes, four
 * different truths: the SDK withdrew the message, the SDK had already handed it
 * to the model, the SDK could not be asked at all — so the item went back to the
 * queue and the control still works — or the cancel could not be carried out.
 * They are never collapsed: "이미 전달됨" is not a failure, "실패" is not a
 * cancellation, and neither of them is "we do not know".
 */
export type CancelSteeredOutcome = 'cancelled' | 'already-delivered' | 'returned-to-queue' | 'failed';

export interface FollowupActionsDeps {
  queue: FollowupActionsQueuePort;
  dispatcher: FollowupActionsDispatcherPort;
  /**
   * Cancel a STEERED item through the SDK, then record it. Required, not
   * optional: without it a steered cancel would silently fall back to
   * `queue.cancelItem`, which answers `invalid-state` — the user would read
   * "cannot cancel" for the one state that actually has a cancel path.
   *
   * The host implements it as `cancel_async_message(uuid)` first, queue write
   * second; this module never touches the SDK itself.
   */
  cancelSteered(
    sessionKey: string,
    itemId: string,
    expectedEpoch: number,
    steerUuid: string,
  ): Promise<CancelSteeredOutcome>;
  /** Server-side session lookup. `undefined` = the click is refused outright. */
  getSessionByKey(sessionKey: string): FollowupActionSession | undefined;
  /**
   * The host's existing interrupt policy (owner / current initiator). Used for
   * Resume and Retry, which have no dispatcher transaction of their own. A
   * throw is a failure, not a yes — it propagates to the detached catch.
   */
  canInterrupt(sessionKey: string, clicker: string): boolean | Promise<boolean>;
  /** Re-render the queue surface. `page` is only passed by the pagination controls. */
  refresh(sessionKey: string, page?: number): void | Promise<void>;
  /** The HOST's drain loop. This module never re-enters the dispatcher itself. */
  runDrain(sessionKey: string): void | Promise<void>;
  /**
   * The host's end-of-turn sweep of rows still sitting in `steered` — the one
   * state whose exit depends on a receipt no one can produce once the turn is
   * over (`slack-handler.ts sweepSteerBucketsIfIdle`).
   *
   * Needed here because `runDrain` is gated on `canDrain` and the sweep must
   * NOT be. `canDrain` is false for exactly the turns that strand rows: an
   * interrupted turn that ended aborted, blocked, errored or parked on a
   * question got no settlement frame for anything pushed into it, and the drain
   * — the only other caller that sweeps — is the branch that just did not run.
   * Those rows would then be invisible to every later drain (`claimNext` takes
   * `queued` only) until some unrelated message happened to start a turn.
   *
   * Optional and best effort, like `onItemLeftSteer`: a host that does not
   * track steers wires nothing, and a throwing sweep is bookkeeping this module
   * reports — never a delivered message turned into a failed click.
   */
  sweepSteered?(sessionKey: string): void | Promise<void>;
  /**
   * `Send now` may have pulled the item out of `steered` (the dispatcher does it
   * inside its own transaction, `followup-dispatcher.ts:831-864`), and that is
   * the ONE exit from `steered` the host never sees a uuid for: no settlement
   * frame, no cancel hook. Told here so the host can release whatever it was
   * holding for that item's steer — temp files above all.
   *
   * Announced after the transaction, unconditionally — and it says "MAY have
   * left", nothing stronger. The dispatcher's unsteer is speculative: a refused
   * reserve or a failed interrupt puts the row back under the SAME uuid
   * (`followup-dispatcher.ts:896`), because the SDK is still holding the pushed
   * copy. So the host must re-read the item and release nothing while it is
   * `steered` under the uuid it was tracking; this module deliberately does not
   * make that call for it. Optional and best effort — a throwing hook must not
   * turn a delivered message into a failed click.
   */
  onItemLeftSteer?(sessionKey: string, itemId: string): void;
  /** Optional logger seam; falls back to this module's `Logger`. */
  reportError?(label: string, error: unknown): void;
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export function registerFollowupActions(app: App, deps: FollowupActionsDeps): void {
  app.action(FOLLOWUP_SEND_NOW_ACTION_ID, async ({ ack, body, respond }) => {
    await ack();
    const reply = respond as unknown as FollowupRespond;
    detach(deps, 'Send now', reply, () => handleSendNow(deps, body, reply));
  });

  app.action(FOLLOWUP_RESUME_ACTION_ID, async ({ ack, body, respond }) => {
    await ack();
    const reply = respond as unknown as FollowupRespond;
    detach(deps, 'Resume', reply, () => handleResume(deps, body, reply));
  });

  app.action(FOLLOWUP_RETRY_ACTION_ID, async ({ ack, body, respond }) => {
    await ack();
    const reply = respond as unknown as FollowupRespond;
    detach(deps, 'Retry', reply, () => handleRetry(deps, body, reply));
  });

  app.action(FOLLOWUP_ITEM_MENU_ACTION_ID, async ({ ack, body, respond }) => {
    await ack();
    const reply = respond as unknown as FollowupRespond;
    detach(deps, 'Queue menu', reply, () => handleMenu(deps, body, reply));
  });

  for (const actionId of [FOLLOWUP_PAGE_PREV_ACTION_ID, FOLLOWUP_PAGE_NEXT_ACTION_ID]) {
    app.action(actionId, async ({ ack, body, respond }) => {
      await ack();
      const reply = respond as unknown as FollowupRespond;
      detach(deps, 'Page change', reply, () => handlePage(deps, body, reply));
    });
  }
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

/**
 * The overflow menu router. It decides NOTHING except which existing handler
 * the click belongs to: routing `send_now`/`retry`/`resume` anywhere but into
 * the button handlers would fork the policy (the turn-epoch fence, the
 * pendingApproval gate, the freeze check) into a second, quietly divergent copy.
 *
 * An `op` this build does not implement is refused rather than defaulted — a
 * menu rendered by a newer process must not be reinterpreted as something this
 * one happens to support.
 */
async function handleMenu(deps: FollowupActionsDeps, body: unknown, respond: FollowupRespond): Promise<void> {
  const value = parseFollowupMenuValue(readMenuValue(body));
  if (!value) {
    await refuse(respond, 'Queue menu ignored: the menu payload could not be read. Refresh the queue and try again.');
    return;
  }
  // Widened to `string` on purpose: the switch must keep a reachable default
  // even when the parser's union covers today's ops exactly.
  const op: string = value.op;
  switch (op) {
    case 'send_now':
      await handleSendNow(deps, body, respond, value);
      return;
    case 'resume':
      await handleResume(deps, body, respond, value);
      return;
    case 'retry':
      await handleRetry(deps, body, respond, value);
      return;
    case 'cancel':
      await handleCancel(deps, body, respond, value);
      return;
    default:
      await refuse(respond, `Queue menu ignored: unsupported operation (${op}). Refresh the queue and try again.`);
  }
}

/**
 * `Send now` (§3.3). The dispatcher owns the transaction; this handler owns the
 * trust boundary in front of it and the follow-through behind it.
 *
 * `turnEpoch` is mandatory here and nowhere else: steering targets the LIVE
 * turn, so a control minted in an earlier generation must not be accepted
 * (`ssot.md:116-120`, A12/A28). It is re-checked inside the dispatcher against
 * the queue's persisted counter — the check below only rejects a payload that
 * could not be compared at all.
 */
async function handleSendNow(
  deps: FollowupActionsDeps,
  body: unknown,
  respond: FollowupRespond,
  preparsed?: FollowupItemActionValue,
): Promise<void> {
  const value = preparsed ?? parseFollowupItemActionValue(readActionValue(body));
  if (!value) {
    await refuse(respond, 'Send now ignored: the button payload could not be read. Refresh the queue and try again.');
    return;
  }
  if (value.turnEpoch === undefined || !Number.isSafeInteger(value.turnEpoch)) {
    await refuse(
      respond,
      'Send now rejected: the button carries no usable turn generation. The item stays in the queue — refresh and click again.',
    );
    return;
  }
  const click = verifyClick(deps, body, value.sessionKey);
  if (!click.ok) {
    await refuse(respond, `Send now rejected: ${click.detail}.`);
    return;
  }
  const item = verifyItem(deps, value);
  if (!item.ok) {
    await refuse(respond, `Send now rejected: ${item.detail}.`);
    return;
  }

  let result: SendNowResult;
  try {
    // The clicker travels as `requestedBy` ONLY. Author, text, files and
    // working directory all come from the stored item (A30).
    result = await deps.dispatcher.sendNow(value.sessionKey, value.itemId, value.epoch, click.clicker, value.turnEpoch);
  } finally {
    // Whatever the dispatcher decided, the item is no longer `steered` in the
    // shape the host remembered it — report it before the refresh so a repaint
    // failure cannot swallow the release.
    try {
      deps.onItemLeftSteer?.(value.sessionKey, value.itemId);
    } catch (error) {
      report(deps, 'Send now steer release', error);
    }
    // The item moved (reserved/dispatched) or it did not — either way the
    // surface is now out of date.
    await safeRefresh(deps, value.sessionKey);
  }

  if (result.status === 'rejected') {
    await refuse(respond, `Send now rejected (${result.reason}): ${result.detail}. The item stays in the queue.`);
    return;
  }

  const run = result.run;
  const sessionKey = value.sessionKey;
  // Its own detached job: the click must not sit on a whole turn, and this
  // continuation outlives the `respond` path's usefulness.
  detach(
    deps,
    'Send now follow-through',
    respond,
    async () => {
      try {
        // The sweep rides the turn's END, not its verdict: whatever this turn
        // did, no settlement frame can arrive for it any more. It therefore
        // runs in the `finally` of the settle — before, and independently of,
        // the `canDrain` gate below — because the drain claims `queued` rows
        // and a row the sweep has not returned yet is invisible to it.
        const settled = await run.settled.finally(() => sweepSteered(deps, sessionKey));
        // Only a `safe` outcome opens the next boundary — a blocked/failed turn
        // must not be followed by an automatic drain (A16).
        if (settled.canDrain) await deps.runDrain(sessionKey);
      } finally {
        await safeRefresh(deps, sessionKey);
      }
    },
    (error) =>
      `Send now follow-through could not finish (${errorText(error)}). Your message was already sent — check the queue state; nothing further was dispatched automatically.`,
  );
}

/**
 * Resume released the SESSION, but `queue.resume` only moves `paused` items
 * back to `queued` — an `uncertain` one is left exactly where it was (A17/R6).
 * Saying nothing would let the click read as "it will run now", which is the
 * A29 conflation: two different acts under one silence.
 */
const RESUME_UNCERTAIN_TEXT = '세션은 재개했지만 이 항목은 실행 여부 확인이 필요합니다 — Retry로 다시 실행하세요.';

/**
 * Resume (A17/A29). A freeze is released only by an explicit user act, and only
 * by someone the interrupt policy already trusts with this session.
 *
 * A live ASK/approval blocks the release: the session is parked ON THE USER, so
 * releasing the queue would race a drained follow-up against an unanswered
 * question. Nothing here retries or replays — `queue.resume` only moves `paused`
 * items back to `queued`, and the drain is the host's.
 */
async function handleResume(
  deps: FollowupActionsDeps,
  body: unknown,
  respond: FollowupRespond,
  preparsed?: FollowupItemActionValue,
): Promise<void> {
  const value = preparsed ?? parseFollowupItemActionValue(readActionValue(body));
  if (!value) {
    await refuse(respond, 'Resume ignored: the button payload could not be read. Refresh the queue and try again.');
    return;
  }
  const click = verifyClick(deps, body, value.sessionKey);
  if (!click.ok) {
    await refuse(respond, `Resume rejected: ${click.detail}.`);
    return;
  }

  const allowed = await deps.canInterrupt(value.sessionKey, click.clicker);
  if (!allowed) {
    await refuse(
      respond,
      'Resume rejected: you are not allowed to steer this session. The queue stays paused and the item remains where it is.',
    );
    return;
  }

  // Re-read AFTER the await: the authorization hop is unbounded, and the
  // session may have picked up a question in the meantime.
  const live = deps.getSessionByKey(value.sessionKey);
  if (!live) {
    await refuse(respond, 'Resume rejected: the session went away while the click was being checked.');
    return;
  }
  const blocking = pendingApproval(live);
  if (blocking) {
    await refuse(respond, `Resume rejected: ${blocking}. Answer it first — the queue stays paused.`);
    return;
  }

  const item = verifyItem(deps, value);
  if (!item.ok) {
    await refuse(respond, `Resume rejected: ${item.detail}.`);
    return;
  }

  // Read BEFORE the resume: the clicked item's state is what the answer below
  // is about, and a successful resume rewrites `paused` out from under us.
  const clickedState = item.item.state;
  try {
    deps.queue.resume(value.sessionKey);
    deps.dispatcher.clearDrainHalt(value.sessionKey, 'resume');
    // Never start a second turn on top of a live one; if something is running,
    // its own settle boundary will drive the next drain.
    if (!deps.dispatcher.isBusy(value.sessionKey)) await deps.runDrain(value.sessionKey);
  } finally {
    await safeRefresh(deps, value.sessionKey);
  }

  // The session is running again, but THIS item is not — `resume` never touches
  // `uncertain`, and only an explicit Retry may re-run a message whose effect is
  // unknown (§3.5/R6).
  if (clickedState === 'uncertain') await reply(respond, RESUME_UNCERTAIN_TEXT);
}

/**
 * Retry (§3.5/R6, A16). `failed` and `uncertain` NEVER auto-retry, so the click
 * itself is the consent. For an `uncertain` item the renderer attaches a confirm
 * dialog (`followup-queue-blocks.ts:257-268`), but Slack does not tell the
 * server that the dialog was accepted — the arrival of THIS action id is the
 * only evidence of an explicit, deliberate retry, and it is treated as such.
 *
 * A frozen session is refused instead of being silently un-frozen: a `queued`
 * item inside a frozen session renders exactly like a drainable one and can
 * never drain, which is the conflation A29 forbids.
 */
async function handleRetry(
  deps: FollowupActionsDeps,
  body: unknown,
  respond: FollowupRespond,
  preparsed?: FollowupItemActionValue,
): Promise<void> {
  const value = preparsed ?? parseFollowupItemActionValue(readActionValue(body));
  if (!value) {
    await refuse(respond, 'Retry ignored: the button payload could not be read. Refresh the queue and try again.');
    return;
  }
  const click = verifyClick(deps, body, value.sessionKey);
  if (!click.ok) {
    await refuse(respond, `Retry rejected: ${click.detail}.`);
    return;
  }

  const allowed = await deps.canInterrupt(value.sessionKey, click.clicker);
  if (!allowed) {
    await refuse(
      respond,
      'Retry rejected: you are not allowed to steer this session. The item remains exactly where it is.',
    );
    return;
  }

  // Re-read AFTER the await, same as Resume (`:271-282`): the authorization
  // hop is unbounded, and an outstanding ASK does not freeze the queue (the
  // only freeze call site is the abort path), so a silent requeue+drain here
  // would race a drained follow-up against an unanswered question.
  const live = deps.getSessionByKey(value.sessionKey);
  if (!live) {
    await refuse(respond, 'Retry rejected: the session went away while the click was being checked.');
    return;
  }
  const blocking = pendingApproval(live);
  if (blocking) {
    await refuse(respond, `Retry rejected: ${blocking}. Answer it first — the item stays in the queue.`);
    return;
  }

  const frozen = deps.queue.freezeReason(value.sessionKey);
  if (frozen) {
    await refuse(
      respond,
      `Retry rejected: the session is frozen (${frozen}). Resume the queue first — the item stays where it is.`,
    );
    return;
  }

  const item = verifyItem(deps, value);
  if (!item.ok) {
    await refuse(respond, `Retry rejected: ${item.detail}.`);
    return;
  }

  // Captured BEFORE the call: the refusal text depends on where the item was,
  // and a successful retry rewrites the state out from under us.
  const previousState = item.item.state;
  try {
    const result = deps.queue.retry(value.sessionKey, value.itemId, value.epoch);
    if (!result.ok) {
      await refuse(respond, retryRefusal(result.reason, previousState));
      return;
    }
    deps.dispatcher.clearDrainHalt(value.sessionKey, 'retry');
    // `runDrain` is the host's loop and is a no-op while a dispatch is in
    // flight; it decides the boundary, this handler only reopens it.
    await deps.runDrain(value.sessionKey);
  } finally {
    await safeRefresh(deps, value.sessionKey);
  }
}

/**
 * Why this is a lookup and NOT an exhaustive `switch` over `FollowupOpFailure`:
 * the queue's rejection set grows. U1 added `capacity` because `failed` is a
 * TERMINAL state — a retry pulls the item back into the pending budget, so a
 * full queue can refuse it — while an `uncertain` item already occupies a
 * pending slot and cannot add to that budget. A code this module has never seen
 * must still produce an honest refusal instead of falling through to silence.
 *
 * Every branch says the same two things: rejected, and the item was RETAINED
 * (A13/A29). None of them claims anything ran.
 */
function retryRefusal(reason: string, state: FollowupItemState): string {
  switch (reason) {
    case 'capacity':
      return state === 'uncertain'
        ? 'Retry rejected (capacity): the queue refused the requeue even though this item already holds a pending slot. It stays in the queue, untouched.'
        : `Retry rejected (capacity): the queue is full, and a ${state} item has to re-enter the pending budget to run again. It stays in the queue as ${state} — clear or cancel something first.`;
    case 'frozen':
      return 'Retry rejected (frozen): the session was frozen in the meantime. Resume the queue first — the item stays where it is.';
    case 'stale-epoch':
      return 'Retry rejected (stale-epoch): the item changed while the click was in flight. It stays in the queue — refresh and look again.';
    case 'invalid-state':
      return `Retry rejected (invalid-state): a ${state} item cannot be requeued from here. It stays in the queue, untouched.`;
    case 'not-found':
      return 'Retry rejected (not-found): that item is no longer in the queue.';
    default:
      return `Retry rejected (${reason}): the item stays in the queue, untouched.`;
  }
}

/**
 * The states a cancel cannot touch because something may still be RUNNING.
 * Mirrors the queue's own in-flight set (`followup-queue.ts:152`); kept here as
 * a message-selection detail only — the queue remains the decider.
 */
const IN_FLIGHT_STATES: readonly FollowupItemState[] = ['reserved', 'claimed', 'dispatched'];

/**
 * Cancel replies speak the panel's language (the queue surface and the enqueue
 * receipt are Korean), so the user reads one voice on one message.
 */
const CANCEL_DENIED_TEXT = '취소가 거부되었습니다: 이 세션을 조작할 권한이 없습니다 — 항목은 큐에 그대로 있습니다.';
/**
 * Success speaks too. The repaint alone is not a receipt: an overflow click
 * gives no visual feedback, so a silent success is indistinguishable from a
 * click that never arrived — and every refusal branch below already answers.
 */
const CANCEL_OK_TEXT = '취소했습니다 — 항목은 기록으로 남습니다.';
const CANCEL_RUNNING_TEXT = '실행 중인 항목은 취소할 수 없습니다 — 패널의 중지 버튼을 쓰세요.';
const CANCEL_STALE_TEXT = '이미 바뀐 항목입니다 — 패널을 새로고침했습니다.';
/** The SDK confirmed the withdrawal: the model never saw the message. */
const CANCEL_STEERED_OK_TEXT = '취소했습니다 — 모델에 전달되기 전에 회수했습니다.';
/** The SDK had already dequeued it, so the message is part of the running turn. */
const CANCEL_STEERED_DELIVERED_TEXT = '취소하지 못했습니다 — 이미 모델에 전달되어 실행 중입니다.';
/**
 * The SDK could not be asked, so delivery is unknown. The item is back in the
 * queue, which is both the honest state and a working control: the next click
 * cancels an ordinary `queued` row.
 */
const CANCEL_STEERED_RETURNED_TEXT =
  '취소하지 못했습니다 — 전달 여부를 확인할 수 없어 큐로 되돌렸습니다. 다시 Cancel 할 수 있습니다.';

/**
 * Cancel (menu-only). Authorization is the SAME interrupt policy Resume and
 * Retry use — cancelling someone else's queued instruction is steering the
 * session just as much as running it early.
 *
 * Three things it deliberately does NOT do:
 *   - it never kicks the drain: removing an item opens no boundary, and a
 *     cancel must not become an implicit "run the next one now";
 *   - it never stops a live turn. `reserved`/`claimed`/`dispatched` are refused
 *     by the queue and answered by pointing at the stop control, because a
 *     queue edit that silently stopped execution would be the A29 conflation
 *     (one sentence for two different acts);
 *   - it never falls back to "cancel whatever is there now" — a lost race is
 *     answered with a repaint so the user decides against the CURRENT state.
 */
async function handleCancel(
  deps: FollowupActionsDeps,
  body: unknown,
  respond: FollowupRespond,
  value: FollowupItemActionValue,
): Promise<void> {
  const click = verifyClick(deps, body, value.sessionKey);
  if (!click.ok) {
    await refuse(respond, `Cancel rejected: ${click.detail}.`);
    return;
  }

  const allowed = await deps.canInterrupt(value.sessionKey, click.clicker);
  if (!allowed) {
    await refuse(respond, CANCEL_DENIED_TEXT);
    return;
  }

  const item = deps.queue.get(value.sessionKey, value.itemId);
  if (item && item.sessionKey !== value.sessionKey) {
    await refuse(respond, 'Cancel rejected: that item belongs to another session.');
    return;
  }
  // Gone, or moved on since the menu was rendered: repaint FIRST so the
  // ephemeral and the panel the user is looking at agree.
  if (!item || item.epoch !== value.epoch) {
    await safeRefresh(deps, value.sessionKey);
    await refuse(respond, CANCEL_STALE_TEXT);
    return;
  }

  // Captured before the call: a successful cancel rewrites the state, and the
  // refusal text depends on where the item WAS.
  const previousState = item.state;
  try {
    // A steered message lives in the SDK's input queue, not only in ours — the
    // host has to ask the SDK first, so this is a different door, not a
    // different reason code on the same one.
    if (previousState === 'steered') {
      await cancelSteeredItem(deps, respond, value, item.steerUuid);
      return;
    }
    const result = deps.queue.cancelItem(
      value.sessionKey,
      value.itemId,
      value.epoch,
      `<@${click.clicker}> 님이 취소했습니다`,
    );
    if (result.ok) {
      await reply(respond, CANCEL_OK_TEXT);
      return;
    }
    if (result.reason === 'stale-epoch' || result.reason === 'not-found') {
      await refuse(respond, CANCEL_STALE_TEXT);
      return;
    }
    if (result.reason === 'invalid-state' && IN_FLIGHT_STATES.includes(previousState)) {
      await refuse(respond, CANCEL_RUNNING_TEXT);
      return;
    }
    await refuse(respond, cancelRefusal(result.reason, previousState));
  } finally {
    // Success or refusal, the surface is now behind the queue.
    await safeRefresh(deps, value.sessionKey);
  }
}

/**
 * Cancel of a `steered` item: the SDK decides, this only reports what it said.
 *
 * Each outcome gets its own sentence, because they are four different facts
 * for the user (A29): withdrawn before the model read it, already in the
 * model's hands, returned to the queue with delivery unknown, or not carried
 * out at all. A throw is left to the detached catch — it must not be turned
 * into "cancelled".
 */
async function cancelSteeredItem(
  deps: FollowupActionsDeps,
  respond: FollowupRespond,
  value: FollowupItemActionValue,
  steerUuid: string | undefined,
): Promise<void> {
  if (!steerUuid) {
    // Nothing can name the SDK's copy, so nothing may claim to have cancelled
    // it — the same refusal a queue `invalid-state` would produce.
    await refuse(respond, cancelRefusal('invalid-state', 'steered'));
    return;
  }

  const outcome = await deps.cancelSteered(value.sessionKey, value.itemId, value.epoch, steerUuid);
  if (outcome === 'cancelled') {
    await reply(respond, CANCEL_STEERED_OK_TEXT);
    return;
  }
  if (outcome === 'already-delivered') {
    await reply(respond, CANCEL_STEERED_DELIVERED_TEXT);
    return;
  }
  if (outcome === 'returned-to-queue') {
    await reply(respond, CANCEL_STEERED_RETURNED_TEXT);
    return;
  }
  await refuse(respond, cancelRefusal(outcome, 'steered'));
}

/**
 * Same shape as `retryRefusal`: never silent, never success-shaped, and the
 * item is always described as RETAINED. A terminal item (`resolved`/`failed`/
 * `cancelled`) lands here rather than in the "still running" branch — telling
 * that user to press stop would be a lie about what the item is doing.
 */
function cancelRefusal(reason: string, state: FollowupItemState): string {
  if (reason === 'invalid-state') return `취소할 수 없는 상태입니다 (${state}) — 항목은 그대로 둡니다.`;
  return `취소가 거부되었습니다 (${reason}) — 항목은 큐에 그대로 있습니다.`;
}

/**
 * Pagination — strictly read-only. Same thread ACL as the item controls (the
 * page a stranger asks for is still a view of someone else's queue), no queue
 * call of any kind, and the page number is validated before it is passed on.
 */
async function handlePage(deps: FollowupActionsDeps, body: unknown, respond: FollowupRespond): Promise<void> {
  const value = parseFollowupPageActionValue(readActionValue(body));
  if (!value) {
    await refuse(respond, 'Page change ignored: the button payload could not be read. Refresh the queue.');
    return;
  }
  if (!Number.isSafeInteger(value.page) || value.page < 1) {
    await refuse(respond, 'Page change rejected: that page number is not usable.');
    return;
  }
  const click = verifyClick(deps, body, value.sessionKey);
  if (!click.ok) {
    await refuse(respond, `Page change rejected: ${click.detail}.`);
    return;
  }
  await deps.refresh(value.sessionKey, value.page);
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

interface VerifiedClick {
  clicker: string;
  session: FollowupActionSession;
}

type ClickVerification = { ok: true; clicker: string; session: FollowupActionSession } | { ok: false; detail: string };

/**
 * Re-derive the click from server state. Nothing in the button `value` is taken
 * as proof of anything except which coordinates to LOOK UP.
 */
function verifyClick(deps: FollowupActionsDeps, body: unknown, sessionKey: string): ClickVerification {
  const clicker = readUserId(body);
  if (!clicker) return { ok: false, detail: 'the click carries no user id' };

  const session = deps.getSessionByKey(sessionKey);
  if (!session) return { ok: false, detail: 'that queue belongs to a session this process does not have' };

  const channelId = readChannelId(body);
  if (!channelId) return { ok: false, detail: 'the click carries no verifiable channel' };
  if (channelId !== session.channelId) return { ok: false, detail: 'the click did not come from the session channel' };

  // `||` not `??`: an empty string is not an anchor.
  const anchor = session.threadRootTs || session.threadTs;
  if (!anchor) return { ok: false, detail: 'the session has no thread to verify this click against' };
  const thread = readThreadTs(body);
  if (!thread) return { ok: false, detail: 'the click carries no verifiable thread' };
  if (thread !== anchor) return { ok: false, detail: 'the click did not come from the session thread' };

  return { ok: true, clicker, session };
}

type ItemVerification = { ok: true; item: FollowupItem } | { ok: false; detail: string };

/**
 * The item must exist, belong to the verified session, and be at the exact
 * generation the button was rendered from. A mismatch is a LOST RACE, not a
 * reason to act on the newer state (A12/A28).
 */
function verifyItem(deps: FollowupActionsDeps, value: FollowupItemActionValue): ItemVerification {
  const item = deps.queue.get(value.sessionKey, value.itemId);
  if (!item) return { ok: false, detail: 'that item is no longer in the queue' };
  if (item.sessionKey !== value.sessionKey) return { ok: false, detail: 'that item belongs to another session' };
  if (item.epoch !== value.epoch) {
    return {
      ok: false,
      detail:
        `the button was rendered from an older view of the queue ` +
        `(generation ${value.epoch}, now ${item.epoch}) and the item stays in the queue`,
    };
  }
  return { ok: true, item };
}

/**
 * A question/approval the user has not answered yet. While one is outstanding
 * the session is parked ON THE USER, so the queue must not be released.
 */
function pendingApproval(session: FollowupActionSession): string | undefined {
  const panel = session.actionPanel;
  if (!panel) return undefined;
  if (panel.waitingForChoice === true) return 'a question is still waiting for an answer';
  if (panel.pendingChoice !== undefined && panel.pendingChoice !== null) {
    return 'an approval is still pending on this thread';
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Body readers — every field is re-typed, none is assumed
 * ------------------------------------------------------------------ */

function readActionValue(body: unknown): string | undefined {
  const actions = (body as { actions?: Array<{ value?: unknown }> })?.actions;
  const value = actions?.[0]?.value;
  return typeof value === 'string' ? value : undefined;
}

/**
 * An overflow menu reports its payload ONLY in `selected_option.value` — there
 * is no top-level `value` on that action. Reading one is therefore not a
 * fallback but a guess, and this module does not guess.
 */
function readMenuValue(body: unknown): string | undefined {
  const actions = (body as { actions?: Array<{ selected_option?: { value?: unknown } }> })?.actions;
  const value = actions?.[0]?.selected_option?.value;
  return typeof value === 'string' ? value : undefined;
}

function readUserId(body: unknown): string | undefined {
  const id = (body as { user?: { id?: unknown } })?.user?.id;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * Slack reports the channel twice. If both are present they must agree —
 * a disagreement is a malformed/forged body, not a value to pick from.
 */
function readChannelId(body: unknown): string | undefined {
  const b = body as { channel?: { id?: unknown }; container?: { channel_id?: unknown } };
  const fromBody = typeof b?.channel?.id === 'string' ? b.channel.id : undefined;
  const fromContainer = typeof b?.container?.channel_id === 'string' ? b.container.channel_id : undefined;
  if (fromBody && fromContainer && fromBody !== fromContainer) return undefined;
  return fromBody || fromContainer;
}

/**
 * The thread the clicked message lives in. `thread_ts` when it is a reply, the
 * message's own `ts` when it IS the thread root. A body with none of the four is
 * unverifiable and its caller refuses the click.
 */
function readThreadTs(body: unknown): string | undefined {
  const b = body as {
    message?: { thread_ts?: unknown; ts?: unknown };
    container?: { thread_ts?: unknown; message_ts?: unknown };
  };
  const candidates = [b?.message?.thread_ts, b?.container?.thread_ts, b?.message?.ts, b?.container?.message_ts];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

/** One ephemeral, visible to the clicker only — the sole way this module talks back. */
function reply(respond: FollowupRespond, text: string): Promise<unknown> {
  return respond({ ...EPHEMERAL, text });
}

/** {@link reply} under the name every rejection path reads better with. */
function refuse(respond: FollowupRespond, text: string): Promise<unknown> {
  return reply(respond, text);
}

/**
 * Run the real work after the ack, off the listener's promise. A detached job
 * that fails silently would look like success to the user, so the failure is
 * both reported and surfaced ephemerally.
 *
 * The default failure text ("Nothing was dispatched; the item stays in the
 * queue") is only true for a job that has not dispatched anything yet. The
 * `Send now` follow-through (started only after `sendNow` already returned
 * `dispatched`) passes its own `failureText` so a post-dispatch failure does
 * not invert a completed send into a claimed non-send.
 */
function detach(
  deps: FollowupActionsDeps,
  label: string,
  respond: FollowupRespond,
  job: () => Promise<void>,
  failureText: (error: unknown) => string = (error) =>
    `${label} could not be completed (${errorText(error)}). Nothing was dispatched; the item stays in the queue.`,
): void {
  void job().catch((error: unknown) => {
    report(deps, label, error);
    return refuse(respond, failureText(error)).catch((replyError: unknown) =>
      // `respond` itself can fail (an expired response_url); that is a log-only
      // fact — there is no second channel to announce it on.
      report(deps, `${label} reply`, replyError),
    );
  });
}

/**
 * The host's steered-row sweep, best effort. It runs in a `finally`, so a throw
 * here would REPLACE the settlement's own outcome — including its rejection —
 * with a bookkeeping failure. Caught and reported instead.
 */
async function sweepSteered(deps: FollowupActionsDeps, sessionKey: string): Promise<void> {
  try {
    await deps.sweepSteered?.(sessionKey);
  } catch (error) {
    report(deps, 'Send now steered sweep', error);
  }
}

/** The surface redraw is best-effort: failing to repaint must not undo the act. */
async function safeRefresh(deps: FollowupActionsDeps, sessionKey: string): Promise<void> {
  try {
    await deps.refresh(sessionKey);
  } catch (error) {
    report(deps, 'queue refresh', error);
  }
}

function report(deps: FollowupActionsDeps, label: string, error: unknown): void {
  if (deps.reportError) {
    try {
      deps.reportError(label, error);
      return;
    } catch {
      // An injected logger that throws must not swallow the original failure.
    }
  }
  logger.error(`${label} failed`, error);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { VerifiedClick };

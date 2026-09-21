import type { FollowupItemState } from '@soma/slack/followup-queue';

/**
 * The follow-up queue's reaction surface — 09 (`.prd/09-followup-reaction-ui-spec.md`).
 *
 * A queued message used to be answered with a bot CARD carrying its state and
 * two buttons (A39). This module is what replaced it: the state and the controls
 * live as reactions on the USER's own message, and nothing is posted at all.
 * The user's instruction was "ui를 최소화" — one message, some emoji, no reply.
 *
 * Two halves, deliberately separated:
 *
 *   - the TABLE (`rolesForFollowupState`, `diffFollowupReactionRoles`) is pure
 *     and is the spec §2.1 table written once. It maps a queue state to the set
 *     of reactions that must stand on the message, and a transition to the ops
 *     that get there. No Slack, no config, no I/O — it can be read as the table
 *     it is;
 *   - the SURFACE ({@link FollowupReactionSurface}) applies those ops through an
 *     injected port and owns the two things the table cannot say: ops are
 *     ordered remove-before-add (a message that carried `inbox_tray` and
 *     `white_check_mark` at once would read as two states), and a custom emoji
 *     the workspace does not have (`invalid_name`) is replaced by a standard one
 *     for the rest of the process's life.
 *
 * What it deliberately does NOT own: which item a reaction belongs to, who may
 * press it, and whether the state accepts it. A reaction is a TRANSPORT into the
 * handlers the buttons already use (`slack/actions/followup-actions.ts`) — a
 * second policy here would be a second, quietly divergent set of rules about
 * interrupting someone else's turn.
 */

/**
 * The reactions this surface manages, by ROLE rather than by name: the names are
 * configurable (§2.3) and the fallback rewrites them at runtime, so every
 * comparison in here is between roles.
 */
export type FollowupReactionRole = 'queued' | 'sendNow' | 'cancel' | 'delivered' | 'cancelled' | 'failed';

export interface FollowupReactionNames {
  /** Parked, waiting for the drain (or for a control). */
  queued: string;
  /** Control — run this item now. */
  sendNow: string;
  /** Control — drop this item. */
  cancel: string;
  /** The model has it (steered, in flight, or consumed). */
  delivered: string;
  cancelled: string;
  failed: string;
}

export const DEFAULT_FOLLOWUP_REACTION_NAMES: FollowupReactionNames = {
  queued: 'inbox_tray',
  sendNow: 'ui_send_now',
  cancel: 'ui_cancel',
  delivered: 'white_check_mark',
  cancelled: 'no_entry_sign',
  failed: 'warning',
};

/**
 * Standard emoji for the two CUSTOM controls, used when the workspace has not
 * installed `:ui_send_now:`/`:ui_cancel:` (§2.3). Only the controls have one:
 * every other name in the table is a standard emoji already, so a failure there
 * is a real failure and not a missing upload.
 */
export const FOLLOWUP_REACTION_FALLBACKS: { sendNow: string; cancel: string } = {
  sendNow: 'arrow_forward',
  cancel: 'x',
};

/**
 * §2.1 — what must be standing on the message for each queue state.
 *
 * Read it as the user wrote it: a waiting message offers its two controls, a
 * message the model has been given shows only that it was delivered, and a
 * terminal message shows how it ended.
 *
 * The check mark means READ, not sent. That is the correction of 2026-09-18:
 * a `steered` message has been pushed into the running turn's input channel and
 * is WAITING there for the model to pick it up at its next tool-call boundary —
 * so it is still the user's to take back. Painting 전달완료 on it took both
 * controls away during exactly the window where they are most wanted.
 *
 * Four readings this table is deliberate about:
 *
 *  - `steered` is WAITING, and shows the same three as `queued`. Both controls
 *    really work there: `Send now` is handled by the dispatcher's own steered
 *    pre-step (unsteer at the steered epoch, then reserve —
 *    `followup-dispatcher.ts:847-905`), and Cancel goes through the SDK
 *    (`cancelSteered`). The check mark arrives when the model actually reads
 *    the message and the row becomes `resolved`.
 *  - `reserved`/`claimed` are NOT a delivery either, and carry no controls.
 *    They sit between the drain's decision and the dispatch, and `rollback`
 *    puts either of them straight back to `queued`
 *    (`followup-queue.ts:558-565`), so a check mark would claim something the
 *    model may never see — while the queue refuses to cancel anything in
 *    flight (`followup-queue.ts:164-170`), so there is nothing to offer.
 *  - `dispatched`/`resolved` DO claim delivery: the message is running as a
 *    turn of its own, or the model confirmed it read it.
 *  - `failed`/`uncertain` keep BOTH controls next to the warning. They really
 *    are actionable: the queue cancels them (`CANCELLABLE_STATES`,
 *    `followup-queue.ts:164-170`) and `retry` is their one non-terminal exit
 *    (`:809-816`). The host routes the `sendNow` reaction on these two into
 *    Retry rather than `Send now` — one reaction, the control that state
 *    actually has (09 C1). A parked row with no control at all was the dead end
 *    the reaction UI was supposed to remove, not create.
 */
export function rolesForFollowupState(state: FollowupItemState): FollowupReactionRole[] {
  switch (state) {
    case 'queued':
    case 'paused':
    // Still waiting, just waiting in the SDK's queue instead of ours.
    case 'steered':
      return ['queued', 'sendNow', 'cancel'];
    case 'reserved':
    case 'claimed':
      return ['queued'];
    case 'dispatched':
    case 'resolved':
      return ['delivered'];
    case 'cancelled':
      return ['cancelled'];
    case 'failed':
    case 'uncertain':
      return ['failed', 'sendNow', 'cancel'];
    default: {
      // A state this build does not know is left alone rather than painted as
      // something it might not be.
      const unreachable: never = state;
      void unreachable;
      return [];
    }
  }
}

/**
 * The ops that take a message from what it shows now to what it must show.
 *
 * `previous === undefined` is a FIRST paint, not "nothing is standing": the
 * difference matters because this surface only ever removes reactions it put
 * there itself, and with no record of a previous paint it has no claim to any.
 */
export function diffFollowupReactionRoles(
  previous: readonly FollowupReactionRole[] | undefined,
  next: readonly FollowupReactionRole[],
): { add: FollowupReactionRole[]; remove: FollowupReactionRole[] } {
  const standing = previous ?? [];
  return {
    add: next.filter((role) => !standing.includes(role)),
    remove: standing.filter((role) => !next.includes(role)),
  };
}

/**
 * Which control does this emoji name stand for, if any?
 *
 * Both the configured name AND its fallback are accepted: a workspace that
 * refused the custom emoji shows the fallback, and the user pressing THAT is
 * pressing the same control. Only the two controls are answerable — the state
 * emoji are reports, and reacting `white_check_mark` to your own message must
 * not run anything.
 *
 * `sendNow` is the ROLE, not the operation: on a `queued`/`paused`/`steered`
 * row the host routes it into `Send now`, on a `failed`/`uncertain` one into
 * Retry (09 C1). Which operation a control means is a question about the item's
 * state, and this module does not read items.
 */
export function followupControlRole(reaction: string, names: FollowupReactionNames): 'sendNow' | 'cancel' | undefined {
  if (reaction === names.sendNow || reaction === FOLLOWUP_REACTION_FALLBACKS.sendNow) return 'sendNow';
  if (reaction === names.cancel || reaction === FOLLOWUP_REACTION_FALLBACKS.cancel) return 'cancel';
  return undefined;
}

/** One `reactions.add`/`reactions.remove`, with the Slack error CODE kept. */
export interface FollowupReactionOpResult {
  ok: boolean;
  /** The Slack error code (`invalid_name`, `no_reaction`, …) when `ok` is false. */
  error?: string;
}

/**
 * The two Slack calls this surface makes — see `slack-api-helper.ts`
 * `addReactionResult`/`removeReactionResult` for the production pair.
 *
 * `remove` may answer `void`, which is read as success: a client that predates
 * the coded variant (the unit doubles, an older host) still paints, it just
 * cannot distinguish a swallowed failure from a real removal.
 */
export interface FollowupReactionPort {
  add(channel: string, ts: string, name: string): Promise<FollowupReactionOpResult>;
  remove(channel: string, ts: string, name: string): Promise<FollowupReactionOpResult | void>;
}

export interface FollowupReactionTarget {
  channel: string;
  ts: string;
}

/** `add` on a reaction that is already there is the state we wanted. */
const TOLERATED_ADD_ERROR = 'already_reacted';
/** `remove` of a reaction the bot never got on is also the state we wanted. */
const TOLERATED_REMOVE_ERROR = 'no_reaction';
/**
 * Not a Slack code: the add never happened, because a remove in the same sync
 * failed and adding the new state on top of the old one would show two states
 * at once. Reported so the caller retries rather than recording a paint that
 * was never attempted.
 */
export const FOLLOWUP_REACTION_SKIPPED_AFTER_FAILED_REMOVE = 'skipped_after_failed_remove';

export type FollowupReactionOp = 'add' | 'remove';

export interface FollowupReactionFailure {
  role: FollowupReactionRole;
  op: FollowupReactionOp;
  /** Slack's code when there is one, the thrown message otherwise. */
  error: string;
}

/**
 * What a paint actually achieved.
 *
 * `painted` is the caller's record for the NEXT diff and it is what this
 * surface BELIEVES is standing, which is not the same as what it asked for:
 * a role whose add failed is not in it (so the next identical sync adds it
 * again), and a role whose REMOVE failed still is (so the next sync removes it
 * again). Recording the request instead would turn one refused API call into a
 * permanently wrong picture that nothing ever reconciles.
 */
export interface FollowupReactionApplyResult {
  painted: FollowupReactionRole[];
  /** Empty on a clean paint. Non-empty means this message has not converged. */
  failed: FollowupReactionFailure[];
}

export interface FollowupReactionSurfaceOptions {
  port: FollowupReactionPort;
  /** §2.3 — the names are configurable; the defaults are the spec table. */
  names?: FollowupReactionNames;
  /** Said once per name that had to fall back. */
  onWarn?: (message: string, detail: Record<string, unknown>) => void;
}

export class FollowupReactionSurface {
  private readonly port: FollowupReactionPort;
  private readonly names: FollowupReactionNames;
  private readonly onWarn?: (message: string, detail: Record<string, unknown>) => void;
  /**
   * Roles whose configured emoji this workspace rejected. Sticky for the life of
   * the process and one-way (custom → fallback): a name that was refused once is
   * refused every time, so re-trying it on every paint would cost one failed API
   * call per message, and a role that flip-flopped would leave the wrong emoji
   * standing when the next transition tried to remove the other one.
   */
  private readonly fellBack = new Set<FollowupReactionRole>();
  /** Failures already reported, keyed by message+role+op+code. */
  private readonly warned = new Set<string>();
  /**
   * How many distinct failures stay remembered. Bounded because the key carries
   * a message ts: an unbounded set would hold one entry per message this
   * process ever failed to paint.
   */
  private static readonly WARN_MEMORY = 200;

  constructor(options: FollowupReactionSurfaceOptions) {
    this.port = options.port;
    this.names = options.names ?? DEFAULT_FOLLOWUP_REACTION_NAMES;
    this.onWarn = options.onWarn;
  }

  /** The names as configured — the router needs them to filter `reaction_added`. */
  get reactionNames(): FollowupReactionNames {
    return this.names;
  }

  /** Is this emoji one of the two controls? The router's filter (09 §5). */
  isControlReaction(reaction: string): boolean {
    return followupControlRole(reaction, this.names) !== undefined;
  }

  /** {@link followupControlRole} against this surface's configured names. */
  controlRole(reaction: string): 'sendNow' | 'cancel' | undefined {
    return followupControlRole(reaction, this.names);
  }

  /**
   * Paint one state onto one message and answer what is now standing.
   *
   * The answer is the caller's record for the NEXT transition — this surface
   * keeps no per-message state, because the only thing that knows which message
   * belongs to which item is the host's queue index.
   */
  applyState(
    target: FollowupReactionTarget,
    state: FollowupItemState,
    previous: readonly FollowupReactionRole[] | undefined,
  ): Promise<FollowupReactionApplyResult> {
    return this.applyRoles(target, rolesForFollowupState(state), previous);
  }

  /**
   * The same, for a set of roles the caller chose itself — the enqueue paints
   * the receipt AND both controls as ONE set before the steer attempt
   * (2026-09-21), so everything the user can press is on the message from the
   * first paint instead of arriving a steer later.
   *
   * Never throws: this is bookkeeping on top of an item that is already durable,
   * so a refused call must not roll a queue transition back. It is NOT
   * "best effort" in the sense of being forgotten, though — every failure comes
   * back in {@link FollowupReactionApplyResult.failed} and is kept out of
   * `painted`, so the caller can retain the row and the next sync repaints
   * exactly what is missing.
   *
   * Ordering is remove-before-add, and a FAILED remove stops the adds: the
   * whole point of that order is that the message never shows the old state and
   * the new one together, and adding `no_entry_sign` next to a `ui_send_now`
   * that would not come down is precisely that picture. The sync leaves the row
   * unconverged instead, and says so.
   */
  async applyRoles(
    target: FollowupReactionTarget,
    roles: readonly FollowupReactionRole[],
    previous: readonly FollowupReactionRole[] | undefined,
  ): Promise<FollowupReactionApplyResult> {
    const standing = previous ?? [];
    const ops = diffFollowupReactionRoles(previous, roles);
    // Untouched roles: asked for AND already there, so nothing was attempted
    // and nothing can have failed.
    const painted = new Set<FollowupReactionRole>(roles.filter((role) => standing.includes(role)));
    const failed: FollowupReactionFailure[] = [];

    // Issued CONCURRENTLY, accounted in order. One paint is one picture, and
    // serializing it made the user watch that picture assemble emoji by emoji
    // across the shared rate-limit queue (2026-09-21). The two orderings that
    // matter are untouched: every remove still COMPLETES before any add is
    // issued (the `await` below covers all of them), and the results are folded
    // in `ops` order, so `failed`/`painted` read exactly as when this was
    // serial.
    const removeResults = await Promise.all(
      ops.remove.map(async (role) => ({
        role,
        result: await this.runOp(
          () => this.port.remove(target.channel, target.ts, this.nameFor(role)),
          TOLERATED_REMOVE_ERROR,
        ),
      })),
    );

    let removeFailed = false;
    for (const { role, result } of removeResults) {
      if (result.ok) continue;
      removeFailed = true;
      // Still on the message as far as anyone knows — recorded as painted so
      // the next diff tries to take it down again.
      painted.add(role);
      failed.push({ role, op: 'remove', error: result.error ?? 'unknown' });
      this.warnFailure(target, role, 'remove', result.error ?? 'unknown');
    }

    if (removeFailed) {
      for (const role of ops.add) {
        failed.push({ role, op: 'add', error: FOLLOWUP_REACTION_SKIPPED_AFTER_FAILED_REMOVE });
      }
      return { painted: this.order(roles, painted), failed };
    }

    const addResults = await Promise.all(ops.add.map(async (role) => ({ role, result: await this.add(target, role) })));
    for (const { role, result } of addResults) {
      if (result.ok) {
        painted.add(role);
        continue;
      }
      failed.push({ role, op: 'add', error: result.error ?? 'unknown' });
      this.warnFailure(target, role, 'add', result.error ?? 'unknown');
    }
    return { painted: this.order(roles, painted), failed };
  }

  /**
   * One add, with the §2.3 fallback. `invalid_name` means the workspace has no
   * such emoji — the ONE failure with a repair. Everything else is answered as
   * it came: a rate limit or a missing scope is not fixed by painting a
   * different picture.
   *
   * A fallback that fails too is reported as a failure, not swallowed: the
   * control is not on the message, and pretending otherwise is what would make
   * the next sync skip it.
   */
  private async add(target: FollowupReactionTarget, role: FollowupReactionRole): Promise<FollowupReactionOpResult> {
    const name = this.nameFor(role);
    const result = await this.runOp(() => this.port.add(target.channel, target.ts, name), TOLERATED_ADD_ERROR);
    if (result.ok || result.error !== 'invalid_name') return result;

    const fallback = FOLLOWUP_REACTION_FALLBACKS[role as 'sendNow' | 'cancel'];
    if (!fallback) return result;
    // Once this is set, `nameFor` answers the fallback, so a later paint never
    // spends a call on the refused name again — this branch is reached once.
    if (!this.fellBack.has(role)) {
      this.fellBack.add(role);
      this.onWarn?.('Queue control emoji is not installed in this workspace — falling back', {
        role,
        configured: name,
        fallback,
      });
    }
    return await this.runOp(() => this.port.add(target.channel, target.ts, fallback), TOLERATED_ADD_ERROR);
  }

  /**
   * Run one port call and normalise every way it can answer into one result:
   * a resolved `void` (the uncoded client) is success, `ok` is success, the
   * tolerated code is success, and a throw is read for a Slack code before
   * falling back to its message. Nothing propagates.
   */
  private async runOp(
    call: () => Promise<FollowupReactionOpResult | void>,
    tolerated: string,
  ): Promise<FollowupReactionOpResult> {
    try {
      const result = await call();
      if (!result || result.ok) return { ok: true };
      if (result.error === tolerated) return { ok: true };
      return { ok: false, error: result.error ?? 'unknown' };
    } catch (error) {
      const code = errorCodeOf(error);
      return code === tolerated ? { ok: true } : { ok: false, error: code };
    }
  }

  /**
   * One WARN per (message, role, op, error). A rate-limited workspace produces
   * the same failure on every paint of every transition, and a log line per
   * attempt would bury the first one — which is the only one that says
   * something new.
   */
  private warnFailure(
    target: FollowupReactionTarget,
    role: FollowupReactionRole,
    op: FollowupReactionOp,
    error: string,
  ): void {
    const key = `${target.channel}:${target.ts}|${role}|${op}|${error}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    while (this.warned.size > FollowupReactionSurface.WARN_MEMORY) {
      const oldest = this.warned.values().next();
      if (oldest.done) break;
      this.warned.delete(oldest.value);
    }
    this.onWarn?.('Queue reaction could not be applied — the row is left for the next sync', {
      channel: target.channel,
      ts: target.ts,
      role,
      op,
      error,
    });
  }

  /** Requested roles first, then anything that refused to leave — stable to read. */
  private order(roles: readonly FollowupReactionRole[], painted: Set<FollowupReactionRole>): FollowupReactionRole[] {
    return [...roles.filter((role) => painted.has(role)), ...[...painted].filter((role) => !roles.includes(role))];
  }

  /** The emoji actually in use for a role right now (configured, or its fallback). */
  private nameFor(role: FollowupReactionRole): string {
    if (this.fellBack.has(role)) {
      const fallback = FOLLOWUP_REACTION_FALLBACKS[role as 'sendNow' | 'cancel'];
      if (fallback) return fallback;
    }
    return this.names[role];
  }
}

/** Slack puts its code in `error.data.error`; anything else is read as prose. */
function errorCodeOf(error: unknown): string {
  const data = (error as { data?: { error?: unknown } })?.data;
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

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
 * The three in-flight states are folded into `delivered` because they are the
 * same fact for the reader (the message left the queue into a run) and because
 * a control on them could only ever be refused — the queue rejects a cancel of
 * anything in flight (`followup-actions.ts` `IN_FLIGHT_STATES`).
 *
 * `failed`/`uncertain` show the warning and NO control, which is the honest
 * reading of "컨트롤은 상태에 맞게 유지": neither state accepts `Send now` or
 * `Cancel` through this transport, and painting a control that can only answer
 * with a refusal is the one thing this surface must not do. Their door out is
 * Retry, which lives on the `queue` command's rows (§4 keeps that surface).
 */
export function rolesForFollowupState(state: FollowupItemState): FollowupReactionRole[] {
  switch (state) {
    case 'queued':
    case 'paused':
      return ['queued', 'sendNow', 'cancel'];
    case 'steered':
    case 'reserved':
    case 'claimed':
    case 'dispatched':
    case 'resolved':
      return ['delivered'];
    case 'cancelled':
      return ['cancelled'];
    case 'failed':
    case 'uncertain':
      return ['failed'];
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
 * refused the custom emoji shows the fallback, and the user clicking THAT is
 * pressing the same control. Only the two controls are answerable — the state
 * emoji are reports, and reacting `white_check_mark` to your own message must
 * not run anything.
 */
export function followupControlRole(reaction: string, names: FollowupReactionNames): 'sendNow' | 'cancel' | undefined {
  if (reaction === names.sendNow || reaction === FOLLOWUP_REACTION_FALLBACKS.sendNow) return 'sendNow';
  if (reaction === names.cancel || reaction === FOLLOWUP_REACTION_FALLBACKS.cancel) return 'cancel';
  return undefined;
}

/** `reactions.add` with the Slack error code kept — see `slack-api-helper.ts` `addReactionResult`. */
export interface FollowupReactionPort {
  add(channel: string, ts: string, name: string): Promise<{ ok: boolean; error?: string }>;
  remove(channel: string, ts: string, name: string): Promise<void>;
}

export interface FollowupReactionTarget {
  channel: string;
  ts: string;
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
  ): Promise<FollowupReactionRole[]> {
    return this.applyRoles(target, rolesForFollowupState(state), previous);
  }

  /**
   * The same, for a set of roles the caller chose itself — the enqueue receipt
   * paints `queued` ALONE before the steer attempt, so the user sees the message
   * was taken within one API call instead of after three.
   *
   * Best effort throughout: this is bookkeeping on top of an item that is
   * already durable, so a refused op is logged by the port and the remaining
   * ops still run. The returned roles are what was REQUESTED — a reaction that
   * could not be added is one this surface will try to remove later, and
   * `reactions.remove` treats a missing reaction as a no-op.
   */
  async applyRoles(
    target: FollowupReactionTarget,
    roles: readonly FollowupReactionRole[],
    previous: readonly FollowupReactionRole[] | undefined,
  ): Promise<FollowupReactionRole[]> {
    const ops = diffFollowupReactionRoles(previous, roles);
    // Remove first: the old state must be gone before the new one appears.
    for (const role of ops.remove) {
      try {
        await this.port.remove(target.channel, target.ts, this.nameFor(role));
      } catch {
        // `no_reaction` is the common case (the bot never got this one on) and
        // every other failure is equally none of the user's business.
      }
    }
    for (const role of ops.add) {
      try {
        await this.add(target, role);
      } catch {
        // Same: a reaction that could not be painted is not worth failing the
        // act it was describing.
      }
    }
    return [...roles];
  }

  /**
   * One add, with the §2.3 fallback. `invalid_name` means the workspace has no
   * such emoji — the ONE failure with a repair. Everything else is reported by
   * the port and left alone: a rate limit or a missing scope is not fixed by
   * painting a different picture.
   */
  private async add(target: FollowupReactionTarget, role: FollowupReactionRole): Promise<void> {
    const name = this.nameFor(role);
    const result = await this.port.add(target.channel, target.ts, name);
    if (result.ok || result.error !== 'invalid_name') return;

    const fallback = FOLLOWUP_REACTION_FALLBACKS[role as 'sendNow' | 'cancel'];
    if (!fallback || this.fellBack.has(role)) return;
    this.fellBack.add(role);
    this.onWarn?.('Queue control emoji is not installed in this workspace — falling back', {
      role,
      configured: name,
      fallback,
    });
    await this.port.add(target.channel, target.ts, fallback);
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

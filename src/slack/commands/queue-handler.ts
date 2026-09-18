import type { FollowupItem, FollowupItemState } from '@soma/slack/followup-queue';
import {
  buildFollowupItemMessage,
  FOLLOWUP_PENDING_STATES,
  FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE,
  type FollowupQueueView,
} from '@soma/slack/followup-queue-blocks';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles `queue` / `큐` — the follow-up queue's own read command (A40).
 *
 * The queue used to be readable only in the combined thread panel; A39 moved it
 * into the thread, one message per item, and the user asked for a way to see
 * what is still waiting without scrolling back for those messages ("따로 명령어
 * 추가해주고 메세지 큐확인할수 있게 해주고"). This is that command.
 *
 * What it lists: the session's UNPROCESSED items only
 * ({@link FOLLOWUP_PENDING_STATES} — `queued`/`steered`/`paused`/`uncertain`/
 * `failed`). `resolved`/`cancelled` are history and the in-flight trio belongs
 * to the turn running it, so neither is something the user is still waiting on.
 * Each row is rendered by {@link buildFollowupItemMessage}, the SAME builder the
 * queue's own surface uses, so a row reads identically wherever it appears.
 *
 * Three properties it is built for:
 *
 *  - it is a CONTROL, not a turn. It answers from queue state and never
 *    dispatches, so `classifyText` returning `control` for it
 *    (`command-router.ts:413`, via this handler's `canHandle`) is what lets it
 *    run live while a turn is in flight — which is the only time the queue has
 *    anything in it.
 *  - it is READ-ONLY (09). The controls are reactions on the user's own message
 *    now, so this listing renders `controls: false` and carries no buttons at
 *    all. A row here with its own `Send now` would be a SECOND copy of a control
 *    the item already has, on a message nothing takes down when the item settles
 *    — exactly the stale-button surface the reaction UI removed. Instead each
 *    row that still offers a control says WHERE it is ({@link REACTION_HINT}),
 *    and only the rows that really offer one: `steered`/`failed`/`uncertain`
 *    accept neither reaction (09 §2.1), and pointing at a control they do not
 *    have would be the dead end this listing used to be.
 *  - it posts ONE MESSAGE PER ROW, not one message carrying every row: a packed
 *    message could not say which line belongs to which item, and its freeze
 *    notice would be about the whole listing rather than about the row it
 *    parked (A29). Ten rows is the page
 *    ({@link FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE}); a longer backlog gets a final
 *    `…외 N건` line instead of more messages, and an item past the tenth is read
 *    on its own message, where its reactions are.
 */
export class QueueHandler implements CommandHandler {
  /**
   * `queue` / `큐`, optionally slash-prefixed. Deliberately EXACT: `queue` with
   * an argument is ordinary English ("queue this for later") and must stay the
   * user's instruction, not a command that answers and consumes it.
   */
  private static readonly PATTERN = /^\/?(?:queue|큐)$/i;

  /** `대기 중인 메시지가 없습니다` — A40's one line for an empty queue. */
  static readonly EMPTY_TEXT = '대기 중인 메시지가 없습니다';

  /**
   * Where the controls are, said on the rows that have them (09 §2.1: `queued`
   * and `paused`). A listing that showed a state and no way to act on it would
   * leave the user looking for a button that is now three lines above, on their
   * own message.
   */
  static readonly REACTION_HINT = '메시지의 리액션으로 Send now / Cancel';

  /** The states whose message carries the two control reactions (09 §2.1). */
  private static readonly REACTION_CONTROL_STATES: readonly FollowupItemState[] = ['queued', 'paused'];

  constructor(private deps: QueueHandlerDeps = {}) {}

  canHandle(text: string): boolean {
    return QueueHandler.PATTERN.test((text ?? '').trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const items = this.pendingItems(ctx);
    if (items.length === 0) {
      await this.post(ctx, QueueHandler.EMPTY_TEXT, undefined);
      return { handled: true };
    }

    const view = this.viewOf(ctx);
    const turnEpoch = view?.turnEpoch ?? 0;
    const shown = items.slice(0, FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE);

    // Sequential, not `Promise.all`: the rows are posted in queue order and a
    // parallel burst would interleave them in the thread.
    for (const [index, item] of shown.entries()) {
      const rendered = buildFollowupItemMessage(item, turnEpoch, {
        // 1-based LIST position, not the item's `seq`: the user is reading a
        // list of what is still waiting, and a gap in it ("1, 4, 7") would look
        // like rows this command decided not to show.
        index: index + 1,
        // The same freeze the item's own message carries: a parked row says why
        // it is not running, and a row that arrived after the freeze says
        // nothing (the builder scopes it per item, A29).
        freeze: view?.freeze,
        // Read-only — see the class note. `turnEpoch` is still passed because
        // the builder takes it; with no buttons to stamp, nothing is minted
        // from it.
        controls: false,
      });
      await this.post(ctx, rendered.text, this.withReactionHint(rendered.blocks, item));
    }

    const hidden = items.length - shown.length;
    // Its own message, and deliberately bare: it stands for items this listing
    // did not render, so there is nothing on it to read or to act on.
    if (hidden > 0) await this.post(ctx, `…외 ${hidden}건`, undefined);
    return { handled: true };
  }

  /**
   * Append "the controls are on your message" to a row that HAS controls.
   *
   * After the row, not before it: the freeze notice the builder puts on top
   * explains why the row is not running, and this one says what to do about it
   * — question first, answer second.
   */
  private withReactionHint(blocks: unknown[], item: FollowupItem): unknown[] {
    if (!QueueHandler.REACTION_CONTROL_STATES.includes(item.state)) return blocks;
    return [...blocks, { type: 'context', elements: [{ type: 'plain_text', text: QueueHandler.REACTION_HINT }] }];
  }

  /** The session's unprocessed items, in FIFO order. Empty when there is no queue. */
  private pendingItems(ctx: CommandContext): FollowupItem[] {
    const view = this.viewOf(ctx);
    if (!view) return [];
    const pending = FOLLOWUP_PENDING_STATES as readonly FollowupItemState[];
    return [...view.items].filter((item) => pending.includes(item.state)).sort((a, b) => a.seq - b.seq);
  }

  /**
   * The queue view for the thread this command was typed in, or `undefined`
   * when there is no session key, no queue, or no items for it yet. Read live on
   * every call — a cached view would answer with a backlog that has since drained.
   */
  private viewOf(ctx: CommandContext): FollowupQueueView | undefined {
    const getSessionKey = this.deps.claudeHandler?.getSessionKey;
    if (typeof getSessionKey !== 'function') return undefined;
    let sessionKey: string | undefined;
    try {
      sessionKey = getSessionKey.call(this.deps.claudeHandler, ctx.channel, ctx.threadTs) || undefined;
    } catch {
      return undefined;
    }
    if (!sessionKey) return undefined;
    return this.deps.getFollowupView?.(sessionKey);
  }

  /**
   * Post the listing into the thread.
   *
   * Through `slackApi` when it is wired, so this listing is the same kind of
   * message as the rest of the queue's own writes (a ⚡ system post, rate-limit
   * queued). `ctx.say` is the fallback for compositions that pass no `slackApi`
   * — an answer through the ordinary handler path beats silence.
   */
  private async post(
    ctx: CommandContext,
    text: string,
    blocks: unknown[] | undefined,
  ): Promise<{ ts?: string; channel?: string } | undefined> {
    const slackApi = this.deps.slackApi;
    if (slackApi?.postSystemMessage) {
      return await slackApi.postSystemMessage(ctx.channel, text, { threadTs: ctx.threadTs, blocks });
    }
    return await ctx.say({ text, blocks: blocks as any[] | undefined, thread_ts: ctx.threadTs });
  }
}

/**
 * What this handler reads, as a structural subset of the command deps the
 * composition root already builds (`slack-handler.ts:382`). Every member is
 * optional: a router constructed without the follow-up wiring answers
 * "대기 중인 메시지가 없습니다" instead of throwing.
 */
export interface QueueHandlerDeps {
  claudeHandler?: { getSessionKey?(channel: string, threadTs: string): string | undefined };
  slackApi?: {
    postSystemMessage?(
      channel: string,
      text: string,
      options?: { threadTs?: string; blocks?: unknown[] },
    ): Promise<{ ts?: string; channel?: string } | undefined>;
  };
  /** The live queue view for a session key (`SlackHandler.getFollowupView`). */
  getFollowupView?(sessionKey: string): FollowupQueueView | undefined;
}

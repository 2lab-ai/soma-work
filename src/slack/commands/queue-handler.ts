import type { FollowupItem, FollowupItemState } from '@soma/slack/followup-queue';
import {
  buildFollowupItemMessage,
  FOLLOWUP_PENDING_STATES,
  FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE,
  FOLLOWUP_QUEUE_TITLE,
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
 * in-thread item message uses, so a row reads and behaves identically in both
 * places — one item, one wording, one pair of controls.
 *
 * Three properties it is built for:
 *
 *  - it is a CONTROL, not a turn. It answers from queue state and never
 *    dispatches, so `classifyText` returning `control` for it
 *    (`command-router.ts:413`, via this handler's `canHandle`) is what lets it
 *    run live while a turn is in flight — which is the only time the queue has
 *    anything in it.
 *  - it posts ONE message. Ten items is a full page
 *    ({@link FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE}, = 21 blocks of Slack's 50) and a
 *    longer backlog is summarised by its tail count rather than paged: this
 *    command is a status read, and the controls for an item past the tenth are
 *    still on that item's own message.
 *  - every posted row is REGISTERED with the host
 *    ({@link QueueHandlerDeps.rememberFollowupItemMessage}), so A41 deletes this
 *    listing's buttons when the item is processed, exactly as it deletes the
 *    item's own message. A listing that outlived its items would be a second
 *    surface of stale buttons — the thing A41 exists to prevent.
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
    const blocks: unknown[] = [];
    shown.forEach((item, index) => {
      // 1-based LIST position, not the item's `seq`: the user is reading a list
      // of what is still waiting, and a gap in it ("1, 4, 7") would look like
      // rows this command decided not to show.
      blocks.push(...buildFollowupItemMessage(item, turnEpoch, index + 1).blocks);
    });
    const hidden = items.length - shown.length;
    if (hidden > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: `…외 ${hidden}건` }] });
    }

    // Counts only, like the panel's fallback: the rows themselves carry the
    // (escaped) message text, and a notification line does not need to repeat
    // ten of them.
    const text = `${FOLLOWUP_QUEUE_TITLE} — 대기 ${items.length}건`;
    const posted = await this.post(ctx, text, blocks);
    // Where the listing landed, per item — see the class note on A41.
    for (const item of shown) {
      this.deps.rememberFollowupItemMessage?.(item.id, {
        channel: posted?.channel ?? ctx.channel,
        ts: posted?.ts,
      });
    }
    return { handled: true };
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
   * Through `slackApi` when it is wired, so this message is the same kind of
   * message as the item messages it mirrors (a ⚡ system post, rate-limit
   * queued) and its `ts` comes back for A41. `ctx.say` is the fallback for
   * compositions that pass no `slackApi` — an answer through the ordinary
   * handler path beats silence.
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
  /** Register a posted message against an item, for A41 deletion. */
  rememberFollowupItemMessage?(itemId: string, ref: { channel: string; ts?: string }): void;
}

/**
 * Host side of user actions (`instruct_user`): the MCP server validates and inspects; this keeps the record on the
 * session (`session.userActions`, apart from the pending question), posts its Slack card, and answers its buttons.
 * Every change is persisted and pushed to the dashboard through `persistAndBroadcast`.
 */
import {
  appendUserAction,
  INSTRUCT_USER_TOOL_NAME,
  parseInstructUserToolResult,
  type ResolveUserActionResult,
  resolveUserAction,
  type UserActionRecord,
  unresolveUserAction,
} from 'somalib/user-action/user-action';
import { Logger } from '../logger';
import type { ConversationSession } from '../types';
import { buildUserActionCard, userActionResolvedPrompt } from './user-action-card';

const logger = new Logger('UserActionHost');

export interface UserActionHostDeps {
  slackApi: {
    postMessage(
      channel: string,
      text: string,
      options?: { threadTs?: string; attachments?: any[]; unfurlLinks?: boolean; unfurlMedia?: boolean },
    ): Promise<{ ts?: string }>;
    updateMessage(channel: string, ts: string, text: string, blocks?: any[], attachments?: any[]): Promise<void>;
  };
  persistAndBroadcast?: (sessionKey: string) => void;
}

/**
 * Take every successful `instruct_user` result of a tool batch: store it, post its card (when the session has a
 * Slack thread), then persist and broadcast once. A failed post keeps the record — the dashboard still shows it.
 */
export async function captureUserActionToolResults(args: {
  toolResults: ReadonlyArray<{ toolName?: string; result: unknown; isError?: boolean }>;
  session: ConversationSession;
  sessionKey: string;
  channel: string;
  threadTs?: string;
  deps: UserActionHostDeps;
}): Promise<UserActionRecord[]> {
  const { session, sessionKey, channel, threadTs, deps } = args;
  const captured: UserActionRecord[] = [];
  for (const tr of args.toolResults) {
    if (tr.toolName !== INSTRUCT_USER_TOOL_NAME || tr.isError === true) continue;
    const action = parseInstructUserToolResult(tr.result);
    if (!action) continue;
    let stored: UserActionRecord = action;
    if (channel) {
      try {
        const card = buildUserActionCard(action, sessionKey);
        const post = await deps.slackApi.postMessage(channel, card.text, {
          threadTs,
          attachments: card.attachments,
          unfurlLinks: false,
          unfurlMedia: false,
        });
        if (post.ts) stored = { ...action, slackTs: post.ts };
      } catch (error) {
        logger.warn('user action card post failed — kept for the dashboard', {
          sessionKey,
          id: action.id,
          error: (error as Error)?.message ?? String(error),
        });
      }
    }
    session.userActions = appendUserAction(session.userActions, stored);
    captured.push(stored);
  }
  if (captured.length) {
    try {
      deps.persistAndBroadcast?.(sessionKey);
    } catch (error) {
      logger.warn('user action persist/broadcast failed', { sessionKey, error: (error as Error)?.message });
    }
  }
  return captured;
}

/**
 * Mark a pending action done or failed (first answer wins), rewrite its Slack card without the buttons, and
 * persist + broadcast. Telling the agent is the caller's job (it owns the message path).
 */
export async function resolveSessionUserAction(args: {
  session: ConversationSession;
  sessionKey: string;
  id: string;
  status: 'done' | 'failed';
  by: string;
  at: number;
  deps: UserActionHostDeps;
}): Promise<ResolveUserActionResult> {
  const { session, sessionKey, deps } = args;
  const r = resolveUserAction(session.userActions, args.id, args.status, args.by, args.at);
  if (!r.ok) return r;
  session.userActions = r.list;
  const channel = session.channelId;
  if (channel && r.action.slackTs) {
    try {
      const card = buildUserActionCard(r.action, sessionKey);
      await deps.slackApi.updateMessage(channel, r.action.slackTs, card.text, undefined, card.attachments);
    } catch (error) {
      logger.warn('user action card update failed', { sessionKey, id: args.id, error: (error as Error)?.message });
    }
  }
  try {
    deps.persistAndBroadcast?.(sessionKey);
  } catch (error) {
    logger.warn('user action persist/broadcast failed', { sessionKey, error: (error as Error)?.message });
  }
  return r;
}

export type AnswerUserActionCode = 'gone' | 'forbidden' | 'already-resolved' | 'not-delivered';

/**
 * The one answer path for a user action — the Slack card's buttons and the dashboard's: the instruction gate, then
 * first answer wins (card rewritten), then the agent is told through the normal message path. When the agent cannot
 * be told (`notify` false), the action goes back to pending with its buttons, so the human can answer again — an
 * answer is never recorded without reaching the agent.
 */
export async function answerUserAction(args: {
  sessionKey: string;
  id: string;
  status: 'done' | 'failed';
  /** Slack user id of whoever answered. */
  actor: string;
  at: number;
  deps: UserActionHostDeps & {
    getSession(sessionKey: string): ConversationSession | undefined;
    /** The instruction gate: owner, approved for the session, or trusted. */
    mayAnswer(sessionKey: string, session: ConversationSession, actor: string): boolean;
    /** Send `text` to the agent as `actor`'s message; true once it is taken (runs, or queued behind a turn). */
    notify(sessionKey: string, session: ConversationSession, text: string, actor: string): Promise<boolean>;
  };
}): Promise<{ ok: true; action: UserActionRecord } | { ok: false; code: AnswerUserActionCode }> {
  const { sessionKey, deps } = args;
  const session = deps.getSession(sessionKey);
  if (!session) return { ok: false, code: 'gone' };
  if (!deps.mayAnswer(sessionKey, session, args.actor)) return { ok: false, code: 'forbidden' };
  const r = await resolveSessionUserAction({ ...args, session, by: args.actor });
  if (!r.ok) return { ok: false, code: r.reason === 'already-resolved' ? 'already-resolved' : 'gone' };
  let delivered = false;
  try {
    delivered = await deps.notify(sessionKey, session, userActionResolvedPrompt(r.action), args.actor);
  } catch (error) {
    logger.warn('user action answer could not reach the agent', { sessionKey, id: args.id, error: (error as Error)?.message });
  }
  if (delivered) return { ok: true, action: r.action };
  // Back to pending: the card gets its buttons again and the dashboard shows it waiting.
  session.userActions = unresolveUserAction(session.userActions, args.id);
  const back = session.userActions.find((a) => a.id === args.id);
  if (back && session.channelId && back.slackTs) {
    try {
      const card = buildUserActionCard(back, sessionKey);
      await deps.slackApi.updateMessage(session.channelId, back.slackTs, card.text, undefined, card.attachments);
    } catch (error) {
      logger.warn('user action card restore failed', { sessionKey, id: args.id, error: (error as Error)?.message });
    }
  }
  try {
    deps.persistAndBroadcast?.(sessionKey);
  } catch (error) {
    logger.warn('user action persist/broadcast failed', { sessionKey, error: (error as Error)?.message });
  }
  return { ok: false, code: 'not-delivered' };
}

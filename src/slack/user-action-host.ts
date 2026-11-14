/**
 * Host side of user actions (`instruct_user`): the MCP server validates and inspects; this keeps the record on the
 * session (`session.userActions`, apart from the pending question), posts its Slack card, and answers its buttons.
 * Every change is persisted and pushed to the dashboard through `persistAndBroadcast`.
 */
import {
  appendUserAction,
  INSTRUCT_USER_TOOL_NAME,
  parseInstructUserToolResult,
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
 * Take every successful `instruct_user` result of a tool batch: store it first (so a press on its card always finds it),
 * post its card when the session has a Slack thread (one retry), stamp the card's ts on the stored record without
 * undoing an answer that came in meanwhile, then persist and broadcast. A result already stored (a replay) is not
 * posted again. A card that still fails keeps the record — the dashboard shows it and answers it.
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
    if (!action || session.userActions?.some((a) => a.id === action.id)) continue;
    session.userActions = appendUserAction(session.userActions, action);
    captured.push(action);
    if (!channel) continue;
    const card = buildUserActionCard(action, sessionKey);
    let ts: string | undefined;
    for (let attempt = 1; attempt <= 2 && !ts; attempt++) {
      try {
        const post = await deps.slackApi.postMessage(channel, card.text, {
          threadTs,
          attachments: card.attachments,
          unfurlLinks: false,
          unfurlMedia: false,
        });
        ts = post.ts;
        if (!ts) break;
      } catch (error) {
        logger.warn('user action card post failed', {
          sessionKey,
          id: action.id,
          attempt,
          error: (error as Error)?.message ?? String(error),
        });
      }
    }
    if (ts) {
      // The record as it is now (it may have been answered while the post was in flight) gets the ts.
      session.userActions = (session.userActions ?? []).map((a) => (a.id === action.id ? { ...a, slackTs: ts } : a));
    }
  }
  if (captured.length) {
    try {
      deps.persistAndBroadcast?.(sessionKey);
    } catch (error) {
      logger.warn('user action persist/broadcast failed', { sessionKey, error: (error as Error)?.message });
    }
  }
  return (session.userActions ?? []).filter((a) => captured.some((c) => c.id === a.id));
}

export type AnswerUserActionCode = 'gone' | 'forbidden' | 'already-resolved' | 'not-delivered';

/** Hands an answer to the agent as `actor`'s message in the session's thread; true once it is taken. */
export type UserActionNotifier = (sessionKey: string, text: string, actor: string) => Promise<boolean>;
let userActionNotifier: UserActionNotifier | undefined;
/**
 * The host's notifier (src/index.ts): the thread's normal message path with a real acceptance signal (its turn reached
 * the model, or it is queued behind a running one). Both answer surfaces use it, so "taken" means the same everywhere.
 */
export function setUserActionNotifier(fn: UserActionNotifier | undefined): void {
  userActionNotifier = fn;
}
export function getUserActionNotifier(): UserActionNotifier | undefined {
  return userActionNotifier;
}

/**
 * The one answer path for a user action — the Slack card's buttons and the dashboard's. The instruction gate; then the
 * answer is held in memory (a second press sees it answered) while the agent is told; only once the message is taken is
 * it recorded — card rewritten without buttons, persisted, broadcast. When the agent cannot be told, nothing was
 * written: the action is pending again, its card untouched, so the human answers again. An answer never sticks unheard.
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
  const r = resolveUserAction(session.userActions, args.id, args.status, args.actor, args.at);
  if (!r.ok) return { ok: false, code: r.reason === 'already-resolved' ? 'already-resolved' : 'gone' };
  session.userActions = r.list;
  let delivered = false;
  try {
    delivered = await deps.notify(sessionKey, session, userActionResolvedPrompt(r.action), args.actor);
  } catch (error) {
    logger.warn('user action answer could not reach the agent', {
      sessionKey,
      id: args.id,
      error: (error as Error)?.message,
    });
  }
  if (!delivered) {
    session.userActions = unresolveUserAction(session.userActions, args.id);
    return { ok: false, code: 'not-delivered' };
  }
  const recorded = session.userActions.find((a) => a.id === args.id) ?? r.action;
  if (session.channelId && recorded.slackTs) {
    try {
      const card = buildUserActionCard(recorded, sessionKey);
      await deps.slackApi.updateMessage(session.channelId, recorded.slackTs, card.text, undefined, card.attachments);
    } catch (error) {
      logger.warn('user action card update failed', { sessionKey, id: args.id, error: (error as Error)?.message });
    }
  }
  try {
    deps.persistAndBroadcast?.(sessionKey);
  } catch (error) {
    logger.warn('user action persist/broadcast failed', { sessionKey, error: (error as Error)?.message });
  }
  return { ok: true, action: recorded };
}

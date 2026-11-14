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
      const now = session.userActions.find((a) => a.id === action.id);
      if (now && now.status !== 'pending') {
        // Answered (from the dashboard) before the card existed: the card shows that answer, without buttons.
        try {
          const answered = buildUserActionCard(now, sessionKey);
          await deps.slackApi.updateMessage(channel, ts, answered.text, undefined, answered.attachments);
        } catch (error) {
          logger.warn('user action card catch-up failed', {
            sessionKey,
            id: action.id,
            error: (error as Error)?.message,
          });
        }
      }
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

export type AnswerUserActionCode = 'gone' | 'forbidden' | 'already-resolved' | 'in-flight' | 'not-delivered';

/** Answers being handed to the agent, by `sessionKey\0id`: a lock apart from the stored record, never persisted. */
const answersInFlight = new Set<string>();

/**
 * A notifier over the host's message injection: true once `onAccepted` fires (the turn reached the model, or it is
 * queued behind a running one); false when the injection settles or fails without it. Settling after acceptance
 * changes nothing.
 */
export function notifierFromInjection(
  inject: (sessionKey: string, text: string, actor: string, onAccepted: () => void) => Promise<unknown>,
): UserActionNotifier {
  return (sessionKey, text, actor) =>
    new Promise<boolean>((resolve) => {
      inject(sessionKey, text, actor, () => resolve(true)).then(
        () => resolve(false),
        () => resolve(false),
      );
    });
}

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
 * The one answer path for a user action — the Slack card's buttons and the dashboard's. The instruction gate; then a
 * lock held apart from the stored record (a second press meanwhile is refused as in flight; the record stays pending
 * on disk whatever else saves) while the agent is told; only once the message is taken is the answer written — record,
 * card without buttons, persist, broadcast. Not taken: nothing was written, the lock is released, the human answers
 * again. An answer never sticks unheard, and a restart mid-way leaves it answerable.
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
  const lock = `${sessionKey}\u0000${args.id}`;
  if (answersInFlight.has(lock)) return { ok: false, code: 'in-flight' };
  // Checked on a copy: the stored record is not touched until the agent took the answer.
  const preview = resolveUserAction(session.userActions, args.id, args.status, args.actor, args.at);
  if (!preview.ok) return { ok: false, code: preview.reason === 'already-resolved' ? 'already-resolved' : 'gone' };
  answersInFlight.add(lock);
  let delivered = false;
  try {
    delivered = await deps.notify(sessionKey, session, userActionResolvedPrompt(preview.action), args.actor);
  } catch (error) {
    logger.warn('user action answer could not reach the agent', {
      sessionKey,
      id: args.id,
      error: (error as Error)?.message,
    });
  } finally {
    answersInFlight.delete(lock);
  }
  if (!delivered) return { ok: false, code: 'not-delivered' };
  // Taken: write it now, against the record as it is now.
  const r = resolveUserAction(session.userActions, args.id, args.status, args.actor, args.at);
  if (!r.ok) return { ok: false, code: r.reason === 'already-resolved' ? 'already-resolved' : 'gone' };
  session.userActions = r.list;
  const recorded = r.action;
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

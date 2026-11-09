/**
 * Questions the model asked for an admin, as dashboard admin approvals (#1070).
 *
 * The model asks with `ASK_USER_QUESTION` and `audience: 'admins'` when the decision belongs to an admin (an
 * approval, a privileged step). The question still goes to its Slack thread; this adapter also lists it on the
 * 관리자 승인 screen, which only admins see, and answers it through the same path the dashboard's session view
 * takes (`ChoiceActionHandler.handleChoiceFromDashboard`). So a card answer rewrites the Slack question (naming the
 * admin) and the session continues with it, and an answer anywhere else takes the card away.
 *
 * The answer turn runs as the session's owner, not the admin: the admin decides, the owner's session carries on
 * with the owner's own permissions. The card resolves as soon as the question is claimed for the answer.
 *
 * Only a single-choice question is listed (a multi-question form stays in its thread).
 */

import { normalizeDecisionFields } from 'somalib/model-commands/validator';
import type { AdminApproval, AdminApprovalAdapter, AdminApprovalResolution } from '../admin-approvals';
import { isAdminUser } from '../admin-utils';
import { Logger } from '../logger';
import type { ConversationSession, UserChoice } from '../types';
import { isAnswerableFromDashboard } from './actions/choice-action-handler';

const logger = new Logger('SessionQuestionAdminApproval');

/** Answers given through this adapter, newest last; enough for the 10-minute resolved window. */
const RESOLVED_KEEP = 50;
/** `<sessionKey>~<stamp>`: the stamp tells this question apart from the next one in the same session. */
const STAMP_SEP = '~';

type Answer = (
  sessionKey: string,
  choiceId: string,
  label: string,
  question: string,
  actor: string,
  opts: { adminAnswer: boolean; onClaimed: () => void },
) => Promise<void>;

export interface SessionQuestionDeps {
  /** Every live session with its key. */
  sessions(): Iterable<[string, ConversationSession]>;
  /** `ChoiceActionHandler.handleChoiceFromDashboard`. */
  answer: Answer;
  now?: () => number;
}

/** The question asked for admins that the session is waiting on, if any. */
function adminQuestion(session: ConversationSession): UserChoice | undefined {
  const q = session.actionPanel?.pendingQuestion;
  if (q?.type !== 'user_choice' || q.audience !== 'admins') return undefined;
  return isAnswerableFromDashboard(session, 'user_choice') ? q : undefined;
}

/** Which question this is: its Slack message, else when it was asked. */
function stampOf(session: ConversationSession): string {
  const pc = session.actionPanel?.pendingChoice;
  return pc?.choiceTs || session.actionPanel?.choiceMessageTs || String(pc?.createdAt ?? 0);
}

function toApproval(sessionKey: string, session: ConversationSession, q: UserChoice): AdminApproval {
  const threadTs = session.threadRootTs || session.threadTs;
  // #1073 — the same decision lines the session view and the Slack card show.
  const decision = normalizeDecisionFields(q);
  return {
    id: `session_question:${sessionKey}${STAMP_SEP}${stampOf(session)}`,
    kind: 'session_question',
    card: 'question',
    title: q.question,
    ...(q.context ? { description: q.context } : {}),
    choices: q.choices.map((c) => ({
      id: c.id,
      label: c.label,
      ...(c.description ? { description: c.description } : {}),
    })),
    ...(q.recommendedChoiceId ? { recommendedId: q.recommendedChoiceId } : {}),
    ...(Object.keys(decision).length ? { decision } : {}),
    requesterId: session.ownerId ?? '',
    ...(session.channelId ? { place: { channel: session.channelId, ...(threadTs ? { threadTs } : {}) } } : {}),
    createdAt: session.actionPanel?.pendingChoice?.createdAt ?? 0,
  };
}

/** The dashboard choice path signals its refusals with these messages. */
function refusalOf(error: unknown): 'not_found' | 'already_answered' | 'invalid' | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'Session not found') return 'not_found';
  if (message === 'Session is not waiting for a choice') return 'already_answered';
  if (message === 'Invalid choice ID' || message === 'Not an admin question') return 'invalid';
  return undefined;
}

export function sessionQuestionAdminApprovalAdapter(deps: SessionQuestionDeps): AdminApprovalAdapter {
  const clock = deps.now ?? Date.now;
  const answered: AdminApprovalResolution[] = [];

  function find(requestId: string): { sessionKey: string; session?: ConversationSession; stamp: string } | null {
    const sep = requestId.lastIndexOf(STAMP_SEP);
    if (sep <= 0) return null;
    const sessionKey = requestId.slice(0, sep);
    const stamp = requestId.slice(sep + 1);
    for (const [key, session] of deps.sessions()) {
      if (key === sessionKey) return { sessionKey, session, stamp };
    }
    return { sessionKey, stamp };
  }

  return {
    kind: 'session_question',
    pending() {
      const out: AdminApproval[] = [];
      for (const [sessionKey, session] of deps.sessions()) {
        const q = adminQuestion(session);
        if (q) out.push(toApproval(sessionKey, session, q));
      }
      return out;
    },
    resolved(since) {
      return answered.filter((r) => r.at >= since);
    },
    async answer(requestId, choiceId, actor) {
      if (!isAdminUser(actor)) return { ok: false, reason: 'forbidden' };
      const found = find(requestId);
      if (!found) return { ok: false, reason: 'invalid' };
      const { sessionKey, session, stamp } = found;
      if (!session) return { ok: false, reason: 'not_found' };
      const id = `session_question:${requestId}`;
      const q = adminQuestion(session);
      // Answered (or replaced by a newer question) since the card was listed.
      if (!q || stampOf(session) !== stamp) {
        const resolution = answered.find((r) => r.id === id);
        return { ok: false, reason: 'already_answered', ...(resolution ? { resolution } : {}) };
      }
      const choice = q.choices.find((c) => c.id === choiceId);
      if (!choice) return { ok: false, reason: 'invalid' };
      // The answer is taken once the question is claimed for it; the turn it starts (minutes, maybe) runs on.
      let markClaimed: () => void = () => {};
      const claimed = new Promise<void>((resolve) => {
        markClaimed = resolve;
      });
      const run = deps.answer(sessionKey, choiceId, choice.label, q.question, actor, {
        adminAnswer: true,
        onClaimed: markClaimed,
      });
      try {
        await Promise.race([claimed, run]);
      } catch (error) {
        const reason = refusalOf(error);
        if (!reason) throw error;
        logger.info('Admin answer to a session question refused', { sessionKey, reason });
        return { ok: false, reason };
      }
      run.catch((error: unknown) =>
        logger.warn('The turn an admin answer started failed', { sessionKey, error: String(error) }),
      );
      answered.push({ id, outcome: 'approved', choiceId, by: actor, via: 'dashboard', at: clock() });
      if (answered.length > RESOLVED_KEEP) answered.splice(0, answered.length - RESOLVED_KEEP);
      return { ok: true, outcome: 'approved' };
    },
  };
}

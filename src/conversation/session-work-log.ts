/**
 * The work-log pipeline a turn's entry goes through (#598 ④b, design 598b
 * v5 §4.1), extracted from the process-wide `appendWorkLog` provider so a
 * Slack-less task's writer can keep the store's promise.
 *
 * Before the store sees the entry: stamp the agent that made it (spec 12), push
 * the card when a tool count grew, refresh a working subagent's spend, and
 * capture the model's files and markdown answers as dashboard artifacts
 * (SSOT 2026-10-23 T1/T7). Then append. The Slack provider swallows the
 * returned promise as before; the task writer tracks it as a receipt.
 */
import { stampWorkLogAgent } from '../session/agent-registry';
import type { ConversationSession } from '../types';
import { captureArtifactFromWorkLog } from './artifact-capture';
import { appendWorkLog, type WorkLogEntry, type WorkLogInput } from './work-log';

export interface SessionWorkLogDeps {
  getAllSessions(): Map<string, ConversationSession>;
  /** Push the session's card (throttled by the caller). */
  scheduleLiveSessionUpdate(sessionKey: string): void;
  /** Re-read a working subagent's spend (throttled by the caller). */
  refreshAgentSpend(sessionKey: string, session: ConversationSession, force: boolean): void;
}

export type SessionWorkLogAppender = (conversationId: string, entry: WorkLogInput) => Promise<WorkLogEntry>;

export function createSessionWorkLogAppender(deps: SessionWorkLogDeps): SessionWorkLogAppender {
  return (conversationId, entry) => {
    // SSOT 2026-10-22 T7/T10: the entry carries the task in progress (the
    // dashboard folds the log under it) and a tool call counts on that task.
    // Spec 12: the task — and the tool count — of the agent that made the
    // entry: a subagent's own ledger, the session's for the main agent.
    let owner: ConversationSession | undefined;
    let ownerKey: string | undefined;
    for (const [key, session] of deps.getAllSessions()) {
      if (session.conversationId === conversationId) {
        owner = session;
        ownerKey = key;
        break;
      }
    }
    const stamped = stampWorkLogAgent(owner ?? {}, entry, Date.now());
    // A node's tool count grew — a subagent's, or the main agent's (the
    // registry root): push the card (throttled, ≤ 1/s per session).
    if (entry.kind === 'tool' && ownerKey) deps.scheduleLiveSessionUpdate(ownerKey);
    // A subagent is working: its spend may have grown (throttled read).
    if (entry.agentId && owner && ownerKey) deps.refreshAgentSpend(ownerKey, owner, false);
    // SSOT 2026-10-23 T1/T7: files the model sends to Slack and its markdown
    // answers become dashboard artifacts. Before the store sees it, while
    // `entry` still has the whole final text (the work log caps it).
    void captureArtifactFromWorkLog(conversationId, entry);
    return appendWorkLog(conversationId, stamped);
  };
}

/**
 * #767 — an instruction sent into someone else's work thread waits for the
 * thread owner's approval.
 *
 * "Someone else" is anyone who is not the session's owner. Their instruction
 * (a Slack thread reply, a dashboard instruction, a drained queue item, a
 * Slack-less task's command or answer) is HELD here instead of running. The
 * owner is asked once per person and session — by Slack DM and on the
 * dashboard card — and answers one of four ways:
 *
 *   - approve         — run the held instructions, this time only;
 *   - approve_session — run them, and never ask again in this session
 *                       (`session.approvedInstructors`, saved with the sessions);
 *   - approve_always  — run them, and never ask again in any of the owner's
 *                       sessions (the owner's trusted list in personal settings,
 *                       removable on the dashboard settings page);
 *   - deny            — drop them, and tell the thread.
 *
 * Exactly once: the Slack buttons and the dashboard route run in this one
 * daemon process, so {@link InstructionApprovals.answer} checks and decides
 * synchronously and writes the decision to disk before any side effect. A
 * decision that cannot be written decides nothing.
 *
 * A one-time approval is not a grant: the released instruction carries the
 * request id (`routeContext.instructionApprovalId`) and every gate re-checks it
 * here — the request was approved, by this session's owner, for this sender,
 * and it held this very message. A made-up id releases nothing.
 */

import { randomUUID } from 'node:crypto';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { Logger } from './logger';
import {
  buildInstructionApprovalDm,
  buildInstructionApprovalEndedDm,
  buildInstructionApprovalResolvedDm,
  type InstructionApprovalDecision,
  type InstructionApprovalSurface,
  type InstructionApprovalView,
  instructionDecidedNotice,
  instructionHeldNotice,
  isInstructionApprovalDecision,
  type SlackMessage,
} from './slack/instruction-approval-blocks';
import type { TaskAnswer } from './task-turn/task-answer';

export type { InstructionApprovalDecision, InstructionApprovalSurface } from './slack/instruction-approval-blocks';
export { INSTRUCTION_APPROVAL_DECISIONS, isInstructionApprovalDecision } from './slack/instruction-approval-blocks';

const logger = new Logger('InstructionApprovals');

/** How long a request waits for the owner. */
export const INSTRUCTION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an ended request is kept (a late click reads "already answered", not "not found"). */
const ENDED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The most instructions one request holds; more are refused with a notice. */
export const MAX_HELD_INSTRUCTIONS = 20;
const PREVIEW_CHARS = 300;

/** One held instruction, as it will run once approved. */
export type HeldInstruction =
  /** A Slack-thread message (a reply, a dashboard instruction echoed to the thread). `event` is the original MessageEvent. */
  | { kind: 'message'; ts: string; text: string; at: number; event: Record<string, unknown> }
  /** A Slack-less task's instruction (`POST …/command`). */
  | { kind: 'task-command'; text: string; at: number }
  /** A Slack-less task's answer to its open question. */
  | { kind: 'task-answer'; askId: string; answer: TaskAnswer; at: number };

export type InstructionApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface InstructionApprovalRequest {
  requestId: string;
  sessionKey: string;
  /** The session's owner when asked — the only one who may answer. */
  ownerId: string;
  requesterId: string;
  requesterName?: string;
  /** The session's Slack thread (none for a Slack-less task). */
  channel?: string;
  threadTs?: string;
  sessionTitle?: string;
  held: HeldInstruction[];
  createdAt: number;
  expiresAt: number;
  status: InstructionApprovalStatus;
  decision?: InstructionApprovalDecision;
  decidedBy?: string;
  decidedVia?: InstructionApprovalSurface;
  decidedAt?: number;
  /** Where the owner's DM landed (rewritten when the request ends). */
  dmRef?: { channel: string; ts: string };
}

/** The pending request as the dashboard card shows it — no instruction beyond a short preview. */
export interface DashboardInstructionApproval {
  requestId: string;
  ownerId: string;
  requesterId: string;
  requesterName?: string;
  /** How many instructions wait. */
  count: number;
  /** The first instruction's words, capped. */
  preview: string;
  createdAt: number;
  expiresAt: number;
}

/** The session fields the gate reads. */
export interface InstructionGateSession {
  ownerId?: string;
  approvedInstructors?: string[];
  channelId?: string;
  threadTs?: string;
  title?: string;
  summaryTitle?: string;
}

export interface InstructionApprovalDeps {
  /** `DATA_DIR/instruction-approvals.json` in production. */
  storeFile: string;
  now?: () => number;
  ttlMs?: number;
  /** The live session by key (none once it was closed). */
  getSession(sessionKey: string): InstructionGateSession | undefined;
  /** Persist the sessions after a session approval. */
  saveSessions(): void;
  /** Is `userId` on `ownerId`'s always-approve list? */
  isTrusted(ownerId: string, userId: string): boolean;
  /** Put `entry` on `ownerId`'s always-approve list; `false` when it could not be added (the list is full). */
  trust(ownerId: string, entry: { userId: string; name?: string }): boolean | void;
  /** DM the owner; resolves where the DM landed. */
  postOwnerDm?(ownerId: string, message: SlackMessage): Promise<{ channel: string; ts: string } | undefined>;
  updateDm?(ref: { channel: string; ts: string }, message: SlackMessage): Promise<unknown>;
  postThreadNotice?(target: { channel: string; threadTs: string }, text: string): Promise<unknown>;
  /** Add (or with `remove`, take off) a reaction on a held Slack message. */
  react?(target: { channel: string; ts: string }, name: string, remove?: boolean): Promise<unknown>;
  /**
   * Run one held instruction now (an approved request). A `{ ok: false }`
   * result (the task was busy, the question changed) is reported on the DM.
   */
  release(request: InstructionApprovalRequest, held: HeldInstruction): Promise<void | { ok: false; reason: string }>;
  /** Push the dashboard board. */
  broadcast?(): void;
  /** The thread permalink and dashboard link the DM shows. */
  links?(request: InstructionApprovalRequest): { threadUrl?: string; dashboardUrl?: string };
}

export type InstructionApprovalAnswer =
  | {
      ok: true;
      decision: InstructionApprovalDecision;
      request: InstructionApprovalRequest;
      /** The side effects (DM, thread, the released instructions' dispatch) — tests await it. */
      done: Promise<void>;
    }
  | {
      ok: false;
      reason: 'invalid' | 'not_found' | 'not_owner' | 'already_answered' | 'expired' | 'session_gone' | 'unavailable';
      request?: InstructionApprovalRequest;
    };

export interface HoldResult {
  requestId: string;
  /** A new request (the owner was asked) — false when the words joined a pending one. */
  created: boolean;
  /** `full`: the request already holds {@link MAX_HELD_INSTRUCTIONS}; this one was not kept. */
  refused?: 'full';
}

interface StoreDoc {
  version: 1;
  requests: Record<string, InstructionApprovalRequest>;
}

function validateDoc(raw: unknown): StoreDoc {
  const doc = raw as Partial<StoreDoc> | null;
  if (!doc || typeof doc !== 'object' || !doc.requests || typeof doc.requests !== 'object') {
    throw new Error('instruction approvals: not a store document');
  }
  const requests: Record<string, InstructionApprovalRequest> = {};
  for (const [id, r] of Object.entries(doc.requests)) {
    if (
      r &&
      typeof r === 'object' &&
      r.requestId === id &&
      typeof r.sessionKey === 'string' &&
      typeof r.ownerId === 'string' &&
      typeof r.requesterId === 'string' &&
      Array.isArray(r.held) &&
      typeof r.status === 'string'
    ) {
      requests[id] = r;
    }
  }
  return { version: 1, requests };
}

/** What the owner reads of one held instruction. */
function textOf(held: HeldInstruction): string {
  if (held.kind !== 'task-answer') return held.text;
  const a = held.answer;
  if (a.kind === 'single') return `(질문에 답: ${a.choiceId})`;
  if (a.kind === 'multi') {
    return `(질문에 답: ${Object.values(a.selections)
      .map((v) => v.label)
      .join(', ')})`;
  }
  return '(질문에 추천 답으로 응답)';
}

/** A thread line with ⚠️ lines appended. */
function withNoteLines(text: string, notes: string[]): string {
  return notes.length ? `${text}\n${notes.map((n) => `⚠️ ${n}`).join('\n')}` : text;
}

/** A DM message with ⚠️ lines appended (text and a block of its own). */
function withNotes(message: SlackMessage, notes: string[]): SlackMessage {
  if (!notes.length) return message;
  const lines = notes.map((n) => `⚠️ ${n}`).join('\n');
  return {
    text: `${message.text}\n${lines}`,
    blocks: [...(message.blocks ?? []), { type: 'context', elements: [{ type: 'mrkdwn', text: lines }] }],
  };
}

function heldKey(held: HeldInstruction): string | undefined {
  return held.kind === 'message' ? `m:${held.ts}` : undefined;
}

export class InstructionApprovals {
  private readonly requests: Map<string, InstructionApprovalRequest>;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly deps: InstructionApprovalDeps) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? INSTRUCTION_APPROVAL_TTL_MS;
    this.requests = new Map(Object.entries(this.load().requests));
  }

  private load(): StoreDoc {
    try {
      return readJsonWithBackup(this.deps.storeFile, validateDoc) ?? { version: 1, requests: {} };
    } catch (error) {
      // Unreadable: start empty (held instructions are lost, nothing runs unasked) and keep the file for inspection.
      logger.error('Instruction approval store unreadable — starting empty', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { version: 1, requests: {} };
    }
  }

  /** Write every request (pruning long-ended ones). Throws when the write fails. */
  private save(): void {
    const t = this.now();
    for (const [id, r] of this.requests) {
      const endedAt = r.status === 'pending' ? r.expiresAt : (r.decidedAt ?? r.expiresAt);
      if (t - endedAt > ENDED_KEEP_MS) this.requests.delete(id);
    }
    atomicWriteJson(this.deps.storeFile, { version: 1, requests: Object.fromEntries(this.requests) });
  }

  private saveQuietly(context: string): void {
    try {
      this.save();
    } catch (error) {
      logger.error(`Instruction approval store write failed (${context})`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private isLive(r: InstructionApprovalRequest): boolean {
    return r.status === 'pending' && r.expiresAt > this.now();
  }

  /** One request by id (any status). */
  get(requestId: string): InstructionApprovalRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * Does `senderId`'s instruction run in this session without asking? Yes for
   * the owner, a person approved for this session, a person on the owner's
   * trusted list, and a message a one-time approval released.
   */
  allows(input: {
    sessionKey: string;
    session: InstructionGateSession | undefined;
    senderId: string | undefined;
    approvalId?: string;
    ts?: string;
  }): boolean {
    const { session, senderId } = input;
    const ownerId = session?.ownerId;
    // No owner on record (or no sender): nobody to ask, nobody to protect from.
    if (!ownerId || !senderId) return true;
    if (senderId === ownerId) return true;
    if (session.approvedInstructors?.includes(senderId)) return true;
    if (this.deps.isTrusted(ownerId, senderId)) return true;
    if (input.approvalId) {
      const r = this.requests.get(input.approvalId);
      if (
        r &&
        r.status === 'approved' &&
        r.sessionKey === input.sessionKey &&
        r.ownerId === ownerId &&
        r.requesterId === senderId &&
        input.ts !== undefined &&
        r.held.some((h) => h.kind === 'message' && h.ts === input.ts)
      ) {
        return true;
      }
    }
    return false;
  }

  /** The request the person is waiting on in this session, if one is live. */
  private livePendingFor(sessionKey: string, requesterId: string): InstructionApprovalRequest | undefined {
    for (const r of this.requests.values()) {
      if (r.sessionKey === sessionKey && r.requesterId === requesterId && this.isLive(r)) return r;
    }
    return undefined;
  }

  private viewOf(r: InstructionApprovalRequest): InstructionApprovalView {
    const links = this.deps.links?.(r) ?? {};
    return {
      requestId: r.requestId,
      ownerId: r.ownerId,
      requesterId: r.requesterId,
      ...(r.requesterName ? { requesterName: r.requesterName } : {}),
      ...(r.sessionTitle ? { sessionTitle: r.sessionTitle } : {}),
      texts: r.held.map(textOf),
      ...links,
      ...(r.decision ? { decision: r.decision } : {}),
      ...(r.decidedVia ? { decidedVia: r.decidedVia } : {}),
    };
  }

  private threadOf(r: InstructionApprovalRequest): { channel: string; threadTs: string } | undefined {
    return r.channel && r.threadTs ? { channel: r.channel, threadTs: r.threadTs } : undefined;
  }

  /**
   * Hold `instruction` until the owner answers. The first held instruction of
   * a person in a session asks the owner (DM) and tells the thread; later ones
   * join the same request and refresh the DM. Never runs anything.
   */
  async hold(input: {
    sessionKey: string;
    session: InstructionGateSession;
    senderId: string;
    senderName?: string;
    instruction: HeldInstruction;
  }): Promise<HoldResult> {
    const { sessionKey, session, senderId, instruction } = input;
    const t = this.now();
    this.endExpired(sessionKey, senderId);
    let request = this.livePendingFor(sessionKey, senderId);
    const created = !request;
    if (!request) {
      request = {
        requestId: `iap_${randomUUID().replace(/-/g, '')}`,
        sessionKey,
        ownerId: session.ownerId as string,
        requesterId: senderId,
        ...(input.senderName ? { requesterName: input.senderName } : {}),
        ...(session.channelId && session.threadTs ? { channel: session.channelId, threadTs: session.threadTs } : {}),
        ...((session.summaryTitle || session.title) && { sessionTitle: session.summaryTitle || session.title }),
        held: [],
        createdAt: t,
        expiresAt: t + this.ttlMs,
        status: 'pending',
      };
      this.requests.set(request.requestId, request);
    }
    const key = heldKey(instruction);
    if (key && request.held.some((h) => heldKey(h) === key)) {
      // A redelivery of a message already held.
      return { requestId: request.requestId, created: false };
    }
    if (request.held.length >= MAX_HELD_INSTRUCTIONS) {
      return { requestId: request.requestId, created: false, refused: 'full' };
    }
    request.held.push(instruction);
    // Held in memory either way: an unsaved hold is lost on a restart, never run.
    this.saveQuietly('hold');

    if (instruction.kind === 'message') {
      void this.bestEffort('react', () =>
        this.deps.react?.(
          { channel: String(instruction.event.channel ?? request.channel ?? ''), ts: instruction.ts },
          'hourglass_flowing_sand',
        ),
      );
    }
    if (created) {
      const thread = this.threadOf(request);
      if (thread) {
        await this.bestEffort('thread notice', () =>
          this.deps.postThreadNotice?.(thread, instructionHeldNotice(request)),
        );
      }
      await this.askOwner(request);
    } else if (request.dmRef) {
      const ref = request.dmRef;
      await this.bestEffort('DM refresh', () =>
        this.deps.updateDm?.(ref, buildInstructionApprovalDm(this.viewOf(request))),
      );
    }
    this.deps.broadcast?.();
    return { requestId: request.requestId, created };
  }

  private async askOwner(request: InstructionApprovalRequest): Promise<void> {
    if (!this.deps.postOwnerDm) return;
    let ref: { channel: string; ts: string } | undefined;
    try {
      ref = await this.deps.postOwnerDm(request.ownerId, buildInstructionApprovalDm(this.viewOf(request)));
    } catch (error) {
      logger.warn('Instruction approval DM failed — the dashboard card still asks', {
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!ref) return;
    if (request.status !== 'pending') {
      // Answered on the dashboard while the DM was on its way: the DM says how at once.
      void this.bestEffort('late DM rewrite', () => this.deps.updateDm?.(ref, this.endedDm(request)));
      return;
    }
    request.dmRef = ref;
    this.saveQuietly('DM ref');
  }

  private endedDm(r: InstructionApprovalRequest): SlackMessage {
    if (r.status === 'expired')
      return buildInstructionApprovalEndedDm(this.viewOf(r), '응답 시간이 지났거나 세션이 끝났습니다');
    return buildInstructionApprovalResolvedDm(this.viewOf(r));
  }

  /** Mark this person's expired requests in this session ended, and rewrite their DMs. */
  private endExpired(sessionKey: string, requesterId: string): void {
    const t = this.now();
    let changed = false;
    for (const r of this.requests.values()) {
      if (r.sessionKey !== sessionKey || r.requesterId !== requesterId) continue;
      if (r.status !== 'pending' || r.expiresAt > t) continue;
      r.status = 'expired';
      r.decidedAt = t;
      changed = true;
      const ref = r.dmRef;
      if (ref) void this.bestEffort('expired DM rewrite', () => this.deps.updateDm?.(ref, this.endedDm(r)));
    }
    if (changed) this.saveQuietly('expire');
  }

  /**
   * The owner's answer, from the DM or the dashboard. Decided and written
   * before it returns; the DM rewrite, the thread line and the released
   * instructions follow in `done`.
   */
  answer(input: {
    requestId: string;
    decision: InstructionApprovalDecision;
    actor: string | undefined;
    surface: InstructionApprovalSurface;
  }): InstructionApprovalAnswer {
    const { requestId, decision, actor, surface } = input;
    if (!actor || !isInstructionApprovalDecision(decision)) return { ok: false, reason: 'invalid' };
    const request = this.requests.get(requestId);
    if (!request) return { ok: false, reason: 'not_found' };
    if (request.ownerId !== actor) return { ok: false, reason: 'not_owner', request };
    if (request.status !== 'pending') {
      return { ok: false, reason: request.status === 'expired' ? 'expired' : 'already_answered', request };
    }
    if (request.expiresAt <= this.now()) return { ok: false, reason: 'expired', request };
    const session = this.deps.getSession(request.sessionKey);
    if (decision !== 'deny' && (!session || session.ownerId !== request.ownerId)) {
      // Closed (or handed to someone else) since: there is nothing to run the words in.
      request.status = 'expired';
      request.decidedAt = this.now();
      this.saveQuietly('session gone');
      const ref = request.dmRef;
      if (ref) void this.bestEffort('ended DM rewrite', () => this.deps.updateDm?.(ref, this.endedDm(request)));
      this.deps.broadcast?.();
      return { ok: false, reason: 'session_gone', request };
    }

    // Synchronous from here to the save: no other answer can interleave.
    request.status = decision === 'deny' ? 'denied' : 'approved';
    request.decision = decision;
    request.decidedBy = actor;
    request.decidedVia = surface;
    request.decidedAt = this.now();
    try {
      this.save();
    } catch (error) {
      // Not on disk: undo it in memory, so neither surface reports an answer a restart would forget.
      request.status = 'pending';
      delete request.decision;
      delete request.decidedBy;
      delete request.decidedVia;
      delete request.decidedAt;
      logger.error('Instruction approval refused — the decision could not be saved', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: 'unavailable' };
    }

    if (decision === 'approve_session' && session) this.approveForSession(request, session);
    const notes: string[] = [];
    if (decision === 'approve_always') {
      let trusted: boolean | void = false;
      try {
        trusted = this.deps.trust(request.ownerId, {
          userId: request.requesterId,
          ...(request.requesterName ? { name: request.requesterName } : {}),
        });
      } catch (error) {
        logger.error('Could not save the always-approve entry — this request is still approved', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Already on the list counts as on it; a full list or a failed save does not — the DM says so.
      if (trusted === false && !this.deps.isTrusted(request.ownerId, request.requesterId)) {
        notes.push(
          '항상 승인 목록에 넣지 못했습니다(목록이 가득 찼거나 저장에 실패했습니다) — 이번 지시만 승인했습니다. 대시보드 설정에서 목록을 정리한 뒤 다시 승인하세요.',
        );
      }
    }
    this.deps.broadcast?.();
    logger.info('Instruction approval answered', { requestId, decision, surface, held: request.held.length });
    return { ok: true, decision, request, done: this.afterAnswer(request, notes) };
  }

  private approveForSession(request: InstructionApprovalRequest, session: InstructionGateSession): void {
    const list = session.approvedInstructors ?? [];
    if (!list.includes(request.requesterId)) session.approvedInstructors = [...list, request.requesterId];
    try {
      this.deps.saveSessions();
    } catch (error) {
      logger.error('Session approval not saved — it holds until the restart', {
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async afterAnswer(request: InstructionApprovalRequest, notes: string[] = []): Promise<void> {
    const view = this.viewOf(request);
    const ref = request.dmRef;
    const thread = this.threadOf(request);
    const resolvedDm = withNotes(buildInstructionApprovalResolvedDm(view), notes);
    await Promise.all([
      ref ? this.bestEffort('DM rewrite', () => this.deps.updateDm?.(ref, resolvedDm)) : undefined,
      thread
        ? this.bestEffort('thread notice', () =>
            this.deps.postThreadNotice?.(thread, withNoteLines(instructionDecidedNotice(view), notes)),
          )
        : undefined,
    ]);
    for (const held of request.held) {
      if (held.kind === 'message') {
        const target = { channel: String(held.event.channel ?? request.channel ?? ''), ts: held.ts };
        void this.bestEffort('react', () => this.deps.react?.(target, 'hourglass_flowing_sand', true));
        if (request.status === 'denied')
          void this.bestEffort('react', () => this.deps.react?.(target, 'no_entry_sign'));
      }
    }
    if (request.status !== 'approved') return;
    // Started in order without waiting for each turn to finish: the first takes
    // the session, the rest queue behind it as ordinary follow-ups.
    const runs = request.held.map((held) =>
      this.deps.release(request, held).then(
        (result) => (result && result.ok === false ? result.reason : undefined),
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    );
    const failures = (await Promise.all(runs)).filter((r): r is string => typeof r === 'string');
    if (failures.length && ref) {
      const failed = withNotes(resolvedDm, [`실행하지 못한 지시가 있습니다: ${failures.join(' · ').slice(0, 500)}`]);
      await this.bestEffort('DM failure note', () => this.deps.updateDm?.(ref, failed));
    }
  }

  private async bestEffort(what: string, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (error) {
      logger.warn(`Instruction approval ${what} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The live requests of one session, for its dashboard card (oldest first). */
  pendingFor(sessionKey: string): DashboardInstructionApproval[] {
    const out: DashboardInstructionApproval[] = [];
    for (const r of this.requests.values()) {
      if (r.sessionKey !== sessionKey || !this.isLive(r)) continue;
      const first = r.held[0] ? textOf(r.held[0]).trim() : '';
      out.push({
        requestId: r.requestId,
        ownerId: r.ownerId,
        requesterId: r.requesterId,
        ...(r.requesterName ? { requesterName: r.requesterName } : {}),
        count: r.held.length,
        preview: first.length > PREVIEW_CHARS ? `${first.slice(0, PREVIEW_CHARS)}…` : first,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
  }
}

// ── The process-wide instance (wired in index.ts) ──

let active: InstructionApprovals | undefined;

export function setInstructionApprovals(instance: InstructionApprovals | undefined): void {
  active = instance;
}

export function getInstructionApprovals(): InstructionApprovals | undefined {
  return active;
}

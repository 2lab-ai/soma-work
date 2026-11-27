/**
 * 보낸 지시 (SSOT 2026-11-27) — every instruction people sent a session, from its first message on. The detail card's
 * round button beside the follow-up queue's shows how many there are; a press lists them, a page at a time, and a row
 * moves 대화 to that instruction.
 *
 *   GET /api/dashboard/session/:conversationId/instructions[?offset=0&limit=30&order=asc|desc]
 *     → 200 { total, offset, nextOffset, order, items: [{ id, n, at, userName?, text, skills?, files? }] }
 *       n is the instruction's number from the first (1); `order=desc` lists the newest first, numbers unchanged.
 *       limit=0 answers the count alone. Unknown conversation → 404.
 *
 * Which user turns are instructions: the ones 대화 draws as a person's message. Not a turn soma-work put there itself
 * (a /compact, a restart resume, an error retry, a goal continuation, a background-work resume, a cron fire, a /renew
 * save or load, any other host turn), and not one a context rollback dropped (`rewoundAt`). The rules are the page's
 * `sysTurnInfo` (dashboard.ts); instruction-history.test.ts runs both over the same turns so the two cannot drift.
 *
 * Who may read: as the session's turns (`/api/dashboard/session/:conversationId`) — any signed-in viewer; a private
 * task's only its owner and the admins (the private-task gate covers this path).
 */

import type { FastifyInstance } from 'fastify';
import { Logger } from '../logger';
import { getConversation } from './recorder';
import type { ConversationTurn } from './types';

const logger = new Logger('InstructionHistory');

/** Rows per page when the query names none, and the most one page holds. */
export const INSTRUCTION_PAGE_DEFAULT = 30;
export const INSTRUCTION_PAGE_MAX = 100;
/** The longest preview a row carries (characters, after the skill blocks and runs of blanks are folded away). */
export const INSTRUCTION_PREVIEW_MAX = 240;
/**
 * The most tags one skill block is read for. The page reads every tag; here the route runs on the shared event loop,
 * and a block of thousands of unclosed tags would make each one a scan to the block's end. Real blocks hold a few.
 */
export const INSTRUCTION_PREVIEW_TAG_MAX = 64;

/** The page's SYS_RESTART_HEADS: how a restart resume or an error retry begins. */
const RESTART_HEADS = [
  'The service was restarted and the previous task was interrupted.',
  '서비스가 재시작되어 이전 작업이 중단되었다.',
  '[재시작 후 자동 재개]',
];

type TurnLike = Pick<ConversationTurn, 'role' | 'rawContent'> &
  Partial<Pick<ConversationTurn, 'origin' | 'compact' | 'rewoundAt'>>;

function decodeSlackEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * A user turn soma-work put there itself — the page's `sysTurnInfo(t) !== null`. A person's turn (origin.by 'user') is
 * never one, except a command they may type themselves that the chat still draws as a host row (/compact, /renew).
 */
export function isHostTurn(t: TurnLike): boolean {
  if (!t || t.role !== 'user') return false;
  const raw = decodeSlackEntities(String(t.rawContent || ''));
  const head = raw.replace(/^\s+/, '');
  const by = t.origin?.by ?? '';
  if (t.compact || (!by && raw.trim() === '/compact')) return true;
  if (head.startsWith('Follow this exact sequence:') && head.includes('skill="local:save"')) return true;
  if (by === 'user') return false;
  if (RESTART_HEADS.some((h) => head.startsWith(h))) return true;
  if (/^\[goal-continuation\]/.test(head)) return true;
  if (/^\[background-work-resume \d+\/\d+\]/.test(head)) return true;
  if (/^\[cron:[^\]]+\]/.test(head)) return true;
  if (head.startsWith("Use 'local:load' skill with this saved context:")) return true;
  return by === 'system';
}

/** A turn 대화 draws as a person's instruction. */
export function isInstructionTurn(t: TurnLike): boolean {
  return !!t && t.role === 'user' && !t.rewoundAt && !isHostTurn(t);
}

/**
 * A row's words: the instruction as 대화 shows it — Slack entities decoded, every closed `<invoked_skills>` block taken
 * out (its skills named instead, as the chat's badges), runs of blanks and line ends folded to one space, cut to `max`.
 * The block rules are the page's `splitInvokedSkills`: each block starts at the last opening tag before its closing
 * one, so a literal mention in the words stays words.
 */
export function instructionPreview(
  rawContent: string,
  max = INSTRUCTION_PREVIEW_MAX,
): { text: string; skills: string[] } {
  const s = decodeSlackEntities(String(rawContent || ''));
  const OPEN = '<invoked_skills>';
  const CLOSE = '</invoked_skills>';
  let text = '';
  const skills: string[] = [];
  let from = 0;
  // Forward only: the next opening tag at or after `from` is kept and looked up again only once `from` passes it, so
  // a run of stray closing tags never rescans what is behind it (no backward search to the start per tag).
  let nextOpen = s.indexOf(OPEN);
  for (;;) {
    const end = s.indexOf(CLOSE, from);
    if (end < 0) {
      text += s.slice(from);
      break;
    }
    if (nextOpen >= 0 && nextOpen < from) nextOpen = s.indexOf(OPEN, from);
    if (nextOpen < 0 || nextOpen > end) {
      // A stray closing tag in the words: words, and look on past it.
      text += s.slice(from, end + CLOSE.length);
      from = end + CLOSE.length;
      continue;
    }
    // The block starts at the last opening tag before its closing one (a literal mention before it stays words).
    let at = nextOpen;
    for (;;) {
      const q = s.indexOf(OPEN, at + 1);
      if (q < 0 || q > end) {
        nextOpen = q;
        break;
      }
      at = q;
    }
    text += s.slice(from, at);
    const inner = s.slice(at + OPEN.length, end);
    // One sticky scan (no slices); a name found unclosed once is never searched for again; at most TAG_MAX tags.
    const tag = /<([^\s<>/]+)>/g;
    const unclosed = new Set<string>();
    let found = 0;
    let tags = 0;
    let i = 0;
    while (i < inner.length && tags < INSTRUCTION_PREVIEW_TAG_MAX) {
      tag.lastIndex = i;
      const m = tag.exec(inner);
      if (!m) break;
      tags++;
      const name = m[1];
      const bodyAt = m.index + m[0].length;
      const bodyEnd = unclosed.has(name) ? -1 : inner.indexOf(`</${name}>`, bodyAt);
      if (bodyEnd < 0) {
        unclosed.add(name);
        i = bodyAt;
        continue;
      }
      found++;
      if (!skills.includes(name)) skills.push(name);
      i = bodyEnd + name.length + 3;
    }
    // A closed block that held no skill is words too.
    if (!found) text += s.slice(at, end + CLOSE.length);
    from = end + CLOSE.length;
  }
  const folded = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(folded);
  return { text: chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : folded, skills };
}

export type InstructionOrder = 'asc' | 'desc';

export interface InstructionRow {
  /** The turn's id — 대화's turn of the same id. */
  id: string;
  /** Its number from the session's first instruction (1). */
  n: number;
  /** When it was sent (epoch ms). */
  at: number;
  userName?: string;
  text: string;
  /** The skills it invoked (the chat's badges), when any. */
  skills?: string[];
  /** How many files it carried, when any. */
  files?: number;
}

export interface InstructionPage {
  total: number;
  offset: number;
  /** The offset of the next page, or null when this one is the last. */
  nextOffset: number | null;
  order: InstructionOrder;
  /** The newest instruction's id — the page tells a rollback that put a new one in its place (same total) by it. */
  lastId: string | null;
  items: InstructionRow[];
}

export interface InstructionQuery {
  offset: number;
  limit: number;
  order: InstructionOrder;
}

/** The query as sent, made safe: offset ≥ 0, 0 ≤ limit ≤ INSTRUCTION_PAGE_MAX, order asc unless desc. */
export function parseInstructionQuery(q: { offset?: string; limit?: string; order?: string } = {}): InstructionQuery {
  const offRaw = q.offset === undefined ? 0 : Number.parseInt(q.offset, 10);
  const limRaw = q.limit === undefined ? INSTRUCTION_PAGE_DEFAULT : Number.parseInt(q.limit, 10);
  return {
    offset: Number.isFinite(offRaw) && offRaw > 0 ? offRaw : 0,
    limit: Number.isFinite(limRaw) ? Math.max(0, Math.min(INSTRUCTION_PAGE_MAX, limRaw)) : INSTRUCTION_PAGE_DEFAULT,
    order: q.order === 'desc' ? 'desc' : 'asc',
  };
}

/** One page of the session's instructions (turns oldest first, as the record keeps them). */
export function instructionPage(turns: readonly ConversationTurn[], q: InstructionQuery): InstructionPage {
  const list = turns.filter(isInstructionTurn);
  const total = list.length;
  const offset = Math.min(q.offset, total);
  const end = Math.min(total, offset + q.limit);
  const items: InstructionRow[] = [];
  for (let k = offset; k < end; k++) {
    const pos = q.order === 'desc' ? total - 1 - k : k;
    const t = list[pos];
    const p = instructionPreview(t.rawContent);
    const row: InstructionRow = { id: String(t.id), n: pos + 1, at: Number(t.timestamp) || 0, text: p.text };
    if (t.userName) row.userName = String(t.userName);
    if (p.skills.length) row.skills = p.skills;
    const files = Array.isArray(t.attachments) ? t.attachments.length : 0;
    if (files) row.files = files;
    items.push(row);
  }
  const lastId = total ? String(list[total - 1].id) : null;
  return { total, offset, nextOffset: end < total ? end : null, order: q.order, lastId, items };
}

export function registerInstructionHistoryRoute(
  server: FastifyInstance,
  authMiddleware: (req: any, reply: any) => Promise<void>,
): void {
  server.get<{
    Params: { conversationId: string };
    Querystring: { offset?: string; limit?: string; order?: string };
  }>(
    '/api/dashboard/session/:conversationId/instructions',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const record = await getConversation(request.params.conversationId);
        if (!record) {
          reply.status(404).send({ error: 'Conversation not found' });
          return;
        }
        reply.header('Cache-Control', 'no-store');
        reply.send(instructionPage(record.turns, parseInstructionQuery(request.query)));
      } catch (error) {
        logger.error('Error listing instructions', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );
}

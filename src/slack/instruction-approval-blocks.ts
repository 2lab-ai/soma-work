/**
 * #767 — the owner's Slack DM for an instruction someone else sent into their
 * work thread, and the lines the thread and the DM read once it is answered.
 *
 * Each button carries ONLY `{ requestId, decision }`. Who asked, which session
 * and which words are read back from the request store
 * (`instruction-approval.ts`) — a forged or replayed payload cannot name
 * another request's instructions or another owner.
 */

/** action_id prefix — the Bolt router (`/^instr_approval_/`) dispatches here. */
export const INSTRUCTION_APPROVAL_ACTION_PREFIX = 'instr_approval_';

export const INSTRUCTION_APPROVAL_DECISIONS = ['approve', 'approve_session', 'approve_always', 'deny'] as const;
export type InstructionApprovalDecision = (typeof INSTRUCTION_APPROVAL_DECISIONS)[number];
export type InstructionApprovalSurface = 'slack' | 'dashboard';

export function isInstructionApprovalDecision(value: unknown): value is InstructionApprovalDecision {
  return typeof value === 'string' && (INSTRUCTION_APPROVAL_DECISIONS as readonly string[]).includes(value);
}

/** The four answers, as the DM and the dashboard card label them. */
export const INSTRUCTION_APPROVAL_LABELS: Record<InstructionApprovalDecision, string> = {
  approve: '✅ 승인',
  approve_session: '🔁 이 세션에서 항상 승인',
  approve_always: '⭐ 이 사람의 지시 항상 승인',
  deny: '🚫 거절',
};

/** What the DM and the thread need to know about one request. */
export interface InstructionApprovalView {
  requestId: string;
  ownerId: string;
  requesterId: string;
  requesterName?: string;
  sessionTitle?: string;
  /** The held instructions' words, oldest first. */
  texts: string[];
  threadUrl?: string;
  dashboardUrl?: string;
  decision?: InstructionApprovalDecision;
  decidedVia?: InstructionApprovalSurface;
}

export interface SlackMessage {
  text: string;
  blocks?: any[];
}

const PREVIEW_ITEMS = 3;
const PREVIEW_CHARS = 300;

/** One instruction's words for a Slack quote: capped, one quote line per line. */
function quote(text: string): string {
  const trimmed = text.trim() || '(첨부만 있는 메시지)';
  const capped = trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS)}…` : trimmed;
  return capped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function previewText(texts: string[]): string {
  const shown = texts.slice(0, PREVIEW_ITEMS).map(quote).join('\n');
  const more = texts.length > PREVIEW_ITEMS ? `\n_외 ${texts.length - PREVIEW_ITEMS}건_` : '';
  return shown + more;
}

function placeLine(view: InstructionApprovalView): string {
  const title = (view.sessionTitle || '작업 스레드').replace(/[<>|]/g, '');
  const parts = [view.threadUrl ? `<${view.threadUrl}|${title}>` : `*${title}*`];
  if (view.dashboardUrl) parts.push(`<${view.dashboardUrl}|대시보드에서 보기>`);
  return parts.join('  ·  ');
}

function button(view: InstructionApprovalView, decision: InstructionApprovalDecision): any {
  const label =
    decision === 'approve_always' && view.requesterName
      ? `⭐ ${view.requesterName}님 지시 항상 승인`
      : INSTRUCTION_APPROVAL_LABELS[decision];
  const el: any = {
    type: 'button',
    text: { type: 'plain_text', text: label.slice(0, 75), emoji: true },
    action_id: `${INSTRUCTION_APPROVAL_ACTION_PREFIX}${decision}`,
    value: JSON.stringify({ requestId: view.requestId, decision }),
  };
  if (decision === 'approve') el.style = 'primary';
  if (decision === 'deny') el.style = 'danger';
  return el;
}

/** The owner's DM while the request waits: who, where, the words, the four answers. */
export function buildInstructionApprovalDm(view: InstructionApprovalView): SlackMessage {
  const count = view.texts.length;
  const head = `🙋 <@${view.requesterId}>님이 회원님의 작업에 지시를 보냈습니다${count > 1 ? ` (${count}건)` : ''}. 실행할까요?`;
  return {
    text: head,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${head}\n${placeLine(view)}` } },
      { type: 'section', text: { type: 'mrkdwn', text: previewText(view.texts) } },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `승인하면 <@${view.requesterId}>님의 권한으로 실행됩니다. 대시보드에서도 응답할 수 있고, 24시간 안에 답하지 않으면 요청이 끝납니다.`,
          },
        ],
      },
      {
        type: 'actions',
        block_id: `instr_approval_${view.requestId}`,
        elements: [
          button(view, 'approve'),
          button(view, 'approve_session'),
          button(view, 'approve_always'),
          button(view, 'deny'),
        ],
      },
    ],
  };
}

/** What one answer means, in a sentence about the requester. */
function decisionSentence(view: InstructionApprovalView): string {
  const who = `<@${view.requesterId}>`;
  switch (view.decision) {
    case 'approve':
      return `✅ ${who}님의 지시를 승인했습니다 (이번만).`;
    case 'approve_session':
      return `🔁 ${who}님의 지시를 승인했습니다 — 이 세션에서는 앞으로 묻지 않습니다.`;
    case 'approve_always':
      return `⭐ ${who}님의 지시를 승인했습니다 — 앞으로 회원님의 모든 작업에서 묻지 않습니다 (대시보드 설정에서 뺄 수 있습니다).`;
    case 'deny':
      return `🚫 ${who}님의 지시를 거절했습니다 — 실행하지 않았습니다.`;
    default:
      return '';
  }
}

/** The owner's DM once answered (no buttons). */
export function buildInstructionApprovalResolvedDm(view: InstructionApprovalView): SlackMessage {
  const via = view.decidedVia === 'dashboard' ? ' — 대시보드에서 응답했습니다.' : '';
  const text = `${decisionSentence(view)}${via}`;
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${text}\n${placeLine(view)}` } },
      { type: 'section', text: { type: 'mrkdwn', text: previewText(view.texts) } },
    ],
  };
}

/** The owner's DM once the request ended unanswered (expired, or its session closed). */
export function buildInstructionApprovalEndedDm(view: InstructionApprovalView, reason: string): SlackMessage {
  const text = `⌛ <@${view.requesterId}>님의 지시 승인 요청이 끝났습니다 — ${reason}. 실행하지 않았습니다.`;
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${text}\n${placeLine(view)}` } }] };
}

/** The thread's line when an instruction is held. */
export function instructionHeldNotice(view: Pick<InstructionApprovalView, 'requesterId' | 'ownerId'>): string {
  return (
    `⏳ <@${view.requesterId}>님의 지시는 이 작업의 소유자 <@${view.ownerId}>님이 승인해야 실행됩니다. ` +
    '소유자에게 DM과 대시보드로 승인을 요청했습니다.'
  );
}

/** The thread's line once the owner answered. */
export function instructionDecidedNotice(view: InstructionApprovalView): string {
  const by = `<@${view.ownerId}>`;
  const who = `<@${view.requesterId}>`;
  switch (view.decision) {
    case 'approve':
      return `✅ ${by}님이 ${who}님의 지시를 승인했습니다 — 실행합니다.`;
    case 'approve_session':
      return `🔁 ${by}님이 ${who}님의 지시를 승인했습니다 — 이 세션에서는 앞으로 바로 실행합니다.`;
    case 'approve_always':
      return `⭐ ${by}님이 ${who}님의 지시를 항상 승인하기로 했습니다 — 실행합니다.`;
    case 'deny':
      return `🚫 ${by}님이 ${who}님의 지시를 거절했습니다 — 실행하지 않았습니다.`;
    default:
      return '';
  }
}

/** A Slack click's `{ requestId, decision }`, or null when the payload is not ours. */
export function parseInstructionApprovalAction(
  body: any,
): { requestId: string; decision: InstructionApprovalDecision } | null {
  const raw: unknown = body?.actions?.[0]?.value;
  if (typeof raw !== 'string') return null;
  let parsed: { requestId?: unknown; decision?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed.requestId !== 'string' || !parsed.requestId) return null;
  if (!isInstructionApprovalDecision(parsed.decision)) return null;
  return { requestId: parsed.requestId, decision: parsed.decision };
}

// The approval card an admin reads before reacting (.prd/16-devops-tools-architecture.md §5.2). Pure.
// Every argument value is shown whole, as a JSON string inside a code area, with nothing that can close the
// code area, start a new line, reorder text, or mention anyone. A card that does not fit Slack's limits is
// refused, never shortened: what the admin approves is exactly what runs.

import type { DevopsTool, UnverifiedRequesterClaim } from '@soma/process-shared/devops/protocol.js';

export interface ApprovalRequest {
  tool: DevopsTool;
  /** One Korean sentence the broker writes from structured arguments. Shown as plain text. */
  title: string;
  /** e.g. 계정, 환경, 존, 권한, 수명, 사유 — values (free text included) are shown inside a code area. */
  details: { label: string; value: string }[];
  /** gh argv (without `gh`), shown in full, one JSON-escaped element per line. */
  argv?: readonly string[];
  /** e.g. CI 코드 실행 가능 / 리뷰 규칙 충족에 쓰일 수 있음 — written by the broker. */
  warnings: string[];
  /** Shown as "요청자(자칭·미검증)". Never an authorization input. */
  claimedRequester: UnverifiedRequesterClaim;
  /** What the digest covers (key-sorted JSON → sha256). */
  canonical: unknown;
}

export type ApprovalErrorCode = 'too-many-pending-approvals' | 'card-too-long' | 'slack-unavailable';

const APPROVAL_ERROR_MESSAGES: Record<ApprovalErrorCode, string> = {
  'too-many-pending-approvals': 'too many approval cards are waiting for an answer; try again after one is decided',
  'card-too-long': 'the approval card would not fit in one Slack message; shorten the arguments',
  'slack-unavailable': 'no approval card could be posted to Slack',
};

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  /** Set when a rate limit refused the request: when a new card could be accepted. */
  readonly retryAfterSeconds?: number;

  constructor(code: ApprovalErrorCode, message?: string, retryAfterSeconds?: number) {
    super(message ?? APPROVAL_ERROR_MESSAGES[code]);
    this.name = 'ApprovalError';
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SlackTextObject {
  type: 'mrkdwn' | 'plain_text';
  text: string;
  emoji?: boolean;
  verbatim?: boolean;
}

export type SlackBlock =
  | { type: 'header'; text: SlackTextObject }
  | { type: 'section'; block_id?: string; text: SlackTextObject };

export interface SlackCard {
  /** Notification fallback; the blocks carry the whole card. */
  text: string;
  blocks: SlackBlock[];
}

/**
 * Slack allows 50 blocks and 3,000 characters per section; the total keeps a card readable. A value whose
 * escaped form is longer than `longValueChars` is listed after the short arguments, so it cannot push a flag
 * below Slack's "show more" fold.
 */
export const CARD_LIMITS = {
  totalChars: 12_000,
  blocks: 45,
  sectionChars: 3_000,
  headerChars: 150,
  longValueChars: 200,
} as const;

export const APPROVAL_INSTRUCTION = '승인 = :white_check_mark: 리액션 · 거부 = :x: 리액션 (어드민 본인 리액션만 유효)';

export const LEASE_BEARER_NOTE =
  ':warning: 승인하면 이 범위·기간 동안 이 봇의 세션이 사용할 수 있습니다 — lease ID를 가진 세션이면 요청한 세션이 아니어도 씁니다.';

const HEADER = 'devops 확인 요청';
const INSTRUCTION_BLOCK_ID = 'approval-instruction';
const STATUS_BLOCK_ID = 'approval-status';
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,20}$/;
/** Longest result line kept (before escaping, which can grow it six-fold). */
const RESULT_LINE_CHARS = 400;

/** Line breaks, controls, bidi and zero-width marks, and the backtick that opens or closes a code span. */
const CODE_UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}`]/gu;
/** Stacked combining marks draw over neighbouring lines; one or two (e.g. decomposed Vietnamese) are kept. */
const MARK_RUN_RE = /\p{M}{3,}/gu;
const LINE_BREAKING_RE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const FORMAT_RE = /\p{Cf}/gu;

function unicodeEscape(char: string): string {
  let out = '';
  for (let i = 0; i < char.length; i++) out += `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return out;
}

/** The three characters Slack requires escaped in text it parses (`<` would start a mention or link). */
function escapeEntities(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One value as one JSON string literal: no raw line break, invisible character, backtick or run of more
 * than two combining marks survives (each becomes a `\uXXXX` escape, so JSON.parse still returns the exact
 * value after Slack decodes the entities).
 */
export function codeValue(value: string): string {
  return escapeEntities(
    JSON.stringify(value).replace(CODE_UNSAFE_RE, unicodeEscape).replace(MARK_RUN_RE, unicodeEscape),
  );
}

/** Broker-written text as plain text: one line, no backticks, no invisible marks. */
function plain(text: string): string {
  return text.replace(/`/g, "'").replace(LINE_BREAKING_RE, ' ').replace(FORMAT_RE, '');
}

/** Broker-written text inside mrkdwn: as `plain`, and nothing Slack would read as a mention or link. */
function prose(text: string): string {
  return escapeEntities(plain(text));
}

function mention(userId: string): string {
  return SLACK_USER_RE.test(userId) ? `<@${userId}>` : `ID 형식 오류 ${codeValue(userId)}`;
}

function mrkdwn(text: string, blockId?: string): SlackBlock {
  return {
    type: 'section',
    ...(blockId === undefined ? {} : { block_id: blockId }),
    text: { type: 'mrkdwn', text, verbatim: true },
  };
}

function tooLong(): never {
  throw new ApprovalError('card-too-long');
}

/** Code lines packed into as few sections as fit; a line never spans two sections. */
function codeSections(heading: string, lines: readonly string[]): SlackBlock[] {
  const wrap = (part: readonly string[], first: boolean) =>
    `${first ? heading : `${heading} (이어서)`}\n\`\`\`\n${part.join('\n')}\n\`\`\``;
  const texts: string[] = [];
  let chunk: string[] = [];
  for (const line of lines) {
    const candidate = [...chunk, line];
    if (wrap(candidate, texts.length === 0).length <= CARD_LIMITS.sectionChars) {
      chunk = candidate;
      continue;
    }
    if (chunk.length === 0) tooLong();
    texts.push(wrap(chunk, texts.length === 0));
    chunk = [line];
    if (wrap(chunk, false).length > CARD_LIMITS.sectionChars) tooLong();
  }
  if (chunk.length > 0) texts.push(wrap(chunk, texts.length === 0));
  return texts.map((text) => mrkdwn(text));
}

function checkLimits(card: SlackCard): SlackCard {
  if (card.blocks.length > CARD_LIMITS.blocks) tooLong();
  let total = card.text.length;
  for (const block of card.blocks) {
    const max = block.type === 'header' ? CARD_LIMITS.headerChars : CARD_LIMITS.sectionChars;
    if (block.text.text.length > max) tooLong();
    total += block.text.text.length;
  }
  if (total > CARD_LIMITS.totalChars) tooLong();
  return card;
}

export function formatKst(ms: number): string {
  const shifted = new Date(ms + 9 * 3600 * 1000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)} KST`;
}

/** Throws ApprovalError('card-too-long') when the card cannot be shown whole. */
export function renderApprovalCard(
  req: ApprovalRequest,
  meta: { approvalId: string; digest: string; expiresAtMs: number },
): SlackCard {
  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: HEADER, emoji: false } },
    { type: 'section', text: { type: 'plain_text', text: plain(req.title), emoji: false } },
    mrkdwn(
      `요청자(자칭·미검증): ${mention(req.claimedRequester.slackUserId)}\n` +
        `만료: ${formatKst(meta.expiresAtMs)} (${new Date(meta.expiresAtMs).toISOString()})`,
    ),
  ];
  // Long values are listed last; their place holds an unquoted marker no real (quoted) value can look like.
  const longLines: string[] = [];
  const shortOrMarker = (value: string): string => {
    const rendered = codeValue(value);
    if (rendered.length <= CARD_LIMITS.longValueChars) return rendered;
    longLines.push(`[긴 값 ${longLines.length + 1}] ${rendered}`);
    return `[긴 값 ${longLines.length} → 아래]`;
  };
  const detailLines = req.details.map(
    ({ label, value }) => `${codeValue(label).slice(1, -1)}: ${shortOrMarker(value)}`,
  );
  detailLines.push(`세션(자칭): ${shortOrMarker(req.claimedRequester.sessionKey)}`);
  blocks.push(...codeSections('*요청 내용*', detailLines));
  if (req.argv !== undefined && req.argv.length > 0) {
    blocks.push(
      ...codeSections(
        `*gh 명령 전문* — gh 뒤 인자 ${req.argv.length}개, 한 줄에 하나 (JSON 문자열)`,
        req.argv.map(shortOrMarker),
      ),
    );
  }
  if (req.tool === 'cf_lease_request') blocks.push(mrkdwn(LEASE_BEARER_NOTE));
  if (req.warnings.length > 0) {
    blocks.push(mrkdwn(`:warning: *주의*\n${req.warnings.map((warning) => `• ${prose(warning)}`).join('\n')}`));
  }
  blocks.push(
    ...codeSections('*확인 정보*', [
      `승인 ID: ${codeValue(meta.approvalId)}`,
      `digest(앞 12자): ${codeValue(meta.digest.slice(0, 12))}`,
    ]),
  );
  if (longLines.length > 0) {
    blocks.push(...codeSections('*긴 값* — 위에서 [긴 값 N → 아래]로 표시한 값의 전문 (JSON 문자열)', longLines));
  }
  blocks.push(mrkdwn(APPROVAL_INSTRUCTION, INSTRUCTION_BLOCK_ID));
  return checkLimits({ text: `${HEADER}: ${prose(req.title)}`, blocks });
}

export type CardStatus =
  | { kind: 'approved'; by: string }
  | { kind: 'done'; line: string }
  | { kind: 'denied'; by: string }
  | { kind: 'expired' }
  | { kind: 'cancelled' };

function capLine(line: string): string {
  return line.length > RESULT_LINE_CHARS ? `${line.slice(0, RESULT_LINE_CHARS)}…(잘림)` : line;
}

const STATUS_LABEL: Record<CardStatus['kind'], string> = {
  approved: '승인됨',
  done: '실행 종료',
  denied: '거부됨',
  expired: '만료됨',
  cancelled: '취소됨',
};

const NO_LONGER = '이 카드에 리액션해도 더 이상 반영되지 않습니다.';

function statusText(status: CardStatus): string {
  switch (status.kind) {
    case 'approved':
      return `:white_check_mark: *승인됨* — ${mention(status.by)} · 실행 중. ${NO_LONGER}`;
    case 'done':
      return `:checkered_flag: *실행 종료* — 결과:\n\`\`\`\n${codeValue(capLine(status.line))}\n\`\`\``;
    case 'denied':
      return `:x: *거부됨* — ${mention(status.by)}. 실행하지 않았습니다. ${NO_LONGER}`;
    case 'expired':
      return `:hourglass: *만료됨* — 시간 안에 승인되지 않아 실행하지 않았습니다. ${NO_LONGER}`;
    case 'cancelled':
      return `:no_entry_sign: *취소됨* — 요청이 취소되어 실행하지 않았습니다. ${NO_LONGER}`;
  }
}

/**
 * The card with its instruction line replaced by the status, so a stale card cannot be read as still
 * open. Without the original card (after a restart) a short status card is rendered instead.
 */
export function renderCardStatus(card: SlackCard | undefined, status: CardStatus): SlackCard {
  const statusBlock = mrkdwn(statusText(status), STATUS_BLOCK_ID);
  const label = STATUS_LABEL[status.kind];
  if (card === undefined) {
    return {
      text: `[${label}] ${HEADER}`,
      blocks: [{ type: 'header', text: { type: 'plain_text', text: HEADER, emoji: false } }, statusBlock],
    };
  }
  const blocks = card.blocks.filter(
    (block) =>
      !(block.type === 'section' && (block.block_id === INSTRUCTION_BLOCK_ID || block.block_id === STATUS_BLOCK_ID)),
  );
  return { text: `[${label}] ${card.text}`, blocks: [...blocks, statusBlock] };
}

/** One result line for the card's thread. Not an approval card, so a long line is cut. */
export function renderResultReply(line: string): SlackCard {
  const capped = capLine(line);
  return {
    text: `devops 실행 결과: ${prose(capped)}`,
    blocks: [mrkdwn(`*실행 결과*\n\`\`\`\n${codeValue(capped)}\n\`\`\``)],
  };
}

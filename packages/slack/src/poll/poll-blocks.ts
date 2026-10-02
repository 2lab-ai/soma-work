import { escapeSlackMrkdwn } from '../mrkdwn-escape';
import type { PollRecord } from './poll-types';

/**
 * Block Kit rendering for native button polls.
 *
 * The poll card is a bot-owned message that is EDITED in place (open counts →
 * result roster / canceled). This is a deliberate, documented exception to the
 * repo's append-only message rule: the card is not a streamed answer, so no
 * user-visible answer text is overwritten.
 *
 * Every builder is a pure function of the record — deterministic output is what
 * lets delivery retries resume exactly where they stopped.
 */

export const POLL_ACTION_VOTE_PREFIX = 'poll_v1_vote_';
export const POLL_ACTION_VOTE_PATTERN = /^poll_v1_vote_\d+$/;
export const POLL_ACTION_CLOSE = 'poll_v1_close';
export const POLL_ACTION_CANCEL = 'poll_v1_cancel';

/**
 * Block budget per message. Slack allows 50 blocks per message
 * (docs/misc/reference/slack-block-kit.md); 45 leaves room for the header,
 * the overflow note and the footer context. Do not raise this to 50.
 */
export const MAX_BLOCKS_PER_MESSAGE = 45;
/**
 * Section text budget. Slack caps a section's text at 3000 chars; 2900 is a
 * safety buffer for the "(1/2)" continuation suffix and escaping growth.
 */
export const MAX_SECTION_CHARS = 2900;
/** Slack caps a message `text` at 40,000 chars; keep a buffer. */
export const MAX_NOTICE_CHARS = 39_000;
/** Slack caps button text at 75 chars; options are limited so "20. <60> · 999" fits. */
export const MAX_OPTION_CHARS = 60;
export const MAX_OPTIONS = 20;
export const MAX_TITLE_CHARS = 150;

export interface PollMessage {
  text: string;
  blocks: any[];
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `MM/DD HH:MM KST` — fixed UTC+9 arithmetic, independent of the host timezone. */
export function formatKst(epochMs: number): string {
  const d = new Date(epochMs + KST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} KST`;
}

function countByOption(poll: PollRecord): number[] {
  const counts = poll.options.map(() => 0);
  for (const idx of Object.values(poll.votes)) {
    if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) counts[idx] += 1;
  }
  return counts;
}

/** Voters per option, in a deterministic order (by userId). */
function votersByOption(poll: PollRecord): string[][] {
  const buckets: string[][] = poll.options.map(() => []);
  for (const userId of Object.keys(poll.votes).sort()) {
    const idx = poll.votes[userId];
    if (Number.isInteger(idx) && idx >= 0 && idx < buckets.length) buckets[idx].push(userId);
  }
  return buckets;
}

function totalVoters(poll: PollRecord): number {
  return countByOption(poll).reduce((a, b) => a + b, 0);
}

function section(text: string): any {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string): any {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

export function buildOpenPollMessage(poll: PollRecord): PollMessage {
  const title = escapeSlackMrkdwn(poll.title);
  const deadline = formatKst(poll.closesAt);
  const counts = countByOption(poll);
  const total = counts.reduce((a, b) => a + b, 0);

  const voteButtons = poll.options.map((label, i) => ({
    type: 'button',
    action_id: `${POLL_ACTION_VOTE_PREFIX}${i}`,
    text: { type: 'plain_text', text: `${i + 1}. ${label} · ${counts[i]}`, emoji: true },
    value: poll.id,
  }));

  const blocks: any[] = [
    section(`🍚 *${title}*\n마감 *${deadline}* · 메뉴 버튼을 눌러 투표하세요. 다시 누르면 바뀝니다. (현재 ${total}명)`),
    { type: 'actions', elements: voteButtons },
    context(
      `실행: <@${poll.creatorId}> · 마감 전에는 인원수만 보이고, 마감 때 이름이 공개됩니다. 세션 종료는 투표 취소가 아닙니다.`,
    ),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: POLL_ACTION_CLOSE,
          text: { type: 'plain_text', text: '지금 마감', emoji: true },
          style: 'primary',
          value: poll.id,
          confirm: {
            title: { type: 'plain_text', text: '지금 마감' },
            text: { type: 'mrkdwn', text: '지금 마감하고 메뉴별 멤버를 공개할까요?' },
            confirm: { type: 'plain_text', text: '마감' },
            deny: { type: 'plain_text', text: '취소' },
          },
        },
        {
          type: 'button',
          action_id: POLL_ACTION_CANCEL,
          text: { type: 'plain_text', text: '투표 취소', emoji: true },
          style: 'danger',
          value: poll.id,
          confirm: {
            title: { type: 'plain_text', text: '투표 취소' },
            text: { type: 'mrkdwn', text: '투표를 취소할까요? 결과는 공개되지 않습니다.' },
            confirm: { type: 'plain_text', text: '투표 취소' },
            deny: { type: 'plain_text', text: '돌아가기' },
          },
        },
      ],
    },
  ];

  return { text: `🍚 ${title} — 투표 중 (마감 ${deadline}, 현재 ${total}명)`, blocks };
}

/** Split a mention list into chunks whose rendered text fits the section budget. */
function chunkMentions(head: string, mentions: string[]): string[] {
  if (mentions.length === 0) return [`${head}\n-`];
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  const budget = MAX_SECTION_CHARS - head.length - 16; // room for "\n" and " (10/10)"
  for (const m of mentions) {
    const add = m.length + 1;
    if (current.length > 0 && length + add > budget) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(m);
    length += add;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((c, i) => {
    const suffix = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '';
    return `${head}${suffix}\n${c.join(' ')}`;
  });
}

function optionHead(poll: PollRecord, i: number, count: number): string {
  return `*${i + 1}. ${escapeSlackMrkdwn(poll.options[i])}* · ${count}명`;
}

export function buildClosedPollMessage(poll: PollRecord): PollMessage {
  const title = escapeSlackMrkdwn(poll.title);
  const total = totalVoters(poll);
  const closedAt = formatKst(poll.closedAt ?? poll.closesAt);
  const voters = votersByOption(poll);

  const header = section(`🍚 *${title}* 결과 · ${closedAt} 마감 · 총 ${total}명`);
  const footer = context('투표가 마감됐습니다. 메뉴 순서대로 멤버를 보여줍니다.');
  const overflowNote = context('명단이 길어 일부 메뉴는 인원만 표시합니다. 전체 명단은 아래 스레드 알림을 확인하세요.');

  // Reserve header + footer + overflow note.
  const budget = MAX_BLOCKS_PER_MESSAGE - 3;
  const optionBlocks: any[] = [];
  let overflowed = false;
  voters.forEach((users, i) => {
    const head = optionHead(poll, i, users.length);
    const parts = chunkMentions(
      head,
      users.map((u) => `<@${u}>`),
    );
    const remaining = budget - optionBlocks.length;
    if (!overflowed && parts.length <= remaining) {
      for (const p of parts) optionBlocks.push(section(p));
    } else if (remaining > 0) {
      // Count-only line keeps option order visible; names live in the notice.
      overflowed = true;
      optionBlocks.push(section(`${head}\n(명단은 스레드 알림 참조)`));
    } else {
      overflowed = true;
    }
  });

  const blocks = [header, ...optionBlocks, ...(overflowed ? [overflowNote] : []), footer];
  return { text: `🍚 ${title} 결과 — 총 ${total}명 (${closedAt} 마감)`, blocks };
}

export function buildCanceledPollMessage(poll: PollRecord): PollMessage {
  const title = escapeSlackMrkdwn(poll.title);
  return {
    text: `🚫 ${title} — 투표가 취소됐습니다`,
    blocks: [section(`🚫 *${title}* 투표가 취소됐습니다. 결과는 공개되지 않습니다.`)],
  };
}

/**
 * Roster notice(s) posted as NEW thread messages after close. Editing the card
 * does not notify anyone; a fresh message with mentions does. The notice text
 * carries the complete per-option roster, so no voter is ever dropped even if
 * the card had to fall back to count-only lines. Long rosters split into
 * ordered parts, each within Slack's text limit.
 */
export function buildResultNotices(poll: PollRecord): Array<{ text: string }> {
  const voters = votersByOption(poll);
  const total = totalVoters(poll);
  const intro = `🔔 *${escapeSlackMrkdwn(poll.title)}* 팀 편성이 끝났습니다. 메뉴별 멤버:`;
  if (total === 0) {
    return [
      {
        text: `🔔 *${escapeSlackMrkdwn(poll.title)}* 투표가 마감됐지만 투표한 사람이 없습니다.\n_${noticeMarker(poll.id, 0, 1)}_`,
      },
    ];
  }
  const lines = voters.map((users, i) => {
    const head = `${i + 1}. ${escapeSlackMrkdwn(poll.options[i])} (${users.length}명)`;
    return `${head} ${users.length ? users.map((u) => `<@${u}>`).join(' ') : '-'}`;
  });

  const parts: string[] = [];
  let current = intro;
  for (const line of lines) {
    if (line.length + 1 > MAX_NOTICE_CHARS) {
      // A single option with an enormous roster: split it by mentions.
      const words = line.split(' ');
      let piece = '';
      for (const w of words) {
        if (piece.length + w.length + 1 > MAX_NOTICE_CHARS) {
          if (current.length > 0) parts.push(current);
          current = '';
          parts.push(piece);
          piece = '';
        }
        piece = piece ? `${piece} ${w}` : w;
      }
      if (piece) {
        if (current.length + piece.length + 1 > MAX_NOTICE_CHARS) {
          parts.push(current);
          current = piece;
        } else {
          current = current ? `${current}\n${piece}` : piece;
        }
      }
      continue;
    }
    if (current.length + line.length + 1 > MAX_NOTICE_CHARS) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  const nonEmpty = parts.filter((t) => t.length > 0);
  return nonEmpty.map((text, i) => ({ text: `${text}\n_${noticeMarker(poll.id, i, nonEmpty.length)}_` }));
}

/**
 * Exact per-part marker carried by every roster notice. After a post with an
 * unknown outcome, delivery looks for this marker (bot-authored messages only)
 * before reposting, so a lost response does not page everyone twice.
 */
export function noticeMarker(pollId: string, index: number, total: number): string {
  return `ref ${pollId} ${index + 1}/${total}`;
}

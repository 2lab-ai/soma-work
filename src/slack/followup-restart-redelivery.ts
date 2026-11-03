/**
 * After a restart, which follow-up rows the restart kept from being processed,
 * and whether the model had read each one before the process went away.
 *
 * Owner directive (SSOT 2026-11-03, work-m64 dev): "서비스 재부팅하면 자동으로 처리되지
 * 않은 메세지는 그 이후에 반드시 보내야함 작업이 중단된거 아니면". Before it, a row a
 * deploy cut stayed `paused` or `uncertain` (보내지 못했습니다) until a person pressed
 * Resume or Retry, through every later restart.
 *
 * The session's Claude transcript is the record of what the model read: a
 * message pushed into a running turn lands there as a `queued_command`
 * attachment whose `source_uuid` is the uuid the host pushed it under, or as a
 * user entry with that `uuid` when it started a turn of its own (both measured
 * on the work-m64 transcript of 2026-11-03).
 *
 * Pure: the caller reads the transcript and owns every queue write.
 */
import type { FollowupItem } from '@soma/slack/followup-queue';
import { FOLLOWUP_RESTART_STEERED_NOTE, isFollowupDelivered } from '@soma/slack/followup-queue';
import { FOLLOWUP_RESTART_FREEZE_REASON } from '@soma/slack/followup-queue-blocks';

/**
 * A row older than this is not sent on a restart: a day-old message landing in
 * a conversation that has moved on would surprise more than it helps. It keeps
 * its Retry.
 */
export const FOLLOWUP_RESTART_REDELIVERY_MAX_AGE_MS = 24 * 60 * 60_000;

/** The `stateReason` the graceful shutdown's stop writes (`followupStopReason('shutdown')`). */
export const FOLLOWUP_SHUTDOWN_STOP_REASON = '실행이 중단되었습니다 (shutdown)';

/** A transcript may stamp an entry a little before the host's enqueue clock. */
const CLOCK_SKEW_MS = 5_000;

/**
 * Did a restart — the graceful shutdown's stop or the crash recovery — leave
 * this row parked, before its words reached the model, recently enough to send?
 *
 * Not one a person stopped: their stop writes its own reason, which this never
 * matches. Not one with delivery evidence: its own turn reached the model, and
 * the resuming run takes that one over instead (`isHostCutFollowup`).
 */
export function isRestartCutUndelivered(item: FollowupItem, now: number): boolean {
  if (item.state !== 'paused' && item.state !== 'uncertain') return false;
  const reason = item.stateReason ?? '';
  const restartCut = reason === FOLLOWUP_SHUTDOWN_STOP_REASON || reason.startsWith(FOLLOWUP_RESTART_FREEZE_REASON);
  if (!restartCut || isFollowupDelivered(item)) return false;
  return now - item.enqueuedAt <= FOLLOWUP_RESTART_REDELIVERY_MAX_AGE_MS;
}

/** The plain text of a transcript message's content (string, or its text blocks). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

/** The words a transcript line hands the model as a user message, or undefined. */
function userWordsOf(entry: Record<string, unknown>): string | undefined {
  if (entry.type === 'attachment') {
    const attachment = entry.attachment as { type?: unknown; prompt?: unknown } | undefined;
    return attachment?.type === 'queued_command' ? contentText(attachment.prompt) : undefined;
  }
  if (entry.type === 'user') {
    const message = entry.message as { role?: unknown; content?: unknown } | undefined;
    return message?.role === 'user' ? contentText(message.content) : undefined;
  }
  return undefined;
}

/**
 * Does the transcript show the model was handed this message?
 *
 * By uuid when the row kept the one it was pushed under (`cutSteerUuid`) — exact.
 * Otherwise by its words, from an entry stamped at or after its enqueue — a row
 * cut before it kept its uuid (frozen by an older build), or a dispatch whose
 * turn the restart cut while it was being set up.
 */
export function transcriptShowsRead(
  transcript: string,
  probe: { uuid?: string; text?: string; since: number },
): boolean {
  if (probe.uuid) {
    return transcript.includes(`"uuid":"${probe.uuid}"`) || transcript.includes(`"source_uuid":"${probe.uuid}"`);
  }
  const words = probe.text?.trim();
  if (!words) return false;
  // JSON keeps non-ASCII as it is, so the escaped words are a cheap filter for the lines worth parsing.
  const needle = JSON.stringify(words).slice(1, -1);
  for (const line of transcript.split('\n')) {
    if (!line.includes(needle)) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    if (!Number.isFinite(at) || at < probe.since - CLOCK_SKEW_MS) continue;
    if (userWordsOf(entry)?.trim() === words) return true;
  }
  return false;
}

/**
 * The next boot's verdict on a row a restart cut: `read` only on the
 * transcript's word; with no transcript, or nothing in it, the message is sent
 * — a second copy of an instruction costs less than a lost one.
 *
 * A row that was waiting (`paused`, never pushed anywhere) cannot have been
 * read, and the transcript is not read for it (`readTranscript` is lazy).
 */
export function restartCutVerdict(item: FollowupItem, readTranscript: () => string | undefined): 'read' | 'unread' {
  // A row a restart took out of `steered` before it kept the uuid says so in its reason (older builds).
  const pushed =
    item.cutSteerUuid !== undefined ||
    item.state === 'uncertain' ||
    (item.stateReason ?? '').endsWith(FOLLOWUP_RESTART_STEERED_NOTE);
  if (!pushed) return 'unread';
  const transcript = readTranscript();
  if (transcript === undefined) return 'unread';
  const read = transcriptShowsRead(transcript, {
    uuid: item.cutSteerUuid,
    text: typeof item.message?.text === 'string' ? item.message.text : undefined,
    since: item.enqueuedAt,
  });
  return read ? 'read' : 'unread';
}

/**
 * Shared helpers for the personal-skill view-submission handlers.
 *
 * Three handlers (edit / rename / delete) all carry the same five-field
 * `private_metadata` JSON shape and the same post-ack flow:
 *   1. updateMessage on the originating list (so the user sees the new state
 *      without having to re-type `$user`).
 *   2. postEphemeral confirmation in the same thread.
 *
 * Both halves are best-effort — a transport failure in either must NOT bubble
 * past the (already-closed) modal; the only legible escape after an `ack`
 * has fired is a log line.
 *
 * Edit handler still owns its own metadata struct (it carries an additional
 * `contentHash` field), but reuses the post-ack helper indirectly via its
 * `postConfirmation` method that wraps `postEphemeral` with the same
 * swallow-and-log contract.
 */
import type { Logger } from '../../logger';
import { buildUserSkillListBlocks } from '../commands/user-skills-list-handler';
import type { SlackApiHelper } from '../slack-api-helper';

/** Common shape carried in `private_metadata` for the rename / delete flows. */
export interface SkillViewMetadataBase {
  requesterId: string;
  skillName: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
}

/**
 * Symmetric writer for `private_metadata` — the menu-action-handler uses this
 * when opening a modal so the 5-field shape stays in lockstep with the
 * `parseSkillViewMetadataBase` reader.
 *
 * `extra` is for handlers that layer additional fields on top of the base
 * shape (e.g. edit carries `contentHash`). Edit handler still owns its own
 * `ParsedMetadata` reader because of that extra field; the writer is shared.
 */
export function buildSkillViewPrivateMetadata(base: SkillViewMetadataBase, extra?: Record<string, unknown>): string {
  return JSON.stringify(extra ? { ...base, ...extra } : base);
}

/**
 * Parse the JSON `private_metadata` carried by a personal-skill view-submission.
 *
 * Returns `null` for any structural mismatch — the caller is expected to ack
 * with `response_action: 'errors'` and a "metadata corrupted" message.
 *
 * `requesterId` and `skillName` are required; channel / thread / messageTs
 * default to empty strings (the originating message may have been ephemeral
 * or the list may not yet have a stored `ts`).
 */
export function parseSkillViewMetadataBase(raw: unknown): SkillViewMetadataBase | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.requesterId !== 'string' || typeof parsed.skillName !== 'string') {
    return null;
  }
  return {
    requesterId: parsed.requesterId,
    skillName: parsed.skillName,
    channelId: typeof parsed.channelId === 'string' ? parsed.channelId : '',
    threadTs: typeof parsed.threadTs === 'string' ? parsed.threadTs : '',
    messageTs: typeof parsed.messageTs === 'string' ? parsed.messageTs : '',
  };
}

/**
 * Best-effort refresh of the originating `$user` list message in place.
 *
 * - When the user still has skills, replace blocks with the freshly built list.
 * - When the user just deleted their last skill, replace with a small empty-
 *   state placeholder so the message text stops referring to skills that are
 *   no longer there.
 *
 * No-op when channelId or messageTs is missing (best-effort contract). Errors
 * are logged at warn level and swallowed.
 */
export async function refreshSkillListMessage(
  slackApi: SlackApiHelper,
  meta: SkillViewMetadataBase,
  logger: Logger,
  emptyStatePlaceholder: string,
): Promise<void> {
  if (!meta.channelId || !meta.messageTs) return;
  try {
    const refreshed = buildUserSkillListBlocks(meta.requesterId);
    if (refreshed) {
      await slackApi.updateMessage(meta.channelId, meta.messageTs, refreshed.fallback, refreshed.blocks, []);
    } else {
      await slackApi.updateMessage(
        meta.channelId,
        meta.messageTs,
        emptyStatePlaceholder,
        [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: emptyStatePlaceholder },
          },
        ],
        [],
      );
    }
  } catch (err) {
    logger.warn('user_skill view submit: list refresh failed', {
      channel: meta.channelId,
      messageTs: meta.messageTs,
      err: (err as Error)?.message ?? String(err),
    });
  }
}

/**
 * Best-effort ephemeral confirmation in the originating thread. Failures are
 * logged but never re-thrown — the modal has already closed.
 */
export async function postSkillEphemeral(
  slackApi: SlackApiHelper,
  meta: SkillViewMetadataBase,
  text: string,
  logger: Logger,
): Promise<void> {
  if (!meta.channelId) return;
  try {
    await slackApi.postEphemeral(meta.channelId, meta.requesterId, text, meta.threadTs || undefined);
  } catch (err) {
    logger.warn('user_skill view submit: postEphemeral failed', {
      channel: meta.channelId,
      requesterId: meta.requesterId,
      err: (err as Error)?.message ?? String(err),
    });
  }
}

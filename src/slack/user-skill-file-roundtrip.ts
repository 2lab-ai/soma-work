import type { WebClient } from '@slack/web-api';
import { Logger } from '../logger';
import type { ConversationSession } from '../types';
import { computeContentHash, getUserSkill, MAX_SKILL_SIZE, updateUserSkill } from '../user-skill-store';

/**
 * Personal-skill SKILL.md file roundtrip.
 *
 * Two paths share this module:
 *   1. Outbound — the Slack action handler uploads SKILL.md as a file when
 *      the skill body cannot fit in an inline modal (`MAX_INLINE_EDIT_CHARS`)
 *      or in a shared code block (`SHARE_CONTENT_CHAR_LIMIT`). Edit-flow
 *      stashes a `pendingSkillUpload` marker on the session at the same time
 *      so the inbound path can recognize the user's reply file as an
 *      edit-apply intent rather than a generic Claude prompt attachment.
 *   2. Inbound — `event-router.handleFileUpload` calls
 *      `consumePendingSkillUpload` BEFORE delegating to the normal Claude
 *      pipeline. When the file matches the marker, the roundtrip is applied
 *      and the event is consumed (Claude is not invoked).
 *
 * Split from `user-skill-menu-action-handler.ts` so the inbound consume
 * logic can be unit-tested without booting Slack action infrastructure.
 */

const logger = new Logger('UserSkillFileRoundtrip');

/**
 * TTL for a pending edit-upload marker (24 hours).
 *
 * Human-editing timescale — a user can plausibly take a coffee / sleep break
 * mid-edit, and the marker is cheap to keep around (one runtime-only field
 * per session). Shorter TTLs (30 min) created a silent-expiry edge where a
 * legitimate slow edit would route the user's upload into Claude as a
 * regular prompt attachment with zero feedback; longer TTLs (24h) trade a
 * non-issue (marker memory) for the same UX.
 */
export const EDIT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Required filename for both outbound and inbound legs (case-insensitive).
 *
 * The case-insensitive match accepts `SKILL.md`, `skill.md`, `Skill.MD` etc.
 * Risk surface: one user uploading two `.md` files in a single armed thread
 * — gated already by the marker + requesterId + channel binding, so the
 * relaxation costs nothing.
 */
export const SKILL_FILE_NAME = 'SKILL.md';
const SKILL_FILE_NAME_LOWER = SKILL_FILE_NAME.toLowerCase();

export interface UploadSkillFileArgs {
  client: WebClient;
  channelId: string;
  threadTs?: string;
  skillName: string;
  content: string;
  /** Slack file title (visible in file modal). */
  title: string;
  /** `initial_comment` posted alongside the file. */
  comment?: string;
}

export interface UploadSkillFileResult {
  ok: boolean;
  /** Best-effort transport error message; empty on success. */
  error?: string;
}

/**
 * Upload SKILL.md as a Slack file attachment via `filesUploadV2`.
 *
 * Public to the action-handler so both `handleShare` (long-body share) and
 * `handleEdit` (long-body edit) can use the same transport. The bot uses
 * `channel_id + thread_ts` so the file lands in the same thread the user
 * clicked from — files cannot be ephemeral, so thread participants will see
 * it; for share that's the point, for edit the user is the only thread
 * participant in DM and a thread-mate in channels (no PII leak beyond the
 * existing inline-share ephemeral fence).
 */
export async function uploadSkillFile(args: UploadSkillFileArgs): Promise<UploadSkillFileResult> {
  try {
    // `thread_ts` is conditionally spread: the `filesUploadV2` TS overload
    // for `FileThreadDestinationArgument` types it as required `string`, so
    // a `string | undefined` field would fail compile even though the
    // runtime accepts the unthreaded form.
    const baseArgs = {
      channel_id: args.channelId,
      content: args.content,
      filename: SKILL_FILE_NAME,
      title: args.title,
      initial_comment: args.comment,
    };
    await args.client.filesUploadV2(args.threadTs ? { ...baseArgs, thread_ts: args.threadTs } : baseArgs);
    return { ok: true };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.error('uploadSkillFile failed', { skillName: args.skillName, err: msg });
    return { ok: false, error: msg };
  }
}

export interface FileDescriptor {
  name?: string;
  url_private_download?: string;
  url_private?: string;
  /** Slack-reported byte size — used to reject oversize uploads pre-download. */
  size?: number;
}

/**
 * Reject SKILL.md uploads whose Slack-reported `size` already exceeds the
 * persistence cap, so the bot never spends bandwidth downloading content the
 * store would refuse to write.
 *
 * Imported from `user-skill-store` so a future bump of `MAX_SKILL_SIZE`
 * tightens this gate automatically — no drift between wire and disk.
 */
function isOversizeUpload(file: FileDescriptor, maxBytes: number): boolean {
  return typeof file.size === 'number' && file.size > maxBytes;
}

export interface DownloadFileResult {
  ok: boolean;
  content?: string;
  error?: string;
}

export interface ConsumeUploadDeps {
  /** Reads current SKILL.md content for the marker's (userId, skillName). */
  readCurrentContent?: (userId: string, skillName: string) => string | null;
  /** Hashes content for the baseline-mismatch guard. */
  hashContent?: (content: string) => string;
  /** Persists the uploaded SKILL.md. */
  applyUpdate?: (userId: string, skillName: string, content: string) => { ok: boolean; message: string };
  /** Downloads a file from Slack to a UTF-8 string. Injected so tests don't hit the network. */
  downloadFile: (file: FileDescriptor) => Promise<DownloadFileResult>;
}

export type ConsumeUploadOutcome =
  | { consumed: false; reason: string; clearMarker?: boolean }
  | {
      consumed: true;
      /** Outcome category — used by callers for log telemetry, not surfaced verbatim to users. */
      outcome: 'applied' | 'rejected_stale' | 'rejected_missing' | 'rejected_download' | 'rejected_update';
      /** Human-facing thread message — caller posts this. */
      message: string;
      /** True iff the marker should be cleared after handling. */
      clearMarker: boolean;
    };

export interface ConsumePendingSkillUploadArgs {
  session: ConversationSession;
  /** ID of the user who uploaded the file (`messageEvent.user`). */
  uploaderId: string;
  /** Files attached to the inbound message event. */
  files: FileDescriptor[];
  /** Byte budget for size pre-check (defaults to `MAX_SKILL_SIZE`). */
  maxBytes?: number;
  /** Optional clock for tests. */
  now?: number;
  deps: ConsumeUploadDeps;
}

/**
 * Decide whether an inbound `file_share` event finishes a pending skill-edit
 * roundtrip, and if so apply the update. See `ConsumeUploadOutcome` for the
 * full result shape — `consumed=false` paths fall through to the normal
 * Claude pipeline; `consumed=true` paths produce a thread message and
 * (sometimes) clear the marker.
 *
 * Expiry is the only `consumed=false, clearMarker=true` path — the stale
 * marker is silently dropped without swallowing the event so other handlers
 * still see the upload as a regular file.
 */
export async function consumePendingSkillUpload(args: ConsumePendingSkillUploadArgs): Promise<ConsumeUploadOutcome> {
  const { session, uploaderId, files, deps } = args;
  const now = args.now ?? Date.now();
  const maxBytes = args.maxBytes ?? MAX_SKILL_SIZE;
  const marker = session.pendingSkillUpload;
  if (!marker) {
    return { consumed: false, reason: 'no_marker' };
  }

  // Marker survives a non-requester upload so the original clicker can still
  // complete the round-trip in the same thread.
  if (!uploaderId || uploaderId !== marker.requesterId) {
    return { consumed: false, reason: 'uploader_mismatch' };
  }

  const skillFile = files.find((f) => f?.name?.toLowerCase() === SKILL_FILE_NAME_LOWER);
  if (!skillFile) {
    return { consumed: false, reason: 'no_skill_md_file' };
  }

  // Expiry is checked AFTER the SKILL.md match so that an expired marker
  // intercepts a clearly-intended roundtrip upload with a "TTL expired"
  // notice rather than silently routing the user's SKILL.md into Claude as
  // a prompt attachment (data-loss UX). Non-SKILL.md uploads still fall
  // through normally even with an expired marker.
  if (marker.expiresAt && marker.expiresAt < now) {
    logger.info('pendingSkillUpload expired — clearing marker', {
      requesterId: marker.requesterId,
      skillName: marker.skillName,
      expiresAt: marker.expiresAt,
      now,
    });
    return {
      consumed: true,
      outcome: 'rejected_stale',
      clearMarker: true,
      message:
        `⏰ \`$user:${marker.skillName}\` 편집 파일 라운드트립이 만료되었습니다 ` +
        `(TTL ${Math.round((now - marker.expiresAt) / 60000)}분 초과). ` +
        '다시 `✏️ 편집` 을 눌러 새 편집 세션을 시작해주세요.',
    };
  }

  if (isOversizeUpload(skillFile, maxBytes)) {
    return {
      consumed: true,
      outcome: 'rejected_update',
      clearMarker: false,
      message:
        `❌ 업로드된 SKILL.md 가 너무 큽니다 (${skillFile.size} > ${maxBytes} bytes). ` +
        '내용을 줄인 뒤 다시 업로드해주세요.',
    };
  }

  const readFn = deps.readCurrentContent ?? defaultRead;
  const hashFn = deps.hashContent ?? computeContentHash;
  const updateFn = deps.applyUpdate ?? defaultUpdate;

  const currentContent = readFn(marker.requesterId, marker.skillName);
  if (currentContent === null) {
    return {
      consumed: true,
      outcome: 'rejected_missing',
      clearMarker: true,
      message: `❌ \`$user:${marker.skillName}\` 가 더 이상 존재하지 않습니다. 업로드는 무시되었습니다.`,
    };
  }

  // Stale-baseline guard: refuse to apply if the on-disk SKILL.md drifted
  // since we shipped the edit baseline, otherwise we'd clobber the other write.
  if (hashFn(currentContent) !== marker.baselineHash) {
    return {
      consumed: true,
      outcome: 'rejected_stale',
      clearMarker: true,
      message:
        `⚠️ \`$user:${marker.skillName}\` 가 편집 파일을 보낸 이후로 다른 곳에서 변경되었습니다. ` +
        '업로드는 적용되지 않았습니다. 다시 \\`편집\\` 을 눌러 최신 본문으로 시작해주세요.',
    };
  }

  const dl = await deps.downloadFile(skillFile);
  if (!dl.ok || dl.content === undefined) {
    // Keep the marker alive on transient download failure so the user can
    // retry within TTL.
    return {
      consumed: true,
      outcome: 'rejected_download',
      clearMarker: false,
      message: `❌ 업로드된 SKILL.md 다운로드에 실패했습니다: ${dl.error ?? 'unknown error'}`,
    };
  }

  const result = updateFn(marker.requesterId, marker.skillName, dl.content);
  if (!result.ok) {
    // Keep the marker alive on validation failure (oversize/empty/etc.) so
    // the user can fix and re-upload within TTL.
    return {
      consumed: true,
      outcome: 'rejected_update',
      clearMarker: false,
      message: `❌ 스킬 업데이트 실패: ${result.message}`,
    };
  }

  return {
    consumed: true,
    outcome: 'applied',
    clearMarker: true,
    message: `✅ \`$user:${marker.skillName}\` 가 업로드된 SKILL.md로 업데이트되었습니다.`,
  };
}

function defaultRead(userId: string, skillName: string): string | null {
  const detail = getUserSkill(userId, skillName);
  return detail ? detail.content : null;
}

function defaultUpdate(userId: string, skillName: string, content: string): { ok: boolean; message: string } {
  return updateUserSkill(userId, skillName, content);
}

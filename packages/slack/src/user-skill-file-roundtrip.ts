import type { WebClient } from '@slack/web-api';
import { Logger } from '@soma/common/logger';

const logger = new Logger('UserSkillFileRoundtrip');

export const EDIT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const SKILL_FILE_NAME = 'SKILL.md';
const SKILL_FILE_NAME_LOWER = SKILL_FILE_NAME.toLowerCase();
const DEFAULT_MAX_SKILL_SIZE = 10 * 1024;

export interface PendingSkillUploadMarker {
  skillName: string;
  requesterId: string;
  baselineHash: string;
  expiresAt?: number;
}

export interface SkillUploadConversationSession {
  pendingSkillUpload?: PendingSkillUploadMarker;
}

export interface UserSkillRoundtripProviders {
  readCurrentContent?: (userId: string, skillName: string) => string | null;
  hashContent?: (content: string) => string;
  applyUpdate?: (userId: string, skillName: string, content: string) => { ok: boolean; message: string };
  getMaxSkillSize?: () => number;
}

let defaultProviders: Required<UserSkillRoundtripProviders> = {
  readCurrentContent: () => null,
  hashContent: (content: string) => content,
  applyUpdate: () => ({ ok: false, message: 'User skill store is not configured.' }),
  getMaxSkillSize: () => DEFAULT_MAX_SKILL_SIZE,
};

export function setUserSkillRoundtripProviders(providers: UserSkillRoundtripProviders): void {
  defaultProviders = {
    ...defaultProviders,
    ...providers,
  };
}

export interface UploadSkillFileArgs {
  client: WebClient;
  channelId: string;
  threadTs?: string;
  skillName: string;
  content: string;
  title: string;
  comment?: string;
}

export interface UploadSkillFileResult {
  ok: boolean;
  error?: string;
}

export async function uploadSkillFile(args: UploadSkillFileArgs): Promise<UploadSkillFileResult> {
  try {
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
  size?: number;
}

function isOversizeUpload(file: FileDescriptor, maxBytes: number): boolean {
  return typeof file.size === 'number' && file.size > maxBytes;
}

export interface DownloadFileResult {
  ok: boolean;
  content?: string;
  error?: string;
}

export interface ConsumeUploadDeps {
  readCurrentContent?: (userId: string, skillName: string) => string | null;
  hashContent?: (content: string) => string;
  applyUpdate?: (userId: string, skillName: string, content: string) => { ok: boolean; message: string };
  downloadFile: (file: FileDescriptor) => Promise<DownloadFileResult>;
}

export type ConsumeUploadOutcome =
  | { consumed: false; reason: string; clearMarker?: boolean }
  | {
      consumed: true;
      outcome: 'applied' | 'rejected_stale' | 'rejected_missing' | 'rejected_download' | 'rejected_update';
      message: string;
      clearMarker: boolean;
    };

export interface ConsumePendingSkillUploadArgs {
  session: SkillUploadConversationSession;
  uploaderId: string;
  files: FileDescriptor[];
  maxBytes?: number;
  now?: number;
  deps: ConsumeUploadDeps;
}

export async function consumePendingSkillUpload(args: ConsumePendingSkillUploadArgs): Promise<ConsumeUploadOutcome> {
  const { session, uploaderId, files, deps } = args;
  const now = args.now ?? Date.now();
  const maxBytes = args.maxBytes ?? defaultProviders.getMaxSkillSize();
  const marker = session.pendingSkillUpload;
  if (!marker) {
    return { consumed: false, reason: 'no_marker' };
  }

  if (!uploaderId || uploaderId !== marker.requesterId) {
    return { consumed: false, reason: 'uploader_mismatch' };
  }

  const skillFile = files.find((file) => file?.name?.toLowerCase() === SKILL_FILE_NAME_LOWER);
  if (!skillFile) {
    return { consumed: false, reason: 'no_skill_md_file' };
  }

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

  const readFn = deps.readCurrentContent ?? defaultProviders.readCurrentContent;
  const hashFn = deps.hashContent ?? defaultProviders.hashContent;
  const updateFn = deps.applyUpdate ?? defaultProviders.applyUpdate;

  const currentContent = readFn(marker.requesterId, marker.skillName);
  if (currentContent === null) {
    return {
      consumed: true,
      outcome: 'rejected_missing',
      clearMarker: true,
      message: `❌ \`$user:${marker.skillName}\` 가 더 이상 존재하지 않습니다. 업로드는 무시되었습니다.`,
    };
  }

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
    return {
      consumed: true,
      outcome: 'rejected_download',
      clearMarker: false,
      message: `❌ 업로드된 SKILL.md 다운로드에 실패했습니다: ${dl.error ?? 'unknown error'}`,
    };
  }

  const result = updateFn(marker.requesterId, marker.skillName, dl.content);
  if (!result.ok) {
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

/**
 * User media — the files a user attached to an instruction (screenshots, PDFs,
 * text, voice notes, video), kept so the dashboard shows them with the
 * instruction that carried them.
 *
 * The turn is the index: a user turn's `attachments` (ConversationTurn) lists
 * its files; this module only holds the bytes, under
 * `DATA_DIR/user-media/<conversationId>/`:
 *   <mediaId>            a kept copy (no extension — the turn's `mime` says what it is)
 *   <mediaId>.remote     an empty marker: the turn lists it, no copy was kept
 *   .pending-<mediaId>   a copy whose user turn is not saved yet
 * The content route looks an id up in the conversation's user turns, never in
 * a second index; the directory only answers "is it committed" and the card count.
 *
 * Lifecycle:
 *   capture  the stream executor (or a steered message) copies the downloads
 *            BEFORE the turn's temp cleanup and before the model runs, bounded
 *            by a deadline and per-turn caps. Past them a file keeps its
 *            metadata (`stored: false`) — it is never dropped.
 *   commit   the recorder promotes the copies once the user turn is saved.
 *   sweep    a `.pending-` copy older than PENDING_TTL_MS lost its turn (crash,
 *            record failure, a copy that outran its deadline) and is deleted.
 *
 * Reads only this process's downloads: a regular file (never a symlink) named
 * `slack-file-*` whose real path is under the OS temp dir or /tmp. The stored
 * file is named by the server-made id only — the user's file name is display text.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TurnAttachment, UserMediaKind, UserMediaUnavailable } from '@soma/slack/user-media';
import { ulid } from 'ulid';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';
import { classifyArtifact } from './artifacts';
import type { ConversationRecord } from './types';

export type { TurnAttachment } from '@soma/slack/user-media';

const logger = new Logger('UserMedia');

/** The fields of a downloaded file (`ProcessedFile`) capture reads. */
export interface UserMediaFile {
  /** Local path of the download; '' when the pipeline kept metadata only. */
  path: string;
  name: string;
  mimetype: string;
  size: number;
  slackFileId?: string;
  permalink?: string;
  unavailable?: UserMediaUnavailable;
}

/** An attachment with the turn it came with — what the session media list returns. */
export interface SessionMediaItem extends TurnAttachment {
  turnId: string;
  /** The user turn's timestamp (ms). */
  turnTs: number;
}

export interface CaptureOptions {
  /** Time budget for the copies, from the call (ms). Past it a file keeps metadata only. */
  deadlineMs?: number;
}

/** Copies kept per turn (Slack allows 10 files per message, the composer 10). Beyond: metadata only. */
export const MAX_COPIES_PER_TURN = 20;
/** Bytes copied per turn. FileHandler already caps one download at 50 MB. */
export const MAX_COPY_BYTES_PER_TURN = 200 * 1024 * 1024;
/** Default copy budget — the same bound the executor gives its temp cleanup. */
export const DEFAULT_CAPTURE_DEADLINE_MS = 3000;
const PENDING_PREFIX = '.pending-';
const REMOTE_SUFFIX = '.remote';
const PENDING_TTL_MS = 60 * 60 * 1000;
const DOWNLOAD_PREFIX = 'slack-file-';
const NAME_MAX = 200;

/**
 * Slack MIME types trusted when the file name has no known extension. Only
 * types the dashboard can show as-is; anything else is a downloadable file.
 */
const MIME_FALLBACK: Record<string, UserMediaKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'application/pdf': 'pdf',
  'text/plain': 'text',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/webm': 'audio',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
};

/**
 * Kind + served MIME: by file name first (the artifact table), then a short
 * Slack-MIME allowlist. An explicit audio MIME wins over a video-looking
 * extension, as in FileHandler: a browser voice note is `.webm` audio.
 */
export function classifyUserMedia(name: string, slackMime: string | undefined): { kind: UserMediaKind; mime: string } {
  const mime = String(slackMime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const byName = classifyArtifact(name);
  if (byName.kind === 'video' && MIME_FALLBACK[mime] === 'audio') return { kind: 'audio', mime };
  if (byName.kind !== 'file') return byName;
  const kind = MIME_FALLBACK[mime];
  return kind ? { kind, mime } : byName;
}

function safeSegment(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Real paths a download may live under: the OS temp dir (macOS: /private/var/folders/…) and /tmp. */
function tempRoots(): string[] {
  const roots = new Set<string>(['/tmp/', '/private/tmp/']);
  try {
    roots.add(`${fs.realpathSync(os.tmpdir()).replace(/\/+$/, '')}/`);
  } catch {
    // no temp dir — /tmp only
  }
  return [...roots];
}

/**
 * The download, if it may be read: an absolute `slack-file-*` regular file (not
 * a symlink) whose real path sits directly in a temp root.
 */
async function readableDownload(filePath: string, roots: string[]): Promise<{ real: string; size: number } | null> {
  if (!filePath || !path.isAbsolute(filePath) || filePath.split(path.sep).includes('..')) return null;
  if (!path.basename(filePath).startsWith(DOWNLOAD_PREFIX)) return null;
  try {
    const lst = await fs.promises.lstat(filePath);
    if (!lst.isFile()) return null; // a symlink reports isSymbolicLink(), not isFile()
    const real = await fs.promises.realpath(filePath);
    if (!roots.includes(`${path.dirname(real)}/`)) return null;
    return { real, size: lst.size };
  } catch {
    return null;
  }
}

function cleanName(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from a display name
  const base = path.basename(String(raw || '')).replace(/[\u0000-\u001f\u007f]/g, '');
  return (base || 'file').slice(0, NAME_MAX);
}

function httpsOnly(url: string | undefined): string | undefined {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url.slice(0, 1000) : undefined;
}

/** Resolves false once `ms` passes, so a slow copy cannot hold the turn. */
function within<T>(work: Promise<T>, ms: number): Promise<T | false> {
  if (ms <= 0) return Promise.resolve(false);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class UserMediaStore {
  private readonly baseDir: string;
  /** Committed attachments per conversation, read from the directory once. */
  private readonly counts = new Map<string, number>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(DATA_DIR, 'user-media');
  }

  private dir(conversationId: string): string | null {
    const seg = safeSegment(conversationId);
    return seg && seg === conversationId ? path.join(this.baseDir, seg) : null;
  }

  /**
   * Copy a turn's downloaded files now — before the turn's temp cleanup and
   * before the model can touch them. Never throws and never drops a file: one
   * that cannot be copied in time or within the caps is returned with
   * `stored: false`. Unknown/unsafe conversation id → [] (nothing to file under).
   */
  async capture(
    conversationId: string,
    files: readonly UserMediaFile[],
    opts: CaptureOptions = {},
  ): Promise<TurnAttachment[]> {
    const dir = this.dir(conversationId);
    if (!dir || !files) return [];
    sweepStalePending(dir);
    if (files.length === 0) return [];
    const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_CAPTURE_DEADLINE_MS);
    const roots = tempRoots();
    const out: TurnAttachment[] = [];
    let copies = 0;
    let bytes = 0;
    // One at a time: the caps are per turn, and a turn's files share one disk.
    for (const file of files) {
      const meta = this.describe(file);
      const src = file.path && !file.unavailable ? await readableDownload(file.path, roots) : null;
      const fits = !!src && copies < MAX_COPIES_PER_TURN && bytes + src.size <= MAX_COPY_BYTES_PER_TURN;
      if (src && fits && (await this.copyPending(conversationId, dir, src.real, meta.id, deadline))) {
        copies += 1;
        bytes += src.size;
        out.push({ ...meta, size: src.size, stored: true });
      } else {
        out.push(meta);
      }
    }
    return out;
  }

  /** Metadata of one file, `stored: false` until a copy lands. */
  private describe(file: UserMediaFile): TurnAttachment {
    const name = cleanName(file.name);
    const { kind, mime } = classifyUserMedia(name, file.mimetype);
    const permalink = httpsOnly(file.permalink);
    return {
      id: ulid(),
      name,
      kind,
      mime,
      size: Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0,
      stored: false,
      ...(file.slackFileId ? { slackFileId: String(file.slackFileId).slice(0, NAME_MAX) } : {}),
      ...(permalink ? { permalink } : {}),
      ...(file.unavailable ? { unavailable: file.unavailable } : {}),
    };
  }

  /** Copy to `.pending-<id>` within the deadline. A copy that outruns it is left for the sweep. */
  private async copyPending(
    conversationId: string,
    dir: string,
    real: string,
    id: string,
    deadline: number,
  ): Promise<boolean> {
    const staged = path.join(dir, PENDING_PREFIX + id);
    const copy = (async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      // Copy-on-write clone where the file system can (APFS), a plain copy otherwise.
      await fs.promises.copyFile(real, staged, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      return true;
    })().catch(async (err) => {
      logger.warn(`Could not keep a user attachment for ${conversationId}`, err);
      await fs.promises.unlink(staged).catch(() => {});
      return false;
    });
    const done = await within(copy, deadline - Date.now());
    if (done === false) logger.warn(`User attachment copy for ${conversationId} missed its deadline; kept as metadata`);
    return done === true;
  }

  /**
   * The user turn listing `attachments` is saved: promote its copies and mark
   * the rest, so the content route serves them and the card counts them.
   */
  async commit(conversationId: string, attachments: readonly TurnAttachment[] | undefined): Promise<void> {
    const dir = this.dir(conversationId);
    if (!dir || !attachments || attachments.length === 0) return;
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    for (const a of attachments) {
      const id = safeSegment(a.id);
      if (!id || id !== a.id) continue;
      try {
        if (a.stored) await fs.promises.rename(path.join(dir, PENDING_PREFIX + id), path.join(dir, id));
        else await fs.promises.writeFile(path.join(dir, id + REMOTE_SUFFIX), '');
      } catch (err) {
        // The copy is gone (swept, disk): the route answers 404 and the tile says so.
        logger.warn(`Could not commit user attachment ${id} of ${conversationId}`, err);
      }
    }
    this.counts.delete(conversationId);
  }

  /** Path of a committed copy, or null (unsafe ids, not committed, no copy kept). */
  contentPath(conversationId: string, mediaId: string): string | null {
    const dir = this.dir(conversationId);
    const seg = safeSegment(mediaId);
    if (!dir || !seg || seg !== mediaId) return null;
    const file = path.join(dir, seg);
    try {
      return fs.statSync(file).isFile() ? file : null;
    } catch {
      return null;
    }
  }

  /** Committed attachments of a conversation (kept or not) — the card's paperclip count. */
  count(conversationId: string | undefined): number {
    if (!conversationId) return 0;
    const dir = this.dir(conversationId);
    if (!dir) return 0;
    const cached = this.counts.get(conversationId);
    if (cached !== undefined) return cached;
    let n = 0;
    try {
      n = fs.readdirSync(dir).filter((name) => !name.startsWith('.')).length;
    } catch {
      n = 0; // no directory: nothing attached yet
    }
    this.counts.set(conversationId, n);
    return n;
  }
}

/** Drop `.pending-*` copies older than PENDING_TTL_MS (best effort). */
function sweepStalePending(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // no directory yet
  }
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const name of names) {
    if (!name.startsWith(PENDING_PREFIX)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // raced with a commit or another sweep — nothing to do
    }
  }
}

/** Every attachment of the conversation's user turns, oldest first, with the turn it came with. */
export function listSessionMedia(record: ConversationRecord | null | undefined): SessionMediaItem[] {
  const out: SessionMediaItem[] = [];
  for (const t of record?.turns ?? []) {
    if (t.role !== 'user' || !Array.isArray(t.attachments)) continue;
    for (const a of t.attachments) out.push({ ...a, turnId: t.id, turnTs: t.timestamp });
  }
  return out;
}

/** The attachment with this id in the conversation's user turns. */
export function findSessionMedia(
  record: ConversationRecord | null | undefined,
  mediaId: string,
): TurnAttachment | undefined {
  for (const t of record?.turns ?? []) {
    if (t.role !== 'user' || !Array.isArray(t.attachments)) continue;
    const hit = t.attachments.find((a) => a.id === mediaId);
    if (hit) return hit;
  }
  return undefined;
}

let defaultStore: UserMediaStore | null = null;

/** Process-wide store under DATA_DIR/user-media. */
export function getUserMediaStore(): UserMediaStore {
  if (!defaultStore) defaultStore = new UserMediaStore();
  return defaultStore;
}

/** Tests only: swap the process-wide store. */
export function setUserMediaStoreForTests(store: UserMediaStore | null): void {
  defaultStore = store;
}

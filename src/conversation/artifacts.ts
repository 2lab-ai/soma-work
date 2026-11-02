/**
 * Session artifacts — the files the model sends to Slack (html, png, wav, …),
 * kept per conversation so the dashboard can preview them on hover and open
 * them full size. A markdown final answer is the chat's (지시와 답변), never an
 * artifact (SSOT 2026-11-02 T6): answers recorded before that stay on disk but
 * are hidden from every read.
 *
 * Layout under `DATA_DIR/artifacts/<conversationId>/`:
 *   index.json   — { version, backfilled, artifacts: SessionArtifact[] } in recording
 *                  order (read newest first), written with `atomicWriteJson` (+ `.bak`, rules/config.md)
 *   <artifactId> — the stored copy of the bytes (no extension; `mime` says what it is)
 *
 * The upload source lives under /tmp and is cleaned with the session's working
 * directory, so the bytes are copied — snapshotted when the model makes the call
 * (artifact-capture.ts), before the upload runs. Only regular files under /tmp
 * are ever read, never through a symlink. Files over MAX_STORED_BYTES, or whose
 * bytes are gone, keep their metadata and Slack permalink (`stored: false`): the
 * dashboard still lists every file sent to Slack, it just cannot preview those.
 *
 * Scope: files the MODEL sent (slack-mcp send_file / send_media). The daemon's
 * own uploads (usage cards, the system-prompt file, skill files) are not session
 * output and are not recorded.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { ulid } from 'ulid';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';

const logger = new Logger('SessionArtifacts');

export type ArtifactKind = 'image' | 'audio' | 'video' | 'html' | 'markdown' | 'pdf' | 'text' | 'file';
/** `final_answer` — a markdown answer recorded before SSOT 2026-11-02 T6: kept on disk, hidden from every read. */
export type ArtifactSource = 'slack_upload' | 'final_answer';

export interface SessionArtifact {
  id: string;
  conversationId: string;
  kind: ArtifactKind;
  /** Display name — the Slack filename. */
  name: string;
  title?: string;
  mime: string;
  /** Bytes of the original. */
  size: number;
  createdAt: number;
  source: ArtifactSource;
  /** A local copy exists and `/content` can serve it. */
  stored: boolean;
  slackFileId?: string;
  permalink?: string;
  /** MCP tool that uploaded it (send_file / send_media). */
  tool?: string;
  /** Work-log turn id (`<sessionKey>:<startMs>:<uuid>`) of the turn that produced it. */
  turnId?: string;
  /** Start of that turn (ms) — the dashboard files the artifact under the turn's answer. */
  turnStartedAt?: number;
  /** One-line preview text (legacy answers only). */
  excerpt?: string;
}

/** What a kanban card carries: the count plus the few newest for the face row. */
export interface ArtifactSummary {
  count: number;
  /** Newest first; at most SUMMARY_RECENT entries. */
  recent: SessionArtifact[];
}

/** A copy of an upload's bytes taken before the upload ran. */
export interface ArtifactSnapshot {
  id: string;
  size: number;
}

interface ArtifactIndex {
  version: 1;
  backfilled?: boolean;
  artifacts: SessionArtifact[];
}

export const MAX_STORED_BYTES = 100 * 1024 * 1024;
/** The only roots an upload is read from — the same allowlist slack-mcp enforces. */
const UPLOAD_ROOTS = ['/tmp/', '/private/tmp/'];
const SUMMARY_RECENT = 4;
/** A snapshot still waiting for its upload's result is `.pending-<id>` until recorded. */
const PENDING_PREFIX = '.pending-';
/** A pending snapshot older than this lost its result (abort, crash, restart) and is swept. */
const PENDING_TTL_MS = 60 * 60 * 1000;

const EXT_TABLE: Record<string, [ArtifactKind, string]> = {
  png: ['image', 'image/png'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  svg: ['image', 'image/svg+xml'],
  bmp: ['image', 'image/bmp'],
  ico: ['image', 'image/x-icon'],
  avif: ['image', 'image/avif'],
  tif: ['image', 'image/tiff'],
  tiff: ['image', 'image/tiff'],
  heic: ['image', 'image/heic'],
  heif: ['image', 'image/heif'],
  mp3: ['audio', 'audio/mpeg'],
  wav: ['audio', 'audio/wav'],
  ogg: ['audio', 'audio/ogg'],
  oga: ['audio', 'audio/ogg'],
  opus: ['audio', 'audio/ogg'],
  flac: ['audio', 'audio/flac'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  weba: ['audio', 'audio/webm'],
  wma: ['audio', 'audio/x-ms-wma'],
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/mp4'],
  mov: ['video', 'video/quicktime'],
  webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'],
  mkv: ['video', 'video/x-matroska'],
  avi: ['video', 'video/x-msvideo'],
  wmv: ['video', 'video/x-ms-wmv'],
  mpg: ['video', 'video/mpeg'],
  mpeg: ['video', 'video/mpeg'],
  '3gp': ['video', 'video/3gpp'],
  html: ['html', 'text/html'],
  htm: ['html', 'text/html'],
  md: ['markdown', 'text/markdown'],
  markdown: ['markdown', 'text/markdown'],
  pdf: ['pdf', 'application/pdf'],
  txt: ['text', 'text/plain'],
  log: ['text', 'text/plain'],
  csv: ['text', 'text/csv'],
  tsv: ['text', 'text/tab-separated-values'],
  json: ['text', 'application/json'],
  jsonl: ['text', 'application/x-ndjson'],
  yaml: ['text', 'text/yaml'],
  yml: ['text', 'text/yaml'],
  xml: ['text', 'application/xml'],
  toml: ['text', 'text/plain'],
  ini: ['text', 'text/plain'],
  diff: ['text', 'text/x-diff'],
  patch: ['text', 'text/x-diff'],
  sql: ['text', 'text/plain'],
  sh: ['text', 'text/plain'],
  py: ['text', 'text/plain'],
  ts: ['text', 'text/plain'],
  tsx: ['text', 'text/plain'],
  js: ['text', 'text/plain'],
  jsx: ['text', 'text/plain'],
  css: ['text', 'text/plain'],
  go: ['text', 'text/plain'],
  rs: ['text', 'text/plain'],
  java: ['text', 'text/plain'],
  kt: ['text', 'text/plain'],
  swift: ['text', 'text/plain'],
  lean: ['text', 'text/plain'],
};

/** Kind + MIME from the filename's extension; unknown → a downloadable `file`. */
export function classifyArtifact(name: string): { kind: ArtifactKind; mime: string } {
  const ext = path.extname(name).slice(1).toLowerCase();
  const hit = EXT_TABLE[ext];
  return hit ? { kind: hit[0], mime: hit[1] } : { kind: 'file', mime: 'application/octet-stream' };
}

/** Newest first, by when each file was made (a stable sort keeps a tie in the order it is given). */
export function newestFirst(a: SessionArtifact, b: SessionArtifact): number {
  return (b.createdAt || 0) - (a.createdAt || 0);
}

/** `<sessionKey>:<startMs>:<uuid>` → startMs; anything else → undefined. */
export function turnStartFromTurnId(turnId: string | undefined): number | undefined {
  if (!turnId) return undefined;
  const parts = turnId.split(':');
  if (parts.length < 3) return undefined;
  const n = Number(parts[parts.length - 2]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function safeSegment(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

function validateIndex(raw: unknown): ArtifactIndex {
  const r = raw as Partial<ArtifactIndex> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.artifacts)) throw new Error('not an artifact index');
  return {
    version: 1,
    ...(r.backfilled ? { backfilled: true } : {}),
    artifacts: r.artifacts.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string'),
  };
}

/**
 * The upload, if it may be read: an absolute path whose real location is a
 * regular file under /tmp, reached without a symlink at the final component.
 */
async function readableUpload(filePath: string | undefined): Promise<{ real: string; size: number } | null> {
  if (!filePath || !path.isAbsolute(filePath) || filePath.split(path.sep).includes('..')) return null;
  try {
    const lst = await fs.promises.lstat(filePath);
    if (!lst.isFile()) return null; // symlinks report isSymbolicLink(), not isFile()
    const real = await fs.promises.realpath(filePath);
    if (!UPLOAD_ROOTS.some((root) => real.startsWith(root))) return null;
    return { real, size: lst.size };
  } catch {
    return null;
  }
}

export type ArtifactListener = (artifact: SessionArtifact) => void;

export class ArtifactStore {
  private readonly baseDir: string;
  private readonly cache = new Map<string, ArtifactIndex>();
  /** `<cid>|<key>` of records in flight — dedupe holds across the awaits of a record. */
  private readonly reserved = new Set<string>();
  private readonly listeners = new Set<ArtifactListener>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(DATA_DIR, 'artifacts');
  }

  private dir(conversationId: string): string | null {
    const seg = safeSegment(conversationId);
    return seg && seg === conversationId ? path.join(this.baseDir, seg) : null;
  }

  onRecorded(listener: ArtifactListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private index(conversationId: string): ArtifactIndex {
    const cached = this.cache.get(conversationId);
    if (cached) return cached;
    const dir = this.dir(conversationId);
    let loaded: ArtifactIndex = { version: 1, artifacts: [] };
    if (dir) {
      sweepStalePending(dir);
      try {
        loaded = readJsonWithBackup(path.join(dir, 'index.json'), validateIndex) ?? loaded;
      } catch (err) {
        // Unusable live + backup: list nothing now, but never report it as backfilled
        // or overwrite silently — the next record writes a fresh index (atomicWriteJson
        // keeps a damaged file from displacing a healthy .bak).
        logger.warn(`Artifact index for ${conversationId} is unusable`, err);
      }
    }
    this.cache.set(conversationId, loaded);
    return loaded;
  }

  private persist(conversationId: string): void {
    const dir = this.dir(conversationId);
    if (!dir) return;
    atomicWriteJson(path.join(dir, 'index.json'), this.index(conversationId), { validatePrevious: isIndexShape });
  }

  /** The recorded files, recording order — a legacy final answer (T6) is never one of them. */
  private files(conversationId: string): SessionArtifact[] {
    if (!this.dir(conversationId)) return [];
    return this.index(conversationId).artifacts.filter((a) => a.source !== 'final_answer');
  }

  /** All artifacts of a conversation, newest first (SSOT 2026-11-02 T3). Unknown/unsafe → []. */
  list(conversationId: string): SessionArtifact[] {
    // Reversed first: files made in the same millisecond list the later-recorded one first.
    return this.files(conversationId).reverse().sort(newestFirst);
  }

  isBackfilled(conversationId: string): boolean {
    return !!this.dir(conversationId) && this.index(conversationId).backfilled === true;
  }

  /** Remember the work-log backfill ran. `persist` false: nothing to keep on disk yet. */
  markBackfilled(conversationId: string, persist: boolean): void {
    if (!this.dir(conversationId)) return;
    this.index(conversationId).backfilled = true;
    if (persist) this.persist(conversationId);
  }

  summary(conversationId: string | undefined): ArtifactSummary | undefined {
    if (!conversationId) return undefined;
    const all = this.list(conversationId);
    if (all.length === 0) return undefined;
    return { count: all.length, recent: all.slice(0, SUMMARY_RECENT) };
  }

  get(conversationId: string, artifactId: string): SessionArtifact | undefined {
    return this.files(conversationId).find((a) => a.id === artifactId);
  }

  /** Absolute path of the stored bytes, or null when not stored / unsafe id. */
  blobPath(conversationId: string, artifactId: string): string | null {
    const dir = this.dir(conversationId);
    const seg = safeSegment(artifactId);
    if (!dir || !seg || seg !== artifactId) return null;
    const art = this.get(conversationId, artifactId);
    if (!art?.stored) return null;
    return path.join(dir, seg);
  }

  /**
   * Copy an upload's bytes now (the call is being made; the upload has not run yet).
   * null when the path is not a regular file under /tmp, is over the cap, or the copy fails.
   */
  async snapshot(conversationId: string, filePath: string | undefined): Promise<ArtifactSnapshot | null> {
    const dir = this.dir(conversationId);
    const src = await readableUpload(filePath);
    if (!dir || !src || src.size > MAX_STORED_BYTES) return null;
    const id = ulid();
    const staged = path.join(dir, PENDING_PREFIX + id);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(src.real, staged);
      return { id, size: src.size };
    } catch (err) {
      logger.warn(`Could not snapshot an upload for ${conversationId}`, err);
      await fs.promises.unlink(staged).catch(() => {});
      return null;
    }
  }

  /** Drop a snapshot whose upload failed or never completed. */
  async discardSnapshot(conversationId: string, snap: ArtifactSnapshot | null | undefined): Promise<void> {
    const dir = this.dir(conversationId);
    if (!dir || !snap || safeSegment(snap.id) !== snap.id) return;
    await fs.promises.unlink(path.join(dir, PENDING_PREFIX + snap.id)).catch(() => {});
  }

  /** Promote a snapshot to the artifact's blob; false when it is gone or does not match `size`. */
  private async adopt(conversationId: string, snap: ArtifactSnapshot, size: number | undefined): Promise<boolean> {
    const dir = this.dir(conversationId);
    if (!dir || safeSegment(snap.id) !== snap.id) return false;
    // The bytes must be the ones Slack received: the tool reports the size it uploaded.
    // (A backfill copies whatever sits at the old path now — another session may have
    // written a different file there since.)
    if (typeof size === 'number' && size >= 0 && snap.size !== size) {
      await this.discardSnapshot(conversationId, snap);
      return false;
    }
    try {
      await fs.promises.rename(path.join(dir, PENDING_PREFIX + snap.id), path.join(dir, snap.id));
      return true;
    } catch (err) {
      logger.warn(`Could not keep an upload snapshot for ${conversationId}`, err);
      return false;
    }
  }

  /**
   * Record a file the model uploaded to Slack. Uses `snapshot` when the call was
   * snapshotted, else copies `filePath` now if it is still a readable upload.
   * Same Slack file id twice → no-op (null).
   */
  async recordSlackUpload(input: {
    conversationId: string;
    snapshot?: ArtifactSnapshot | null;
    filePath?: string;
    filename?: string;
    title?: string;
    slackFileId?: string;
    permalink?: string;
    size?: number;
    tool?: string;
    turnId?: string;
    now?: number;
  }): Promise<SessionArtifact | null> {
    const { conversationId } = input;
    if (!this.dir(conversationId)) return null;
    const key = input.slackFileId ? `${conversationId}|file:${input.slackFileId}` : undefined;
    if (
      key &&
      (this.reserved.has(key) || this.files(conversationId).some((a) => a.slackFileId === input.slackFileId))
    ) {
      await this.discardSnapshot(conversationId, input.snapshot);
      return null;
    }
    if (key) this.reserved.add(key);
    try {
      const reported = typeof input.size === 'number' && input.size >= 0 ? input.size : undefined;
      let snap = input.snapshot ?? (input.filePath ? await this.snapshot(conversationId, input.filePath) : null);
      if (snap && !(await this.adopt(conversationId, snap, reported))) snap = null;
      const name = (input.filename || (input.filePath ? path.basename(input.filePath) : '') || 'file').slice(0, 200);
      const { kind, mime } = classifyArtifact(name);
      const size = snap?.size ?? reported ?? 0;
      const turnStartedAt = turnStartFromTurnId(input.turnId);
      const artifact: SessionArtifact = {
        id: snap?.id ?? ulid(),
        conversationId,
        kind,
        name,
        ...(input.title ? { title: input.title.slice(0, 200) } : {}),
        mime,
        size,
        createdAt: input.now ?? Date.now(),
        source: 'slack_upload',
        stored: !!snap,
        ...(input.slackFileId ? { slackFileId: input.slackFileId } : {}),
        ...(input.permalink ? { permalink: input.permalink } : {}),
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(turnStartedAt ? { turnStartedAt } : {}),
      };
      this.append(conversationId, artifact);
      return artifact;
    } finally {
      if (key) this.reserved.delete(key);
    }
  }

  private append(conversationId: string, artifact: SessionArtifact): void {
    const idx = this.index(conversationId);
    idx.artifacts = [...idx.artifacts, artifact];
    try {
      this.persist(conversationId);
    } catch (err) {
      // The in-memory list still serves this process; the next record retries the write.
      logger.error(`Failed to persist artifact index for ${conversationId}`, err);
    }
    for (const l of this.listeners) {
      try {
        l(artifact);
      } catch (err) {
        logger.warn('Artifact listener threw', err);
      }
    }
  }
}

/** Drop `.pending-*` snapshots older than PENDING_TTL_MS (best effort, once per index load). */
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
      // raced with a record or another sweep — nothing to do
    }
  }
}

function isIndexShape(parsed: unknown): boolean {
  return !!parsed && typeof parsed === 'object' && Array.isArray((parsed as ArtifactIndex).artifacts);
}

let defaultStore: ArtifactStore | null = null;

/** Process-wide store under DATA_DIR/artifacts. */
export function getArtifactStore(): ArtifactStore {
  if (!defaultStore) defaultStore = new ArtifactStore();
  return defaultStore;
}

/** Tests only: swap the process-wide store. */
export function setArtifactStoreForTests(store: ArtifactStore | null): void {
  defaultStore = store;
}

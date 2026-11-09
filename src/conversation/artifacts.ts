/**
 * Session artifacts — the files the model sends to Slack (html, png, wav, mp4, …)
 * and the links it posts there (a page or app the session serves, a published
 * video — slack-mcp `send_link`, kind `link`), kept per conversation so the
 * dashboard can preview them on hover and open them full size (a link opens its
 * URL in a new tab). A markdown final answer is the chat's (지시와 답변), never an
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
 * Scope: what the MODEL sent (slack-mcp send_file / send_media / send_link). The daemon's
 * own uploads (usage cards, the system-prompt file, skill files) are not session
 * output and are not recorded.
 *
 * Versions (#1074): an upload under the same key as an earlier one (the model's
 * `artifact_key`, else the file name without its time stamps —
 * somalib/artifacts/artifact-version.ts) is the next version of that artifact,
 * not an unrelated file. The same content as the latest version records no new
 * version; the same bytes are stored once (`blob`); a key keeps the bytes of its
 * newest MAX_KEPT_VERSIONS versions — older ones keep their row and Slack link.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import {
  artifactKeyFor,
  assignArtifactVersions,
  isSha256Hex,
  MAX_KEPT_VERSIONS,
  planArtifactVersion,
} from 'somalib/artifacts/artifact-version';
import { ulid } from 'ulid';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';

const logger = new Logger('SessionArtifacts');

/** What a file is — the kinds `classifyArtifact` gives a filename. */
export type FileArtifactKind = 'image' | 'audio' | 'video' | 'html' | 'markdown' | 'pdf' | 'text' | 'file';
/** `link` — a URL the model posted with send_link (recordLink); never a file's kind. */
export type ArtifactKind = FileArtifactKind | 'link';
/**
 * `slack_upload` — a file sent with send_file / send_media. `slack_link` — a URL posted with send_link (no bytes).
 * `final_answer` — a markdown answer recorded before SSOT 2026-11-02 T6: kept on disk, hidden from every read.
 */
export type ArtifactSource = 'slack_upload' | 'slack_link' | 'final_answer';

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
  /**
   * The URL it opens (plain http(s), no credentials — normalizeArtifactUrl): a `link`'s target, or where the
   * session also serves an uploaded file (send_file `url`) — the dashboard offers it as 라이브로 열기.
   */
  url?: string;
  /** kind `link`: ts of the Slack message that posted it — with `channel`, the dedupe key. */
  messageTs?: string;
  /** kind `link`: the Slack channel of that message (a ts is unique only within its channel). */
  channel?: string;
  permalink?: string;
  /** MCP tool that sent it (send_file / send_media / send_link). */
  tool?: string;
  /** Work-log turn id (`<sessionKey>:<startMs>:<uuid>`) of the turn that produced it. */
  turnId?: string;
  /** Start of that turn (ms) — the dashboard files the artifact under the turn's answer. */
  turnStartedAt?: number;
  /** One-line preview text (legacy answers only). */
  excerpt?: string;
  /** #1074 — what makes two uploads the same artifact: `key:` / `url:` / `name:` (artifact-version.ts). */
  key?: string;
  /** #1074 — 1 for the key's first upload, one more for each upload whose content differs. */
  version?: number;
  /** #1074 — sha256 (hex) of the bytes, when known. */
  sha256?: string;
  /** #1074 — the version before this one. */
  previousId?: string;
  /** #1074 — true: differs from the previous version (absent: none, or a hash is unknown). */
  changed?: boolean;
  /** #1074 — the stored copy is this artifact's id (the same bytes are kept once). Internal. */
  blob?: string;
  /** #1074 — Slack files that sent this version again unchanged (dedupe). Internal. */
  resentFileIds?: string[];
}

/**
 * What a kanban card carries — the board goes to every signed-in viewer, so the
 * versions themselves stay on the session's own API (#1074): one entry per
 * artifact (its latest version) with its version badge, never the version list.
 */
export interface ArtifactSummary {
  /** Artifacts, a key counted once. */
  count: number;
  /** Newest first; at most SUMMARY_RECENT entries. */
  recent: SessionArtifact[];
}

/** A copy of an upload's bytes taken before the upload ran. */
export interface ArtifactSnapshot {
  id: string;
  size: number;
  /** sha256 (hex) of the copy. */
  sha256?: string;
}

interface ArtifactIndex {
  version: 1;
  backfilled?: boolean;
  artifacts: SessionArtifact[];
}

export const MAX_STORED_BYTES = 100 * 1024 * 1024;
/** Longest URL a link artifact keeps. */
const MAX_URL_LENGTH = 2000;
/** The only roots an upload is read from — the same allowlist slack-mcp enforces. */
const UPLOAD_ROOTS = ['/tmp/', '/private/tmp/'];
const SUMMARY_RECENT = 4;
/** A snapshot still waiting for its upload's result is `.pending-<id>` until recorded. */
const PENDING_PREFIX = '.pending-';
/** A pending snapshot older than this lost its result (abort, crash, restart) and is swept. */
const PENDING_TTL_MS = 60 * 60 * 1000;
/** Slack file ids remembered per version for unchanged re-sends. */
const MAX_RESENT_IDS = 20;

const EXT_TABLE: Record<string, [FileArtifactKind, string]> = {
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
export function classifyArtifact(name: string): { kind: FileArtifactKind; mime: string } {
  const ext = path.extname(name).slice(1).toLowerCase();
  const hit = EXT_TABLE[ext];
  return hit ? { kind: hit[0], mime: hit[1] } : { kind: 'file', mime: 'application/octet-stream' };
}

/**
 * A URL a link artifact may hold: http(s) only (never javascript:, file:, data:), no user:password part (the
 * artifact list is readable by every signed-in dashboard user), at most MAX_URL_LENGTH. null otherwise.
 */
export function normalizeArtifactUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
  return u.href.length > MAX_URL_LENGTH ? null : u.href;
}

/** `youtu.be/rxkAcSqCG2Y` — an untitled link's display name. */
function linkDisplayName(href: string): string {
  const u = new URL(href);
  const tail = `${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  return `${u.host}${tail}`.slice(0, 200);
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

/** An artifact as the session's API serves it: without the store's bookkeeping. */
export function publicArtifact(a: SessionArtifact): SessionArtifact {
  const { blob: _blob, resentFileIds: _resent, ...rest } = a;
  return rest;
}

/**
 * An artifact as the board and its live push carry it (every signed-in viewer, #1074):
 * its version badge (`version`, `changed`), not the hash or the link to its other versions.
 */
export function boardArtifact(a: SessionArtifact): SessionArtifact {
  const { sha256: _sha, previousId: _prev, ...rest } = publicArtifact(a);
  return rest;
}

/** The latest version of each key, newest first (rows newest first in). */
function latestPerKey(newestFirst: SessionArtifact[]): SessionArtifact[] {
  const best = new Map<string, SessionArtifact>();
  for (const a of newestFirst) {
    const k = a.key || `id:${a.id}`;
    const cur = best.get(k);
    if (!cur || (a.version ?? 0) > (cur.version ?? 0)) best.set(k, a);
  }
  return newestFirst.filter((a) => best.get(a.key || `id:${a.id}`) === a);
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
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

  /** The conversation's index file (slack-mcp reads it, #1074); null for an unsafe id. */
  indexFile(conversationId: string): string | null {
    const dir = this.dir(conversationId);
    return dir ? path.join(dir, 'index.json') : null;
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
        // Rows recorded before versions existed (#1074) get a key and a version on load.
        assignArtifactVersions(loaded.artifacts);
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

  /** Every recorded version of every artifact, newest first (SSOT 2026-11-02 T3). Unknown/unsafe → []. */
  list(conversationId: string): SessionArtifact[] {
    return this.rowsNewestFirst(conversationId).map(publicArtifact);
  }

  private rowsNewestFirst(conversationId: string): SessionArtifact[] {
    // Reversed first: files made in the same millisecond list the later-recorded one first.
    return this.files(conversationId).reverse().sort(newestFirst);
  }

  /** The versions of the artifact `artifactId` belongs to, newest version first (#1074). */
  versions(conversationId: string, artifactId: string): SessionArtifact[] {
    const art = this.get(conversationId, artifactId);
    if (!art) return [];
    const key = art.key || `id:${art.id}`;
    return this.files(conversationId)
      .filter((a) => (a.key || `id:${a.id}`) === key)
      .sort((x, y) => (y.version ?? 0) - (x.version ?? 0))
      .map(publicArtifact);
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
    const latest = latestPerKey(this.rowsNewestFirst(conversationId));
    if (latest.length === 0) return undefined;
    return { count: latest.length, recent: latest.slice(0, SUMMARY_RECENT).map(boardArtifact) };
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
    const blob = art.blob ?? art.id;
    return safeSegment(blob) === blob ? path.join(dir, blob) : null;
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
      return { id, size: src.size, sha256: await sha256Of(staged) };
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
   * Same Slack file id twice → no-op (null). Same key as an earlier upload → its
   * next version; the same content as the latest version → no new version (null).
   */
  async recordSlackUpload(input: {
    conversationId: string;
    snapshot?: ArtifactSnapshot | null;
    filePath?: string;
    filename?: string;
    title?: string;
    slackFileId?: string;
    permalink?: string;
    /** send_file `url` — where the session also serves this file. */
    url?: string;
    size?: number;
    tool?: string;
    turnId?: string;
    now?: number;
    /** #1074 — the model's `artifact_key`. */
    key?: string;
    /** #1074 — sha256 of the bytes slack-mcp uploaded (used when no copy is kept here). */
    sha256?: string;
  }): Promise<SessionArtifact | null> {
    const { conversationId } = input;
    if (!this.dir(conversationId)) return null;
    const fileId = input.slackFileId;
    const reservation = fileId ? `${conversationId}|file:${fileId}` : undefined;
    if (reservation && (this.reserved.has(reservation) || this.knowsSlackFile(conversationId, fileId as string))) {
      await this.discardSnapshot(conversationId, input.snapshot);
      return null;
    }
    if (reservation) this.reserved.add(reservation);
    try {
      const reported = typeof input.size === 'number' && input.size >= 0 ? input.size : undefined;
      let snap = input.snapshot ?? (input.filePath ? await this.snapshot(conversationId, input.filePath) : null);
      // The copy must be the bytes Slack received: slack-mcp reports their hash; a different one means the file
      // changed between the call and the upload — keep no copy, and let the reported hash decide (#1074 r1).
      const reportedSha = isSha256Hex(input.sha256) ? input.sha256 : undefined;
      if (snap && reportedSha && snap.sha256 && snap.sha256 !== reportedSha) {
        await this.discardSnapshot(conversationId, snap);
        snap = null;
      }
      if (snap && !(await this.adopt(conversationId, snap, reported))) snap = null;
      const name = (input.filename || (input.filePath ? path.basename(input.filePath) : '') || 'file').slice(0, 200);
      const { kind, mime } = classifyArtifact(name);
      const size = snap?.size ?? reported ?? 0;
      const sha256 = snap?.sha256 ?? reportedSha;
      // From here to the index write nothing awaits: two uploads of one key never plan the same version.
      const key = artifactKeyFor({ key: input.key, name });
      const plan = planArtifactVersion(this.files(conversationId), key, sha256);
      if (plan.unchanged && plan.previous) {
        const same = plan.previous as SessionArtifact;
        if (fileId) same.resentFileIds = [...(same.resentFileIds ?? []), fileId].slice(-MAX_RESENT_IDS);
        // That version had no copy (too large then, pruned, or its snapshot failed): these are its bytes.
        const restore = !!snap && !same.stored;
        if (restore && snap) {
          same.stored = true;
          if (snap.id !== same.id) same.blob = snap.id;
        }
        const saved = this.persistLogged(conversationId);
        if (restore && !saved) {
          same.stored = false;
          delete same.blob;
        }
        if (snap && !(restore && saved)) await this.unlinkUnreferenced(conversationId, [snap.id]);
        return null;
      }
      // The same bytes are kept once: a stored artifact with this hash lends its copy.
      const twin = sha256 ? this.storedWithHash(conversationId, sha256) : undefined;
      const turnStartedAt = turnStartFromTurnId(input.turnId);
      const url = normalizeArtifactUrl(input.url);
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
        stored: !!snap || !!twin,
        ...(twin ? { blob: twin.blob ?? twin.id } : {}),
        ...(input.slackFileId ? { slackFileId: input.slackFileId } : {}),
        ...(url ? { url } : {}),
        ...(input.permalink ? { permalink: input.permalink } : {}),
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(turnStartedAt ? { turnStartedAt } : {}),
        key,
        version: plan.version,
        ...(sha256 ? { sha256 } : {}),
        ...(plan.previous ? { previousId: plan.previous.id } : {}),
        ...(plan.changed === true ? { changed: true } : {}),
      };
      const freed = this.append(conversationId, artifact);
      if (snap && twin) freed.push(snap.id);
      await this.unlinkUnreferenced(conversationId, freed);
      return artifact;
    } finally {
      if (reservation) this.reserved.delete(reservation);
    }
  }

  /**
   * Record a link the model posted to the thread (slack-mcp send_link): a page or app the session serves, a
   * published video, a release asset. No bytes — the dashboard opens the URL. Not a plain http(s) URL → null
   * (nothing recorded). Same Slack message twice → no-op (null).
   */
  recordLink(input: {
    conversationId: string;
    url: string;
    title?: string;
    messageTs?: string;
    channel?: string;
    permalink?: string;
    tool?: string;
    turnId?: string;
    now?: number;
  }): SessionArtifact | null {
    const { conversationId } = input;
    const url = normalizeArtifactUrl(input.url);
    if (!this.dir(conversationId) || !url) return null;
    // No await between this check and append: two results for one message cannot both pass it.
    // Without a message ts (a backfilled reply that lost it), the same URL in the same turn is one link.
    const same = (a: SessionArtifact) =>
      a.kind === 'link' &&
      (input.messageTs
        ? a.messageTs === input.messageTs && (a.channel ?? '') === (input.channel ?? '')
        : !a.messageTs && a.url === url && a.turnId === input.turnId);
    if (this.files(conversationId).some(same)) return null;
    // #1074 — the same link is the same artifact: a link's content is its URL, so posting it again adds no version.
    const key = artifactKeyFor({ url });
    if (this.files(conversationId).some((a) => a.key === key)) return null;
    const turnStartedAt = turnStartFromTurnId(input.turnId);
    const title = input.title?.trim().slice(0, 200);
    const artifact: SessionArtifact = {
      id: ulid(),
      conversationId,
      kind: 'link',
      name: title || linkDisplayName(url),
      mime: 'text/uri-list',
      size: 0,
      createdAt: input.now ?? Date.now(),
      source: 'slack_link',
      stored: false,
      url,
      ...(input.messageTs ? { messageTs: input.messageTs } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.permalink ? { permalink: input.permalink } : {}),
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(turnStartedAt ? { turnStartedAt } : {}),
      key,
      version: 1,
    };
    this.append(conversationId, artifact);
    return artifact;
  }

  /** A Slack file already recorded — as a version, or as an unchanged re-send of one. */
  private knowsSlackFile(conversationId: string, fileId: string): boolean {
    return this.files(conversationId).some((a) => a.slackFileId === fileId || a.resentFileIds?.includes(fileId));
  }

  private storedWithHash(conversationId: string, sha256: string): SessionArtifact | undefined {
    return this.files(conversationId).find((a) => a.stored && a.sha256 === sha256);
  }

  /**
   * Add a version, then drop the bytes of its key's versions past MAX_KEPT_VERSIONS (their row and
   * Slack link stay). Returns the copies that may now be unreferenced.
   */
  private append(conversationId: string, artifact: SessionArtifact): string[] {
    const idx = this.index(conversationId);
    idx.artifacts = [...idx.artifacts, artifact];
    const freed: string[] = [];
    const ofKey = idx.artifacts
      .filter((a) => a.source !== 'final_answer' && a.key === artifact.key)
      .sort((x, y) => (y.version ?? 0) - (x.version ?? 0));
    const dropped: SessionArtifact[] = [];
    for (const old of ofKey.slice(MAX_KEPT_VERSIONS)) {
      if (!old.stored) continue;
      old.stored = false;
      dropped.push(old);
      freed.push(old.blob ?? old.id);
    }
    // Bytes go only once the index that no longer lists them as stored is on disk (#1074 r1): if the write
    // fails, the pruned versions stay stored here too, and the next record prunes them again.
    if (!this.persistLogged(conversationId)) {
      for (const old of dropped) old.stored = true;
      freed.length = 0;
    }
    for (const l of this.listeners) {
      try {
        l(artifact);
      } catch (err) {
        logger.warn('Artifact listener threw', err);
      }
    }
    return freed;
  }

  /** false when the write failed (logged): the in-memory list still serves this process; the next record retries. */
  private persistLogged(conversationId: string): boolean {
    try {
      this.persist(conversationId);
      return true;
    } catch (err) {
      logger.error(`Failed to persist artifact index for ${conversationId}`, err);
      return false;
    }
  }

  /** Delete stored copies no stored artifact points at any more (best effort). */
  private async unlinkUnreferenced(conversationId: string, blobs: string[]): Promise<void> {
    const dir = this.dir(conversationId);
    if (!dir || blobs.length === 0) return;
    const inUse = new Set(
      this.files(conversationId)
        .filter((a) => a.stored)
        .map((a) => a.blob ?? a.id),
    );
    for (const blob of new Set(blobs)) {
      if (inUse.has(blob) || safeSegment(blob) !== blob) continue;
      await fs.promises.unlink(path.join(dir, blob)).catch(() => {});
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

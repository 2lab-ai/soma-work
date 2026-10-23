/**
 * Turns the work-log stream into session artifacts.
 *
 * Every step of a turn already reaches the daemon as a work-log entry
 * (src/index.ts wires the stream executor's `appendWorkLog` provider):
 *
 *   tool        mcp__slack-mcp__send_file|send_media  raw = the tool input JSON ({ file_path, filename, title, … })
 *   tool_result same tool                              raw = the tool's JSON reply ({ uploaded, file_id, filename, size, permalink, … })
 *   final       the turn's final answer                text = the whole answer (the work log caps it later, not here)
 *
 * The slack-mcp server runs as a grandchild stdio process, so this is the one
 * place the daemon sees both halves of an upload. A call and its result carry
 * the same `toolUseId`; the bytes are snapshotted when the call arrives — the
 * file the model asked to upload, before /tmp cleanup can take it — and kept
 * only if the result reports `uploaded: true`.
 *
 * Uploads made before this capture existed are recovered once per conversation
 * by `backfillArtifactsFromWorkLog` (stored work-log entries carry no tool-use
 * id; there a result pairs with the pending call of the same display name, else
 * the oldest pending one).
 */

import * as path from 'node:path';
import { Logger } from '../logger';
import { type ArtifactSnapshot, type ArtifactStore, getArtifactStore } from './artifacts';
import { readWorkLog, readWorkLogRaw } from './work-log';

const logger = new Logger('ArtifactCapture');

/** `mcp__slack-mcp__send_file` / `mcp__slack-mcp__send_media`. */
export const UPLOAD_TOOL = /^mcp__slack-mcp__send_(?:file|media)$/;

/** The work-log entry fields this module reads (a subset of WorkLogInput / WorkLogEntry). */
export interface CaptureEntry {
  kind: string;
  text: string;
  tool?: string;
  toolUseId?: string;
  ok?: boolean;
  turnId?: string;
  ts?: number;
  raw?: string;
}

interface PendingUpload {
  tool: string;
  toolUseId?: string;
  filePath?: string;
  displayName: string;
  title?: string;
  snapshot: Promise<ArtifactSnapshot | null>;
}

/** Calls without a result yet, per conversation. Bounded: a turn that dies mid-upload must not leak. */
const MAX_PENDING = 32;
const pendingByConversation = new Map<string, PendingUpload[]>();

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function pendingFromCall(entry: CaptureEntry, input: Record<string, unknown> | null): Omit<PendingUpload, 'snapshot'> {
  const filePath = str(input?.file_path);
  return {
    tool: entry.tool as string,
    ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
    filePath,
    displayName: str(input?.filename) ?? (filePath ? path.basename(filePath) : ''),
    title: str(input?.title),
  };
}

/** By tool-use id when the result has one; else same tool + display name; else the oldest of that tool. */
function takeMatching<T extends { tool: string; toolUseId?: string; displayName: string }>(
  queue: T[],
  tool: string,
  toolUseId: string | undefined,
  filename: string | undefined,
): T | undefined {
  let idx = toolUseId ? queue.findIndex((p) => p.toolUseId === toolUseId) : -1;
  if (idx < 0 && !toolUseId) {
    if (filename) idx = queue.findIndex((p) => p.tool === tool && p.displayName === filename);
    if (idx < 0) idx = queue.findIndex((p) => p.tool === tool);
  }
  if (idx < 0) return undefined;
  return queue.splice(idx, 1)[0];
}

function uploadReply(entry: CaptureEntry) {
  const reply = parseJsonObject(entry.raw);
  return {
    ok: entry.ok !== false && reply?.uploaded === true,
    filename: str(reply?.filename),
    fileId: str(reply?.file_id),
    permalink: str(reply?.permalink),
    size: typeof reply?.size === 'number' ? reply.size : undefined,
  };
}

/**
 * Observe one live work-log entry. Never throws — the work log must not break
 * the turn — and returns the recording promise (tests await it; production ignores it).
 */
export function captureArtifactFromWorkLog(
  conversationId: string,
  entry: CaptureEntry,
  store: ArtifactStore = getArtifactStore(),
): Promise<void> {
  try {
    if (!conversationId || !entry) return Promise.resolve();

    if (entry.kind === 'tool' && entry.tool && UPLOAD_TOOL.test(entry.tool)) {
      const call = pendingFromCall(entry, parseJsonObject(entry.raw));
      const pending: PendingUpload = { ...call, snapshot: store.snapshot(conversationId, call.filePath) };
      const queue = pendingByConversation.get(conversationId) ?? [];
      queue.push(pending);
      if (queue.length > MAX_PENDING) {
        const evicted = queue.shift();
        void evicted?.snapshot.then((s) => store.discardSnapshot(conversationId, s));
      }
      pendingByConversation.set(conversationId, queue);
      return pending.snapshot.then(() => undefined);
    }

    if (entry.kind === 'tool_result' && entry.tool && UPLOAD_TOOL.test(entry.tool)) {
      const reply = uploadReply(entry);
      const queue = pendingByConversation.get(conversationId) ?? [];
      const pending = takeMatching(queue, entry.tool, entry.toolUseId, reply.filename);
      if (queue.length === 0) pendingByConversation.delete(conversationId);
      return (async () => {
        const snap = pending ? await pending.snapshot : null;
        if (!reply.ok) {
          await store.discardSnapshot(conversationId, snap);
          return;
        }
        await store.recordSlackUpload({
          conversationId,
          snapshot: snap,
          filename: reply.filename ?? pending?.displayName,
          title: pending?.title,
          slackFileId: reply.fileId,
          permalink: reply.permalink,
          size: reply.size,
          tool: entry.tool?.replace(/^mcp__slack-mcp__/, ''),
          turnId: entry.turnId,
          now: entry.ts,
        });
      })().catch((err) => logger.warn(`Upload artifact not recorded for ${conversationId}`, err));
    }

    if (entry.kind === 'final' && typeof entry.text === 'string') {
      return store
        .recordAnswer({
          conversationId,
          turnId: entry.turnId ?? `final:${entry.ts ?? Date.now()}`,
          markdown: entry.raw ?? entry.text,
          now: entry.ts,
        })
        .then(() => undefined)
        .catch((err) => logger.warn(`Answer artifact not recorded for ${conversationId}`, err));
    }
  } catch (err) {
    logger.warn('Artifact capture failed', err);
  }
  return Promise.resolve();
}

/** What the backfill reads — the work-log store's read API (injectable for tests). */
export interface WorkLogReader {
  readWorkLog(
    conversationId: string,
    opts: { afterSeq?: number; limit?: number },
  ): Promise<{ entries: Array<CaptureEntry & { seq: number; rawBytes?: number }>; hasMore: boolean }>;
  readWorkLogRaw(conversationId: string, seq: number): Promise<{ raw: string } | null | 'budget'>;
}

const defaultReader: WorkLogReader = { readWorkLog, readWorkLogRaw } as unknown as WorkLogReader;

const BACKFILL_PAGE = 500;
const backfillInflight = new Map<string, Promise<void>>();

/**
 * Record the uploads and markdown answers of a conversation's existing work log,
 * once. Idempotent (Slack file id / turn id dedupe) and safe to race with live
 * capture. Bytes are kept when the uploaded file is still a readable /tmp file.
 */
export function backfillArtifactsFromWorkLog(
  conversationId: string,
  store: ArtifactStore = getArtifactStore(),
  reader: WorkLogReader = defaultReader,
): Promise<void> {
  if (!conversationId || store.isBackfilled(conversationId)) return Promise.resolve();
  const running = backfillInflight.get(conversationId);
  if (running) return running;
  const run = (async () => {
    const rawOf = async (seq: number): Promise<string | undefined> => {
      const r = await reader.readWorkLogRaw(conversationId, seq);
      return r && r !== 'budget' ? r.raw : undefined;
    };
    const pending: Array<Omit<PendingUpload, 'snapshot'>> = [];
    let afterSeq = 0;
    let sawAny = false;
    for (;;) {
      const page = await reader.readWorkLog(conversationId, { afterSeq, limit: BACKFILL_PAGE });
      for (const e of page.entries) {
        sawAny = true;
        afterSeq = Math.max(afterSeq, e.seq);
        if (e.tool && UPLOAD_TOOL.test(e.tool) && (e.kind === 'tool' || e.kind === 'tool_result')) {
          const raw = e.rawBytes ? await rawOf(e.seq) : undefined;
          if (e.kind === 'tool') {
            pending.push(pendingFromCall(e, parseJsonObject(raw)));
            continue;
          }
          const reply = uploadReply({ ...e, raw });
          const call = takeMatching(pending, e.tool, undefined, reply.filename);
          if (!reply.ok) continue;
          await store.recordSlackUpload({
            conversationId,
            filePath: call?.filePath,
            filename: reply.filename ?? call?.displayName,
            title: call?.title,
            slackFileId: reply.fileId,
            permalink: reply.permalink,
            size: reply.size,
            tool: e.tool.replace(/^mcp__slack-mcp__/, ''),
            turnId: e.turnId,
            now: e.ts,
          });
        } else if (e.kind === 'final') {
          const text = e.rawBytes ? ((await rawOf(e.seq)) ?? e.text) : e.text;
          await store.recordAnswer({
            conversationId,
            turnId: e.turnId ?? `final:${e.seq}`,
            markdown: text,
            now: e.ts,
          });
        }
      }
      if (!page.hasMore || page.entries.length === 0) break;
    }
    // Persist the marker only when there was a log to read; an empty one may still fill later.
    store.markBackfilled(conversationId, sawAny);
  })()
    .catch((err) => {
      // Not again on every board build this process: an unreadable log stays unreadable.
      logger.warn(`Artifact backfill failed for ${conversationId}`, err);
      store.markBackfilled(conversationId, false);
    })
    .finally(() => backfillInflight.delete(conversationId));
  backfillInflight.set(conversationId, run);
  return run;
}

/** Tests only: forget pending uploads. */
export function resetArtifactCaptureForTests(): void {
  pendingByConversation.clear();
  backfillInflight.clear();
}

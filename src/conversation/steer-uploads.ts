/**
 * The panel composer's files reach the session thread once (#488).
 *
 * An instruction to a running session carries its files through the session's
 * Slack thread (`injectDashboardMessage`). A failed send keeps its files for a
 * retry; uploading them all again would post the ones Slack already took a
 * second time. So each file goes up on its own, and its Slack id is kept the
 * moment Slack takes it — before its metadata is read back — so a retry reuses
 * it (same thread, same bytes and name, within the window): a failed metadata
 * read is read again, never uploaded again.
 */

import { createHash } from 'node:crypto';
import type { NewTaskAttachment } from './new-task';
import type { SlackEventFile } from './new-task-launcher';

export interface SteerUploadIo {
  /** Upload one file into the thread; its Slack file id. */
  upload(channel: string, threadTs: string, file: NewTaskAttachment): Promise<string>;
  /** Read an uploaded file back in the shape the message pipeline downloads from. */
  resolve(id: string): Promise<SlackEventFile>;
}

export interface SteerUploaderOptions {
  /** How long an uploaded file is reused for a retry (default 15 minutes). */
  ttlMs?: number;
  /** Most files remembered (oldest forgotten first). */
  max?: number;
  now?: () => number;
}

export function createSteerUploader(
  io: SteerUploadIo,
  opts: SteerUploaderOptions = {},
): (channel: string, threadTs: string, files: NewTaskAttachment[]) => Promise<SlackEventFile[]> {
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  const max = opts.max ?? 200;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, { id: string; file?: SlackEventFile; at: number }>();
  return async (channel, threadTs, files) => {
    const out: SlackEventFile[] = [];
    for (const f of files) {
      const key = `${channel}\u0000${threadTs}\u0000${f.name}\u0000${createHash('sha256').update(f.data).digest('hex')}`;
      let entry = seen.get(key);
      if (!entry || now() - entry.at >= ttlMs) {
        // One file per upload: each one is taken or not, never "k of n".
        const id = await io.upload(channel, threadTs, f);
        entry = { id, at: now() };
        seen.delete(key);
        seen.set(key, entry);
        while (seen.size > max) seen.delete(seen.keys().next().value as string);
      }
      if (!entry.file) entry.file = await io.resolve(entry.id);
      out.push(entry.file);
    }
    return out;
  };
}

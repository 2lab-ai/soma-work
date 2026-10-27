/**
 * The panel composer's files reach the session thread once (#488).
 *
 * An instruction to a running session carries its files through the session's
 * Slack thread (`injectDashboardMessage`). A failed send keeps its files for a
 * retry; uploading them all again would post the ones Slack already took a
 * second time. So each file goes up on its own, and a file already uploaded to
 * the same thread — same bytes, same name, within the window — is reused.
 */

import { createHash } from 'node:crypto';
import type { NewTaskAttachment } from './new-task';
import type { SlackEventFile } from './new-task-launcher';

type Upload = (channel: string, threadTs: string, files: NewTaskAttachment[]) => Promise<SlackEventFile[]>;

export interface SteerUploaderOptions {
  /** How long an uploaded file is reused for a retry (default 15 minutes). */
  ttlMs?: number;
  /** Most files remembered (oldest forgotten first). */
  max?: number;
  now?: () => number;
}

export function createSteerUploader(upload: Upload, opts: SteerUploaderOptions = {}): Upload {
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  const max = opts.max ?? 200;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, { file: SlackEventFile; at: number }>();
  return async (channel, threadTs, files) => {
    const out: SlackEventFile[] = [];
    for (const f of files) {
      const key = `${channel}\u0000${threadTs}\u0000${f.name}\u0000${createHash('sha256').update(f.data).digest('hex')}`;
      const hit = seen.get(key);
      if (hit && now() - hit.at < ttlMs) {
        out.push(hit.file);
        continue;
      }
      // One file per upload: each one is taken or not, never "k of n".
      const [file] = await upload(channel, threadTs, [f]);
      seen.delete(key);
      seen.set(key, { file, at: now() });
      while (seen.size > max) seen.delete(seen.keys().next().value as string);
      out.push(file);
    }
    return out;
  };
}

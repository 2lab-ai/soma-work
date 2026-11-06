import { describe, expect, it } from 'vitest';
import { FollowupQueue, type FollowupQueueSnapshot } from '../followup-queue';
import { parseFollowupQueueSnapshot } from '../followup-queue-store';
import type { MessageEvent } from '../pipeline/types';

/**
 * SSOT 2026-11-06 (dev, this thread): two instructions sent with a pasted screenshot while a turn ran
 * were never stored. Slack's files.info answered right after the upload with an empty `mimetype`, the
 * store rejected the whole snapshot (`files[0].mimetype is not a non-empty string`) and the message was
 * dropped — the agent never saw it. A file's descriptive fields must never cost the message.
 */

const SESSION = 'C1:1700.000000';

/** A queue that persists through the real store's validation, as production does. */
function storedQueue(): FollowupQueue {
  return new FollowupQueue({
    save: (snapshot: FollowupQueueSnapshot) => {
      parseFollowupQueueSnapshot(JSON.parse(JSON.stringify(snapshot)));
    },
  });
}

function withFile(file: Record<string, unknown>): MessageEvent {
  return {
    user: 'U1',
    channel: 'C1',
    thread_ts: '1700.000000',
    ts: '1700.000200',
    text: '지금 뭔가 상태 이상해 다시 리뷰하고 픽스해',
    files: [
      {
        id: 'F0CEY2Q0YP9',
        name: 'screenshot-20261106-103444.png',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/files-pri/T1-F0CEY2Q0YP9/screenshot.png',
        url_private_download: 'https://files.slack.com/files-pri/T1-F0CEY2Q0YP9/download/screenshot.png',
        size: 79804,
        ...file,
      },
    ],
  } as MessageEvent;
}

describe('a follow-up with a file is stored even when Slack has not filled the file in yet', () => {
  it('an empty mimetype and filetype are named from the file name — the message is queued, not dropped', () => {
    const queue = storedQueue();
    const result = queue.enqueue(SESSION, withFile({ mimetype: '', filetype: '' }));
    expect(result.status).toBe('queued');
    const stored = queue.list(SESSION)[0].message.files?.[0];
    expect(stored?.mimetype).toBe('image/png');
    expect(stored?.filetype).toBe('png');
    expect(queue.list(SESSION)[0].message.text).toBe('지금 뭔가 상태 이상해 다시 리뷰하고 픽스해');
  });

  it('a name without a known extension falls back to a generic type; an empty name to the file id', () => {
    const queue = storedQueue();
    const result = queue.enqueue(SESSION, withFile({ name: '', mimetype: '', filetype: '' }));
    expect(result.status).toBe('queued');
    const stored = queue.list(SESSION)[0].message.files?.[0];
    expect(stored?.name).toBe('F0CEY2Q0YP9');
    expect(stored?.mimetype).toBe('application/octet-stream');
    expect(stored?.filetype).toBe('binary');
  });

  it('a missing url_private takes the download URL; a missing size is 0', () => {
    const queue = storedQueue();
    const result = queue.enqueue(SESSION, withFile({ url_private: '', size: undefined }));
    expect(result.status).toBe('queued');
    const stored = queue.list(SESSION)[0].message.files?.[0];
    expect(stored?.url_private).toBe('https://files.slack.com/files-pri/T1-F0CEY2Q0YP9/download/screenshot.png');
    expect(stored?.size).toBe(0);
  });

  it('a file nobody can fetch (no id, no URL) is left out — the message and its text are kept', () => {
    const queue = storedQueue();
    const result = queue.enqueue(SESSION, withFile({ id: '', url_private: '', url_private_download: '' }));
    expect(result.status).toBe('queued');
    expect(queue.list(SESSION)[0].message.files).toEqual([]);
    expect(queue.list(SESSION)[0].message.text).toBe('지금 뭔가 상태 이상해 다시 리뷰하고 픽스해');
  });

  it('files that arrive late in a second envelope are made storable too', () => {
    const queue = storedQueue();
    const first = queue.enqueue(SESSION, { ...withFile({}), files: undefined } as MessageEvent);
    if (first.status !== 'queued') throw new Error('not queued');
    const late = withFile({ mimetype: '', filetype: '' }).files ?? [];
    const attached = queue.attachFilesQueued(SESSION, first.item.id, first.item.epoch, late);
    expect(attached.ok).toBe(true);
    expect(queue.list(SESSION)[0].message.files?.[0]?.mimetype).toBe('image/png');
  });

  it('a complete file is stored exactly as it came', () => {
    const queue = storedQueue();
    const message = withFile({});
    expect(queue.enqueue(SESSION, message).status).toBe('queued');
    expect(queue.list(SESSION)[0].message).toEqual(message);
  });
});

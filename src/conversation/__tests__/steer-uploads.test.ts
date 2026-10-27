/**
 * #488 — the composer's files reach the session thread once: a retry after a
 * failed send never uploads again a file Slack already took — whether the
 * failure was another file's upload or reading this file's metadata back.
 */
import { describe, expect, it } from 'vitest';
import { createSteerUploader } from '../steer-uploads';

const file = (name: string, body: string) => ({ name, mimetype: 'image/png', data: Buffer.from(body) });

function fakeSlack() {
  const uploads: string[] = [];
  const reads: string[] = [];
  let failUpload: string | null = null;
  let failRead: string | null = null;
  return {
    uploads,
    reads,
    failUpload: (n: string | null) => (failUpload = n),
    failRead: (n: string | null) => (failRead = n),
    io: {
      upload: async (_c: string, _t: string, f: { name: string }) => {
        uploads.push(f.name);
        if (f.name === failUpload) throw new Error('Slack accepted 0 of 1 files');
        return `F-${f.name}`;
      },
      resolve: async (id: string) => {
        reads.push(id);
        if (id === `F-${failRead}`) throw new Error('Slack has no download URL yet');
        return { id, name: id.slice(2) } as never;
      },
    },
  };
}

describe('createSteerUploader (#488)', () => {
  it('uploads one file at a time and, on a retry, only the files Slack did not take', async () => {
    const slack = fakeSlack();
    const up = createSteerUploader(slack.io);
    slack.failUpload('b.png');
    await expect(up('C1', 't1', [file('a.png', 'A'), file('b.png', 'B')])).rejects.toThrow();
    slack.failUpload(null);
    const out = await up('C1', 't1', [file('a.png', 'A'), file('b.png', 'B')]);
    expect(out.map((f) => f.id)).toEqual(['F-a.png', 'F-b.png']);
    expect(slack.uploads).toEqual(['a.png', 'b.png', 'b.png']);
  });

  it('a file Slack took whose metadata read failed is read again on the retry, never uploaded again', async () => {
    const slack = fakeSlack();
    const up = createSteerUploader(slack.io);
    slack.failRead('a.png');
    await expect(up('C1', 't1', [file('a.png', 'A')])).rejects.toThrow();
    slack.failRead(null);
    const out = await up('C1', 't1', [file('a.png', 'A')]);
    expect(out.map((f) => f.id)).toEqual(['F-a.png']);
    expect(slack.uploads).toEqual(['a.png']);
    expect(slack.reads).toEqual(['F-a.png', 'F-a.png']);
  });

  it('the same bytes in another thread, or after the window, are uploaded again', async () => {
    const slack = fakeSlack();
    let now = 0;
    const up = createSteerUploader(slack.io, { ttlMs: 1000, now: () => now });
    await up('C1', 't1', [file('a.png', 'A')]);
    await up('C1', 't2', [file('a.png', 'A')]);
    now = 5000;
    await up('C1', 't1', [file('a.png', 'A')]);
    expect(slack.uploads).toEqual(['a.png', 'a.png', 'a.png']);
  });

  it('a different file with the same name is a different file', async () => {
    const slack = fakeSlack();
    const up = createSteerUploader(slack.io);
    await up('C1', 't1', [file('a.png', 'A')]);
    await up('C1', 't1', [file('a.png', 'other bytes')]);
    expect(slack.uploads).toEqual(['a.png', 'a.png']);
  });
});

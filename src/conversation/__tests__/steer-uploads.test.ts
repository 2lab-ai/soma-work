/**
 * #488 — the composer's files reach the session thread once: a retry after a
 * failed upload never uploads again the files Slack already took.
 */
import { describe, expect, it } from 'vitest';
import { createSteerUploader } from '../steer-uploads';

const file = (name: string, body: string) => ({ name, mimetype: 'image/png', data: Buffer.from(body) });

function fakeSlack() {
  const calls: string[][] = [];
  let failOn: string | null = null;
  const upload = async (_c: string, _t: string, files: Array<{ name: string }>) => {
    calls.push(files.map((f) => f.name));
    if (files.some((f) => f.name === failOn)) throw new Error('Slack accepted 0 of 1 files');
    return files.map((f) => ({ id: `F-${f.name}`, name: f.name }) as never);
  };
  return { calls, upload, failOn: (n: string | null) => (failOn = n) };
}

describe('createSteerUploader (#488)', () => {
  it('uploads one file at a time and, on a retry, only the files Slack did not take', async () => {
    const slack = fakeSlack();
    const up = createSteerUploader(slack.upload);
    slack.failOn('b.png');
    await expect(up('C1', 't1', [file('a.png', 'A'), file('b.png', 'B')])).rejects.toThrow();
    slack.failOn(null);
    const out = await up('C1', 't1', [file('a.png', 'A'), file('b.png', 'B')]);
    expect(out.map((f) => f.id)).toEqual(['F-a.png', 'F-b.png']);
    expect(slack.calls).toEqual([['a.png'], ['b.png'], ['b.png']]);
  });

  it('the same bytes in another thread, or after the window, are uploaded again', async () => {
    const slack = fakeSlack();
    let now = 0;
    const up = createSteerUploader(slack.upload, { ttlMs: 1000, now: () => now });
    await up('C1', 't1', [file('a.png', 'A')]);
    await up('C1', 't2', [file('a.png', 'A')]);
    now = 5000;
    await up('C1', 't1', [file('a.png', 'A')]);
    expect(slack.calls).toEqual([['a.png'], ['a.png'], ['a.png']]);
  });

  it('a different file with the same name is a different file', async () => {
    const slack = fakeSlack();
    const up = createSteerUploader(slack.upload);
    await up('C1', 't1', [file('a.png', 'A')]);
    await up('C1', 't1', [file('a.png', 'other bytes')]);
    expect(slack.calls).toEqual([['a.png'], ['a.png']]);
  });
});

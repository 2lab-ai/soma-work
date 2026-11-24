import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyRelease } from '../release-notifier';

const sha = (n: number) => `${String(n).padStart(4, '0')}${'a'.repeat(36)}`;

let root: string;
let distDir: string;
let notifiedFile: string;

const write = (file: string, value: unknown) => fs.writeFileSync(path.join(distDir, file), JSON.stringify(value));
const version = (over: Record<string, unknown> = {}) => ({
  version: '0.3.108',
  previousVersion: '0.3.107',
  tag: 'v0.3.108-dev',
  previousTag: 'v0.3.107-dev',
  commitHash: sha(10),
  commitHashShort: sha(10).slice(0, 8),
  commitTime: '2026-11-24T02:00:00Z',
  branch: 'main',
  buildTime: '2026-11-24T02:10:00Z',
  // The bundle's default: since the last deploy anywhere (another host, one commit back).
  releaseNotes: '• change 10 (#110)',
  ...over,
});

function fakeClient() {
  const postMessage = vi.fn(async (_args: { text: string; blocks: Array<{ text?: { text: string } }> }) => ({
    ok: true,
  }));
  return { client: { chat: { postMessage } } as never, postMessage };
}
const notesOf = (call: { blocks: Array<{ text?: { text: string } }> }) =>
  call.blocks.map((b) => b.text?.text ?? '').find((t) => t.startsWith('*📋 변경 사항*')) ?? '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notifier-'));
  distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir);
  notifiedFile = path.join(root, 'data', 'release-notified.json');
  vi.stubEnv('DEFAULT_UPDATE_CHANNEL', 'C0UPDATES01');
  write('version.json', version());
  write('release-history.json', {
    head: sha(10),
    entries: Array.from({ length: 10 }, (_, i) => ({ sha: sha(10 - i), title: `change ${10 - i}`, pr: 110 - i })),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('notifyRelease — this host’s changes, once per deploy', () => {
  it('announces every PR since the version this deploy replaced here, not since the last deploy anywhere', async () => {
    // This host ran v0.3.103 (commit 3); four deploys to other hosts happened since.
    write('previous-version.json', version({ version: '0.3.103', tag: 'v0.3.103-dev', commitHash: sha(3) }));
    const { client, postMessage } = fakeClient();
    await notifyRelease(client, { distDir, notifiedFile });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const call = postMessage.mock.calls[0][0];
    expect(call.text).toContain('v0.3.103 → v0.3.108');
    const notes = notesOf(call);
    expect(notes).toContain('_(v0.3.103-dev → v0.3.108-dev)_');
    for (let n = 4; n <= 10; n++) expect(notes).toContain(`• change ${n} (#${100 + n})`);
    expect(notes).not.toContain('change 3 ');
    expect(notes).not.toContain('Initial release');
  });

  it('a restart of the same build posts nothing; the next build posts again', async () => {
    write('previous-version.json', version({ version: '0.3.103', tag: 'v0.3.103-dev', commitHash: sha(3) }));
    const first = fakeClient();
    await notifyRelease(first.client, { distDir, notifiedFile });
    expect(first.postMessage).toHaveBeenCalledTimes(1);

    const restart = fakeClient();
    await notifyRelease(restart.client, { distDir, notifiedFile });
    expect(restart.postMessage).not.toHaveBeenCalled();

    write('version.json', version({ version: '0.3.109', tag: 'v0.3.109-dev', buildTime: '2026-11-24T05:00:00Z' }));
    const next = fakeClient();
    await notifyRelease(next.client, { distDir, notifiedFile });
    expect(next.postMessage).toHaveBeenCalledTimes(1);
  });

  it('a failed post is not recorded: the next start tries again', async () => {
    const failing = fakeClient();
    failing.postMessage.mockRejectedValueOnce(new Error('channel_not_found'));
    await notifyRelease(failing.client, { distDir, notifiedFile });
    expect(fs.existsSync(notifiedFile)).toBe(false);
    const retry = fakeClient();
    await notifyRelease(retry.client, { distDir, notifiedFile });
    expect(retry.postMessage).toHaveBeenCalledTimes(1);
  });

  it('without a previous version on this host it falls back to the bundle notes', async () => {
    const { client, postMessage } = fakeClient();
    await notifyRelease(client, { distDir, notifiedFile });
    const notes = notesOf(postMessage.mock.calls[0][0]);
    expect(notes).toContain('_(v0.3.107-dev → v0.3.108-dev)_');
    expect(notes).toContain('• change 10 (#110)');
  });
});

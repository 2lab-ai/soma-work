/**
 * .prd/27 §1 — the host side: what a run reads from the session, and that it writes back only while the key still names
 * that session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodeChangesService, type SessionLike, sessionPrUrls } from '../service';
import { CodeChangesStore } from '../store';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function setup(session: SessionLike & { key?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-svc-'));
  roots.push(dir);
  const sessions = new Map<string, SessionLike>([['k1', session]]);
  const persist = vi.fn();
  const pushCard = vi.fn();
  const onResult = vi.fn();
  const listCheckoutDirs = vi.fn(async () => ({ dirs: [] as string[] }));
  const svc = createCodeChangesService({
    getSessionByKey: (k) => sessions.get(k),
    allSessions: () => sessions.entries(),
    persist,
    pushCard,
    onResult,
    store: new CodeChangesStore(dir),
    collect: {
      listCheckoutDirs,
      fetchPullDetail: async () => undefined,
      fetchPullFiles: async () => undefined,
      now: () => 7,
    },
    scheduler: { delayMs: 0, minIntervalMs: 0 },
  });
  return { svc, sessions, persist, pushCard, onResult, listCheckoutDirs };
}

describe('code-changes service', () => {
  it('sessionPrUrls: the current PR first, then the history newest first, once each', () => {
    expect(
      sessionPrUrls({
        links: { pr: { url: 'https://github.com/a/b/pull/3' } },
        linkHistory: {
          prs: [{ url: 'https://github.com/a/b/pull/1' }, { url: 'https://github.com/a/b/pull/3' }, null],
        },
      }),
    ).toEqual(['https://github.com/a/b/pull/3', 'https://github.com/a/b/pull/1']);
  });

  it('a turn-end snapshot reads the session’s folders and writes its summary, persists, pushes the card', async () => {
    const session: SessionLike = {
      conversationId: 'conv1',
      ownerId: 'U1',
      sessionWorkingDir: '/tmp/U1/session_1794756694405_abc',
    };
    const t = setup(session);
    t.svc.snapshot({ sessionKey: 'k1', workingDirectory: '/tmp/U1/session_1794756694405_abc/repo' });
    await t.svc.scheduler.idle();
    expect(t.listCheckoutDirs).toHaveBeenCalledWith(
      ['/tmp/U1/session_1794756694405_abc', '/tmp/U1/session_1794756694405_abc/repo'],
      expect.any(Number),
    );
    expect(session.codeChanges?.updatedAt).toBe(7);
    expect(t.persist).toHaveBeenCalledWith('k1');
    expect(t.pushCard).toHaveBeenCalledWith('k1');
    expect(t.onResult).toHaveBeenCalledTimes(1);
  });

  it('a session replaced (or terminated) while the run was under way is not written', async () => {
    const session: SessionLike = { conversationId: 'conv1', sessionWorkingDir: '/tmp/x/session_1794756694405_a' };
    const t = setup(session);
    t.listCheckoutDirs.mockImplementation(async () => {
      t.sessions.set('k1', { conversationId: 'conv2', sessionWorkingDir: '/tmp/y' });
      return { dirs: [] };
    });
    t.svc.snapshot({ sessionKey: 'k1' });
    await t.svc.scheduler.idle();
    expect(session.codeChanges).toBeUndefined();
    expect(t.persist).not.toHaveBeenCalled();
  });

  it('refresh runs now for the live session of a conversation; false when none holds it', async () => {
    const session: SessionLike = { conversationId: 'conv1', sessionWorkingDir: '/tmp/x/session_1794756694405_a' };
    const t = setup(session);
    expect(await t.svc.refresh('conv1')).toBe(true);
    expect(session.codeChanges).toBeDefined();
    expect(await t.svc.refresh('conv-none')).toBe(false);
    session.terminated = true;
    expect(await t.svc.refresh('conv1')).toBe(false);
  });
});

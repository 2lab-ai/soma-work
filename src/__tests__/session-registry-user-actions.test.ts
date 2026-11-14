/**
 * User actions (instruct_user) survive a restart: SessionRegistry writes `session.userActions` and reads it back —
 * the pending one still answerable (its Slack ts kept, so its card can be rewritten), the answered one still answered.
 */
import fs from 'node:fs';
import { inspectUserActionScript, resolveUserAction, type UserActionRecord } from 'somalib/user-action/user-action';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return { TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-user-actions-test-${process.pid}`) };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));

import { SessionRegistry } from '../session-registry';

function action(id: string, over: Partial<UserActionRecord> = {}): UserActionRecord {
  const script = "open 'https://example.com/verify'";
  return {
    id,
    title: '인증 페이지 열기',
    host: 'owner-mac',
    why: '소유자 본인만 할 수 있다.',
    script,
    shell: 'bash',
    expect: '페이지가 열린다',
    effects: '페이지를 연다.',
    optional: false,
    createdAt: 1,
    status: 'pending',
    inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
    ...over,
  };
}

describe('SessionRegistry — user actions across a restart', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('a pending and an answered action come back as they were; the pending one can still be answered once', () => {
    const before = new SessionRegistry();
    const s = before.createSession('U1', 'User', 'C1', '300.001');
    s.sessionId = 'sid-1';
    s.userActions = [
      action('ua_pending', { slackTs: '111.222' }),
      action('ua_done', { status: 'done', resolvedBy: 'U1', resolvedAt: 9 }),
    ];
    before.saveSessions();

    const after = new SessionRegistry();
    after.loadSessions();
    const restored = after.getSession('C1', '300.001');
    expect(restored?.userActions).toEqual(s.userActions);

    const answered = resolveUserAction(restored?.userActions, 'ua_pending', 'done', 'U1', 10);
    expect(answered.ok).toBe(true);
    expect(resolveUserAction(restored?.userActions, 'ua_done', 'failed', 'U1', 11)).toMatchObject({
      ok: false,
      reason: 'already-resolved',
    });
  });

  it('malformed stored entries are dropped, not crashing the load', () => {
    const before = new SessionRegistry();
    const s = before.createSession('U1', 'User', 'C1', '300.002');
    s.sessionId = 'sid-2';
    s.userActions = [action('ua_ok'), { id: 'broken' } as unknown as UserActionRecord];
    before.saveSessions();

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSession('C1', '300.002')?.userActions?.map((a) => a.id)).toEqual(['ua_ok']);
  });
});

/**
 * Slack's sleep / expiry notices and the session list's countdowns state the
 * admin-set lifecycle durations, not the old fixed "24시간" / "7일".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../user-settings-store')>();
  return {
    ...actual,
    userSettingsStore: { ...actual.userSettingsStore, getUserSessionTheme: vi.fn().mockReturnValue('default') },
  };
});

import type { ClaudeHandler } from '../../claude-handler';
import { __resetSessionLifecyclePolicyForTests, updateSessionLifecyclePolicy } from '../../session-lifecycle-policy';
import type { ConversationSession } from '../../types';
import { SessionUiManager } from '../session-manager';
import type { SlackApiHelper } from '../slack-api-helper';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function setup() {
  const slackApi = {
    postMessage: vi.fn().mockResolvedValue({ ts: '1.2', channel: 'C1', threadTs: '111.222', echoedMessage: true }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    getThreadRootState: vi.fn().mockResolvedValue('exists'),
    getUserName: vi.fn().mockResolvedValue('User'),
    getChannelName: vi.fn().mockResolvedValue('#c'),
    getPermalink: vi.fn().mockResolvedValue('https://slack.com/x'),
  };
  const handler = {
    getAllSessions: vi.fn().mockReturnValue(new Map()),
    getSessionKey: vi.fn().mockImplementation((c: string, t?: string) => `${c}-${t}`),
  };
  const manager = new SessionUiManager(handler as unknown as ClaudeHandler, slackApi as unknown as SlackApiHelper);
  const session = {
    ownerId: 'U1',
    ownerName: 'User',
    userId: 'U1',
    channelId: 'C1',
    threadTs: '111.222',
    sessionId: 's1',
    isActive: true,
    lastActivity: new Date(),
  } as ConversationSession;
  const posted = () => {
    const calls = slackApi.postMessage.mock.calls;
    return String(calls[calls.length - 1]?.[1] ?? '');
  };
  return { manager, session, posted };
}

describe('lifecycle notices follow the policy', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-lifecycle-text-'));
    __resetSessionLifecyclePolicyForTests(path.join(dir, 'session-lifecycle.json'));
  });

  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults still read 24시간 / 7일', async () => {
    const { manager, session, posted } = setup();
    await manager.handleSessionSleep(session);
    expect(posted()).toContain('24시간 동안 활동이 없어');
    expect(posted()).toContain('Sleep 모드는 7일 동안 유지되며');
    await manager.handleSessionExpiry(session);
    expect(posted()).toContain('Sleep 모드가 7일 경과하여');
  });

  it('an admin-set policy changes the stated durations', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 6 * HOUR, archiveAfterMs: 36 * HOUR });
    const { manager, session, posted } = setup();
    await manager.handleSessionSleep(session);
    expect(posted()).toContain('6시간 동안 활동이 없어');
    expect(posted()).toContain('Sleep 모드는 36시간 동안 유지되며');
    await manager.handleSessionExpiry(session);
    expect(posted()).toContain('Sleep 모드가 36시간 경과하여');
  });

  it('the session list counts down against the policy durations', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 6 * HOUR, archiveAfterMs: 2 * DAY });
    const { MessageFormatter } = await import('@soma/slack/message-formatter');
    const { getSessionLifecycleDurations } = await import('@soma/slack/session-manager');
    const d = getSessionLifecycleDurations();
    expect(d).toEqual({ sleepAfterMs: 6 * HOUR, archiveAfterMs: 2 * DAY });
    expect(MessageFormatter.formatExpiresIn(new Date(Date.now() - HOUR), d.sleepAfterMs)).toMatch(
      /^(4시간 5\d분|5시간 0분) 남음$/,
    );
  });
});

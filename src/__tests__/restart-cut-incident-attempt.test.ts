/**
 * A restart that cuts an Eagle incident attempt settles it — it does not resume it.
 *
 * Incident (dev, 2026-11-06): the receiver restarted about 20 times in one day. An incident attempt that a restart
 * cut got the ordinary crash recovery: a "자동으로 재개합니다" notice in the bot-to-bot thread, then the ordinary
 * restart prompt ("The service was restarted… check git status…") as its next turn. That prompt is not an incident
 * request, and the cut attempt never wrote its finished marker, so the ingress refused every retry from Eagle as
 * `attempt_in_progress` — and the restored session stayed `working`, which the ingress refuses as `session_busy`.
 *
 * So a cut incident attempt ends the way any unfinished attempt ends: ONE host-authored result line (`interrupted`),
 * the finished marker, and an idle session. No notice, no resume turn. Eagle reads `interrupted` and asks once more.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock(import('../env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DATA_DIR: '/tmp/soma-work-restart-cut-incident-test' };
});

import { SlackHandler } from '../slack-handler';
import type { ConversationSession } from '../types';

const REQUEST = {
  version: 1,
  incident_id: 'EXT|ext:nupro365|NUPRO365 OUTAGE',
  lifecycle_id: '1794191513.354979',
  attempt_id: '1794191513.354979-a1-1794191513514342000',
  channel_id: 'C0EAGLE',
  parent_ts: '1794191513.354979',
  env: 'stage2',
  summary: 'NUPRO365 OUTAGE',
};

function incidentSession(extra: Partial<ConversationSession> = {}): ConversationSession {
  return {
    channelId: 'C0EAGLE',
    threadTs: '1794191513.354979',
    ownerId: 'U_EAGLE',
    activityState: 'working',
    incidentRequest: { ...REQUEST },
    ...extra,
  } as unknown as ConversationSession;
}

function ordinarySession(): ConversationSession {
  return { channelId: 'C0EAGLE', threadTs: '1794191513.354979', ownerId: 'U1', activityState: 'working' } as any;
}

async function boot(
  session: ConversationSession,
  working: boolean,
  opts: { diskAttemptId?: string | null; safeguardHalt?: boolean; onPost?: () => void } = {},
) {
  const key = 'C0EAGLE-1794191513.354979';
  const sessions = new Map<string, ConversationSession>([[key, session]]);
  const postMessage = vi.fn(async (_args: Record<string, unknown>) => {
    opts.onPost?.();
    return { ok: true, ts: '1794191600.000100' };
  });
  if (opts.safeguardHalt) (session as any).safeguardHalt = { at: 1 };
  const app = { client: { chat: { postMessage } }, assistant: vi.fn() } as any;
  const claudeHandler = {
    getAllSessions: vi.fn().mockReturnValue(sessions),
    getSessionByKey: vi.fn((k: string) => sessions.get(k)),
    getCrashRecoveredSessions: vi.fn().mockReturnValue([
      {
        channelId: 'C0EAGLE',
        threadTs: '1794191513.354979',
        ownerId: session.ownerId,
        activityState: working ? 'working' : 'idle',
        shouldAutoResume: working,
        sessionKey: key,
        // What the load read from disk before Slack delivered anything.
        ...(opts.diskAttemptId === null ? {} : { incidentAttemptId: opts.diskAttemptId ?? REQUEST.attempt_id }),
      },
    ]),
    clearCrashRecoveredSessions: vi.fn(),
    saveSessions: vi.fn(),
  } as any;
  const handler = new SlackHandler(app, claudeHandler, {} as any);
  const handleMessage = vi.fn(async () => {});
  (handler as any).handleMessage = handleMessage;
  await handler.notifyCrashRecovery();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { handleMessage, postMessage, claudeHandler };
}

describe('restart — a cut incident attempt is settled, never resumed', () => {
  it('posts one host-authored interrupted result and no recovery notice', async () => {
    const { postMessage } = await boot(incidentSession(), true);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const post = postMessage.mock.calls[0][0];
    expect(post.channel).toBe('C0EAGLE');
    expect(post.thread_ts).toBe('1794191513.354979');
    expect(post.text).not.toContain('서비스가 재시작되었습니다');
    expect(post.text).toContain('EAGLE_INCIDENT_RESULT:');
    expect(post.text).toContain('"status":"interrupted"');
    expect(post.text).toContain(REQUEST.attempt_id);
    // Published like any incident conclusion: Slack's own processing off.
    expect(post).toMatchObject({ unfurl_links: false, unfurl_media: false, parse: 'none', mrkdwn: false });
  });

  it('does not run the ordinary restart prompt as a turn', async () => {
    const { handleMessage } = await boot(incidentSession(), true);

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('leaves the thread ready for the retry: finished marker written, session idle, saved', async () => {
    const session = incidentSession();
    const { claudeHandler } = await boot(session, true);

    expect(session.incidentAttemptFinishedId).toBe(REQUEST.attempt_id);
    expect(session.activityState).toBe('idle');
    expect(claudeHandler.saveSessions).toHaveBeenCalled();
  });

  it('posts nothing for an attempt whose conclusion was already posted, and still frees the session', async () => {
    const session = incidentSession({
      incidentAttemptFinishedId: REQUEST.attempt_id,
      incidentAttemptPublishedId: REQUEST.attempt_id,
    } as any);
    const { postMessage, handleMessage } = await boot(session, true);

    expect(postMessage).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(session.activityState).toBe('idle');
  });

  // Graceful restart: shutdown aborted the run, the run wrote its finished
  // marker on the way out, and its conclusion was never posted (review of
  // c6713cf7, finding 1). The result is still owed.
  it('still posts the result when the cut run wrote its finished marker but never posted', async () => {
    const session = incidentSession({ incidentAttemptFinishedId: REQUEST.attempt_id } as any);
    const { postMessage } = await boot(session, true);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).toContain('"status":"interrupted"');
    expect(session.incidentAttemptPublishedId).toBe(REQUEST.attempt_id);
  });

  // Slack delivers events before recovery runs, so the ingress may already have
  // handed the thread to Eagle's retry (review finding 2). That attempt is live
  // work: no result for it, no marker, no state change.
  it('leaves a retry that took the thread over before recovery untouched', async () => {
    const session = incidentSession({
      activityState: 'working',
      incidentRequest: { ...REQUEST, attempt_id: 'AT-2' },
    } as any);
    const { postMessage, handleMessage } = await boot(session, true);

    expect(postMessage).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(session.incidentAttemptFinishedId).toBeUndefined();
    expect(session.activityState).toBe('working');
  });

  // The ingress can admit the retry the moment the marker and idle are set; if
  // they were set after the post's await, they would land on the retry.
  it('frees the thread before it awaits the post', async () => {
    const session = incidentSession();
    const seen: Array<{ marker?: string; state?: string }> = [];
    await boot(session, true, {
      onPost: () => seen.push({ marker: session.incidentAttemptFinishedId, state: session.activityState }),
    });

    expect(seen).toEqual([{ marker: REQUEST.attempt_id, state: 'idle' }]);
  });

  it('settles a cut attempt even in a thread the safeguards halted', async () => {
    const session = incidentSession();
    const { postMessage } = await boot(session, true, { safeguardHalt: true });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(session.incidentAttemptFinishedId).toBe(REQUEST.attempt_id);
    expect(session.activityState).toBe('idle');
  });

  it('posts nothing in an incident thread that was not working', async () => {
    const session = incidentSession({ activityState: 'idle' } as any);
    const { postMessage, handleMessage } = await boot(session, false);

    expect(postMessage).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(session.incidentAttemptFinishedId).toBeUndefined();
  });

  it('control: an ordinary working session still gets the notice and the resume turn', async () => {
    const { postMessage, handleMessage } = await boot(ordinarySession(), true);

    expect(postMessage.mock.calls[0][0].text).toContain('자동으로 재개합니다');
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});

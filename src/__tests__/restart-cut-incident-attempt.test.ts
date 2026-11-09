/**
 * A restart that cuts an Eagle incident attempt settles it — it does not resume it.
 *
 * Incident (dev, 2026-11-06): the receiver restarted about 20 times in one day. An incident attempt that a restart
 * cut got the ordinary crash recovery: a "자동으로 재개합니다" notice in the bot-to-bot thread, then the ordinary
 * restart prompt ("The service was restarted… check git status…") as its next turn. That prompt is not an incident
 * request, and the cut attempt never wrote its finished marker, so the ingress refused every retry from Eagle as
 * `attempt_in_progress` — and the restored session stayed `working`, which the ingress refuses as `session_busy`.
 *
 * So a cut incident attempt ends the way any unfinished attempt ends. The load marks it finished and idle before
 * Slack delivers anything (session-registry.test.ts), and names the attempts that still owe Eagle a result. This
 * file covers the second half: recovery posts ONE host-authored result line (`interrupted`) for each, no notice and
 * no resume turn, and keeps the debt when the post fails. Eagle reads `interrupted` and asks once more.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock(import('../env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DATA_DIR: '/tmp/soma-work-restart-cut-incident-test' };
});

import { SlackHandler } from '../slack-handler';
import type { ConversationSession } from '../types';

const KEY = 'C0EAGLE-1794191513.354979';

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

/** The session as the load left it: marked finished and idle, the result owed. */
function settledIncidentSession(extra: Partial<ConversationSession> = {}): ConversationSession {
  return {
    channelId: 'C0EAGLE',
    threadTs: '1794191513.354979',
    ownerId: 'U_EAGLE',
    activityState: 'idle',
    incidentRequest: { ...REQUEST },
    incidentAttemptFinishedId: REQUEST.attempt_id,
    incidentResultOwedId: REQUEST.attempt_id,
    ...extra,
  } as unknown as ConversationSession;
}

function ordinarySession(): ConversationSession {
  return { channelId: 'C0EAGLE', threadTs: '1794191513.354979', ownerId: 'U1', activityState: 'working' } as any;
}

async function boot(
  session: ConversationSession,
  opts: {
    owedAttemptId?: string | null;
    crashRecord?: boolean;
    working?: boolean;
    safeguardHalt?: boolean;
    postFails?: boolean;
  } = {},
) {
  const sessions = new Map<string, ConversationSession>([[KEY, session]]);
  const postMessage = vi.fn(async (_args: Record<string, unknown>) => {
    if (opts.postFails) throw new Error('slack_down');
    return { ok: true, ts: '1794191600.000100' };
  });
  if (opts.safeguardHalt) (session as any).safeguardHalt = { at: 1 };
  const app = { client: { chat: { postMessage } }, assistant: vi.fn() } as any;
  const working = opts.working ?? true;
  const claudeHandler = {
    getAllSessions: vi.fn().mockReturnValue(sessions),
    getSessionByKey: vi.fn((k: string) => sessions.get(k)),
    // What the load found still owing Eagle a result.
    takeIncidentResultsOwed: vi.fn().mockReturnValue(
      opts.owedAttemptId === null
        ? []
        : [
            {
              sessionKey: KEY,
              channelId: 'C0EAGLE',
              threadTs: '1794191513.354979',
              attemptId: opts.owedAttemptId ?? REQUEST.attempt_id,
            },
          ],
    ),
    getCrashRecoveredSessions: vi.fn().mockReturnValue(
      opts.crashRecord === false
        ? []
        : [
            {
              channelId: 'C0EAGLE',
              threadTs: '1794191513.354979',
              ownerId: session.ownerId,
              activityState: working ? 'working' : 'idle',
              shouldAutoResume: working,
              sessionKey: KEY,
            },
          ],
    ),
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
    const { postMessage } = await boot(settledIncidentSession());

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
    const { handleMessage } = await boot(settledIncidentSession());

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('records the post: published marker set, owed marker cleared, saved', async () => {
    const session = settledIncidentSession();
    const { claudeHandler } = await boot(session);

    expect(session.incidentAttemptPublishedId).toBe(REQUEST.attempt_id);
    expect(session.incidentResultOwedId).toBeUndefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalled();
  });

  // Review of PR #1054 (astra, P1): a failed post must not lose the debt. The
  // owed marker stays, so the next start-up posts it again.
  it('keeps the result owed when the post fails', async () => {
    const session = settledIncidentSession();
    const { postMessage } = await boot(session, { postFails: true });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(session.incidentResultOwedId).toBe(REQUEST.attempt_id);
    expect(session.incidentAttemptPublishedId).toBeUndefined();
    // The thread stays free for a retry all the same.
    expect(session.incidentAttemptFinishedId).toBe(REQUEST.attempt_id);
    expect(session.activityState).toBe('idle');
  });

  // Slack delivers events before recovery runs, so the ingress may already have
  // handed the thread to Eagle's retry. That attempt is live work: no result
  // for the old one, no change to the new one.
  it('posts nothing when a newer attempt owns the thread', async () => {
    const session = settledIncidentSession({
      activityState: 'working',
      incidentRequest: { ...REQUEST, attempt_id: 'AT-2' },
      incidentAttemptFinishedId: undefined,
    } as any);
    const { postMessage, handleMessage } = await boot(session);

    expect(postMessage).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(session.incidentAttemptFinishedId).toBeUndefined();
    expect(session.activityState).toBe('working');
  });

  it('posts nothing for an attempt whose conclusion was already posted', async () => {
    const session = settledIncidentSession({ incidentAttemptPublishedId: REQUEST.attempt_id } as any);
    const { postMessage, handleMessage } = await boot(session);

    expect(postMessage).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('posts the owed result in a thread the safeguards halted', async () => {
    const session = settledIncidentSession();
    const { postMessage } = await boot(session, { safeguardHalt: true });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(session.incidentAttemptPublishedId).toBe(REQUEST.attempt_id);
  });

  // Review of PR #1054 (astra, P1): an attempt that was idle on disk, asleep,
  // or never stamped at shutdown has no crash record. It is owed all the same.
  it('posts the owed result when the session has no crash record', async () => {
    const session = settledIncidentSession();
    const { postMessage, handleMessage } = await boot(session, { crashRecord: false });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).toContain('"status":"interrupted"');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('posts nothing in an incident thread that owes no result', async () => {
    const session = settledIncidentSession({ incidentResultOwedId: undefined } as any);
    const { postMessage, handleMessage } = await boot(session, { owedAttemptId: null, working: false });

    expect(postMessage).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('control: an ordinary working session still gets the notice and the resume turn', async () => {
    const { postMessage, handleMessage } = await boot(ordinarySession(), { owedAttemptId: null });

    expect(postMessage.mock.calls[0][0].text).toContain('자동으로 재개합니다');
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});

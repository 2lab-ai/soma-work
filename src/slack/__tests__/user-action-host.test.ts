import {
  INSTRUCT_USER_TOOL_NAME,
  inspectUserActionScript,
  type UserActionRecord,
} from 'somalib/user-action/user-action';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../types';
import { answerUserAction, captureUserActionToolResults, notifierFromInjection } from '../user-action-host';

function action(id: string): UserActionRecord {
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
  };
}

const toolResult = (a: UserActionRecord, toolName = INSTRUCT_USER_TOOL_NAME) => ({
  toolUseId: `t-${a.id}`,
  toolName,
  result: [{ type: 'text', text: JSON.stringify({ type: 'user_action', ok: true, action: a, note: '' }) }],
});

function deps() {
  return {
    slackApi: {
      postMessage: vi.fn(async () => ({ ts: '111.222' })),
      updateMessage: vi.fn(async () => undefined),
    },
    persistAndBroadcast: vi.fn(),
  };
}

describe('captureUserActionToolResults', () => {
  it('stores the action on the session apart from the pending question, posts its own card, and broadcasts', async () => {
    const session = { actionPanel: {} } as unknown as ConversationSession;
    const d = deps();
    const got = await captureUserActionToolResults({
      toolResults: [toolResult(action('ua_1'))],
      session,
      sessionKey: 'work:C1:1.0',
      channel: 'C1',
      threadTs: '1.0',
      deps: d,
    });
    expect(got.map((a) => a.id)).toEqual(['ua_1']);
    expect(session.userActions?.map((a) => [a.id, a.slackTs])).toEqual([['ua_1', '111.222']]);
    expect((session as any).actionPanel.pendingQuestion).toBeUndefined();
    expect(d.slackApi.postMessage).toHaveBeenCalledTimes(1);
    const [channel, text, opts] = d.slackApi.postMessage.mock.calls[0] as any[];
    expect(channel).toBe('C1');
    expect(text).toContain('사용자 작업');
    expect(opts.threadTs).toBe('1.0');
    expect(opts.attachments[0].blocks.some((b: any) => b.type === 'actions')).toBe(true);
    expect(d.persistAndBroadcast).toHaveBeenCalledWith('work:C1:1.0');
  });

  it('ignores other tools and refused calls, and does nothing when nothing matched', async () => {
    const session = {} as ConversationSession;
    const d = deps();
    const refused = {
      toolUseId: 'x',
      toolName: INSTRUCT_USER_TOOL_NAME,
      result: JSON.stringify({ type: 'user_action', ok: false, error: { code: 'X', message: 'm' } }),
    };
    const got = await captureUserActionToolResults({
      toolResults: [toolResult(action('ua_2'), 'mcp__model-command__run'), refused],
      session,
      sessionKey: 'k',
      channel: 'C1',
      threadTs: '1.0',
      deps: d,
    });
    expect(got).toEqual([]);
    expect(session.userActions).toBeUndefined();
    expect(d.slackApi.postMessage).not.toHaveBeenCalled();
    expect(d.persistAndBroadcast).not.toHaveBeenCalled();
  });

  it('keeps the action for the dashboard when the Slack post fails, and with no channel posts nothing', async () => {
    const session = {} as ConversationSession;
    const d = deps();
    d.slackApi.postMessage
      .mockRejectedValueOnce(new Error('slack down'))
      .mockRejectedValueOnce(new Error('still down'));
    await captureUserActionToolResults({
      toolResults: [toolResult(action('ua_3'))],
      session,
      sessionKey: 'k',
      channel: 'C1',
      threadTs: '1.0',
      deps: d,
    });
    expect(session.userActions?.[0].id).toBe('ua_3');
    expect(session.userActions?.[0].slackTs).toBeUndefined();
    expect(d.persistAndBroadcast).toHaveBeenCalled();

    const s2 = {} as ConversationSession;
    const d2 = deps();
    await captureUserActionToolResults({
      toolResults: [toolResult(action('ua_4'))],
      session: s2,
      sessionKey: 'k2',
      channel: '',
      deps: d2,
    });
    expect(s2.userActions?.[0].id).toBe('ua_4');
    expect(d2.slackApi.postMessage).not.toHaveBeenCalled();
  });
});

describe('captureUserActionToolResults — ordering and retries (review)', () => {
  it('stores the action before its card is posted, so a press during the post finds it', async () => {
    const session = {} as ConversationSession;
    const d = deps();
    let seenDuringPost: string[] | undefined;
    d.slackApi.postMessage.mockImplementationOnce(async () => {
      seenDuringPost = session.userActions?.map((a) => a.id);
      return { ts: '9.9' };
    });
    await captureUserActionToolResults({
      toolResults: [toolResult(action('ua_r'))],
      session,
      sessionKey: 'k',
      channel: 'C1',
      deps: d,
    });
    expect(seenDuringPost).toEqual(['ua_r']);
    expect(session.userActions?.[0].slackTs).toBe('9.9');
  });

  it('an answer that lands during the post is kept, and the card is brought up to it (no buttons)', async () => {
    const session = {} as ConversationSession;
    const d = deps();
    d.slackApi.postMessage.mockImplementationOnce(async () => {
      session.userActions = session.userActions?.map((a) => ({ ...a, status: 'done' as const, resolvedBy: 'U1' }));
      return { ts: '9.9' };
    });
    await captureUserActionToolResults({
      toolResults: [toolResult(action('ua_s'))],
      session,
      sessionKey: 'k',
      channel: 'C1',
      deps: d,
    });
    expect(session.userActions?.[0]).toMatchObject({ status: 'done', resolvedBy: 'U1', slackTs: '9.9' });
    const [ch, ts, , , attachments] = d.slackApi.updateMessage.mock.calls[0] as any[];
    expect([ch, ts]).toEqual(['C1', '9.9']);
    expect(attachments[0].blocks.some((b: any) => b.type === 'actions')).toBe(false);
  });

  it('retries a failed post once, and a replayed result is not posted again', async () => {
    const session = {} as ConversationSession;
    const d = deps();
    d.slackApi.postMessage.mockRejectedValueOnce(new Error('timeout'));
    const tr = toolResult(action('ua_t'));
    await captureUserActionToolResults({ toolResults: [tr], session, sessionKey: 'k', channel: 'C1', deps: d });
    expect(d.slackApi.postMessage).toHaveBeenCalledTimes(2);
    expect(session.userActions?.[0].slackTs).toBe('111.222');
    await captureUserActionToolResults({ toolResults: [tr], session, sessionKey: 'k', channel: 'C1', deps: d });
    expect(d.slackApi.postMessage).toHaveBeenCalledTimes(2);
    expect(session.userActions).toHaveLength(1);
  });
});

describe('answerUserAction — one path for the Slack button and the dashboard', () => {
  function setup(opts: { may?: boolean; delivered?: boolean } = {}) {
    const session = {
      ownerId: 'U_OWNER',
      channelId: 'C1',
      userActions: [{ ...action('ua_1'), slackTs: '111.222' }],
    } as unknown as ConversationSession;
    const d = deps();
    const notify = vi.fn(async () => opts.delivered ?? true);
    const args = {
      sessionKey: 'k',
      id: 'ua_1',
      status: 'done' as const,
      actor: 'U_OWNER',
      at: 5,
      deps: {
        ...d,
        getSession: () => session,
        mayAnswer: () => opts.may ?? true,
        notify,
      },
    };
    return { session, d, notify, args };
  }

  it('marks it, tells the agent once, and answers ok', async () => {
    const { session, notify, args } = setup();
    const r = await answerUserAction(args);
    expect(r.ok).toBe(true);
    expect(session.userActions?.[0].status).toBe('done');
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0] as any[])[2]).toContain('사용자 작업 완료');
  });

  it('refuses someone who may not answer, changing nothing', async () => {
    const { session, notify, args } = setup({ may: false });
    expect(await answerUserAction(args)).toEqual({ ok: false, code: 'forbidden' });
    expect(session.userActions?.[0].status).toBe('pending');
    expect(notify).not.toHaveBeenCalled();
  });

  it('records only once the agent took it; while it is told, the stored record stays pending and a second press is in flight', async () => {
    const { session, d, args } = setup();
    let duringTelling: { status?: string; writes: number; second?: unknown } = { writes: 0 };
    args.deps.notify = vi.fn(async () => {
      duringTelling = {
        // What any save of the registry would write right now.
        status: JSON.parse(JSON.stringify(session.userActions))[0].status,
        writes: d.slackApi.updateMessage.mock.calls.length + d.persistAndBroadcast.mock.calls.length,
        second: await answerUserAction({
          ...args,
          status: 'failed',
          deps: { ...args.deps, notify: vi.fn(async () => true) },
        }),
      };
      return true;
    });
    expect((await answerUserAction(args)).ok).toBe(true);
    expect(duringTelling).toEqual({ status: 'pending', writes: 0, second: { ok: false, code: 'in-flight' } });
    expect(session.userActions?.[0]).toMatchObject({ status: 'done', resolvedBy: 'U_OWNER' });
    const [channel, ts, , , attachments] = d.slackApi.updateMessage.mock.calls[0] as any[];
    expect([channel, ts]).toEqual(['C1', '111.222']);
    expect(attachments[0].blocks.some((b: any) => b.type === 'actions')).toBe(false);
    expect(d.persistAndBroadcast).toHaveBeenCalledWith('k');
  });

  it('when the agent cannot be told, nothing was ever written: still pending, card untouched, answerable again', async () => {
    const { session, d, args } = setup({ delivered: false });
    expect(await answerUserAction(args)).toEqual({ ok: false, code: 'not-delivered' });
    expect(session.userActions?.[0].status).toBe('pending');
    expect(session.userActions?.[0]).not.toHaveProperty('resolvedBy');
    expect(d.slackApi.updateMessage).not.toHaveBeenCalled();
    expect(d.persistAndBroadcast).not.toHaveBeenCalled();
    const again = await answerUserAction({ ...args, deps: { ...args.deps, notify: vi.fn(async () => true) } });
    expect(again.ok).toBe(true);
  });

  it('a notifier that throws counts as not delivered, and releases the lock', async () => {
    const { session, args } = setup();
    args.deps.notify = vi.fn(async () => {
      throw new Error('pipeline down');
    });
    expect(await answerUserAction(args)).toEqual({ ok: false, code: 'not-delivered' });
    expect(session.userActions?.[0].status).toBe('pending');
    const again = await answerUserAction({ ...args, deps: { ...args.deps, notify: vi.fn(async () => true) } });
    expect(again.ok).toBe(true);
  });

  it('a second answer is refused as already answered; an unknown one as gone', async () => {
    const { args } = setup();
    await answerUserAction(args);
    expect(await answerUserAction(args)).toEqual({ ok: false, code: 'already-resolved' });
    expect(await answerUserAction({ ...args, id: 'nope' })).toEqual({ ok: false, code: 'gone' });
    expect(await answerUserAction({ ...args, deps: { ...args.deps, getSession: () => undefined } })).toEqual({
      ok: false,
      code: 'gone',
    });
  });
});

describe('notifierFromInjection — acceptance, not settlement, decides', () => {
  it('true when onAccepted fires, even if the injection settles later', async () => {
    let settle!: () => void;
    const notify = notifierFromInjection((_k, _t, _a, onAccepted) => {
      onAccepted();
      return new Promise<void>((r) => {
        settle = r;
      });
    });
    const p = notify('k', 'text', 'U1');
    settle();
    expect(await p).toBe(true);
  });

  it('false when the injection settles without acceptance, or fails', async () => {
    expect(await notifierFromInjection(async () => undefined)('k', 't', 'U1')).toBe(false);
    expect(
      await notifierFromInjection(async () => {
        throw new Error('down');
      })('k', 't', 'U1'),
    ).toBe(false);
  });
});

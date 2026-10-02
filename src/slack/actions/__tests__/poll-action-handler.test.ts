import { describe, expect, it, vi } from 'vitest';
import { PollActionHandler } from '../poll-action-handler';

function body(actionId: string, value: string, extra: Record<string, unknown> = {}) {
  return {
    user: { id: 'UVOTER' },
    channel: { id: 'C1' },
    message: { ts: '200.1', thread_ts: '100.1' },
    actions: [{ action_id: actionId, value, action_ts: '1790000000.123456' }],
    ...extra,
  };
}

function makeService(overrides: Record<string, any> = {}) {
  return {
    castVote: vi.fn(async () => ({ kind: 'recorded', optionIndex: 1, label: '된장찌개' })),
    close: vi.fn(async () => 'closed'),
    cancel: vi.fn(async () => 'canceled'),
    ...overrides,
  };
}

describe('PollActionHandler', () => {
  it('vote: passes voter, option index from action_id, message ids and action_ts; joins the lane synchronously', async () => {
    const service = makeService();
    const handler = new PollActionHandler({ getService: () => service as any });
    const respond = vi.fn(async (_msg: any) => undefined);
    const pending = handler.handleVote(body('poll_v1_vote_1', 'poll_1'), respond);
    // castVote must already have been called before the handler's first await settles
    expect(service.castVote).toHaveBeenCalledTimes(1);
    await pending;
    expect(service.castVote).toHaveBeenCalledWith({
      pollId: 'poll_1',
      userId: 'UVOTER',
      optionIndex: 1,
      actionTs: '1790000000.123456',
      channel: 'C1',
      messageTs: '200.1',
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', replace_original: false }),
    );
    expect(respond.mock.calls[0][0].text).toContain('2. 된장찌개');
  });

  it('vote outcomes map to ephemeral messages only for the clicker; stale is silent', async () => {
    const cases: Array<[any, string | null]> = [
      [{ kind: 'unchanged', optionIndex: 0, label: '김치찌개' }, '이미'],
      [{ kind: 'closed' }, '마감'],
      [{ kind: 'mismatch' }, '유효하지 않습니다'],
      [{ kind: 'not_found' }, '유효하지 않습니다'],
      [{ kind: 'invalid_option' }, '알 수 없는'],
      [{ kind: 'stale' }, null],
    ];
    for (const [outcome, fragment] of cases) {
      const service = makeService({ castVote: vi.fn(async () => outcome) });
      const handler = new PollActionHandler({ getService: () => service as any });
      const respond = vi.fn(async (_msg: any) => undefined);
      await handler.handleVote(body('poll_v1_vote_0', 'poll_1'), respond);
      if (fragment === null) expect(respond).not.toHaveBeenCalled();
      else expect(respond.mock.calls[0][0].text).toContain(fragment);
    }
  });

  it('malformed payloads never throw and never reach the service', async () => {
    const service = makeService();
    const handler = new PollActionHandler({ getService: () => service as any });
    const respond = vi.fn(async (_msg: any) => undefined);
    await handler.handleVote({ actions: [{ action_id: 'poll_v1_vote_x', value: 'p' }] }, respond);
    await handler.handleVote(body('poll_v1_vote_1', ''), respond);
    await handler.handleVote({ ...body('poll_v1_vote_1', 'p'), user: undefined }, respond);
    expect(service.castVote).not.toHaveBeenCalled();
  });

  it('close/cancel authorize as the clicking user and explain refusals ephemerally', async () => {
    const service = makeService({ close: vi.fn(async () => 'forbidden'), cancel: vi.fn(async () => 'forbidden') });
    const handler = new PollActionHandler({ getService: () => service as any });
    const respond = vi.fn(async (_msg: any) => undefined);
    await handler.handleClose(body('poll_v1_close', 'poll_1'), respond);
    expect(service.close).toHaveBeenCalledWith({
      pollId: 'poll_1',
      actorId: 'UVOTER',
      channel: 'C1',
      messageTs: '200.1',
    });
    expect(respond.mock.calls[0][0].text).toContain('시작한 사람만');
    await handler.handleCancel(body('poll_v1_cancel', 'poll_1'), respond);
    expect(service.cancel).toHaveBeenCalledWith({
      pollId: 'poll_1',
      actorId: 'UVOTER',
      channel: 'C1',
      messageTs: '200.1',
    });
    expect(respond.mock.calls[1][0].text).toContain('시작한 사람만');
  });

  it('when the poll service is not initialized, tells the clicker instead of throwing', async () => {
    const handler = new PollActionHandler({ getService: () => undefined });
    const respond = vi.fn(async (_msg: any) => undefined);
    await handler.handleVote(body('poll_v1_vote_0', 'poll_1'), respond);
    expect(respond.mock.calls[0][0].text).toContain('사용할 수 없습니다');
  });
});

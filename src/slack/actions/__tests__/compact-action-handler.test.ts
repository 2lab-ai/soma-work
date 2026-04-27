import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { CompactActionHandler } from '../compact-action-handler';
import type { MessageHandler, RespondFn } from '../types';

/**
 * #617 followup v2 — `/compact` yes/no button handlers.
 *
 *   `compact_confirm` — replace the prompt with "starting…" and re-dispatch
 *                       `/compact --yes` through the message pipeline so the
 *                       CompactHandler takes the confirmed branch.
 *   `compact_cancel`  — replace the prompt with "취소되었습니다."
 */
describe('CompactActionHandler — confirm', () => {
  let slackApi: { postMessage: ReturnType<typeof vi.fn> };
  let claudeHandler: { getSessionByKey: ReturnType<typeof vi.fn> };
  let messageHandler: Mock<MessageHandler>;
  let respond: Mock<RespondFn>;

  beforeEach(() => {
    slackApi = { postMessage: vi.fn().mockResolvedValue({ ts: 'ts-say' }) };
    claudeHandler = {
      getSessionByKey: vi.fn().mockReturnValue({ sessionId: 'sess-1', ownerId: 'U1' }),
    };
    messageHandler = vi.fn<MessageHandler>().mockResolvedValue(undefined);
    respond = vi.fn<RespondFn>().mockResolvedValue(undefined);
  });

  const makeHandler = () =>
    new CompactActionHandler({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      messageHandler: messageHandler as any,
    });

  const makeConfirmBody = (overrides: any = {}) => ({
    actions: [{ value: 'C1:171.100' }],
    user: { id: 'U1' },
    channel: { id: 'C1' },
    message: { ts: 'ts-prompt', thread_ts: '171.100' },
    ...overrides,
  });

  it('replaces the prompt in-place with "starting…" and re-dispatches /compact --yes', async () => {
    const handler = makeHandler();
    await handler.handleConfirm(makeConfirmBody(), respond);

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ replace_original: true, text: expect.stringContaining('압축') }),
    );
    expect(messageHandler).toHaveBeenCalledTimes(1);
    const [event] = messageHandler.mock.calls[0];
    expect(event).toEqual(
      expect.objectContaining({
        user: 'U1',
        channel: 'C1',
        thread_ts: '171.100',
        text: '/compact --yes',
      }),
    );
  });

  it('falls back to message.ts as thread_ts when thread_ts is absent', async () => {
    const handler = makeHandler();
    const body = makeConfirmBody({ message: { ts: 'ts-prompt' } });
    await handler.handleConfirm(body, respond);
    const [event] = messageHandler.mock.calls[0];
    expect(event.thread_ts).toBe('ts-prompt');
  });

  it('refuses when the actor is not the session owner', async () => {
    claudeHandler.getSessionByKey.mockReturnValue({ sessionId: 'sess-1', ownerId: 'SOMEONE_ELSE' });
    const handler = makeHandler();
    await handler.handleConfirm(makeConfirmBody(), respond);

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', text: expect.stringContaining('소유자만') }),
    );
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('returns ephemeral error when the session no longer exists', async () => {
    claudeHandler.getSessionByKey.mockReturnValue(undefined);
    const handler = makeHandler();
    await handler.handleConfirm(makeConfirmBody(), respond);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', text: expect.stringContaining('찾을 수 없습니다') }),
    );
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('returns ephemeral error on malformed payload (missing sessionKey)', async () => {
    const handler = makeHandler();
    await handler.handleConfirm(makeConfirmBody({ actions: [{}] }), respond);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    expect(messageHandler).not.toHaveBeenCalled();
  });
});

describe('CompactActionHandler — cancel', () => {
  it('replaces the prompt with "취소되었습니다."', async () => {
    const slackApi = { postMessage: vi.fn() };
    const claudeHandler = { getSessionByKey: vi.fn() };
    const messageHandler = vi.fn<MessageHandler>();
    const respond = vi.fn<RespondFn>().mockResolvedValue(undefined);

    const handler = new CompactActionHandler({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      messageHandler: messageHandler as any,
    });
    await handler.handleCancel({}, respond);
    expect(respond).toHaveBeenCalledWith({ text: '취소되었습니다.', replace_original: true });
    expect(messageHandler).not.toHaveBeenCalled();
  });
});

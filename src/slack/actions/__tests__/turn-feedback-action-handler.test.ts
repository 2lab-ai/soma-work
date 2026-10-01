import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildFeedbackContextActions, encodeFeedbackValue } from '@soma/slack/turn-feedback-block-builder';
import { setTurnFeedbackStoreDataDirProvider, TurnFeedbackStore } from '@soma/slack/turn-feedback-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnFeedbackActionHandler } from '../turn-feedback-action-handler';

function makeBody(overrides: { value?: string; userId?: string; blocks?: any[] } = {}) {
  const turnId = 'C1-1.2:1700:abc';
  return {
    user: { id: overrides.userId ?? 'U1' },
    channel: { id: 'C1' },
    container: { channel_id: 'C1', message_ts: '1700.9' },
    message: {
      ts: '1700.9',
      thread_ts: '1700.1',
      blocks: overrides.blocks ?? [
        { type: 'section', text: { type: 'mrkdwn', text: '✅ *작업 완료*' } },
        buildFeedbackContextActions(turnId, overrides.userId ?? 'U1'),
      ],
    },
    actions: [
      {
        action_id: 'turn_feedback_v1',
        value: overrides.value ?? encodeFeedbackValue('positive', turnId),
      },
    ],
  };
}

describe('TurnFeedbackActionHandler', () => {
  let tmpDir: string;
  let store: TurnFeedbackStore;
  let slackApi: { updateMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-handler-'));
    setTurnFeedbackStoreDataDirProvider(() => tmpDir);
    store = new TurnFeedbackStore();
    slackApi = { updateMessage: vi.fn().mockResolvedValue(undefined) };
  });

  function handler() {
    return new TurnFeedbackActionHandler({ slackApi: slackApi as any, store });
  }

  it('persists the feedback and acknowledges by replacing the buttons', async () => {
    await handler().handleFeedback(makeBody(), vi.fn());

    const rec = store.get('C1-1.2:1700:abc', 'U1');
    expect(rec?.sentiment).toBe('positive');
    expect(rec?.messageTs).toBe('1700.9');

    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    const [channel, ts, , blocks] = slackApi.updateMessage.mock.calls[0];
    expect(channel).toBe('C1');
    expect(ts).toBe('1700.9');
    // The feedback_buttons are gone, replaced by a plain context ack...
    expect(JSON.stringify(blocks)).toContain('👍');
    expect(JSON.stringify(blocks)).not.toContain('feedback_buttons');
    // ...but the 🗑 dismiss icon_button is preserved so the card stays dismissible.
    const ctxActions = blocks.find((b: any) => b.type === 'context_actions');
    expect(ctxActions.elements).toHaveLength(1);
    expect(ctxActions.elements[0].type).toBe('icon_button');
  });

  it('is idempotent on double-click (one record, sentiment stable)', async () => {
    await handler().handleFeedback(makeBody(), vi.fn());
    await handler().handleFeedback(makeBody(), vi.fn());
    expect(store.listForTurn('C1-1.2:1700:abc')).toHaveLength(1);
  });

  it('records a sentiment flip in place', async () => {
    await handler().handleFeedback(makeBody({ value: encodeFeedbackValue('positive', 'C1-1.2:1700:abc') }), vi.fn());
    await handler().handleFeedback(makeBody({ value: encodeFeedbackValue('negative', 'C1-1.2:1700:abc') }), vi.fn());
    expect(store.get('C1-1.2:1700:abc', 'U1')?.sentiment).toBe('negative');
    expect(store.listForTurn('C1-1.2:1700:abc')).toHaveLength(1);
  });

  it('ignores an unparseable value (no persist, no update)', async () => {
    await handler().handleFeedback(makeBody({ value: 'garbage' }), vi.fn());
    expect(store.list()).toHaveLength(0);
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
  });

  // A32 — on the consolidated surface the feedback row lives on the STREAMED
  // answer message. `chat.update` there would overwrite the answer, so the ack
  // must be an ephemeral respond() and the host message must stay untouched.
  describe('stream-hosted feedback row (A32)', () => {
    function makeStreamHostBody(userId = 'U1') {
      const turnId = 'C1-1.2:1700:abc';
      const body = makeBody({ userId });
      body.message.blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: '스트리밍된 답변 본문' } },
        buildFeedbackContextActions(turnId, userId, { includeDismiss: false, streamHosted: true }) as any,
      ];
      return body;
    }

    it('persists and acks ephemerally WITHOUT touching the host message', async () => {
      const respond = vi.fn().mockResolvedValue(undefined);
      await handler().handleFeedback(makeStreamHostBody(), respond);

      expect(store.get('C1-1.2:1700:abc', 'U1')?.sentiment).toBe('positive');
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith({
        response_type: 'ephemeral',
        replace_original: false,
        text: '🙏 피드백 감사합니다',
      });
    });

    it('still persists when the ephemeral ack throws', async () => {
      const respond = vi.fn().mockRejectedValue(new Error('expired_trigger'));
      await handler().handleFeedback(makeStreamHostBody(), respond);

      expect(store.get('C1-1.2:1700:abc', 'U1')?.sentiment).toBe('positive');
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
    });

    it('legacy card (no marker block_id) keeps the chat.update ack', async () => {
      const respond = vi.fn().mockResolvedValue(undefined);
      await handler().handleFeedback(makeBody(), respond);

      expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
      expect(respond).not.toHaveBeenCalled();
    });
  });

  it('still persists when the cosmetic update throws', async () => {
    slackApi.updateMessage.mockRejectedValueOnce(new Error('cant_update_message'));
    await handler().handleFeedback(makeBody(), vi.fn());
    expect(store.get('C1-1.2:1700:abc', 'U1')?.sentiment).toBe('positive');
  });
});

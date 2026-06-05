import { describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('default'),
  },
}));

import type { TurnCompletionEvent } from '../../turn-notifier';
import { SlackBlockKitChannel } from '../slack-block-kit-channel';

function makeEvent(overrides: Partial<TurnCompletionEvent> = {}): TurnCompletionEvent {
  return {
    category: 'WorkflowComplete',
    userId: 'U123',
    channel: 'C123',
    threadTs: '123.456',
    durationMs: 1000,
    ...overrides,
  };
}

function api() {
  return { postMessage: vi.fn().mockResolvedValue({ ts: '999.1' }) };
}

describe('SlackBlockKitChannel — #1064 feedback affordance', () => {
  it('WorkflowComplete WITH turnId posts top-level blocks ending in feedback context_actions (no attachment)', async () => {
    const slackApi = api();
    await new SlackBlockKitChannel(slackApi).send(makeEvent({ turnId: 'C123-1.2:1700:uuid' }));

    const opts = slackApi.postMessage.mock.calls[0][2];
    expect(opts.attachments).toBeUndefined();
    expect(Array.isArray(opts.blocks)).toBe(true);
    const last = opts.blocks[opts.blocks.length - 1];
    expect(last.type).toBe('context_actions');
    expect(last.elements[0].type).toBe('feedback_buttons');
    expect(last.elements[0].action_id).toBe('turn_feedback_v1');
  });

  it('WorkflowComplete WITHOUT turnId keeps the legacy colored attachment (no feedback)', async () => {
    const slackApi = api();
    await new SlackBlockKitChannel(slackApi).send(makeEvent());

    const opts = slackApi.postMessage.mock.calls[0][2];
    expect(opts.blocks).toBeUndefined();
    expect(opts.attachments).toHaveLength(1);
    expect(JSON.stringify(opts.attachments)).not.toContain('feedback_buttons');
  });

  it('Exception WITH turnId stays an attachment — feedback is WorkflowComplete-only', async () => {
    const slackApi = api();
    await new SlackBlockKitChannel(slackApi).send(
      makeEvent({ category: 'Exception', message: 'boom', turnId: 'C123-1.2:1700:uuid' }),
    );

    const opts = slackApi.postMessage.mock.calls[0][2];
    expect(opts.attachments).toHaveLength(1);
    expect(opts.blocks).toBeUndefined();
    expect(JSON.stringify(opts.attachments)).not.toContain('feedback_buttons');
  });
});

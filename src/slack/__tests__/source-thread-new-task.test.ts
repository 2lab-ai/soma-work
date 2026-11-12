/**
 * SSOT 2026-11-12 — an instruction someone gives in a source thread (a thread whose earlier mention moved to its
 * own work thread) is a new instruction. Its sender is asked by DM whether to run it as a new task; on yes it runs
 * exactly like a first mention there — a new work thread, linked back to the same source thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildNewTaskOfferMessage,
  NEW_TASK_ACTION_PREFIX,
  parseNewTaskAction,
  SourceThreadNewTask,
} from '../source-thread-new-task';

const REQUEST = { channel: 'C_SRC', threadTs: '100.200', ts: '200.300', user: 'U_Z', text: '$fix' };

function makeSlackApi() {
  return {
    openDmChannel: vi.fn().mockResolvedValue('D_Z'),
    postMessage: vi.fn().mockResolvedValue({ ts: 'dm.1', channel: 'D_Z' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    getPermalink: vi.fn().mockResolvedValue('https://slack.test/archives/C_SRC/p100200'),
    getThreadMessage: vi.fn().mockResolvedValue({ ts: '200.300', user: 'U_Z', team: 'T_1', text: '<@B_BOT> $fix' }),
    getBotUserId: vi.fn().mockResolvedValue('B_BOT'),
  };
}

/** The value Slack sends back for the DM's buttons, as a click payload. */
function clickBody(actionId: string, value: string, clicker = 'U_Z') {
  return {
    user: { id: clicker },
    container: { channel_id: 'D_Z', message_ts: 'dm.1' },
    channel: { id: 'D_Z' },
    message: { ts: 'dm.1' },
    actions: [{ action_id: actionId, value }],
  };
}

function offeredButtons(slackApi: ReturnType<typeof makeSlackApi>) {
  const blocks = slackApi.postMessage.mock.calls[0][2].blocks as any[];
  const actions = blocks.find((b) => b.type === 'actions');
  return actions.elements as Array<{ action_id: string; value: string; text: { text: string } }>;
}

describe('SourceThreadNewTask.offer', () => {
  it('DMs the sender a start / cancel choice that quotes the instruction', async () => {
    const slackApi = makeSlackApi();
    const flow = new SourceThreadNewTask({ slackApi, messageHandler: vi.fn() });

    const sent = await flow.offer({ ...REQUEST, linked: [{ title: '이전 작업', activityState: 'idle' }] });

    expect(sent).toBe(true);
    expect(slackApi.openDmChannel).toHaveBeenCalledWith('U_Z');
    const [dm, text, options] = slackApi.postMessage.mock.calls[0];
    expect(dm).toBe('D_Z');
    expect(text).toContain('새 작업');
    const body = JSON.stringify(options.blocks);
    expect(body).toContain('$fix');
    expect(body).toContain('이전 작업');
    expect(body).toContain('https://slack.test/archives/C_SRC/p100200');
    const buttons = offeredButtons(slackApi);
    expect(buttons.map((b) => b.action_id)).toEqual([
      `${NEW_TASK_ACTION_PREFIX}start`,
      `${NEW_TASK_ACTION_PREFIX}cancel`,
    ]);
    // The click carries only where the instruction is — never the words themselves (they are read back from Slack).
    expect(parseNewTaskAction(clickBody(buttons[0].action_id, buttons[0].value))).toEqual({
      decision: 'start',
      ref: { channel: 'C_SRC', threadTs: '100.200', ts: '200.300', user: 'U_Z' },
    });
  });

  it('reports false when the DM cannot be sent', async () => {
    const slackApi = makeSlackApi();
    slackApi.openDmChannel.mockRejectedValue(new Error('cannot_dm_bot'));
    const flow = new SourceThreadNewTask({ slackApi, messageHandler: vi.fn() });
    await expect(flow.offer({ ...REQUEST, linked: [] })).resolves.toBe(false);
  });
});

describe('SourceThreadNewTask.handleAction', () => {
  let slackApi: ReturnType<typeof makeSlackApi>;
  let messageHandler: any;
  let respond: any;
  let flow: SourceThreadNewTask;
  let start: { action_id: string; value: string };
  let cancel: { action_id: string; value: string };

  beforeEach(async () => {
    slackApi = makeSlackApi();
    messageHandler = vi.fn().mockResolvedValue(undefined);
    respond = vi.fn().mockResolvedValue(undefined);
    flow = new SourceThreadNewTask({ slackApi, messageHandler });
    await flow.offer({ ...REQUEST, linked: [] });
    [start, cancel] = offeredButtons(slackApi);
  });

  it('start: runs the original instruction as a first mention in the source thread (a new work thread)', async () => {
    await flow.handleAction(clickBody(start.action_id, start.value), respond);

    expect(slackApi.getThreadMessage).toHaveBeenCalledWith('C_SRC', '100.200', '200.300');
    await vi.waitFor(() => expect(messageHandler).toHaveBeenCalledTimes(1));
    const [event, say] = messageHandler.mock.calls[0];
    expect(event).toMatchObject({
      channel: 'C_SRC',
      thread_ts: '100.200',
      ts: '200.300',
      user: 'U_Z',
      text: '$fix',
      team: 'T_1',
    });
    // The DM no longer offers the buttons.
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'D_Z',
      'dm.1',
      expect.stringContaining('시작'),
      expect.any(Array),
    );
    // `say` answers in the source thread, where the new task starts.
    await say({ text: 'hi' });
    expect(slackApi.postMessage).toHaveBeenLastCalledWith(
      'C_SRC',
      'hi',
      expect.objectContaining({ threadTs: '100.200' }),
    );
  });

  it('start twice: the second click does not start a second task', async () => {
    await flow.handleAction(clickBody(start.action_id, start.value), respond);
    await flow.handleAction(clickBody(start.action_id, start.value), respond);
    await vi.waitFor(() => expect(messageHandler).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });

  it('only the sender may answer', async () => {
    await flow.handleAction(clickBody(start.action_id, start.value, 'U_OTHER'), respond);
    expect(messageHandler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });

  it('cancel: nothing runs and the DM says so', async () => {
    await flow.handleAction(clickBody(cancel.action_id, cancel.value), respond);
    expect(messageHandler).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'D_Z',
      'dm.1',
      expect.stringContaining('취소'),
      expect.any(Array),
    );
  });

  it('the original message is gone (or not the sender’s): nothing runs, the DM says why', async () => {
    slackApi.getThreadMessage.mockResolvedValue(null);
    await flow.handleAction(clickBody(start.action_id, start.value), respond);
    expect(messageHandler).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'D_Z',
      'dm.1',
      expect.stringContaining('찾을 수 없'),
      expect.any(Array),
    );

    slackApi.getThreadMessage.mockResolvedValue({ ts: '200.300', user: 'U_SOMEONE_ELSE', text: '<@B_BOT> rm -rf' });
    await flow.handleAction(clickBody(start.action_id, start.value), respond);
    expect(messageHandler).not.toHaveBeenCalled();
  });
});

describe('buildNewTaskOfferMessage', () => {
  it('keeps a long instruction inside the Slack section limit', () => {
    const message = buildNewTaskOfferMessage(
      { ...REQUEST, text: 'x'.repeat(10_000), linked: [] },
      'https://slack.test/p',
    );
    for (const block of message.blocks as any[]) {
      if (block.type === 'section') expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});

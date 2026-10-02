import { describe, expect, it, vi } from 'vitest';
import { createPollSlackApi } from '../poll-slack-adapter';

function makeHelper(pages: any[][], opts: { failOn?: number; error?: any } = {}) {
  const replies = vi.fn(async (args: any) => {
    const page = args.cursor ? Number(args.cursor) : 0;
    if (opts.failOn === page) throw opts.error;
    return {
      messages: pages[page],
      response_metadata: { next_cursor: page + 1 < pages.length ? String(page + 1) : '' },
    };
  });
  const helper: any = {
    postMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    getBotUserId: vi.fn(async () => 'UBOT'),
    getClient: () => ({ conversations: { replies } }),
  };
  return { helper, replies };
}

describe('createPollSlackApi.threadHasBotMessage', () => {
  it('ignores a user message that quotes the marker', async () => {
    const { helper } = makeHelper([[{ ts: '1', user: 'UHUMAN', text: 'look: ref poll_1 1/1' }]]);
    const api = createPollSlackApi(helper);
    await expect(api.threadHasBotMessage?.('C1', '100.1', '99', 'ref poll_1 1/1')).resolves.toBe(false);
  });

  it('finds the bot-authored notice on a later page (scans every page) and bounds by oldest', async () => {
    const { helper, replies } = makeHelper([
      [{ ts: '1', user: 'UBOT', text: 'something else' }],
      [{ ts: '2', user: 'UBOT', text: 'roster…\n_ref poll_1 2/2_' }],
    ]);
    const api = createPollSlackApi(helper);
    await expect(api.threadHasBotMessage?.('C1', '100.1', '1790000000', 'ref poll_1 2/2')).resolves.toBe(true);
    expect(replies.mock.calls[0][0]).toMatchObject({ channel: 'C1', ts: '100.1', oldest: '1790000000' });
  });

  it('a marker is exact: part 1/2 does not match 1/20 or 11/2', async () => {
    const { helper } = makeHelper([
      [
        { ts: '1', user: 'UBOT', text: '_ref poll_1 1/20_' },
        { ts: '2', user: 'UBOT', text: '_ref poll_1 11/2_' },
      ],
    ]);
    const api = createPollSlackApi(helper);
    await expect(api.threadHasBotMessage?.('C1', '100.1', '99', 'ref poll_1 1/2')).resolves.toBe(false);
  });

  it('a failed page is "not yet checked" (throws), never "absent"', async () => {
    const err: any = new Error('thread_not_found');
    err.data = { error: 'thread_not_found' };
    const { helper } = makeHelper([[{ ts: '1', user: 'UBOT', text: 'x' }], []], { failOn: 1, error: err });
    const api = createPollSlackApi(helper);
    await expect(api.threadHasBotMessage?.('C1', '100.1', '99', 'ref poll_1 1/1')).rejects.toBe(err);
  });
});

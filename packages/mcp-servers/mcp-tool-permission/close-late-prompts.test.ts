/**
 * #621 — an MCP grant answered before the child recorded every admin DM copy,
 * or never answered: the copies the answer did not reach lose their buttons.
 */

import { describe, expect, it, vi } from 'vitest';
import { closeLatePrompts } from './close-late-prompts.js';

const D1 = { channel: 'D1', ts: '1.1' };
const D2 = { channel: 'D2', ts: '2.2' };

function slack() {
  return {
    chat: { update: vi.fn(async (_args: { channel: string; ts: string; text: string; blocks: unknown[] }) => ({})) },
  };
}

describe('closeLatePrompts (#621)', () => {
  it('rewrites only the copies the answering process did not list, with its outcome line', async () => {
    const s = slack();
    const closed = await closeLatePrompts(s, [D1, D2], {
      behavior: 'deny',
      message: 'Denied by <@UADMIN>',
      promptText: '❌ Permission denied by <@UADMIN> (대시보드에서 응답)',
      promptsRewritten: ['1.1'],
    });
    expect(closed).toBe(1);
    expect(s.chat.update).toHaveBeenCalledTimes(1);
    const args = s.chat.update.mock.calls[0][0];
    expect(args).toMatchObject({
      channel: 'D2',
      ts: '2.2',
      text: '❌ Permission denied by <@UADMIN> (대시보드에서 응답)',
    });
    expect(JSON.stringify(args.blocks)).not.toContain('actions');
  });

  it('nobody answered in time: every copy says the request ended', async () => {
    const s = slack();
    expect(await closeLatePrompts(s, [D1, D2], { behavior: 'deny', message: 'Permission request timed out' })).toBe(2);
    for (const [args] of s.chat.update.mock.calls) expect(args.text).toBe('⌛ Permission request timed out');
  });

  it('every copy reached: nothing to do; a failing update is reported, the rest still close', async () => {
    const s = slack();
    expect(
      await closeLatePrompts(s, [D1, D2], { behavior: 'allow', promptText: 'x', promptsRewritten: ['1.1', '2.2'] }),
    ).toBe(0);
    expect(s.chat.update).not.toHaveBeenCalled();
    s.chat.update.mockRejectedValueOnce(new Error('message_not_found'));
    const errors: unknown[] = [];
    expect(await closeLatePrompts(s, [D1, D2], { behavior: 'allow' }, (e) => errors.push(e))).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

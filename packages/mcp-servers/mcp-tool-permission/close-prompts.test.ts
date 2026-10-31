/**
 * #621 — once an MCP grant request is over, every admin DM copy loses its
 * buttons: the ones the answer could not reach, a rewrite that failed in the
 * answering process, and all of them on a timeout.
 */

import { describe, expect, it, vi } from 'vitest';
import { closePrompts } from './close-prompts.js';

const D1 = { channel: 'D1', ts: '1.1' };
const D2 = { channel: 'D2', ts: '2.2' };

function slack() {
  return {
    chat: { update: vi.fn(async (_args: { channel: string; ts: string; text: string; blocks: unknown[] }) => ({})) },
  };
}

describe('closePrompts (#621)', () => {
  it('rewrites every copy with the answering process’s outcome line, without buttons', async () => {
    const s = slack();
    const closed = await closePrompts(s, [D1, D2], {
      behavior: 'deny',
      message: 'Denied by <@UADMIN>',
      promptText: '❌ Permission denied by <@UADMIN> (대시보드에서 응답)',
    });
    expect(closed).toBe(2);
    expect(s.chat.update.mock.calls.map(([a]) => a.channel)).toEqual(['D1', 'D2']);
    for (const [args] of s.chat.update.mock.calls) {
      expect(args.text).toBe('❌ Permission denied by <@UADMIN> (대시보드에서 응답)');
      expect(JSON.stringify(args.blocks)).not.toContain('actions');
    }
  });

  it('nobody answered in time: every copy says the request ended', async () => {
    const s = slack();
    expect(await closePrompts(s, [D1, D2], { behavior: 'deny', message: 'Permission request timed out' })).toBe(2);
    for (const [args] of s.chat.update.mock.calls) expect(args.text).toBe('⌛ Permission request timed out');
  });

  it('a failing update is reported; the rest still close', async () => {
    const s = slack();
    s.chat.update.mockRejectedValueOnce(new Error('message_not_found'));
    const errors: unknown[] = [];
    expect(await closePrompts(s, [D1, D2], { behavior: 'allow' }, (e) => errors.push(e))).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

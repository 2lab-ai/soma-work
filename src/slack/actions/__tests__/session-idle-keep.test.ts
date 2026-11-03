/**
 * #881 D1 (fable R1 P1 on #887) — the 12h idle check's "keep" button answers with `replace_original` on that very
 * message, so the registry must not also edit it: two writes to one message race. The button refreshes the clock
 * with `editWarning: false`; its own reply is the one write.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionActionHandler } from '../session-action-handler';

describe('SessionActionHandler.handleIdleKeep', () => {
  it('refreshes the clock without a second edit of the message the button replies on', async () => {
    const refreshSessionActivityByKey = vi.fn().mockReturnValue(true);
    const handler = new SessionActionHandler({
      slackApi: {} as any,
      claudeHandler: { refreshSessionActivityByKey, getSessionByKey: vi.fn().mockReturnValue(undefined) } as any,
      sessionManager: {} as any,
    });
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler.handleIdleKeep({ actions: [{ value: 'C1-1.1' }] }, respond);
    expect(refreshSessionActivityByKey).toHaveBeenCalledWith('C1-1.1', { editWarning: false });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ replace_original: true }));
  });
});

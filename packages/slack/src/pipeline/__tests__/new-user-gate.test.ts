/**
 * E2 ⑦ — the new-user approval gate, as a function of its own (.prd/18 D2 (4)):
 * the Slack path keeps its results, and the task entry (⑧) can run it before
 * any folder or task exists.
 *
 *   accepted          → 'pass', nothing posted
 *   no record (new)   → pending record, "승인 대기 중", admins asked → 'new';
 *                       a failure in there is logged, never thrown
 *   record, pending   → "아직 승인 대기 중" → 'pending'; a failed post throws
 */
import { describe, expect, it, vi } from 'vitest';
import { NEW_USER_PENDING_TEXT, runNewUserGate, USER_STILL_PENDING_TEXT } from '../session-initializer';

function deps(settings: unknown) {
  return {
    getUserSettings: vi.fn(() => settings),
    createPendingUser: vi.fn(),
    notifyAdmins: vi.fn(async () => undefined),
    postMessage: vi.fn(async () => ({ ts: '1' })),
    logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
}
const AT = { user: 'U1', userName: 'Alice', channel: 'C1', threadTs: '1.0' };

describe('runNewUserGate (E2 ⑦)', () => {
  it('an accepted user passes; nothing is posted', async () => {
    const d = deps({ accepted: true });
    expect(await runNewUserGate(d, AT)).toBe('pass');
    expect(d.postMessage).not.toHaveBeenCalled();
    expect(d.createPendingUser).not.toHaveBeenCalled();
  });

  it('a new user: a pending record, told to wait, the admins asked — in that order', async () => {
    const d = deps(undefined);
    const order: string[] = [];
    d.createPendingUser.mockImplementation(() => void order.push('pending'));
    d.postMessage.mockImplementation(async () => {
      order.push('post');
      return { ts: '1' };
    });
    d.notifyAdmins.mockImplementation(async () => void order.push('admins'));
    expect(await runNewUserGate(d, AT)).toBe('new');
    expect(order).toEqual(['pending', 'post', 'admins']);
    expect(d.createPendingUser).toHaveBeenCalledWith('U1', 'Alice');
    expect(d.postMessage).toHaveBeenCalledWith('C1', NEW_USER_PENDING_TEXT, { threadTs: '1.0' });
    expect(d.notifyAdmins).toHaveBeenCalledWith('U1', 'Alice');
  });

  it('a new user whose admins cannot be asked, or whose record cannot be made: still halted, never thrown', async () => {
    const admins = deps(undefined);
    admins.notifyAdmins.mockRejectedValue(new Error('admin-requests.json unreadable'));
    expect(await runNewUserGate(admins, AT)).toBe('new');
    expect(admins.logger.error).toHaveBeenCalled();

    const record = deps(undefined);
    record.createPendingUser.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(await runNewUserGate(record, AT)).toBe('new');
    expect(record.postMessage).not.toHaveBeenCalled();
  });

  it('a user still pending is told to wait; a post that fails throws', async () => {
    const d = deps({ accepted: false });
    expect(await runNewUserGate(d, AT)).toBe('pending');
    expect(d.postMessage).toHaveBeenCalledWith('C1', USER_STILL_PENDING_TEXT, { threadTs: '1.0' });
    expect(d.createPendingUser).not.toHaveBeenCalled();

    const failing = deps({ accepted: false });
    failing.postMessage.mockRejectedValue(new Error('channel_not_found'));
    await expect(runNewUserGate(failing, AT)).rejects.toThrow('channel_not_found');
  });
});

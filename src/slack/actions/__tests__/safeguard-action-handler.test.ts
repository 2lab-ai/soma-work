/**
 * ssot-task: T3 — the admin button is the only way to lift a safeguards halt.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildWorkSessionKey } from '../../../session-identity';
import { SafeguardActionHandler } from '../safeguard-action-handler';

const KEY = buildWorkSessionKey('C1', '171.1');

const HALT = { atMs: 1_000, detail: 'reasoning_extraction' };

function harness(opts: { halt?: typeof HALT; admin: boolean; liftThrows?: boolean }) {
  let halt: typeof HALT | undefined = opts.halt;
  const registry = {
    getSafeguardHaltByKey: vi.fn(() => halt),
    liftSafeguardHalt: vi.fn(() => {
      if (opts.liftThrows) throw new Error('disk full');
      halt = undefined;
      return true;
    }),
    broadcastSessionUpdate: vi.fn(),
  };
  const handler = new SafeguardActionHandler({ getRegistry: () => registry, isAdmin: () => opts.admin });
  const respond = vi.fn().mockResolvedValue(undefined);
  const click = (atMs = 1_000, where: { channel: string; threadTs: string } = { channel: 'C1', threadTs: '171.1' }) =>
    handler.handleAdminRetry(
      {
        user: { id: 'U_CLICK' },
        channel: { id: where.channel },
        message: { ts: '171.9', thread_ts: where.threadTs },
        actions: [{ value: JSON.stringify({ sessionKey: KEY, atMs }) }],
      },
      respond,
    );
  return { registry, respond, click, current: () => halt };
}

describe('SafeguardActionHandler (T3)', () => {
  it('an admin click lifts the lock and says so on the notice', async () => {
    const h = harness({ halt: HALT, admin: true });
    await h.click();
    expect(h.registry.liftSafeguardHalt).toHaveBeenCalledWith(KEY);
    expect(h.current()).toBeUndefined();
    expect(h.respond).toHaveBeenCalledWith(
      expect.objectContaining({ replace_original: true, text: expect.stringContaining('<@U_CLICK>') }),
    );
    expect(h.registry.broadcastSessionUpdate).toHaveBeenCalled();
  });

  it('a non-admin click leaves the lock and is told only an admin may retry', async () => {
    const h = harness({ halt: HALT, admin: false });
    await h.click();
    expect(h.registry.liftSafeguardHalt).not.toHaveBeenCalled();
    expect(h.current()).toEqual(HALT);
    expect(h.respond).toHaveBeenCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', text: expect.stringContaining('관리자') }),
    );
  });

  it("an older notice's button does not lift a newer halt", async () => {
    const h = harness({ halt: HALT, admin: true });
    await h.click(999);
    expect(h.registry.liftSafeguardHalt).not.toHaveBeenCalled();
  });

  it('a click from another thread does not lift this thread (the value is not trusted for the key)', async () => {
    const h = harness({ halt: HALT, admin: true });
    await h.click(1_000, { channel: 'C1', threadTs: '999.9' });
    expect(h.registry.liftSafeguardHalt).not.toHaveBeenCalled();
    expect(h.current()).toEqual(HALT);
  });

  it('a failed save reports the lock as still on', async () => {
    const h = harness({ halt: HALT, admin: true, liftThrows: true });
    await h.click();
    expect(h.respond).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('여전히 잠겨') }));
    expect(h.registry.broadcastSessionUpdate).not.toHaveBeenCalled();
  });
});

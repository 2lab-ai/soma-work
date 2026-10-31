/**
 * E4 ④a-2 — `/z epictasks`: the per-user switch for making epic tasks
 * (.prd/19 D12). Off by default; only an accepted user can change it.
 */
import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  users: {} as Record<string, { accepted?: boolean; epicTasks?: boolean }>,
  fail: false,
}));

vi.mock('../../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: (u: string) => store.users[u],
    getUserEpicTasks: (u: string) => store.users[u]?.epicTasks === true,
    setUserEpicTasks: (u: string, v: boolean) => {
      if (store.fail) throw new Error('disk full');
      store.users[u] = { ...(store.users[u] ?? { accepted: true }), epicTasks: v };
    },
  },
}));

import { EpicTasksHandler } from '../../../commands/epictasks-handler';
import { applyEpicTasks, createEpicTasksTopicBinding, renderEpicTasksCard } from '../epictasks-topic';

const actionIds = (blocks: any[]) =>
  blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e: any) => e.action_id));

describe('epictasks topic (E4 ④a-2)', () => {
  it('the card shows the state with on/off buttons; off by default', async () => {
    store.users = { U1: { accepted: true } };
    const off = await renderEpicTasksCard({ userId: 'U1', issuedAt: 1 });
    expect(off.text).toContain('OFF');
    expect(actionIds(off.blocks)).toEqual(
      expect.arrayContaining(['z_setting_epictasks_set_on', 'z_setting_epictasks_set_off']),
    );
    store.users.U1.epicTasks = true;
    expect((await renderEpicTasksCard({ userId: 'U1', issuedAt: 2 })).text).toContain('ON');
  });

  it('an accepted user turns it on and off; an unknown or pending one is refused and nothing is made', async () => {
    store.users = { U1: { accepted: true }, UP: { accepted: false } };
    expect(await applyEpicTasks({ userId: 'U1', value: 'on' })).toMatchObject({ ok: true });
    expect(store.users.U1.epicTasks).toBe(true);
    expect(await applyEpicTasks({ userId: 'U1', value: 'off' })).toMatchObject({ ok: true });
    expect(store.users.U1.epicTasks).toBe(false);
    expect(await applyEpicTasks({ userId: 'UNEW', value: 'on' })).toMatchObject({ ok: false });
    expect(store.users.UNEW).toBeUndefined();
    expect(await applyEpicTasks({ userId: 'UP', value: 'on' })).toMatchObject({ ok: false });
    expect(store.users.UP.epicTasks).toBeUndefined();
  });

  it('a bad value is refused; a failed save is reported', async () => {
    store.users = { U1: { accepted: true } };
    expect(await applyEpicTasks({ userId: 'U1', value: 'maybe' })).toMatchObject({ ok: false });
    store.fail = true;
    try {
      expect(await applyEpicTasks({ userId: 'U1', value: 'on' })).toMatchObject({
        ok: false,
        description: 'disk full',
      });
    } finally {
      store.fail = false;
    }
  });

  it('the binding is the epictasks topic', () => {
    expect(createEpicTasksTopicBinding().topic).toBe('epictasks');
  });
});

describe('EpicTasksHandler — `epictasks on|off`', () => {
  const h = new EpicTasksHandler();
  const ctx = (text: string) =>
    ({ user: 'U1', text, threadTs: '1.1', channel: 'C1', say: vi.fn(async () => ({})) }) as any;

  it('takes epictasks, its status, on/off and the `/z` set form — nothing else', () => {
    for (const t of [
      'epictasks',
      'epictasks status',
      'epictasks on',
      'EPICTASKS OFF',
      '/epictasks on',
      'epictasks set on',
    ]) {
      expect(h.canHandle(t), t).toBe(true);
    }
    for (const t of ['epictasks on now', 'epic tasks on', 'epictask on', 'please epictasks on']) {
      expect(h.canHandle(t), t).toBe(false);
    }
  });

  it('on saves and acks; bare shows the card; a refusal is said and nothing saved', async () => {
    store.users = { U1: { accepted: true } };
    const on = ctx('epictasks on');
    expect(await h.execute(on)).toEqual({ handled: true });
    expect(store.users.U1.epicTasks).toBe(true);
    expect(on.say).toHaveBeenCalledWith({ text: expect.stringContaining('ON'), thread_ts: '1.1' });
    const bare = ctx('epictasks');
    await h.execute(bare);
    expect(bare.say.mock.calls[0][0].blocks.length).toBeGreaterThan(0);
    store.users = {};
    const refused = ctx('epictasks on');
    await h.execute(refused);
    expect(store.users.U1).toBeUndefined();
    expect(refused.say).toHaveBeenCalledWith({ text: expect.stringContaining('관리자 승인'), thread_ts: '1.1' });
  });
});

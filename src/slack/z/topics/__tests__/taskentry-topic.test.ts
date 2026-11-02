/**
 * E2 ⑧ — `/z taskentry`: the per-user switch of the Slack entry (.prd/18 D1).
 * Off by default; only an accepted user can change it (a store setter would
 * otherwise create the record as accepted and skip the new-user gate).
 */
import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  users: {} as Record<string, { accepted?: boolean; slackTaskEntry?: boolean }>,
  fail: false,
}));

vi.mock('../../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: (u: string) => store.users[u],
    getUserSlackTaskEntry: (u: string) => store.users[u]?.slackTaskEntry ?? false,
    setUserSlackTaskEntry: (u: string, v: boolean) => {
      if (store.fail) throw new Error('disk full');
      store.users[u] = { ...(store.users[u] ?? { accepted: true }), slackTaskEntry: v };
    },
  },
}));

import { TaskEntryHandler } from '../../../commands/taskentry-handler';
import {
  applyTaskEntry,
  createTaskEntryTopicBinding,
  parseTaskEntryValue,
  renderTaskEntryCard,
} from '../taskentry-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  return out;
}

describe('taskentry topic', () => {
  it('parses on/off and the usual aliases; anything else is null', () => {
    for (const v of ['on', 'ON', 'true', 'enable']) expect(parseTaskEntryValue(v)).toBe(true);
    for (const v of ['off', 'false', 'disable']) expect(parseTaskEntryValue(v)).toBe(false);
    for (const v of ['', 'maybe', 'status']) expect(parseTaskEntryValue(v)).toBeNull();
  });

  it('the card shows the current state with on/off buttons', async () => {
    store.users = { U1: { accepted: true } };
    const off = await renderTaskEntryCard({ userId: 'U1', issuedAt: 1 });
    expect(off.text).toContain('OFF');
    expect(actionIds(off.blocks)).toEqual(
      expect.arrayContaining(['z_setting_taskentry_set_on', 'z_setting_taskentry_set_off']),
    );
    store.users.U1.slackTaskEntry = true;
    expect((await renderTaskEntryCard({ userId: 'U1', issuedAt: 2 })).text).toContain('ON');
  });

  it('an accepted user turns it on and off', async () => {
    store.users = { U1: { accepted: true } };
    expect(await applyTaskEntry({ userId: 'U1', value: 'on' })).toMatchObject({ ok: true });
    expect(store.users.U1.slackTaskEntry).toBe(true);
    expect(await applyTaskEntry({ userId: 'U1', value: 'off' })).toMatchObject({ ok: true });
    expect(store.users.U1.slackTaskEntry).toBe(false);
  });

  it('an unknown or pending user is refused and no record is made', async () => {
    store.users = { UP: { accepted: false } };
    expect(await applyTaskEntry({ userId: 'UNEW', value: 'on' })).toMatchObject({ ok: false });
    expect(store.users.UNEW).toBeUndefined();
    expect(await applyTaskEntry({ userId: 'UP', value: 'on' })).toMatchObject({ ok: false });
    expect(store.users.UP.slackTaskEntry).toBeUndefined();
  });

  it('a bad value is refused; a failed save is reported', async () => {
    store.users = { U1: { accepted: true } };
    expect(await applyTaskEntry({ userId: 'U1', value: 'maybe' })).toMatchObject({ ok: false });
    store.fail = true;
    try {
      expect(await applyTaskEntry({ userId: 'U1', value: 'on' })).toMatchObject({
        ok: false,
        description: 'disk full',
      });
    } finally {
      store.fail = false;
    }
  });

  it('the binding is the taskentry topic', () => {
    expect(createTaskEntryTopicBinding().topic).toBe('taskentry');
  });
});

describe('TaskEntryHandler — `taskentry on|off`', () => {
  const h = new TaskEntryHandler();
  const ctx = (text: string) =>
    ({ user: 'U1', text, threadTs: '1.1', channel: 'C1', say: vi.fn(async () => ({})) }) as any;

  it('takes taskentry, its status, on/off and the `/z` set form — nothing else', () => {
    for (const t of [
      'taskentry',
      'taskentry status',
      'taskentry on',
      'TASKENTRY OFF',
      '/taskentry on',
      'taskentry set on',
    ]) {
      expect(h.canHandle(t), t).toBe(true);
    }
    for (const t of ['taskentry on now', 'task entry on', 'taskentries', 'please taskentry on']) {
      expect(h.canHandle(t), t).toBe(false);
    }
  });

  it('on saves and acks; bare shows the card', async () => {
    store.users = { U1: { accepted: true } };
    const on = ctx('taskentry on');
    expect(await h.execute(on)).toEqual({ handled: true });
    expect(store.users.U1.slackTaskEntry).toBe(true);
    expect(on.say).toHaveBeenCalledWith({ text: expect.stringContaining('ON'), thread_ts: '1.1' });
    const bare = ctx('taskentry');
    await h.execute(bare);
    expect(bare.say.mock.calls[0][0].blocks.length).toBeGreaterThan(0);
  });

  it('a refusal is said, nothing saved', async () => {
    store.users = {};
    const c = ctx('taskentry on');
    await h.execute(c);
    expect(store.users.U1).toBeUndefined();
    expect(c.say).toHaveBeenCalledWith({ text: expect.stringContaining('관리자 승인'), thread_ts: '1.1' });
  });
});

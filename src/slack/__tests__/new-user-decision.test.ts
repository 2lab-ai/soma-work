/**
 * #622 — a new user's access request as ONE decision, Slack DM + dashboard.
 * The real user-settings store and request store (DATA_DIR is a scratch dir).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ admins: new Set<string>(['UADMIN1', 'UADMIN2']) }));
vi.mock('../../admin-utils', () => ({
  isAdminUser: (u: string) => h.admins.has(u),
  getAdminUsers: () => h.admins,
}));

import { DATA_DIR } from '../../env-paths';
import { userSettingsStore } from '../../user-settings-store';
import { UserAcceptanceActionHandler } from '../actions/user-acceptance-action-handler';
import {
  closeNewUserRequest,
  decideNewUser,
  newUserAdminApprovalAdapter,
  notifyAdminsNewUser,
} from '../new-user-decision';

function slackApi() {
  return {
    postMessage: vi.fn(async (channel: string, _text: string, _o?: any) => ({
      ts: `ts-${channel}`,
      channel: `D-${channel}`,
    })),
    updateMessage: vi.fn(async (_c: string, _t: string, _x: string, _b?: any[]) => undefined),
  };
}

let seq = 0;
function newUser(): string {
  const id = `UNEW${++seq}${Date.now()}`;
  userSettingsStore.createPendingUser(id, `Kim ${seq}`);
  return id;
}

describe('new-user access requests as one decision (#622)', () => {
  let api: ReturnType<typeof slackApi>;

  beforeEach(() => {
    fs.rmSync(path.join(DATA_DIR, 'admin-requests.json'), { force: true });
    api = slackApi();
  });

  it('every admin is asked by DM and the request is a dashboard card', async () => {
    const id = newUser();
    expect(await notifyAdminsNewUser(api, id, 'Kim')).toBe(2);
    expect(api.postMessage.mock.calls.map((c) => c[0])).toEqual(['UADMIN1', 'UADMIN2']);
    const card = (await newUserAdminApprovalAdapter(api).pending(Date.now())).find((c) => c.id === `new_user:${id}`);
    expect(card).toMatchObject({ kind: 'new_user', card: 'permission', requesterId: id, title: '새 사용자 접근 요청' });
  });

  it('accepted on the dashboard: the user is accepted, every admin DM rewritten, the user told; Slack then reads "already"', async () => {
    const id = newUser();
    await notifyAdminsNewUser(api, id, 'Kim');
    const adapter = newUserAdminApprovalAdapter(api);
    expect(await adapter.answer(id, 'approve', 'UADMIN1')).toEqual({ ok: true, outcome: 'approved' });
    expect(userSettingsStore.getUserSettings(id)?.accepted).toBe(true);
    await vi.waitFor(() => expect(api.updateMessage).toHaveBeenCalledTimes(2));
    expect(api.updateMessage.mock.calls.map((c) => c[0])).toEqual(['D-UADMIN1', 'D-UADMIN2']);
    for (const c of api.updateMessage.mock.calls) expect(c[2]).toContain('대시보드에서 응답');
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledWith(id, expect.stringContaining('승인'), {}));
    expect((await adapter.pending(Date.now())).some((c) => c.id === `new_user:${id}`)).toBe(false);
    expect((await adapter.resolved(0)).find((r) => r.id === `new_user:${id}`)).toMatchObject({
      outcome: 'approved',
      by: 'UADMIN1',
      via: 'dashboard',
    });
    // The other admin's DM click, later: refused, nothing changes.
    const respond = vi.fn(async () => undefined);
    await new UserAcceptanceActionHandler({ slackApi: api }).handleDeny(
      { user: { id: 'UADMIN2' }, actions: [{ value: id }] },
      respond,
    );
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    expect(userSettingsStore.getUserSettings(id)?.accepted).toBe(true);
  });

  it('denied in Slack: the user record is removed, the card resolves with who; the dashboard answer is already answered', async () => {
    const id = newUser();
    await notifyAdminsNewUser(api, id, 'Kim');
    const respond = vi.fn(async () => undefined);
    await new UserAcceptanceActionHandler({ slackApi: api }).handleDeny(
      { user: { id: 'UADMIN2' }, actions: [{ value: id }] },
      respond,
    );
    expect(userSettingsStore.getUserSettings(id)).toBeUndefined();
    expect(api.updateMessage).toHaveBeenCalledTimes(2);
    const adapter = newUserAdminApprovalAdapter(api);
    expect((await adapter.resolved(0)).find((r) => r.id === `new_user:${id}`)).toMatchObject({
      outcome: 'denied',
      via: 'slack',
    });
    expect(await adapter.answer(id, 'approve', 'UADMIN1')).toEqual({ ok: false, reason: 'already_answered' });
    expect(userSettingsStore.getUserSettings(id)).toBeUndefined();
  });

  it('two answers at the same moment: exactly one takes effect', async () => {
    const id = newUser();
    await notifyAdminsNewUser(api, id, 'Kim');
    const a = decideNewUser({ userId: id, decision: 'accept', actor: 'UADMIN1', via: 'dashboard', slackApi: api });
    const b = decideNewUser({ userId: id, decision: 'deny', actor: 'UADMIN2', via: 'slack', slackApi: api });
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(userSettingsStore.getUserSettings(id)?.accepted).toBe(true);
  });

  it('answered on the dashboard while the DMs were going out: the late copies are closed', async () => {
    const id = newUser();
    let answered = false;
    api.postMessage.mockImplementation(async (channel: string) => {
      if (channel === 'UADMIN2' && !answered) {
        answered = true;
        await newUserAdminApprovalAdapter(api).answer(id, 'deny', 'UADMIN1');
      }
      return { ts: `ts-${channel}`, channel: `D-${channel}` };
    });
    await notifyAdminsNewUser(api, id, 'Kim');
    const closed = api.updateMessage.mock.calls.map((c) => c[0]);
    expect(closed).toEqual(expect.arrayContaining(['D-UADMIN1', 'D-UADMIN2']));
  });

  it('a pending user from before the request store is still a card, and answerable once', async () => {
    const id = newUser(); // no notifyAdminsNewUser: no recorded round
    const adapter = newUserAdminApprovalAdapter(api);
    expect((await adapter.pending(Date.now())).some((c) => c.id === `new_user:${id}`)).toBe(true);
    expect(await adapter.answer(id, 'approve', 'UADMIN1')).toEqual({ ok: true, outcome: 'approved' });
    expect(await adapter.answer(id, 'deny', 'UADMIN2')).toEqual({ ok: false, reason: 'already_answered' });
  });

  it('refused: a non-admin, an unknown choice, a user who is not pending', async () => {
    const id = newUser();
    const adapter = newUserAdminApprovalAdapter(api);
    expect(await adapter.answer(id, 'approve', id)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await adapter.answer(id, 'maybe', 'UADMIN1')).toEqual({ ok: false, reason: 'invalid' });
    expect(await adapter.answer('UNOBODY', 'approve', 'UADMIN1')).toEqual({ ok: false, reason: 'not_found' });
    expect(userSettingsStore.getUserSettings(id)?.accepted).toBe(false);
  });

  it('the `admin accept` command ends the open round: DMs rewritten, card resolved', async () => {
    const id = newUser();
    await notifyAdminsNewUser(api, id, 'Kim');
    userSettingsStore.acceptUser(id, 'UADMIN1');
    await closeNewUserRequest(id, 'accept', 'UADMIN1', api);
    expect(api.updateMessage).toHaveBeenCalledTimes(2);
    const adapter = newUserAdminApprovalAdapter(api);
    expect((await adapter.pending(Date.now())).some((c) => c.id === `new_user:${id}`)).toBe(false);
    expect((await adapter.resolved(0)).find((r) => r.id === `new_user:${id}`)).toMatchObject({ outcome: 'approved' });
  });
});

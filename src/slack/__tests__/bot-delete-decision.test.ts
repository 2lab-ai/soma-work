/**
 * #623 — a non-admin's request to delete a bot message as ONE decision,
 * the admins' Slack DMs + the dashboard. The real request store (DATA_DIR scratch).
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
import { BotDeleteActionHandler } from '../actions/bot-delete-action-handler';
import {
  botDeleteAdminApprovalAdapter,
  botDeleteRequestId,
  decideBotDelete,
  reconcileBotDeletes,
  requestBotDelete,
} from '../bot-delete-decision';

function slackApi() {
  return {
    openDmChannel: vi.fn(async (u: string) => `D-${u}`),
    postMessage: vi.fn(async (channel: string, _t: string, _o?: any) => ({ ts: `ts-${channel}`, channel })),
    updateMessage: vi.fn(async (_c: string, _t: string, _x: string, _b?: any[]) => undefined),
    deleteMessage: vi.fn(async (_c: string, _t: string) => undefined),
  };
}

const TARGET = { requesterId: 'U1', targetChannel: 'C1', targetTs: '171.1' };
const ID = botDeleteRequestId('C1', '171.1');

function click(api: ReturnType<typeof slackApi>, actor: string, value: object, decision: 'approve' | 'reject') {
  const respond = vi.fn(async (_m: any) => undefined);
  const handler = new BotDeleteActionHandler({ slackApi: api });
  const body = { user: { id: actor }, actions: [{ value: JSON.stringify(value) }] };
  return (decision === 'approve' ? handler.handleApprove(body, respond) : handler.handleReject(body, respond)).then(
    () => respond,
  );
}

describe('bot-message delete requests as one decision (#623)', () => {
  let api: ReturnType<typeof slackApi>;

  beforeEach(() => {
    fs.rmSync(path.join(DATA_DIR, 'admin-requests.json'), { force: true });
    fs.rmSync(path.join(DATA_DIR, 'admin-requests.json.bak'), { force: true });
    api = slackApi();
  });

  it('every admin is asked by DM (buttons carry the request id) and the request is a dashboard card', async () => {
    expect(await requestBotDelete(api, { ...TARGET, preview: '배포 완료 메시지' })).toBe(2);
    const value = JSON.parse(api.postMessage.mock.calls[0][2].blocks[1].elements[0].value);
    expect(value).toMatchObject({ ...TARGET, requestId: ID });
    const card = (await botDeleteAdminApprovalAdapter(api).pending(Date.now())).find(
      (c) => c.id === `bot_delete:${ID}`,
    );
    expect(card).toMatchObject({
      kind: 'bot_delete',
      card: 'permission',
      requesterId: 'U1',
      rows: { 채널: 'C1', 메시지: '171.1', 미리보기: '배포 완료 메시지' },
    });
  });

  it('approved on the dashboard: deleted once, every admin DM rewritten, the requester told; a Slack click later is refused', async () => {
    await requestBotDelete(api, TARGET);
    const adapter = botDeleteAdminApprovalAdapter(api);
    expect(await adapter.answer(ID, 'approve', 'UADMIN1')).toEqual({ ok: true, outcome: 'approved' });
    expect(api.deleteMessage).toHaveBeenCalledWith('C1', '171.1');
    await vi.waitFor(() => expect(api.updateMessage).toHaveBeenCalledTimes(2));
    for (const c of api.updateMessage.mock.calls) expect(c[2]).toContain('대시보드에서 응답');
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledWith('D-U1', expect.stringContaining('승인')));
    expect((await adapter.pending(Date.now())).some((c) => c.id === `bot_delete:${ID}`)).toBe(false);
    const respond = await click(api, 'UADMIN2', { ...TARGET, requestId: ID }, 'reject');
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    expect(api.deleteMessage).toHaveBeenCalledTimes(1);
    expect(api.postMessage).not.toHaveBeenCalledWith('D-U1', expect.stringContaining('거절'));
  });

  it('rejected in Slack: nothing deleted, the card resolves with who; the dashboard answer is already answered', async () => {
    await requestBotDelete(api, TARGET);
    const respond = await click(api, 'UADMIN2', { ...TARGET, requestId: ID }, 'reject');
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ replace_original: true }));
    expect(api.updateMessage).toHaveBeenCalledTimes(2);
    const adapter = botDeleteAdminApprovalAdapter(api);
    expect((await adapter.resolved(0)).find((r) => r.id === `bot_delete:${ID}`)).toMatchObject({
      outcome: 'denied',
      via: 'slack',
    });
    expect(await adapter.answer(ID, 'approve', 'UADMIN1')).toEqual({ ok: false, reason: 'already_answered' });
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it('two answers at the same moment: exactly one acts', async () => {
    await requestBotDelete(api, TARGET);
    const results = await Promise.all([
      decideBotDelete({ requestId: ID, decision: 'approve', actor: 'UADMIN1', via: 'dashboard', slackApi: api }),
      decideBotDelete({ requestId: ID, decision: 'approve', actor: 'UADMIN2', via: 'slack', slackApi: api }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(api.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('a button from before the request store (no request id) still acts — once', async () => {
    const first = await click(api, 'UADMIN1', TARGET, 'approve');
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ replace_original: true }));
    const second = await click(api, 'UADMIN2', TARGET, 'approve');
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    expect(api.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('a delete that fails reopens the request (try again); a message already gone counts as deleted', async () => {
    await requestBotDelete(api, TARGET);
    const adapter = botDeleteAdminApprovalAdapter(api);
    api.deleteMessage.mockRejectedValueOnce(
      Object.assign(new Error('cant_delete_message'), { data: { error: 'cant_delete_message' } }),
    );
    await expect(adapter.answer(ID, 'approve', 'UADMIN1')).rejects.toThrow('삭제에 실패');
    expect((await adapter.pending(Date.now())).some((c) => c.id === `bot_delete:${ID}`)).toBe(true);
    api.deleteMessage.mockRejectedValueOnce(Object.assign(new Error('gone'), { data: { error: 'message_not_found' } }));
    expect(await adapter.answer(ID, 'approve', 'UADMIN2')).toEqual({ ok: true, outcome: 'approved' });
  });

  it('answered on the dashboard while the DMs were going out: the late copies are closed', async () => {
    let answered = false;
    api.postMessage.mockImplementation(async (channel: string) => {
      if (channel === 'D-UADMIN2' && !answered) {
        answered = true;
        await botDeleteAdminApprovalAdapter(api).answer(ID, 'deny', 'UADMIN1');
      }
      return { ts: `ts-${channel}`, channel };
    });
    await requestBotDelete(api, TARGET);
    expect(api.updateMessage.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['D-UADMIN1', 'D-UADMIN2']));
  });

  it('an approved delete — done or still in flight — is not asked again (no contradicting second round)', async () => {
    await requestBotDelete(api, TARGET);
    let finish: () => void = () => {};
    api.deleteMessage.mockImplementationOnce(
      () =>
        new Promise<undefined>((r) => {
          finish = () => r(undefined);
        }),
    );
    const inFlight = decideBotDelete({
      requestId: ID,
      decision: 'approve',
      actor: 'UADMIN1',
      via: 'dashboard',
      slackApi: api,
    });
    await new Promise((r) => setTimeout(r, 5));
    const posted = api.postMessage.mock.calls.length;
    expect(await requestBotDelete(api, TARGET)).toBe('alreadyApproved');
    expect(api.postMessage.mock.calls.length).toBe(posted);
    expect(
      await decideBotDelete({ requestId: ID, decision: 'reject', actor: 'UADMIN2', via: 'slack', slackApi: api }),
    ).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    finish();
    expect(await inFlight).toMatchObject({ ok: true, outcome: 'approved' });
  });

  it('a slow delete that fails reopens only its own answer, never a later one', async () => {
    await requestBotDelete(api, TARGET);
    let fail: () => void = () => {};
    api.deleteMessage.mockImplementationOnce(
      () =>
        new Promise((_r, reject) => {
          fail = () => reject(Object.assign(new Error('x'), { data: { error: 'cant_delete_message' } }));
        }),
    );
    const first = decideBotDelete({
      requestId: ID,
      decision: 'approve',
      actor: 'UADMIN1',
      via: 'dashboard',
      slackApi: api,
    });
    await new Promise((r) => setTimeout(r, 5));
    fail();
    expect(await first).toMatchObject({ ok: false, reason: 'failed' });
    // Reopened (its own answer): a later answer acts once, and stays.
    expect(
      await decideBotDelete({ requestId: ID, decision: 'reject', actor: 'UADMIN2', via: 'slack', slackApi: api }),
    ).toMatchObject({
      ok: true,
      outcome: 'denied',
    });
    expect(
      await decideBotDelete({ requestId: ID, decision: 'approve', actor: 'UADMIN1', via: 'slack', slackApi: api }),
    ).toMatchObject({
      ok: false,
      reason: 'already_answered',
    });
  });

  it('a delete in flight is not a decision yet: late DMs keep their buttons; on success every recorded copy says deleted', async () => {
    let finish: (ok: boolean) => void = () => {};
    api.deleteMessage.mockImplementation(
      () =>
        new Promise<undefined>((resolve, reject) => {
          finish = (ok) =>
            ok ? resolve(undefined) : reject(Object.assign(new Error('x'), { data: { error: 'cant_delete_message' } }));
        }),
    );
    // The first admin DM goes out; then the dashboard approves while the second is still being posted.
    let inFlight: Promise<any> | undefined;
    api.postMessage.mockImplementation(async (channel: string) => {
      if (channel === 'D-UADMIN2' && !inFlight) {
        inFlight = decideBotDelete({
          requestId: ID,
          decision: 'approve',
          actor: 'UADMIN1',
          via: 'dashboard',
          slackApi: api,
        });
        await new Promise((r) => setTimeout(r, 5));
      }
      return { ts: `ts-${channel}`, channel };
    });
    await requestBotDelete(api, TARGET);
    // Not decided yet: nothing announced "deleted", the card is neither pending nor resolved.
    expect(api.updateMessage).not.toHaveBeenCalled();
    const adapter = botDeleteAdminApprovalAdapter(api);
    expect((await adapter.resolved(0)).some((r) => r.id === `bot_delete:${ID}`)).toBe(false);
    finish(true);
    expect(await inFlight).toMatchObject({ ok: true, outcome: 'approved' });
    await vi.waitFor(() =>
      expect(api.updateMessage.mock.calls.map((c) => c[0]).sort()).toEqual(['D-UADMIN1', 'D-UADMIN2']),
    );
    expect((await adapter.resolved(0)).find((r) => r.id === `bot_delete:${ID}`)).toMatchObject({ outcome: 'approved' });
  });

  it('a delete in flight that fails: nothing was announced, the request is answerable again', async () => {
    await requestBotDelete(api, TARGET);
    let fail: () => void = () => {};
    api.deleteMessage.mockImplementationOnce(
      () =>
        new Promise((_r, reject) => {
          fail = () => reject(Object.assign(new Error('x'), { data: { error: 'cant_delete_message' } }));
        }),
    );
    const first = decideBotDelete({
      requestId: ID,
      decision: 'approve',
      actor: 'UADMIN1',
      via: 'dashboard',
      slackApi: api,
    });
    await new Promise((r) => setTimeout(r, 5));
    fail();
    expect(await first).toMatchObject({ ok: false, reason: 'failed' });
    expect(api.updateMessage).not.toHaveBeenCalled();
    expect(
      (await botDeleteAdminApprovalAdapter(api).pending(Date.now())).some((c) => c.id === `bot_delete:${ID}`),
    ).toBe(true);
  });

  it('a delete this process is still carrying out never lapses: a second answer is told to retry (busy), not decided', async () => {
    await requestBotDelete(api, TARGET);
    let finish: () => void = () => {};
    api.deleteMessage.mockImplementationOnce(
      () =>
        new Promise<undefined>((r) => {
          finish = () => r(undefined);
        }),
    );
    // A's claim is far older than the lapse window (Slack held the delete for minutes).
    const a = decideBotDelete({
      requestId: ID,
      decision: 'approve',
      actor: 'UADMIN1',
      via: 'dashboard',
      slackApi: api,
      now: Date.now() - 10 * 60 * 1000,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(
      await decideBotDelete({ requestId: ID, decision: 'reject', actor: 'UADMIN2', via: 'slack', slackApi: api }),
    ).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    const adapter = botDeleteAdminApprovalAdapter(api);
    expect(await adapter.answer(ID, 'deny', 'UADMIN2')).toEqual({ ok: false, reason: 'busy' });
    finish();
    expect(await a).toMatchObject({ ok: true, outcome: 'approved' });
    expect((await adapter.resolved(0)).find((r) => r.id === `bot_delete:${ID}`)).toMatchObject({
      outcome: 'approved',
      by: 'UADMIN1',
    });
    expect(api.postMessage).not.toHaveBeenCalledWith('D-U1', expect.stringContaining('거절'));
  });

  function leaveOrphan() {
    // What a process that died mid-delete leaves: an unsettled approval on disk, nobody carrying it out.
    const file = path.join(DATA_DIR, 'admin-requests.json');
    const all = JSON.parse(fs.readFileSync(file, 'utf-8'));
    all[`bot_delete:${ID}`].handled = true;
    all[`bot_delete:${ID}`].resolution = {
      by: 'UADMIN1',
      choiceId: 'approve',
      outcome: 'approved',
      via: 'slack',
      at: Date.now() - 10 * 60 * 1000,
      settled: false,
    };
    fs.writeFileSync(file, JSON.stringify(all));
  }

  it('an approval a dead process left: the next answer first redoes the delete — done, so it stands', async () => {
    await requestBotDelete(api, TARGET);
    leaveOrphan();
    // The delete had in fact gone through before the crash.
    api.deleteMessage.mockRejectedValueOnce(Object.assign(new Error('gone'), { data: { error: 'message_not_found' } }));
    expect(
      await decideBotDelete({ requestId: ID, decision: 'reject', actor: 'UADMIN2', via: 'slack', slackApi: api }),
    ).toMatchObject({
      ok: false,
      reason: 'already_answered',
    });
    expect(api.deleteMessage).toHaveBeenCalledWith('C1', '171.1');
    const adapter = botDeleteAdminApprovalAdapter(api);
    expect((await adapter.resolved(0)).find((r) => r.id === `bot_delete:${ID}`)).toMatchObject({
      outcome: 'approved',
      by: 'UADMIN1',
    });
    expect(api.updateMessage.mock.calls.every((c) => String(c[2]).includes('삭제되었습니다'))).toBe(true);
    expect(api.postMessage).not.toHaveBeenCalledWith('D-U1', expect.stringContaining('거절'));
  });

  it('an approval a dead process left whose delete cannot be redone: the request opens, the next answer decides', async () => {
    await requestBotDelete(api, TARGET);
    leaveOrphan();
    api.deleteMessage.mockRejectedValueOnce(Object.assign(new Error('x'), { data: { error: 'channel_not_found' } }));
    expect(
      await decideBotDelete({ requestId: ID, decision: 'reject', actor: 'UADMIN2', via: 'slack', slackApi: api }),
    ).toMatchObject({
      ok: true,
      outcome: 'denied',
    });
  });

  it('an orphan whose redo finishes after another answer was recorded: that answer stands, nothing is announced', async () => {
    await requestBotDelete(api, TARGET);
    leaveOrphan();
    const file = path.join(DATA_DIR, 'admin-requests.json');
    api.deleteMessage.mockImplementationOnce(async () => {
      // While the redo runs, another answer lands on record (a denial).
      const all = JSON.parse(fs.readFileSync(file, 'utf-8'));
      all[`bot_delete:${ID}`].resolution = {
        by: 'UADMIN2',
        choiceId: 'reject',
        outcome: 'denied',
        via: 'slack',
        at: Date.now(),
      };
      fs.writeFileSync(file, JSON.stringify(all));
      throw Object.assign(new Error('gone'), { data: { error: 'message_not_found' } });
    });
    expect(await reconcileBotDeletes(api)).toBe(0);
    expect(api.updateMessage).not.toHaveBeenCalled();
    expect(api.postMessage).not.toHaveBeenCalledWith('D-U1', expect.stringContaining('삭제되었습니다'));
    expect(
      (await botDeleteAdminApprovalAdapter(api).resolved(0)).find((r) => r.id === `bot_delete:${ID}`),
    ).toMatchObject({
      outcome: 'denied',
      by: 'UADMIN2',
    });
  });

  it('a delete whose outcome is unknown (timeout): the approval stays claimed; the next answer redoes it, not overrides it', async () => {
    await requestBotDelete(api, TARGET);
    // The request timed out — Slack may have deleted the message.
    api.deleteMessage.mockRejectedValueOnce(new Error('socket hang up'));
    expect(
      await decideBotDelete({ requestId: ID, decision: 'approve', actor: 'UADMIN1', via: 'slack', slackApi: api }),
    ).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    // A competing reject: the redo runs first and finds the message gone — the approval stands.
    api.deleteMessage.mockRejectedValueOnce(Object.assign(new Error('gone'), { data: { error: 'message_not_found' } }));
    expect(
      await decideBotDelete({ requestId: ID, decision: 'reject', actor: 'UADMIN2', via: 'slack', slackApi: api }),
    ).toMatchObject({
      ok: false,
      reason: 'already_answered',
    });
    expect(
      (await botDeleteAdminApprovalAdapter(api).resolved(0)).find((r) => r.id === `bot_delete:${ID}`),
    ).toMatchObject({
      outcome: 'approved',
      by: 'UADMIN1',
    });
  });

  it('an orphan whose redo cannot reach Slack stays claimed: a competing answer is told to retry', async () => {
    await requestBotDelete(api, TARGET);
    leaveOrphan();
    api.deleteMessage.mockRejectedValueOnce(Object.assign(new Error('x'), { data: { error: 'ratelimited' } }));
    expect(
      await decideBotDelete({ requestId: ID, decision: 'reject', actor: 'UADMIN2', via: 'slack', slackApi: api }),
    ).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    const held = (await botDeleteAdminApprovalAdapter(api).resolved(0)).find((r) => r.id === `bot_delete:${ID}`);
    expect(held).toBeUndefined(); // still an unsettled approval, not a decision
    expect(api.postMessage).not.toHaveBeenCalledWith('D-U1', expect.stringContaining('거절'));
  });

  it('at startup every orphaned approval is finished', async () => {
    await requestBotDelete(api, TARGET);
    leaveOrphan();
    expect(await reconcileBotDeletes(api)).toBe(1);
    expect(api.deleteMessage).toHaveBeenCalledTimes(1);
    expect(
      (await botDeleteAdminApprovalAdapter(api).resolved(0)).find((r) => r.id === `bot_delete:${ID}`),
    ).toMatchObject({
      outcome: 'approved',
    });
    expect(await reconcileBotDeletes(api)).toBe(0);
  });

  it('refused: a non-admin, an unknown choice, a missing request', async () => {
    await requestBotDelete(api, TARGET);
    const adapter = botDeleteAdminApprovalAdapter(api);
    expect(await adapter.answer(ID, 'approve', 'U1')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await adapter.answer(ID, 'maybe', 'UADMIN1')).toEqual({ ok: false, reason: 'invalid' });
    expect(await adapter.answer('C9/1.1', 'approve', 'UADMIN1')).toEqual({ ok: false, reason: 'not_found' });
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });
});

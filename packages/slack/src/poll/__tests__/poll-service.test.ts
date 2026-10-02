import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollService, type PollSlackApi } from '../poll-service';
import { PollStore } from '../poll-store';

const tick = () => new Promise((r) => setTimeout(r, 0));
const NOW = Date.UTC(2026, 9, 2, 2, 0, 0); // 11:00 KST
const CLOSES = Date.UTC(2026, 9, 2, 3, 50, 0); // 12:50 KST

function platformError(code: string) {
  const err: any = new Error(`An API error occurred: ${code}`);
  err.code = 'slack_webapi_platform_error';
  err.data = { ok: false, error: code };
  return err;
}

function transientError() {
  const err: any = new Error('socket hang up');
  err.code = 'slack_webapi_request_error';
  return err;
}

describe('PollService', () => {
  let dir: string;
  let store: PollStore;
  let slack: {
    postMessage: ReturnType<typeof vi.fn>;
    updateMessage: ReturnType<typeof vi.fn>;
    deleteMessage: ReturnType<typeof vi.fn>;
    threadHasBotMessage: ReturnType<typeof vi.fn>;
  };
  let now: number;
  let seq: number;
  let service: PollService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-service-'));
    store = new PollStore(path.join(dir, 'polls.json'));
    store.load();
    seq = 0;
    slack = {
      postMessage: vi.fn(async (_c: string, _t: string, opts?: { threadTs?: string }) => ({
        ts: `200.${++seq}`,
        threadTs: opts?.threadTs,
        echoedMessage: true,
      })),
      updateMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      threadHasBotMessage: vi.fn(async () => false),
    };
    now = NOW;
    service = new PollService({
      store,
      slack: slack as unknown as PollSlackApi,
      now: () => now,
      newId: () => `poll_${++seq}`,
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function openPoll(overrides: Partial<{ creatorId: string; options: string[] }> = {}) {
    const res = await service.createPoll({
      invocationId: 'toolu_x',
      channel: 'C1',
      threadTs: '100.1',
      creatorId: overrides.creatorId ?? 'UCREATOR',
      title: '점심 팀 편성',
      options: overrides.options ?? ['김치찌개', '된장찌개', '제육볶음'],
      closesAt: CLOSES,
    });
    if (!res.ok) throw new Error(`create failed: ${res.reason}`);
    return res.poll;
  }

  const vote = (pollId: string, userId: string, optionIndex: number, actionTs: string, messageTs: string) =>
    service.castVote({ pollId, userId, optionIndex, actionTs, channel: 'C1', messageTs });

  describe('createPoll', () => {
    it('posts the card in the thread and persists exactly one open record with its messageTs', async () => {
      const poll = await openPoll();
      expect(slack.postMessage).toHaveBeenCalledTimes(1);
      const [channel, , opts] = slack.postMessage.mock.calls[0];
      expect(channel).toBe('C1');
      expect(opts.threadTs).toBe('100.1');
      expect(opts.blocks.length).toBeGreaterThan(0);
      const stored = store.get(poll.id);
      expect(stored?.status).toBe('open');
      expect(stored?.messageTs).toBe(poll.messageTs);
      expect(stored?.creatorId).toBe('UCREATOR');
    });

    it('two overlapping creates in the same thread produce one poll (reservation held until write)', async () => {
      const a = service.createPoll({
        channel: 'C1',
        threadTs: '100.1',
        creatorId: 'U1',
        title: 't',
        options: ['a', 'b'],
        closesAt: CLOSES,
      });
      const b = service.createPoll({
        channel: 'C1',
        threadTs: '100.1',
        creatorId: 'U2',
        title: 't',
        options: ['a', 'b'],
        closesAt: CLOSES,
      });
      const [ra, rb] = await Promise.all([a, b]);
      expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
      const failed = ra.ok ? rb : ra;
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.reason).toBe('thread_has_open_poll');
      expect(store.all()).toHaveLength(1);
      expect(slack.postMessage).toHaveBeenCalledTimes(1);
    });

    it('refuses while an open poll exists in the thread, allows again after it closes', async () => {
      const first = await openPoll();
      const again = await service.createPoll({
        channel: 'C1',
        threadTs: '100.1',
        creatorId: 'U9',
        title: 't',
        options: ['a'],
        closesAt: CLOSES,
      });
      expect(again.ok).toBe(false);
      await service.close({ pollId: first.id, actorId: 'UCREATOR', channel: 'C1', messageTs: first.messageTs });
      const third = await service.createPoll({
        channel: 'C1',
        threadTs: '100.1',
        creatorId: 'U9',
        title: 't',
        options: ['a'],
        closesAt: CLOSES,
      });
      expect(third.ok).toBe(true);
    });

    it('rejects a deadline closer than 60s or beyond 7 days without posting', async () => {
      const soon = await service.createPoll({
        channel: 'C1',
        threadTs: '1.1',
        creatorId: 'U1',
        title: 't',
        options: ['a'],
        closesAt: NOW + 30_000,
      });
      const far = await service.createPoll({
        channel: 'C1',
        threadTs: '1.2',
        creatorId: 'U1',
        title: 't',
        options: ['a'],
        closesAt: NOW + 8 * 24 * 3600_000,
      });
      expect(soon.ok).toBe(false);
      expect(far.ok).toBe(false);
      if (!soon.ok) expect(soon.reason).toBe('closes_at_out_of_range');
      expect(slack.postMessage).not.toHaveBeenCalled();
      expect(store.all()).toHaveLength(0);
    });

    it('post failure leaves no record (no zombie), and a rerun works', async () => {
      slack.postMessage.mockRejectedValueOnce(platformError('not_in_channel'));
      const res = await service.createPoll({
        channel: 'C1',
        threadTs: '100.1',
        creatorId: 'U1',
        title: 't',
        options: ['a'],
        closesAt: CLOSES,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('post_failed');
      expect(store.all()).toHaveLength(0);
      const rerun = await openPoll();
      expect(rerun.status).toBe('open');
    });

    it('card landing at the channel root (dead thread) is deleted and nothing is recorded', async () => {
      slack.postMessage.mockResolvedValueOnce({ ts: '300.1', threadTs: undefined, echoedMessage: true });
      const res = await service.createPoll({
        channel: 'C1',
        threadTs: '100.1',
        creatorId: 'U1',
        title: 't',
        options: ['a'],
        closesAt: CLOSES,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('misthreaded');
      expect(slack.deleteMessage).toHaveBeenCalledWith('C1', '300.1');
      expect(store.all()).toHaveLength(0);
    });

    it('unconfirmed placement (no echoed message) is not treated as success', async () => {
      slack.postMessage.mockResolvedValueOnce({ ts: '300.2', echoedMessage: false });
      const res = await service.createPoll({
        channel: 'C1',
        threadTs: '100.1',
        creatorId: 'U1',
        title: 't',
        options: ['a'],
        closesAt: CLOSES,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('post_outcome_unknown');
      expect(slack.deleteMessage).toHaveBeenCalledTimes(1);
      expect(store.all()).toHaveLength(0);
    });

    it('card posts use strictBlocks so a block rejection never yields a buttonless poll', async () => {
      await openPoll();
      expect(slack.postMessage.mock.calls[0][2].strictBlocks).toBe(true);
    });

    it('same invocation id is applied once', async () => {
      await openPoll();
      const dup = await service.createPoll({
        invocationId: 'toolu_x',
        channel: 'C2',
        threadTs: '9.9',
        creatorId: 'UCREATOR',
        title: 't',
        options: ['a'],
        closesAt: CLOSES,
      });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.reason).toBe('duplicate_invocation');
      expect(slack.postMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('castVote', () => {
    it('one vote per user; a later click on another option replaces it; card shows counts only', async () => {
      const p = await openPoll();
      expect((await vote(p.id, 'UA', 0, '300.1', p.messageTs)).kind).toBe('recorded');
      expect((await vote(p.id, 'UA', 2, '300.2', p.messageTs)).kind).toBe('recorded');
      expect(store.get(p.id)?.votes).toEqual({ UA: 2 });
      const lastUpdate = slack.updateMessage.mock.calls.at(-1);
      const blocksJson = JSON.stringify(lastUpdate?.[3]);
      expect(blocksJson).toContain('3. 제육볶음 · 1');
      expect(blocksJson).not.toContain('UA');
    });

    it('same option again is a no-op for votes (no card update)', async () => {
      const p = await openPoll();
      await vote(p.id, 'UA', 1, '300.1', p.messageTs);
      const updates = slack.updateMessage.mock.calls.length;
      const res = await vote(p.id, 'UA', 1, '300.2', p.messageTs);
      expect(res.kind).toBe('unchanged');
      expect(slack.updateMessage.mock.calls.length).toBe(updates);
    });

    it('ordering by action_ts: A@10 → A@30 → B@20 leaves A (newer same-option click still advances the clock)', async () => {
      const p = await openPoll();
      await vote(p.id, 'UA', 0, '10.0', p.messageTs);
      await vote(p.id, 'UA', 0, '30.0', p.messageTs);
      const late = await vote(p.id, 'UA', 1, '20.0', p.messageTs);
      expect(late.kind).toBe('stale');
      expect(store.get(p.id)?.votes).toEqual({ UA: 0 });
    });

    it('rejects clicks from a different message/channel, out-of-range options and unknown polls', async () => {
      const p = await openPoll();
      expect(
        (
          await service.castVote({
            pollId: p.id,
            userId: 'UA',
            optionIndex: 0,
            actionTs: '1',
            channel: 'C1',
            messageTs: '999.9',
          })
        ).kind,
      ).toBe('mismatch');
      expect(
        (
          await service.castVote({
            pollId: p.id,
            userId: 'UA',
            optionIndex: 0,
            actionTs: '1',
            channel: 'CX',
            messageTs: p.messageTs,
          })
        ).kind,
      ).toBe('mismatch');
      expect((await vote(p.id, 'UA', 7, '1', p.messageTs)).kind).toBe('invalid_option');
      expect((await vote('poll_nope', 'UA', 0, '1', p.messageTs)).kind).toBe('not_found');
      expect(store.get(p.id)?.votes).toEqual({});
    });

    it('rejects votes at/after closesAt even before the scheduler closes the poll', async () => {
      const p = await openPoll();
      now = CLOSES;
      expect((await vote(p.id, 'UA', 0, '1', p.messageTs)).kind).toBe('closed');
      expect(store.get(p.id)?.votes).toEqual({});
    });

    it('serializes concurrent clicks: no vote is lost', async () => {
      const p = await openPoll();
      const users = Array.from({ length: 20 }, (_, i) => `U${i}`);
      await Promise.all(users.map((u, i) => vote(p.id, u, i % 3, `400.${i}`, p.messageTs)));
      expect(Object.keys(store.get(p.id)?.votes ?? {})).toHaveLength(20);
    });
  });

  describe('close / cancel', () => {
    it('owner close: freezes votes, card becomes roster, notice with mentions posted; votes after close refused', async () => {
      const p = await openPoll();
      await vote(p.id, 'UA', 1, '1', p.messageTs);
      const res = await service.close({ pollId: p.id, actorId: 'UCREATOR', channel: 'C1', messageTs: p.messageTs });
      expect(res).toBe('closed');
      const stored = store.get(p.id);
      expect(stored?.status).toBe('closed');
      expect(stored?.delivery?.cardDone).toBe(true);
      expect(stored?.delivery?.noticeDone).toBe(true);
      const cardUpdate = slack.updateMessage.mock.calls.at(-1);
      expect(JSON.stringify(cardUpdate?.[3])).toContain('<@UA>');
      const notice = slack.postMessage.mock.calls.at(-1);
      expect(notice?.[1]).toContain('<@UA>');
      expect(notice?.[2]?.threadTs).toBe('100.1');
      expect((await vote(p.id, 'UB', 0, '2', p.messageTs)).kind).toBe('closed');
    });

    it('non-owner cannot close or cancel', async () => {
      const p = await openPoll();
      expect(await service.close({ pollId: p.id, actorId: 'UOTHER', channel: 'C1', messageTs: p.messageTs })).toBe(
        'forbidden',
      );
      expect(await service.cancel({ pollId: p.id, actorId: 'UOTHER', channel: 'C1', messageTs: p.messageTs })).toBe(
        'forbidden',
      );
      expect(store.get(p.id)?.status).toBe('open');
    });

    it('close is idempotent: scheduler + owner racing renders and notifies once', async () => {
      const p = await openPoll();
      await vote(p.id, 'UA', 0, '1', p.messageTs);
      now = CLOSES;
      const posts = slack.postMessage.mock.calls.length;
      const [a, b] = await Promise.all([
        service.closeDue(),
        service.close({ pollId: p.id, actorId: 'UCREATOR', channel: 'C1', messageTs: p.messageTs }),
      ]);
      expect([a, b]).toBeDefined();
      expect(slack.postMessage.mock.calls.length - posts).toBe(1); // exactly one notice
    });

    it('cancel hides names: canceled card, no notice', async () => {
      const p = await openPoll();
      await vote(p.id, 'UA', 0, '1', p.messageTs);
      const posts = slack.postMessage.mock.calls.length;
      expect(await service.cancel({ pollId: p.id, actorId: 'UCREATOR', channel: 'C1', messageTs: p.messageTs })).toBe(
        'canceled',
      );
      expect(store.get(p.id)?.status).toBe('canceled');
      expect(JSON.stringify(slack.updateMessage.mock.calls.at(-1)?.[3])).not.toContain('UA');
      expect(slack.postMessage.mock.calls.length).toBe(posts);
    });

    it('a stale open-card render queued before close cannot overwrite the result card', async () => {
      const p = await openPoll();
      let release: () => void = () => {};
      slack.updateMessage.mockImplementationOnce(
        () =>
          new Promise<undefined>((r) => {
            release = () => r(undefined);
          }),
      );
      const v = vote(p.id, 'UA', 0, '1', p.messageTs); // its card update hangs
      const c = service.close({ pollId: p.id, actorId: 'UCREATOR', channel: 'C1', messageTs: p.messageTs });
      await tick();
      release();
      await Promise.all([v, c]);
      const last = slack.updateMessage.mock.calls.at(-1);
      expect(JSON.stringify(last?.[3])).not.toContain('poll_v1_vote_'); // result card (no buttons) is last
    });
  });

  describe('delivery retry (closeDue)', () => {
    it('transient failure keeps delivery pending and retries with backoff until it succeeds', async () => {
      const p = await openPoll();
      now = CLOSES;
      slack.updateMessage.mockRejectedValueOnce(transientError());
      await service.closeDue();
      let stored = store.get(p.id);
      expect(stored?.status).toBe('closed');
      expect(stored?.delivery?.cardDone).toBe(false);
      expect(stored?.delivery?.permanentError).toBeUndefined();
      // before backoff elapses: no retry
      const calls = slack.updateMessage.mock.calls.length;
      await service.closeDue();
      expect(slack.updateMessage.mock.calls.length).toBe(calls);
      now += 2 * 60_000;
      await service.closeDue();
      stored = store.get(p.id);
      expect(stored?.delivery?.cardDone).toBe(true);
      expect(stored?.delivery?.noticeDone).toBe(true);
    });

    it('card deleted (permanent) does not block the roster notice; card is not retried', async () => {
      const p = await openPoll();
      await vote(p.id, 'UA', 0, '1', p.messageTs);
      now = CLOSES;
      slack.updateMessage.mockRejectedValue(platformError('message_not_found'));
      await service.closeDue();
      const stored = store.get(p.id);
      expect(stored?.delivery?.cardError).toBe('message_not_found');
      expect(stored?.delivery?.noticeDone).toBe(true);
      expect(slack.postMessage.mock.calls.at(-1)?.[1]).toContain('<@UA>');
      const calls = slack.updateMessage.mock.calls.length;
      now += 60 * 60_000;
      await service.closeDue();
      expect(slack.updateMessage.mock.calls.length).toBe(calls);
    });

    it('a failed second notice part resumes without reposting the first part', async () => {
      const options = ['a', 'b'];
      const p = await openPoll({ options });
      // enough voters to force 2 notice parts (each mention 14 chars incl. space, notice cap 39k)
      store.update(p.id, (rec) => {
        for (let i = 0; i < 3000; i++) rec.votes[`U${String(i).padStart(9, '0')}`] = i % 2;
      });
      now = CLOSES;
      const before = slack.postMessage.mock.calls.length;
      slack.postMessage.mockImplementationOnce(async () => ({ ts: 'n1' })).mockRejectedValueOnce(transientError());
      await service.closeDue();
      let d = store.get(p.id)?.delivery;
      expect(d?.noticesDone).toBe(1);
      expect(d?.noticeDone).toBe(false);
      now += 2 * 60_000;
      await service.closeDue();
      d = store.get(p.id)?.delivery;
      expect(d?.noticeDone).toBe(true);
      const noticeCalls = slack.postMessage.mock.calls.slice(before).map((c) => c[1] as string);
      // part 1 posted once, part 2 attempted twice (fail + success)
      expect(noticeCalls.filter((t) => t === noticeCalls[0])).toHaveLength(1);
      expect(noticeCalls).toHaveLength(3);
    });

    it('unknown-outcome notice part is looked up (bot-authored marker) before reposting', async () => {
      const p = await openPoll();
      await vote(p.id, 'UA', 0, '1', p.messageTs);
      now = CLOSES;
      const lost: any = new Error('socket hang up');
      lost.code = 'ECONNRESET';
      slack.postMessage.mockRejectedValueOnce(lost);
      await service.closeDue();
      expect(store.get(p.id)?.delivery?.noticeUnknownPart).toBe(0);
      slack.threadHasBotMessage.mockResolvedValueOnce(true);
      const posts = slack.postMessage.mock.calls.length;
      now += 2 * 60_000;
      await service.closeDue();
      const [, , oldestSec, marker] = slack.threadHasBotMessage.mock.calls.at(-1) as any[];
      expect(Number(oldestSec)).toBeLessThanOrEqual(Math.floor(CLOSES / 1000));
      expect(marker).toBe(`ref ${p.id} 1/1`);
      expect(slack.postMessage.mock.calls.length).toBe(posts); // not reposted
      expect(store.get(p.id)?.delivery?.noticeDone).toBe(true);
    });

    it('marker scan says the thread is gone → notices stop with noticeError', async () => {
      const p = await openPoll();
      now = CLOSES;
      const lost: any = new Error('socket hang up');
      slack.postMessage.mockRejectedValueOnce(lost);
      await service.closeDue();
      slack.threadHasBotMessage.mockRejectedValueOnce(platformError('thread_not_found'));
      now += 2 * 60_000;
      await service.closeDue();
      expect(store.get(p.id)?.delivery?.noticeError).toBe('thread_not_found');
    });

    it('gives up 24h after close with a persisted expiredAt, and resumes on restart (resumeExpiredDeliveries)', async () => {
      const p = await openPoll();
      now = CLOSES;
      slack.updateMessage.mockRejectedValue(transientError());
      await service.closeDue();
      now = CLOSES + 25 * 3600_000;
      await service.closeDue();
      expect(store.get(p.id)?.delivery?.expiredAt).toBe(now);
      const calls = slack.updateMessage.mock.calls.length;
      now += 3600_000;
      await service.closeDue();
      expect(slack.updateMessage.mock.calls.length).toBe(calls); // stays stopped
      slack.updateMessage.mockImplementation(async () => undefined);
      expect(service.resumeExpiredDeliveries()).toBe(1);
      await service.closeDue();
      expect(store.get(p.id)?.delivery?.cardDone).toBe(true);
      expect(store.get(p.id)?.delivery?.expiredAt).toBeUndefined();
    });

    it('survives a restart: a fresh service over the same store closes overdue polls', async () => {
      const p = await openPoll();
      const fresh = new PollService({
        store: (() => {
          const s = new PollStore(path.join(dir, 'polls.json'));
          s.load();
          return s;
        })(),
        slack: slack as unknown as PollSlackApi,
        now: () => CLOSES + 1000,
        newId: () => 'unused',
      });
      await fresh.closeDue();
      const s2 = new PollStore(path.join(dir, 'polls.json'));
      s2.load();
      expect(s2.get(p.id)?.status).toBe('closed');
    });
  });
});

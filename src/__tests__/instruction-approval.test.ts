/**
 * #767 — "다른 사람의 작업 스레드에 남이 지시를 내릴시에 해당 유저에게 dm과 대시보드
 * 승인 요청 일반적인 권한 요청 해서 처리해줘. 승인 / 이세션에서 항상 승인 / 해당
 * 사람의 지시 항상 승인 / 거절".
 *
 * The one place an instruction from someone who is not the session's owner is
 * held, asked about and answered:
 *  T1 — who runs without asking (the owner, a session approval, a trusted
 *       person, a released one-time approval) and who is held;
 *  T2 — a hold asks the owner once by DM and tells the thread once; more words
 *       from the same person join the same request;
 *  T3 — the four answers, exactly once, owner only, persisted before any side
 *       effect; a release carries the request id the gate re-checks;
 *  T4 — "항상 승인" saves the person to the owner's trusted list.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type HeldInstruction,
  type InstructionApprovalDeps,
  type InstructionApprovalRequest,
  InstructionApprovals,
} from '../instruction-approval';

const OWNER = 'U_OWNER';
const OTHER = 'U_OTHER';
const KEY = 'work:C1:100.000';

function session(extra: Record<string, unknown> = {}): any {
  return { ownerId: OWNER, ownerName: 'Owner', channelId: 'C1', threadTs: '100.000', title: '배포 작업', ...extra };
}

function message(ts: string, text: string, user = OTHER): HeldInstruction {
  return {
    kind: 'message',
    ts,
    text,
    at: 1,
    event: { user, channel: 'C1', thread_ts: '100.000', ts, text },
  };
}

describe('InstructionApprovals (#767)', () => {
  let dir: string;
  let storeFile: string;
  let sessions: Map<string, any>;
  let trusted: Map<string, Set<string>>;
  let now: number;
  let dms: Array<{ ownerId: string; text: string; blocks: any[] }>;
  let dmUpdates: Array<{ ref: { channel: string; ts: string }; text: string; blocks?: any[] }>;
  let notices: Array<{ channel: string; threadTs: string; text: string }>;
  let released: Array<{ requestId: string; held: HeldInstruction }>;
  let saveSessions: ReturnType<typeof vi.fn<() => void>>;
  let broadcast: ReturnType<typeof vi.fn<() => void>>;

  function deps(over: Partial<InstructionApprovalDeps> = {}): InstructionApprovalDeps {
    return {
      storeFile,
      now: () => now,
      getSession: (key) => sessions.get(key),
      saveSessions: () => saveSessions(),
      isTrusted: (ownerId, userId) => trusted.get(ownerId)?.has(userId) === true,
      trust: (ownerId, entry) => {
        const set = trusted.get(ownerId) ?? new Set<string>();
        set.add(entry.userId);
        trusted.set(ownerId, set);
      },
      postOwnerDm: async (ownerId, msg) => {
        dms.push({ ownerId, text: msg.text, blocks: msg.blocks ?? [] });
        return { channel: 'D_OWNER', ts: `dm.${dms.length}` };
      },
      updateDm: async (ref, msg) => {
        dmUpdates.push({ ref, text: msg.text, blocks: msg.blocks });
      },
      postThreadNotice: async (target, text) => {
        notices.push({ ...target, text });
      },
      release: async (request, held) => {
        released.push({ requestId: request.requestId, held });
      },
      broadcast: () => broadcast(),
      ...over,
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-approval-'));
    storeFile = path.join(dir, 'instruction-approvals.json');
    sessions = new Map([[KEY, session()]]);
    trusted = new Map();
    now = 1_000_000;
    dms = [];
    dmUpdates = [];
    notices = [];
    released = [];
    saveSessions = vi.fn<() => void>();
    broadcast = vi.fn<() => void>();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function holdOne(approvals: InstructionApprovals, ts = '101.000', text = '배포해줘') {
    return approvals.hold({
      sessionKey: KEY,
      session: sessions.get(KEY),
      senderId: OTHER,
      senderName: 'Other',
      instruction: message(ts, text),
    });
  }

  describe('T1 — who runs without asking', () => {
    it("the owner's own words and a missing sender run; anyone else is held", () => {
      const approvals = new InstructionApprovals(deps());
      const s = sessions.get(KEY);
      expect(approvals.allows({ sessionKey: KEY, session: s, senderId: OWNER })).toBe(true);
      expect(approvals.allows({ sessionKey: KEY, session: s, senderId: OTHER })).toBe(false);
      // A session with no owner on record has nobody to ask.
      expect(approvals.allows({ sessionKey: KEY, session: session({ ownerId: '' }), senderId: OTHER })).toBe(true);
    });

    it('a person approved for this session runs in this session only', () => {
      const approvals = new InstructionApprovals(deps());
      const approved = session({ approvedInstructors: [OTHER] });
      expect(approvals.allows({ sessionKey: KEY, session: approved, senderId: OTHER })).toBe(true);
      expect(approvals.allows({ sessionKey: 'work:C1:200.000', session: session(), senderId: OTHER })).toBe(false);
    });

    it("a person on the owner's trusted list runs in every session of that owner", () => {
      trusted.set(OWNER, new Set([OTHER]));
      const approvals = new InstructionApprovals(deps());
      expect(approvals.allows({ sessionKey: KEY, session: session(), senderId: OTHER })).toBe(true);
      expect(approvals.allows({ sessionKey: KEY, session: session({ ownerId: 'U_SOMEONE' }), senderId: OTHER })).toBe(
        false,
      );
    });

    it('a one-time approval releases exactly the instructions it held — a forged or foreign id does not', async () => {
      const approvals = new InstructionApprovals(deps());
      const { requestId } = await holdOne(approvals);
      const s = sessions.get(KEY);
      // Not yet answered: the id releases nothing.
      expect(
        approvals.allows({ sessionKey: KEY, session: s, senderId: OTHER, approvalId: requestId, ts: '101.000' }),
      ).toBe(false);
      const answer = approvals.answer({ requestId, decision: 'approve', actor: OWNER, surface: 'slack' });
      expect(answer.ok).toBe(true);
      expect(
        approvals.allows({ sessionKey: KEY, session: s, senderId: OTHER, approvalId: requestId, ts: '101.000' }),
      ).toBe(true);
      // Another message, another session, another sender, or a made-up id: still held.
      expect(
        approvals.allows({ sessionKey: KEY, session: s, senderId: OTHER, approvalId: requestId, ts: '102.000' }),
      ).toBe(false);
      expect(
        approvals.allows({
          sessionKey: 'work:C9:1.0',
          session: s,
          senderId: OTHER,
          approvalId: requestId,
          ts: '101.000',
        }),
      ).toBe(false);
      expect(
        approvals.allows({ sessionKey: KEY, session: s, senderId: 'U_THIRD', approvalId: requestId, ts: '101.000' }),
      ).toBe(false);
      expect(
        approvals.allows({ sessionKey: KEY, session: s, senderId: OTHER, approvalId: 'iap_forged', ts: '101.000' }),
      ).toBe(false);
    });
  });

  describe('T2 — a hold asks the owner once', () => {
    it('DMs the owner with the four answers and tells the thread, once per person and session', async () => {
      const approvals = new InstructionApprovals(deps());
      const first = await holdOne(approvals, '101.000', '배포해줘');
      const second = await holdOne(approvals, '102.000', '테스트도 돌려줘');
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.requestId).toBe(first.requestId);

      expect(dms).toHaveLength(1);
      expect(dms[0].ownerId).toBe(OWNER);
      const actions = dms[0].blocks.find((b) => b.type === 'actions');
      expect(actions.elements.map((e: any) => JSON.parse(e.value).decision)).toEqual([
        'approve',
        'approve_session',
        'approve_always',
        'deny',
      ]);
      expect(JSON.stringify(dms[0].blocks)).toContain('배포해줘');
      // The second message is added to the same DM (its text is rewritten), not a second DM.
      expect(dmUpdates[dmUpdates.length - 1]?.ref).toEqual({ channel: 'D_OWNER', ts: 'dm.1' });
      expect(JSON.stringify(dmUpdates[dmUpdates.length - 1]?.blocks)).toContain('테스트도 돌려줘');

      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ channel: 'C1', threadTs: '100.000' });
      expect(notices[0].text).toContain(`<@${OTHER}>`);
      expect(notices[0].text).toContain(`<@${OWNER}>`);
      expect(broadcast).toHaveBeenCalled();
    });

    it('the dashboard reads the pending request of the session — who asked, how many, a short preview', async () => {
      const approvals = new InstructionApprovals(deps());
      await holdOne(approvals, '101.000', 'x'.repeat(2000));
      await holdOne(approvals, '102.000', '두 번째');
      const pending = approvals.pendingFor(KEY);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ ownerId: OWNER, requesterId: OTHER, requesterName: 'Other', count: 2 });
      expect(pending[0].preview.length).toBeLessThanOrEqual(400);
      expect(approvals.pendingFor('work:C1:999.000')).toEqual([]);
    });

    it('a redelivered message is held once', async () => {
      const approvals = new InstructionApprovals(deps());
      await holdOne(approvals, '101.000');
      await holdOne(approvals, '101.000');
      expect(approvals.pendingFor(KEY)[0].count).toBe(1);
    });

    it('an expired request is not answered; the next message asks again', async () => {
      const approvals = new InstructionApprovals(deps({ ttlMs: 1000 }));
      const { requestId } = await holdOne(approvals);
      now += 5000;
      expect(approvals.pendingFor(KEY)).toEqual([]);
      const answer = approvals.answer({ requestId, decision: 'approve', actor: OWNER, surface: 'dashboard' });
      expect(answer).toMatchObject({ ok: false, reason: 'expired' });
      const again = await holdOne(approvals, '103.000');
      expect(again.created).toBe(true);
      expect(again.requestId).not.toBe(requestId);
      expect(released).toEqual([]);
    });
  });

  describe('T3 — the four answers', () => {
    it('승인 — runs every held instruction once, in order, and tells the thread and the DM', async () => {
      const approvals = new InstructionApprovals(deps());
      const { requestId } = await holdOne(approvals, '101.000', 'one');
      await holdOne(approvals, '102.000', 'two');
      const answer = approvals.answer({ requestId, decision: 'approve', actor: OWNER, surface: 'slack' });
      expect(answer.ok).toBe(true);
      if (answer.ok) await answer.done;
      expect(released.map((r) => (r.held as any).ts)).toEqual(['101.000', '102.000']);
      expect(released.every((r) => r.requestId === requestId)).toBe(true);
      // One-time: the person is not remembered anywhere.
      expect(sessions.get(KEY).approvedInstructors).toBeUndefined();
      expect(trusted.get(OWNER)).toBeUndefined();
      expect(notices[notices.length - 1]?.text).toContain('승인');
      expect(dmUpdates[dmUpdates.length - 1]?.ref).toEqual({ channel: 'D_OWNER', ts: 'dm.1' });
      // The rewritten DM offers no buttons any more.
      expect(JSON.stringify(dmUpdates[dmUpdates.length - 1]?.blocks ?? [])).not.toContain('instr_approval_');
      expect(approvals.pendingFor(KEY)).toEqual([]);
    });

    it('이 세션에서 항상 승인 — the person runs in this session from now on, saved with the sessions', async () => {
      const approvals = new InstructionApprovals(deps());
      const { requestId } = await holdOne(approvals);
      const answer = approvals.answer({ requestId, decision: 'approve_session', actor: OWNER, surface: 'dashboard' });
      expect(answer.ok).toBe(true);
      if (answer.ok) await answer.done;
      expect(sessions.get(KEY).approvedInstructors).toEqual([OTHER]);
      expect(saveSessions).toHaveBeenCalled();
      expect(released).toHaveLength(1);
      expect(approvals.allows({ sessionKey: KEY, session: sessions.get(KEY), senderId: OTHER })).toBe(true);
      expect(dmUpdates[dmUpdates.length - 1]?.text).toContain('대시보드');
    });

    it("이 사람의 지시 항상 승인 — the person goes on the owner's trusted list", async () => {
      const approvals = new InstructionApprovals(deps());
      const { requestId } = await holdOne(approvals);
      const answer = approvals.answer({ requestId, decision: 'approve_always', actor: OWNER, surface: 'slack' });
      expect(answer.ok).toBe(true);
      if (answer.ok) await answer.done;
      expect(trusted.get(OWNER)?.has(OTHER)).toBe(true);
      expect(released).toHaveLength(1);
    });

    it('이 사람의 지시 항상 승인 with a full list — runs once, and the DM says the person was not added (trinity R1)', async () => {
      const approvals = new InstructionApprovals(deps({ trust: () => false }));
      const { requestId } = await holdOne(approvals);
      const answer = approvals.answer({ requestId, decision: 'approve_always', actor: OWNER, surface: 'slack' });
      expect(answer.ok).toBe(true);
      if (answer.ok) await answer.done;
      expect(released).toHaveLength(1);
      expect(dmUpdates[dmUpdates.length - 1]?.text).toContain('항상 승인 목록에 넣지 못했습니다');
    });

    it('거절 — nothing runs; the thread is told', async () => {
      const approvals = new InstructionApprovals(deps());
      const { requestId } = await holdOne(approvals);
      const answer = approvals.answer({ requestId, decision: 'deny', actor: OWNER, surface: 'slack' });
      expect(answer.ok).toBe(true);
      if (answer.ok) await answer.done;
      expect(released).toEqual([]);
      expect(notices[notices.length - 1]?.text).toContain('거절');
      expect(
        approvals.allows({
          sessionKey: KEY,
          session: sessions.get(KEY),
          senderId: OTHER,
          approvalId: requestId,
          ts: '101.000',
        }),
      ).toBe(false);
    });

    it('only the owner answers, only once, only a known decision', async () => {
      const approvals = new InstructionApprovals(deps());
      const { requestId } = await holdOne(approvals);
      expect(approvals.answer({ requestId, decision: 'approve', actor: OTHER, surface: 'slack' })).toMatchObject({
        ok: false,
        reason: 'not_owner',
      });
      expect(approvals.answer({ requestId, decision: 'yes' as any, actor: OWNER, surface: 'slack' })).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
      expect(
        approvals.answer({ requestId: 'iap_nope', decision: 'approve', actor: OWNER, surface: 'slack' }),
      ).toMatchObject({
        ok: false,
        reason: 'not_found',
      });
      const first = approvals.answer({ requestId, decision: 'approve', actor: OWNER, surface: 'slack' });
      const second = approvals.answer({ requestId, decision: 'deny', actor: OWNER, surface: 'dashboard' });
      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, reason: 'already_answered' });
      if (first.ok) await first.done;
      expect(released).toHaveLength(1);
    });

    it('an answer that cannot be saved decides nothing', async () => {
      const approvals = new InstructionApprovals(deps());
      const { requestId } = await holdOne(approvals);
      // The store file's directory is replaced by a file: the save throws.
      fs.rmSync(dir, { recursive: true, force: true });
      fs.writeFileSync(dir, 'not a directory');
      try {
        const answer = approvals.answer({ requestId, decision: 'approve', actor: OWNER, surface: 'slack' });
        expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
        expect(released).toEqual([]);
        expect(approvals.pendingFor(KEY)).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { force: true });
        fs.mkdirSync(dir);
      }
    });

    it('a request survives a restart and is answered from the store', async () => {
      const first = new InstructionApprovals(deps());
      const { requestId } = await holdOne(first);
      const restarted = new InstructionApprovals(deps());
      expect(restarted.pendingFor(KEY)).toHaveLength(1);
      const answer = restarted.answer({ requestId, decision: 'approve', actor: OWNER, surface: 'slack' });
      expect(answer.ok).toBe(true);
      if (answer.ok) await answer.done;
      expect(released.map((r) => (r.held as any).text)).toEqual(['배포해줘']);
      const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      const record: InstructionApprovalRequest = stored.requests[requestId];
      expect(record).toMatchObject({ status: 'approved', decision: 'approve', decidedBy: OWNER, decidedVia: 'slack' });
    });

    it('a session that is gone takes no approval — the request ends and nothing runs', async () => {
      const approvals = new InstructionApprovals(deps());
      const { requestId } = await holdOne(approvals);
      sessions.delete(KEY);
      expect(approvals.answer({ requestId, decision: 'approve', actor: OWNER, surface: 'slack' })).toMatchObject({
        ok: false,
        reason: 'session_gone',
      });
      expect(released).toEqual([]);
    });
  });
});

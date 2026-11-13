import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const admins = vi.hoisted(() => ({ set: new Set(['UADMIN']) }));
vi.mock('../admin-utils', () => ({
  getAdminUsers: () => admins.set,
  isAdminUser: (u: string) => admins.set.has(u),
}));
vi.mock('../env-users', () => ({ isEnvironmentUser: (u: string) => u === 'env:acme-dev2' }));

import { type HeldInstruction, InstructionApprovals } from '../instruction-approval';

const KEY = 'work:C1:100.000';
const ENV = 'env:acme-dev2';

describe('InstructionApprovals — environment user session', () => {
  let dir: string;
  let dms: string[];
  let updated: string[];
  const session = { ownerId: ENV, ownerName: 'acme-dev2', channelId: 'C1', threadTs: '100.000', title: 'deploy' };
  const message = (user: string): HeldInstruction => ({
    kind: 'message',
    ts: '101.000',
    text: '계속해',
    at: 1,
    event: { user, channel: 'C1', thread_ts: '100.000', ts: '101.000', text: '계속해' },
  });

  function approvals(): InstructionApprovals {
    return new InstructionApprovals({
      storeFile: path.join(dir, 'instruction-approvals.json'),
      now: () => 1_000_000,
      getSession: () => session as any,
      saveSessions: () => undefined,
      isTrusted: () => false,
      trust: () => undefined,
      postOwnerDm: async (ownerId: string) => {
        if (ownerId === 'UBROKEN') throw new Error('cannot_dm');
        dms.push(ownerId);
        return { channel: `D_${ownerId}`, ts: '1' };
      },
      updateDm: async (ref: { channel: string }) => {
        updated.push(ref.channel);
      },
      postThreadNotice: async () => undefined,
      release: async () => undefined,
      broadcast: () => undefined,
    } as any);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-env-'));
    dms = [];
    updated = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('an admin speaks in the environment session without asking; anyone else is held', () => {
    const a = approvals();
    expect(a.allows({ sessionKey: KEY, session: session as any, senderId: 'UADMIN' })).toBe(true);
    expect(a.allows({ sessionKey: KEY, session: session as any, senderId: 'U_REQ' })).toBe(false);
  });

  it("someone else's words are asked of the admins, and an admin decides", async () => {
    const a = approvals();
    const held = await a.hold({
      sessionKey: KEY,
      session: session as any,
      senderId: 'U_REQ',
      senderName: 'Req',
      instruction: message('U_REQ'),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(dms).toEqual(['UADMIN']);
    const requestId = (held as { requestId: string }).requestId;
    expect(a.answer({ requestId, decision: 'approve', actor: 'U_REQ', surface: 'slack' }).ok).toBe(false);
    expect(a.answer({ requestId, decision: 'approve', actor: 'UADMIN', surface: 'slack' }).ok).toBe(true);
  });

  it('one admin DM that fails does not stop the others', async () => {
    admins.set = new Set(['UBROKEN', 'UADMIN']);
    try {
      const a = approvals();
      await a.hold({
        sessionKey: KEY,
        session: session as any,
        senderId: 'U_REQ',
        senderName: 'Req',
        instruction: message('U_REQ'),
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(dms).toEqual(['UADMIN']);
    } finally {
      admins.set = new Set(['UADMIN']);
    }
  });

  it("every admin's DM is rewritten once the request is answered", async () => {
    admins.set = new Set(['UADMIN', 'UADMIN2']);
    try {
      const a = approvals();
      const held = await a.hold({
        sessionKey: KEY,
        session: session as any,
        senderId: 'U_REQ',
        senderName: 'Req',
        instruction: message('U_REQ'),
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(dms).toEqual(['UADMIN', 'UADMIN2']);
      const requestId = (held as { requestId: string }).requestId;
      expect(a.answer({ requestId, decision: 'deny', actor: 'UADMIN', surface: 'slack' }).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 10));
      expect(updated.sort()).toEqual(['D_UADMIN', 'D_UADMIN2']);
    } finally {
      admins.set = new Set(['UADMIN']);
    }
  });
});

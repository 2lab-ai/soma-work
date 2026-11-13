import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../admin-utils', () => ({
  getAdminUsers: () => new Set(['UADMIN']),
  isAdminUser: (u: string) => u === 'UADMIN',
}));
vi.mock('../env-users', () => ({ isEnvironmentUser: (u: string) => u === 'env:acme-dev2' }));

import { type HeldInstruction, InstructionApprovals } from '../instruction-approval';

const KEY = 'work:C1:100.000';
const ENV = 'env:acme-dev2';

describe('InstructionApprovals — environment user session', () => {
  let dir: string;
  let dms: string[];
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
        dms.push(ownerId);
        return { channel: `D_${ownerId}`, ts: '1' };
      },
      updateDm: async () => undefined,
      postThreadNotice: async () => undefined,
      release: async () => undefined,
      broadcast: () => undefined,
    } as any);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-env-'));
    dms = [];
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
});

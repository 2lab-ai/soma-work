/**
 * #622/#623 — the admin request store: one round per key, answered exactly
 * once, every DM copy kept on record, a damaged file never forgets answers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAdminRequest,
  markAdminRequest,
  openAdminRequest,
  reopenAdminRequest,
  setAdminRequestPrompts,
  settleAdminRequest,
} from '../admin-request-store';
import { DATA_DIR } from '../env-paths';

const FILE = path.join(DATA_DIR, 'admin-requests.json');
const TTL = 60_000;

function answer(by: string, at = Date.now()) {
  return { by, choiceId: 'approve', outcome: 'approved' as const, via: 'slack' as const, at };
}

describe('admin request store (#622, #623)', () => {
  beforeEach(() => {
    fs.rmSync(FILE, { force: true });
    fs.rmSync(`${FILE}.bak`, { force: true });
  });

  it('asking again while the round is open keeps it: the first DM copies stay on record', () => {
    openAdminRequest({ kind: 'bot_delete', requestId: 'C1/1.1', requesterId: 'U1', ttlMs: TTL });
    setAdminRequestPrompts('bot_delete', 'C1/1.1', [{ channel: 'D1', ts: '1' }]);
    openAdminRequest({ kind: 'bot_delete', requestId: 'C1/1.1', requesterId: 'U1', ttlMs: TTL });
    setAdminRequestPrompts('bot_delete', 'C1/1.1', [{ channel: 'D2', ts: '2' }]);
    expect(getAdminRequest('bot_delete', 'C1/1.1')?.prompts).toEqual([
      { channel: 'D1', ts: '1' },
      { channel: 'D2', ts: '2' },
    ]);
  });

  it('an answered round is replaced by a fresh one on a new ask', () => {
    openAdminRequest({ kind: 'new_user', requestId: 'U9', requesterId: 'U9', ttlMs: TTL });
    expect(markAdminRequest('new_user', 'U9', answer('UADMIN'))).not.toBeNull();
    const fresh = openAdminRequest({ kind: 'new_user', requestId: 'U9', requesterId: 'U9', ttlMs: TTL });
    expect(fresh).toMatchObject({ handled: false, prompts: [] });
    expect(fresh.resolution).toBeUndefined();
  });

  it('reopen undoes only its own answer — never a later round or a later answer', () => {
    openAdminRequest({ kind: 'bot_delete', requestId: 'C1/2.2', requesterId: 'U1', ttlMs: TTL });
    const a = answer('UADMIN1', 1_000_000_000_000);
    expect(markAdminRequest('bot_delete', 'C1/2.2', { ...a, at: Date.now() })).not.toBeNull();
    // A's delete is still in flight; the answer on record is not A's: A's reopen leaves it.
    expect(reopenAdminRequest('bot_delete', 'C1/2.2', a)).toBe(false);
    expect(getAdminRequest('bot_delete', 'C1/2.2')?.handled).toBe(true);
    const b = answer('UADMIN2');
    openAdminRequest({ kind: 'bot_delete', requestId: 'C1/3.3', requesterId: 'U1', ttlMs: TTL });
    markAdminRequest('bot_delete', 'C1/3.3', b);
    expect(reopenAdminRequest('bot_delete', 'C1/3.3', b)).toBe(true);
    expect(getAdminRequest('bot_delete', 'C1/3.3')?.handled).toBe(false);
  });

  it('a claim whose side effect never settled (the process died) lapses: the request is answerable again', () => {
    openAdminRequest({ kind: 'bot_delete', requestId: 'C1/7.7', requesterId: 'U1', ttlMs: TTL });
    const claim = { ...answer('UADMIN1', Date.now() - 10 * 60 * 1000), settled: false };
    expect(markAdminRequest('bot_delete', 'C1/7.7', claim)).not.toBeNull();
    expect(getAdminRequest('bot_delete', 'C1/7.7')?.handled).toBe(false);
    expect(markAdminRequest('bot_delete', 'C1/7.7', answer('UADMIN2'))).not.toBeNull();
  });

  it('a fresh claim holds; settling makes it the decision (only the answer on record settles)', () => {
    openAdminRequest({ kind: 'bot_delete', requestId: 'C1/8.8', requesterId: 'U1', ttlMs: TTL });
    const claim = { ...answer('UADMIN1'), settled: false };
    markAdminRequest('bot_delete', 'C1/8.8', claim);
    expect(markAdminRequest('bot_delete', 'C1/8.8', answer('UADMIN2'))).toBeNull();
    expect(settleAdminRequest('bot_delete', 'C1/8.8', { ...claim, by: 'UOTHER' })).toBeNull();
    expect(settleAdminRequest('bot_delete', 'C1/8.8', claim)?.resolution?.settled).toBeUndefined();
  });

  it('a damaged live file falls back to the backup: answered stays answered', () => {
    openAdminRequest({ kind: 'bot_delete', requestId: 'C1/4.4', requesterId: 'U1', ttlMs: TTL });
    markAdminRequest('bot_delete', 'C1/4.4', answer('UADMIN1'));
    // One more write so the backup holds the answered generation.
    openAdminRequest({ kind: 'bot_delete', requestId: 'C1/5.5', requesterId: 'U1', ttlMs: TTL });
    fs.writeFileSync(FILE, '{ broken');
    expect(getAdminRequest('bot_delete', 'C1/4.4')?.handled).toBe(true);
    expect(markAdminRequest('bot_delete', 'C1/4.4', answer('UADMIN2'))).toBeNull();
  });

  it('live and backup both unusable: refuses (throws) rather than forgetting every answer', () => {
    fs.writeFileSync(FILE, '{ broken');
    fs.writeFileSync(`${FILE}.bak`, 'also broken');
    expect(() => getAdminRequest('bot_delete', 'C1/6.6')).toThrow();
  });
});

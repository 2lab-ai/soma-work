/**
 * #829 T1/T5 — the card's follow-up marker on the session.
 *
 * - `setExecutiveSummary` (UPDATE_SESSION from the model-run es) puts the TL;DR on the card and derives the
 *   follow-up from its ⚠️ line; a TL;DR without one clears it.
 * - The marker survives a restart (the card must not drop to DONE after a deploy) and junk is dropped on load.
 * - `/new` (resetSessionContext) clears it: a fresh conversation is decided by its own next summary.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/soma-work-session-follow-up-test';

vi.mock(import('../env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DATA_DIR: '/tmp/soma-work-session-follow-up-test' };
});

import { SessionRegistry } from '../session-registry';

function wipe(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

beforeEach(() => {
  wipe();
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(wipe);

const BLOCKED = ['PR #12 opened.', '⚠️ **PR #12 not merged — needs a maintainer approval.**', 'Next: merge #12.'];

describe('setExecutiveSummary — the TL;DR and the follow-up on the card', () => {
  it('writes the TL;DR and derives the follow-up from its ⚠️ line', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.001');
    expect(reg.setExecutiveSummary('C1', '171.001', BLOCKED)).toBe(true);
    expect(s.executiveSummary?.tldr).toEqual(BLOCKED);
    expect(s.followUp?.reason).toBe('PR #12 not merged — needs a maintainer approval.');
    expect(s.followUp?.at).toBe(s.executiveSummary?.at);
    // the model-run es checked with tools: its card (TL;DR + verdict) is marked so the same turn's host summary
    // keeps the pair
    expect(s.executiveSummary?.source).toBe('es');
  });

  it('a list marker before the ⚠️ line still counts', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.001');
    reg.setExecutiveSummary('C1', '171.001', ['done', '- ⚠️ **PR #3 is a draft**', 'next']);
    expect(s.executiveSummary?.tldr[1]).toBe('⚠️ **PR #3 is a draft**');
    expect(s.followUp?.reason).toBe('PR #3 is a draft');
  });

  it('a TL;DR without a ⚠️ line clears a previous follow-up', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.001');
    reg.setExecutiveSummary('C1', '171.001', BLOCKED);
    reg.setExecutiveSummary('C1', '171.001', ['PR #12 merged.', 'CI green.', 'Next: deploy.']);
    expect(s.followUp).toBeUndefined();
    expect(s.executiveSummary?.tldr[0]).toBe('PR #12 merged.');
  });

  it('no session: false, nothing written', () => {
    expect(new SessionRegistry().setExecutiveSummary('C9', '9.9', BLOCKED)).toBe(false);
  });

  it('no usable line: false, the card keeps what it had', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.001');
    reg.setExecutiveSummary('C1', '171.001', BLOCKED);
    expect(reg.setExecutiveSummary('C1', '171.001', ['  ', ''])).toBe(false);
    expect(s.followUp?.reason).toContain('PR #12');
  });
});

describe('a Slack-less dashboard task (no channel, no thread) — by session key', () => {
  it('setExecutiveSummaryByKey writes the TL;DR and the follow-up on the task', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' });
    const key = `task:${task.taskId}`;
    expect(reg.getSessionByKey(key)).toBe(task);
    expect(reg.setExecutiveSummaryByKey(key, BLOCKED)).toBe(true);
    expect(task.executiveSummary?.tldr).toEqual(BLOCKED);
    expect(task.followUp?.reason).toContain('PR #12');
  });

  it('an unknown key: false, never a throw', () => {
    expect(new SessionRegistry().setExecutiveSummaryByKey('task:nope', BLOCKED)).toBe(false);
  });

  it('fillPlaceholderSessionTitleByKey fills a task with no title and leaves a deliberate one', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' });
    const key = `task:${task.taskId}`;
    task.title = 'New Session';
    expect(reg.fillPlaceholderSessionTitleByKey(key, 'Login fix')).toBe(true);
    expect(task.title).toBe('Login fix');
    expect(reg.fillPlaceholderSessionTitleByKey(key, 'Other')).toBe(false);
    expect(task.title).toBe('Login fix');
  });
});

describe('the follow-up survives a restart', () => {
  function restoreWith(followUp: unknown) {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.001');
    session.sessionId = 'sess-1';
    (session as any).followUp = followUp;
    writer.saveSessions();
    const reader = new SessionRegistry();
    reader.loadSessions();
    return reader.getSession('C1', '171.001');
  }

  it('the es mark rides on the card TL;DR across a restart; the follow-up itself carries only reason and time', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.002');
    session.sessionId = 'sess-2';
    writer.setExecutiveSummary('C1', '171.002', BLOCKED);
    const reader = new SessionRegistry();
    reader.loadSessions();
    const back = reader.getSession('C1', '171.002');
    expect(back?.executiveSummary?.source).toBe('es');
    expect(back?.followUp).toEqual({
      reason: 'PR #12 not merged — needs a maintainer approval.',
      at: back?.executiveSummary?.at,
    });
    expect(restoreWith({ reason: 'r', at: 5, source: 'es' })?.followUp).toEqual({ reason: 'r', at: 5 });
  });

  it('round-trips the reason and its time', () => {
    expect(restoreWith({ reason: 'PR #12 not merged', at: 1_793_600_000_000 })?.followUp).toEqual({
      reason: 'PR #12 not merged',
      at: 1_793_600_000_000,
    });
  });

  it('none stored, or junk: none restored', () => {
    expect(restoreWith(undefined)?.followUp).toBeUndefined();
    expect(restoreWith({ reason: '  ', at: 1 })?.followUp).toBeUndefined();
    expect(restoreWith({ reason: 'x' })?.followUp).toBeUndefined();
    expect(restoreWith('x')?.followUp).toBeUndefined();
  });
});

describe('/new clears it', () => {
  it('resetSessionContext drops the follow-up', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.001');
    s.sessionId = 'sess-1';
    reg.setExecutiveSummary('C1', '171.001', BLOCKED);
    expect(reg.resetSessionContext('C1', '171.001')).toBe(true);
    expect(s.followUp).toBeUndefined();
    expect(s.executiveSummary).toBeUndefined();
  });
});

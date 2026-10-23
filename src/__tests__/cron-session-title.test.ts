/**
 * T1/T2 (SSOT 2026-10-23) — a cron session starts under its job name and
 * swaps to the real name once the work makes one clear.
 *
 *   - the job-name title is PROVISIONAL: the first turn-summary title or a
 *     link-derived title replaces it (a deliberate title is still never
 *     overwritten by those writers);
 *   - an explicit title update (UPDATE_SESSION, PR merge, issue link) clears
 *     the provisional mark;
 *   - the cron origin and the mark survive a restart.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-cron-session-title-test',
}));

import { SessionRegistry } from '../session-registry';
import { canApplySummaryTitle } from '../session-title-policy';

const TEST_DATA_DIR = '/tmp/soma-work-cron-session-title-test';

describe('provisional (cron job-name) titles', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('setSessionTitle replaces a provisional title and clears the mark', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Z', 'C1', '100.001');
    session.title = 'nightly-qa';
    session.titleProvisional = true;

    registry.setSessionTitle('C1', '100.001', 'QA pass: orders API');

    expect(session.title).toBe('QA pass: orders API');
    expect(session.titleProvisional).toBeFalsy();
  });

  it('setSessionTitle still never overwrites a deliberate title', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Z', 'C1', '100.002');
    session.title = 'Human chosen';

    registry.setSessionTitle('C1', '100.002', 'Other');

    expect(session.title).toBe('Human chosen');
  });

  it('updateSessionTitle clears the provisional mark', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Z', 'C1', '100.003');
    session.title = 'nightly-qa';
    session.titleProvisional = true;

    registry.updateSessionTitle('C1', '100.003', 'Explicit');

    expect(session.title).toBe('Explicit');
    expect(session.titleProvisional).toBeFalsy();
  });

  it('persists the cron origin and the provisional mark across save/load', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Z', 'C1', '100.004');
    session.sessionId = 'sess-4';
    session.state = 'MAIN';
    session.title = 'nightly-qa';
    session.titleProvisional = true;
    session.cronJob = { id: 'job-1', name: 'nightly-qa' };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', '100.004');

    expect(restored?.cronJob).toEqual({ id: 'job-1', name: 'nightly-qa' });
    expect(restored?.titleProvisional).toBe(true);
  });
});

describe('canApplySummaryTitle — the turn-summary title writer (src/index.ts)', () => {
  it('applies to an empty title or one equal to the conversation id (unchanged behaviour)', () => {
    expect(canApplySummaryTitle({})).toBe(true);
    expect(canApplySummaryTitle({ title: 'conv-1', conversationId: 'conv-1' })).toBe(true);
  });
  it('applies to a provisional cron job-name title', () => {
    expect(canApplySummaryTitle({ title: 'nightly-qa', titleProvisional: true, conversationId: 'c' })).toBe(true);
  });
  it('refuses a deliberate title', () => {
    expect(canApplySummaryTitle({ title: 'Direct (skipDispatch)', conversationId: 'c' })).toBe(false);
    expect(canApplySummaryTitle({ title: 'Human chosen', titleProvisional: false, conversationId: 'c' })).toBe(false);
  });
});

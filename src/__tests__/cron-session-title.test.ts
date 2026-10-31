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

import { getArchiveStore } from '../session-archive';
import { SessionRegistry } from '../session-registry';
import { applySummaryTitle, canApplySummaryTitle } from '../session-title-policy';

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

  // trinity round 5 (fable P3): a cron session that expires while the process
  // is down is archived during load — it must stay filed under its job.
  it('a cron session archived during load keeps its job', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Z', 'C1', '100.005');
    session.sessionId = 'sess-5';
    session.state = 'MAIN';
    session.title = 'QA pass: orders API';
    session.cronJob = { id: 'job-1', name: 'nightly-qa' };
    writer.saveSessions();

    // Asleep since an unknown time: past the archive limit, so load archives it.
    const file = `${TEST_DATA_DIR}/sessions.json`;
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const s of saved) {
      s.state = 'SLEEPING';
      delete s.sleepStartedAt;
    }
    fs.writeFileSync(file, JSON.stringify(saved));

    new SessionRegistry().loadSessions();

    const archived = getArchiveStore()
      .listRecent(24 * 60 * 60 * 1000)
      .find((a) => a.sessionId === 'sess-5');
    expect(archived?.archiveReason).toBe('sleep_expired');
    expect(archived?.cronJob).toEqual({ id: 'job-1', name: 'nightly-qa' });
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

describe('applySummaryTitle — by registry key, so a Slack-less task works too (#615 R1)', () => {
  function registryWith(entries: Array<[string, Record<string, unknown>]>) {
    const sessions = new Map(entries);
    return {
      getAllSessions: () => sessions,
      updateSessionTitleByKey: vi.fn((key: string, title: string) => {
        const s = sessions.get(key);
        if (s) s.title = title;
      }),
    };
  }

  it('a task: written by its task key, no Slack thread render', () => {
    const task = { conversationId: 'conv-t', slackless: true, channelId: '' };
    const registry = registryWith([['task:abc', task]]);
    const hooks = { renderThread: vi.fn(), scheduleLiveUpdate: vi.fn() };
    const out = applySummaryTitle(registry, 'conv-t', 'Summarized', hooks);
    expect(out).toMatchObject({ outcome: 'applied', sessionKey: 'task:abc' });
    expect(registry.updateSessionTitleByKey).toHaveBeenCalledWith('task:abc', 'Summarized');
    expect(hooks.renderThread).not.toHaveBeenCalled();
    expect(hooks.scheduleLiveUpdate).toHaveBeenCalledWith('task:abc');
  });

  it('a Slack session: written by its key and its thread re-rendered (as before)', () => {
    const slack = { conversationId: 'conv-s', channelId: 'C1', threadTs: '1.1' };
    const registry = registryWith([['work:C1:1.1', slack]]);
    const hooks = { renderThread: vi.fn(), scheduleLiveUpdate: vi.fn() };
    expect(applySummaryTitle(registry, 'conv-s', 'Summarized', hooks).outcome).toBe('applied');
    expect(registry.updateSessionTitleByKey).toHaveBeenCalledWith('work:C1:1.1', 'Summarized');
    expect(hooks.renderThread).toHaveBeenCalledWith(slack);
  });

  it('a deliberate title is kept; an unknown conversation is reported', () => {
    const registry = registryWith([['task:abc', { conversationId: 'conv-t', title: 'Chosen' }]]);
    const hooks = { renderThread: vi.fn(), scheduleLiveUpdate: vi.fn() };
    expect(applySummaryTitle(registry, 'conv-t', 'Summarized', hooks).outcome).toBe('kept');
    expect(applySummaryTitle(registry, 'conv-x', 'Summarized', hooks).outcome).toBe('no-session');
    expect(registry.updateSessionTitleByKey).not.toHaveBeenCalled();
  });
});

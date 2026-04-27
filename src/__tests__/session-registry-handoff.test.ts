import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use $TMPDIR so this test passes inside restrictive sandboxes as well as CI.
// `vi.mock` is hoisted — keep the path computation inside the factory.
vi.mock('../env-paths', () => ({
  DATA_DIR: require('path').join(
    process.env.TMPDIR ?? require('os').tmpdir(),
    'soma-work-session-registry-handoff-test',
  ),
}));

import { SessionRegistry } from '../session-registry';
import type { HandoffContext } from '../types';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-session-registry-handoff-test');

function sampleContext(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    handoffKind: 'plan-to-work',
    sourceIssueUrl: 'https://github.com/owner/repo/issues/42',
    parentEpicUrl: 'https://github.com/owner/repo/issues/10',
    escapeEligible: false,
    tier: 'medium',
    issueRequiredByUser: true,
    chainId: '11111111-1111-1111-1111-111111111111',
    hopBudget: 1,
    ...overrides,
  };
}

describe('SessionRegistry — handoffContext persistence (#695)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it('round-trips handoffContext through save + load when sessionId exists', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.001');
    session.sessionId = 'sess-1';
    session.handoffContext = sampleContext();

    writer.saveSessions();

    const reader = new SessionRegistry();
    const loaded = reader.loadSessions();
    const restored = reader.getSession('C1', '171.001');

    expect(loaded).toBe(1);
    expect(restored?.handoffContext).toEqual(session.handoffContext);
  });

  it('backward-compat: legacy session JSON without handoffContext loads with handoffContext === undefined', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.002');
    session.sessionId = 'sess-legacy';
    // No handoffContext assigned — mimics pre-#695 session.
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', '171.002');

    expect(restored?.handoffContext).toBeUndefined();
  });

  it('AD-12: persists a session that has handoffContext but NO sessionId (post-reset window)', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.003');
    // Simulate state right after `resetSessionContext()`: sessionId cleared,
    // handoffContext attached by `runDispatch` before the model produces
    // a new sessionId. Pre-AD-12 the filter would skip this session.
    session.sessionId = undefined;
    session.handoffContext = sampleContext({
      handoffKind: 'plan-to-work',
      sourceIssueUrl: 'https://github.com/owner/repo/issues/99',
      tier: 'small',
      escapeEligible: true,
      issueRequiredByUser: false,
    });

    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', '171.003');

    expect(restored?.handoffContext).toEqual(session.handoffContext);
    expect(restored?.sessionId).toBeUndefined();
  });

  it('skips empty sessions that have neither sessionId nor handoffContext (legacy gate intact)', () => {
    const writer = new SessionRegistry();
    writer.createSession('U1', 'Tester', 'C1', '171.004');
    // No sessionId, no handoffContext.

    writer.saveSessions();

    // sessions.json should be an empty array (no session saved).
    const reader = new SessionRegistry();
    const loaded = reader.loadSessions();
    expect(loaded).toBe(0);
    expect(reader.getSession('C1', '171.004')).toBeUndefined();
  });
});

describe('SessionRegistry — autoHandoffBudget persistence (#697)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it('T2.1 fresh session from createSession has autoHandoffBudget=1 (spec AD-6)', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Tester', 'C1', '172.001');
    expect(session.autoHandoffBudget).toBe(1);
  });

  it('T2.2 session with autoHandoffBudget=0 round-trips through save/load', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '172.002');
    session.sessionId = 'sess-budget-0';
    session.autoHandoffBudget = 0; // simulate post-consume state

    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', '172.002');

    expect(restored?.autoHandoffBudget).toBe(0);
  });

  it('T2.3 pre-#697 disk state (SerializedSession without autoHandoffBudget) loads as undefined', () => {
    // Hand-craft a legacy session payload without the autoHandoffBudget field.
    const legacyPayload = [
      {
        key: 'C1:172.003',
        ownerId: 'U1',
        ownerName: 'Tester',
        userId: 'U1',
        channelId: 'C1',
        threadTs: '172.003',
        sessionId: 'sess-legacy-budget',
        isActive: true,
        lastActivity: new Date().toISOString(),
        state: 'MAIN',
        workflow: 'default',
      },
    ];
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), JSON.stringify(legacyPayload, null, 2));

    const reader = new SessionRegistry();
    const loaded = reader.loadSessions();
    expect(loaded).toBe(1);
    const restored = reader.getSession('C1', '172.003');
    expect(restored?.autoHandoffBudget).toBeUndefined();
  });

  it('T2.4 resetSessionContext restores autoHandoffBudget=1 after prior decrement to 0', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Tester', 'C1', '172.004');
    // `resetSessionContext` early-returns unless `sessionId` is set — simulate
    // a session with active conversation history (the realistic post-model-turn
    // state in which `resetSession: true` continuations fire).
    session.sessionId = 'sess-active';
    session.autoHandoffBudget = 0; // simulate consumed
    expect(session.autoHandoffBudget).toBe(0);

    const didReset = registry.resetSessionContext('C1', '172.004');
    expect(didReset).toBe(true);

    const resetted = registry.getSession('C1', '172.004');
    expect(resetted?.autoHandoffBudget).toBe(1);
    // Also verifies #695 handoffContext clear still works side-by-side.
    expect(resetted?.handoffContext).toBeUndefined();
  });
});

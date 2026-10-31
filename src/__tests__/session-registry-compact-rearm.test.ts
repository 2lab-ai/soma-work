import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted — keep the path computation inside the factory.
vi.mock('../env-paths', () => ({
  DATA_DIR: require('path').join(
    process.env.TMPDIR ?? require('os').tmpdir(),
    'soma-work-session-registry-compact-rearm',
  ),
}));

import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-session-registry-compact-rearm');

function usageWithOccupancy(cacheRead: number) {
  return {
    currentInputTokens: 2,
    currentOutputTokens: 600,
    currentCacheReadTokens: cacheRead,
    currentCacheCreateTokens: 4_000,
    contextWindow: 1_000_000,
    totalInputTokens: 3_000_000,
    totalOutputTokens: 400_000,
    totalCacheReadTokens: 170_000_000,
    totalCacheCreateTokens: 10_000_000,
    totalCostUsd: 130,
    lastUpdated: 1_793_000_000_000,
  };
}

function saveAndReload(thread: string, cacheRead: number) {
  const writer = new SessionRegistry();
  const session = writer.createSession('U1', 'Tester', 'C1', thread);
  session.sessionId = 'sdk-A';
  session.model = 'claude-opus-5-5[1m]';
  session.usage = usageWithOccupancy(cacheRead);
  writer.saveSessions();
  const reader = new SessionRegistry();
  reader.loadSessions();
  return reader.getSession('C1', thread);
}

/**
 * ssot-task: T3 — a restart must not forget that the context is over the
 * auto-compact threshold (a dev deployment, 2026-10-30).
 *
 * Automatic compaction has one authority: the harness threshold check. A
 * session's goal turn was killed by three restarts in a row (04:11, 04:51,
 * 06:31Z). Each resumed the same SDK session on its full transcript — 950,637
 * tokens after the third — while the restore reset `autoCompactPending` and
 * nothing re-checked the saved occupancy, so no `/compact` ever ran: 975,598
 * tokens later the API answered "Prompt is too long".
 */
describe('SessionRegistry — auto-compact is re-armed from the restored occupancy', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('a saved occupancy over the threshold (950k on a 750k-trigger model) arms auto-compact', () => {
    const restored = saveAndReload('171.401', 946_035);
    expect(restored?.usage?.currentCacheReadTokens).toBe(946_035);
    expect(restored?.autoCompactPending).toBe(true);
  });

  it('a saved occupancy under the threshold leaves auto-compact disarmed', () => {
    const restored = saveAndReload('171.402', 400_000);
    expect(restored?.autoCompactPending).toBe(false);
  });
});

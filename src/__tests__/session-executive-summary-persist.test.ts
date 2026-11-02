/**
 * SSOT 2026-11-02 T7 — the card's TL;DR survives a restart, like the thread head that shows the same
 * lines (review: grok P1). `executiveSummary` is saved with the session and restored only when it is
 * still a TL;DR (lines of text and a time).
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/soma-work-session-es-persist-test';

vi.mock(import('../env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DATA_DIR: '/tmp/soma-work-session-es-persist-test' };
});

import { SessionRegistry } from '../session-registry';

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function restoreWith(executiveSummary: unknown) {
  const writer = new SessionRegistry();
  const session = writer.createSession('U1', 'Tester', 'C1', '171.001');
  session.sessionId = 'sess-1';
  (session as any).executiveSummary = executiveSummary;
  writer.saveSessions();
  const reader = new SessionRegistry();
  reader.loadSessions();
  return reader.getSession('C1', '171.001');
}

describe('T7 — the card TL;DR is kept across a restart', () => {
  it('round-trips the TL;DR lines and when they came', () => {
    const restored = restoreWith({ tldr: ['PR merged', 'CI green'], at: 1_793_600_000_000 });
    expect(restored?.executiveSummary).toEqual({ tldr: ['PR merged', 'CI green'], at: 1_793_600_000_000 });
  });

  it('none stored: none restored', () => {
    expect(restoreWith(undefined)?.executiveSummary).toBeUndefined();
  });

  it('what is not a TL;DR is dropped on load (no lines, no time, junk lines)', () => {
    expect(restoreWith({ tldr: [], at: 1 })?.executiveSummary).toBeUndefined();
    expect(restoreWith({ tldr: ['x'] })?.executiveSummary).toBeUndefined();
    expect(restoreWith({ tldr: [' ', 3, null, 'kept'], at: 2 })?.executiveSummary).toEqual({ tldr: ['kept'], at: 2 });
  });
});

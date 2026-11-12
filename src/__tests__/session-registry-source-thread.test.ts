/**
 * SSOT 2026-11-12 — one source thread may start several work threads: every instruction there that the sender
 * runs as a new task gets its own work thread, all linked back to the same source thread. The reverse lookup
 * returns every one of them.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-registry-source-thread-test-${process.pid}`),
  };
});

vi.mock('../env-paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
}));

import { SessionRegistry } from '../session-registry';

describe('SessionRegistry.findSessionsBySourceThread', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('returns every work session started from the same source thread', () => {
    const registry = new SessionRegistry();
    const first = registry.createSession('U_OWNER', 'Owner', 'C1', '901.000');
    first.sourceThread = { channel: 'C1', threadTs: '100.000' };
    const second = registry.createSession('U_Z', 'Z', 'C1', '902.000');
    second.sourceThread = { channel: 'C1', threadTs: '100.000' };
    const other = registry.createSession('U_Z', 'Z', 'C1', '903.000');
    other.sourceThread = { channel: 'C1', threadTs: '555.000' };

    const linked = registry.findSessionsBySourceThread('C1', '100.000');
    expect(linked.map((s) => s.threadTs)).toEqual(['901.000', '902.000']);
  });

  it('returns an empty list for a thread no session came from', () => {
    const registry = new SessionRegistry();
    registry.createSession('U_Z', 'Z', 'C1', '901.000');
    expect(registry.findSessionsBySourceThread('C1', '100.000')).toEqual([]);
  });
});

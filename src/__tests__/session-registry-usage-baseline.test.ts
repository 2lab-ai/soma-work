import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted — keep the path computation inside the factory.
vi.mock('../env-paths', () => ({
  DATA_DIR: require('path').join(
    process.env.TMPDIR ?? require('os').tmpdir(),
    'soma-work-session-registry-usage-baseline-test',
  ),
}));

import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-session-registry-usage-baseline-test');

/**
 * RED — the last SDK running total (`sdkUsageBaseline`) must survive a
 * restart. `session.usage` is runtime-only, but the goal's spend is persisted:
 * if the baseline were lost, the first turn after a restart would credit the
 * goal with the SDK session's whole running total again.
 */
describe('SessionRegistry — sdkUsageBaseline persistence', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('round-trips sdkUsageBaseline through save + load', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.101');
    session.sessionId = 'sdk-A';
    session.sdkUsageBaseline = {
      sdkSessionId: 'sdk-A',
      models: {
        'claude-opus-5-5[1m]': {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadInputTokens: 10_000,
          cacheCreationInputTokens: 500,
          costUsd: 1.25,
        },
      },
    };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();

    expect(reader.getSession('C1', '171.101')?.sdkUsageBaseline).toEqual(session.sdkUsageBaseline);
  });

  it('drops a malformed persisted baseline instead of trusting it', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.102');
    session.sessionId = 'sdk-A';
    (session as any).sdkUsageBaseline = { sdkSessionId: 'sdk-A', models: { opus: { costUsd: 'lots' } } };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();

    expect(reader.getSession('C1', '171.102')?.sdkUsageBaseline).toBeUndefined();
  });
});

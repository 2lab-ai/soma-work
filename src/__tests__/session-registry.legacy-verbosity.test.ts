/**
 * Session restore upgrades a verbosity mask stored before the NARRATION flag
 * (spec 10 §3.2) to the current preset — so a thread whose sessions.json was
 * not rewritten by the 2026-10-16 one-shot (e.g. its data write failed after
 * the marker) keeps its level instead of silently losing narration and showing
 * a `custom` chip.
 */

import fs from 'node:fs';
import { getVerbosityFlags, getVerbosityName, LOG_VERBOSITY_MASK_VERSION, OutputFlag } from '@soma/slack/output-flags';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-session-registry-legacy-verbosity-test',
}));

import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = '/tmp/soma-work-session-registry-legacy-verbosity-test';

function writeSession(
  threadTs: string,
  logVerbosity: number | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: `C-legacy-${threadTs}`,
    ownerId: 'U-legacy',
    userId: 'U-legacy',
    channelId: 'C-legacy',
    threadTs,
    sessionId: `legacy-${threadTs}`,
    isActive: true,
    lastActivity: new Date().toISOString(),
    state: 'MAIN',
    workflow: 'default',
    ...(logVerbosity === undefined ? {} : { logVerbosity }),
    ...extra,
  };
}

describe('SessionRegistry.loadSessions — legacy verbosity masks', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('restores pre-NARRATION preset masks as the current presets, and keeps the rest', () => {
    const legacyDetail = getVerbosityFlags('detail') & ~OutputFlag.NARRATION;
    const legacyCompact = getVerbosityFlags('compact') & ~OutputFlag.NARRATION;
    fs.writeFileSync(
      `${TEST_DATA_DIR}/sessions.json`,
      JSON.stringify([
        writeSession('171.001', legacyDetail),
        writeSession('171.002', legacyCompact),
        writeSession('171.003', getVerbosityFlags('minimal')),
        writeSession('171.004', 0b1111),
        writeSession('171.005', undefined),
      ]),
    );

    const registry = new SessionRegistry();
    expect(registry.loadSessions()).toBe(5);

    const mask = (threadTs: string) => registry.getSession('C-legacy', threadTs)?.logVerbosity;
    expect(mask('171.001')).toBe(getVerbosityFlags('detail'));
    expect(getVerbosityName(mask('171.001') as number)).toBe('detail');
    expect(mask('171.002')).toBe(getVerbosityFlags('compact'));
    expect(mask('171.003')).toBe(getVerbosityFlags('minimal'));
    expect(mask('171.004')).toBe(0b1111);
    expect(mask('171.005')).toBeUndefined();
  });

  it('a mask saved WITH the version marker is never rewritten, even if it equals an old preset number', () => {
    // A current custom mask that happens to equal the old detail preset.
    const legacyDetailNumber = getVerbosityFlags('detail') & ~OutputFlag.NARRATION;
    fs.writeFileSync(
      `${TEST_DATA_DIR}/sessions.json`,
      JSON.stringify([
        writeSession('172.001', legacyDetailNumber, { logVerbosityVersion: LOG_VERBOSITY_MASK_VERSION }),
        writeSession('172.002', legacyDetailNumber),
      ]),
    );

    const registry = new SessionRegistry();
    registry.loadSessions();

    expect(registry.getSession('C-legacy', '172.001')?.logVerbosity).toBe(legacyDetailNumber);
    expect(registry.getSession('C-legacy', '172.002')?.logVerbosity).toBe(getVerbosityFlags('detail'));
  });

  it('saveSessions stamps the version marker next to every stored mask, and a round trip keeps the mask', () => {
    const legacyCompactNumber = getVerbosityFlags('compact') & ~OutputFlag.NARRATION;
    const writer = new SessionRegistry();
    const withMask = writer.createSession('U1', 'Tester', 'C-v', '173.001');
    withMask.sessionId = 'sess-v1';
    withMask.logVerbosity = legacyCompactNumber;
    const noMask = writer.createSession('U1', 'Tester', 'C-v', '173.002');
    noMask.sessionId = 'sess-v2';
    noMask.logVerbosity = undefined;
    writer.saveSessions();

    const saved = JSON.parse(fs.readFileSync(`${TEST_DATA_DIR}/sessions.json`, 'utf8')) as Array<
      Record<string, unknown>
    >;
    const byThread = (ts: string) => saved.find((entry) => entry.threadTs === ts);
    expect(byThread('173.001')).toMatchObject({ logVerbosity: legacyCompactNumber, logVerbosityVersion: 2 });
    expect(byThread('173.002')).not.toHaveProperty('logVerbosityVersion');

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C-v', '173.001')?.logVerbosity).toBe(legacyCompactNumber);
  });
});

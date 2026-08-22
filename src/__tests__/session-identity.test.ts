/**
 * Step 4d — soma-work session identity over the shared soma-lib model.
 *
 * Pins the canonical key format (`work:<channel>:<thread|direct>`), the
 * legacy-key normalization used for pre-deploy Slack action payloads, and
 * the loadSessions() key re-derivation that migrates an old-format
 * sessions.json in place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-session-identity-test',
}));

import {
  buildWorkSessionKey,
  DIRECT_THREAD_ID,
  normalizeSessionKey,
  WORK_TENANT_ID,
} from '../session-identity';
import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = '/tmp/soma-work-session-identity-test';

describe('buildWorkSessionKey', () => {
  it('builds the shared tenant:channel:thread format', () => {
    expect(buildWorkSessionKey('C0ACM4320MQ', '1755849600.123456')).toBe(
      'work:C0ACM4320MQ:1755849600.123456',
    );
  });

  it('uses the direct sentinel for channel-level sessions', () => {
    expect(buildWorkSessionKey('C0ACM4320MQ')).toBe('work:C0ACM4320MQ:direct');
    expect(buildWorkSessionKey('C0ACM4320MQ', undefined)).toBe('work:C0ACM4320MQ:direct');
    expect(buildWorkSessionKey('C0ACM4320MQ', '')).toBe('work:C0ACM4320MQ:direct');
  });

  it('exposes the tenant and sentinel constants it is built from', () => {
    const key = buildWorkSessionKey('C1');
    expect(key.startsWith(`${WORK_TENANT_ID}:`)).toBe(true);
    expect(key.endsWith(`:${DIRECT_THREAD_ID}`)).toBe(true);
  });
});

describe('normalizeSessionKey', () => {
  it('passes canonical keys through unchanged', () => {
    const key = buildWorkSessionKey('C123', '111.222');
    expect(normalizeSessionKey(key)).toBe(key);
  });

  it('converts a legacy channel-threadTs key', () => {
    expect(normalizeSessionKey('C0ACM4320MQ-1755849600.123456')).toBe(
      'work:C0ACM4320MQ:1755849600.123456',
    );
  });

  it('converts a legacy channel-direct key', () => {
    expect(normalizeSessionKey('C0ACM4320MQ-direct')).toBe('work:C0ACM4320MQ:direct');
  });

  it('splits at the FIRST dash so dashed thread ids survive', () => {
    // Slack channel ids are alphanumeric; anything after the first dash is
    // the thread segment, even if it contains further dashes.
    expect(normalizeSessionKey('C1-t-G')).toBe('work:C1:t-G');
  });

  it('returns unrecognizable strings unchanged', () => {
    expect(normalizeSessionKey('nodash')).toBe('nodash');
    expect(normalizeSessionKey('-leading')).toBe('-leading');
    expect(normalizeSessionKey('trailing-')).toBe('trailing-');
    expect(normalizeSessionKey('')).toBe('');
  });
});

describe('SessionRegistry key migration on load (Step 4d)', () => {
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

  it('re-derives map keys from channel/thread fields, migrating legacy keys', () => {
    const legacy = {
      key: 'C777-171.100',
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C777',
      threadTs: '171.100',
      sessionId: 'sess-1',
      isActive: true,
      lastActivity: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), JSON.stringify([legacy]));

    const registry = new SessionRegistry();
    expect(registry.loadSessions()).toBe(1);

    // Reachable via the canonical derivation…
    const session = registry.getSession('C777', '171.100');
    expect(session?.sessionId).toBe('sess-1');
    // …under the new-format map key…
    expect(registry.getSessionByKey('work:C777:171.100')?.sessionId).toBe('sess-1');
    // …and still reachable via the legacy key (pre-deploy Slack buttons).
    expect(registry.getSessionByKey('C777-171.100')?.sessionId).toBe('sess-1');
  });

  it('persists the migrated key on the next save', () => {
    const legacy = {
      key: 'C888-direct',
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C888',
      sessionId: 'sess-2',
      isActive: true,
      lastActivity: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), JSON.stringify([legacy]));

    const registry = new SessionRegistry();
    registry.loadSessions();
    registry.saveSessions();

    const rewritten = JSON.parse(
      fs.readFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), 'utf-8'),
    );
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0].key).toBe('work:C888:direct');
  });

  it('is idempotent for already-canonical files', () => {
    const canonical = {
      key: 'work:C999:171.200',
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C999',
      threadTs: '171.200',
      sessionId: 'sess-3',
      isActive: true,
      lastActivity: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), JSON.stringify([canonical]));

    const registry = new SessionRegistry();
    expect(registry.loadSessions()).toBe(1);
    expect(registry.getSessionByKey('work:C999:171.200')?.sessionId).toBe('sess-3');
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { McpToolGrantStore, parseDuration, type PermissionLevel } from './mcp-tool-grant-store';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grant-store-test-'));
}

describe('McpToolGrantStore', () => {
  let dir: string;
  let store: McpToolGrantStore;

  beforeEach(() => {
    dir = makeTempDir();
    store = new McpToolGrantStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── S4: Grant store atomic write ──
  it('setGrant persists grant to file', () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_USER', 'server-tools', 'write', expiresAt, 'U_ADMIN');

    const grant = store.getActiveGrant('U_USER', 'server-tools');
    expect(grant).not.toBeNull();
    expect(grant!.write).toBeDefined();
    expect(grant!.write!.grantedBy).toBe('U_ADMIN');
    expect(grant!.write!.expiresAt).toBe(expiresAt);
  });

  // ── S4: write implies read ──
  it('write grant implies read access', () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_USER', 'server-tools', 'write', expiresAt, 'U_ADMIN');

    expect(store.hasActiveGrant('U_USER', 'server-tools', 'read')).toBe(true);
    expect(store.hasActiveGrant('U_USER', 'server-tools', 'write')).toBe(true);
  });

  // ── S5: active read grant allows read tool ──
  it('read grant allows read-level access only', () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_USER', 'server-tools', 'read', expiresAt, 'U_ADMIN');

    expect(store.hasActiveGrant('U_USER', 'server-tools', 'read')).toBe(true);
    expect(store.hasActiveGrant('U_USER', 'server-tools', 'write')).toBe(false);
  });

  // ── S6: expired grant blocks access ──
  it('expired grant returns false for hasActiveGrant', () => {
    const expiresAt = new Date(Date.now() - 1000).toISOString(); // past
    store.setGrant('U_USER', 'server-tools', 'write', expiresAt, 'U_ADMIN');

    expect(store.hasActiveGrant('U_USER', 'server-tools', 'write')).toBe(false);
    expect(store.hasActiveGrant('U_USER', 'server-tools', 'read')).toBe(false);
  });

  // ── S6: expired write but active read ──
  it('expired write grant still allows read if read grant is active', () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    const futureExpiry = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_USER', 'server-tools', 'write', pastExpiry, 'U_ADMIN');
    store.setGrant('U_USER', 'server-tools', 'read', futureExpiry, 'U_ADMIN');

    expect(store.hasActiveGrant('U_USER', 'server-tools', 'write')).toBe(false);
    expect(store.hasActiveGrant('U_USER', 'server-tools', 'read')).toBe(true);
  });

  // ── S3: no grant returns null ──
  it('getActiveGrant returns null for unknown user', () => {
    expect(store.getActiveGrant('U_UNKNOWN', 'server-tools')).toBeNull();
  });

  // ── S7: getGrants returns all grants ──
  it('getGrants returns all grants for a user', () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_USER', 'server-tools', 'read', expiresAt, 'U_ADMIN');

    const grants = store.getGrants('U_USER');
    expect(grants).toBeDefined();
    expect(grants!['server-tools']).toBeDefined();
    expect(grants!['server-tools'].read).toBeDefined();
  });

  // ── S8: revoke grant ──
  it('revokeGrant removes specific level', () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_USER', 'server-tools', 'write', expiresAt, 'U_ADMIN');
    store.setGrant('U_USER', 'server-tools', 'read', expiresAt, 'U_ADMIN');

    store.revokeGrant('U_USER', 'server-tools', 'write');

    expect(store.hasActiveGrant('U_USER', 'server-tools', 'write')).toBe(false);
    expect(store.hasActiveGrant('U_USER', 'server-tools', 'read')).toBe(true);
  });

  // ── S8: revoke all ──
  it('revokeGrant with level "all" removes both levels', () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_USER', 'server-tools', 'write', expiresAt, 'U_ADMIN');
    store.setGrant('U_USER', 'server-tools', 'read', expiresAt, 'U_ADMIN');

    store.revokeGrant('U_USER', 'server-tools', 'all');

    expect(store.hasActiveGrant('U_USER', 'server-tools', 'write')).toBe(false);
    expect(store.hasActiveGrant('U_USER', 'server-tools', 'read')).toBe(false);
  });

  // ── S4: atomic write (file survives reload) ──
  it('grants survive store reload from disk', () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_USER', 'server-tools', 'write', expiresAt, 'U_ADMIN');

    // Create new store instance from same directory
    const store2 = new McpToolGrantStore(dir);
    expect(store2.hasActiveGrant('U_USER', 'server-tools', 'write')).toBe(true);
  });
});

describe('parseDuration', () => {
  // ── S4: duration parsing ──
  it('parses hours correctly', () => {
    expect(parseDuration('24h')).toBe(24 * 3600 * 1000);
  });

  it('parses days correctly', () => {
    expect(parseDuration('7d')).toBe(7 * 24 * 3600 * 1000);
  });

  it('parses weeks correctly', () => {
    expect(parseDuration('4w')).toBe(4 * 7 * 24 * 3600 * 1000);
  });

  it('returns null for invalid format', () => {
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('24x')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

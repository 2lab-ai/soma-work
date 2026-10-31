import { spawn } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpToolGrantStore, type PermissionLevel, parseDuration } from '../mcp-tool-grant-store';

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
  it("two processes writing the same file: a write never drops the other one's grant (#621)", () => {
    // The MCP child and the main process each hold a store over one file; each loaded it at start.
    const other = new McpToolGrantStore(dir);
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_B', 'server-tools', 'read', expiresAt, 'U_ADMIN');
    other.setGrant('U_A', 'github', 'write', expiresAt, 'U_ADMIN');
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-tool-grants.json'), 'utf-8'));
    expect(Object.keys(disk).sort()).toEqual(['U_A', 'U_B']);
    store.revokeGrant('U_A', 'github', 'all');
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-tool-grants.json'), 'utf-8'));
    expect(after.U_B?.['server-tools']?.read).toBeDefined();
    expect(after.U_A?.github).toBeUndefined();
  });

  it('a write that cannot reach the disk throws and leaves the grants as they were (#621)', () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_A', 'github', 'read', expiresAt, 'U_ADMIN');
    // The rename target becomes unwritable: a directory where the temp file must land.
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => store.setGrant('U_B', 'github', 'write', expiresAt, 'U_ADMIN')).toThrow();
      expect(store.getActiveGrant('U_B', 'github')).toBeNull();
      expect(store.getActiveGrant('U_A', 'github')?.read).toBeDefined();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('setGrant returns what it replaced; restoreGrant puts it back', () => {
    const first = new Date(Date.now() + 86400000).toISOString();
    const second = new Date(Date.now() + 2 * 86400000).toISOString();
    expect(store.setGrant('U_A', 'github', 'write', first, 'U_ADMIN1')).toBeNull();
    const replaced = store.setGrant('U_A', 'github', 'write', second, 'U_ADMIN2');
    expect(replaced?.expiresAt).toBe(first);
    store.restoreGrant('U_A', 'github', 'write', replaced);
    expect(new McpToolGrantStore(dir).getActiveGrant('U_A', 'github')?.write?.expiresAt).toBe(first);
    store.restoreGrant('U_A', 'github', 'write', null);
    expect(new McpToolGrantStore(dir).getActiveGrant('U_A', 'github')).toBeNull();
  });

  it('another process mid-change holds the file: a write waits for it and keeps its change (#621)', async () => {
    const file = path.join(dir, 'mcp-tool-grants.json');
    const lock = `${file}.lock`;
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.setGrant('U_REVOKED', 'github', 'write', expiresAt, 'U_ADMIN');
    // The "MCP child": takes the lock, revokes U_REVOKED a moment later, releases.
    const child = spawn(process.execPath, [
      '-e',
      `const fs=require('fs');fs.writeFileSync(${JSON.stringify(lock)},'child',{flag:'wx'});` +
        `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(file)},'{}');fs.unlinkSync(${JSON.stringify(lock)});},300);`,
    ]);
    const exited = new Promise((r) => child.on('exit', r));
    for (let i = 0; i < 200 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(lock)).toBe(true);
    // The main process approves someone else meanwhile — from a map that still has U_REVOKED.
    store.setGrant('U_NEW', 'server-tools', 'read', expiresAt, 'U_ADMIN');
    await exited;
    const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(disk.U_REVOKED).toBeUndefined();
    expect(disk.U_NEW?.['server-tools']?.read).toBeDefined();
  });

  it('a lock nobody releases: a fresh one makes the write fail; an abandoned one is broken', () => {
    const file = path.join(dir, 'mcp-tool-grants.json');
    const lock = `${file}.lock`;
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const impatient = new McpToolGrantStore(dir, 50);
    fs.writeFileSync(lock, 'someone');
    expect(() => impatient.setGrant('U_A', 'github', 'read', expiresAt, 'U_ADMIN')).toThrow(/locked/);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    impatient.setGrant('U_A', 'github', 'read', expiresAt, 'U_ADMIN');
    expect(impatient.getActiveGrant('U_A', 'github')?.read).toBeDefined();
    expect(fs.existsSync(lock)).toBe(false);
  });

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

  // ── Zero-value guard ──
  it('returns null for zero duration', () => {
    expect(parseDuration('0h')).toBeNull();
    expect(parseDuration('0d')).toBeNull();
    expect(parseDuration('0w')).toBeNull();
  });
});

// saveGrants rollback is verified by code review:
// On write failure, catch block calls this.loadGrants() to restore last-known-good state.
// loadGrants restoration is covered by "grants survive store reload from disk" test above.

describe('Grant expiry boundary conditions', () => {
  let dir: string;
  let store: McpToolGrantStore;

  beforeEach(() => {
    dir = makeTempDir();
    store = new McpToolGrantStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('grant expired at exactly now is treated as expired (strict > comparison)', () => {
    // Set grant that expires at Date.now() — should be expired
    const exactNow = new Date().toISOString();
    store.setGrant('U_BOUNDARY', 'server-tools', 'read', exactNow, 'U_ADMIN');

    // Give 1ms to ensure we're past the boundary
    const result = store.hasActiveGrant('U_BOUNDARY', 'server-tools', 'read');
    expect(result).toBe(false);
  });

  it('grant expired 1ms ago is expired', () => {
    const justPast = new Date(Date.now() - 1).toISOString();
    store.setGrant('U_PAST', 'server-tools', 'read', justPast, 'U_ADMIN');

    expect(store.hasActiveGrant('U_PAST', 'server-tools', 'read')).toBe(false);
  });

  it('grant expiring in 1 second is still active', () => {
    const nearFuture = new Date(Date.now() + 1000).toISOString();
    store.setGrant('U_FUTURE', 'server-tools', 'read', nearFuture, 'U_ADMIN');

    expect(store.hasActiveGrant('U_FUTURE', 'server-tools', 'read')).toBe(true);
  });
});

describe('Corrupted grant file handling', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('corrupted JSON resets grants to empty', () => {
    dir = makeTempDir();
    const grantFile = path.join(dir, 'mcp-tool-grants.json');

    // Write a valid grant first
    const store1 = new McpToolGrantStore(dir);
    store1.setGrant('U_TEST', 'server-tools', 'read', new Date(Date.now() + 86400000).toISOString(), 'U_ADMIN');
    expect(store1.hasActiveGrant('U_TEST', 'server-tools', 'read')).toBe(true);

    // Corrupt the file
    fs.writeFileSync(grantFile, '{ corrupted json !!!');

    // New store should load gracefully with empty grants
    const store2 = new McpToolGrantStore(dir);
    expect(store2.hasActiveGrant('U_TEST', 'server-tools', 'read')).toBe(false);
  });

  it('missing grant file results in no grants', () => {
    dir = makeTempDir();
    const store = new McpToolGrantStore(dir);
    expect(store.hasActiveGrant('U_NOBODY', 'server-tools', 'read')).toBe(false);
    expect(store.getGrants('U_NOBODY')).toBeNull();
  });

  it('valid JSON but wrong shape is handled gracefully', () => {
    dir = makeTempDir();
    const grantFile = path.join(dir, 'mcp-tool-grants.json');
    fs.writeFileSync(grantFile, JSON.stringify('not-an-object'));

    const store = new McpToolGrantStore(dir);
    // Should not crash — string won't have expected properties
    expect(store.hasActiveGrant('U_ANY', 'server-tools', 'read')).toBe(false);
  });
});

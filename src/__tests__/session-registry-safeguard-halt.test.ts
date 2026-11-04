import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted — keep the path computation inside the factory.
vi.mock('../env-paths', () => ({
  DATA_DIR: require('path').join(process.env.TMPDIR ?? require('os').tmpdir(), 'soma-work-session-registry-safeguard'),
}));

import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-session-registry-safeguard');

/**
 * ssot-task: T2 · T3 — a restart must not unlock a session the safeguards
 * stopped. The lock is the only thing standing between a non-admin (or the
 * restart's own goal resume) and the blocked session.
 */
describe('SessionRegistry — safeguardHalt survives a restart', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('saves and restores the halt', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.501');
    session.sessionId = 'sdk-A';
    session.safeguardHalt = {
      atMs: 1_793_752_964_388,
      model: 'Opus 5.5 (1M context)',
      detail: 'reasoning_extraction',
      requestId: 'req_011CggxYZxQ7TEBU95XW3X19',
      messageId: 'msg_011CggxYckLHkHA9sUKftEWG',
    };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.501')?.safeguardHalt).toEqual(session.safeguardHalt);
  });

  it('a session without a halt restores without one', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.502');
    session.sessionId = 'sdk-B';
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.502')?.safeguardHalt).toBeUndefined();
  });

  it('drops a malformed halt (no atMs) instead of locking on garbage', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.503');
    session.sessionId = 'sdk-C';
    (session as any).safeguardHalt = { detail: 'x' };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.503')?.safeguardHalt).toBeUndefined();
  });

  // Review gate (astra-zhuge P1 #5–#7, PR #906).
  const HALT = { atMs: 1_793_752_964_388, detail: 'reasoning_extraction', requestId: 'req_x' };

  it('a halted session closed by its owner stays halted after a restart — the next session inherits the lock', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.601');
    session.sessionId = 'sdk-D';
    session.safeguardHalt = HALT;
    writer.saveSessions();
    expect(writer.terminateSession(writer.getSessionKey('C1', '171.601'))).toBe(true);
    expect(writer.getSafeguardHalt('C1', '171.601')).toEqual(HALT);

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.601')).toBeUndefined();
    expect(reader.getSafeguardHalt('C1', '171.601')).toEqual(HALT);
    const reborn = reader.createSession('U1', 'Tester', 'C1', '171.601');
    expect(reborn.safeguardHalt).toEqual(HALT);
  });

  it('a halted session archived at load (slept past the limit) leaves its lock behind', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.602');
    session.sessionId = 'sdk-E';
    session.safeguardHalt = HALT;
    session.state = 'SLEEPING';
    session.sleepStartedAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.602')).toBeUndefined();
    expect(reader.getSafeguardHalt('C1', '171.602')).toEqual(HALT);
  });

  it('a corrupt tombstone file falls back to its .bak instead of reading as "no locks"', () => {
    const writer = new SessionRegistry();
    const a = writer.createSession('U1', 'Tester', 'C1', '171.603');
    a.sessionId = 'sdk-F';
    a.safeguardHalt = HALT;
    writer.saveSessions();
    writer.terminateSession(writer.getSessionKey('C1', '171.603'));
    // A second write leaves the first as the .bak.
    const b = writer.createSession('U1', 'Tester', 'C1', '171.604');
    b.sessionId = 'sdk-G';
    writer.saveSessions();
    const file = path.join(TEST_DATA_DIR, 'safeguard-halts.json');
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
    fs.writeFileSync(file, '{ torn');

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSafeguardHalt('C1', '171.603')).toEqual(HALT);
  });

  // Review gate round 2 (astra-zhuge P1 #2, #3).
  it('a session that inherited a tombstone keeps the tombstone on disk until the admin lifts it', () => {
    const writer = new SessionRegistry();
    const a = writer.createSession('U1', 'Tester', 'C1', '171.701');
    a.sessionId = 'sdk-H';
    a.safeguardHalt = HALT;
    writer.saveSessions();
    writer.terminateSession(writer.getSessionKey('C1', '171.701'));
    const reborn = writer.createSession('U1', 'Tester', 'C1', '171.701');
    reborn.sessionId = 'sdk-I';
    writer.saveSessions();

    const file = path.join(TEST_DATA_DIR, 'safeguard-halts.json');
    expect(fs.readFileSync(file, 'utf-8')).toContain('171.701');

    expect(writer.liftSafeguardHalt(writer.getSessionKey('C1', '171.701'))).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('171.701');
  });

  it('both tombstone copies unreadable: the threads the file names stay locked, others are not', () => {
    const writer = new SessionRegistry();
    const a = writer.createSession('U1', 'Tester', 'C1', '171.702');
    a.sessionId = 'sdk-J';
    a.safeguardHalt = HALT;
    writer.saveSessions();
    writer.terminateSession(writer.getSessionKey('C1', '171.702'));
    const file = path.join(TEST_DATA_DIR, 'safeguard-halts.json');
    const raw = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, raw.slice(0, raw.length - 3)); // torn
    fs.writeFileSync(`${file}.bak`, '{ torn');

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSafeguardHalt('C1', '171.702')).toBeDefined();
    expect(reader.getSafeguardHalt('C1', '171.799')).toBeUndefined();
    expect(reader.liftSafeguardHalt(reader.getSessionKey('C1', '171.702'))).toBe(true);
    expect(reader.getSafeguardHalt('C1', '171.702')).toBeUndefined();
  });

  // Review gate round 4 (fable-zhuge P2, PR #906).
  it('a lift whose save fails leaves the lock in memory too (matches "still locked")', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.801');
    s.sessionId = 'sdk-K';
    s.safeguardHalt = HALT;
    reg.saveSessions();
    const spy = vi.spyOn(reg, 'saveSessionsOrThrow').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => reg.liftSafeguardHalt(reg.getSessionKey('C1', '171.801'))).toThrow('disk full');
    expect(reg.getSafeguardHalt('C1', '171.801')).toEqual(HALT);
    spy.mockRestore();
  });
  // Review gate round 6 (astra-zhuge P1 + P2, PR #906): while the tombstone
  // file is unreadable it is never overwritten — yet a lock set (or lifted)
  // meanwhile must survive a restart.
  function tearTombstoneFile(): void {
    const file = path.join(TEST_DATA_DIR, 'safeguard-halts.json');
    const raw = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, raw.slice(0, raw.length - 3)); // torn
    fs.writeFileSync(`${file}.bak`, '{ torn');
  }

  function unreadableRegistry(): SessionRegistry {
    const writer = new SessionRegistry();
    const a = writer.createSession('U1', 'Tester', 'C1', '171.901');
    a.sessionId = 'sdk-U1';
    a.safeguardHalt = HALT;
    writer.saveSessions();
    writer.terminateSession(writer.getSessionKey('C1', '171.901'));
    tearTombstoneFile();
    const reg = new SessionRegistry();
    reg.loadSessions();
    return reg;
  }

  it('unreadable tombstones: a session halted and closed meanwhile stays locked after a restart', () => {
    const reg = unreadableRegistry();
    const b = reg.createSession('U1', 'Tester', 'C1', '171.902');
    b.sessionId = 'sdk-U2';
    b.safeguardHalt = { atMs: 2_000, detail: 'reasoning_extraction' };
    reg.saveSessions();
    reg.terminateSession(reg.getSessionKey('C1', '171.902'));

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSafeguardHalt('C1', '171.902')).toEqual({ atMs: 2_000, detail: 'reasoning_extraction' });
    expect(after.getSafeguardHalt('C1', '171.901')).toBeDefined(); // the torn file still fails closed
  });

  it('unreadable tombstones: an admin lift survives a restart', () => {
    const reg = unreadableRegistry();
    expect(reg.liftSafeguardHalt(reg.getSessionKey('C1', '171.901'))).toBe(true);

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSafeguardHalt('C1', '171.901')).toBeUndefined();
  });

  it('haltSafeguardByKey locks the live session, or tombstones a thread with none', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.950');
    s.sessionId = 'sdk-H';
    expect(reg.haltSafeguardByKey(reg.getSessionKey('C1', '171.950'), HALT)).toBe('session');
    expect(s.safeguardHalt).toEqual(HALT);
    expect(reg.haltSafeguardByKey(reg.getSessionKey('C1', '171.950'), { atMs: 9 })).toBe('already');
    expect(s.safeguardHalt).toEqual(HALT);

    expect(reg.haltSafeguardByKey(reg.getSessionKey('C1', '171.951'), HALT)).toBe('tombstone');
    reg.saveSessions();
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSafeguardHalt('C1', '171.951')).toEqual(HALT);
  });
  // Review gate round 7 (astra-zhuge P1, PR #906).
  it('an unreadable sidecar is never overwritten into "no locks": the threads it names stay locked', () => {
    const reg = unreadableRegistry();
    const b = reg.createSession('U1', 'Tester', 'C1', '171.960');
    b.sessionId = 'sdk-S1';
    b.safeguardHalt = { atMs: 3_000 };
    reg.saveSessions();
    reg.terminateSession(reg.getSessionKey('C1', '171.960')); // its lock is in the sidecar now
    const sidecar = path.join(TEST_DATA_DIR, 'safeguard-halts.while-unreadable.json');
    const raw = fs.readFileSync(sidecar, 'utf-8');
    fs.writeFileSync(sidecar, raw.slice(0, raw.length - 2)); // torn
    fs.writeFileSync(`${sidecar}.bak`, '{ torn');

    const next = new SessionRegistry();
    next.loadSessions();
    expect(next.getSafeguardHalt('C1', '171.960')).toBeDefined();
    next.saveSessions(); // rewrites the sidecar

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSafeguardHalt('C1', '171.960')).toBeDefined();
  });

  it('a session restored under a key only the unreadable text names inherits the lock', () => {
    const reg = unreadableRegistry();
    const reborn = reg.createSession('U1', 'Tester', 'C1', '171.901');
    expect(reborn.safeguardHalt).toBeDefined();
  });
  // Review gate round 8 (astra-zhuge + fable-zhuge P1, PR #906): a lift recorded
  // against the raw evidence never deletes a LATER lock on the same thread.
  it('an old lift does not delete a new lock on the same thread after a restart', () => {
    const reg = unreadableRegistry(); // 171.901 is locked by raw evidence only
    expect(reg.liftSafeguardHalt(reg.getSessionKey('C1', '171.901'))).toBe(true);
    // The operator repairs the main file.
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'safeguard-halts.json'), '{}');
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'safeguard-halts.json.bak'), '{}');
    const repaired = new SessionRegistry();
    repaired.loadSessions();
    const again = repaired.createSession('U1', 'Tester', 'C1', '171.901');
    again.sessionId = 'sdk-U3';
    again.safeguardHalt = { atMs: 2_000, detail: 'reasoning_extraction' };
    repaired.saveSessions();
    repaired.terminateSession(repaired.getSessionKey('C1', '171.901'));

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSafeguardHalt('C1', '171.901')).toEqual({ atMs: 2_000, detail: 'reasoning_extraction' });
  });
  // Durability edges found by the round-9 review's tracing (PR #906).
  it('a torn live tombstone file whose older .bak lacks a lock still fails closed on it', () => {
    const reg = new SessionRegistry();
    const a = reg.createSession('U1', 'Tester', 'C1', '171.980');
    a.sessionId = 'sdk-T1';
    a.safeguardHalt = HALT;
    reg.saveSessions();
    reg.terminateSession(reg.getSessionKey('C1', '171.980'));
    const b = reg.createSession('U1', 'Tester', 'C1', '171.981');
    b.sessionId = 'sdk-T2';
    b.safeguardHalt = HALT;
    reg.saveSessions();
    reg.terminateSession(reg.getSessionKey('C1', '171.981')); // live {980, 981}, .bak {980}
    const file = path.join(TEST_DATA_DIR, 'safeguard-halts.json');
    const raw = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, raw.slice(0, raw.length - 3)); // torn live; the .bak parses

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSafeguardHalt('C1', '171.981')).toBeDefined();
    after.saveSessions(); // rewrites the main file from the .bak's set
    const later = new SessionRegistry();
    later.loadSessions();
    expect(later.getSafeguardHalt('C1', '171.981')).toBeDefined();
  });

  it('evidence carried through two sidecar corruptions (JSON-escaped) still locks its thread', () => {
    const reg = unreadableRegistry();
    const b = reg.createSession('U1', 'Tester', 'C1', '171.970');
    b.sessionId = 'sdk-E1';
    b.safeguardHalt = { atMs: 4_000 };
    reg.saveSessions();
    reg.terminateSession(reg.getSessionKey('C1', '171.970'));
    const sidecar = path.join(TEST_DATA_DIR, 'safeguard-halts.while-unreadable.json');
    const tear = () => {
      const text = fs.readFileSync(sidecar, 'utf-8');
      fs.writeFileSync(sidecar, text.slice(0, text.length - 2));
      fs.writeFileSync(`${sidecar}.bak`, '{ torn');
    };
    tear();
    const once = new SessionRegistry();
    once.loadSessions();
    once.saveSessions(); // carries the torn text as rawEvidence (escaped inside JSON)
    tear();
    const twice = new SessionRegistry();
    twice.loadSessions();
    expect(twice.getSafeguardHalt('C1', '171.970')).toBeDefined();
  });

  it('raw evidence never locks a key that is only the prefix of a named key', () => {
    const reg = unreadableRegistry(); // the torn text names …:171.901
    expect(reg.getSafeguardHalt('C1', '171.90')).toBeUndefined();
  });

  it('a lift whose sessions.json write fails puts the tombstone file back (a restart stays locked)', () => {
    const reg = new SessionRegistry();
    const s1 = reg.createSession('U1', 'Tester', 'C1', '171.990');
    s1.sessionId = 'sdk-L1';
    s1.safeguardHalt = HALT;
    reg.saveSessions();
    reg.terminateSession(reg.getSessionKey('C1', '171.990')); // the lock is a tombstone now
    // sessions.json cannot be replaced (a non-empty directory sits at its path),
    // while the tombstone file before it is written fine.
    const sessionsFile = path.join(TEST_DATA_DIR, 'sessions.json');
    fs.rmSync(sessionsFile, { force: true });
    fs.mkdirSync(sessionsFile);
    fs.writeFileSync(path.join(sessionsFile, 'blocker'), 'x');

    expect(() => reg.liftSafeguardHalt(reg.getSessionKey('C1', '171.990'))).toThrow();
    fs.rmSync(sessionsFile, { recursive: true, force: true });

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSafeguardHalt('C1', '171.990')).toEqual(HALT);
  });
});

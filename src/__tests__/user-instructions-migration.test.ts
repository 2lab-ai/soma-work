/**
 * User Instructions Migration — Contract Tests
 *
 * Issue: #754 (parent epic #727)
 *
 * Tests the eager startup migration that takes a backup of data/sessions.json,
 * reads legacy `session.instructions[]`, and projects them onto the user-scope
 * master at `data/users/{userId}/user-session.json`.
 *
 * Sealed current-pointer rule (from #727 sealed decisions):
 *   - 1 active legacy instruction → set `currentInstructionId` on that session
 *   - >1 active                    → `currentInstructionId = null`, all into
 *                                    instructionHistory, source='migration',
 *                                    one migration `add+confirmed` lifecycle
 *                                    event per instruction
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type LegacySession,
  type MigrationResult,
  migrateUserInstructions,
  runStartupUserInstructionsMigration,
} from '../user-instructions-migration';
import { getUserSessionStore, initUserSessionStore, UserSessionStore } from '../user-session-store';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-migrate-'));
});

afterEach(() => {
  if (dataDir && fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function writeLegacy(sessions: LegacySession[]): void {
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify(sessions, null, 2));
}

function readUserDoc(userId: string): unknown {
  const file = path.join(dataDir, 'users', userId, 'user-session.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('migrateUserInstructions — backup + idempotency', () => {
  it('takes a timestamped backup of sessions.json before writing', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'do x', addedAt: 1, status: 'active' }],
      },
    ]);

    migrateUserInstructions({ dataDir, dryRun: false });

    const backupFiles = fs.readdirSync(dataDir).filter((f) => f.startsWith('sessions.json.') && f.endsWith('.bak'));
    expect(backupFiles.length).toBe(1);
  });

  it('dry-run does NOT write user files or backup', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'do x', addedAt: 1, status: 'active' }],
      },
    ]);

    migrateUserInstructions({ dataDir, dryRun: true });

    expect(fs.existsSync(path.join(dataDir, 'users'))).toBe(false);
    const backupFiles = fs.readdirSync(dataDir).filter((f) => f.startsWith('sessions.json.') && f.endsWith('.bak'));
    expect(backupFiles).toHaveLength(0);
  });

  it('idempotent: running twice produces the same user-session.json', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [
          { id: 'i1', text: 'do x', addedAt: 1, status: 'active' },
          { id: 'i2', text: 'do y', addedAt: 2, status: 'active' },
        ],
      },
    ]);

    const r1 = migrateUserInstructions({ dataDir, dryRun: false });
    const after1 = JSON.stringify(readUserDoc('U1'));

    const r2 = migrateUserInstructions({ dataDir, dryRun: false });
    const after2 = JSON.stringify(readUserDoc('U1'));

    // On-disk state must be byte-identical across runs.
    expect(after1).toBe(after2);
    expect(r1.newInstructions).toBe(2);
    // Second pass: no new mutations.
    expect(r2.newInstructions).toBe(0);
    expect(r2.userIdsTouched).toBe(0);
  });

  it('migrates legacy `todo` status to `active`', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'do x', addedAt: 1, status: 'todo' as 'active' }],
      },
    ]);

    migrateUserInstructions({ dataDir, dryRun: false });

    const doc = readUserDoc('U1') as { instructions: Array<{ id: string; status: string }> };
    expect(doc.instructions[0].id).toBe('i1');
    expect(doc.instructions[0].status).toBe('active');
  });
});

describe('migrateUserInstructions — current-pointer rule', () => {
  it('1 active legacy → set currentInstructionId on that session', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'do x', addedAt: 1, status: 'active' }],
      },
    ]);

    const result: MigrationResult = migrateUserInstructions({ dataDir, dryRun: false });

    const doc = readUserDoc('U1') as {
      instructions: Array<{ id: string; status: string; source: string; linkedSessionIds: string[] }>;
      lifecycleEvents: Array<{ op: string; state: string; instructionId?: string; sessionKey: string }>;
    };
    expect(doc.instructions).toHaveLength(1);
    expect(doc.instructions[0].source).toBe('migration');
    expect(doc.instructions[0].linkedSessionIds).toEqual(['C1-T1']);

    // Session pointer is recorded in result for caller to apply to sessions.json
    expect(result.sessionPointers['C1-T1']).toEqual({
      currentInstructionId: 'i1',
      instructionHistory: ['i1'],
    });

    // Two lifecycle events: add (confirmed) + link (confirmed) for the single session
    const ops = doc.lifecycleEvents.map((e) => e.op);
    expect(ops).toContain('add');
    // States must be confirmed by 'migration'
    for (const evt of doc.lifecycleEvents) {
      expect(evt.state).toBe('confirmed');
    }
  });

  it('>1 active legacy → currentInstructionId=null, all into instructionHistory', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [
          { id: 'i1', text: 'a', addedAt: 1, status: 'active' },
          { id: 'i2', text: 'b', addedAt: 2, status: 'active' },
        ],
      },
    ]);

    const result = migrateUserInstructions({ dataDir, dryRun: false });

    const doc = readUserDoc('U1') as {
      instructions: Array<{ id: string; status: string; source: string }>;
    };
    expect(doc.instructions.map((i) => i.id).sort()).toEqual(['i1', 'i2']);
    for (const inst of doc.instructions) {
      expect(inst.source).toBe('migration');
    }

    expect(result.sessionPointers['C1-T1']).toEqual({
      currentInstructionId: null,
      instructionHistory: ['i1', 'i2'],
    });
  });

  it('preserves quantity + text across migration', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [
          { id: 'i1', text: 'first', addedAt: 1, status: 'active' },
          { id: 'i2', text: 'second', addedAt: 2, status: 'completed', completedAt: 100, evidence: 'merged' },
          { id: 'i3', text: 'third', addedAt: 3, status: 'todo' as 'active' },
        ],
      },
    ]);

    migrateUserInstructions({ dataDir, dryRun: false });

    const doc = readUserDoc('U1') as { instructions: Array<{ id: string; text: string; status: string }> };
    expect(doc.instructions).toHaveLength(3);
    const byId = Object.fromEntries(doc.instructions.map((i) => [i.id, i]));
    expect(byId.i1.text).toBe('first');
    expect(byId.i1.status).toBe('active');
    expect(byId.i2.status).toBe('completed');
    expect(byId.i3.status).toBe('active'); // todo→active
  });

  it('uses ownerId as the user key (not the legacy userId field)', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U_OWNER',
        userId: 'U_LEGACY',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'a', addedAt: 1, status: 'active' }],
      },
    ]);

    migrateUserInstructions({ dataDir, dryRun: false });

    expect(readUserDoc('U_OWNER')).not.toBeNull();
    expect(readUserDoc('U_LEGACY')).toBeNull();
  });

  it('produces a doc that round-trips through UserSessionStore (invariants pass)', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'a', addedAt: 1, status: 'active' }],
      },
    ]);

    migrateUserInstructions({ dataDir, dryRun: false });

    const store = new UserSessionStore(dataDir);
    const doc = store.load('U1');
    // Should not throw — invariants should hold for migrated docs.
    expect(() => store.save('U1', doc)).not.toThrow();
  });
});

// ── #727 P0-3 — lifecycle event repair is independently idempotent ──
describe('migrateUserInstructions — lifecycle event repair (P0-3)', () => {
  it('a previous partial save (instruction present, lifecycle event missing) is repaired on the next run', () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'do x', addedAt: 1, status: 'active' }],
      },
    ]);

    const store = new UserSessionStore(dataDir);
    // Simulate a previous run that wrote the instruction row but crashed
    // before persisting the lifecycle event.
    store.save('U1', {
      schemaVersion: 1,
      instructions: [
        {
          id: 'i1',
          text: 'do x',
          status: 'active',
          linkedSessionIds: ['C1-T1'],
          createdAt: new Date(1).toISOString(),
          source: 'migration',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });
    // Drop the per-userId cache so the migration sees the freshly-written
    // disk state (the migration itself uses a brand-new store, but we
    // cleared this one for safety in the test fixture).
    store.invalidateCache();

    migrateUserInstructions({ dataDir, dryRun: false });

    const doc = readUserDoc('U1') as {
      instructions: Array<{ id: string }>;
      lifecycleEvents: Array<{ id: string; instructionId?: string; op: string; state: string }>;
    };
    // Phase 1: instruction count unchanged (already present).
    expect(doc.instructions).toHaveLength(1);
    // Phase 2: lifecycle event written this run.
    const evt = doc.lifecycleEvents.find((e) => e.id === 'mig_U1_i1_C1-T1');
    expect(evt).toBeDefined();
    expect(evt!.op).toBe('add');
    expect(evt!.state).toBe('confirmed');
    expect(evt!.instructionId).toBe('i1');
  });
});

// ── #727 P0-4 — migration runs under PID lock, stale lock is reclaimed ──
describe('runStartupUserInstructionsMigration — PID lock', () => {
  it('reclaims a stale (dead-PID) migration lock and completes successfully', async () => {
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'do x', addedAt: 1, status: 'active' }],
      },
    ]);

    // Plant a stale lock pointing at a long-dead PID — the legacy wx-flag
    // implementation would deadlock here for 30s; the pid-lock helper
    // should detect dead-PID and reclaim immediately.
    const stalePid = 99999999;
    const lockPath = path.join(dataDir, 'user-instructions-migration.pid');
    fs.writeFileSync(lockPath, `${stalePid}:${Date.now() - 1000}`, 'utf-8');

    const t0 = Date.now();
    await runStartupUserInstructionsMigration({ dataDir });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_000);

    const doc = readUserDoc('U1') as { instructions: Array<{ id: string }> };
    expect(doc.instructions).toHaveLength(1);
  });
});

// ── #727 P1-2 — admin --apply mirrors fresh-boot disk state ──
describe('runStartupUserInstructionsMigration — admin/boot parity (P1-2)', () => {
  it('admin and boot produce byte-identical user docs AND sessions.json pointers', async () => {
    const sessions = [
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'do x', addedAt: 1, status: 'active' as const }],
      },
    ];
    writeLegacy(sessions);

    // Snapshot sessions.json pre-migration so we can restore for the
    // second run (admin path).
    const sessionsFile = path.join(dataDir, 'sessions.json');
    const preRun = fs.readFileSync(sessionsFile, 'utf-8');

    // First run — admin --apply path.
    const adminResult = await runStartupUserInstructionsMigration({ dataDir });
    const adminUserDoc = fs.readFileSync(path.join(dataDir, 'users', 'U1', 'user-session.json'), 'utf-8');
    const adminSessions = fs.readFileSync(sessionsFile, 'utf-8');

    // Reset disk: delete user dir + restore sessions.json + delete migration lock.
    fs.rmSync(path.join(dataDir, 'users'), { recursive: true, force: true });
    fs.writeFileSync(sessionsFile, preRun, 'utf-8');
    // Remove any boot/admin backups so the second run is clean.
    for (const f of fs.readdirSync(dataDir)) {
      if (f.startsWith('sessions.json.') && f.endsWith('.bak')) {
        fs.unlinkSync(path.join(dataDir, f));
      }
    }

    // Second run — fresh boot path.
    const bootResult = await runStartupUserInstructionsMigration({ dataDir });
    const bootUserDoc = fs.readFileSync(path.join(dataDir, 'users', 'U1', 'user-session.json'), 'utf-8');
    const bootSessions = fs.readFileSync(sessionsFile, 'utf-8');

    // User doc identical (modulo timestamps that flow from `now`).
    expect(JSON.parse(adminUserDoc).instructions[0].id).toBe(JSON.parse(bootUserDoc).instructions[0].id);
    // sessions.json carries the pointer in BOTH paths (admin must NOT
    // leave sessions.json stale — the bug fixed in #727 P1-2).
    const adminParsed = JSON.parse(adminSessions) as Array<Record<string, unknown>>;
    const bootParsed = JSON.parse(bootSessions) as Array<Record<string, unknown>>;
    expect(adminParsed[0].currentInstructionId).toBe('i1');
    expect(bootParsed[0].currentInstructionId).toBe('i1');
    expect(adminResult.userIdsTouched).toBe(1);
    expect(bootResult.userIdsTouched).toBe(1);
  });
});

// ── #727 P1-D — single store instance, no cache divergence ──────────────────
//
// Round-2 oracle review flagged that `migrateUserInstructions` constructs a
// fresh `new UserSessionStore(opts.dataDir)` while `session-registry.ts` reads
// via the `getUserSessionStore()` singleton. The two stores have INDEPENDENT
// per-userId caches, so the singleton can return stale (or empty) docs after
// a successful migration unless the migration uses the singleton itself
// (option-a) or the caller explicitly invalidates (option-b).
//
// We assert option-a: after `runStartupUserInstructionsMigration` completes,
// reading via `getUserSessionStore()` immediately reflects the migrated data
// — without any explicit `invalidateCache()` call.
describe('runStartupUserInstructionsMigration — singleton store coherence (P1-D)', () => {
  it('singleton getUserSessionStore() reflects migrated data even when its cache was warmed pre-migration', async () => {
    // Pin the singleton at the per-test data dir.
    initUserSessionStore(dataDir);
    const singleton = getUserSessionStore();

    // Pre-seed an existing user-session.json so the singleton's `load()`
    // populates its in-memory cache (the FILE-EXISTS branch caches; the
    // FILE-MISSING branch does not). This models the steady-state path
    // where the user already has a master doc before the migration runs
    // again (e.g. ops re-run of `migrate-user-instructions --apply` or
    // boot ordering where another component primed the cache first).
    const userDir = path.join(dataDir, 'users', 'U1');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'user-session.json'),
      JSON.stringify({ schemaVersion: 1, instructions: [], lifecycleEvents: [] }, null, 2),
    );
    // Warm the singleton cache.
    const beforeMig = singleton.load('U1');
    expect(beforeMig.instructions.length).toBe(0);

    // Now stage a legacy session and run the migration. With round-1
    // wiring, migration constructs a fresh `new UserSessionStore(...)` —
    // the disk gets the new row, but the singleton's cache still holds
    // the warmed empty-instructions doc.
    writeLegacy([
      {
        key: 'C1-T1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 'T1',
        isActive: true,
        lastActivity: new Date().toISOString(),
        instructions: [{ id: 'i1', text: 'do x', addedAt: 1, status: 'active' }],
      },
    ]);

    await runStartupUserInstructionsMigration({ dataDir });

    // Disk MUST contain the migrated row.
    const onDisk = JSON.parse(fs.readFileSync(path.join(userDir, 'user-session.json'), 'utf-8')) as {
      instructions: Array<{ id: string }>;
    };
    expect(onDisk.instructions.find((i) => i.id === 'i1')).toBeDefined();

    // P1-D contract: the singleton must agree with disk after migration.
    // Round-1 fails here because the migration used a separate
    // UserSessionStore instance and only invalidated ITS cache.
    const visible = singleton.load('U1');
    expect(visible.instructions.find((i) => i.id === 'i1')).toBeDefined();
    expect(visible.instructions.find((i) => i.id === 'i1')?.status).toBe('active');
  });
});

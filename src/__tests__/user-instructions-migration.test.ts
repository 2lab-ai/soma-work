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
  migrateUserInstructions,
  type LegacySession,
  type MigrationResult,
} from '../user-instructions-migration';
import { UserSessionStore } from '../user-session-store';

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

    const backupFiles = fs
      .readdirSync(dataDir)
      .filter((f) => f.startsWith('sessions.json.') && f.endsWith('.bak'));
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
    const backupFiles = fs
      .readdirSync(dataDir)
      .filter((f) => f.startsWith('sessions.json.') && f.endsWith('.bak'));
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

    expect(after1).toBe(after2);
    // The second pass should report 0 new instructions
    expect(r2.userIdsTouched).toBe(r1.userIdsTouched);
    expect(r2.newInstructions).toBe(0);
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

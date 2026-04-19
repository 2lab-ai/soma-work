import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeCctLegacyAttachmentSlot,
  makeCctSetupSlot,
  makeV1OAuthSlot,
  makeV1SetupSlot,
  makeV1Snapshot,
  makeV2Snapshot,
} from './__fixtures__/snapshots';
import { migrateLegacyCooldowns } from './migrate';
import { CctStore, RevisionConflictError } from './store';
import type { CctStoreSnapshot, LegacyV1Snapshot } from './types';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cct-store-test-'));
}

describe('CctStore.load', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates empty v2 snapshot when file is missing', async () => {
    const store = new CctStore(path.join(tmp, 'cct-store.json'));
    const snap = await store.load();
    expect(snap).toEqual({
      version: 2,
      revision: 0,
      registry: { slots: [] },
      state: {},
    });
  });
});

describe('CctStore save/load round-trip', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('preserves both AuthKey CCT sub-arms (setup + legacy-attachment)', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const store = new CctStore(filePath);
    const loaded = await store.load();

    const s1 = makeCctSetupSlot();
    const s2 = makeCctLegacyAttachmentSlot();
    const next: CctStoreSnapshot = {
      ...loaded,
      revision: loaded.revision + 1,
      registry: { activeKeyId: s1.keyId, slots: [s1, s2] },
      state: {
        [s1.keyId]: { authState: 'healthy', activeLeases: [] },
        [s2.keyId]: { authState: 'healthy', activeLeases: [] },
      },
    };
    await store.save(loaded.revision, next);

    const store2 = new CctStore(filePath);
    const readBack = await store2.load();
    expect(readBack.version).toBe(2);
    expect(readBack.registry.slots).toHaveLength(2);
    const [r1, r2] = readBack.registry.slots;
    expect(r1.kind).toBe('cct');
    expect(r2.kind).toBe('cct');
    if (r1.kind !== 'cct' || r2.kind !== 'cct') throw new Error('unreachable');
    expect(r1.source).toBe('setup');
    expect(r2.source).toBe('legacy-attachment');
    if (r2.source !== 'legacy-attachment') throw new Error('unreachable');
    expect(r2.oauthAttachment.accessToken).toBe('at-xyz');
    expect(r2.oauthAttachment.acknowledgedConsumerTosRisk).toBe(true);
    expect(readBack.revision).toBe(1);
  });

  it('durable write: no leftover tmp file after save', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const store = new CctStore(filePath);
    const snap = await store.load();
    await store.save(snap.revision, { ...snap, revision: snap.revision + 1 });
    const entries = await fs.readdir(tmp);
    const leftovers = entries.filter((e) => e.startsWith('cct-store.json.tmp.'));
    expect(leftovers).toEqual([]);
  });
});

describe('CctStore CAS', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('save throws RevisionConflictError when expected revision mismatches', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const store = new CctStore(filePath);
    const snap = await store.load();

    // First writer commits revision 1
    await store.save(snap.revision, { ...snap, revision: snap.revision + 1 });

    // Second writer with stale expected=0 fails
    await expect(store.save(0, { ...snap, revision: 1 })).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('concurrent mutate: loser retries and sees winner edit', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const store = new CctStore(filePath);
    // seed with two slots
    const s1 = makeCctSetupSlot();
    const s2 = makeCctSetupSlot({ keyId: '01HZZZAAAA0000000000000099', name: 'cct9' });
    const initial = await store.load();
    await store.save(initial.revision, {
      ...initial,
      revision: initial.revision + 1,
      registry: { slots: [s1, s2] },
      state: {
        [s1.keyId]: { authState: 'healthy', activeLeases: [] },
        [s2.keyId]: { authState: 'healthy', activeLeases: [] },
      },
    });

    // Two concurrent mutations — both set cooldown on a different slot.
    const [result1, result2] = await Promise.all([
      store.mutate((s) => {
        s.state[s1.keyId].cooldownUntil = '2026-04-19T00:00:00.000Z';
      }),
      store.mutate((s) => {
        s.state[s2.keyId].cooldownUntil = '2026-04-20T00:00:00.000Z';
      }),
    ]);
    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();

    const final = await new CctStore(filePath).load();
    expect(final.state[s1.keyId].cooldownUntil).toBe('2026-04-19T00:00:00.000Z');
    expect(final.state[s2.keyId].cooldownUntil).toBe('2026-04-20T00:00:00.000Z');
    // Two successive commits after seed: revisions 2 and 3 (seed left us at 1).
    expect(final.revision).toBe(3);
  });

  it('mutate retries up to 5 on CAS conflict then rethrows', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const store = new CctStore(filePath);
    await store.load();

    // Force RevisionConflictError on every save by stubbing save to always throw.
    const saveSpy = vi.spyOn(store, 'save').mockImplementation(async (expected: number) => {
      throw new RevisionConflictError(expected, expected + 1);
    });
    let callCount = 0;
    await expect(
      store.mutate((_s) => {
        callCount++;
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    // 1 initial + 5 retries = 6 attempts.
    expect(callCount).toBe(6);
    expect(saveSpy).toHaveBeenCalledTimes(6);
    saveSpy.mockRestore();
  });
});

describe('CctStore.mutate deep-clone safety', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('callback cannot corrupt store by retaining snap ref after mutate returns', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const store = new CctStore(filePath);

    const s1 = makeCctSetupSlot();
    await store.mutate((snap) => {
      snap.registry.slots.push(s1);
      snap.state[s1.keyId] = { authState: 'healthy', activeLeases: [] };
    });

    // Grab a ref and mutate it after mutate returned — must not affect disk.
    let escaped: CctStoreSnapshot | undefined;
    await store.mutate((snap) => {
      escaped = snap;
    });
    if (!escaped) throw new Error('escaped ref missing');
    escaped.registry.slots[0].name = 'HACKED';
    escaped.state[s1.keyId].cooldownUntil = '9999-01-01T00:00:00.000Z';

    const fresh = await new CctStore(filePath).load();
    expect(fresh.registry.slots[0].name).toBe('cct1');
    expect(fresh.state[s1.keyId].cooldownUntil).toBeUndefined();
  });
});

describe('CctStore.withLock serialization', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('serializes concurrent work so sentinels do not interleave', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    // Ensure file exists so lock path's realpath resolves.
    await new CctStore(filePath).load();
    const store = new CctStore(filePath);

    const events: string[] = [];
    const run = (tag: string) =>
      store.withLock(async () => {
        events.push(`start:${tag}`);
        await new Promise((r) => setTimeout(r, 25));
        events.push(`end:${tag}`);
      });

    await Promise.all([run('A'), run('B')]);

    // Each start must be immediately followed by its matching end (no interleaving).
    for (let i = 0; i < events.length; i += 2) {
      const start = events[i];
      const end = events[i + 1];
      expect(start.startsWith('start:')).toBe(true);
      expect(end.startsWith('end:')).toBe(true);
      expect(start.slice(6)).toBe(end.slice(4));
    }
  });
});

describe('migrateLegacyCooldowns', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('matches legacy entries by name, warns on orphans, renames source', async () => {
    const legacyPath = path.join(tmp, 'token-cooldowns.json');
    const entries = [
      { name: 'cct1', cooldownUntil: '2026-04-20T12:00:00.000Z' },
      { name: 'ghost', cooldownUntil: '2026-04-20T12:00:00.000Z' },
    ];
    await fs.writeFile(legacyPath, JSON.stringify({ entries }), 'utf8');

    const s1 = makeCctSetupSlot({ name: 'cct1' });
    const snap = makeV2Snapshot({ slots: [s1] });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await migrateLegacyCooldowns(snap, tmp);
    expect(result.didRename).toBe(true);
    const after = result.snapshot;
    expect(after.state[s1.keyId].cooldownUntil).toBe('2026-04-20T12:00:00.000Z');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("orphan legacy cooldown 'ghost'"));
    warnSpy.mockRestore();

    // Source renamed.
    await expect(fs.stat(legacyPath)).rejects.toThrow();
    const siblings = await fs.readdir(tmp);
    const renamed = siblings.find((e) => e.startsWith('token-cooldowns.json.migrated.'));
    expect(renamed).toBeTruthy();
  });

  it('is a no-op when legacy file does not exist', async () => {
    const snap = makeV2Snapshot();
    const result = await migrateLegacyCooldowns(snap, tmp);
    expect(result.didRename).toBe(false);
    expect(result.snapshot).toBe(snap);
  });
});

// ─────────────────────────────────────────────────────────────────────
// PR-A: load() persists v1 → v2 migration
// ─────────────────────────────────────────────────────────────────────
describe('CctStore.load — v1 → v2 migration on first read', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('upgrades a v1 file on disk: returned snapshot + on-disk file are both v2', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const v1: LegacyV1Snapshot = makeV1Snapshot({
      revision: 7,
      activeSlotId: 'k-1',
      slots: [makeV1SetupSlot({ slotId: 'k-1' }), makeV1OAuthSlot({ slotId: 'k-2' })],
    });
    await fs.writeFile(filePath, JSON.stringify(v1, null, 2), 'utf8');

    const store = new CctStore(filePath);
    const loaded = await store.load();
    expect(loaded.version).toBe(2);
    expect(loaded.registry.activeKeyId).toBe('k-1');
    expect(loaded.registry.slots.map((s) => s.keyId)).toEqual(['k-1', 'k-2']);

    // Round-trip: re-reading the raw file must show v2 (persistence worked).
    const diskRaw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(diskRaw.version).toBe(2);
    expect(diskRaw.registry.activeKeyId).toBe('k-1');
    expect('activeSlotId' in diskRaw.registry).toBe(false);
  });

  it('v2 file is not re-written on load (no-op load preserves file mtime bytes)', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const snap = makeV2Snapshot({ revision: 3, slots: [makeCctSetupSlot({ keyId: 'k-a' })] });
    await fs.writeFile(filePath, JSON.stringify(snap, null, 2), 'utf8');
    const before = await fs.readFile(filePath, 'utf8');

    const store = new CctStore(filePath);
    const loaded = await store.load();
    expect(loaded.version).toBe(2);
    expect(loaded.revision).toBe(3);

    const after = await fs.readFile(filePath, 'utf8');
    expect(after).toBe(before);
  });

  it('race: concurrent load on a fresh v1 file produces a single consistent v2 on disk', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const v1 = makeV1Snapshot({ slots: [makeV1SetupSlot({ slotId: 'k-z' })] });
    await fs.writeFile(filePath, JSON.stringify(v1, null, 2), 'utf8');

    const results = await Promise.all([
      new CctStore(filePath).load(),
      new CctStore(filePath).load(),
      new CctStore(filePath).load(),
    ]);
    for (const r of results) {
      expect(r.version).toBe(2);
      expect(r.registry.slots[0].keyId).toBe('k-z');
    }
    const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(disk.version).toBe(2);
  });

  it('legacy-cooldown migration on a v1 snapshot is folded in and persisted as v2', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const v1 = makeV1Snapshot({
      slots: [makeV1SetupSlot({ slotId: 'k-c', name: 'cctC' })],
    });
    await fs.writeFile(filePath, JSON.stringify(v1, null, 2), 'utf8');
    const legacyPath = path.join(tmp, 'token-cooldowns.json');
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ entries: [{ name: 'cctC', cooldownUntil: '2026-04-30T00:00:00.000Z' }] }),
      'utf8',
    );

    const store = new CctStore(filePath);
    const loaded = await store.load();
    expect(loaded.version).toBe(2);
    expect(loaded.state['k-c'].cooldownUntil).toBe('2026-04-30T00:00:00.000Z');

    // The on-disk file must also reflect v2 + folded cooldown.
    const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(disk.version).toBe(2);
    expect(disk.state['k-c'].cooldownUntil).toBe('2026-04-30T00:00:00.000Z');
    // Legacy file renamed.
    await expect(fs.stat(legacyPath)).rejects.toThrow();
  });

  it('load() is safe when only the legacy cooldown file is present (no main v1 file)', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const legacyPath = path.join(tmp, 'token-cooldowns.json');
    // No slot named 'ghostly' exists — the migrator warns but does not throw.
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ entries: [{ name: 'ghostly', cooldownUntil: '2026-05-01T00:00:00.000Z' }] }),
      'utf8',
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new CctStore(filePath);
    const loaded = await store.load();
    expect(loaded.version).toBe(2);
    expect(loaded.registry.slots).toEqual([]);
    warnSpy.mockRestore();
  });
});

describe('CctStore.load — malformed v2 recovery', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reinterprets "version:2 with v1 body" as v1 and re-runs migration', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    // Shape observed on a production dev host: version was flipped to 2 but
    // slots/registry are still v1-shaped and `state` is absent entirely.
    const malformed = {
      version: 2,
      revision: 5135,
      registry: {
        slots: [
          {
            slotId: '01KPG2HKB3DXZY74QWVMBNC2X9',
            name: 'ai2',
            kind: 'setup_token',
            value: 'sk-ant-oat01-aaa',
            createdAt: '2026-04-18T10:35:21.827Z',
          },
          {
            slotId: '01KPG2HKBZJDTF9QPN0H19WHS5',
            name: 'ai3',
            kind: 'setup_token',
            value: 'sk-ant-oat01-bbb',
            createdAt: '2026-04-18T10:35:21.855Z',
          },
        ],
        activeSlotId: '01KPG2HKB3DXZY74QWVMBNC2X9',
      },
    };
    await fs.writeFile(filePath, JSON.stringify(malformed, null, 2), 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new CctStore(filePath);
    const loaded = await store.load();

    // The in-memory snapshot is valid v2.
    expect(loaded.version).toBe(2);
    expect(loaded.revision).toBe(5135);
    expect(loaded.registry.activeKeyId).toBe('01KPG2HKB3DXZY74QWVMBNC2X9');
    expect(loaded.registry.slots).toHaveLength(2);
    for (const slot of loaded.registry.slots) {
      expect(slot.kind).toBe('cct');
      if (slot.kind !== 'cct') throw new Error('unreachable');
      expect(slot.source).toBe('setup');
      if (slot.source !== 'setup') throw new Error('unreachable');
      expect(typeof slot.keyId).toBe('string');
      expect(slot.keyId.length).toBeGreaterThan(0);
      expect(typeof slot.setupToken).toBe('string');
    }
    expect(loaded.state).toEqual({});

    // Disk is rewritten as proper v2.
    const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(disk.version).toBe(2);
    expect(disk.registry.activeKeyId).toBe('01KPG2HKB3DXZY74QWVMBNC2X9');
    expect('activeSlotId' in disk.registry).toBe(false);
    expect(disk.registry.slots[0]).toMatchObject({ kind: 'cct', source: 'setup' });
    expect(disk.registry.slots[0].setupToken).toBe('sk-ant-oat01-aaa');
    expect('slotId' in disk.registry.slots[0]).toBe(false);
    expect('value' in disk.registry.slots[0]).toBe(false);
    expect(disk.state).toEqual({});

    // We surface a single warning so operators notice the repair.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('defaults missing `state` to {} on an otherwise valid v2 file', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const missingStateV2 = {
      version: 2,
      revision: 1,
      registry: {
        activeKeyId: 'k-only',
        slots: [
          {
            kind: 'cct',
            source: 'setup',
            keyId: 'k-only',
            name: 'only',
            setupToken: 'sk-ant-oat01-solo',
            createdAt: '2026-04-18T00:00:00.000Z',
          },
        ],
      },
    };
    await fs.writeFile(filePath, JSON.stringify(missingStateV2, null, 2), 'utf8');

    const store = new CctStore(filePath);
    const loaded = await store.load();
    expect(loaded.version).toBe(2);
    // In-memory repair: subsequent `snap.state[keyId]` reads are safe.
    expect(loaded.state).toEqual({});

    // The first write after a repaired read persists the normalised shape.
    await store.mutate((snap) => {
      snap.state[snap.registry.slots[0].keyId] = { authState: 'healthy', activeLeases: [] };
    });
    const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(disk.state['k-only']).toEqual({ authState: 'healthy', activeLeases: [] });
  });
});

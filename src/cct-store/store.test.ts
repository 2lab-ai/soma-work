import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeV2Snapshot } from './__fixtures__/snapshots';
import { migrateLegacyCooldowns } from './migrate';
import { CctStore, RevisionConflictError } from './store';
import type { CctStoreSnapshot, OAuthCredentialsSlot, SetupTokenSlot } from './types';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cct-store-test-'));
}

function setupSlot(overrides: Partial<SetupTokenSlot> = {}): SetupTokenSlot {
  return {
    slotId: '01HZZZAAAA0000000000000001',
    name: 'cct1',
    kind: 'setup_token',
    value: 'sk-ant-oat01-abc',
    createdAt: '2026-04-18T00:00:00.000Z',
    ...overrides,
  };
}

function oauthSlot(overrides: Partial<OAuthCredentialsSlot> = {}): OAuthCredentialsSlot {
  return {
    slotId: '01HZZZAAAA0000000000000002',
    name: 'cct2',
    kind: 'oauth_credentials',
    credentials: {
      accessToken: 'at-xyz',
      refreshToken: 'rt-xyz',
      expiresAtMs: 1_900_000_000_000,
      scopes: ['user:inference', 'user:profile'],
      rateLimitTier: 'default_claude_max_5x',
      subscriptionType: 'max_5x',
    },
    createdAt: '2026-04-18T00:00:00.000Z',
    acknowledgedConsumerTosRisk: true,
    ...overrides,
  };
}

describe('CctStore.load', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates empty snapshot when file is missing', async () => {
    const store = new CctStore(path.join(tmp, 'cct-store.json'));
    const snap = await store.load();
    expect(snap).toEqual(makeV2Snapshot());
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

  it('preserves both TokenSlot union kinds', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const store = new CctStore(filePath);
    const loaded = await store.load();

    const s1 = setupSlot();
    const s2 = oauthSlot();
    const next: CctStoreSnapshot = {
      ...loaded,
      revision: loaded.revision + 1,
      registry: { activeSlotId: s1.slotId, slots: [s1, s2] },
      state: {
        [s1.slotId]: { authState: 'healthy', activeLeases: [] },
        [s2.slotId]: { authState: 'healthy', activeLeases: [] },
      },
    };
    await store.save(loaded.revision, next);

    const store2 = new CctStore(filePath);
    const readBack = await store2.load();
    expect(readBack.registry.slots).toHaveLength(2);
    expect(readBack.registry.slots[0].kind).toBe('setup_token');
    expect(readBack.registry.slots[1].kind).toBe('oauth_credentials');
    if (readBack.registry.slots[1].kind === 'oauth_credentials') {
      expect(readBack.registry.slots[1].credentials.accessToken).toBe('at-xyz');
      expect(readBack.registry.slots[1].acknowledgedConsumerTosRisk).toBe(true);
    }
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
    const s1 = setupSlot();
    const s2 = setupSlot({ slotId: '01HZZZAAAA0000000000000099', name: 'cct9' });
    const initial = await store.load();
    await store.save(initial.revision, {
      ...initial,
      revision: initial.revision + 1,
      registry: { slots: [s1, s2] },
      state: {
        [s1.slotId]: { authState: 'healthy', activeLeases: [] },
        [s2.slotId]: { authState: 'healthy', activeLeases: [] },
      },
    });

    // Two concurrent mutations — both set cooldown on a different slot.
    const [result1, result2] = await Promise.all([
      store.mutate((s) => {
        s.state[s1.slotId].cooldownUntil = '2026-04-19T00:00:00.000Z';
      }),
      store.mutate((s) => {
        s.state[s2.slotId].cooldownUntil = '2026-04-20T00:00:00.000Z';
      }),
    ]);
    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();

    const final = await new CctStore(filePath).load();
    expect(final.state[s1.slotId].cooldownUntil).toBe('2026-04-19T00:00:00.000Z');
    expect(final.state[s2.slotId].cooldownUntil).toBe('2026-04-20T00:00:00.000Z');
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

    const s1 = setupSlot();
    await store.mutate((snap) => {
      snap.registry.slots.push(s1);
      snap.state[s1.slotId] = { authState: 'healthy', activeLeases: [] };
    });

    // Grab a ref and mutate it after mutate returned — must not affect disk.
    let escaped: CctStoreSnapshot | undefined;
    await store.mutate((snap) => {
      escaped = snap;
    });
    if (!escaped) throw new Error('escaped ref missing');
    escaped.registry.slots[0].name = 'HACKED';
    escaped.state[s1.slotId].cooldownUntil = '9999-01-01T00:00:00.000Z';

    const fresh = await new CctStore(filePath).load();
    expect(fresh.registry.slots[0].name).toBe('cct1');
    expect(fresh.state[s1.slotId].cooldownUntil).toBeUndefined();
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

    const s1 = setupSlot({ name: 'cct1' });
    const snap: CctStoreSnapshot = makeV2Snapshot({
      registry: { slots: [s1] },
      state: { [s1.slotId]: { authState: 'healthy', activeLeases: [] } },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after = await migrateLegacyCooldowns(snap, tmp);
    expect(after.state[s1.slotId].cooldownUntil).toBe('2026-04-20T12:00:00.000Z');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("orphan legacy cooldown 'ghost'"));
    warnSpy.mockRestore();

    // Source renamed.
    await expect(fs.stat(legacyPath)).rejects.toThrow();
    const siblings = await fs.readdir(tmp);
    const renamed = siblings.find((e) => e.startsWith('token-cooldowns.json.migrated.'));
    expect(renamed).toBeTruthy();
  });

  it('is a no-op when legacy file does not exist', async () => {
    const snap: CctStoreSnapshot = makeV2Snapshot();
    const after = await migrateLegacyCooldowns(snap, tmp);
    expect(after).toEqual(snap);
  });
});

describe('CctStore v2 upgrade', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeV1SnapshotFile(filePath: string, snap: any): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(snap, null, 2), 'utf8');
  }

  it('repeated load() on a v1 file returns synthesized v2 without writing to disk', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const v1Oauth = {
      slotId: '01HZZZAAAA0000000000000200',
      name: 'oauth1',
      kind: 'oauth_credentials',
      credentials: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAtMs: 1_900_000_000_000,
        scopes: ['user:profile', 'user:inference'],
      },
      createdAt: '2026-04-18T00:00:00.000Z',
      acknowledgedConsumerTosRisk: true,
    };
    const v1Snap = {
      version: 1,
      revision: 2,
      registry: { slots: [v1Oauth] },
      state: { [v1Oauth.slotId]: { authState: 'healthy', activeLeases: [] } },
    };
    await writeV1SnapshotFile(filePath, v1Snap);
    const mtimeBefore = (await fs.stat(filePath)).mtimeMs;

    const store = new CctStore(filePath);
    const a = await store.load();
    const b = await store.load();
    expect(a.version).toBe(2);
    expect(b.version).toBe(2);
    // Synthesised configDir points under the dataDir
    const [slotA] = a.registry.slots as OAuthCredentialsSlot[];
    expect(slotA.configDir).toBe(path.join(tmp, 'cct-store.dirs', v1Oauth.slotId));

    const mtimeAfter = (await fs.stat(filePath)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    // And the raw bytes on disk are still v1.
    const rawBytes = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(rawBytes.version).toBe(1);
  });

  it('upgradeIfNeeded persists v2, mkdir 0700 each oauth configDir, revision +1', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const v1Oauth = {
      slotId: '01HZZZAAAA0000000000000201',
      name: 'oauth1',
      kind: 'oauth_credentials',
      credentials: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAtMs: 1_900_000_000_000,
        scopes: ['user:profile', 'user:inference'],
      },
      createdAt: '2026-04-18T00:00:00.000Z',
      acknowledgedConsumerTosRisk: true,
    };
    const v1Setup = {
      slotId: '01HZZZAAAA0000000000000202',
      name: 'setup1',
      kind: 'setup_token',
      value: 'sk-ant-oat01-aaa',
      createdAt: '2026-04-18T00:00:00.000Z',
    };
    const v1Snap = {
      version: 1,
      revision: 5,
      registry: { slots: [v1Oauth, v1Setup] },
      state: {},
    };
    await writeV1SnapshotFile(filePath, v1Snap);

    const store = new CctStore(filePath);
    const upgraded = await store.upgradeIfNeeded();
    expect(upgraded).toBe(true);

    // Post-upgrade on-disk bytes must be v2, revision=6.
    const rawBytes = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(rawBytes.version).toBe(2);
    expect(rawBytes.revision).toBe(6);
    const expectedDir = path.join(tmp, 'cct-store.dirs', v1Oauth.slotId);
    expect(rawBytes.registry.slots[0].configDir).toBe(expectedDir);
    // setup_token slot should NOT have a configDir field.
    expect(rawBytes.registry.slots[1].configDir).toBeUndefined();

    // The configDir exists and has mode 0o700 bits set.
    const st = await fs.stat(expectedDir);
    expect(st.isDirectory()).toBe(true);
    // On POSIX, check that no group/other bits leak through (mask 0o077 must be 0).
    if (process.platform !== 'win32') {
      expect(st.mode & 0o077).toBe(0);
    }
  });

  it('upgradeIfNeeded on an already-v2 file is a no-op and returns false', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const store = new CctStore(filePath);
    // First call bootstraps (file was missing → synthesised v2 on lock acquire).
    const first = await store.upgradeIfNeeded();
    expect(first).toBe(false);

    const rev1 = (await store.load()).revision;
    const second = await store.upgradeIfNeeded();
    expect(second).toBe(false);
    expect((await store.load()).revision).toBe(rev1);
  });

  it('upgradeIfNeeded serialises concurrent calls via the cross-process lock (single persist)', async () => {
    const filePath = path.join(tmp, 'cct-store.json');
    const v1Snap = {
      version: 1,
      revision: 0,
      registry: { slots: [] },
      state: {},
    };
    await writeV1SnapshotFile(filePath, v1Snap);

    const store = new CctStore(filePath);
    const results = await Promise.all([store.upgradeIfNeeded(), store.upgradeIfNeeded(), store.upgradeIfNeeded()]);
    // Exactly one call should have persisted a v2 write.
    const trueCount = results.filter((r) => r === true).length;
    expect(trueCount).toBe(1);
    const rawBytes = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(rawBytes.version).toBe(2);
    // Revision jumped exactly once.
    expect(rawBytes.revision).toBe(1);
  });

  it('upgradeIfNeeded uses the raw read (not load()) — stale v1 file is still persisted', async () => {
    // If upgradeIfNeeded were to call `load()` instead of `readSnapshotRaw()`,
    // the synthesised v2 from the load-time migrator would cause the routine
    // to return `false` without ever persisting — that is the exact bug the
    // codex nit protects against. We verify by spying on store.load and
    // asserting it is NOT consulted during the upgrade path.
    const filePath = path.join(tmp, 'cct-store.json');
    const v1Snap = {
      version: 1,
      revision: 1,
      registry: { slots: [] },
      state: {},
    };
    await writeV1SnapshotFile(filePath, v1Snap);
    const store = new CctStore(filePath);

    const loadSpy = vi.spyOn(store, 'load');
    const upgraded = await store.upgradeIfNeeded();
    expect(upgraded).toBe(true);
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();

    const rawBytes = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(rawBytes.version).toBe(2);
    expect(rawBytes.revision).toBe(2);
  });
});

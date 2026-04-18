import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateV1ToV2 } from './migrate-v2';
import type { CctStoreSnapshot, OAuthCredentialsSlot, SetupTokenSlot, SnapshotV1 } from './types';

const DATA_DIR = '/tmp/cct-fixture';

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
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 1_900_000_000_000,
      scopes: ['user:profile', 'user:inference'],
    },
    createdAt: '2026-04-18T00:00:00.000Z',
    acknowledgedConsumerTosRisk: true,
    ...overrides,
  };
}

describe('migrateV1ToV2 (pure)', () => {
  it('attaches configDir to each oauth_credentials slot; setup_token untouched', () => {
    const s1 = setupSlot({ slotId: '01HZZZAAAA0000000000000001', name: 's1' });
    const s2 = oauthSlot({ slotId: '01HZZZAAAA0000000000000002', name: 'o1' });
    const v1: SnapshotV1 = {
      version: 1,
      revision: 3,
      registry: { activeSlotId: s2.slotId, slots: [s1, s2] },
      state: {
        [s1.slotId]: { authState: 'healthy', activeLeases: [] },
        [s2.slotId]: { authState: 'healthy', activeLeases: [] },
      },
    };

    const v2 = migrateV1ToV2(v1, DATA_DIR);

    expect(v2.version).toBe(2);
    expect(v2.revision).toBe(3);
    // Setup-token slot carried through as-is (no configDir on its type).
    const migratedSetup = v2.registry.slots[0] as SetupTokenSlot;
    expect(migratedSetup).toEqual(s1);
    // OAuth slot gained the computed configDir.
    const migratedOauth = v2.registry.slots[1] as OAuthCredentialsSlot;
    expect(migratedOauth.configDir).toBe(path.join(DATA_DIR, 'cct-store.dirs', s2.slotId));
    // State map preserved.
    expect(v2.state).toEqual(v1.state);
  });

  it('is idempotent when fed a v2 snapshot (deep-equal identity)', () => {
    const o = oauthSlot({ configDir: '/some/dir' });
    const v2: CctStoreSnapshot = {
      version: 2,
      revision: 7,
      registry: { activeSlotId: o.slotId, slots: [o] },
      state: { [o.slotId]: { authState: 'healthy', activeLeases: [] } },
    };

    const out = migrateV1ToV2(v2, DATA_DIR);
    // Must be deep-equal — we allow either identity or structural equality.
    expect(out).toEqual(v2);
    // configDir on already-v2 oauth slot preserved unchanged.
    expect((out.registry.slots[0] as OAuthCredentialsSlot).configDir).toBe('/some/dir');
  });

  it('mixed kinds: two oauth + two setup_token — only oauth gets configDir', () => {
    const o1 = oauthSlot({ slotId: '01HZZZAAAA0000000000000010', name: 'o1' });
    const o2 = oauthSlot({ slotId: '01HZZZAAAA0000000000000011', name: 'o2' });
    const s1 = setupSlot({ slotId: '01HZZZAAAA0000000000000012', name: 's1' });
    const s2 = setupSlot({ slotId: '01HZZZAAAA0000000000000013', name: 's2', value: 'sk-ant-oat01-bbb' });
    const v1: SnapshotV1 = {
      version: 1,
      revision: 0,
      registry: { slots: [o1, s1, o2, s2] },
      state: {},
    };

    const v2 = migrateV1ToV2(v1, DATA_DIR);
    const [m1, m2, m3, m4] = v2.registry.slots;
    expect((m1 as OAuthCredentialsSlot).configDir).toBe(path.join(DATA_DIR, 'cct-store.dirs', o1.slotId));
    expect(m2).toEqual(s1);
    expect((m3 as OAuthCredentialsSlot).configDir).toBe(path.join(DATA_DIR, 'cct-store.dirs', o2.slotId));
    expect(m4).toEqual(s2);
  });

  it('empty snapshot: slots=[], state={}, revision=0 → v2 identity except version bump', () => {
    const v1: SnapshotV1 = {
      version: 1,
      revision: 0,
      registry: { slots: [] },
      state: {},
    };
    const v2 = migrateV1ToV2(v1, DATA_DIR);
    expect(v2).toEqual({
      version: 2,
      revision: 0,
      registry: { slots: [] },
      state: {},
    });
  });
});

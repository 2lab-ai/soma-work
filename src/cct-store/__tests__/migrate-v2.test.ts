/**
 * RED-first tests for the v1 → v2 AuthKey migrator (#575 PR-A).
 *
 * Covers the four transformation invariants listed in plan §3.4:
 *   (1) v1 setup_token → CctSlotWithSetup (kind:'cct', source:'setup')
 *   (2) v1 oauth_credentials → CctSlotLegacyAttachmentOnly (kind:'cct',
 *       source:'legacy-attachment', acknowledgedConsumerTosRisk:true)
 *   (3) slotId/activeSlotId renames to keyId/activeKeyId (registry + state)
 *   (4) idempotence — feeding v2 input yields a deep-clone v2 output
 */

import { describe, expect, it } from 'vitest';
import {
  makeCctSetupSlot,
  makeV1OAuthSlot,
  makeV1SetupSlot,
  makeV1Snapshot,
  makeV2Snapshot,
} from '../__fixtures__/snapshots';
import { migrateV1ToV2 } from '../migrate-v2';

describe('migrateV1ToV2', () => {
  it('maps v1 setup_token → CctSlotWithSetup (kind:cct, source:setup)', () => {
    const v1 = makeV1Snapshot({
      slots: [makeV1SetupSlot({ slotId: 'k-1', name: 'cct1', value: 'sk-ant-oat01-abc' })],
    });
    const v2 = migrateV1ToV2(v1);
    expect(v2.version).toBe(2);
    expect(v2.registry.slots).toHaveLength(1);
    const s = v2.registry.slots[0];
    expect(s.kind).toBe('cct');
    if (s.kind !== 'cct') throw new Error('unreachable');
    expect(s.source).toBe('setup');
    expect(s.keyId).toBe('k-1');
    expect(s.name).toBe('cct1');
    if (s.source !== 'setup') throw new Error('unreachable');
    expect(s.setupToken).toBe('sk-ant-oat01-abc');
    expect('oauthAttachment' in s ? s.oauthAttachment : undefined).toBeUndefined();
  });

  it('maps v1 oauth_credentials → CctSlotLegacyAttachmentOnly with acknowledgedConsumerTosRisk:true', () => {
    const v1 = makeV1Snapshot({
      slots: [
        makeV1OAuthSlot({
          slotId: 'k-2',
          name: 'cct2',
        }),
      ],
    });
    const v2 = migrateV1ToV2(v1);
    const s = v2.registry.slots[0];
    if (s.kind !== 'cct' || s.source !== 'legacy-attachment') {
      throw new Error('expected legacy-attachment CCT slot');
    }
    expect(s.keyId).toBe('k-2');
    expect(s.oauthAttachment.accessToken).toBe('at-xyz');
    expect(s.oauthAttachment.refreshToken).toBe('rt-xyz');
    expect(s.oauthAttachment.acknowledgedConsumerTosRisk).toBe(true);
    expect(s.oauthAttachment.scopes).toEqual(['user:inference', 'user:profile']);
    expect(s.oauthAttachment.subscriptionType).toBe('max_5x');
    expect(s.oauthAttachment.rateLimitTier).toBe('default_claude_max_5x');
  });

  it('renames slotId/activeSlotId to keyId/activeKeyId on registry and state map', () => {
    const v1 = makeV1Snapshot({
      activeSlotId: 'k-1',
      slots: [makeV1SetupSlot({ slotId: 'k-1', name: 'cct1' }), makeV1OAuthSlot({ slotId: 'k-2', name: 'cct2' })],
      state: {
        'k-1': { authState: 'healthy', activeLeases: [], cooldownUntil: '2026-04-19T00:00:00.000Z' },
        'k-2': { authState: 'refresh_failed', activeLeases: [] },
      },
    });
    const v2 = migrateV1ToV2(v1);
    expect(v2.registry.activeKeyId).toBe('k-1');
    // The TS type on v2 registries has no `activeSlotId` at all — check the
    // raw JSON shape for defensive drift (JSON.parse(stringify) flattens).
    const roundTripped = JSON.parse(JSON.stringify(v2)) as Record<string, unknown>;
    const registry = (roundTripped as { registry: Record<string, unknown> }).registry;
    expect('activeSlotId' in registry).toBe(false);
    expect(registry.activeKeyId).toBe('k-1');
    expect(v2.state['k-1'].cooldownUntil).toBe('2026-04-19T00:00:00.000Z');
    expect(v2.state['k-2'].authState).toBe('refresh_failed');
    expect(v2.registry.slots.map((s) => s.keyId)).toEqual(['k-1', 'k-2']);
  });

  it('is idempotent: v2 input → deep-cloned v2 output (no shared references)', () => {
    const v2 = makeV2Snapshot({
      activeKeyId: '01HZZZAAAA0000000000000001',
      slots: [makeCctSetupSlot()],
    });
    const migrated = migrateV1ToV2(v2);
    expect(migrated).toEqual(v2);
    // Mutating the result must not corrupt the input — proves deep clone.
    migrated.registry.slots[0].name = 'HACKED';
    expect(v2.registry.slots[0].name).toBe('cct1');
    expect(migrated).not.toBe(v2);
    expect(migrated.registry).not.toBe(v2.registry);
    expect(migrated.registry.slots).not.toBe(v2.registry.slots);
  });
});

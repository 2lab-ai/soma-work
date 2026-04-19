/**
 * Pure v1 → v2 migrator for the CCT store (#575 PR-A).
 *
 * Maps the v1 `TokenSlot` union onto the v2 `AuthKey` union and moves
 * `slotId` → `keyId` / `activeSlotId` → `activeKeyId` on the registry
 * and state maps.
 *
 * Mapping rules:
 *   • `kind: 'setup_token'`       → `{ kind: 'cct', source: 'setup', setupToken: slot.value }`
 *   • `kind: 'oauth_credentials'` → `{ kind: 'cct', source: 'legacy-attachment',
 *                                       oauthAttachment: { ...slot.credentials,
 *                                         acknowledgedConsumerTosRisk: true } }`
 *
 * Guarantees:
 *   • Pure — operates on a `structuredClone` of the input, never mutates it.
 *   • Idempotent — feeding a v2 snapshot in returns a deep-cloned v2 output.
 *   • No I/O — this module is safe to import from tests without filesystem
 *     or env-paths side effects.
 */

import type { AuthKey, CctSlotLegacyAttachmentOnly, CctSlotWithSetup, OAuthAttachment } from '../auth/auth-key';
import type {
  CctStoreSnapshot,
  LegacyV1OAuthCredentialsSlot,
  LegacyV1SetupTokenSlot,
  LegacyV1Snapshot,
  LegacyV1TokenSlot,
  PersistedSnapshot,
  SlotState,
} from './types';

function cloneSlotState(s: SlotState): SlotState {
  return structuredClone(s);
}

function v1SetupToCct(slot: LegacyV1SetupTokenSlot): CctSlotWithSetup {
  return {
    kind: 'cct',
    source: 'setup',
    keyId: slot.slotId,
    name: slot.name,
    setupToken: slot.value,
    createdAt: slot.createdAt,
  };
}

function v1OAuthToAttachment(slot: LegacyV1OAuthCredentialsSlot): OAuthAttachment {
  const c = slot.credentials;
  const out: OAuthAttachment = {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAtMs: c.expiresAtMs,
    scopes: [...c.scopes],
    acknowledgedConsumerTosRisk: true,
  };
  if (c.subscriptionType !== undefined) out.subscriptionType = c.subscriptionType;
  if (c.rateLimitTier !== undefined) out.rateLimitTier = c.rateLimitTier;
  return out;
}

function v1OAuthToCct(slot: LegacyV1OAuthCredentialsSlot): CctSlotLegacyAttachmentOnly {
  return {
    kind: 'cct',
    source: 'legacy-attachment',
    keyId: slot.slotId,
    name: slot.name,
    oauthAttachment: v1OAuthToAttachment(slot),
    createdAt: slot.createdAt,
  };
}

function v1SlotToAuthKey(slot: LegacyV1TokenSlot): AuthKey {
  if (slot.kind === 'setup_token') return v1SetupToCct(slot);
  return v1OAuthToCct(slot);
}

function migrateV1Body(snapshot: LegacyV1Snapshot): CctStoreSnapshot {
  const cloned = structuredClone(snapshot);
  const slots: AuthKey[] = cloned.registry.slots.map(v1SlotToAuthKey);
  const state: Record<string, SlotState> = {};
  // State keys were slotId in v1; they become keyId in v2 (same string).
  for (const [slotId, s] of Object.entries(cloned.state)) {
    state[slotId] = cloneSlotState(s);
  }
  const out: CctStoreSnapshot = {
    version: 2,
    revision: cloned.revision,
    registry: {
      slots,
      ...(cloned.registry.activeSlotId !== undefined ? { activeKeyId: cloned.registry.activeSlotId } : {}),
    },
    state,
  };
  return out;
}

/**
 * Idempotent v1 → v2 migration. If the input is already v2 we return a
 * deep clone (never the original reference) so callers can safely mutate
 * the result.
 */
export function migrateV1ToV2(snapshot: PersistedSnapshot): CctStoreSnapshot {
  if (snapshot.version === 2) {
    return structuredClone(snapshot);
  }
  return migrateV1Body(snapshot);
}

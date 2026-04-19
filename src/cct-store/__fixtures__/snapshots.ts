/**
 * Test fixtures for CctStoreSnapshot (v2) and its v1 ancestor.
 *
 * Kept outside the production surface (`__fixtures__` dir, re-exported
 * only via explicit imports from tests). The factories below return a
 * fully-formed but minimally-valid snapshot that tests can spread-override
 * when they want to assert on a particular field.
 */

import type { AuthKey, CctSlotLegacyAttachmentOnly, CctSlotWithSetup, OAuthAttachment } from '../../auth/auth-key';
import type { CctStoreSnapshot, LegacyV1Snapshot, LegacyV1TokenSlot, SlotState } from '../types';

/** Canonical OAuth attachment for the `source: 'legacy-attachment'` arm. */
export function makeOAuthAttachment(overrides: Partial<OAuthAttachment> = {}): OAuthAttachment {
  return {
    accessToken: 'at-xyz',
    refreshToken: 'rt-xyz',
    expiresAtMs: 1_900_000_000_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max_5x',
    rateLimitTier: 'default_claude_max_5x',
    acknowledgedConsumerTosRisk: true,
    ...overrides,
  };
}

export function makeCctSetupSlot(overrides: Partial<CctSlotWithSetup> = {}): CctSlotWithSetup {
  return {
    kind: 'cct',
    source: 'setup',
    keyId: '01HZZZAAAA0000000000000001',
    name: 'cct1',
    setupToken: 'sk-ant-oat01-abc',
    createdAt: '2026-04-18T00:00:00.000Z',
    ...overrides,
  };
}

export function makeCctLegacyAttachmentSlot(
  overrides: Partial<CctSlotLegacyAttachmentOnly> = {},
): CctSlotLegacyAttachmentOnly {
  return {
    kind: 'cct',
    source: 'legacy-attachment',
    keyId: '01HZZZAAAA0000000000000002',
    name: 'cct2',
    oauthAttachment: makeOAuthAttachment(),
    createdAt: '2026-04-18T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Build a v2 snapshot. Pass `slots` to control the registry; `state` is
 * auto-populated with a `healthy` SlotState for any keyId not supplied.
 */
export function makeV2Snapshot(
  opts: { revision?: number; activeKeyId?: string; slots?: AuthKey[]; state?: Record<string, SlotState> } = {},
): CctStoreSnapshot {
  const slots = opts.slots ?? [];
  const state: Record<string, SlotState> = { ...(opts.state ?? {}) };
  for (const slot of slots) {
    if (!state[slot.keyId]) {
      state[slot.keyId] = { authState: 'healthy', activeLeases: [] };
    }
  }
  return {
    version: 2,
    revision: opts.revision ?? 0,
    registry: {
      slots,
      ...(opts.activeKeyId !== undefined ? { activeKeyId: opts.activeKeyId } : {}),
    },
    state,
  };
}

/**
 * Build a v1 snapshot for migrator tests. Keeps the legacy shape
 * (slotId, kind: 'setup_token'|'oauth_credentials', credentials: {…}).
 */
export function makeV1Snapshot(
  opts: {
    revision?: number;
    activeSlotId?: string;
    slots?: LegacyV1TokenSlot[];
    state?: Record<string, SlotState>;
  } = {},
): LegacyV1Snapshot {
  const slots = opts.slots ?? [];
  const state: Record<string, SlotState> = { ...(opts.state ?? {}) };
  for (const slot of slots) {
    if (!state[slot.slotId]) {
      state[slot.slotId] = { authState: 'healthy', activeLeases: [] };
    }
  }
  return {
    version: 1,
    revision: opts.revision ?? 0,
    registry: {
      slots,
      ...(opts.activeSlotId !== undefined ? { activeSlotId: opts.activeSlotId } : {}),
    },
    state,
  };
}

/** V1 setup-token slot factory for migrator tests. */
export function makeV1SetupSlot(overrides: Partial<LegacyV1TokenSlot> = {}): LegacyV1TokenSlot {
  return {
    slotId: '01HZZZAAAA0000000000000001',
    name: 'cct1',
    kind: 'setup_token',
    value: 'sk-ant-oat01-abc',
    createdAt: '2026-04-18T00:00:00.000Z',
    ...overrides,
  } as LegacyV1TokenSlot;
}

/** V1 oauth-credentials slot factory for migrator tests. */
export function makeV1OAuthSlot(overrides: Partial<LegacyV1TokenSlot> = {}): LegacyV1TokenSlot {
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
  } as LegacyV1TokenSlot;
}

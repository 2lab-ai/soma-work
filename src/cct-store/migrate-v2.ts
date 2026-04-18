import path from 'node:path';
import type { CctStoreSnapshot, OAuthCredentialsSlot, SnapshotV1, SnapshotV2, TokenSlot } from './types';

/**
 * Pure v1 → v2 migrator.
 *
 * Folds a default `configDir` into every `oauth_credentials` slot. Setup-
 * token slots are carried through unchanged. Idempotent: feeding a v2
 * snapshot returns the input as-is (same reference is fine — callers
 * outside tests don't retain it).
 *
 * IMPORTANT: this function performs NO filesystem I/O. Directory creation
 * for the new configDirs is the responsibility of `CctStore.upgradeIfNeeded`.
 *
 * @param snap   snapshot read straight off disk (may be v1 or v2).
 * @param dataDir absolute path to the CCT data directory — used to
 *                compute `<dataDir>/cct-store.dirs/<slotId>` per oauth slot.
 */
export function migrateV1ToV2(snap: CctStoreSnapshot | SnapshotV1, dataDir: string): SnapshotV2 {
  if (snap.version === 2) return snap as SnapshotV2;

  const dirsRoot = path.join(dataDir, 'cct-store.dirs');
  const nextSlots: TokenSlot[] = snap.registry.slots.map((slot) => {
    if (slot.kind !== 'oauth_credentials') return slot;
    if (slot.configDir) return slot;
    const upgraded: OAuthCredentialsSlot = {
      ...slot,
      configDir: path.join(dirsRoot, slot.slotId),
    };
    return upgraded;
  });

  return {
    ...snap,
    version: 2,
    registry: {
      ...snap.registry,
      slots: nextSlots,
    },
  };
}

import type { CctStoreSnapshot } from '../types';

/**
 * Factory for a valid v2 {@link CctStoreSnapshot} with sensible empty
 * defaults. Callers spread overrides to customise individual fields.
 *
 * Intended for test fixtures only — real stores mutate through
 * `CctStore.mutate`.
 */
export function makeV2Snapshot(opts: Partial<CctStoreSnapshot> = {}): CctStoreSnapshot {
  return {
    version: 2,
    revision: 0,
    registry: { slots: [] },
    state: {},
    ...opts,
  };
}

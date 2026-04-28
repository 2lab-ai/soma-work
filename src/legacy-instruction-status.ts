/**
 * Single source of truth for mapping the legacy on-disk instruction-status
 * enum onto the sealed #727 / #754 enum.
 *
 * The legacy mirror (`session.instructions[].status` on `data/sessions.json`)
 * historically allowed the value `'todo'`. The sealed enum collapses that
 * into `'active'`. Both `src/user-instructions-migration.ts` (admin/eager
 * boot path) and `src/session-registry.ts` (per-session deserialization)
 * need the exact same mapping; extracting the helper here prevents the two
 * sites from drifting (Linus P1-6).
 */

import type { UserInstructionStatus } from './user-session-store';

export type LegacyInstructionStatus = 'active' | 'todo' | 'completed' | 'cancelled';

/**
 * Map a legacy status value onto the sealed #727 / #754 enum.
 *
 * Rules (binding):
 *   - 'completed'  → 'completed'
 *   - 'cancelled'  → 'cancelled'
 *   - 'active'     → 'active'
 *   - 'todo'       → 'active'   (legacy enum value collapsed at migration time)
 *   - undefined    → 'active'   (pre-status disk state)
 *   - any other    → 'active'   (defensive — log & continue at the call site)
 */
export function mapLegacyInstructionStatus(
  status: LegacyInstructionStatus | string | undefined | null,
): UserInstructionStatus {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  // 'active' | 'todo' | undefined | unknown → 'active'.
  return 'active';
}

/**
 * `<current-user-instruction>` block builder (#756, parent epic #727).
 *
 * Dual-protection prompt block — lives at a fixed position in the system
 * prompt every request and is re-derived from the user-scope master
 * (UserSessionStore) on every rebuild so the model retains a single
 * authoritative answer to "which instruction is this turn working on?"
 * even after compaction or reset.
 *
 * Pure module: callers feed in the loaded UserSessionDoc, the session's
 * `currentInstructionId`, and (optionally) the active pending-confirm
 * entry from `PendingInstructionConfirmStore.getBySession()`. Wiring the
 * stores belongs in `prompt-builder.ts`.
 *
 * Block format (active):
 *   <current-user-instruction>
 *     active: <id> · <title>
 *     age: <h>h
 *     linked sessions: [<id>, ...]
 *     pending: <op> (requested by <by.type>:<by.id> at <at>)   // optional
 *   </current-user-instruction>
 *
 * Block format (active:null + candidates):
 *   <current-user-instruction>
 *     active: null
 *     candidates (max 5):
 *       - <id> · <title> (age <h>h)
 *       - ...
 *     + N more (see dashboard)                                  // optional
 *   </current-user-instruction>
 */

import type { PendingInstructionConfirm } from '../slack/actions/pending-instruction-confirm-store';
import type { UserInstruction, UserSessionDoc } from '../user-session-store';

export const CURRENT_INSTRUCTION_BLOCK_OPEN = '<current-user-instruction>';
export const CURRENT_INSTRUCTION_BLOCK_CLOSE = '</current-user-instruction>';

/** Max candidate rows surfaced when `currentInstructionId === null`. */
export const CURRENT_INSTRUCTION_CANDIDATE_CAP = 5;
/** Max chars rendered for the instruction title (active or candidate). */
export const CURRENT_INSTRUCTION_TITLE_CAP = 120;

export interface BuildCurrentInstructionBlockArgs {
  /** The full user-scope master doc. */
  doc: UserSessionDoc;
  /** Session lookup key — channel|threadTs (matches PendingInstructionConfirm). */
  sessionKey: string;
  /** Session pointer; `null`/`undefined` are normal (chat / question turns). */
  currentInstructionId: string | null | undefined;
  /** Pending y/n confirm entry for this session, if any. */
  pending?: PendingInstructionConfirm | undefined;
  /** Injectable clock — defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Whole-hour age between two ISO timestamps. Negative deltas (clock skew)
 * clamp to 0 so the block never renders a misleading "-3h".
 */
function hoursBetween(fromIso: string, nowIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(nowIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const ms = to - from;
  if (ms <= 0) return 0;
  return Math.floor(ms / (3600 * 1000));
}

function truncateTitle(text: string): string {
  // Collapse internal whitespace so multi-line instructions render on one
  // logical row, then cap to keep the block compact.
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= CURRENT_INSTRUCTION_TITLE_CAP) return flat;
  return `${flat.slice(0, CURRENT_INSTRUCTION_TITLE_CAP - 1)}…`;
}

function isUsableActive(inst: UserInstruction | undefined): inst is UserInstruction {
  return !!inst && inst.status === 'active';
}

function renderPendingLine(pending: PendingInstructionConfirm): string {
  // Mirrors the sealed `lifecycleEvents[].by` shape so the same words show
  // up here as in the audit log; aids cross-referencing during debugging.
  const at = new Date(pending.createdAt).toISOString();
  return `pending: ${pending.type} (requested by ${pending.by.type}:${pending.by.id} at ${at})`;
}

function renderActiveBlock(args: {
  inst: UserInstruction;
  nowIso: string;
  pending?: PendingInstructionConfirm | undefined;
}): string {
  const { inst, nowIso, pending } = args;
  const ageH = hoursBetween(inst.createdAt, nowIso);
  const linked = inst.linkedSessionIds.join(', ');
  const lines = [
    CURRENT_INSTRUCTION_BLOCK_OPEN,
    `  active: ${inst.id} · ${truncateTitle(inst.text)}`,
    `  age: ${ageH}h`,
    `  linked sessions: [${linked}]`,
  ];
  if (pending) {
    lines.push(`  ${renderPendingLine(pending)}`);
  }
  lines.push(CURRENT_INSTRUCTION_BLOCK_CLOSE);
  return lines.join('\n');
}

/**
 * Sort candidates newest-first by `createdAt`, breaking ties with `id`
 * (deterministic — required for byte-stable re-derivation across calls).
 */
function sortCandidatesNewestFirst(a: UserInstruction, b: UserInstruction): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function renderNullBlock(args: {
  doc: UserSessionDoc;
  nowIso: string;
  pending?: PendingInstructionConfirm | undefined;
}): string {
  const { doc, nowIso, pending } = args;
  const candidates = doc.instructions.filter((i) => i.status === 'active').sort(sortCandidatesNewestFirst);

  const lines: string[] = [CURRENT_INSTRUCTION_BLOCK_OPEN, '  active: null'];

  if (candidates.length > 0) {
    const visible = candidates.slice(0, CURRENT_INSTRUCTION_CANDIDATE_CAP);
    const overflow = candidates.length - visible.length;
    lines.push(`  candidates (max ${CURRENT_INSTRUCTION_CANDIDATE_CAP}):`);
    for (const c of visible) {
      const ageH = hoursBetween(c.createdAt, nowIso);
      lines.push(`    - ${c.id} · ${truncateTitle(c.text)} (age ${ageH}h)`);
    }
    if (overflow > 0) {
      lines.push(`  + ${overflow} more (see dashboard)`);
    }
  }

  if (pending) {
    lines.push(`  ${renderPendingLine(pending)}`);
  }

  lines.push(CURRENT_INSTRUCTION_BLOCK_CLOSE);
  return lines.join('\n');
}

/**
 * Build the `<current-user-instruction>` block.
 *
 * Always returns a non-empty string — the block is unconditional so the
 * model can reliably grep for the tag every turn. When the session has no
 * active pointer and the user has no active instructions, the block still
 * renders `active: null` (the model's deterministic fallback).
 */
export function buildCurrentInstructionBlock(args: BuildCurrentInstructionBlockArgs): string {
  const nowIso = (args.now ?? (() => new Date().toISOString()))();
  const pointer = args.currentInstructionId ?? null;

  let activeInst: UserInstruction | undefined;
  if (pointer) {
    activeInst = args.doc.instructions.find((i) => i.id === pointer);
  }

  if (isUsableActive(activeInst)) {
    return renderActiveBlock({ inst: activeInst, nowIso, pending: args.pending });
  }

  // Pointer is null OR resolves to a missing/completed/cancelled row →
  // surface candidates list (max 5 with overflow notice). The pointer
  // resolution is intentionally defensive: we mirror the same `active:
  // null` line either way so the model never sees a half-formed
  // reference like `active: <stale_id>` after the master moves on.
  return renderNullBlock({ doc: args.doc, nowIso, pending: args.pending });
}

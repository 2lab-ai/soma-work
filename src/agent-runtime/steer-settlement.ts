/**
 * Shared vocabulary of the steer settlement (spec §6 item 6).
 *
 * The settlement frame is SYNTHETIC: `ClaudeHandler` computes it at the turn's
 * `result` and injects it into the SDK message stream, and the Claude-Code
 * mapper turns it into `steer_lifecycle` events. Producer and consumer sit in
 * different layers, so the subtype literal and the list reader live here — two
 * hand-written `'steer_settlement'` strings would drift silently and every
 * steered item would hang in `steered` forever.
 *
 * Neutral zone: no SDK import (the mapper's adapter zone owns that).
 */

/** Subtype of the host-computed settlement frame. Written AND matched here. */
export const STEER_SETTLEMENT_SUBTYPE = 'steer_settlement';

/**
 * Read a uuid list off a duck-typed frame/receipt, keeping non-empty strings.
 *
 * Every list this touches is declared but optional in the SDK types and absent
 * on CLIs predating the `interrupt_receipt_v1` / `interrupt_cancel_queued_v1`
 * capabilities (sdk.d.ts:3940-3948), so an unexpected shape must degrade to
 * "nothing listed" rather than throw mid-settlement. Also used for the
 * `capabilities` string list on `system`/`init`.
 */
export function readUuidList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((u): u is string => typeof u === 'string' && u.length > 0) : [];
}

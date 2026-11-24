/**
 * A board card's live push as what changed (dashboard perf 2026-11-24).
 *
 * A running card was pushed whole about once a second — 67 to 160 KB each, its task history and agent tree included —
 * while only its usage numbers moved: one tab on dev took 15 MB in 120 s of those pushes, most of them byte for byte
 * the copy it already held. Each socket now keeps what it was last sent of each card, field by field, and gets:
 *
 * - nothing, when no field changed;
 * - `sessionPatch` with only the changed fields (`set`) and the fields that left the card (`unset`);
 * - the whole card (`sessionUpdated`, as before) on its first push to the socket, and on a change once
 *   {@link CARD_KEYFRAME_MS} has passed since its last whole copy — so a copy the page replaced from an older board
 *   poll is put right within that time even if the fields it lost never change again.
 *
 * The page (`patchedSession` in dashboard.ts's page script) applies a patch onto its copy of the card and runs the
 * `sessionUpdated` path with the result.
 */

/** What a socket was last sent of one card: each top-level field as JSON, and when it last got the whole card. */
export interface SentCard {
  fields: Map<string, string>;
  fullAt: number;
}

/** A socket's last-sent copy of every card pushed to it, by card key. */
export type SentCards = Map<string, SentCard>;

/** The longest a socket goes on patches of a card that keeps changing before it gets the whole card again. */
export const CARD_KEYFRAME_MS = 30_000;

/**
 * A card's top-level fields as JSON, in the card's own order. A field `JSON.stringify` leaves out of an object
 * (undefined, a function) is absent — so the whole card rebuilt from these is `JSON.stringify(card)`.
 */
export function cardFields(card: object): Map<string, string> {
  const fields = new Map<string, string>();
  for (const [name, value] of Object.entries(card)) {
    const json = JSON.stringify(value);
    if (json !== undefined) fields.set(name, json);
  }
  return fields;
}

function objectOf(fields: Iterable<[string, string]>): string {
  const parts: string[] = [];
  for (const [name, json] of fields) parts.push(`${JSON.stringify(name)}:${json}`);
  return `{${parts.join(',')}}`;
}

/**
 * The message that brings this socket's copy of card `key` to `fields`, or undefined when its copy is that already.
 * Records what it returns as the socket's copy — call it only for a message that is then sent.
 */
export function cardPushMessage(
  sent: SentCards,
  key: string,
  fields: Map<string, string>,
  nowMs: number,
): string | undefined {
  const prev = sent.get(key);
  const set: Array<[string, string]> = [];
  const unset: string[] = [];
  if (prev) {
    for (const [name, json] of fields) if (prev.fields.get(name) !== json) set.push([name, json]);
    for (const name of prev.fields.keys()) if (!fields.has(name)) unset.push(name);
    if (set.length === 0 && unset.length === 0) return undefined;
  }
  if (!prev || nowMs - prev.fullAt >= CARD_KEYFRAME_MS) {
    sent.set(key, { fields, fullAt: nowMs });
    return `{"type":"sessionUpdated","session":${objectOf(fields)}}`;
  }
  sent.set(key, { fields, fullAt: prev.fullAt });
  const unsetPart = unset.length > 0 ? `,"unset":${JSON.stringify(unset)}` : '';
  return `{"type":"sessionPatch","key":${JSON.stringify(key)},"set":${objectOf(set)}${unsetPart}}`;
}

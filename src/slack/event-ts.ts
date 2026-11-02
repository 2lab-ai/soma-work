/**
 * A Slack-format `ts` for a turn that has no Slack message of its own — an approved
 * request sent again, a button that injects a turn into its session.
 *
 * `ts` is the turn's identity from the ingress on: the follow-up queue keys every item
 * on `<channel>:<ts>` (dedup, A3) and its store refuses an empty one. A turn sent with
 * `ts: ''` while its session was busy therefore could not be queued at all
 * (work-m64 dev, 2026-10-28: "큐 저장에 실패 — …message.ts is not a non-empty string").
 * A fixed placeholder would not do either: two such turns would share one key, and the
 * queue would drop the second as a duplicate.
 *
 * Values are strictly increasing within the process, so two turns minted in the same
 * millisecond still get different keys.
 */
let lastMicros = 0;

export function mintEventTs(nowMs: number = Date.now()): string {
  const micros = Math.max(Math.floor(nowMs * 1000), lastMicros + 1);
  lastMicros = micros;
  return `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, '0')}`;
}

/**
 * A Slack message ts (`"1792900000.000100"`) as an ORDER key in epoch
 * milliseconds, keeping Slack's microseconds as the fraction. Flooring or
 * rounding to whole ms would tie — or invert — two messages sent within one
 * millisecond; the auto-mode classifier quotes the owner's messages in this
 * order, so a later "don't" must stay after an earlier "do".
 *
 * Doubles keep adjacent microseconds of a current ts apart (spacing ≈ 2.4e-4 ms
 * against a 1e-3 ms step), and multiplying by 1000 keeps their order.
 */
export function slackTsOrderMs(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

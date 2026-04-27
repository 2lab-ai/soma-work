/**
 * Escape user-controlled text for inclusion inside a Slack `mrkdwn` block.
 *
 * Slack only requires `&`, `<`, `>` to be entity-encoded for text embedded in
 * `mrkdwn`; this prevents labels like `<@U123>` from triggering mentions and
 * `<url|label>` from rendering as links. Formatting chars (`*_~`) remain intact.
 *
 * Originally inlined in `choice-message-builder.ts`; extracted here so other
 * Slack surfaces (e.g. user-skills list, future button banners) can reuse the
 * exact same escape semantics without duplicating the helper.
 */
export function escapeSlackMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

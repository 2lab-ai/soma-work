/**
 * How a user is named in a Slack message. A Slack id becomes a mention (`<@U…>`). An environment user
 * (`env:<name>`, server-tools `envUser`) is not a Slack account — Slack leaves `<@env:<name>>` as raw text — so it is
 * shown as code. A Slack id never contains `:`, so the prefix alone decides.
 */
export function userMention(userId: string): string {
  return userId.startsWith('env:') ? `\`${userId}\`` : `<@${userId}>`;
}

/**
 * The admin DM copies an MCP grant answer did not reach (#621).
 *
 * The answering process (a Slack click or the dashboard, in the main process)
 * rewrites the copies it read from the stored request and lists their `ts` in
 * `promptsRewritten`. A copy this MCP child recorded after that read — and
 * every copy when nobody answered in time — is rewritten here, so no copy
 * keeps live Approve / Deny buttons once the request is over.
 */

export interface LatePromptResponse {
  behavior: 'allow' | 'deny';
  message?: string;
  promptText?: string;
  promptsRewritten?: string[];
}

export interface LatePromptSlack {
  chat: {
    update(args: { channel: string; ts: string; text: string; blocks: unknown[] }): Promise<unknown>;
  };
}

export async function closeLatePrompts(
  slack: LatePromptSlack,
  prompts: ReadonlyArray<{ channel: string; ts: string }>,
  response: LatePromptResponse,
  onError: (error: unknown) => void = () => {},
): Promise<number> {
  const reached = new Set(response.promptsRewritten ?? []);
  const text =
    response.promptText ??
    (response.behavior === 'allow'
      ? `✅ ${response.message ?? 'Permission granted'}`
      : `⌛ ${response.message ?? 'Permission request ended'}`);
  let closed = 0;
  for (const prompt of prompts) {
    if (reached.has(prompt.ts)) continue;
    try {
      await slack.chat.update({
        channel: prompt.channel,
        ts: prompt.ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
      closed++;
    } catch (error) {
      onError(error);
    }
  }
  return closed;
}

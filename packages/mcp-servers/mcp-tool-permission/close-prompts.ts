/**
 * Close every admin DM copy of an MCP grant request once it is over (#621).
 *
 * The answering process (a Slack click or the dashboard, in the main process)
 * rewrites the copies it read from the stored request; this child, which
 * recorded every copy and got the answer, rewrites them all again with the same
 * line. That covers a copy recorded after the answer read the request, a
 * rewrite that failed there, and the timeout (nobody answered) — no copy keeps
 * live Approve / Deny buttons once the request is over.
 */

export interface PromptCloseResponse {
  behavior: 'allow' | 'deny';
  message?: string;
  /** The outcome line the answering process wrote (who answered, where). */
  promptText?: string;
}

export interface PromptCloseSlack {
  chat: {
    update(args: { channel: string; ts: string; text: string; blocks: unknown[] }): Promise<unknown>;
  };
}

export async function closePrompts(
  slack: PromptCloseSlack,
  prompts: ReadonlyArray<{ channel: string; ts: string }>,
  response: PromptCloseResponse,
  onError: (error: unknown) => void = () => {},
): Promise<number> {
  const text =
    response.promptText ??
    (response.behavior === 'allow'
      ? `✅ ${response.message ?? 'Permission granted'}`
      : `⌛ ${response.message ?? 'Permission request ended'}`);
  let closed = 0;
  for (const prompt of prompts) {
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

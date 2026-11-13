/**
 * The one message an admin approved for an environment user (env-access): its channel, its thread and its words.
 * An environment user's "accept once" grant is bound to this key, so it serves that message there and nowhere else —
 * not the same words in another thread, not other words in the same thread.
 */
export function environmentApprovalKey(channel: string, threadTs: string | undefined, text: string): string {
  return JSON.stringify([channel, threadTs ?? null, text]);
}

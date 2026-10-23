/**
 * Conversation subtitle (titleSub) — the model-generated line under a
 * dashboard panel title.
 *
 * Two operations with different permission scopes (the routes in
 * dashboard.ts apply them):
 *   • ensureTitleSub — fill a MISSING subtitle. titleSub is derived data with
 *     no author: the caller chooses only when it is generated, never what it
 *     says. So any signed-in viewer may trigger it (reads are open, #716).
 *     It never overwrites: an existing subtitle is returned as is.
 *   • regenerateTitleSub — replace the subtitle. That changes someone else's
 *     record, so it stays behind the #716 / #717 owner-or-Admin-mode gate.
 *
 * Spend bounds, because a fill is reachable by every viewer:
 *   • one LLM call per conversation at a time (in-process single flight —
 *     per dashboard process, not across processes);
 *   • after a failed fill, further fills wait out TITLE_SUB_FILL_COOLDOWN_MS;
 *   • no conversation text → no LLM call.
 */
import { fillConversationTitleSub, updateConversationTitleSub } from './recorder';
import { generateTitle } from './title-generator';
import type { ConversationRecord } from './types';

export const TITLE_SUB_FILL_COOLDOWN_MS = 60_000;

export type TitleSubResult =
  | { ok: true; titleSub: string }
  | { ok: false; reason: 'no_content' | 'generation_failed' }
  | { ok: false; reason: 'cooldown'; retryAfterMs: number };

const inFlight = new Map<string, Promise<string | null>>();
const lastFailedFillAt = new Map<string, number>();

/** The first turns, as the title prompt sees them. Empty when no turn has text. */
export function titleSourceText(record: ConversationRecord): string {
  return record.turns
    .slice(0, 6)
    .map((t) => ({ role: t.role, text: t.rawContent?.substring(0, 500) || t.summaryTitle || '' }))
    .filter((t) => t.text.trim())
    .map((t) => `[${t.role}]: ${t.text}`)
    .join('\n\n');
}

function generateOnce(conversationId: string, source: string): Promise<string | null> {
  const running = inFlight.get(conversationId);
  if (running) return running;
  const call = generateTitle(source).finally(() => inFlight.delete(conversationId));
  inFlight.set(conversationId, call);
  return call;
}

/** Fill a missing subtitle; any signed-in viewer. Never overwrites. */
export async function ensureTitleSub(record: ConversationRecord, now = Date.now()): Promise<TitleSubResult> {
  if (record.titleSub) return { ok: true, titleSub: record.titleSub };
  const source = titleSourceText(record);
  if (!source) return { ok: false, reason: 'no_content' };

  const failedAt = lastFailedFillAt.get(record.id);
  if (failedAt !== undefined) {
    const retryAfterMs = failedAt + TITLE_SUB_FILL_COOLDOWN_MS - now;
    if (retryAfterMs > 0) return { ok: false, reason: 'cooldown', retryAfterMs };
    lastFailedFillAt.delete(record.id);
  }

  const generated = await generateOnce(record.id, source);
  if (!generated) {
    // Concurrent fills that shared this call all land here; one entry is enough.
    lastFailedFillAt.set(record.id, now);
    return { ok: false, reason: 'generation_failed' };
  }
  const stored = await fillConversationTitleSub(record.id, generated);
  return { ok: true, titleSub: stored ?? generated };
}

/** Replace the subtitle; the caller must have passed the #716 write gate. */
export async function regenerateTitleSub(record: ConversationRecord): Promise<TitleSubResult> {
  const source = titleSourceText(record);
  if (!source) return { ok: false, reason: 'no_content' };
  const generated = await generateOnce(record.id, source);
  if (!generated) return { ok: false, reason: 'generation_failed' };
  lastFailedFillAt.delete(record.id);
  await updateConversationTitleSub(record.id, generated);
  return { ok: true, titleSub: generated };
}

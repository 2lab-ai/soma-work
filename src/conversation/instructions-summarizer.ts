/**
 * Summarises the `completed` subset of `session.instructions` into a short
 * prose block that the user-instructions prompt builder injects when there
 * are ≥ 2 completed entries.
 *
 * Design rationale (see docs/PLAN §5):
 *   - Sonnet direct (no haiku first pass). The completed entries are typically
 *     short; haiku adds latency + fallback complexity without meaningful cost
 *     savings at ≤ 50 entries.
 *   - Fire-and-forget regen when `upstreamHash` mismatches. The block builder
 *     renders a `(summary pending…)` placeholder for the first turn; the
 *     next turn sees the fresh summary once the async call resolves.
 *   - Snapshot invalidation: after the summary is written, we clear
 *     `session.systemPrompt` so the next rebuild picks up the new text.
 */

import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { buildQueryEnv } from '../auth/query-env-builder';
import { ensureActiveSlotAuth, NoHealthySlotError, type SlotAuthLease } from '../credentials-manager';
import { Logger } from '../logger';
import { computeCompletedUpstreamHash } from '../prompt/user-instructions-block';
import { getTokenManager } from '../token-manager';
import type { ConversationSession, SessionInstruction } from '../types';

const logger = new Logger('InstructionsSummarizer');

/**
 * Sonnet direct — see doc comment. Kept local (rather than imported from
 * `conversation/summarizer.ts`) so a future model swap here doesn't
 * accidentally drift the session-summary-title model.
 */
const SONNET_MODEL = 'claude-sonnet-4-5';

/** In-flight regen tracker — one concurrent summary per session is sufficient. */
const inFlight = new WeakSet<ConversationSession>();

/**
 * Attempt to summarise a set of completed instructions. Returns `null` on
 * any failure (no credentials, model error, parse error) — the caller falls
 * back to a `(summary pending…)` placeholder.
 *
 * Kept pure (no session mutation) so it can be unit-tested in isolation.
 */
export async function summarizeCompletedInstructions(items: SessionInstruction[]): Promise<string | null> {
  if (!items || items.length < 2) return null;

  let lease: SlotAuthLease | null = null;
  try {
    try {
      lease = await ensureActiveSlotAuth(getTokenManager(), 'instructions-summarizer');
    } catch (credErr) {
      if (credErr instanceof NoHealthySlotError) {
        logger.warn('Credentials invalid, instructions summarizer disabled', {
          error: credErr.message,
        });
        return null;
      }
      throw credErr;
    }

    const lines = items
      .map((i, idx) => {
        const text = i.text.replace(/\s+/g, ' ').trim();
        const ev = i.evidence ? ` (evidence: ${i.evidence.slice(0, 200)})` : '';
        return `[${idx + 1}] ${text}${ev}`;
      })
      .join('\n');
    const truncatedLines = lines.length > 6000 ? `${lines.slice(0, 6000)}\n...[truncated]` : lines;

    const prompt = `Summarise the following user instructions that are already COMPLETED in a session. Produce a compact prose block (3-8 short lines, no bullets, no markdown headers) that captures WHAT was asked and WHAT outcome closed it. Do NOT add recommendations or meta-commentary — the goal is to remind the model of prior completed intent without re-expanding the prompt.

Completed instructions:
${truncatedLines}`;

    const { env } = buildQueryEnv(lease);
    const options: Options = {
      model: SONNET_MODEL,
      maxTurns: 1,
      tools: [],
      systemPrompt:
        'You compress completed-instruction logs into a compact prose summary. Output only the summary text.',
      settingSources: [],
      plugins: [],
      env,
      stderr: (data: string) => {
        logger.warn('InstructionsSummarizer stderr', { data: data.trimEnd() });
      },
    };

    let assistantText = '';
    for await (const message of query({ prompt, options })) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') assistantText += block.text;
        }
      }
    }

    const summary = assistantText.trim();
    if (!summary) {
      logger.warn('InstructionsSummarizer returned empty text');
      return null;
    }
    // Cap the summary length defensively — the model sometimes over-expands.
    return summary.length > 1500 ? `${summary.slice(0, 1500)}…` : summary;
  } catch (err) {
    logger.error('Instructions summarisation failed', err);
    return null;
  } finally {
    if (lease) await lease.release();
  }
}

/**
 * Regenerate `session.instructionsCompletedSummary` if the cached hash no
 * longer matches the current completed subset. Fire-and-forget — returns a
 * Promise that resolves when the regen pipeline completes, but most callers
 * can drop it on the floor. Safe to call on every turn; deduplicates via
 * `inFlight`.
 *
 * On success, clears `session.systemPrompt` so the next prompt build picks
 * up the fresh summary (see §2 of PLAN.md — snapshot invalidation).
 */
export async function regenerateInstructionsSummaryIfStale(session: ConversationSession): Promise<boolean> {
  if (!session) return false;
  const instructions = session.instructions || [];
  const completed = instructions.filter((i) => i.status === 'completed');
  if (completed.length < 2) return false;

  const expectedHash = computeCompletedUpstreamHash(instructions);
  const cached = session.instructionsCompletedSummary;
  if (cached && cached.upstreamHash === expectedHash) return false;

  if (inFlight.has(session)) {
    logger.debug('Summary regen already in-flight for session, skipping', {
      sessionId: session.sessionId,
    });
    return false;
  }
  inFlight.add(session);

  try {
    const summary = await summarizeCompletedInstructions(completed);
    if (!summary) return false;
    // Re-fetch hash in case completed entries changed mid-flight — we tag the
    // cache with the hash of the exact subset we summarised so the next stale
    // check behaves correctly.
    const postHash = computeCompletedUpstreamHash(session.instructions || []);
    session.instructionsCompletedSummary = { summary, upstreamHash: postHash };
    // Snapshot invalidation — next buildSystemPrompt() call will rebuild with
    // the new summary. See PLAN.md §2.
    session.systemPrompt = undefined;
    return true;
  } finally {
    inFlight.delete(session);
  }
}

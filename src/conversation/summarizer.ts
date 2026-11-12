import { buildOneShotOptions, runOneShotText } from '../agent-runtime';
import { type AuxModel, type AuxTier, auxModelFor } from '../agent-runtime/aux-model';
import type { TenantKeyLease } from '../auth/llmux-tenant-keys';
import { buildQueryEnv } from '../auth/query-env-builder';
import { userTenantKey } from '../auth/user-tenant-key';
import { config } from '../config';
import { ensureActiveSlotAuth, NoHealthySlotError, type SlotAuthLease } from '../credentials-manager';
import { Logger } from '../logger';
import { getTokenManager } from '../token-manager';

const logger = new Logger('Summarizer');

/**
 * Summary result from the summarizer
 */
export interface SummaryResult {
  title: string; // 1-line title
  body: string; // 3-line summary
}

/**
 * Per-call options of the summarizers. `tenantUserId` = the user the summary is
 * made for (the conversation's / session's user): in llmux mode the call carries
 * their own key, so it is metered under their tenant; absent → the shared key.
 * `mainModel` = the session's model when the summary is made for a live session.
 * The model is an aux tier of the main model — `mainModel`, else the user's
 * default model (`agent-runtime/aux-model.ts`).
 */
export interface SummarizerCallOptions {
  tenantUserId?: string;
  mainModel?: string;
}

/** The aux model of `tier` for this call. */
function auxFor(tier: AuxTier, opts: SummarizerCallOptions, override?: string): AuxModel {
  return auxModelFor(tier, { mainModel: opts.mainModel, userId: opts.tenantUserId, override });
}

/**
 * Summarize assistant response into a title and body.
 * Uses Agent SDK (OAuth) — same auth path as all other Claude calls.
 * Returns null on failure (graceful degradation).
 */
export async function summarizeResponse(
  content: string,
  opts: SummarizerCallOptions = {},
): Promise<SummaryResult | null> {
  let lease: SlotAuthLease | null = null;
  try {
    try {
      lease = await ensureActiveSlotAuth(getTokenManager(), 'summarizer');
    } catch (credErr) {
      if (credErr instanceof NoHealthySlotError) {
        logger.warn('Credentials invalid, summarization disabled', { error: credErr.message });
        return null;
      }
      throw credErr;
    }

    // Truncate very long content to save tokens
    const maxContentLength = 8000;
    const truncatedContent =
      content.length > maxContentLength ? `${content.substring(0, maxContentLength)}\n...[truncated]` : content;

    const prompt = `Summarize this AI assistant response. Output ONLY a JSON object with "title" (1 short line, max 60 chars) and "body" (3 concise lines separated by \\n). No markdown, no code blocks, just raw JSON.

Response to summarize:
${truncatedContent}`;

    // Use options.env (not process.env) so concurrent leases don't
    // clobber the shared CLAUDE_CODE_OAUTH_TOKEN.
    const { env } = buildQueryEnv(lease, { llmuxTenant: await userTenantKey(opts.tenantUserId) });
    // The `sonnet` tier of the main model; SUMMARY_MODEL (operator) overrides it.
    const aux = auxFor('sonnet', opts, config.conversation.summaryModel);
    const options = buildOneShotOptions({
      model: aux.model,
      effort: aux.effort,
      systemPrompt: 'You are a concise summarizer. Output only what is requested.',
      env,
      logger,
      stderrLabel: 'Summarizer',
    });

    try {
      const assistantText = await runOneShotText(prompt, options);

      // Strip markdown code block wrappers (LLMs frequently add them despite instructions)
      let cleanText = assistantText.trim();
      if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      // Parse JSON response
      const parsed = JSON.parse(cleanText);
      if (parsed.title && parsed.body) {
        return {
          title: String(parsed.title).substring(0, 100),
          body: String(parsed.body).substring(0, 500),
        };
      }

      logger.warn('Summarizer returned unexpected format', { text: assistantText.substring(0, 200) });
      return null;
    } catch (error) {
      logger.error('Summarization failed', error);
      return null;
    }
  } finally {
    if (lease) await lease.release();
  }
}

// ──────────────────────────────────────────────────────────────────────
// Dashboard v2.1 — session summary title (distinct from per-turn summary)
// ──────────────────────────────────────────────────────────────────────

export interface SessionSummaryTitleLinks {
  issueTitle?: string;
  issueLabel?: string;
  prTitle?: string;
  prLabel?: string;
  prStatus?: string;
}

export interface SessionSummaryTitleResult {
  title: string;
  /** The aux TIER that produced the title (the model is that tier of the main model). */
  model: AuxTier;
}

/**
 * Non-printable character ratio — used as a quality gate on LLM output.
 */
function nonTextRatio(s: string): number {
  if (!s) return 0;
  let bad = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0;
    // Allow common printable + CJK + emoji ranges. Reject control chars
    // other than space / tab.
    if (code < 0x20 && code !== 0x09) bad += 1;
  }
  return bad / Math.max(1, s.length);
}

function titlePassesQuality(title: string): boolean {
  if (!title) return false;
  if (title.length < 5 || title.length > 80) return false;
  if (/untitled|n\/a|\.\.\./i.test(title)) return false;
  if (nonTextRatio(title) > 0.3) return false;
  return true;
}

function buildPromptParts(
  userMessages: string[],
  links?: SessionSummaryTitleLinks,
): { system: string; prompt: string } {
  const joined = userMessages
    .map((m, i) => `[${i + 1}] ${m}`)
    .join('\n\n')
    .slice(0, 4000);
  const linkCtx: string[] = [];
  if (links?.issueTitle || links?.issueLabel) {
    linkCtx.push(`Issue: ${links.issueLabel ?? ''}${links.issueTitle ? ` — ${links.issueTitle}` : ''}`.trim());
  }
  if (links?.prTitle || links?.prLabel) {
    const status = links.prStatus ? ` (${links.prStatus})` : '';
    linkCtx.push(`PR: ${links.prLabel ?? ''}${links.prTitle ? ` — ${links.prTitle}` : ''}${status}`.trim());
  }
  const linkBlock = linkCtx.length > 0 ? `\n\nLinked context:\n${linkCtx.join('\n')}` : '';
  const system =
    'You produce one concise task title per request. Output ONLY raw JSON with key "title". No markdown, no code fences.';
  const prompt = `Analyze these user messages and optional linked issue/PR context. Return a JSON object {"title": "..."} with a concise task title (<=80 chars, English or Korean matching the input, no placeholder like "Untitled").

User messages:
${joined || '(empty)'}${linkBlock}`;
  return { system, prompt };
}

async function runTitleQuery(
  aux: AuxModel,
  system: string,
  prompt: string,
  lease: SlotAuthLease,
  llmuxTenant: TenantKeyLease | null,
): Promise<string | null> {
  const { env } = buildQueryEnv(lease, { llmuxTenant });
  const options = buildOneShotOptions({
    model: aux.model,
    effort: aux.effort,
    systemPrompt: system,
    env,
    logger,
    stderrLabel: 'SessionSummaryTitle',
  });
  const assistantText = await runOneShotText(prompt, options);
  let cleanText = assistantText.trim();
  if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    const parsed = JSON.parse(cleanText);
    if (parsed && typeof parsed.title === 'string') {
      return parsed.title.trim().slice(0, 80);
    }
  } catch (err) {
    logger.debug('SessionSummaryTitle JSON parse failed', { text: cleanText.slice(0, 120) });
  }
  return null;
}

/**
 * Generate a concise session-level task title from a list of user messages,
 * optionally informed by linked issue/PR metadata. The `haiku` aux tier first —
 * falls back to the `sonnet` tier when its output fails the quality gate. Both
 * tiers follow the main model's provider (`opts.mainModel`, else the user's
 * default model).
 */
export async function generateSessionSummaryTitle(
  userMessages: string[],
  sessionLinks?: SessionSummaryTitleLinks,
  opts: SummarizerCallOptions = {},
): Promise<SessionSummaryTitleResult | null> {
  if (!userMessages || userMessages.length === 0) return null;
  let lease: SlotAuthLease | null = null;
  try {
    try {
      lease = await ensureActiveSlotAuth(getTokenManager(), 'session-summary-title');
    } catch (credErr) {
      if (credErr instanceof NoHealthySlotError) {
        logger.warn('Credentials invalid, session summary title disabled', { error: credErr.message });
        return null;
      }
      throw credErr;
    }

    const { system, prompt } = buildPromptParts(userMessages, sessionLinks);
    // Resolved once: the Sonnet fallback below runs for the same user.
    const llmuxTenant = await userTenantKey(opts.tenantUserId);

    // The haiku tier first — cheap default.
    let title = await runTitleQuery(auxFor('haiku', opts), system, prompt, lease, llmuxTenant);
    if (title && titlePassesQuality(title)) {
      return { title, model: 'haiku' };
    }
    logger.info('SessionSummaryTitle Haiku miss — falling back to Sonnet', {
      preview: title?.slice(0, 40),
    });

    title = await runTitleQuery(auxFor('sonnet', opts), system, prompt, lease, llmuxTenant);
    if (title && titlePassesQuality(title)) {
      return { title, model: 'sonnet' };
    }
    logger.warn('SessionSummaryTitle Sonnet also missed quality gate', {
      preview: title?.slice(0, 40),
    });
    return null;
  } catch (err) {
    logger.error('SessionSummaryTitle failed', err);
    return null;
  } finally {
    if (lease) await lease.release();
  }
}

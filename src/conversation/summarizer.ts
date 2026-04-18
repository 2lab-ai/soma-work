import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { buildQueryEnv } from '../auth/query-env-builder';
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
 * Get the summary model from config (default: claude-haiku-4-20250414)
 */
function getSummaryModel(): string {
  return config.conversation.summaryModel;
}

/**
 * Summarize assistant response into a title and body.
 * Uses Agent SDK (OAuth) — same auth path as all other Claude calls.
 * Returns null on failure (graceful degradation).
 */
export async function summarizeResponse(content: string): Promise<SummaryResult | null> {
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

    // Pass the fresh lease token via options.env (built by `buildQueryEnv`)
    // so concurrent summariser / title-generator / dispatch calls don't
    // clobber each other's token on the shared
    // `process.env.CLAUDE_CODE_OAUTH_TOKEN` variable.
    const { env } = buildQueryEnv(lease);
    const options: Options = {
      model: getSummaryModel(),
      maxTurns: 1,
      tools: [],
      systemPrompt: 'You are a concise summarizer. Output only what is requested.',
      settingSources: [],
      plugins: [],
      env,
      stderr: (data: string) => {
        logger.warn('Summarizer stderr', { data: data.trimEnd() });
      },
    };

    try {
      let assistantText = '';

      for await (const message of query({ prompt, options })) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              assistantText += block.text;
            }
          }
        }
      }

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
  model: 'haiku' | 'sonnet';
}

const HAIKU_MODEL = 'claude-haiku-4-5';
const SONNET_MODEL = 'claude-sonnet-4-5';

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
  model: string,
  system: string,
  prompt: string,
  lease: SlotAuthLease,
): Promise<string | null> {
  const { env } = buildQueryEnv(lease);
  const options: Options = {
    model,
    maxTurns: 1,
    tools: [],
    systemPrompt: system,
    settingSources: [],
    plugins: [],
    env,
    stderr: (data: string) => {
      logger.warn('SessionSummaryTitle stderr', { data: data.trimEnd() });
    },
  };
  let assistantText = '';
  for await (const message of query({ prompt, options })) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          assistantText += block.text;
        }
      }
    }
  }
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
 * optionally informed by linked issue/PR metadata. Haiku first — falls back
 * to Sonnet when the Haiku output fails the quality gate.
 */
export async function generateSessionSummaryTitle(
  userMessages: string[],
  sessionLinks?: SessionSummaryTitleLinks,
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

    // Haiku first — cheap default.
    let title = await runTitleQuery(HAIKU_MODEL, system, prompt, lease);
    if (title && titlePassesQuality(title)) {
      return { title, model: 'haiku' };
    }
    logger.info('SessionSummaryTitle Haiku miss — falling back to Sonnet', {
      preview: title?.slice(0, 40),
    });

    title = await runTitleQuery(SONNET_MODEL, system, prompt, lease);
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

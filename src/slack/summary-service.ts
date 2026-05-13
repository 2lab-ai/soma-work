import { Logger } from '../logger.js';

const logger = new Logger('SummaryService');

/**
 * Summary prompt template — fixed, not user-configurable.
 * Trace: docs/turn-summary-lifecycle/trace.md, S3, Section 2
 *
 * Design intent (revised after user feedback): the auto-summary must describe
 * the **actual work performed**, not a high-level abstract recap. The previous
 * template capped "Status" at 1–2 sentences and only referenced AS-IS/TO-BE
 * for linked issue/PR, which forced generic output when neither was attached.
 * The new template demands concrete artifacts (file paths, commands, commit
 * hashes, PR/issue numbers) and explicitly tells the model to be specific.
 */
export const SUMMARY_PROMPT = `Based on the conversation history in this session, generate an Executive Summary describing the **actual work performed** — not a generic recap.

You MUST use ONLY the conversation history you already have. Do NOT attempt to call any tools, APIs, or external services.

Required content (omit any section that has nothing concrete to report — do NOT fabricate or hedge):

1. **What was done** — Concrete actions taken this session. List actual artifacts from the conversation: file paths edited or created (with full paths), commands run, commits made (hash + message if shown), PRs opened/updated/merged (with numbers and titles), issues touched (with numbers), tests or builds executed and their outcomes. List artifacts, not abstractions. Typically 3–10 bullets.

2. **Decisions made** — Specific design, architectural, or scope choices that were settled, with the rationale when it was discussed. Skip if none.

3. **Open threads** — Anything left unresolved: failing tests, pending reviews, unanswered questions, blocked work.

4. **Suggested next actions** — Up to 3 concrete next steps the user can take. Each in its own code block for easy copy.

Rules:
- Be specific. "Refactored auth" is useless; "Edited src/auth/login.ts to add JWT refresh handling, ran npm test (passed)" is useful.
- Reference real artifacts from the conversation: file paths, function names, PR numbers, error messages, command names. Never invent values you did not see in history.
- If the session has truly no meaningful work history, say so in one sentence — do NOT ask the user for additional context or tool access.
- Write in the same language the conversation was conducted in.
- Respond with the summary only — no preamble, no markdown fences wrapping the whole response.`;

/**
 * Minimal session interface for summary operations.
 * Avoids importing the full ConversationSession type to keep this module testable.
 */
export interface SummarySessionInfo {
  isActive: boolean;
  model?: string;
  /**
   * The user's base working directory (e.g. `/tmp/{userId}`). NOT what the SDK
   * needs for `resume` — see `sessionWorkingDir`. Kept for backward compat
   * with callers that only have this field.
   */
  workingDirectory?: string;
  /**
   * The session-unique SDK cwd (`/tmp/{userId}/session_{ts}_{repo}`). The
   * Claude Agent SDK stores conversation history under
   * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, so `resume` only
   * loads history when the fork runs under the SAME cwd that produced the
   * conversation. Always prefer this over `workingDirectory` when forking.
   * Docs: docs/claude-agent-sdk/sessions.md L234-L235.
   */
  sessionWorkingDir?: string;
  /** Claude SDK session ID — used to resume conversation for context-aware summaries. */
  sessionId?: string;
  links?: {
    issue?: { url: string; label?: string; title?: string };
    pr?: { url: string; label?: string; title?: string };
  };
  actionPanel?: {
    summaryBlocks?: any[];
    [key: string]: any;
  };
}

/**
 * Function type for executing a prompt against a forked session.
 * Injected at construction time — production wiring provides the real implementation,
 * tests provide a mock.
 *
 * @param prompt - The full summary prompt to execute
 * @param model - Model to use (from session)
 * @param sessionId - Claude SDK session ID for forking conversation context
 * @param cwd - Working directory for the forked session
 * @returns The LLM's response text, or null on failure
 */
export type ForkExecutor = (
  prompt: string,
  model?: string,
  sessionId?: string,
  cwd?: string,
  abortSignal?: AbortSignal,
) => Promise<string | null>;

/**
 * Handles executive summary generation and display.
 *
 * - execute(): builds prompt from session context, calls forkExecutor, returns response
 * - displayOnThread(): sets summaryBlocks on actionPanel for ThreadSurface rendering
 * - clearDisplay(): removes summaryBlocks, triggers re-render
 *
 * Trace: docs/turn-summary-lifecycle/trace.md, S3 + S5
 */
export class SummaryService {
  private forkExecutor: ForkExecutor;

  /**
   * @param forkExecutor - Injected function that executes prompt via forked session.
   *   If not provided, falls back to returning the prompt text (stub behavior for testing).
   */
  constructor(forkExecutor?: ForkExecutor) {
    this.forkExecutor = forkExecutor ?? (async (prompt) => prompt);
  }

  /**
   * Build the full summary prompt from session context + template.
   */
  buildPrompt(session: SummarySessionInfo): string {
    const contextParts: string[] = [];

    contextParts.push('## Session Context');

    if (session.links?.issue) {
      const issue = session.links.issue;
      contextParts.push(`- Active Issue: ${issue.title || issue.label || 'untitled'} (${issue.url})`);
    }
    if (session.links?.pr) {
      const pr = session.links.pr;
      contextParts.push(`- Active PR: ${pr.title || pr.label || 'untitled'} (${pr.url})`);
    }

    if (!session.links?.issue && !session.links?.pr) {
      contextParts.push('- No active issues or PRs linked to this session');
    }

    return `${contextParts.join('\n')}\n\n${SUMMARY_PROMPT}`;
  }

  /**
   * Execute summary.prompt via forked session and collect response.
   * Returns the LLM's response text, or null if execution fails.
   *
   * Trace: S3, Section 3b
   */
  async execute(session: SummarySessionInfo, abortSignal?: AbortSignal): Promise<string | null> {
    if (!session.isActive) {
      logger.warn('Skipping summary — session is not active');
      return null;
    }

    if (abortSignal?.aborted) {
      logger.info('Summary execution skipped — already aborted');
      return null;
    }

    // SDK `resume` requires matching cwd — sessionWorkingDir is the SDK's
    // actual cwd; workingDirectory is the user base dir. Without this, the
    // fork looks under the wrong ~/.claude/projects path and silently loses
    // all conversation history (then create-fork-executor used to fall back
    // to a context-less retry that produced misleading output).
    const forkCwd = session.sessionWorkingDir ?? session.workingDirectory;

    logger.info('Executing summary', {
      model: session.model,
      hasIssue: !!session.links?.issue,
      hasPR: !!session.links?.pr,
      hasSessionId: !!session.sessionId,
      forkCwd,
      usedSessionWorkingDir: !!session.sessionWorkingDir,
    });

    const fullPrompt = this.buildPrompt(session);

    try {
      const response = await this.forkExecutor(fullPrompt, session.model, session.sessionId, forkCwd, abortSignal);

      // Check abort after await — the fork may have completed but user already sent new input
      if (abortSignal?.aborted) {
        logger.info('Summary fork completed but aborted — discarding result');
        return null;
      }

      logger.info('Summary fork completed', {
        hasResponse: !!response,
        responseLength: response?.length ?? 0,
      });
      return response;
    } catch (err: any) {
      if (err?.name === 'AbortError' || abortSignal?.aborted) {
        logger.info('Summary fork aborted', { reason: err?.message });
        return null;
      }
      logger.error('Summary fork failed', { error: err?.message || String(err) });
      return null;
    }
  }

  /**
   * Display summary result on thread header by setting summaryBlocks.
   * ThreadSurface picks these up during its next render cycle.
   *
   * Trace: S3, Section 3c
   */
  displayOnThread(session: SummarySessionInfo, summaryText: string): void {
    if (!session.actionPanel) {
      logger.warn('Cannot display summary — no actionPanel on session');
      return;
    }

    const summaryBlocks = this.buildSummaryBlocks(summaryText);
    session.actionPanel.summaryBlocks = summaryBlocks;

    logger.info('Summary displayed on thread', { blockCount: summaryBlocks.length });
  }

  /**
   * Clear summary display from thread header.
   * Trace: S5, Section 3b
   */
  clearDisplay(session: SummarySessionInfo): void {
    if (!session.actionPanel) return;
    if (!session.actionPanel.summaryBlocks) return;

    session.actionPanel.summaryBlocks = undefined;
    logger.info('Summary cleared from thread');
  }

  /** Slack section block text limit (mrkdwn) */
  private static readonly SLACK_SECTION_TEXT_LIMIT = 3000;

  /**
   * Convert summary text to Slack Block Kit blocks.
   * Long text is split across multiple section blocks to respect Slack's 3000-char limit.
   *
   * The LLM emits github-flavored markdown (`**bold**`, `## H2`, `__italic__`,
   * ```ts fenced blocks). Slack mrkdwn uses `*bold*`, `_italic_`, and has no
   * native heading syntax, so we normalize before emitting the mrkdwn section.
   * See `formatSummaryForSlack` for the line-by-line, fence-aware rewrite.
   */
  private buildSummaryBlocks(summaryText: string): any[] {
    const blocks: any[] = [{ type: 'divider' }];
    const header = '*Executive Summary*\n';
    const maxChunkSize = SummaryService.SLACK_SECTION_TEXT_LIMIT - header.length;

    const mrkdwnText = SummaryService.formatSummaryForSlack(summaryText);

    if (mrkdwnText.length <= maxChunkSize) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${header}${mrkdwnText}` },
      });
    } else {
      // Split on newline boundaries to avoid mid-word breaks
      const chunks = this.chunkText(mrkdwnText, maxChunkSize);
      chunks.forEach((chunk, i) => {
        const prefix = i === 0 ? header : '';
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `${prefix}${chunk}` },
        });
      });
    }

    return blocks;
  }

  /**
   * Rewrite github-flavored markdown to Slack mrkdwn, line by line, skipping
   * the bodies of fenced code blocks so the syntax inside ```...``` stays
   * verbatim.
   *
   * Rules:
   * - Opening fence `~~~lang` / ```lang has its language tag stripped (Slack
   *   mrkdwn fences don't support a language hint).
   * - Inside a fence: line is emitted unchanged (no bold/italic/header
   *   substitutions on code samples).
   * - Outside a fence:
   *   - ATX headings `# … ######` become `*…*` (Slack has no native heading
   *     block in a mrkdwn section, so bold is the closest visual approximation).
   *   - `**bold**` → `*bold*`
   *   - `__italic__` → `_italic_`
   *
   * Note: emphasis inside inline code (`...`) is not protected here. Slack
   * already renders inline-code spans correctly because Slack mrkdwn treats
   * backticks as literal code, so the marginal gain of a tokenizer doesn't
   * justify the complexity for the executive-summary surface.
   *
   * Marked `static` so tests can validate the converter directly without
   * constructing a service.
   */
  static formatSummaryForSlack(text: string): string {
    let inFence = false;
    return text
      .split('\n')
      .map((line) => {
        if (/^\s*```/.test(line)) {
          const wasInFence = inFence;
          inFence = !inFence;
          if (!wasInFence) {
            // Opening fence — strip the language tag (```ts → ```).
            return line.replace(/^(\s*)```[^\s`]*\s*$/, '$1```');
          }
          // Closing fence — emit verbatim.
          return line;
        }
        if (inFence) {
          // Inside a fenced code block — never touch.
          return line;
        }
        let out = line;
        // ATX headings: leading 1–6 `#` then space then content. Strip an
        // optional trailing `#` run + whitespace so `## Foo ##` also folds
        // cleanly to `*Foo*`.
        out = out.replace(
          /^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/,
          (_m, indent: string, content: string) => `${indent}*${content}*`,
        );
        // Bold: `**x**` → `*x*`. Non-greedy match on non-`*` runs keeps
        // adjacent bold spans separate.
        out = out.replace(/\*\*([^*]+)\*\*/g, '*$1*');
        // Italic: `__x__` → `_x_`.
        out = out.replace(/__([^_]+)__/g, '_$1_');
        return out;
      })
      .join('\n');
  }

  /**
   * Split text into chunks ≤ maxLen, preferring newline boundaries.
   */
  private chunkText(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) {
        // No newline found; hard-split at maxLen
        splitAt = maxLen;
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
    if (remaining.length > 0) {
      chunks.push(remaining);
    }
    return chunks;
  }
}

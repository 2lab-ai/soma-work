import type {
  HandoffContext,
  SessionLink,
  SessionLinkHistory,
  SessionLinks,
  WorkflowType,
} from 'somalib/model-commands/session-types';
import { Logger } from '../logger.js';

const logger = new Logger('SummaryService');

/** Workflow that forces the `epic` ES tier (multi-sub-issue epic sweep). */
const EPIC_WORKFLOW: WorkflowType = 'z-epic-update';

/**
 * Cap on per-kind link enumeration in the prompt body. A long-running session
 * accumulates dozens of PRs/issues in `linkHistory`; dumping them all every
 * turn-end bloats the prompt without changing the mode decision (which only
 * uses `.length`). The cap shows the most recent entries.
 */
const MAX_PROMPT_HISTORY_ENTRIES = 10;

/**
 * Executive-summary mode (host-selected from session state).
 *
 * Design: `src/local/skills/es/SKILL.md`. The three modes mirror
 * `using-epic-tasks` Case A/B/C but for the *report* layer — the legacy fixed
 * 8-section format becomes the `epic` tier, and the previous lighter
 * "What was done / Decisions / Open threads / Next actions" recap is the
 * `issue` and `brief` floor (preserved, not deleted).
 */
export type ExecutiveSummaryMode = 'brief' | 'issue' | 'epic';

/**
 * Global rules — language, no-tools guard, no-fabrication, conciseness — that
 * apply to every mode. Kept as a single exported constant for two reasons:
 *
 * 1. The existing harness test suite pins `buildPrompt() ⊇ SUMMARY_PROMPT`,
 *    so we preserve that invariant by composing every mode prompt as
 *    `<context>\n\n<mode template>\n\n<SUMMARY_PROMPT>`.
 *
 * 2. These rules are battle-tested (regression-pinned) and we explicitly do
 *    NOT want to fork them per mode. The mode template owns the *section
 *    shape*; SUMMARY_PROMPT owns the *truthfulness/format* contract.
 *
 * Trace: docs/turn-summary-lifecycle/trace.md, S3, Section 2.
 */
export const SUMMARY_PROMPT = `Based on the conversation history in this session, generate an Executive Summary describing the **actual work performed** — not a generic recap.

You MUST use ONLY the conversation history you already have. Do NOT attempt to call any tools, APIs, or external services.

Top-of-document invariant (applies to every mode that has artifacts):
1. **SSOT** — quote the user's instruction verbatim. Never paraphrase.
2. **Status** — issue/PR links with current state (Open / Draft / Merged / Closed / QA / etc.) and any state changes that happened in this session. In \`brief\` mode with no link at all, omit Status entirely rather than render an empty section.

Required content (omit any section that has nothing concrete to report — do NOT fabricate or hedge):

1. **What was done** — Concrete actions taken this session. List actual artifacts from the conversation: file paths edited or created (with full paths), commands run, commits made (hash + message if shown), PRs opened/updated/merged (with numbers and titles), issues touched (with numbers), tests or builds executed and their outcomes. List artifacts, not abstractions. Typically 3–10 bullets.

2. **Decisions made** — Specific design, architectural, or scope choices that were settled, with the rationale when it was discussed. Include only items with explicit decision signals ("we chose", "approved", "alternative considered and rejected"). Descriptive implementation language is NOT a decision. Skip if none.

3. **Open threads** — Anything left unresolved: failing tests, pending reviews, unanswered questions, blocked work.

4. **Suggested next actions** — Up to 3 concrete next steps the user can take. Each in its own code block for easy copy.

Rules:
- Be specific. "Refactored auth" is useless; "Edited src/auth/login.ts to add JWT refresh handling, ran npm test (passed)" is useful.
- Reference real artifacts from the conversation: file paths, function names, PR numbers, error messages, command names. Never invent values you did not see in history.
- If the session has truly no meaningful work history, say so in one sentence — do NOT ask the user for additional context or tool access.
- Write in the same language the conversation was conducted in.
- Respond with the summary only — no preamble, no markdown fences wrapping the whole response.`;

/**
 * Per-mode template body, inlined so the host fork — which has no tool access
 * — never has to read a file. Each template mirrors
 * `src/local/skills/es/reference/templates/<mode>.md` but compressed for
 * prompt tokens.
 *
 * The HA-discipline anti-pattern guards (epic body forbids file paths;
 * brief body forbids inventing artifacts) are encoded here so the LLM cannot
 * regress an `epic` ES into a long `issue` ES.
 */
const MODE_TEMPLATES: Record<ExecutiveSummaryMode, string> = {
  brief: `## Executive Summary mode: brief
Use this shape when there is no PR/issue produced this turn (Q&A, exploration, single-file edits without commit, clarification).

Sections (in order):
- **SSOT**: paste the user's instruction verbatim in a fenced block.
- **Status** *(OMIT this section entirely when no link/state change exists — empty Status is forbidden)*: only render if at least one link or state change actually exists from earlier in the session.
- **Outcome**: one paragraph or 2-4 bullets. What was answered / decided / attempted.
- **Key Details**: ≤5 bullets. Real artifacts only — file paths read, commands run. Never invent.
- **Next Actions**: ≤3 fenced code blocks, one per action.

Forbidden at brief mode: inventing PRs/commits, padding into Decisions/Verification/Risks sections.`,

  issue: `## Executive Summary mode: issue
Use this shape when one durable unit (1 issue + 1 PR) was produced this turn. Implementation detail is welcome here.

Sections (in order):
- **SSOT**: user's instruction verbatim.
- **Status**: one bullet per linked issue/PR — \`{label}: {url} — {state}\`. Include parent epic link if known. List session-scoped state transitions (e.g. \`Open → Merged\`).
- **Summary**: one paragraph naming files (file paths), commands, PR numbers. Concrete only.
- **Verification**: tests/builds/lint runs this session as \`{command} → {result}\`. Skip if nothing was verified.
- **Decisions Made**: explicit-signal decisions only. Skip if none.
- **Next Actions**: ≤3 fenced code blocks.

Required artifact references: file paths (\`src/foo.ts:42\`), command names, commits, PR numbers. Forbidden: inflating into multi-PR / workstream / risks tables — that's epic mode.`,

  epic: `## Executive Summary mode: epic
Use this shape when multiple PRs / sub-issues / root-cause analysis / STV verify cycle were produced this session.

HA discipline (binding): at epic mode, real artifacts are *issue links, PR links, statuses, architectural outcomes* — NOT files, functions, or commit hashes. Implementation detail belongs in the linked sub-issue/PR body. **Do not list file paths in section bodies.**

Sections (in order):
- **SSOT**: user's instruction verbatim.
- **Status**: epic link + Done/Remaining count; child issues table (#, Title, URL, State); child PRs table (#, Title, URL, State, Reviewer/Approval). List session-scoped state transitions explicitly.
- **Executive Summary**: one paragraph — the architectural outcome at the system level. Concept language only.
- **Workstream Status**: per workstream / sub-issue (child issues / child PRs), 1-2 lines on where it stands. Issue/PR-level granularity — do not drop into file/function detail.
- **Verification**: Spec Item | Status (✅/❌/🔶) | Verification Method. Final Verdict: PASS / PARTIAL / GAP_DETECTED / FAIL with \`{N}/{N} satisfied, {N} gaps\`.
- **Decisions Made**: architectural decisions with rationale. Explicit signals only.
- **Risks / Blockers**: Item | Status (⚠️/🔶/✅) | Action. Cover residual damage, deployment status, monitoring.
- **Next Actions**: ≤5 fenced code blocks.

Forbidden at epic mode: file paths, function names, commit hashes, long multi-line code/diff blocks, "Decisions Made" inferred from descriptive text. Avoid file paths and function-level detail entirely — link to the sub-issue/PR instead.`,
};

const MODE_RANK: Record<ExecutiveSummaryMode, number> = { brief: 0, issue: 1, epic: 2 };

/**
 * Format a remaining-time duration as `{m}m {s}s` / `{m}m` / `{s}s`.
 * Used for the countdown indicator. Negative inputs clamp to "0s".
 */
function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** Plain-text link line for the prompt body: `Title (url) — status` with sensible fallbacks. */
function formatLink(link: SessionLink): string {
  const name = link.title || link.label || 'untitled';
  const status = link.status ? ` — ${link.status}` : '';
  return `${name} (${link.url})${status}`;
}

/** Append a capped, indented history block (the model only needs the most recent entries). */
function pushHistory(target: string[], kind: 'PR' | 'Issue', entries: SessionLink[]): void {
  if (entries.length < 2) return;
  target.push(`- ${kind} history (${entries.length}):`);
  const shown = entries.slice(-MAX_PROMPT_HISTORY_ENTRIES);
  const omitted = entries.length - shown.length;
  for (const entry of shown) {
    target.push(`  - ${formatLink(entry)}`);
  }
  if (omitted > 0) {
    target.push(`  - … (${omitted} older entr${omitted === 1 ? 'y' : 'ies'} omitted)`);
  }
}

/**
 * Pick the executive-summary mode for this session based on accumulated
 * artifact scope.
 *
 * Rules (first match wins):
 * - `epic` — ≥2 PRs or ≥2 issues touched, or workflow == `z-epic-update`.
 * - `issue` — any durable PR or issue exists (active or in history).
 * - `brief` — no durable artifact.
 *
 * A parent-epic link in `handoffContext` is informational only — a single-PR
 * leaf inside an epic chain stays `issue`, otherwise every sub-issue would
 * render as `epic`.
 *
 * Stickiness has two sources:
 * 1. `linkHistory` is monotonically accumulated by
 *    `session-registry.updateSessionResources`, so a quiet turn after an
 *    `issue` turn naturally stays `issue`.
 * 2. `session.lastSummaryMode` floors the result — the surface never
 *    downgrades a prior `issue` / `epic` summary to `brief`, even if a host
 *    reset cleared `linkHistory`.
 */
export function selectExecutiveSummaryMode(session: SummarySessionInfo): ExecutiveSummaryMode {
  const prHistory = session.linkHistory?.prs?.length ?? 0;
  const issueHistory = session.linkHistory?.issues?.length ?? 0;
  const hasActivePr = !!session.links?.pr;
  const hasActiveIssue = !!session.links?.issue;
  const isEpicWorkflow = session.workflow === EPIC_WORKFLOW;

  let mode: ExecutiveSummaryMode;
  if (prHistory >= 2 || issueHistory >= 2 || isEpicWorkflow) {
    mode = 'epic';
  } else if (prHistory >= 1 || issueHistory >= 1 || hasActivePr || hasActiveIssue) {
    mode = 'issue';
  } else {
    mode = 'brief';
  }

  // Stickiness floor: never downgrade below the last rendered mode. Upgrades
  // remain possible (issue → epic on next merge of a second PR).
  const floor = session.lastSummaryMode;
  if (floor && MODE_RANK[floor] > MODE_RANK[mode]) {
    return floor;
  }
  return mode;
}

/**
 * Subset of the runtime `ConversationSession` (src/types.ts:175-201) that
 * `SummaryService` and `selectExecutiveSummaryMode` actually read. Real
 * sessions can be passed in directly because the shape is type-compatible;
 * tests construct partials.
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
  links?: SessionLinks;
  /**
   * Accumulated history of every link touched in this conversation. Populated
   * by `session-registry.updateSessionResources`. `selectExecutiveSummaryMode`
   * uses this so a quiet turn after a multi-PR turn does not silently
   * downgrade to `brief`.
   */
  linkHistory?: SessionLinkHistory;
  /** `z-epic-update` forces `epic` mode; other values do not influence mode selection on their own. */
  workflow?: WorkflowType;
  /**
   * Handoff context from a `z` chain. Informational only — a parent epic link
   * alone does NOT upgrade a single-PR leaf turn to `epic`. The full type is
   * imported so tests can pass a complete `HandoffContext` shape.
   */
  handoffContext?: HandoffContext;
  /**
   * Mode of the last successfully-rendered ES on this session. Acts as a
   * floor: once a session has shown `issue` or `epic`, a later quiet turn
   * cannot downgrade the surface to `brief`. Written by
   * `SummaryService.displayOnThread` after a successful render.
   */
  lastSummaryMode?: ExecutiveSummaryMode;
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
   * Build the full summary prompt from session context + tier template + global rules.
   *
   * Composition: `<Session Context with mode header>\n\n<MODE_TEMPLATES[mode]>\n\n<SUMMARY_PROMPT>`.
   * The host computes the mode; the LLM is told not to reclassify because a
   * one-shot, no-tools forked summary cannot reliably count artifacts from
   * transcript noise.
   */
  buildPrompt(session: SummarySessionInfo): string {
    const mode = selectExecutiveSummaryMode(session);
    const contextParts: string[] = [
      '## Session Context',
      `- Active ES mode: ${mode} (host-selected; do not reclassify)`,
    ];

    if (session.links?.issue) {
      contextParts.push(`- Active Issue: ${formatLink(session.links.issue)}`);
    }
    if (session.links?.pr) {
      contextParts.push(`- Active PR: ${formatLink(session.links.pr)}`);
    }
    if (!session.links?.issue && !session.links?.pr) {
      contextParts.push('- No active issues or PRs linked to this session');
    }

    const prHistory = session.linkHistory?.prs ?? [];
    const issueHistory = session.linkHistory?.issues ?? [];
    pushHistory(contextParts, 'PR', prHistory);
    pushHistory(contextParts, 'Issue', issueHistory);

    if (session.handoffContext?.parentEpicUrl) {
      contextParts.push(`- Parent epic: ${session.handoffContext.parentEpicUrl}`);
    }

    return `${contextParts.join('\n')}\n\n${MODE_TEMPLATES[mode]}\n\n${SUMMARY_PROMPT}`;
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
   * Also records `session.lastSummaryMode` so a later quiet turn cannot
   * downgrade the surface to `brief` (see `selectExecutiveSummaryMode`).
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
    session.lastSummaryMode = selectExecutiveSummaryMode(session);

    logger.info('Summary displayed on thread', {
      blockCount: summaryBlocks.length,
      mode: session.lastSummaryMode,
    });
  }

  /**
   * Render a "Executive Summary in {N}m {S}s" countdown block to the thread
   * surface during the pre-summary wait window. Mirrors `displayOnThread`'s
   * field layout (same `actionPanel.summaryBlocks` field) so the final
   * summary cleanly overwrites the countdown when the timer fires, and a
   * single `clearDisplay()` wipes either state on new user input.
   *
   * The block also carries a short prompt-cache-reset notice — the 5-minute
   * default wait window aligns with the Anthropic prompt-cache TTL, so by
   * the time the summary lands the cache has already expired. Telling the
   * user up front prevents the "why did my next turn get expensive?"
   * surprise.
   *
   * Tick text MUST differ across calls (the thread surface short-circuits
   * identical render keys), which is why the formatted remaining time
   * appears in the block text — every interval naturally produces a new
   * string.
   */
  displayCountdownOnThread(session: SummarySessionInfo, remainingMs: number): void {
    if (!session.actionPanel) return;

    const remainingText = formatRemaining(remainingMs);
    const blocks = [
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏳ *Executive Summary in ${remainingText}*\n_Prompt cache will reset when this fires._`,
        },
      },
    ];
    session.actionPanel.summaryBlocks = blocks;

    logger.info('Countdown displayed on thread', { remainingMs, remainingText });
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
   * Rewrite github-flavored markdown to Slack mrkdwn line by line, leaving
   * fenced code blocks verbatim:
   * - Opening fence: strip the language tag (```ts → ```).
   * - Inside a fence: pass through unchanged.
   * - Outside: ATX headings → `*…*`, `**bold**` → `*bold*`, `__italic__` → `_italic_`.
   *
   * Single-`*` emphasis (`*x*`) is deliberately *not* rewritten — in Slack
   * mrkdwn `*x*` is bold, so converting GFM italic to Slack `_x_` would have
   * to first distinguish it from already-bold text, which a line-level
   * regex pass can't do safely. Leaving it alone keeps both meanings legible
   * (Slack renders `*x*` as bold either way).
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
          return line;
        }
        if (inFence) return line;
        // ATX headings: leading 1–6 `#` then space then content. The trailing
        // `#*` strips an optional closing-hash run so `## Foo ##` folds to `*Foo*`.
        return line
          .replace(/^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/, (_m, indent: string, content: string) => `${indent}*${content}*`)
          .replace(/\*\*([^*]+)\*\*/g, '*$1*')
          .replace(/__([^_]+)__/g, '_$1_');
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

import { Logger } from '@soma/common/logger';
import { type SafeguardFlagInfo, safeguardFlagOf } from '@soma/common/safeguard';
import type { SessionLink, SessionLinks } from './directives/session-link-directive';
import type { HandoffContext, WorkflowType } from './handoff-budget';

export interface SessionLinkHistory {
  issues: SessionLink[];
  prs: SessionLink[];
  docs: SessionLink[];
}

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
 * Design: `src/local/skills/es/SKILL.md` (zworkflow es). soma-work's turn-end summary is `local:auto-es` run
 * without tools: the es contract below plus the skill's turn-end contract, which soma-work reads from
 * `src/local-harness/skills/auto-es/reference/turn-end.md` and hands in as `turnEndContract` (#857). The three modes mirror
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
 * Trace: docs/archive/features/turn-summary-lifecycle/trace.md, S3, Section 2.
 */
export const SUMMARY_PROMPT = `Based on the conversation history in this session, generate an Executive Summary describing the **actual work performed** — not a generic recap.

You MUST use ONLY the conversation history you already have. Do NOT attempt to call any tools, APIs, or external services.

TL;DR envelope (required in every mode):
- Open the response with a TL;DR block in exactly this shape, each tag on its own line:
<tldr>
first line
second line
third line
</tldr>
- Exactly 3 lines. Each line is one plain sentence of at most 100 characters — no bullets, headings, code or tables.
- Line 1 is the outcome: what changed, was decided or was answered. Lines 2 and 3 carry the most important supporting fact and the next step or open risk.
- Use only facts that also appear in the document below the block.
- The host removes this block from the document and shows it alone on the channel-visible thread surface; the full document is posted inside the thread. The block is an envelope, not part of the document — the document after it still starts with SSOT.

Top-of-document invariant (applies to the document after the TL;DR block, in every mode that has artifacts):
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
- Respond with the leading TL;DR block followed by the summary only — the TL;DR block is the only thing allowed before the document; no other preamble, no markdown fences wrapping the whole response.`;

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

/** The channel-visible thread surface never shows more than this many TL;DR lines. */
const TLDR_MAX_LINES = 3;
/**
 * Host hard cap per TL;DR line. The prompt asks for ≤100 characters; the
 * extra room is a safety margin for a slightly long line, not a second
 * contract.
 */
const TLDR_MAX_LINE_CHARS = 140;
/**
 * Shown on the surface when the model returned no usable TL;DR. It states the
 * failure and points at the thread; it does not claim the in-thread post
 * succeeded (that post's errors are swallowed). English, like the surface
 * header it sits under.
 */
export const TLDR_MISSING_POINTER = 'TL;DR not generated — see the thread for the full summary.';

const TLDR_OPEN_LINE = /^\s*<tldr>\s*$/i;
const TLDR_CLOSE_LINE = /^\s*<\/tldr>\s*$/i;
const FENCE_LINE = /^\s*(?:```|~~~)/;
const LIST_MARKER = /^(?:[-*•+]|\d+[.)])\s+/;

/** Where the surface TL;DR came from. Logged so model compliance with the envelope stays observable. */
export type TldrSource = 'model' | 'missing';

export interface ParsedExecutiveSummary {
  /** At most {@link TLDR_MAX_LINES} plain lines (list markers stripped), each capped in length. Empty when missing. */
  tldr: string[];
  /** The full Executive Summary with the `<tldr>` envelope removed. */
  body: string;
  tldrSource: TldrSource;
}

function capTldrLine(line: string): string {
  const chars = Array.from(line);
  if (chars.length <= TLDR_MAX_LINE_CHARS) return line;
  return `${chars
    .slice(0, TLDR_MAX_LINE_CHARS - 1)
    .join('')
    .trimEnd()}…`;
}

/** One TL;DR line, trimmed and without a list marker — the one normalization both es paths share (#829). */
export function cleanTldrLine(line: string): string {
  return line.trim().replace(LIST_MARKER, '').trim();
}

function cleanTldrLines(lines: string[]): string[] {
  return lines
    .map(cleanTldrLine)
    .filter((line) => line.length > 0)
    .slice(0, TLDR_MAX_LINES)
    .map(capTldrLine);
}

/**
 * #829 — a TL;DR line as plain text: the contract's bold (`**x**`) unwrapped. The Slack surface renders the
 * bold; the dashboard card draws text as is, so it shows this form (and the follow-up reason is built from it).
 * #846 — double underscores are not unwrapped: in a TL;DR they are identifiers (`__init__`), not emphasis.
 */
export function plainTldrLine(line: string): string {
  return line.replace(/\*\*([^*]+)\*\*/g, '$1');
}

/**
 * #846 — this turn's model-run es (`local:auto-es`) wrote the card (`executiveSummary.source === 'es'`). The host
 * fork of the same turn would be ignored by the card, so the turn end does not start it. The next input clears the
 * marker (`clearDisplay`).
 */
export function esWroteCardThisTurn(session: object): boolean {
  return (session as { executiveSummary?: { source?: unknown } }).executiveSummary?.source === 'es';
}

/**
 * #881 B1 — did this turn fold in a steered send the es could not have had? Only a send pushed at or after the es
 * write was issued (`executiveSummary.issuedAt`, from its receiptId) re-opens the verdict; one pushed before it was
 * already in the turn the es judged. Unknown either way (no issue time, or a send this process did not push) →
 * re-judge, as before #881.
 */
export function steerAfterEs(session: object, pushedAt: ReadonlyArray<number | undefined>): boolean {
  if (pushedAt.length === 0) return false;
  const es = (session as { executiveSummary?: { source?: unknown; issuedAt?: unknown } }).executiveSummary;
  if (es?.source !== 'es' || typeof es.issuedAt !== 'number') return true;
  const issuedAt = es.issuedAt;
  return pushedAt.some((at) => at === undefined || at >= issuedAt);
}

/**
 * #846 — input reached the model after this turn's es wrote the card (a steered message): the es verdict no longer
 * covers the turn. Drops the marker only; the TL;DR stays until the turn-end summary decides again.
 */
export function releaseEsCard(session: object): void {
  const s = session as { executiveSummary?: { tldr: string[]; at: number; source?: string } };
  if (s.executiveSummary?.source !== 'es') return;
  const { tldr, at } = s.executiveSummary;
  s.executiveSummary = { tldr, at };
}

/** A TL;DR line that starts with ⚠️ (after any emphasis markers) — the unfinished-own-artifact signal (#829). */
const FOLLOW_UP_LINE = /^[\s*_~]*\u26a0\ufe0f?/u;

/**
 * #829 — what the task card waits on the user for: the TL;DR's ⚠️ lines, markup stripped, joined.
 *
 * The `local:auto-es` contract (#857) reserves a leading ⚠️ in a TL;DR line for "an issue/PR this session created is not
 * complete, and why". The same line the reader sees emphasized is the host's signal — one source, so the card
 * cannot say "waiting" while the summary says "done", or the reverse. Undefined when no line carries it.
 */
export function followUpFromTldr(tldr: readonly string[]): { reason: string } | undefined {
  const reasons = tldr
    .filter((line) => FOLLOW_UP_LINE.test(line))
    .map((line) =>
      plainTldrLine(line.replace(FOLLOW_UP_LINE, ''))
        .replace(/\*\*/g, '')
        // #846 — strip leftover bold/strike markers and the separator, never an identifier's underscores.
        .replace(/^[\s*~:—-]+|[\s*~]+$/g, '')
        .trim(),
    )
    .filter((reason) => reason.length > 0);
  return reasons.length > 0 ? { reason: reasons.join(' · ') } : undefined;
}

/**
 * #829 / #917 — the follow-up the last Executive Summary left: its ⚠️ reason and when it started (`at`, the idle clock
 * it floors). `askedAt` / `questionTurnId` — the host asked the follow-up question for this verdict
 * (`src/slack/follow-up-question.ts`); each new verdict drops them, so the next stop asks again.
 */
export interface SessionFollowUp {
  reason: string;
  at: number;
  askedAt?: number;
  questionTurnId?: string;
}

type FollowUpListener = (session: { followUp?: SessionFollowUp }, previous: SessionFollowUp | undefined) => void;
let followUpListener: FollowUpListener | undefined;

/**
 * #917 — the host hears every verdict on a session's follow-up (set, kept, cleared), with what it was before: a new
 * verdict may ask the follow-up question, a cleared or changed one retracts the question it asked. One slot.
 */
export function setFollowUpListener(fn: FollowUpListener | undefined): void {
  followUpListener = fn;
}

/**
 * #846 — the follow-up a TL;DR leaves, set on the session. It is one fact with one start time: the same ⚠️ reason again
 * keeps its time (the idle clock it floors and the panel's announcement do not restart, so re-running es on an
 * unfinished artifact cannot push sleep out forever); a new reason starts at `at` and clears the sleep warnings sent on
 * the old clock (they named the old expiry, and a sent warning is not sent again until cleared). No ⚠️ line clears it.
 * #917 — every call is a new verdict: the same reason keeps its time but not its asked mark, so the host asks again.
 */
export function applyFollowUp(session: object, tldr: readonly string[], at: number): string | undefined {
  const s = session as {
    followUp?: SessionFollowUp;
    lastWarningSentAt?: number;
    warningMessageTs?: string;
  };
  const previous = s.followUp ? { ...s.followUp } : undefined;
  const next = followUpFromTldr(tldr);
  let posted: string | undefined;
  if (!next) {
    s.followUp = undefined;
  } else if (previous?.reason === next.reason) {
    // A new verdict on the same follow-up: same clock, may be asked again. The question already asked for it stays
    // bound (`questionTurnId`) — while it is open no second one is asked, and a later clear still takes it back.
    s.followUp = {
      reason: next.reason,
      at: previous.at,
      ...(previous.questionTurnId ? { questionTurnId: previous.questionTurnId } : {}),
    };
  } else {
    s.followUp = { reason: next.reason, at };
    // #881 D1 — the warning already posted named the old expiry: hand it back so the caller edits it.
    posted = s.warningMessageTs;
    s.lastWarningSentAt = undefined;
    s.warningMessageTs = undefined;
  }
  if (previous || s.followUp) {
    try {
      followUpListener?.(s, previous);
    } catch (error) {
      logger.warn('Follow-up listener failed', { error: (error as Error)?.message ?? String(error) });
    }
  }
  return posted;
}

/**
 * Split a raw Executive Summary response into the TL;DR envelope and the
 * full document.
 *
 * Only a LEADING, CLOSED envelope counts: the first non-blank line must be a
 * standalone `<tldr>` and a standalone `</tldr>` line must follow. Anywhere
 * else, `<tldr>` is document content (an ES about this very feature quotes
 * it) and is left untouched, so the in-thread copy stays complete.
 *
 * Failure handling never invents a summary from the body — the body starts
 * with the verbatim SSOT quote, so "first lines of the body" would put the
 * user's own instruction on the channel as if it were a conclusion:
 * - no leading envelope → `missing`, body unchanged;
 * - leading `<tldr>` never closed → `missing`, only that opener line is
 *   dropped (protocol must not leak), every other line is kept;
 * - closed but empty envelope → `missing`, envelope removed.
 * A model TL;DR longer than 3 lines is cut to 3, never padded.
 */
export function parseExecutiveSummary(raw: string): ParsedExecutiveSummary {
  const lines = raw.split('\n');
  let open = 0;
  while (open < lines.length && lines[open].trim() === '') open++;
  if (open >= lines.length || !TLDR_OPEN_LINE.test(lines[open])) {
    return { tldr: [], body: raw, tldrSource: 'missing' };
  }

  // The envelope must close before the first code fence (``` or ~~~): a
  // `</tldr>` inside a fenced example further down is document content, not
  // our terminator.
  let close = -1;
  for (let i = open + 1; i < lines.length && !FENCE_LINE.test(lines[i]); i++) {
    if (TLDR_CLOSE_LINE.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    const body = lines
      .filter((_, i) => i !== open)
      .join('\n')
      .trim();
    return { tldr: [], body, tldrSource: 'missing' };
  }

  const tldr = cleanTldrLines(lines.slice(open + 1, close));
  const body = lines
    .slice(close + 1)
    .join('\n')
    .trim();
  return { tldr, body, tldrSource: tldr.length > 0 ? 'model' : 'missing' };
}

/**
 * Text of the in-thread ES message: the TL;DR (same lines as the surface)
 * followed by the whole document. Rendered through `buildSummaryBlocks`, so
 * it gets the same markdown rewrite and 3000-char chunking.
 */
/**
 * SSOT 2026-11-02 T7 — the whole Executive Summary as the dashboard's chat shows it: the TL;DR
 * as a markdown list, then the document with the `<tldr>` envelope removed.
 */
export function composeExecutiveSummaryMarkdown(raw: string): string {
  const { tldr, body } = parseExecutiveSummary(raw);
  if (tldr.length === 0) return body;
  const head = ['**TL;DR**', ...tldr.map((line) => `- ${line}`)].join('\n');
  return body ? `${head}\n\n${body}` : head;
}

function composeInThreadSummary({ tldr, body }: ParsedExecutiveSummary): string {
  if (tldr.length === 0) return body;
  const tldrSection = ['**TL;DR**', ...tldr.map((line) => `• ${line}`)].join('\n');
  return body ? `${tldrSection}\n\n${body}` : tldrSection;
}

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
  /** #881 D1 — the thread's channel, to edit a stale expiry warning ('' for a Slack-less task). */
  channelId?: string;
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
   * Docs: docs/stale-plans/review-needed/claude-agent-sdk/sessions.md L234-L235.
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
  /**
   * SSOT 2026-11-02 T7 — the TL;DR the thread head shows, for the dashboard's task card: set by
   * `displayOnThread` (only when the summary has one), cleared by `clearDisplay` on the next input.
   */
  executiveSummary?: { tldr: string[]; at: number; source?: 'es'; issuedAt?: number };
  /**
   * #829 — the latest Executive Summary left an own issue/PR unfinished (its ⚠️ TL;DR line). Set and cleared only by
   * an Executive Summary (`displayOnThread`, or the model-run es through UPDATE_SESSION) — the next user input does
   * not clear it. #917 — it waits on the user through the host's follow-up question, never on its own.
   */
  followUp?: SessionFollowUp;
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
 * Minimal Slack API surface needed for posting an in-thread summary message.
 * Keeps `SummaryService` from depending on the full `SlackApiHelper`.
 */
export interface SummarySlackApi {
  postMessage: (
    channel: string,
    text: string,
    options?: { threadTs?: string; blocks?: any[]; [key: string]: any },
  ) => Promise<any>;
}

/** Construction options for {@link SummaryService}. */
export interface SummaryServiceOptions {
  /**
   * #857 — the harness skill's turn-end contract (`local:auto-es`, reference/turn-end.md), appended after the es
   * contract. soma-work reads it from the bundled harness plugin; without it the summary is the generic es one.
   */
  turnEndContract?: string;
  /**
   * #881 D1 — a new ⚠️ follow-up cleared an expiry warning already posted: the host edits it (behind the same
   * live-root gate as every lifecycle notice). Fire-and-forget.
   */
  onWarningCleared?: (session: SummarySessionInfo, warningMessageTs: string) => void;
  /**
   * #904 — Anthropic's safeguards blocked the summary query itself (it resumes
   * the session's own conversation): the host halts the session. The summary
   * returns null as for any failure.
   */
  onSafeguardFlag?: (session: SummarySessionInfo, flag: SafeguardFlagInfo) => void;
}

/**
 * Handles executive summary generation and display.
 *
 * - execute(): builds prompt from session context, calls forkExecutor, returns response
 * - displayOnThread(): sets summaryBlocks on actionPanel for ThreadSurface rendering
 * - displayCountdownOnThread(): renders a "X minutes remaining" indicator
 * - postInThread(): posts the summary as a permanent in-thread message
 * - clearDisplay(): removes summaryBlocks, triggers re-render
 *
 * Trace: docs/archive/features/turn-summary-lifecycle/trace.md, S3 + S5
 */
/**
 * Apply `rewrite` to `line` with its inline code spans (`` `…` ``) held out: each span is swapped for a placeholder,
 * so markup around a span still pairs up (`**run `x` now**`), and the span comes back exactly as written. The
 * placeholder is NUL-delimited: model text carries no NUL, so it cannot collide with the summary itself.
 */
function outsideInlineCode(line: string, rewrite: (part: string) => string): string {
  const spans: string[] = [];
  const held = line.replace(/`[^`\n]*`/g, (span) => `\u0000${spans.push(span) - 1}\u0000`);
  return rewrite(held).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? '');
}

export class SummaryService {
  private forkExecutor: ForkExecutor;
  private slackApi?: SummarySlackApi;
  private turnEndContract?: string;

  /**
   * @param forkExecutor - Injected function that executes prompt via forked session.
   *   If not provided, falls back to returning the prompt text (stub behavior for testing).
   * @param slackApi - Injected Slack API for in-thread posting. Optional —
   *   when absent, `postInThread` becomes a no-op (tests and host-fork
   *   configurations without Slack credentials still work).
   */
  private readonly onWarningCleared?: (session: SummarySessionInfo, warningMessageTs: string) => void;

  constructor(forkExecutor?: ForkExecutor, slackApi?: SummarySlackApi, options?: SummaryServiceOptions) {
    this.forkExecutor = forkExecutor ?? (async (prompt) => prompt);
    this.slackApi = slackApi;
    this.turnEndContract = options?.turnEndContract?.trim() || undefined;
    this.onWarningCleared = options?.onWarningCleared;
    this.onSafeguardFlag = options?.onSafeguardFlag;
  }

  private readonly onSafeguardFlag?: SummaryServiceOptions['onSafeguardFlag'];

  /**
   * Build the full summary prompt from session context + tier template + global rules.
   *
   * Composition: `<Session Context with mode header>\n\n<MODE_TEMPLATES[mode]>\n\n<SUMMARY_PROMPT>`, then the
   * `local:auto-es` turn-end contract when one was handed in (#857).
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

    const base = `${contextParts.join('\n')}\n\n${MODE_TEMPLATES[mode]}\n\n${SUMMARY_PROMPT}`;
    // #857 — soma-work's turn end runs `local:auto-es`: its harness rules come last, on top of the es contract.
    return this.turnEndContract ? `${base}\n\n${this.turnEndContract}` : base;
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
      const blocked = safeguardFlagOf(err);
      if (blocked) {
        logger.warn('Summary fork blocked by Anthropic safeguards — halting the session', { ...blocked });
        try {
          this.onSafeguardFlag?.(session, blocked);
        } catch (haltErr: any) {
          logger.error('Summary safeguard halt failed', { error: haltErr?.message || String(haltErr) });
        }
        return null;
      }
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
    // The surface is the channel-visible thread root, so it carries only the
    // TL;DR. The full ES goes inside the thread via `postInThread`.
    const { tldr, tldrSource } = parseExecutiveSummary(summaryText);
    // #829 — the model-run es wrote this turn's card with tools (`executiveSummary.source: 'es'`): the tool-less
    // host fork of the same turn leaves the card alone, TL;DR and verdict as one pair. The user's next input
    // (`clearDisplay`) drops that TL;DR, so the next summary decides again.
    if (session.executiveSummary?.source !== 'es') {
      // The dashboard's task card shows the same lines (SSOT 2026-11-02 T7), so this comes
      // before the thread-head guard.
      const at = Date.now();
      if (tldr.length > 0) session.executiveSummary = { tldr, at };
      else session.executiveSummary = undefined;
      // #829 — a well-formed TL;DR decides whether the card waits on its user; a reply with none keeps the
      // previous verdict (a malformed summary is no evidence the work got finished).
      if (tldr.length > 0) {
        const staleWarning = applyFollowUp(session, tldr, at);
        // #881 D1 — the host edits it, behind the same live-root gate as every lifecycle notice.
        if (staleWarning) {
          try {
            this.onWarningCleared?.(session, staleWarning);
          } catch (error) {
            logger.warn('Stale expiry warning not edited', { error: (error as Error)?.message });
          }
        }
      }
    }

    if (!session.actionPanel) {
      logger.warn('Cannot display summary — no actionPanel on session');
      return;
    }

    const summaryBlocks = this.buildTldrBlocks(tldr);
    session.actionPanel.summaryBlocks = summaryBlocks;
    session.lastSummaryMode = selectExecutiveSummaryMode(session);

    if (tldrSource === 'missing') {
      logger.warn('Executive Summary has no <tldr> envelope — surface shows the pointer line', {
        mode: session.lastSummaryMode,
      });
    }
    logger.info('Summary TL;DR displayed on thread surface', {
      blockCount: summaryBlocks.length,
      mode: session.lastSummaryMode,
      tldrSource,
      tldrLines: tldr.length,
    });
  }

  /**
   * Thread-surface blocks: a divider plus one section holding the header and
   * at most {@link TLDR_MAX_LINES} TL;DR lines. With no TL;DR, a single pointer
   * line stands in — the surface is never left blank, because it is also the
   * "summary arrived" signal.
   */
  buildTldrBlocks(tldr: string[]): any[] {
    const lines =
      tldr.length > 0 ? tldr.map((line) => `• ${SummaryService.formatTldrLineForSlack(line)}`) : [TLDR_MISSING_POINTER];
    return [
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Executive Summary · TL;DR*\n${lines.join('\n')}` },
      },
    ];
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
   * #846 — a turn whose model-run es wrote the card has no host summary (`esWroteCardThisTurn`). The thread head
   * shows the TL;DR that es wrote instead, so Slack and the card say the same thing. No fork, no tool call.
   */
  displayEsTldrOnThread(session: SummarySessionInfo): void {
    const tldr = session.executiveSummary?.tldr ?? [];
    if (!session.actionPanel || tldr.length === 0) return;
    session.actionPanel.summaryBlocks = this.buildTldrBlocks(tldr);
    logger.info('es TL;DR displayed on thread surface', { tldrLines: tldr.length });
  }

  /**
   * Clear summary display from thread header.
   * Trace: S5, Section 3b
   */
  clearDisplay(session: SummarySessionInfo): void {
    // The dashboard card's TL;DR goes with the thread head's — even where there is no head to clear.
    session.executiveSummary = undefined;
    // #829 — the follow-up stays: the card keeps waiting until a summary judges the work again.
    if (!session.actionPanel) return;
    if (!session.actionPanel.summaryBlocks) return;

    session.actionPanel.summaryBlocks = undefined;
    logger.info('Summary cleared from thread');
  }

  /**
   * Post the Executive Summary as a permanent message in the thread, in
   * addition to the floating header surface. The header is volatile (next
   * user message wipes it via `clearDisplay`); this message is durable so
   * the summary becomes part of the conversation history.
   *
   * Deliberately NOT registered with `completionMessageTracker` — that would
   * make the next user message delete the summary along with the
   * "작업 완료" notification. The host caller (stream-executor) must skip
   * tracking too.
   *
   * No-op when:
   * - no `slackApi` was injected (test fixtures / fork-only environments);
   * - the session has no `threadTs` (otherwise we'd accidentally post to the
   *   channel root, which is never what we want);
   * - the Slack API throws (errors are logged and swallowed — the summary
   *   surface render already succeeded, and a missing in-thread post must
   *   not crash the host fork).
   */
  async postInThread(
    session: SummarySessionInfo & { channelId?: string; threadTs?: string; sessionTitle?: string },
    summaryText: string,
  ): Promise<void> {
    if (!this.slackApi) return;
    if (!session.threadTs) {
      logger.debug('Skipping in-thread summary post — no threadTs');
      return;
    }
    if (!session.channelId) {
      logger.debug('Skipping in-thread summary post — no channelId');
      return;
    }

    // Full ES in the thread: TL;DR on top (same lines as the surface), then
    // the whole document with the `<tldr>` envelope removed.
    const blocks = this.buildSummaryBlocks(composeInThreadSummary(parseExecutiveSummary(summaryText)));
    const fallbackText = session.sessionTitle ? `Executive Summary — ${session.sessionTitle}` : 'Executive Summary';

    try {
      await this.slackApi.postMessage(session.channelId, fallbackText, {
        threadTs: session.threadTs,
        blocks,
      });
      logger.info('Summary posted in-thread', {
        channelId: session.channelId,
        threadTs: session.threadTs,
        blockCount: blocks.length,
      });
    } catch (err: any) {
      logger.warn('Failed to post in-thread summary', {
        channelId: session.channelId,
        threadTs: session.threadTs,
        error: err?.message || String(err),
      });
    }
  }

  /** Slack section block text limit (mrkdwn) */
  private static readonly SLACK_SECTION_TEXT_LIMIT = 3000;

  /**
   * Convert summary text to Slack Block Kit blocks.
   * Long text is split across multiple section blocks to respect Slack's 3000-char limit.
   *
   * The LLM emits github-flavored markdown (`**bold**`, `## H2`, ```ts fenced
   * blocks). Slack mrkdwn uses `*bold*` and has no native heading syntax, so we
   * normalize before emitting the mrkdwn section.
   * See `formatSummaryForSlack` for the line-by-line, fence-aware rewrite.
   */
  buildSummaryBlocks(summaryText: string): any[] {
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
   * - Outside: ATX headings → `*…*`, `**bold**` → `*bold*` (inline code held out); `__x__` stays — it is an
   *   identifier (`__init__`), as on the TL;DR line (#881 B3).
   *
   * Single-`*` emphasis (`*x*`) is deliberately *not* rewritten — in Slack
   * mrkdwn `*x*` is bold, so converting GFM italic to Slack `_x_` would have
   * to first distinguish it from already-bold text, which a line-level
   * regex pass can't do safely. Leaving it alone keeps both meanings legible
   * (Slack renders `*x*` as bold either way).
   */
  /**
   * #846 — one TL;DR line for the Slack head: only the contract's bold (`**x**`) becomes Slack bold. A TL;DR has
   * no headings or fences, and `__x__` there is an identifier (`__init__`), not emphasis — the card shows the same.
   */
  static formatTldrLineForSlack(line: string): string {
    return outsideInlineCode(line, (part) => part.replace(/\*\*([^*]+)\*\*/g, '*$1*'));
  }

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
        // Bold only. Double underscores stay as written: they belong to identifiers (`__init__`, `obj.__dict__`),
        // as on the TL;DR line (#871); inline code is never rewritten (#881 B3).
        return outsideInlineCode(
          line.replace(
            /^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/,
            (_m, indent: string, content: string) => `${indent}*${content}*`,
          ),
          (part) => part.replace(/\*\*([^*]+)\*\*/g, '*$1*'),
        );
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

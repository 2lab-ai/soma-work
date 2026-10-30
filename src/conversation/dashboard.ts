/**
 * Dashboard module — personal Kanban board + statistics.
 * Extends the existing Fastify conversation web server.
 *
 * Routes:
 *   GET  /dashboard                          → Dashboard HTML (all users overview)
 *   GET  /dashboard/:userId                  → Dashboard HTML (specific user)
 *   GET  /api/dashboard/sessions             → All active sessions as Kanban data (JSON)
 *   GET  /api/dashboard/stats                → Period statistics, one user or all users (JSON)
 *   GET  /api/dashboard/usage                → Period token usage + cost, one user or all users (JSON)
 *   GET  /api/dashboard/users                → User list (JSON)
 *   GET  /api/dashboard/lifecycle            → Session lifecycle policy (JSON; also in the sessions response)
 *   PUT  /api/dashboard/lifecycle            → Update it (admin: viewer token, or ADMIN_USERS + X-Admin-Mode: on);
 *                                              409 + counts when it would sleep/end sessions, unless ?confirm=1
 *   GET  /api/dashboard/session/:id          → Session detail turns (JSON)
 *   GET  /api/dashboard/session/:id/worklog  → Work log entries (JSON, registered in work-log-routes.ts)
 *   POST /api/dashboard/session/:id/ensure-title   → Fill a missing titleSub (any signed-in viewer; never overwrites)
 *   POST /api/dashboard/session/:id/generate-title → Regenerate titleSub (owner, or ADMIN_USERS + X-Admin-Mode: on)
 *   POST /api/dashboard/session/:key/stop    → Stop a working session
 *   POST /api/dashboard/session/:key/close   → Close/terminate a session
 *   POST /api/dashboard/session/:key/trash   → Trash (hide) a closed session
 *   POST /api/dashboard/session/:key/command → Send command to session
 *   POST /api/dashboard/session/:key/goal    → Add a goal / delete the current or a queued goal
 *   POST /api/dashboard/session/:key/model   → Switch to a representative model (compacts first when needed)
 *   POST /api/dashboard/session/:conversationId/resummarize/:turnId → Retry summary generation
 *   WS   /ws/dashboard                       → Real-time session state updates (WebSocket),
 *                                              incl. `work_log` entries (owner/admin scoped)
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants as zlibConstants } from 'node:zlib';
import type { FollowupItem, FollowupItemState } from '@soma/slack/followup-queue';
import type { FollowupQueueView } from '@soma/slack/followup-queue-blocks';
import { sumLiveUsage } from '@soma/slack/live-usage';
import { livePendingModelSwitch } from '@soma/slack/model-switch';
import type { FastifyInstance } from 'fastify';
import type { CronExecutionRecord, CronJob } from 'somalib/cron/cron-storage';
import type { LlmuxStatus } from '../auth/llmux-client';
import type { LlmuxTierId } from '../auth/llmux-tiers';
import { config } from '../config';
import { displayTitle } from '../format/display-title';
import { Logger } from '../logger';
import { MetricsEventStore } from '../metrics/event-store';
import { calculateTokenCost, findModelPricing } from '../metrics/model-registry';
import { ReportAggregator } from '../metrics/report-aggregator';
import type { MetricsEvent } from '../metrics/types';
import { clampEffortToModel, modelCatalog } from '../model-catalog';
import {
  type AnswerPermissionPromptArgs,
  isPermissionPromptDecision,
  loadPermissionPrompt,
  type PermissionPromptAnswer,
  promptBelongsToThread,
} from '../permission-prompt-response';
import {
  type AgentRegistry,
  type AgentSpend,
  loseRunningAgents,
  type SubagentSpendSum,
  sanitizeAgentRegistry,
  subagentSpendOf,
} from '../session/agent-registry';
import { resolveEffectiveAutoCompact } from '../session/autocompact-policy';
import { sanitizeCronJob } from '../session/cron-job';
import { EffortSwitchError, type EffortSwitchResult } from '../session/effort-switch';
import { productionModelCatalogDeps } from '../session/model-catalog-deps';
import {
  listRepresentativeModels,
  ModelSwitchError,
  type ModelSwitchResult,
  usedContextTokens,
} from '../session/model-switch';
import {
  ledgerTasks,
  sanitizeTaskLedger,
  type TaskDropped,
  type TaskRevision,
  type TaskTokens,
  type TaskWork,
} from '../session/task-ledger';
import { type ArchivedSession, getArchiveStore, type SessionLifecycleOutcome } from '../session-archive';
import { buildWorkSessionKey, normalizeSessionKey } from '../session-identity';
import {
  countLifecycleTransitions,
  getSessionLifecyclePolicy,
  isSessionLifecyclePolicyDegraded,
  previewSessionLifecyclePolicy,
  SessionLifecyclePolicyError,
  updateSessionLifecyclePolicy,
} from '../session-lifecycle-policy';
import { GOAL_EVAL_DISPATCH_MAX_RETRIES } from '../slack/goal-completion-evaluator';
import { type HostGoalAction, HostGoalActionError, type HostGoalActionResult } from '../slack/goal-host-actions';
import { getSurfaceLines } from '../slack/surface-config';
import { buildThreadPermalink } from '../turn-notifier';
import { coerceEffort, EFFORT_LEVELS, type EffortLevel, userSettingsStore } from '../user-settings-store';
import { fetchSiblingBoards, type InstanceEnvironment, mergeBoards, shouldAggregate } from './aggregator';
import { backfillArtifactsFromWorkLog } from './artifact-capture';
import { type ArtifactSummary, getArtifactStore, type SessionArtifact } from './artifacts';
import { buildCapacityView, type CapacityView } from './capacity-view';
import { buildCronJobsView, type CronRunSessionLookup } from './cron-view';
import { readAllInstances } from './instance-registry';
import {
  createNewTaskGate,
  NEW_TASK_BODY_LIMIT,
  NEW_TASK_LIMITS,
  type NewTaskAttachment,
  type NewTaskContext,
  NewTaskError,
  type NewTaskSubmission,
  parseAttachments,
  parseNewTaskSubmission,
} from './new-task';
import type { NewTaskLaunchResult } from './new-task-launcher';
import {
  type DashboardPermissionRequest,
  pendingPermissionsFor,
  permissionPromptDetail,
  refreshPendingPermissions,
  startPermissionPromptWatch,
  stopPermissionPromptWatch,
} from './permission-prompts';
import { getConversation, resummarizeTurn } from './recorder';
import { ensureTitleSub, regenerateTitleSub, type TitleSubResult } from './title-sub';
import {
  fillUiIcons,
  pageTokenAliases,
  UI_LIB_FILE,
  UI_LIB_VERSION,
  uiLibDistDir,
  uiLibKitCss,
  uiLibTokensCss,
} from './ui-lib';
import { getUserMediaStore } from './user-media';
import type { WorkLogEntry } from './work-log';

const logger = new Logger('Dashboard');

/** The @2lab.ai/ui build the /dashboard/ui route serves — moved to ./ui-lib (the settings page loads it too). */
export { UI_LIB_FILE, uiLibDistDir };

/** Who reads a usage report: an admin or an operator token sees per-user spend; everyone else the totals and models. */
export interface UsageViewer {
  isAdmin?: boolean;
  mode?: string;
}
/**
 * affectUI review batch 1 (Z, 2026-10-27): spend by model for everyone, by user for admins only. The report's
 * per-user parts (byUser, the rankings) leave the server only for an admin or an operator token.
 */
export function usageForViewer<T extends { byUser: unknown; tokenRankings: unknown[]; costRankings: unknown[] }>(
  report: T,
  viewer: UsageViewer | undefined,
): T {
  if (viewer?.isAdmin || viewer?.mode === 'bearer_header' || viewer?.mode === 'bearer_cookie') return report;
  return { ...report, byUser: {}, tokenRankings: [], costRankings: [] };
}

// ── Types ──────────────────────────────────────────────────────────

export interface KanbanSession {
  key: string;
  title: string;
  /**
   * Latest assistant-turn summaryTitle for this session, when one has been
   * generated. Clients prefer this over {@link title} for card display so
   * refreshed pages match the live `summaryTitleChanged` WS patch. Absent
   * when no assistant turn has produced a summaryTitle yet.
   */
  summaryTitle?: string;
  /**
   * Server-resolved card / panel headline (#762). Computed by `displayTitle()`
   * over the full priority chain (`summaryTitle → issueTitle → prTitle →
   * title → 'Untitled'`). Clients render this verbatim instead of repeating
   * the priority logic, so card and panel surfaces stay in lock-step.
   */
  displayHeadline: string;
  /**
   * The cron job whose fire created this session (SSOT 2026-10-23 T3/T4).
   * The client files the card in the CRON lane under this job and leads its
   * head with the CRON badge. Absent for every other session.
   */
  cronJob?: { id?: string; name: string };
  ownerName: string;
  ownerId: string;
  workflow: string;
  model: string;
  channelId: string;
  threadTs?: string;
  activityState: 'working' | 'waiting' | 'idle';
  sessionState: string; // MAIN | SLEEPING
  terminated?: boolean;
  trashed?: boolean;
  /**
   * SSOT 2026-10-30 — starred by its owner: listed first in its column (a
   * pinned group in DONE) and kept alive (never slept or archived). Live
   * sessions only; an archive is never starred.
   */
  starred?: boolean;
  conversationId?: string;
  lastActivity: string; // ISO
  /** Links */
  issueUrl?: string;
  issueLabel?: string;
  issueTitle?: string;
  prUrl?: string;
  prLabel?: string;
  prTitle?: string;
  prStatus?: string;
  /** Merge stats */
  mergeStats?: {
    totalLinesAdded: number;
    totalLinesDeleted: number;
  };
  /**
   * Token usage — session totals of every token kind and the API-equivalent
   * cost. While a turn runs, the calls it has made so far are folded in
   * (SSOT 2026-10-22 T1/T2), so the numbers grow during the turn.
   */
  tokenUsage?: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreateTokens: number;
    totalCostUsd: number;
    contextUsagePercent: number;
    /**
     * SSOT 2026-10-26 T3 — the totals count from this time, not from the
     * task's start (a task that had spent before the total was kept).
     */
    partialSince?: number;
  };
  /**
   * SSOT 2026-10-26 T2/T3 — the subagents' share of the task total: every
   * subagent's own spend added up (the record cap's dropped ones included).
   * Absent when no subagent spend is known.
   */
  subagentSpend?: SubagentSpendSum;
  /**
   * SSOT 2026-10-22 T11 — when the work finished (epoch ms), for the DONE day
   * groups: an idle / sleeping card when it last went idle (else its last
   * activity), an archived card at its archive's kept finish time (else its
   * last activity). Absent while the session works or waits. The face's age
   * reads `finishedAt`, which has no fallback.
   */
  doneAt?: number;
  /**
   * Spec 13 §3.7 — when a live session started waiting on its user (epoch ms):
   * the oldest of its open permission prompts and, while its own state is
   * `waiting`, its switch to that state. Absent otherwise. (`lastActivity`
   * moves on user input only, so it cannot say this.)
   */
  waitingSince?: number;
  /**
   * Spec 13 §3.7 — the exact moment its work finished (epoch ms), the clock the
   * face's "· 12m ago" reads: a live idle card's switch to idle, an archived
   * card's kept finish time. Absent when only inferred — `doneAt` then falls
   * back to the last activity for the day groups, the face shows no age.
   */
  finishedAt?: number;
  /**
   * SSOT 2026-10-22 T4/T5 — tokens the context holds now, the threshold it
   * auto-compacts at (follows the model), and the representative model a
   * switch waits to apply once the running compact seals.
   */
  contextTokens?: number;
  autoCompactTokens?: number;
  pendingModel?: string;
  /**
   * re-context-window D1/D2 — what the last request read, by the SDK's cache
   * categories (`usage.current*`), and the window they are measured against:
   * the same committed sample as `contextTokens` and `contextUsagePercent`.
   * `unsplit` — the four counters hold one total, not a split: `compact` when
   * it is a compaction's `post_tokens` (applyPostCompactOccupancy), else
   * `unknown`. Live sessions with a known window only.
   */
  contextParts?: {
    window: number;
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    unsplit?: 'compact' | 'unknown';
  };
  /** D3 — the turn-end check scheduled a compaction: the next user turn starts with `/compact`. */
  compactPending?: boolean;
  /** D4 — the latest compaction's SDK counts (runtime only; cleared when the next one starts). */
  lastCompact?: { preTokens: number; postTokens: number; trigger?: 'manual' | 'auto' };
  /**
   * Task list — the model's latest TodoWrite list, from the session's task
   * ledger (SSOT 2026-10-22 T7/T8): each task has its own id (`T<n>`), its
   * elapsed time and the tool calls made while it ran.
   */
  tasks?: DashboardTask[];
  /**
   * Tasks a later list no longer holds, newest first: completed ones, and ones
   * it dropped before they completed (`dropped` says how — never running).
   */
  earlierTasks?: DashboardTask[];
  /**
   * SSOT 2026-10-29 T5 — work no task got: done while none was in progress,
   * and the next list completed none (tool calls, subagents' tool calls, usage).
   */
  tasksOutside?: TaskWork;
  /** SSOT 2026-10-29 T8 — the Slack bot that runs this session, by the name Slack shows (its answers' name). */
  botName?: string;
  /**
   * Spec 12 — the subagents of this session (the main agent is the card
   * itself), in spawn order, each with its own tasks. At most
   * {@link AGENTS_ON_CARD_MAX}: running agents and their ancestors first, then
   * the newest. Absent when the session never started one.
   */
  agents?: DashboardAgent[];
  /** How many subagents the session has in all (≥ `agents.length`). */
  agentsTotal?: number;
  /**
   * The main agent's own counts — the root node of the agent tree, so its row
   * carries the same fields as a subagent's (tool calls counted by the same
   * rule). Absent until the main agent calls a tool.
   */
  agentRoot?: { toolCalls: number; lastTool?: string };
  /** Slack thread permalink */
  slackThreadUrl?: string;
  /** Dashboard v2.1 — live turn timer + counters (per session) */
  activeLegStartedAtMs?: number;
  activeAccumulatedMs?: number;
  compactionCount?: number;
  /** Dashboard v2.1 — thread aggregate (derived, not persisted) */
  threadTotalActiveMs?: number;
  threadSessionCount?: number;
  threadCompactionCount?: number;
  /** Per-session effort level, normalised via coerceEffort. */
  effort?: EffortLevel;
  /** The level the session's model actually runs, when it caps `effort` (SSOT 2026-10-23 T1). */
  effortEffective?: string;
  /** The levels the session's model runs (catalog menu ∩ EFFORT_LEVELS); absent when the catalog does not know it (re-model-picker D6). */
  effortLevels?: EffortLevel[];
  /** Jira short key like "PROJ-123" derived from issueUrl */
  issueShortRef?: string;
  /** GitHub PR short ref like "PR-123" derived from prUrl */
  prShortRef?: string;
  /**
   * #814 — environment metadata identifying which soma-work instance owns
   * this card. Self cards get the local instance's env; sibling cards
   * get their owner's env after the aggregator stamps them on the merge
   * path. The frontend renders an env badge from this and groups token
   * stats by `instanceName`. Always present once `setSelfInstanceEnv()`
   * has been called from `startWebServer` — defensive `?` because tests
   * exercise paths that don't initialize the env (and the badge is
   * suppressed when missing).
   */
  environment?: {
    instanceName: string;
    port: number;
    host: string;
  };
  /**
   * The session's goal list (SSOT 2026-10-21 T2): the current goal with its
   * state, and the goals queued behind it in start order. Absent when the
   * session has never had a goal.
   */
  goal?: KanbanGoal;
  /**
   * Set when the session is idle only because the system will start it again
   * by itself (see {@link KanbanAutoResume}). Such a card is unfinished work:
   * the board puts it in `working`, not `idle`. Absent otherwise.
   */
  autoResume?: KanbanAutoResume;
  /**
   * SSOT 2026-10-23 T1/T5 — what the model produced in this conversation: the
   * files it sent to Slack and its markdown final answers. The count and the
   * few newest, so the card face shows them without a fetch; the full list is
   * `GET /api/dashboard/session/:conversationId/artifacts`. Absent when none.
   */
  artifacts?: ArtifactSummary;
  /**
   * SSOT 2026-10-25 — how many files the user attached to this session's
   * instructions (user media). The card face shows a paperclip count only and
   * never fetches an image; the files are on the user turns. Absent when none.
   */
  userMedia?: { count: number };
  /**
   * SSOT 2026-10-24 — permission prompts this session is blocked on (oldest
   * first), the same prompt the Slack card shows. While any is pending the card
   * reads `activityState: 'waiting'` (NEEDS YOU). No tool input here: the board
   * goes to every viewer; the requester reads it from
   * `GET /api/dashboard/session/:key/permission/:approvalId`.
   */
  pendingPermissions?: DashboardPermissionRequest[];
  /** Pending user choice question (present when activityState === 'waiting' and a question was asked) */
  pendingQuestion?: {
    type: 'user_choice' | 'user_choices';
    question: string;
    choices?: Array<{ id: string; label: string; description?: string }>;
    /** ID of the recommended choice (single-choice) */
    recommendedChoiceId?: string;
    /** Multi-choice fields */
    questions?: Array<{
      id: string;
      question: string;
      choices: Array<{ id: string; label: string; description?: string }>;
      context?: string;
      recommendedChoiceId?: string;
    }>;
    questionCount?: number;
    title?: string;
    description?: string;
  };
  /**
   * The session's follow-up queue as the panel's <ui-agent-steering> lists it
   * (dashboard batch 2): the notes still waiting, being handed over or failed,
   * with the generations an action on them must carry. Absent when there is
   * nothing to show.
   */
  followups?: DashboardFollowups;
}

/** One task as the dashboard shows it (a `TaskRecord` of `session/task-ledger.ts`). */
export interface DashboardTask {
  id: string;
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  startedAt?: number;
  completedAt?: number;
  toolCalls: number;
  /** When it left the list (earlier tasks; absent on a ledger saved before this existed). */
  removedAt?: number;
  /**
   * Earlier tasks only (dashboard task view T2): it left the list before it
   * completed — `started` it had run and a new plan replaced it (교체됨),
   * `unstarted` it never ran (실행 안 됨). Such a task is never shown as running or waiting.
   */
  dropped?: TaskDropped;
  /** First time it entered in_progress (kept when it went back to pending). */
  firstStartedAt?: number;
  /** SSOT 2026-10-29 T5 — the subagents' tool calls while it ran (its share). */
  agentToolCalls?: number;
  /** API usage while it ran (its share); absent = recorded before per-task usage (unknown). */
  tokens?: TaskTokens;
  /** Its earlier texts — the model rewrites a task as it goes. */
  revisions?: TaskRevision[];
  /** It went from waiting straight to completed: the start is the list before. */
  startEstimated?: boolean;
  /** It ran together with this many tasks (≥ 2: the numbers are its share). */
  shared?: number;
}

/** One subagent as the card carries it (an `AgentRecord` of `session/agent-registry.ts`). */
export interface DashboardAgent {
  /** The id of the tool call that started it (work-log entries carry it as `agentId` / `agentRef`). */
  id: string;
  /** Spawn order (`A<n>`). */
  n: number;
  parentId?: string;
  type?: string;
  description?: string;
  background?: boolean;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  lastTool?: string;
  /**
   * SSOT 2026-10-26 T2 — what it spent: its own API calls (tokens by kind,
   * API-equivalent cost), read from its transcript. Not the SDK's
   * `total_tokens`, which is only the size of its last context.
   */
  spend?: AgentSpend;
  durationMs?: number;
  summary?: string;
  /** Its latest TodoWrite list — at most one current task, none unless it runs. */
  tasks?: DashboardTask[];
  earlierTasks?: DashboardTask[];
}

/** Most subagents one card carries. */
export const AGENTS_ON_CARD_MAX = 40;

/**
 * Spec 12 — a registry as the card carries it. `live` = the session can still
 * run them; an archive cannot, so an agent it still thought running reads
 * `unknown`.
 */
export function agentsToKanban(
  registry: AgentRegistry | undefined,
  live: boolean,
): Pick<KanbanSession, 'agents' | 'agentsTotal' | 'agentRoot' | 'subagentSpend'> {
  const reg = live ? registry : loseRunningAgents(registry, Date.now());
  const subSpend = subagentSpendOf(reg);
  const root = {
    ...(reg?.root
      ? { agentRoot: { toolCalls: reg.root.toolCalls, ...(reg.root.lastTool ? { lastTool: reg.root.lastTool } : {}) } }
      : {}),
    ...(subSpend ? { subagentSpend: subSpend } : {}),
  };
  const all = reg?.agents ?? [];
  if (all.length === 0) return root;
  let chosen = all;
  if (all.length > AGENTS_ON_CARD_MAX) {
    const byId = new Map(all.map((a) => [a.id, a]));
    const keep = new Set<string>();
    for (const a of all) {
      if (a.status !== 'running') continue;
      for (let cur: (typeof all)[number] | undefined = a; cur && !keep.has(cur.id); ) {
        keep.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
    for (let i = all.length - 1; i >= 0 && keep.size < AGENTS_ON_CARD_MAX; i--) keep.add(all[i].id);
    chosen = all.filter((a) => keep.has(a.id));
  }
  return {
    ...root,
    agents: chosen.map((a) => {
      const view = a.ledger ? ledgerTasks(a.ledger) : undefined;
      const tasks = normalizeTaskProgress(view?.current, a.status === 'running');
      return {
        id: a.id,
        n: a.n,
        ...(a.parentId ? { parentId: a.parentId } : {}),
        ...(a.type ? { type: a.type } : {}),
        ...(a.description ? { description: a.description } : {}),
        ...(a.background !== undefined ? { background: a.background } : {}),
        status: a.status,
        startedAt: a.startedAt,
        ...(a.endedAt ? { endedAt: a.endedAt } : {}),
        toolCalls: a.toolCalls,
        ...(a.lastTool ? { lastTool: a.lastTool } : {}),
        ...(a.spend ? { spend: a.spend } : {}),
        ...(a.durationMs ? { durationMs: a.durationMs } : {}),
        ...(a.summary ? { summary: a.summary } : {}),
        ...(tasks?.length ? { tasks } : {}),
        ...(view?.earlier.length ? { earlierTasks: view.earlier } : {}),
      };
    }),
    agentsTotal: all.length,
  };
}

export interface KanbanGoal {
  current?: {
    goalId: string;
    objective: string;
    /** `active` drives the loop; `paused` keeps the objective but stops injecting it; `complete` is the last finished goal. */
    status: 'active' | 'paused' | 'complete';
    /** Auto-continuation turns since the last real user message, and the cap. */
    continuationCount: number;
    maxContinuations: number;
    /** The last completion-eval verdict that said "not yet" — what is still missing. */
    lastEvalReason?: string;
  };
  queue: Array<{ goalId: string; objective: string }>;
  completedCount: number;
  /** SSOT 2026-10-22 T6 — completed goals with their details, newest first. */
  history: KanbanGoalHistoryItem[];
}

/** One completed goal as the card lists it (SSOT 2026-10-22 T6). */
export interface KanbanGoalHistoryItem {
  goalId: string;
  objective: string;
  createdAt?: number;
  completedAt?: number;
  /** `user` (goal done) or `eval-model` (the completion evaluator). */
  completedVia?: string;
  /** The evaluator's verdict, or `user`. Capped. */
  completionReason?: string;
  /** Active turn time spent on the goal (ms). */
  activeMsUsed?: number;
  /** Every token kind spent on the goal. */
  tokens?: number;
  costUsd?: number;
  /** Auto-continuation turns it took. */
  continuationCount?: number;
}

/**
 * Why an idle session is not done: something the system armed will start it
 * again without the user.
 *
 * - `error-retry` — the last turn failed with a recoverable error (429 pool
 *   rate limit, transient API error) and is re-run at `at`.
 * - `goal-eval-retry` — the goal's completion check failed the same way and
 *   is re-run at `at`; the next turn follows if the goal is not met.
 * - `goal-eval` — the goal's completion check is running now.
 */
export interface KanbanAutoResume {
  kind: 'error-retry' | 'goal-eval-retry' | 'goal-eval';
  /** Epoch ms the resume fires. Absent for `goal-eval` (already running). */
  at?: number;
  /** Which retry this is, and the budget — "attempt 1/3". */
  attempt?: number;
  maxAttempts?: number;
  /** First line of the error that caused the retry. */
  reason?: string;
}

export interface KanbanBoard {
  working: KanbanSession[];
  waiting: KanbanSession[];
  idle: KanbanSession[];
  closed: KanbanSession[];
}

export interface UserDayStats {
  date: string;
  sessionsCreated: number;
  turnsUsed: number;
  prsCreated: number;
  prsMerged: number;
  commitsCreated: number;
  linesAdded: number;
  linesDeleted: number;
  mergeLinesAdded: number;
  mergeLinesDeleted: number;
  workflowCounts: Record<string, number>;
}

export interface UserStats {
  /** null = every user (no userId asked). */
  userId: string | null;
  period: 'day' | 'week' | 'month';
  days: UserDayStats[];
  totals: {
    sessionsCreated: number;
    turnsUsed: number;
    prsCreated: number;
    prsMerged: number;
    commitsCreated: number;
    linesAdded: number;
    linesDeleted: number;
    mergeLinesAdded: number;
    mergeLinesDeleted: number;
    workflowCounts: Record<string, number>;
  };
}

// ── Self-instance environment (#814) ───────────────────────────────

/**
 * The local instance's environment metadata, set once by `web-server.ts`
 * after `activePort` is finalized. Used to stamp self-owned cards with
 * `environment` and to compose `${instanceName}::${originalKey}` keys
 * so the client cache and the cross-instance aggregator can distinguish
 * cards from sibling instances.
 *
 * Null until set — code paths that build cards before
 * `setSelfInstanceEnv` runs (e.g. tests that exercise the dashboard
 * without booting the server) emit raw keys and no environment, which
 * keeps backward compat with the existing dashboard.test.ts snapshots
 * that assert `key === 'C1:t1'` directly.
 */
/**
 * SSOT 2026-10-29 T8 — the Slack bot's name as Slack shows it (users.info of
 * the bot user: display name, else real name), the name its answers carry in
 * the dashboard's chat. '' until resolved (the chat then says Assistant). Each
 * instance names its own sessions (`botName` on the card) — a sibling's cards
 * arrive with that instance's bot.
 */
let _botDisplayName = '';
export function setDashboardBotName(name: string | undefined): void {
  _botDisplayName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
}

let _selfInstanceEnv: InstanceEnvironment | null = null;

/** Wire the local instance's env. Called by `startWebServer`. */
export function setSelfInstanceEnv(env: InstanceEnvironment): void {
  _selfInstanceEnv = env;
}

/** Test helper — clear the self env between cases. */
export function __resetSelfInstanceEnvForTests(): void {
  _selfInstanceEnv = null;
  _aggregatorCacheClear();
}

// #814 — Per-process TTL cache for sibling fan-out. Collapses concurrent
// /api/dashboard/sessions polls (multiple browser tabs) into one fan-out;
// 1500 ms < 30 s poll cadence so a sibling that just came up surfaces on
// the next tick.
const AGGREGATOR_CACHE_TTL_MS = 1_500;
type SiblingBoards = Awaited<ReturnType<typeof fetchSiblingBoards>>;
let _aggregatorCache: { value: SiblingBoards; stamp: number } | null = null;
function _aggregatorCacheGet(): SiblingBoards | null {
  if (_aggregatorCache === null) return null;
  if (Date.now() - _aggregatorCache.stamp > AGGREGATOR_CACHE_TTL_MS) return null;
  return _aggregatorCache.value;
}
function _aggregatorCacheSet(siblings: SiblingBoards): void {
  _aggregatorCache = { value: siblings, stamp: Date.now() };
}
function _aggregatorCacheClear(): void {
  _aggregatorCache = null;
}

/**
 * Build the wire-format key for a session. When the local env is wired
 * (production), keys are `${instanceName}::${originalKey}` — collision-
 * proof against sibling instances. When it's not wired (legacy tests),
 * we return the original key untouched.
 */
function composeSessionKey(originalKey: string): string {
  if (!_selfInstanceEnv) return originalKey;
  if (originalKey.startsWith(`${_selfInstanceEnv.instanceName}::`)) return originalKey;
  return `${_selfInstanceEnv.instanceName}::${originalKey}`;
}

/**
 * Inverse of {@link composeSessionKey}: strip the `${selfInstance}::`
 * prefix from an action endpoint's `:key` param.
 *
 * Three outcomes (#814 silent-failure-hunter audit):
 *   - **No env wired** (legacy / single-instance): return `wireKey` unchanged.
 *   - **No `::` separator**: return `wireKey` unchanged (legacy clients
 *     that haven't seen a composite key yet, e.g. immediately after upgrade).
 *   - **`foreign-instance::raw`**: return `null` — the action targets a
 *     sibling instance that this server does not own. Callers must surface a
 *     409 with a redirect hint, not silently pass through and 403/no-op.
 *   - **`self::raw`**: strip and return `raw`.
 */
function stripSelfInstancePrefix(wireKey: string): string | null {
  if (!_selfInstanceEnv) return wireKey;
  // Only treat as composite when `::` is present — bare keys remain
  // backward-compatible for clients that pre-date the composite wire format.
  const sepIdx = wireKey.indexOf('::');
  if (sepIdx < 0) return wireKey;
  const prefix = wireKey.slice(0, sepIdx);
  // The session storage layer uses `archived_<channel>:<thread>_<ts>` as a
  // key shape — the prefix in that case is the literal string `archived_…`,
  // not an instance name. We only treat the prefix as an instance routing
  // hint when it matches the self instance; everything else is left alone.
  if (prefix === _selfInstanceEnv.instanceName) {
    return wireKey.slice(sepIdx + 2);
  }
  // Anything else with `::` is a foreign instance — refuse.
  return null;
}

/**
 * Helper for action endpoints — wrap `stripSelfInstancePrefix` and emit a
 * uniform 409 reply when the wire key targets a sibling instance, so the
 * caller's frontend can show "open this card on $sibling".
 *
 * Returns the resolved local key, or null if the request was rejected
 * (in which case the reply has already been sent).
 */
function resolveSelfActionKey(wireKey: string, reply: any): string | null {
  const local = stripSelfInstancePrefix(wireKey);
  if (local === null) {
    reply.status(409).send({
      error:
        'Cross-instance action not supported — this session belongs to another soma-work instance. Open that instance directly to act on it.',
      wireKey,
    });
    return null;
  }
  return local;
}

/**
 * Resolve the wire-format `:key` route param to a local session key AND
 * gate on `requireSessionOwner` in one call. Centralizes the
 * (cross-instance reject → owner gate) preamble that every action
 * endpoint shares. Returns null if either check failed (the reply has
 * already been sent).
 */
function resolveSelfActionKeyAndOwner(request: any, reply: any): { wireKey: string; originalKey: string } | null {
  const wireKey: string = request.params?.key ?? '';
  const originalKey = resolveSelfActionKey(wireKey, reply);
  if (originalKey === null) return null;
  if (!requireSessionOwner(request, reply, originalKey)) return null;
  return { wireKey, originalKey };
}

// ── Task star + revive targets (SSOT 2026-10-30) ───────────────────

/**
 * The local part of an archived card's key — `archived_<sessionKey>_<archivedAt>`
 * (archivedToKanban) — split into the archive it names, or null for a live key.
 * The session key may itself hold `_`; the timestamp is the last segment.
 */
function parseArchivedCardKey(localKey: string): { sessionKey: string; archivedAt: number } | null {
  if (!localKey.startsWith('archived_')) return null;
  const rest = localKey.slice('archived_'.length);
  const sep = rest.lastIndexOf('_');
  if (sep <= 0) return null;
  const ts = rest.slice(sep + 1);
  if (!/^[0-9]{1,16}$/.test(ts)) return null;
  return { sessionKey: rest.slice(0, sep), archivedAt: Number(ts) };
}

const LIFECYCLE_REFUSAL_STATUS: Record<Extract<SessionLifecycleOutcome, { ok: false }>['code'], number> = {
  not_found: 404,
  forbidden: 403,
  terminated: 409,
  conflict: 409,
  no_conversation: 422,
  transcript_missing: 422,
  invalid_cwd: 422,
  incident_provenance: 422,
  handoff_provenance: 422,
};

function sendLifecycleRefusal(reply: any, outcome: Extract<SessionLifecycleOutcome, { ok: false }>): void {
  reply.status(LIFECYCLE_REFUSAL_STATUS[outcome.code] ?? 500).send({ error: outcome.message, code: outcome.code });
}

/**
 * The session a star / revive targets. A live card: the cross-instance check
 * and the session-owner gate every action takes. An archived card: the exact
 * archive it names (404 when gone), gated by that archive's owner — the live
 * map has no entry to read an owner from. Null = already answered.
 */
function resolveLifecycleTarget(
  request: any,
  reply: any,
): { kind: 'live'; originalKey: string } | { kind: 'archived'; archived: ArchivedSession } | null {
  const local = resolveSelfActionKey(request.params?.key ?? '', reply);
  if (local === null) return null;
  const card = parseArchivedCardKey(local);
  if (!card) {
    if (!requireSessionOwner(request, reply, local)) return null;
    return { kind: 'live', originalKey: local };
  }
  const archived = getArchiveStore().load(card.sessionKey, card.archivedAt);
  if (!archived) {
    reply.status(404).send({ error: '보관된 세션을 찾을 수 없어요', code: 'not_found' });
    return null;
  }
  if (!_hasWriteAccess(request, archived.ownerId)) {
    reply.status(403).send({
      error: 'Forbidden — write requires session ownership, or admin user with X-Admin-Mode: on header (#716)',
    });
    return null;
  }
  return { kind: 'archived', archived };
}

// ── Session data accessor ──────────────────────────────────────────

type SessionAccessor = () => Map<string, any>;
let _getSessionsFn: SessionAccessor | null = null;

/** Register session accessor (called once at startup) */
export function setDashboardSessionAccessor(fn: SessionAccessor): void {
  _getSessionsFn = fn;
}

function getAllSessions(): Map<string, any> {
  if (!_getSessionsFn) return new Map();
  return _getSessionsFn();
}

// ── CRON lane + capacity sources (SSOT 2026-10-23) ─────────────────

/** This instance's cron jobs and their execution history (wired in src/index.ts). */
export interface DashboardCronSource {
  listJobs(): CronJob[];
  listHistory(): CronExecutionRecord[];
}
let _cronSource: DashboardCronSource | null = null;
export function setDashboardCronSource(source: DashboardCronSource | null): void {
  _cronSource = source;
}

/** Where the capacity view reads llmux from. Null = the live auth runtime. */
export interface CapacitySource {
  enabled(): { ok: true } | { ok: false; reason: string };
  fetchStatus(): Promise<LlmuxStatus>;
  tiers(): Record<string, LlmuxTierId>;
}
let _capacitySource: CapacitySource | null = null;
let _capacityCache: { at: number; view: CapacityView } | null = null;
let _capacityInFlight: Promise<CapacityView> | null = null;
/** llmux is read at most this often; every browser tab shares the read. */
const CAPACITY_TTL_MS = 30_000;
/** A failed read is retried sooner. */
const CAPACITY_FAIL_TTL_MS = 10_000;

export function setCapacitySource(source: CapacitySource | null): void {
  _capacitySource = source;
  _capacityCache = null;
  _capacityInFlight = null;
}

async function defaultCapacitySource(): Promise<CapacitySource> {
  // Loaded on first use, so the dashboard module stays free of auth-runtime
  // and config side effects at import.
  const [{ getAuthRuntimeSnapshot }, { fetchLlmuxStatus }, { getLlmuxAccountTiers }] = await Promise.all([
    import('../auth/auth-runtime'),
    import('../auth/llmux-client'),
    import('../config'),
  ]);
  return {
    enabled: () => {
      const mode = getAuthRuntimeSnapshot().mode;
      return mode === 'llmux' ? { ok: true } : { ok: false, reason: `auth mode is ${mode} — llmux not in use` };
    },
    fetchStatus: () => fetchLlmuxStatus({ timeoutMs: 3_000 }),
    tiers: () => getLlmuxAccountTiers(),
  };
}

/** A fixed, de-identified reason: raw llmux errors can carry hosts and URLs. */
function capacityFailureReason(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return 'llmux admin credential required';
  if (typeof status === 'number') return `llmux error (HTTP ${status})`;
  return 'llmux unreachable';
}

async function readCapacity(): Promise<CapacityView> {
  const now = Date.now();
  if (_capacityCache) {
    const ttl = _capacityCache.view.available ? CAPACITY_TTL_MS : CAPACITY_FAIL_TTL_MS;
    if (now - _capacityCache.at < ttl) return _capacityCache.view;
  }
  if (_capacityInFlight) return _capacityInFlight;
  _capacityInFlight = (async (): Promise<CapacityView> => {
    let view: CapacityView;
    try {
      const source = _capacitySource ?? (await defaultCapacitySource());
      const gate = source.enabled();
      if (!gate.ok) {
        view = { available: false, reason: gate.reason, fetchedAtMs: Date.now(), groups: [] };
      } else {
        const status = await source.fetchStatus();
        view = buildCapacityView(status, source.tiers(), Date.now());
      }
    } catch (err) {
      logger.warn('Capacity view: llmux status read failed', { error: (err as Error)?.message });
      view = { available: false, reason: capacityFailureReason(err), fetchedAtMs: Date.now(), groups: [] };
    }
    _capacityCache = { at: Date.now(), view };
    return view;
  })();
  try {
    return await _capacityInFlight;
  } finally {
    _capacityInFlight = null;
  }
}

/** A cron run's session, live or archived, keyed by its canonical session key. */
function cronRunSessionIndex(): CronRunSessionLookup {
  const index = new Map<string, NonNullable<ReturnType<CronRunSessionLookup>> & { archivedAt?: number }>();
  const usageOf = (u: any) =>
    u
      ? {
          tokens:
            (u.totalInputTokens || 0) +
            (u.totalOutputTokens || 0) +
            (u.totalCacheReadTokens || 0) +
            (u.totalCacheCreateTokens || 0),
          costUsd: u.totalCostUsd || 0,
        }
      : {};
  try {
    for (const archived of getArchiveStore().listRecent(CRON_RUN_ARCHIVE_WINDOW_MS)) {
      if (!archived?.sessionKey) continue;
      const key = normalizeSessionKey(archived.sessionKey);
      // listRecent is not ordered: a thread archived twice keeps its newest archive.
      const prev = index.get(key);
      if (prev && (prev.archivedAt ?? 0) >= (archived.archivedAt ?? 0)) continue;
      index.set(key, {
        archivedAt: archived.archivedAt,
        cronJobId: archived.cronJob?.id,
        cronJobName: archived.cronJob?.name,
        session: {
          headline: displayTitle(archived),
          conversationId: archived.conversationId,
          activityState: 'idle',
          live: false,
          boardKey: composeSessionKey(`archived_${archived.sessionKey}_${archived.archivedAt}`),
          slackThreadUrl:
            archived.channelId && archived.threadTs
              ? (buildThreadPermalink(archived.channelId, archived.threadTs) ?? undefined)
              : undefined,
          // The task total it kept (SSOT 2026-10-26 T3), else the last runtime usage.
          ...usageOf(
            archived.taskUsage
              ? {
                  totalInputTokens: archived.taskUsage.inputTokens,
                  totalOutputTokens: archived.taskUsage.outputTokens,
                  totalCacheReadTokens: archived.taskUsage.cacheReadTokens,
                  totalCacheCreateTokens: archived.taskUsage.cacheCreateTokens,
                  totalCostUsd: archived.taskUsage.costUsd,
                }
              : archived.usage,
          ),
          activeMs: archived.busyMs || 0,
        },
      });
    }
  } catch (err) {
    logger.debug('cron run index: archive read failed', { error: (err as Error)?.message });
  }
  for (const [key, s] of getAllSessions().entries()) {
    if (!s?.channelId) continue;
    const u = tokenUsageOf(s);
    index.set(buildWorkSessionKey(s.channelId, s.threadTs), {
      cronJobId: s.cronJob?.id,
      cronJobName: s.cronJob?.name,
      session: {
        headline: displayTitle(s),
        conversationId: s.conversationId,
        activityState: s.state === 'SLEEPING' ? 'sleeping' : s.activityState || 'idle',
        live: true,
        boardKey: s.sessionId ? composeSessionKey(key) : undefined,
        slackThreadUrl:
          s.channelId && s.threadTs ? (buildThreadPermalink(s.channelId, s.threadTs) ?? undefined) : undefined,
        ...usageOf(u),
        activeMs: s.activeAccumulatedMs || 0,
      },
    });
  }
  return (canonicalKey) => index.get(canonicalKey);
}
/** How far back archived sessions are searched to link a cron run. */
const CRON_RUN_ARCHIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The lifecycle policy as the page sees it; `degraded` only when the saved policy is unreadable. */
function lifecycleView(): ReturnType<typeof getSessionLifecyclePolicy> & { degraded?: true } {
  const policy = getSessionLifecyclePolicy();
  return isSessionLifecyclePolicyDegraded() ? { ...policy, degraded: true } : policy;
}

/**
 * #716 write-access predicate. Returns true when the authenticated
 * caller may mutate a resource owned by `ownerId`:
 *   - bearer admin (viewer token / API client)
 *   - oauth user, owns the resource
 *   - oauth user in ADMIN_USERS AND `X-Admin-Mode: on` header set
 *
 * The header alone proves nothing — `authContext.isAdmin` is rebuilt
 * per-request from the verified JWT, so a non-admin shipping `on` is
 * still rejected.
 */
function _hasWriteAccess(request: any, ownerId: string | undefined): boolean {
  const authContext = request.authContext;
  if (authContext?.mode === 'bearer_header' || authContext?.mode === 'bearer_cookie') return true;
  if (authContext?.userId && ownerId && authContext.userId === ownerId) return true;
  const adminModeHeader = request.headers?.['x-admin-mode'];
  const adminModeOn = Array.isArray(adminModeHeader) ? adminModeHeader[0] === 'on' : adminModeHeader === 'on';
  if (authContext?.isAdmin && adminModeOn) return true;
  return false;
}

/**
 * Write-gate for kanban session actions (stop / close / trash / command /
 * answer-* / submit-recommended). Reads remain world-readable per #716.
 */
function requireSessionOwner(request: any, reply: any, sessionKey: string): boolean {
  const sessions = _getSessionsFn?.();
  const targetSession = sessions?.get(sessionKey);
  if (_hasWriteAccess(request, targetSession?.ownerId)) return true;
  reply.status(403).send({
    error: 'Forbidden — write requires session ownership, or admin user with X-Admin-Mode: on header (#716)',
  });
  return false;
}

/**
 * Same #716 write-access policy applied to a conversation record (used
 * by `resummarize` and `generate-title` which key off the conversation,
 * not the live session). Oracle re-review (#717 P2) caught that those
 * two write routes still used the older `authContext.isAdmin` shortcut
 * and skipped the X-Admin-Mode gate.
 */
function requireConversationWriteAccess(request: any, reply: any, ownerId: string | undefined): boolean {
  if (_hasWriteAccess(request, ownerId)) return true;
  reply.status(403).send({
    error: 'Forbidden — write requires conversation ownership, or admin user with X-Admin-Mode: on header (#716)',
  });
  return false;
}

/** One wire shape for both subtitle routes; `code` lets the panel tell the cases apart. */
function sendTitleSubResult(reply: any, result: TitleSubResult): void {
  if (result.ok) {
    reply.send({ ok: true, titleSub: result.titleSub });
    return;
  }
  switch (result.reason) {
    case 'no_content':
      reply.status(422).send({ error: 'No conversation text to title yet', code: 'no_content' });
      return;
    case 'cooldown':
      reply
        .status(429)
        .header('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
        .send({ error: 'Title generation failed recently', code: 'cooldown', retryAfterMs: result.retryAfterMs });
      return;
    case 'generation_failed':
      reply.status(502).send({ error: 'Title generation failed', code: 'generation_failed' });
      return;
  }
}

// ── Task accessor ──────────────────────────────────────────────────

type TaskAccessor = (
  sessionKey: string,
) => { current: DashboardTask[]; earlier: DashboardTask[]; outside?: TaskWork } | undefined;
let _getTasksFn: TaskAccessor | null = null;

/** Register task accessor (called once at startup) */
export function setDashboardTaskAccessor(fn: TaskAccessor): void {
  _getTasksFn = fn;
}

// ── Action callbacks ───────────────────────────────────────────────

type StopHandler = (sessionKey: string) => Promise<void>;
type CloseHandler = (sessionKey: string) => Promise<void>;
type TrashHandler = (sessionKey: string) => Promise<void>;
/**
 * An instruction from the panel's composer (dashboard task view T1.5): the
 * text (may be empty when files are attached) and the files the user pasted,
 * attached or recorded — decoded and held to the new-task limits.
 */
type CommandHandler = (sessionKey: string, message: string, files: NewTaskAttachment[]) => Promise<void>;

let _stopHandlerFn: StopHandler | null = null;
let _closeHandlerFn: CloseHandler | null = null;
let _trashHandlerFn: TrashHandler | null = null;
let _commandHandlerFn: CommandHandler | null = null;

export function setDashboardStopHandler(fn: StopHandler): void {
  _stopHandlerFn = fn;
}
export function setDashboardCloseHandler(fn: CloseHandler): void {
  _closeHandlerFn = fn;
}
export function setDashboardTrashHandler(fn: TrashHandler): void {
  _trashHandlerFn = fn;
}
export function setDashboardCommandHandler(fn: CommandHandler): void {
  _commandHandlerFn = fn;
}

/**
 * Task star + revive (SSOT 2026-10-30), wired to the session registry in
 * src/index.ts: star / unstar a live session (starring a sleeping one wakes
 * it), revive a live (sleeping) one, restore an archived one — the resume
 * proof (transcript + cwd + incident provenance) is the host's.
 */
export interface DashboardLifecycleHandler {
  star(sessionKey: string, starred: boolean): SessionLifecycleOutcome;
  revive(sessionKey: string): SessionLifecycleOutcome;
  restore(archived: ArchivedSession): SessionLifecycleOutcome;
}
let _lifecycleHandler: DashboardLifecycleHandler | null = null;
export function setDashboardLifecycleHandler(handler: DashboardLifecycleHandler | null): void {
  _lifecycleHandler = handler;
}

// ── Follow-up queue (dashboard batch 2 — <ui-agent-steering>) ──────

/** One queue item as the panel lists it. */
export interface DashboardFollowupItem {
  id: string;
  /** `message.text` as it will run (an edit replaces it). */
  text: string;
  /** Names of the files that came with it. */
  files: string[];
  /** Who wrote it — only when that is not the session's owner (someone else in the thread). */
  author?: string;
  enqueuedAt: number;
  state: FollowupItemState;
  stateReason?: string;
  /** The item's CAS generation: every action on it sends it back. */
  epoch: number;
  /** Edit is offered: `queued`, the owner's own words, not a goal's opening turn (the server checks again). */
  editable: boolean;
}
export interface DashboardFollowups {
  /** The session's turn generation (the control view's): Send now sends it back. */
  turnEpoch: number;
  items: DashboardFollowupItem[];
}
export type DashboardFollowupOp = 'promote' | 'cancel' | 'edit';
export interface DashboardFollowupRequest {
  sessionKey: string;
  itemId: string;
  op: DashboardFollowupOp;
  epoch: number;
  turnEpoch: number;
  text?: string;
}
/** A refusal carries the queue's own words (the item stays) and the status the route answers with. */
export type DashboardFollowupOutcome = { ok: true; message?: string } | { ok: false; status: number; message: string };
/**
 * The queue behind the panel (wired in src/index.ts to SlackHandler): `view` is
 * the CONTROL view (`getFollowupView` — its turnEpoch is what Send now is
 * fenced against), `act` runs Send now / Retry / Cancel through the Slack
 * controls' own handlers and Edit through `editQueued`.
 */
export interface DashboardFollowupHandler {
  view(sessionKey: string): FollowupQueueView | undefined;
  act(request: DashboardFollowupRequest): Promise<DashboardFollowupOutcome>;
}
let _followupHandler: DashboardFollowupHandler | null = null;
export function setDashboardFollowupHandler(handler: DashboardFollowupHandler | null): void {
  _followupHandler = handler;
}

/** States a note still has a control in; `failed` keeps Retry / Cancel until one is used. */
const FOLLOWUP_SHOWN_STATES: readonly FollowupItemState[] = [
  'queued',
  'paused',
  'steered',
  'reserved',
  'claimed',
  'dispatched',
  'uncertain',
  'failed',
];
/** `failed` is history (nothing clears it but Retry or Cancel): the newest few are shown, not all of them. */
const FOLLOWUP_SHOWN_FAILED = 5;
/** A reason that only repeats the state (`steered`) says nothing the state does not. */
const FOLLOWUP_STATE_ECHO = new Set<string>(['steered', 'consumed']);

/** The session payload's queue: what the panel lists, oldest first (the queue's arrival order). */
export function followupsOf(sessionKey: string, ownerId: string | undefined): DashboardFollowups | undefined {
  const view = _followupHandler?.view(sessionKey);
  if (!view) return undefined;
  const failed = view.items.filter((item) => item.state === 'failed').slice(-FOLLOWUP_SHOWN_FAILED);
  const shown = view.items.filter(
    (item) => FOLLOWUP_SHOWN_STATES.includes(item.state) && (item.state !== 'failed' || failed.includes(item)),
  );
  if (shown.length === 0) return undefined;
  let names: Map<string, string> | undefined;
  const nameOf = (userId: string): string => {
    if (!names) {
      names = new Map();
      for (const [, s] of getAllSessions()) if (s?.ownerId && s.ownerName) names.set(s.ownerId, s.ownerName);
    }
    return names.get(userId) ?? userId;
  };
  return {
    turnEpoch: view.turnEpoch ?? 0,
    items: shown.map((item: FollowupItem) => {
      const author = item.message?.user;
      const out: DashboardFollowupItem = {
        id: item.id,
        text: typeof item.message?.text === 'string' ? item.message.text : '',
        files: (item.message?.files ?? []).map((f) => String(f?.name || 'file')),
        enqueuedAt: item.enqueuedAt,
        state: item.state,
        epoch: item.epoch,
        editable:
          item.state === 'queued' &&
          !!author &&
          author === ownerId &&
          item.message?.routeContext?.goalOpeningId === undefined,
      };
      if (author && author !== ownerId) out.author = nameOf(author);
      if (item.stateReason && !FOLLOWUP_STATE_ECHO.has(item.stateReason)) out.stateReason = item.stateReason;
      return out;
    }),
  };
}

/**
 * Goal list actions from the work item (SSOT 2026-10-21 T3). The handler is
 * `SlackHandler.handleHostGoalAction`; it throws `HostGoalActionError` for
 * every refusal, whose `statusCode` the route answers with.
 */
type GoalActionHandler = (
  sessionKey: string,
  action: HostGoalAction,
  actorUserId?: string,
) => Promise<HostGoalActionResult>;
let _goalActionHandlerFn: GoalActionHandler | null = null;

export function setDashboardGoalHandler(fn: GoalActionHandler): void {
  _goalActionHandlerFn = fn;
}

/**
 * SSOT 2026-10-22 T4/T5 — switch a session to a representative model
 * (`session/model-switch.ts` `switchSessionModel`). Throws `ModelSwitchError`
 * for every refusal, whose `statusCode` the route answers with.
 */
type ModelSwitchHandler = (sessionKey: string, nickname: string) => Promise<ModelSwitchResult>;
let _modelSwitchHandlerFn: ModelSwitchHandler | null = null;

export function setDashboardModelHandler(fn: ModelSwitchHandler): void {
  _modelSwitchHandlerFn = fn;
}

/**
 * SSOT 2026-10-23 T1 — change one session's reasoning effort
 * (`session/effort-switch.ts` `switchSessionEffort`, the `%effort` scope).
 * Throws `EffortSwitchError` for every refusal, whose `statusCode` the route
 * answers with.
 */
type EffortSwitchHandler = (sessionKey: string, effort: string) => EffortSwitchResult | Promise<EffortSwitchResult>;
let _effortSwitchHandlerFn: EffortSwitchHandler | null = null;

export function setDashboardEffortHandler(fn: EffortSwitchHandler): void {
  _effortSwitchHandlerFn = fn;
}

type ChoiceAnswerHandler = (sessionKey: string, choiceId: string, label: string, question: string) => Promise<void>;
let _choiceAnswerHandlerFn: ChoiceAnswerHandler | null = null;

export function setDashboardChoiceAnswerHandler(fn: ChoiceAnswerHandler): void {
  _choiceAnswerHandlerFn = fn;
}

type MultiChoiceAnswerHandler = (
  sessionKey: string,
  selections: Record<string, { choiceId: string; label: string }>,
) => Promise<void>;
let _multiChoiceAnswerHandlerFn: MultiChoiceAnswerHandler | null = null;

export function setDashboardMultiChoiceAnswerHandler(fn: MultiChoiceAnswerHandler): void {
  _multiChoiceAnswerHandlerFn = fn;
}

/**
 * SSOT 2026-10-24 — answer a permission prompt from the dashboard. Wired in
 * src/index.ts to `answerPermissionPrompt` with the session registry (the
 * same path the Slack buttons use). The route passes the signed-in user as
 * `actor` and the session's thread, and maps a refusal to its status.
 */
type PermissionAnswerHandler = (
  args: Pick<AnswerPermissionPromptArgs, 'approvalId' | 'actor' | 'decision' | 'thread'>,
) => Promise<PermissionPromptAnswer>;
let _permissionAnswerHandlerFn: PermissionAnswerHandler | null = null;

export function setDashboardPermissionAnswerHandler(fn: PermissionAnswerHandler | null): void {
  _permissionAnswerHandlerFn = fn;
}

export { refreshPendingPermissions };

/** Follow the permission prompt store while the web server listens; push the board on a change. */
export function startDashboardPermissionWatch(): void {
  startPermissionPromptWatch(() => broadcastSessionUpdate());
}

export function stopDashboardPermissionWatch(): void {
  stopPermissionPromptWatch();
}

// Hero "Submit All Recommended" handler (group-only). The dashboard does not
// pass selections — the implementation derives them from session.pendingQuestion
// recommendations. Returns rejected promise on validation failure for
// status-code mapping in the route handler.
type SubmitRecommendedHandler = (sessionKey: string) => Promise<void>;
let _submitRecommendedHandlerFn: SubmitRecommendedHandler | null = null;

export function setDashboardSubmitRecommendedHandler(fn: SubmitRecommendedHandler): void {
  _submitRecommendedHandlerFn = fn;
}

/**
 * Dashboard "New task" (SSOT 2026-10-23) — what the composer offers a user and
 * how a task starts. Wired in src/index.ts (`new-task.ts` builds the context,
 * `new-task-launcher.ts` starts the task). `context(userId, {fresh:true})`
 * re-checks channel membership instead of serving a cached answer: it is the
 * authorization step right before a task is posted.
 */
export interface DashboardNewTaskProvider {
  context(userId: string, options?: { fresh?: boolean }): Promise<NewTaskContext>;
  start(userId: string, submission: NewTaskSubmission): Promise<NewTaskLaunchResult>;
}
let _newTaskProvider: DashboardNewTaskProvider | null = null;
const _newTaskGate = createNewTaskGate();

export function setDashboardNewTaskProvider(provider: DashboardNewTaskProvider | null): void {
  _newTaskProvider = provider;
}

/** The signed-in Slack user a task runs as — never a body field, never the admin-mode target. */
function newTaskUserId(request: unknown): string | undefined {
  const userId = (request as { authContext?: { userId?: string } }).authContext?.userId;
  return typeof userId === 'string' && userId ? userId : undefined;
}

// ── Kanban transformation ──────────────────────────────────────────

// Dashboard v2.1 — max active-leg duration cap (mirrors session-registry).
// Duplicated here (not imported) so dashboard.ts stays independent of
// session-registry in the mcp-servers split.
const DASHBOARD_MAX_LEG_MS = Number(process.env.MAX_LEG_MS) || 30 * 60 * 1000;

function computeThreadAggregate(
  channelId: string,
  threadTs: string | undefined,
  allSessions: Map<string, any>,
  now: number,
): { totalActiveMs: number; sessionCount: number; compactionCount: number } {
  // Match on session FIELDS, not a constructed key: aggregation must never
  // throw on hostile/corrupt in-memory data (the shared identity builder
  // rejects separator characters), and the fields are the ground truth the
  // map key is derived from anyway.
  let totalActiveMs = 0;
  let sessionCount = 0;
  let compactionCount = 0;
  for (const s of allSessions.values()) {
    if (s.channelId !== channelId || (s.threadTs || undefined) !== (threadTs || undefined)) continue;
    sessionCount += 1;
    compactionCount += s.compactionCount || 0;
    let acc = s.activeAccumulatedMs || 0;
    if (s.activeLegStartedAtMs) {
      acc += Math.min(now - s.activeLegStartedAtMs, DASHBOARD_MAX_LEG_MS);
    }
    totalActiveMs += acc;
  }
  return { totalActiveMs, sessionCount, compactionCount };
}

/**
 * Extract Jira-style short key from a "/browse/KEY-123" issue URL.
 * URL-only (no label fallback) to avoid false positives like "HTTP-200".
 * Key must be 2+ uppercase letters followed by "-<digits>" (Jira project-key convention).
 */
export function extractIssueShortRef(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/browse\/([A-Z]{2,}-\d+)/);
  return m ? m[1] : undefined;
}

/**
 * Extract "PR-<number>" from a GitHub PR URL. URL-only.
 * Trailing boundary: "/", "?", "#", or end of string (so .../pull/123#comment-... also matches).
 */
export function extractPrShortRef(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return m ? `PR-${m[1]}` : undefined;
}

/**
 * affectUI model picker D6 — the effort levels a model runs: its catalog menu
 * ∩ EFFORT_LEVELS, in EFFORT_LEVELS order. Undefined when the catalog has no
 * menu for the model (the picker then offers every level and the runtime
 * clamp decides, as before).
 */
export function pickerEffortLevels(catalogEfforts: readonly string[] | null | undefined): EffortLevel[] | undefined {
  if (!catalogEfforts || catalogEfforts.length === 0) return undefined;
  const menu = new Set(catalogEfforts.map((e) => String(e).toLowerCase()));
  const levels = EFFORT_LEVELS.filter((level) => menu.has(level));
  return levels.length > 0 ? levels : undefined;
}

/**
 * Card-derived UI fields shared between live (sessionToKanban) and archived
 * (archivedToKanban) kanban builders. Archived sessions don't persist effort,
 * so their branch always falls back to the owner's default; live sessions
 * use the persisted value when present.
 */
function cardDerivedFields(src: {
  effort?: unknown;
  ownerId?: string;
  model?: string;
  links?: { issue?: { url?: string }; pr?: { url?: string } };
  persistedEffort: boolean;
}): Pick<KanbanSession, 'effort' | 'effortEffective' | 'effortLevels' | 'issueShortRef' | 'prShortRef'> {
  const effort =
    src.persistedEffort && src.effort
      ? coerceEffort(src.effort)
      : userSettingsStore.getUserDefaultEffort(src.ownerId || '');
  // SSOT 2026-10-23 T1 — the level the model really runs (build-stream-options
  // clamps the same way); present only when the model caps the chosen level.
  const clamped = src.model ? clampEffortToModel(src.model, effort) : effort;
  // affectUI model picker D6 — the effort control offers only what the model runs.
  const effortLevels = src.model ? pickerEffortLevels(modelCatalog.getEffortsFor(src.model)) : undefined;
  return {
    effort,
    ...(clamped !== effort ? { effortEffective: clamped } : {}),
    ...(effortLevels ? { effortLevels } : {}),
    issueShortRef: extractIssueShortRef(src.links?.issue?.url),
    prShortRef: extractPrShortRef(src.links?.pr?.url),
  };
}

const KANBAN_GOAL_STATUSES = new Set(['active', 'paused', 'complete']);

function positiveCount(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The armed automatic resume of a live session, if any (see
 * {@link KanbanAutoResume}). Reads the persisted markers the resume machinery
 * itself trusts: an error auto-retry counts only while its marker belongs to
 * the current run (`pendingRetrySessionId === sessionId`) and the session is
 * not asleep — the same rule `resumePendingErrorRetries` uses to re-arm it
 * after a restart (#351); `goal.evalBackoffUntil` is re-armed by the
 * post-restart goal resume (`resumeActiveGoals` → backoff gate). The soonest
 * action wins: a turn retry before a goal re-check.
 */
export function deriveAutoResume(s: any, now: number): KanbanAutoResume | undefined {
  const retryAt = Number(s?.pendingRetryAt);
  if (
    Number.isFinite(retryAt) &&
    retryAt > now &&
    s.state !== 'SLEEPING' &&
    s.pendingRetrySessionId !== undefined &&
    s.pendingRetrySessionId === s.sessionId
  ) {
    const detail = s.pendingRetryDetail ?? {};
    return {
      kind: 'error-retry',
      at: retryAt,
      attempt: positiveCount(detail.attempt),
      maxAttempts: positiveCount(detail.maxAttempts),
      reason: typeof detail.reason === 'string' && detail.reason ? detail.reason : undefined,
    };
  }
  const goal = s?.goal;
  if (!goal || goal.status !== 'active') return undefined;
  const backoffUntil = Number(goal.evalBackoffUntil);
  if (Number.isFinite(backoffUntil) && backoffUntil > now) {
    return {
      kind: 'goal-eval-retry',
      at: backoffUntil,
      attempt: positiveCount(goal.evalDispatchRetryCount),
      maxAttempts: GOAL_EVAL_DISPATCH_MAX_RETRIES,
      reason: typeof goal.evalRetryReason === 'string' && goal.evalRetryReason ? goal.evalRetryReason : undefined,
    };
  }
  if (goal.pendingEval) return { kind: 'goal-eval' };
  return undefined;
}

/**
 * The task list as the dashboard shows it: at most ONE task in progress.
 *
 * TodoWrite is a model-written snapshot and the model does mark several
 * tasks `in_progress` at once (parallel background work) — shown verbatim,
 * the timeline and panel spun two or three "current" tasks side by side. The
 * one current task is the first `in_progress` in list order (the task the
 * card's task row already names — `cardCurrentTask`); any later `in_progress`
 * reads as `pending`. A session with no work in flight (`hasCurrent` false —
 * see {@link sessionHasCurrentTask}) has no current task at all: every
 * `in_progress` reads as `pending`, the rule the Slack plan block applies when
 * a turn ends (`task-list-block-builder` finalize demotion). Display-only: the
 * stored snapshot (and its timestamps) is untouched, so the choice is stable
 * across updates.
 */
export function normalizeTaskProgress<T extends { status: string }>(
  tasks: readonly T[] | undefined,
  hasCurrent: boolean,
): T[] | undefined {
  if (!tasks) return undefined;
  let currentTaken = !hasCurrent;
  return tasks.map((t) => {
    if (t.status !== 'in_progress') return t;
    if (!currentTaken) {
      currentTaken = true;
      return t;
    }
    return { ...t, status: 'pending' };
  });
}

/**
 * Does this live session have work in flight, so one task may read as
 * current? A running turn, a question waiting on the user (the card's task row
 * names what it was doing), or an armed automatic resume (the task it will
 * pick up again). An idle session in DONE has none.
 */
export function sessionHasCurrentTask(s: any, autoResume: KanbanAutoResume | undefined): boolean {
  const state = s?.activityState;
  return state === 'working' || state === 'waiting' || autoResume !== undefined;
}

/** The goal list of a live session, shaped for the card (`KanbanSession.goal`). */
function goalToKanban(s: any): KanbanGoal | undefined {
  const goal = s.goal;
  const queue: any[] = Array.isArray(s.goalQueue) ? s.goalQueue : [];
  const history: any[] = Array.isArray(s.goalHistory) ? s.goalHistory : [];
  if (!goal && queue.length === 0 && history.length === 0) return undefined;
  return {
    current:
      goal && typeof goal.goalId === 'string' && KANBAN_GOAL_STATUSES.has(goal.status)
        ? {
            goalId: goal.goalId,
            objective: String(goal.objective ?? ''),
            status: goal.status,
            continuationCount: Number(goal.continuationCount) || 0,
            maxContinuations: Number(goal.maxContinuations) || 0,
            ...(typeof goal.lastEvalReason === 'string' && goal.lastEvalReason
              ? { lastEvalReason: goal.lastEvalReason }
              : {}),
          }
        : undefined,
    queue: queue
      .filter((g) => g && typeof g.goalId === 'string')
      .map((g) => ({ goalId: g.goalId, objective: String(g.objective ?? '') })),
    completedCount: history.length,
    history: history
      // A finished goal stays current when its queue is empty and is ALSO in the
      // history; the current block shows only objective + state, so the list
      // keeps it — the count and the list always agree.
      .filter((g) => g && typeof g.goalId === 'string')
      .map(goalHistoryItem)
      .reverse(),
  };
}

const GOAL_REASON_MAX = 1000;
function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/** A completed goal's details for the card (T6) — known fields only, numbers as numbers. */
function goalHistoryItem(g: any): KanbanGoalHistoryItem {
  const tokenParts = [g.tokensInput, g.tokensOutput, g.tokensCacheRead, g.tokensCacheCreate].map(finiteNumber);
  const item: KanbanGoalHistoryItem = { goalId: g.goalId, objective: String(g.objective ?? '') };
  const createdAt = finiteNumber(g.createdAt);
  if (createdAt !== undefined) item.createdAt = createdAt;
  const completedAt = finiteNumber(g.completedAt);
  if (completedAt !== undefined) item.completedAt = completedAt;
  if (typeof g.completedVia === 'string') item.completedVia = g.completedVia;
  if (typeof g.completionReason === 'string' && g.completionReason) {
    item.completionReason = g.completionReason.slice(0, GOAL_REASON_MAX);
  }
  const activeMsUsed = finiteNumber(g.activeMsUsed);
  if (activeMsUsed !== undefined) item.activeMsUsed = activeMsUsed;
  if (tokenParts.some((n) => n !== undefined)) item.tokens = tokenParts.reduce<number>((a, n) => a + (n ?? 0), 0);
  const costUsd = finiteNumber(g.costUsd);
  if (costUsd !== undefined) item.costUsd = costUsd;
  const continuationCount = finiteNumber(g.continuationCount);
  if (continuationCount !== undefined) item.continuationCount = continuationCount;
  return item;
}

/**
 * The card's token totals — the TASK total (SSOT 2026-10-26 T3): the persisted
 * `taskUsage` (main agent + every subagent, across restarts and resets) plus
 * the calls of the turn still running (`liveUsage`, priced at the session
 * model like the rest of the live cost). A session without `taskUsage` (none
 * spent yet since it existed) falls back to the runtime `usage.total*`. The
 * context gauge stays the live window's.
 */
function tokenUsageOf(s: any): KanbanSession['tokenUsage'] {
  const live = sumLiveUsage(s.liveUsage);
  const liveTokens = live.inputTokens + live.outputTokens + live.cacheReadTokens + live.cacheCreateTokens;
  const task = s.taskUsage;
  if (!task && !s.usage && liveTokens === 0) return undefined;
  const u = s.usage || {};
  const base = task
    ? {
        input: task.inputTokens || 0,
        output: task.outputTokens || 0,
        cacheRead: task.cacheReadTokens || 0,
        cacheCreate: task.cacheCreateTokens || 0,
        cost: task.costUsd || 0,
      }
    : {
        input: u.totalInputTokens || 0,
        output: u.totalOutputTokens || 0,
        cacheRead: u.totalCacheReadTokens || 0,
        cacheCreate: u.totalCacheCreateTokens || 0,
        cost: u.totalCostUsd || 0,
      };
  const liveCost =
    liveTokens > 0
      ? calculateTokenCost(s.model, live.inputTokens, live.outputTokens, live.cacheReadTokens, live.cacheCreateTokens)
      : 0;
  return {
    ...(task?.partialSince ? { partialSince: task.partialSince } : {}),
    totalInputTokens: base.input + live.inputTokens,
    totalOutputTokens: base.output + live.outputTokens,
    totalCacheReadTokens: base.cacheRead + live.cacheReadTokens,
    totalCacheCreateTokens: base.cacheCreate + live.cacheCreateTokens,
    totalCostUsd: base.cost + liveCost,
    contextUsagePercent: u.contextWindow
      ? (((u.currentInputTokens || 0) +
          (u.currentCacheReadTokens || 0) +
          (u.currentCacheCreateTokens || 0) +
          (u.currentOutputTokens || 0)) /
          u.contextWindow) *
        100
      : 0,
  };
}

/** T4/T5 — context fill, the auto-compact threshold of the current model, a waiting switch. */
function modelFields(s: any): Pick<KanbanSession, 'contextTokens' | 'autoCompactTokens' | 'pendingModel'> {
  const out: Pick<KanbanSession, 'contextTokens' | 'autoCompactTokens' | 'pendingModel'> = {};
  if (s.usage) out.contextTokens = usedContextTokens(s);
  try {
    if (s.model) out.autoCompactTokens = resolveEffectiveAutoCompact(s, s.ownerId || '', userSettingsStore).tokens;
  } catch (error) {
    logger.debug('auto-compact threshold unavailable for the card', { error: (error as Error)?.message });
  }
  // Past its TTL the switch no longer counts: the picker unlocks.
  const pending = livePendingModelSwitch(s);
  if (pending && typeof pending.nickname === 'string') out.pendingModel = pending.nickname;
  return out;
}

type ContextFields = Pick<KanbanSession, 'contextParts' | 'compactPending' | 'lastCompact'>;
/** A token counter as the card shows it: a finite count, else 0. */
function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}
/**
 * re-context-window D1–D4 — what fills the context now (the committed sample
 * `contextUsagePercent` reads, by cache category), a scheduled auto-compact,
 * and the latest compaction's SDK counts. Nothing is inferred: a missing
 * window sends no parts, a missing count no `lastCompact`.
 */
function contextFields(s: any): ContextFields {
  const out: ContextFields = {};
  const u = s.usage;
  const window = tokenCount(u?.contextWindow);
  if (u && window > 0) {
    const parts: NonNullable<KanbanSession['contextParts']> = {
      window,
      cacheRead: tokenCount(u.currentCacheReadTokens),
      cacheWrite: tokenCount(u.currentCacheCreateTokens),
      input: tokenCount(u.currentInputTokens),
      output: tokenCount(u.currentOutputTokens),
    };
    if (parts.input > 0 && parts.cacheRead === 0 && parts.cacheWrite === 0 && parts.output === 0) {
      // applyPostCompactOccupancy (session-usage-math.ts) writes post_tokens here with the rest zeroed.
      const post = finiteNumber(s.compactPostTokens);
      parts.unsplit = post !== undefined && Math.round(post) === parts.input ? 'compact' : 'unknown';
    }
    out.contextParts = parts;
  }
  if (s.autoCompactPending === true) out.compactPending = true;
  const pre = finiteNumber(s.compactPreTokens);
  const post = finiteNumber(s.compactPostTokens);
  // /new · /renew zero compactionCount on the same session object but keep the
  // last cycle's counts (cleared only when the next compaction starts): no
  // compaction in this logical session, no lastCompact.
  if (pre !== undefined && post !== undefined && (s.compactionCount || 0) > 0) {
    out.lastCompact = { preTokens: pre, postTokens: post };
    if (s.compactTrigger === 'manual' || s.compactTrigger === 'auto') out.lastCompact.trigger = s.compactTrigger;
  }
  return out;
}

/** T11 — when a live session's work finished; undefined while it works or waits. */
function liveDoneAt(s: any): number | undefined {
  const state = s.activityState || 'idle';
  if (state !== 'idle') return undefined;
  const changed = finiteNumber(s.activityStateChangedAt);
  if (changed) return changed;
  const last = s.lastActivity instanceof Date ? s.lastActivity.getTime() : Date.parse(String(s.lastActivity));
  return Number.isFinite(last) ? last : undefined;
}

/** Spec 13 §3.7 — a live session's exact finish time; undefined unless idle with a state stamp. */
function liveFinishedAt(s: any): number | undefined {
  return (s.activityState || 'idle') === 'idle' ? finiteNumber(s.activityStateChangedAt) : undefined;
}

/**
 * Spec 13 §3.7 — when a live session started waiting on its user: the oldest
 * of its open permission prompts and, while its own state is `waiting` (a
 * question), the switch to that state. A running turn's state stamp is when
 * it started working, so it never counts. Undefined when it does not wait.
 */
export function liveWaitingSince(
  s: { activityState?: string; activityStateChangedAt?: unknown },
  permissions: ReadonlyArray<{ createdAt?: unknown }>,
): number | undefined {
  let oldest: number | undefined;
  const consider = (v: unknown) => {
    const t = finiteNumber(v);
    if (t !== undefined && (oldest === undefined || t < oldest)) oldest = t;
  };
  for (const p of permissions) consider(p.createdAt);
  if ((s.activityState || 'idle') === 'waiting') consider(s.activityStateChangedAt);
  return oldest;
}

// ── Artifacts (SSOT 2026-10-23) ──

/** One work-log backfill at a time: a board of old cards must not read every log at once. */
let artifactBackfillChain: Promise<void> = Promise.resolve();
const artifactBackfillQueued = new Set<string>();

/**
 * The card's artifact summary. A conversation whose work log was never scanned
 * gets a backfill queued; what it finds arrives as `artifact_update` + a card patch.
 */
function cardArtifacts(conversationId: string | undefined): ArtifactSummary | undefined {
  if (!conversationId) return undefined;
  const store = getArtifactStore();
  if (!store.isBackfilled(conversationId) && !artifactBackfillQueued.has(conversationId)) {
    artifactBackfillQueued.add(conversationId);
    artifactBackfillChain = artifactBackfillChain
      .then(() => backfillArtifactsFromWorkLog(conversationId, store))
      .catch(() => {})
      .finally(() => artifactBackfillQueued.delete(conversationId));
  }
  return store.summary(conversationId);
}

/** The card's user-media count (SSOT 2026-10-25): one cached directory read per conversation. */
function cardUserMedia(conversationId: string | undefined): { count: number } | undefined {
  const count = getUserMediaStore().count(conversationId);
  return count > 0 ? { count } : undefined;
}

/**
 * A new artifact: tell every dashboard (the list is readable by any signed-in
 * user — artifact-routes.ts) and re-push the live card so its face row grows.
 */
export function broadcastArtifactUpdate(artifact: SessionArtifact): void {
  if (wsClients.size > 0) {
    try {
      const payload = JSON.stringify({ type: 'artifact_update', conversationId: artifact.conversationId, artifact });
      for (const client of wsClients) {
        try {
          client.send(payload);
        } catch {
          wsClients.delete(client);
        }
      }
    } catch (error) {
      logger.error('Failed to broadcast artifact update', error);
    }
  }
  const sessions = _getSessionsFn?.();
  if (!sessions) return;
  for (const [key, s] of sessions) {
    if (s?.conversationId === artifact.conversationId) scheduleLiveSessionUpdate(key);
  }
}

function sessionToKanban(key: string, s: any): KanbanSession {
  const autoResume = deriveAutoResume(s, Date.now());
  const taskView = _getTasksFn ? _getTasksFn(key) : undefined;
  const aggregate = computeThreadAggregate(s.channelId, s.threadTs, getAllSessions(), Date.now());
  const headline = displayTitle(s);
  const permissions = pendingPermissionsFor(s.channelId, s.threadTs);
  return {
    // #814 Wire-format key includes the local instance prefix so sibling
    // instances can never collide on the client cache.
    key: composeSessionKey(key),
    title: headline,
    displayHeadline: headline,
    cronJob: sanitizeCronJob(s.cronJob),
    // Emit summaryTitle so initial board renders (and full-page refresh) match
    // the live broadcastSummaryTitleChanged WS patch. Session registry stores
    // this on the session record itself — see session-registry.ts applyTitle.
    summaryTitle: typeof s.summaryTitle === 'string' && s.summaryTitle.length > 0 ? s.summaryTitle : undefined,
    ownerName: s.ownerName || s.ownerId || 'unknown',
    ownerId: s.ownerId || '',
    workflow: s.workflow || 'default',
    model: s.model || 'unknown',
    channelId: s.channelId,
    threadTs: s.threadTs,
    // A turn blocked on a permission prompt waits for its user (projection
    // only — the session's own activityState is untouched).
    activityState: permissions.length > 0 ? 'waiting' : s.activityState || 'idle',
    sessionState: s.state || 'MAIN',
    terminated: s.terminated === true,
    trashed: s.trashed === true,
    ...(s.starred === true ? { starred: true } : {}),
    conversationId: s.conversationId,
    lastActivity: s.lastActivity instanceof Date ? s.lastActivity.toISOString() : String(s.lastActivity),
    ...(permissions.length > 0 ? { pendingPermissions: permissions } : {}),
    issueUrl: s.links?.issue?.url,
    issueLabel: s.links?.issue?.label,
    issueTitle: s.links?.issue?.title,
    prUrl: s.links?.pr?.url,
    prLabel: s.links?.pr?.label,
    prTitle: s.links?.pr?.title,
    prStatus: s.links?.pr?.status,
    mergeStats: s.mergeStats
      ? {
          totalLinesAdded: s.mergeStats.totalLinesAdded,
          totalLinesDeleted: s.mergeStats.totalLinesDeleted,
        }
      : undefined,
    tokenUsage: tokenUsageOf(s),
    doneAt: liveDoneAt(s),
    waitingSince: liveWaitingSince(s, permissions),
    finishedAt: liveFinishedAt(s),
    ...modelFields(s),
    ...contextFields(s),
    tasks: normalizeTaskProgress(taskView?.current, sessionHasCurrentTask(s, autoResume)),
    earlierTasks: taskView?.earlier.length ? taskView.earlier : undefined,
    tasksOutside: taskView?.outside,
    botName: _botDisplayName || undefined,
    ...agentsToKanban(s.agents, true),
    slackThreadUrl:
      s.channelId && s.threadTs ? (buildThreadPermalink(s.channelId, s.threadTs) ?? undefined) : undefined,
    // Dashboard v2.1 — timer + compaction fields
    activeLegStartedAtMs: s.activeLegStartedAtMs,
    activeAccumulatedMs: s.activeAccumulatedMs || 0,
    compactionCount: s.compactionCount || 0,
    threadTotalActiveMs: aggregate.totalActiveMs,
    threadSessionCount: aggregate.sessionCount,
    threadCompactionCount: aggregate.compactionCount,
    ...cardDerivedFields({
      effort: s.effort,
      ownerId: s.ownerId,
      model: s.model,
      links: s.links,
      persistedEffort: true,
    }),
    // #814 Stamp self env (when wired) so the frontend renders the env
    // badge for self cards too — siblings get their env from the
    // aggregator's mergeBoards stamp.
    environment: _selfInstanceEnv ? { ..._selfInstanceEnv } : undefined,
    goal: goalToKanban(s),
    ...(autoResume ? { autoResume } : {}),
    artifacts: cardArtifacts(s.conversationId),
    userMedia: cardUserMedia(s.conversationId),
    followups: followupsOf(key, s.ownerId),
    pendingQuestion: s.actionPanel?.pendingQuestion
      ? s.actionPanel.pendingQuestion.type === 'user_choice'
        ? {
            type: 'user_choice' as const,
            question: s.actionPanel.pendingQuestion.question,
            choices: s.actionPanel.pendingQuestion.choices?.map((c: any) => ({
              id: c.id,
              label: c.label,
              description: c.description,
            })),
            ...(s.actionPanel.pendingQuestion.recommendedChoiceId
              ? { recommendedChoiceId: s.actionPanel.pendingQuestion.recommendedChoiceId }
              : {}),
          }
        : s.actionPanel.pendingQuestion.type === 'user_choices'
          ? {
              type: 'user_choices' as const,
              question: s.actionPanel.pendingQuestion.title || '복수 질문',
              questionCount: s.actionPanel.pendingQuestion.questions?.length || 0,
              title: s.actionPanel.pendingQuestion.title,
              description: s.actionPanel.pendingQuestion.description,
              questions: s.actionPanel.pendingQuestion.questions?.map((q: any) => ({
                id: q.id,
                question: q.question,
                choices: (q.choices || []).map((c: any) => ({
                  id: c.id,
                  label: c.label,
                  description: c.description,
                })),
                context: q.context,
                ...(q.recommendedChoiceId ? { recommendedChoiceId: q.recommendedChoiceId } : {}),
              })),
            }
          : undefined // Unknown question type — skip
      : undefined,
  };
}

/** The task ledger an archive kept (T7/T8), as the card carries it. */
function archivedTasks(archived: ArchivedSession): Pick<KanbanSession, 'tasks' | 'earlierTasks' | 'tasksOutside'> {
  const ledger = sanitizeTaskLedger(archived.taskLedger);
  if (!ledger) return {};
  const view = ledgerTasks(ledger);
  // An archived session runs nothing: no task reads as current.
  return {
    tasks: normalizeTaskProgress(view.current, false),
    earlierTasks: view.earlier.length ? view.earlier : undefined,
    tasksOutside: view.outside,
  };
}

/**
 * Convert an ArchivedSession to KanbanSession for the closed column.
 * Trace: Scenario 3, Section 3a transformation
 */
function archivedToKanban(archived: ArchivedSession): KanbanSession {
  const headline = displayTitle(archived);
  return {
    // #814 Same composite-key scheme as live cards. The original archive
    // key already contains underscores and timestamps; the instance
    // prefix simply nests on top via `::`.
    key: composeSessionKey(`archived_${archived.sessionKey}_${archived.archivedAt}`),
    title: headline,
    displayHeadline: headline,
    cronJob: sanitizeCronJob(archived.cronJob),
    summaryTitle:
      typeof archived.summaryTitle === 'string' && archived.summaryTitle.length > 0 ? archived.summaryTitle : undefined,
    ownerName: archived.ownerName || archived.ownerId || 'unknown',
    ownerId: archived.ownerId || '',
    workflow: archived.workflow || 'default',
    model: archived.model || 'unknown',
    channelId: archived.channelId,
    threadTs: archived.threadTs,
    activityState: 'idle', // Archived sessions are not active
    sessionState: archived.archiveReason === 'sleep_expired' ? 'SLEEPING' : 'TERMINATED',
    terminated: true,
    conversationId: archived.conversationId,
    lastActivity: archived.lastActivity,
    issueUrl: archived.links?.issue?.url,
    issueLabel: archived.links?.issue?.label,
    issueTitle: archived.links?.issue?.title,
    prUrl: archived.links?.pr?.url,
    prLabel: archived.links?.pr?.label,
    prTitle: archived.links?.pr?.title,
    prStatus: archived.links?.pr?.status,
    mergeStats: archived.mergeStats
      ? {
          totalLinesAdded: archived.mergeStats.totalLinesAdded,
          totalLinesDeleted: archived.mergeStats.totalLinesDeleted,
        }
      : undefined,
    // The task total it kept (SSOT 2026-10-26 T3); an older archive has only
    // the runtime usage it saw last.
    tokenUsage: archived.taskUsage
      ? {
          totalInputTokens: archived.taskUsage.inputTokens || 0,
          totalOutputTokens: archived.taskUsage.outputTokens || 0,
          totalCacheReadTokens: archived.taskUsage.cacheReadTokens || 0,
          totalCacheCreateTokens: archived.taskUsage.cacheCreateTokens || 0,
          totalCostUsd: archived.taskUsage.costUsd || 0,
          contextUsagePercent: 0, // No active context for archived sessions
          ...(archived.taskUsage.partialSince ? { partialSince: archived.taskUsage.partialSince } : {}),
        }
      : archived.usage
        ? {
            totalInputTokens: archived.usage.totalInputTokens || 0,
            totalOutputTokens: archived.usage.totalOutputTokens || 0,
            totalCacheReadTokens: archived.usage.totalCacheReadTokens || 0,
            totalCacheCreateTokens: archived.usage.totalCacheCreateTokens || 0,
            totalCostUsd: archived.usage.totalCostUsd || 0,
            contextUsagePercent: 0, // No active context for archived sessions
          }
        : undefined,
    // The archive's kept finish time (spec 13 §3.7); an older archive falls
    // back to its last activity for the day groups only.
    finishedAt: finiteNumber(archived.doneAt),
    doneAt:
      finiteNumber(archived.doneAt) ??
      (Number.isFinite(Date.parse(archived.lastActivity)) ? Date.parse(archived.lastActivity) : undefined),
    ...archivedTasks(archived),
    botName: _botDisplayName || undefined,
    ...agentsToKanban(sanitizeAgentRegistry(archived.agents), false),
    goal: goalToKanban(archived),
    artifacts: cardArtifacts(archived.conversationId),
    userMedia: cardUserMedia(archived.conversationId),
    slackThreadUrl:
      archived.channelId && archived.threadTs
        ? (buildThreadPermalink(archived.channelId, archived.threadTs) ?? undefined)
        : undefined,
    // Dashboard v2.1 — derive from archive snapshot fields.
    activeLegStartedAtMs: undefined, // archived sessions never have an open leg
    activeAccumulatedMs: archived.busyMs || 0,
    compactionCount: archived.compactionCount || 0,
    threadTotalActiveMs: archived.busyMs || 0,
    threadSessionCount: 1,
    threadCompactionCount: archived.compactionCount || 0,
    ...cardDerivedFields({ ownerId: archived.ownerId, links: archived.links, persistedEffort: false }),
    environment: _selfInstanceEnv ? { ..._selfInstanceEnv } : undefined,
  };
}

/**
 * A session the board shows: one that has run an SDK session — or, after a
 * `/new` cleared that, one whose task has already spent (SSOT 2026-10-26 T3:
 * the task total outlives the reset, so the card does too).
 */
function onBoard(s: { sessionId?: string; taskUsage?: unknown }): boolean {
  return !!s.sessionId || !!s.taskUsage;
}

function buildKanbanBoard(userId?: string): KanbanBoard {
  const sessions = getAllSessions();
  const board: KanbanBoard = { working: [], waiting: [], idle: [], closed: [] };

  for (const [key, session] of sessions.entries()) {
    if (!onBoard(session)) continue;
    if (userId && session.ownerId !== userId) continue;
    if (session.trashed === true) continue;

    const kanban = sessionToKanban(key, session);

    // Closed: SLEEPING state (terminated sessions are handled via archive below)
    if (session.state === 'SLEEPING') {
      board.closed.push(kanban);
    } else {
      switch (kanban.activityState) {
        case 'working':
          board.working.push(kanban);
          break;
        case 'waiting':
          board.waiting.push(kanban);
          break;
        default:
          // Idle but with an armed automatic resume (turn retry, goal
          // re-check) is unfinished work — RUNNING, not DONE.
          if (kanban.autoResume) board.working.push(kanban);
          else board.idle.push(kanban);
          break;
      }
    }
  }

  // Add recently archived sessions to closed column (#401)
  // Dedup: skip archives that overlap with a live session (same thread or same conversationId).
  // This prevents ghost cards when:
  //   - A bot-initiated thread terminates the source session (conversationId match)
  //   - A user sends a message to a terminated thread, creating a new session (thread key match)
  try {
    const liveThreadKeys = new Set<string>();
    const liveConversationIds = new Set<string>();
    for (const [, s] of sessions.entries()) {
      if (!onBoard(s)) continue;
      if (s.trashed === true) continue;
      if (s.channelId && s.threadTs) liveThreadKeys.add(`${s.channelId}:${s.threadTs}`);
      if (s.conversationId) liveConversationIds.add(s.conversationId);
    }

    // How long archives stay listed is the admin-set lifecycle policy (48h default).
    const archives = getArchiveStore().listRecent(getSessionLifecyclePolicy().boardArchiveWindowMs);
    // Fix #438: Sort archives newest-first so the most recent interaction in a
    // thread/conversation wins during dedup (older terminated duplicates are dropped)
    const sortedArchives = [...archives].sort((a, b) => b.archivedAt - a.archivedAt);
    const seenArchiveConversationIds = new Set<string>();
    const seenArchiveThreadKeys = new Set<string>();
    for (const archived of sortedArchives) {
      // Fix #438: Skip archives without sessionId — these sessions were terminated
      // before any Claude interaction (e.g., bot-thread migration source sessions)
      if (!onBoard(archived)) continue;
      if (userId && archived.ownerId !== userId) continue;
      // Skip if a live session exists in the same thread
      if (archived.channelId && archived.threadTs && liveThreadKeys.has(`${archived.channelId}:${archived.threadTs}`)) {
        logger.debug('Skipping archive (thread overlap with live session)', { archivedKey: archived.sessionKey });
        continue;
      }
      // Skip if a live session shares the same conversationId (bot-initiated migration)
      if (archived.conversationId && liveConversationIds.has(archived.conversationId)) {
        logger.debug('Skipping archive (conversationId overlap with live session)', {
          archivedKey: archived.sessionKey,
          conversationId: archived.conversationId,
        });
        continue;
      }
      // Fix #438: Archive-to-archive dedup — skip if we've already seen a newer archive
      // with the same conversationId or thread key
      if (archived.conversationId && seenArchiveConversationIds.has(archived.conversationId)) {
        continue;
      }
      const archiveThreadKey =
        archived.channelId && archived.threadTs ? `${archived.channelId}:${archived.threadTs}` : null;
      if (archiveThreadKey && seenArchiveThreadKeys.has(archiveThreadKey)) {
        continue;
      }
      // Track this archive for future dedup
      if (archived.conversationId) seenArchiveConversationIds.add(archived.conversationId);
      if (archiveThreadKey) seenArchiveThreadKeys.add(archiveThreadKey);
      board.closed.push(archivedToKanban(archived));
    }
  } catch (err) {
    logger.warn('Failed to load archived sessions for dashboard — closed column may be incomplete', err);
  }

  // Sort each column: starred first (SSOT 2026-10-30 T2), then lastActivity desc
  const byActivity = (a: KanbanSession, b: KanbanSession) =>
    Number(b.starred === true) - Number(a.starred === true) ||
    new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  board.working.sort(byActivity);
  board.waiting.sort(byActivity);
  board.idle.sort(byActivity);
  board.closed.sort(byActivity);

  return board;
}

// ── Stats aggregation ──────────────────────────────────────────────

/**
 * KST calendar day ('YYYY-MM-DD') of a timestamp. One formatter for every call:
 * `toLocaleDateString(…, { timeZone })` builds a new one each time (~35 µs),
 * which was 90% of a month of stats — thousands of events, on the event loop
 * every other request waits on (#477).
 */
const KST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Per-day stats for one user, or for every user when `userId` is absent. */
function aggregateUserStats(events: MetricsEvent[], userId?: string): Map<string, UserDayStats> {
  const dayMap = new Map<string, UserDayStats>();

  for (const ev of events) {
    if (userId && ev.userId !== userId) continue;
    // A hand-edited line without a usable timestamp is skipped, not a 500 for the whole period.
    if (typeof ev.timestamp !== 'number' || !Number.isFinite(ev.timestamp)) continue;

    const dateStr = KST_DAY.format(ev.timestamp);
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, {
        date: dateStr,
        sessionsCreated: 0,
        turnsUsed: 0,
        prsCreated: 0,
        prsMerged: 0,
        commitsCreated: 0,
        linesAdded: 0,
        linesDeleted: 0,
        mergeLinesAdded: 0,
        mergeLinesDeleted: 0,
        workflowCounts: {},
      });
    }
    const day = dayMap.get(dateStr)!;

    switch (ev.eventType) {
      case 'session_created': {
        day.sessionsCreated++;
        const wf = (ev.metadata?.workflow as string) || 'default';
        day.workflowCounts[wf] = (day.workflowCounts[wf] || 0) + 1;
        break;
      }
      case 'turn_used':
        day.turnsUsed++;
        break;
      case 'pr_created':
        day.prsCreated++;
        break;
      case 'pr_merged':
        day.prsMerged++;
        break;
      case 'commit_created':
        day.commitsCreated++;
        break;
      case 'code_lines_added':
        day.linesAdded += (ev.metadata?.linesAdded as number) || 0;
        day.linesDeleted += (ev.metadata?.linesDeleted as number) || 0;
        break;
      case 'merge_lines_added':
        day.mergeLinesAdded += (ev.metadata?.linesAdded as number) || 0;
        day.mergeLinesDeleted += (ev.metadata?.linesDeleted as number) || 0;
        break;
    }
  }

  return dayMap;
}

function getDateRange(period: 'day' | 'week' | 'month'): { startDate: string; endDate: string } {
  const now = new Date();
  const end = KST_DAY.format(now);

  let start: Date;
  switch (period) {
    case 'day':
      start = now;
      break;
    case 'week':
      start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      start = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
      break;
  }
  const startDate = KST_DAY.format(start);
  return { startDate, endDate: end };
}

/**
 * Get date range starting from a specific date string (YYYY-MM-DD).
 */
function getDateRangeFrom(date: string, period: 'day' | 'week' | 'month'): { startDate: string; endDate: string } {
  const base = new Date(date + 'T00:00:00Z');
  switch (period) {
    case 'day':
      return { startDate: date, endDate: date };
    case 'week': {
      const end = new Date(base.getTime() + 6 * 24 * 60 * 60 * 1000);
      return { startDate: date, endDate: end.toISOString().slice(0, 10) };
    }
    case 'month': {
      const end = new Date(base.getTime() + 29 * 24 * 60 * 60 * 1000);
      return { startDate: date, endDate: end.toISOString().slice(0, 10) };
    }
  }
}

// ── WebSocket broadcast ────────────────────────────────────────────

type WsClient = { send: (data: string) => void; close: () => void; userId?: string; isAdmin?: boolean };
const wsClients = new Set<WsClient>();

/** Broadcast session state update to all connected WebSocket clients */
export function broadcastSessionUpdate(): void {
  if (wsClients.size === 0) return;
  try {
    const board = buildKanbanBoard();
    const payload = JSON.stringify({ type: 'session_update', board });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast session update', error);
  }
}

/** Broadcast task update to all connected WebSocket clients */
export function broadcastTaskUpdate(
  sessionKey: string,
  tasks: DashboardTask[],
  earlierTasks: DashboardTask[] = [],
  tasksOutside?: TaskWork,
): void {
  if (wsClients.size === 0) return;
  try {
    // #814 External callers (e.g. Slack handler) pass the raw session key.
    // Compose the wire-format key here so the client cache (keyed by
    // composite `${instanceName}::${rawKey}`) finds the card.
    const wireKey = composeSessionKey(sessionKey);
    // Same one-current-task view as the board payload (sessionToKanban).
    const live = _getSessionsFn?.().get(sessionKey);
    const payload = JSON.stringify({
      type: 'task_update',
      sessionKey: wireKey,
      tasks: normalizeTaskProgress(tasks, sessionHasCurrentTask(live, deriveAutoResume(live, Date.now()))),
      earlierTasks,
      tasksOutside: tasksOutside ?? null,
    });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast task update', error);
  }
}

/**
 * Send a payload to the conversation's audience: the owning session's owner
 * plus admin clients. Shared by `conversation_update` and `work_log` so both
 * events have the same scope by construction.
 */
function sendToConversationAudience(conversationId: string, payload: string): void {
  // Resolve session owner for scoping — iterate because sessions are keyed by
  // sessionKey (channelId:threadTs), not conversationId (UUID)
  let ownerId: string | undefined;
  const sessions = _getSessionsFn?.();
  if (sessions) {
    for (const [, s] of sessions) {
      if (s.conversationId === conversationId) {
        ownerId = s.ownerId;
        break;
      }
    }
  }

  if (!ownerId) {
    // No active session — broadcast only to admin clients so archived session
    // updates (e.g., resummarize) still reach the admin dashboard without
    // leaking to non-owner clients.
    logger.debug('No active session for broadcast, sending to admin clients only', { conversationId });
  }

  for (const client of wsClients) {
    if (!ownerId) {
      // When owner is unknown, only admin clients receive the update
      if (!client.isAdmin) continue;
    } else if (!client.isAdmin && client.userId && client.userId !== ownerId) {
      continue;
    }
    try {
      client.send(payload);
    } catch {
      wsClients.delete(client);
    }
  }
}

/** Broadcast conversation turn update — scoped to session owner's WS clients only */
export function broadcastConversationUpdate(conversationId: string, turn: any): void {
  if (wsClients.size === 0) return;
  try {
    // Strip rawContent from assistant turns to reduce bandwidth
    const sanitizedTurn = turn?.role === 'assistant' && turn?.rawContent ? { ...turn, rawContent: undefined } : turn;
    const payload = JSON.stringify({ type: 'conversation_update', conversationId, turn: sanitizedTurn });
    sendToConversationAudience(conversationId, payload);
  } catch (error) {
    logger.error('Failed to broadcast conversation update', error);
  }
}

/** Broadcast a work-log entry (spec §3.3) — same owner/admin scope as `conversation_update`. */
export function broadcastWorkLog(conversationId: string, entry: WorkLogEntry): void {
  if (wsClients.size === 0) return;
  try {
    sendToConversationAudience(conversationId, JSON.stringify({ type: 'work_log', conversationId, entry }));
  } catch (error) {
    logger.error('Failed to broadcast work log entry', error);
  }
}

/**
 * Dashboard v2.1 — targeted summaryTitle update. Sent in lieu of a full
 * session_update to avoid re-sending the whole board for a title change.
 *
 * Carries the resolved `displayHeadline` (#762) so clients render server-truth
 * directly instead of re-implementing the priority chain. No-op when the
 * session is gone — same defensive shape as `broadcastSingleSessionUpdate`,
 * so a missing session surfaces as a server-side log line rather than a
 * silently-degraded payload.
 */
export function broadcastSummaryTitleChanged(sessionKey: string, summaryTitle: string): void {
  if (wsClients.size === 0) return;
  try {
    const session = _getSessionsFn?.().get(sessionKey);
    if (!session) {
      logger.warn('broadcastSummaryTitleChanged: session not found', { sessionKey });
      return;
    }
    // #814 — clients key their cache by composite. See broadcastTaskUpdate.
    const wireKey = composeSessionKey(sessionKey);
    const payload = JSON.stringify({
      type: 'summaryTitleChanged',
      sessionKey: wireKey,
      summaryTitle,
      displayHeadline: displayTitle(session),
    });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast summaryTitleChanged', error);
  }
}

/**
 * Push a single-session kanban payload (#762) — used by the link-derived title
 * pipeline so a card that just got its first real title doesn't have to wait
 * for the next periodic full-board broadcast. Sends the same `KanbanSession`
 * shape that `sessionToKanban` produces, so the client just feeds it back
 * through `renderCard()`.
 *
 * No-op when the session can't be found (terminated/unknown key) — that path
 * would otherwise emit a malformed event the client would silently ignore.
 */
export function broadcastSingleSessionUpdate(sessionKey: string): void {
  if (wsClients.size === 0) return;
  try {
    const session = _getSessionsFn?.().get(sessionKey);
    if (!session || !onBoard(session)) return;
    const kanban = sessionToKanban(sessionKey, session);
    const payload = JSON.stringify({ type: 'sessionUpdated', session: kanban });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast single session update', error);
  }
}

/**
 * At most one push per key per `intervalMs`: the first call sends at once, the
 * calls inside the window collapse into one trailing send at its end — so the
 * last value always arrives (SSOT 2026-10-22 T1/T2 live usage).
 */
export function createLiveUpdateThrottle(send: (key: string) => void, intervalMs: number): (key: string) => void {
  const state = new Map<string, { last: number; timer?: ReturnType<typeof setTimeout> }>();
  return (key: string) => {
    const now = Date.now();
    const st = state.get(key) ?? { last: Number.NEGATIVE_INFINITY };
    state.set(key, st);
    if (st.timer) return;
    const wait = st.last + intervalMs - now;
    if (wait <= 0) {
      st.last = now;
      send(key);
      return;
    }
    st.timer = setTimeout(() => {
      st.timer = undefined;
      st.last = Date.now();
      send(key);
    }, wait);
    st.timer.unref?.();
  };
}

/** Push a running card whose live usage grew — once a second at most per session. */
export const scheduleLiveSessionUpdate = createLiveUpdateThrottle((key) => broadcastSingleSessionUpdate(key), 1000);

/** Broadcast session action feedback to all connected WebSocket clients */
function broadcastSessionAction(sessionKey: string, action: 'stop' | 'close' | 'trash'): void {
  if (wsClients.size === 0) return;
  try {
    const payload = JSON.stringify({ type: 'session_action', sessionKey, action });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast session action', error);
  }
}

// ── Route registration ─────────────────────────────────────────────

// Opt-in route compression for the dashboard's first load (#477): ~1.5 MB of
// HTML + JSON that the public proxy does not compress. br or gzip only (route
// options replace the plugin's, so the list is explicit here; zstd would
// otherwise win on Node 26). Brotli quality 5 instead of the plugin's default 4:
// ~8% smaller page for ~2x the CPU (≈16 ms for the 0.8 MB page, off the event
// loop above the plugin's sync threshold).
const FIRST_LOAD_COMPRESSION = {
  encodings: ['br', 'gzip'] as Array<'br' | 'gzip'>,
  threshold: 1024,
  brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } },
};

export async function registerDashboardRoutes(
  server: FastifyInstance,
  authMiddleware: (req: any, reply: any) => Promise<void>,
  csrfMiddleware?: (req: any, reply: any) => Promise<void>,
): Promise<void> {
  const store = new MetricsEventStore();

  // ── JSON API ──

  // Kanban sessions
  // The board: hundreds of KB of JSON, polled every 30 s by every open tab.
  server.get<{ Querystring: { userId?: string; selfOnly?: string } }>(
    '/api/dashboard/sessions',
    { preHandler: [authMiddleware], compress: FIRST_LOAD_COMPRESSION },
    async (request, reply) => {
      const userId = request.query.userId || undefined;
      const selfOnly = request.query.selfOnly === 'true';
      const board = buildKanbanBoard(userId);
      // The admin Lifecycle dialog reads the policy from the board poll.
      const lifecycle = lifecycleView();

      // #814 — when not the recursion-guarded selfOnly path, ask the
      // aggregator to fan out to sibling instances on the same host.
      // Skip pre-listen / single-instance.
      if (!_selfInstanceEnv) {
        return reply.send({ board, lifecycle });
      }
      if (selfOnly) {
        return reply.send({ board, lifecycle });
      }

      try {
        // Pre-discover once and reuse the same records inside
        // `fetchSiblingBoards` (via `discoverFn`) so the gate doesn't
        // cost a second readdir+readFile sweep.
        const all = await readAllInstances();
        const selfPort = _selfInstanceEnv.port;
        const siblingCount = all.filter((r) => r.port !== selfPort && r.pid !== process.pid).length;
        if (
          !shouldAggregate({
            selfOnly,
            viewerToken: config.conversation.viewerToken,
            siblingCount,
          })
        ) {
          return reply.send({ board, lifecycle });
        }
        // Per-poll TTL cache — multiple browser tabs polling /sessions
        // every 30 s shouldn't independently fan out N×HTTP each time.
        // 1.5 s collapses a burst of concurrent polls without going
        // stale enough to mask a sibling that just came up.
        const cached = _aggregatorCacheGet();
        let siblings;
        if (cached) {
          siblings = cached;
        } else {
          siblings = await fetchSiblingBoards({
            selfPort,
            selfPid: process.pid,
            viewerToken: config.conversation.viewerToken,
            discoverFn: async () => all,
          });
          _aggregatorCacheSet(siblings);
        }
        const merged = mergeBoards({
          selfBoard: board,
          selfEnv: _selfInstanceEnv,
          siblings,
        });
        return reply.send({ board: merged, lifecycle });
      } catch (err) {
        // Hard failure of the aggregator must never surface a 500 —
        // fall back to self-only. Log at error (with stack) so a
        // genuine bug in mergeBoards / fetch wiring is visible, not
        // confused with the warn-throttled per-sibling failures.
        logger.error('Aggregator failed; serving self-only board', err);
        return reply.send({ board, lifecycle });
      }
    },
  );

  // Session lifecycle policy (sleep / archive / board windows). Readable by any
  // signed-in user; only an admin may change it — the viewer-token bearer, or an
  // ADMIN_USERS member with X-Admin-Mode: on (same gate as cross-owner writes, #716).
  // CRON lane (SSOT 2026-10-23 T4/T5): this instance's jobs — prompt never
  // included — with their runs newest first, each linked to its session.
  // Readable like the board; `userId` narrows to one owner.
  server.get<{ Querystring: { userId?: string } }>(
    '/api/dashboard/cron',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      if (!_cronSource) {
        reply.send({ jobs: [] });
        return;
      }
      try {
        const jobs = buildCronJobsView({
          jobs: _cronSource.listJobs(),
          history: _cronSource.listHistory(),
          userId: request.query.userId || undefined,
          nowMs: Date.now(),
          findSession: cronRunSessionIndex(),
        });
        reply.send({ jobs });
      } catch (err) {
        logger.error('Cron lane read failed', err);
        reply.send({ jobs: [], error: 'cron storage unreadable' });
      }
    },
  );

  // LLM capacity (SSOT 2026-10-23 T7/T9/T10): the llmux cooldown view. Same
  // exposure as the readonly `auth` card (#803 — account identity visible to
  // every viewer; infra settings never). Cached; an llmux failure is a 200
  // with `available:false` and a fixed reason — never a 500.
  server.get('/api/dashboard/capacity', { preHandler: [authMiddleware] }, async (_request, reply) => {
    reply.send({ capacity: await readCapacity() });
  });

  server.get('/api/dashboard/lifecycle', { preHandler: [authMiddleware] }, async (_request, reply) => {
    reply.send({ lifecycle: lifecycleView() });
  });

  // Shortening a duration sleeps or ends sessions on the next sweep, and ending
  // removes their work dirs — so a change that would move any live session is
  // answered 409 with the counts until the caller repeats it with ?confirm=1.
  server.put<{ Body: unknown; Querystring: { confirm?: string } }>(
    '/api/dashboard/lifecycle',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      if (!_hasWriteAccess(request, undefined)) {
        reply
          .status(403)
          .send({ error: 'Forbidden — changing the lifecycle policy requires an admin with Admin mode on' });
        return;
      }
      try {
        const before = getSessionLifecyclePolicy();
        const next = previewSessionLifecyclePolicy(request.body);
        // While degraded the sweep has been paused, so nothing has moved under
        // `before`: count every session the resumed sweep would move.
        const from = isSessionLifecyclePolicyDegraded()
          ? { ...before, sleepAfterMs: Number.POSITIVE_INFINITY, archiveAfterMs: Number.POSITIVE_INFINITY }
          : before;
        const impact = countLifecycleTransitions(getAllSessions().values(), from, next, Date.now());
        if ((impact.willSleep > 0 || impact.willArchive > 0) && request.query.confirm !== '1') {
          reply.status(409).send({ needsConfirm: true, ...impact });
          return;
        }
        const lifecycle = updateSessionLifecyclePolicy(request.body);
        const auth = (request as any).authContext;
        logger.warn('Session lifecycle policy changed', {
          actor: auth?.userId || auth?.mode || 'unknown',
          before,
          after: lifecycle,
          ...impact,
        });
        broadcastSessionUpdate();
        reply.send({ lifecycle: lifecycleView() });
      } catch (error) {
        if (error instanceof SessionLifecyclePolicyError) {
          reply.status(400).send({ error: error.message, field: error.field });
          return;
        }
        logger.error('Failed to save the session lifecycle policy', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Stats for one user, or for every user when userId is absent (the All Users view).
  server.get<{ Querystring: { userId?: string; period?: string } }>(
    '/api/dashboard/stats',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { period: rawPeriod } = request.query;
      const userId = request.query.userId || undefined;
      // #716: stats are world-readable for any authenticated user. The
      // session/conversation contents are also world-readable; write
      // operations (close/command/resummarize) remain gated by
      // requireSessionOwner.
      const period = (['day', 'week', 'month'].includes(rawPeriod || '') ? rawPeriod : 'day') as
        | 'day'
        | 'week'
        | 'month';
      const { startDate, endDate } = getDateRange(period);

      try {
        const events = await store.readRange(startDate, endDate);
        const dayMap = aggregateUserStats(events, userId);
        const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

        const totals = days.reduce(
          (acc, d) => {
            const wfCounts = { ...acc.workflowCounts };
            for (const [wf, cnt] of Object.entries(d.workflowCounts)) {
              wfCounts[wf] = (wfCounts[wf] || 0) + cnt;
            }
            return {
              sessionsCreated: acc.sessionsCreated + d.sessionsCreated,
              turnsUsed: acc.turnsUsed + d.turnsUsed,
              prsCreated: acc.prsCreated + d.prsCreated,
              prsMerged: acc.prsMerged + d.prsMerged,
              commitsCreated: acc.commitsCreated + d.commitsCreated,
              linesAdded: acc.linesAdded + d.linesAdded,
              linesDeleted: acc.linesDeleted + d.linesDeleted,
              mergeLinesAdded: acc.mergeLinesAdded + d.mergeLinesAdded,
              mergeLinesDeleted: acc.mergeLinesDeleted + d.mergeLinesDeleted,
              workflowCounts: wfCounts,
            };
          },
          {
            sessionsCreated: 0,
            turnsUsed: 0,
            prsCreated: 0,
            prsMerged: 0,
            commitsCreated: 0,
            linesAdded: 0,
            linesDeleted: 0,
            mergeLinesAdded: 0,
            mergeLinesDeleted: 0,
            workflowCounts: {} as Record<string, number>,
          },
        );

        reply.send({ userId: userId ?? null, period, days, totals } satisfies UserStats);
      } catch (error) {
        logger.error('Error computing dashboard stats', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Token usage statistics
  server.get<{ Querystring: { period?: string; userId?: string; date?: string } }>(
    '/api/dashboard/usage',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { period: rawPeriod, userId, date } = request.query;
      const period = (['day', 'week', 'month'].includes(rawPeriod || '') ? rawPeriod : 'day') as
        | 'day'
        | 'week'
        | 'month';

      // Validate date format and semantic validity if provided
      // Roundtrip check: JS normalizes "2026-04-31" → "2026-05-01", so we reject when the parsed date
      // does not match the original string (catches impossible calendar dates).
      if (date) {
        const parsed = new Date(date + 'T00:00:00Z');
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          Number.isNaN(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== date
        ) {
          reply.status(400).send({ error: 'Invalid date. Use YYYY-MM-DD.' });
          return;
        }
      }

      const { startDate, endDate } = date ? getDateRangeFrom(date, period) : getDateRange(period);

      try {
        const aggregator = new ReportAggregator(store);
        const report = await aggregator.aggregateTokenUsage(startDate, endDate, userId || undefined);
        reply.send(usageForViewer(report, (request as { authContext?: UsageViewer }).authContext));
      } catch (error) {
        logger.error('Error computing token usage stats', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // All users list (for dashboard navigation)
  server.get('/api/dashboard/users', { preHandler: [authMiddleware] }, async (_request, reply) => {
    const sessions = getAllSessions();
    const users = new Map<string, string>();
    for (const [, session] of sessions.entries()) {
      if (session.ownerId && session.ownerName) {
        users.set(session.ownerId, session.ownerName);
      }
    }
    reply.send({ users: Array.from(users.entries()).map(([id, name]) => ({ id, name })) });
  });

  // Session detail (conversation turns for slide panel)
  // Supports pagination via ?limit=N&before=<turnId>. Default limit=30, max=200.
  // - No `before`: returns the latest N turns (chronological order preserved).
  // - With `before`: returns up to N turns strictly BEFORE the turn with that id.
  // Response includes `hasMore: true` when older turns exist beyond the returned window.
  server.get<{
    Params: { conversationId: string };
    Querystring: { limit?: string; before?: string };
  }>('/api/dashboard/session/:conversationId', { preHandler: [authMiddleware] }, async (request, reply) => {
    try {
      const record = await getConversation(request.params.conversationId);
      if (!record) {
        reply.status(404).send({ error: 'Conversation not found' });
        return;
      }
      // #716: session details world-readable for any authenticated user.
      // Writes (resummarize/title/close/command/answer-choice/...) still
      // run requireSessionOwner so cross-user reads do not imply
      // cross-user writes.

      const DEFAULT_LIMIT = 30;
      const MAX_LIMIT = 200;
      const limitRaw = request.query.limit ? Number.parseInt(request.query.limit, 10) : DEFAULT_LIMIT;
      const limit = Number.isNaN(limitRaw) ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, limitRaw));
      const before = request.query.before;

      // Compute the window on the source array BEFORE allocating projected copies —
      // on a 10k-turn conversation this avoids allocating 10k throwaway objects per request.
      const source = record.turns;
      let startIdx: number;
      let endIdx: number;
      let hasMore: boolean;
      if (before) {
        const beforeIdx = source.findIndex((t) => t.id === before);
        if (beforeIdx < 0) {
          // Unknown cursor → return empty, no more
          startIdx = 0;
          endIdx = 0;
          hasMore = false;
        } else {
          startIdx = Math.max(0, beforeIdx - limit);
          endIdx = beforeIdx;
          hasMore = startIdx > 0;
        }
      } else {
        startIdx = Math.max(0, source.length - limit);
        endIdx = source.length;
        hasMore = startIdx > 0;
      }

      // Lightweight turn summaries (no rawContent for assistant turns).
      const turns = source.slice(startIdx, endIdx).map((t) => ({
        id: t.id,
        role: t.role,
        timestamp: t.timestamp,
        userName: t.userName,
        summaryTitle: t.summaryTitle,
        summaryBody: t.summaryBody,
        summarized: t.summarized,
        rawContent: t.role === 'user' ? t.rawContent : undefined,
        // User media (SSOT 2026-10-25): the files this instruction carried, metadata only.
        attachments: t.role === 'user' ? t.attachments : undefined,
        // SSOT 2026-10-27: who put a user turn there (a host turn reads as one
        // line), and a /compact turn's compaction (estimate, then its result).
        origin: t.role === 'user' ? t.origin : undefined,
        compact: t.role === 'user' ? t.compact : undefined,
      }));

      reply.send({
        id: record.id,
        title: record.title,
        titleSub: record.titleSub,
        ownerName: record.ownerName,
        workflow: record.workflow,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        turnCount: record.turns.length,
        turns,
        hasMore,
      });
    } catch (error) {
      logger.error('Error fetching session detail', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  // Resummarize a specific assistant turn
  server.post<{ Params: { conversationId: string; turnId: string } }>(
    '/api/dashboard/session/:conversationId/resummarize/:turnId',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      try {
        // #716 / Oracle re-review P2: enforce the same write-access
        // policy as kanban actions — bearer admin, owner, or
        // OAuth admin with X-Admin-Mode: on header. The previous
        // shortcut (isAdmin alone) skipped the safe-mode header.
        const record = await getConversation(request.params.conversationId);
        if (!record) {
          reply.status(404).send({ error: 'Turn not found or not an assistant turn' });
          return;
        }
        if (!requireConversationWriteAccess(request, reply, record.ownerId)) return;
        const ok = await resummarizeTurn(request.params.conversationId, request.params.turnId);
        if (!ok) {
          reply.status(404).send({ error: 'Turn not found or not an assistant turn' });
          return;
        }
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error resummarizing turn', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Subtitle (titleSub). #716 makes reads world-readable and writes owner-only;
  // #717 P2 put generate-title behind that write gate. The panel fills a missing
  // subtitle on open for every viewer, so filling has its own route that only
  // needs sign-in + CSRF: titleSub is derived data with no author (the caller
  // picks when it is generated, never what it says), and a fill never
  // overwrites. This exception covers filling an EMPTY titleSub and nothing
  // else — replacing one stays on generate-title behind the write gate.
  server.post<{ Params: { conversationId: string } }>(
    '/api/dashboard/session/:conversationId/ensure-title',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      try {
        const record = await getConversation(request.params.conversationId);
        if (!record) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }
        sendTitleSubResult(reply, await ensureTitleSub(record));
      } catch (error) {
        logger.error('Error filling title', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Regenerate (overwrite) titleSub — owner, or admin with X-Admin-Mode: on.
  server.post<{ Params: { conversationId: string } }>(
    '/api/dashboard/session/:conversationId/generate-title',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      try {
        const record = await getConversation(request.params.conversationId);
        if (!record) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }
        // #716 / Oracle re-review P2: same write-access policy as
        // resummarize and kanban actions.
        if (!requireConversationWriteAccess(request, reply, record.ownerId)) return;
        sendTitleSubResult(reply, await regenerateTitleSub(record));
      } catch (error) {
        logger.error('Error generating title', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Action routes ──

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/stop',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { wireKey: key, originalKey } = resolved;
      try {
        if (_stopHandlerFn) {
          await _stopHandlerFn(originalKey);
        }
        // Broadcast uses wire-format so the client cache lookup matches.
        broadcastSessionAction(key, 'stop');
        broadcastSessionUpdate();
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error stopping session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/close',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { wireKey: key, originalKey } = resolved;
      try {
        if (_closeHandlerFn) {
          await _closeHandlerFn(originalKey);
        }
        broadcastSessionAction(key, 'close');
        broadcastSessionUpdate();
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error closing session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/trash',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { wireKey: key, originalKey } = resolved;
      // A starred session is pinned on top of the board; hiding it would
      // contradict the star (SSOT 2026-10-30). Unstar it first.
      if (getAllSessions().get(normalizeSessionKey(originalKey))?.starred === true) {
        reply.status(409).send({ error: '즐겨찾기한 세션은 휴지통으로 옮길 수 없어요 — 먼저 별을 해제하세요' });
        return;
      }
      try {
        if (_trashHandlerFn) {
          await _trashHandlerFn(originalKey);
        }
        broadcastSessionAction(key, 'trash');
        broadcastSessionUpdate();
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error trashing session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Task star + revive (SSOT 2026-10-30) ──
  // Star: pinned on top + kept alive (starring a sleeping or archived card
  // brings it back first — T5). Revive: a sleeping session wakes, an archived
  // one is restored so the conversation continues (T4). Owner-only like Close;
  // an archived card is gated by its archive's owner and names the exact
  // archive it shows. The answer carries the live key, so the page can follow
  // an archived card to the session it became.

  server.post<{ Params: { key: string }; Body: { starred?: unknown } }>(
    '/api/dashboard/session/:key/star',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const starred = request.body?.starred;
      if (typeof starred !== 'boolean') {
        reply.status(400).send({ error: 'starred must be a boolean' });
        return;
      }
      if (!_lifecycleHandler) {
        reply.status(501).send({ error: 'Lifecycle handler not configured' });
        return;
      }
      const target = resolveLifecycleTarget(request, reply);
      if (!target) return;
      try {
        let revived = false;
        let outcome: SessionLifecycleOutcome;
        if (target.kind === 'archived') {
          if (!starred) {
            reply.status(409).send({ error: '보관된 세션에는 별이 없어요', code: 'conflict' });
            return;
          }
          const restored = _lifecycleHandler.restore(target.archived);
          if (!restored.ok) {
            sendLifecycleRefusal(reply, restored);
            return;
          }
          revived = restored.revived;
          outcome = _lifecycleHandler.star(restored.sessionKey, true);
        } else {
          outcome = _lifecycleHandler.star(target.originalKey, starred);
        }
        if (!outcome.ok) {
          sendLifecycleRefusal(reply, outcome);
          return;
        }
        broadcastSessionUpdate();
        reply.send({
          ok: true,
          key: composeSessionKey(outcome.sessionKey),
          starred: outcome.starred,
          revived: revived || outcome.revived,
        });
      } catch (error) {
        logger.error('Error starring session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/revive',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      if (!_lifecycleHandler) {
        reply.status(501).send({ error: 'Lifecycle handler not configured' });
        return;
      }
      const target = resolveLifecycleTarget(request, reply);
      if (!target) return;
      try {
        const outcome =
          target.kind === 'archived'
            ? _lifecycleHandler.restore(target.archived)
            : _lifecycleHandler.revive(target.originalKey);
        if (!outcome.ok) {
          sendLifecycleRefusal(reply, outcome);
          return;
        }
        broadcastSessionUpdate();
        reply.send({
          ok: true,
          key: composeSessionKey(outcome.sessionKey),
          starred: outcome.starred,
          revived: outcome.revived,
        });
      } catch (error) {
        logger.error('Error reviving session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // The panel's composer (dashboard task view T1.5): a multiline instruction
  // with the images, files and voice notes the user added — base64 in JSON like
  // a new task's, under the same limits (and the same body limit, so a phone
  // photo fits). A files-only instruction is allowed.
  server.post<{ Params: { key: string }; Body: { message?: string; attachments?: unknown } }>(
    '/api/dashboard/session/:key/command',
    { bodyLimit: NEW_TASK_BODY_LIMIT, preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { message = '', attachments } = request.body || {};
      if (typeof message !== 'string') {
        reply.status(400).send({ error: 'message must be a string' });
        return;
      }
      if (message.length > NEW_TASK_LIMITS.maxPromptChars) {
        reply.status(400).send({ error: `message exceeds max length (${NEW_TASK_LIMITS.maxPromptChars} chars)` });
        return;
      }
      if (!message.trim() && !(Array.isArray(attachments) && attachments.length > 0)) {
        reply.status(400).send({ error: 'message is required (or attach a file)' });
        return;
      }
      // Only the session's owner gets their files decoded (up to the new-task limits).
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      const files = parseAttachments(attachments);
      if (!files.ok) {
        reply.status(400).send({ error: files.error });
        return;
      }
      try {
        if (_commandHandlerFn) {
          await _commandHandlerFn(originalKey, message, files.value);
        }
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error sending command to session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // The panel's follow-up queue (dashboard batch 2, <ui-agent-steering>): Send now
  // (Retry on a failed note), Cancel and Edit on one item. Owner-only like Stop —
  // the same gate — and carrying the generation the panel showed: the item's
  // epoch, and the session's turnEpoch that Send now is fenced against. A
  // refusal answers with the queue's own words; the item stays where it was.
  server.post<{
    Params: { key: string; itemId: string; op: string };
    Body: { epoch?: unknown; turnEpoch?: unknown; text?: unknown };
  }>(
    '/api/dashboard/session/:key/queue/:itemId/:op',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { itemId, op } = request.params;
      const body = request.body || {};
      if (op !== 'promote' && op !== 'cancel' && op !== 'edit') {
        reply.status(404).send({ error: "op must be 'promote', 'cancel' or 'edit'" });
        return;
      }
      if (!itemId || itemId.length > 400) {
        reply.status(400).send({ error: 'itemId is required' });
        return;
      }
      const generation = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
      if (!generation(body.epoch) || !generation(body.turnEpoch)) {
        reply.status(400).send({ error: 'epoch and turnEpoch are required (the generation the panel showed)' });
        return;
      }
      let text: string | undefined;
      if (op === 'edit') {
        if (typeof body.text !== 'string' || !body.text.trim()) {
          reply.status(400).send({ error: 'text is required and must be a non-empty string' });
          return;
        }
        if (body.text.length > NEW_TASK_LIMITS.maxPromptChars) {
          reply.status(400).send({ error: `text exceeds max length (${NEW_TASK_LIMITS.maxPromptChars} chars)` });
          return;
        }
        text = body.text.trim();
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      if (!_followupHandler) {
        reply.status(501).send({ error: 'Follow-up queue handler not configured' });
        return;
      }
      try {
        const outcome = await _followupHandler.act({
          sessionKey: originalKey,
          itemId,
          op,
          epoch: body.epoch,
          turnEpoch: body.turnEpoch,
          ...(text !== undefined ? { text } : {}),
        });
        // Whatever the queue answered, the panel gets the queue as it is now.
        scheduleLiveSessionUpdate(originalKey);
        if (outcome.ok) reply.send(outcome.message ? { ok: true, message: outcome.message } : { ok: true });
        else reply.status(outcome.status).send({ error: outcome.message });
      } catch (error) {
        logger.error('Error acting on the follow-up queue', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Goal list (work item) ──

  server.post<{
    Params: { key: string };
    Body: { action?: unknown; objective?: unknown; goalId?: unknown; expect?: unknown };
  }>(
    '/api/dashboard/session/:key/goal',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const body = request.body || {};
      let action: HostGoalAction;
      if (body.action === 'add') {
        if (typeof body.objective !== 'string' || !body.objective.trim()) {
          reply.status(400).send({ error: 'objective is required and must be a non-empty string' });
          return;
        }
        if (body.objective.length > 4000) {
          reply.status(400).send({ error: 'objective exceeds max length (4000 chars)' });
          return;
        }
        action = { action: 'add', objective: body.objective };
      } else if (body.action === 'delete') {
        if (typeof body.goalId !== 'string' || !body.goalId || body.goalId.length > 200) {
          reply.status(400).send({ error: 'goalId is required and must be a string' });
          return;
        }
        if (body.expect !== 'current' && body.expect !== 'queued') {
          reply.status(400).send({ error: "expect must be 'current' or 'queued'" });
          return;
        }
        action = { action: 'delete', goalId: body.goalId, expect: body.expect };
      } else {
        reply.status(400).send({ error: "action must be 'add' or 'delete'" });
        return;
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      if (!_goalActionHandlerFn) {
        reply.status(501).send({ error: 'Goal action handler not configured' });
        return;
      }
      try {
        // The acting dashboard user (owner, or an admin in admin mode); a bearer
        // client has none and the handler falls back to the session owner.
        const actorUserId = (request as { authContext?: { userId?: string } }).authContext?.userId;
        const result = await _goalActionHandlerFn(originalKey, action, actorUserId);
        broadcastSessionUpdate();
        reply.send({ ok: true, result });
      } catch (error) {
        if (error instanceof HostGoalActionError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        logger.error('Error applying goal action from dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Model switch (SSOT 2026-10-22 T4/T5) ──

  server.post<{ Params: { key: string }; Body: { model?: unknown } }>(
    '/api/dashboard/session/:key/model',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const nickname = (request.body || {}).model;
      if (typeof nickname !== 'string' || !nickname || nickname.length > 64) {
        reply.status(400).send({ error: 'model is required and must be a representative model nickname' });
        return;
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      if (!_modelSwitchHandlerFn) {
        reply.status(501).send({ error: 'Model switch handler not configured' });
        return;
      }
      try {
        const result = await _modelSwitchHandlerFn(resolved.originalKey, nickname);
        broadcastSessionUpdate();
        reply.send({ ok: true, result });
      } catch (error) {
        if (error instanceof ModelSwitchError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        logger.error('Error switching model from dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Effort switch (SSOT 2026-10-23 T1) ──

  server.post<{ Params: { key: string }; Body: { effort?: unknown } }>(
    '/api/dashboard/session/:key/effort',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const effort = (request.body || {}).effort;
      if (typeof effort !== 'string' || !effort || effort.length > 32) {
        reply.status(400).send({ error: `effort is required: one of ${EFFORT_LEVELS.join(', ')}` });
        return;
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      if (!_effortSwitchHandlerFn) {
        reply.status(501).send({ error: 'Effort switch handler not configured' });
        return;
      }
      try {
        const result = await _effortSwitchHandlerFn(resolved.originalKey, effort);
        reply.send({ ok: true, result });
      } catch (error) {
        if (error instanceof EffortSwitchError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        logger.error('Error switching effort from dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── New task (SSOT 2026-10-23) ──

  server.get('/api/dashboard/new-task/context', { preHandler: [authMiddleware] }, async (request, reply) => {
    const userId = newTaskUserId(request);
    if (!userId) {
      reply.status(403).send({ error: 'Slack 계정으로 로그인해야 새 작업을 시작할 수 있습니다' });
      return;
    }
    if (!_newTaskProvider) {
      reply.status(501).send({ error: 'New task is not configured' });
      return;
    }
    try {
      reply.send({ context: await _newTaskProvider.context(userId) });
    } catch (error) {
      logger.error('Error building the new-task context', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  server.post<{ Body: unknown }>(
    '/api/dashboard/new-task',
    {
      preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])],
      // Phone photos / voice notes travel as base64 in the JSON body; the
      // decoded sizes are bounded again by parseNewTaskSubmission.
      bodyLimit: NEW_TASK_BODY_LIMIT,
    },
    async (request, reply) => {
      const userId = newTaskUserId(request);
      if (!userId) {
        reply.status(403).send({ error: 'Slack 계정으로 로그인해야 새 작업을 시작할 수 있습니다' });
        return;
      }
      const provider = _newTaskProvider;
      if (!provider) {
        reply.status(501).send({ error: 'New task is not configured' });
        return;
      }
      const requestId = (request.body as { requestId?: unknown } | null)?.requestId;
      try {
        const result = await _newTaskGate.run(userId, typeof requestId === 'string' ? requestId : '', async () => {
          // Authorize against a FRESH context: membership is re-checked right
          // before anything is posted into the channel.
          const context = await provider.context(userId, { fresh: true });
          const parsed = parseNewTaskSubmission(request.body, context);
          if (!parsed.ok) throw new NewTaskError(400, parsed.error);
          return provider.start(userId, parsed.value);
        });
        reply.send({ ok: true, ...result });
      } catch (error) {
        if (error instanceof NewTaskError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        logger.error('Error starting a new task from the dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Answer choice from dashboard ──

  server.post<{ Params: { key: string }; Body: { choiceId: string; label: string; question: string } }>(
    '/api/dashboard/session/:key/answer-choice',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { choiceId, label, question } = request.body || {};
      if (
        !choiceId ||
        typeof choiceId !== 'string' ||
        !label ||
        typeof label !== 'string' ||
        !question ||
        typeof question !== 'string'
      ) {
        reply.status(400).send({ error: 'choiceId, label, and question are required and must be strings' });
        return;
      }
      if (choiceId.length > 100 || label.length > 500 || question.length > 2000) {
        reply.status(400).send({ error: 'Field length exceeded' });
        return;
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      try {
        if (_choiceAnswerHandlerFn) {
          await _choiceAnswerHandlerFn(originalKey, choiceId, label, question);
        } else {
          reply.status(501).send({ error: 'Choice answer handler not configured' });
          return;
        }
        reply.send({ ok: true });
      } catch (error) {
        const errMsg = (error as Error).message || '';
        if (errMsg === 'Session not found') {
          reply.status(404).send({ error: 'Session not found' });
        } else if (errMsg === 'Session is not waiting for a choice') {
          reply.status(409).send({ error: 'Session is not waiting for a choice' });
        } else if (errMsg === 'Invalid choice ID') {
          reply.status(422).send({ error: 'Invalid choice ID' });
        } else {
          logger.error('Error answering choice from dashboard', error);
          reply.status(500).send({ error: 'Internal Server Error' });
        }
      }
    },
  );

  // ── Answer multi-choice from dashboard ──

  server.post<{
    Params: { key: string };
    Body: { selections: Record<string, { choiceId: string; label: string }> };
  }>(
    '/api/dashboard/session/:key/answer-multi-choice',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { selections } = request.body || {};
      if (
        !selections ||
        typeof selections !== 'object' ||
        Array.isArray(selections) ||
        Object.keys(selections).length === 0
      ) {
        reply.status(400).send({ error: 'selections is required and must be a non-empty object' });
        return;
      }
      // Reject payloads with too many selections (max 50 questions per form)
      const selKeys = Object.keys(selections);
      if (selKeys.length > 50) {
        reply.status(400).send({ error: 'Too many selections' });
        return;
      }
      // Validate each selection entry
      for (const sel of Object.values(selections)) {
        if (
          !sel ||
          typeof sel !== 'object' ||
          !sel.choiceId ||
          typeof sel.choiceId !== 'string' ||
          !sel.label ||
          typeof sel.label !== 'string'
        ) {
          reply.status(400).send({ error: 'Invalid selection entry' });
          return;
        }
        if (sel.choiceId.length > 200 || sel.label.length > 1000) {
          reply.status(400).send({ error: 'Selection field length exceeded' });
          return;
        }
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      try {
        if (_multiChoiceAnswerHandlerFn) {
          await _multiChoiceAnswerHandlerFn(originalKey, selections);
        } else {
          reply.status(501).send({ error: 'Multi-choice answer handler not configured' });
          return;
        }
        reply.send({ ok: true });
      } catch (error) {
        const errMsg = (error as Error).message || '';
        if (errMsg === 'Session not found') {
          reply.status(404).send({ error: 'Session not found' });
        } else if (errMsg === 'Session is not waiting for a choice') {
          reply.status(409).send({ error: 'Session is not waiting for choices' });
        } else if (errMsg === 'Session has no pending multi-choice question') {
          reply.status(409).send({ error: 'Session has no pending multi-choice question' });
        } else if (errMsg.startsWith('Missing answer for question')) {
          reply.status(400).send({ error: errMsg });
        } else if (errMsg === 'Invalid choice ID') {
          reply.status(422).send({ error: 'Invalid choice ID' });
        } else {
          logger.error('Error answering multi-choice from dashboard', error);
          reply.status(500).send({ error: 'Internal Server Error' });
        }
      }
    },
  );

  // ── Permission prompts from dashboard (SSOT 2026-10-24) ──
  //
  // Only the user the prompt was raised for reads its parameters or answers
  // it — the Slack card's rule. That is the turn's initiator, who is not
  // always the session owner (a mention in someone else's thread), so the
  // owner gate does not apply here: the requester check replaces it. The
  // bearer token and admin mode carry no requester identity and are refused.
  // A prompt of another thread is 404 under this session's key.

  /** The live session behind the route key and its prompt, or null after replying. */
  async function resolvePermissionTarget(
    request: any,
    reply: any,
    approvalId: string,
  ): Promise<{
    originalKey: string;
    thread: { channel: string; threadTs?: string };
    pending: NonNullable<Awaited<ReturnType<typeof loadPermissionPrompt>>>;
  } | null> {
    const originalKey = resolveSelfActionKey(request.params?.key ?? '', reply);
    if (originalKey === null) return null;
    const session = getAllSessions().get(originalKey);
    if (!session || !session.channelId) {
      reply.status(404).send({ error: 'Session not found' });
      return null;
    }
    const thread = { channel: String(session.channelId), threadTs: session.threadTs || undefined };
    const pending = await loadPermissionPrompt(approvalId);
    if (!pending || !promptBelongsToThread(pending, thread)) {
      reply.status(404).send({ error: 'Permission request not found or expired' });
      return null;
    }
    const actor = request.authContext?.userId;
    if (!actor || !pending.user || actor !== pending.user) {
      reply.status(403).send({ error: 'Only the user this permission request is for can see or answer it' });
      return null;
    }
    return { originalKey, thread, pending };
  }

  // The id names files in the store: no path characters (`/`, `.`) may reach path.join.
  const isApprovalId = (v: unknown): v is string =>
    typeof v === 'string' && v.length <= 128 && /^approval_[A-Za-z0-9_]+$/.test(v);

  server.get<{ Params: { key: string; approvalId: string } }>(
    '/api/dashboard/session/:key/permission/:approvalId',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { approvalId } = request.params;
      if (!isApprovalId(approvalId)) {
        reply.status(400).send({ error: 'Invalid approval id' });
        return;
      }
      try {
        const target = await resolvePermissionTarget(request, reply, approvalId);
        if (!target) return;
        reply.header('Cache-Control', 'no-store').send(permissionPromptDetail(approvalId, target.pending));
      } catch (error) {
        logger.error('Error reading a permission prompt for the dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.post<{ Params: { key: string }; Body: { approvalId?: unknown; decision?: unknown } }>(
    '/api/dashboard/session/:key/permission',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { approvalId, decision } = request.body || {};
      if (!isApprovalId(approvalId) || !isPermissionPromptDecision(decision)) {
        reply
          .status(400)
          .send({ error: 'approvalId and decision (approve | deny | explain | approve_disable_rule) are required' });
        return;
      }
      if (!_permissionAnswerHandlerFn) {
        reply.status(501).send({ error: 'Permission answer handler not configured' });
        return;
      }
      try {
        const target = await resolvePermissionTarget(request, reply, approvalId);
        if (!target) return;
        const result = await _permissionAnswerHandlerFn({
          approvalId,
          actor: (request as { authContext?: { userId?: string } }).authContext?.userId,
          decision,
          thread: target.thread,
        });
        if (result.ok) {
          logger.info('Permission prompt answered from the dashboard', {
            approvalId,
            decision,
            sessionKey: target.originalKey,
          });
          reply.send({ ok: true, decision });
          return;
        }
        switch (result.reason) {
          case 'already_answered':
            reply.status(409).send({ error: 'Permission request was already answered' });
            return;
          case 'not_requester':
            reply.status(403).send({ error: 'Only the user this permission request is for can answer it' });
            return;
          default:
            reply.status(404).send({ error: 'Permission request not found or expired' });
            return;
        }
      } catch (error) {
        logger.error('Error answering a permission prompt from the dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Submit-all-recommended from dashboard (hero one-click) ──

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/submit-recommended',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      try {
        if (!_submitRecommendedHandlerFn) {
          reply.status(501).send({ error: 'Submit-recommended handler not configured' });
          return;
        }
        await _submitRecommendedHandlerFn(originalKey);
        reply.send({ ok: true });
      } catch (error) {
        const errMsg = (error as Error).message || '';
        if (errMsg === 'Session not found') {
          reply.status(404).send({ error: 'Session not found' });
        } else if (
          errMsg === 'Session is not waiting for a choice' ||
          errMsg === 'Session has no pending multi-choice question' ||
          errMsg === 'Submission in progress' ||
          errMsg === 'Recommendations incomplete'
        ) {
          reply.status(409).send({ error: errMsg });
        } else if (errMsg === 'No recommendation available') {
          reply.status(422).send({ error: errMsg });
        } else {
          logger.error('Error submitting recommended from dashboard', error);
          reply.status(500).send({ error: 'Internal Server Error' });
        }
      }
    },
  );

  // ── @2lab.ai/ui — the library's own build, same origin ──
  // The 작업 로그's tool call cards are <ui-tool-call-card> from the installed
  // @2lab.ai/ui package (a pinned dependency): its flat dist/*.js files, nothing
  // else. Public library code — no session data — so no auth.
  server.get<{ Params: { file: string } }>('/dashboard/ui/:file', async (request, reply) => {
    const file = String(request.params.file || '');
    const dir = uiLibDistDir();
    if (!dir || !UI_LIB_FILE.test(file)) return reply.code(404).send();
    try {
      const body = await readFile(join(dir, file));
      return reply
        .header('Cache-Control', 'public, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff')
        .type('text/javascript; charset=utf-8')
        .send(body);
    } catch {
      return reply.code(404).send();
    }
  });

  // ── HTML Dashboard ──

  // The page is ~0.8 MB of inline HTML/CSS/JS: compressed when the browser
  // accepts it (web-server registers @fastify/compress opt-in, #477). These
  // handlers return the reply: a compressed body is a stream, and an async
  // handler that resolves without returning it ends the response empty.
  server.get(
    '/dashboard',
    { preHandler: [authMiddleware], compress: FIRST_LOAD_COMPRESSION },
    async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').send(renderDashboardPage());
    },
  );

  server.get<{ Params: { userId: string } }>(
    '/dashboard/:userId',
    { preHandler: [authMiddleware], compress: FIRST_LOAD_COMPRESSION },
    async (request, reply) => {
      return reply.type('text/html; charset=utf-8').send(renderDashboardPage(request.params.userId));
    },
  );

  // ── WebSocket ──

  try {
    await server.register(await import('@fastify/websocket'));

    const MAX_WS_CLIENTS = 100;

    server.get('/ws/dashboard', { websocket: true, preHandler: [authMiddleware] }, (socket: any, request: any) => {
      // Enforce max client cap to prevent DoS
      if (wsClients.size >= MAX_WS_CLIENTS) {
        logger.warn('WebSocket max clients reached, rejecting', { total: wsClients.size });
        socket.close(1013, 'Max clients reached');
        return;
      }
      const authContext = request?.authContext;
      const client: WsClient = {
        send: (data: string) => socket.send(data),
        close: () => socket.close(),
        userId: authContext?.userId,
        isAdmin: authContext?.isAdmin,
      };
      wsClients.add(client);
      logger.debug('WebSocket client connected', { total: wsClients.size });

      // Send initial state
      try {
        const board = buildKanbanBoard();
        socket.send(JSON.stringify({ type: 'session_update', board }));
      } catch {
        /* ignore */
      }

      socket.on('close', () => {
        wsClients.delete(client);
        logger.debug('WebSocket client disconnected', { total: wsClients.size });
      });
    });
  } catch (error) {
    logger.warn('WebSocket support unavailable (install @fastify/websocket for real-time updates)', error);
  }

  logger.info('Dashboard routes registered');
}

// ── Dashboard HTML ─────────────────────────────────────────────────

/** re-model-picker D5 — a representative model with its registry price per M tokens; unchanged when the registry does not know the id. */
function withPickerPrice<T extends { model: string }>(m: T): T | (T & { price: { input: number; output: number } }) {
  const pricing = findModelPricing(m.model);
  return pricing ? { ...m, price: { input: pricing.inputPerMTok, output: pricing.outputPerMTok } } : m;
}

function renderDashboardPage(userId?: string): string {
  const initUser = userId ? JSON.stringify(userId) : 'null';
  // #814 — inject the local instance's name so the frontend can identify
  // sibling cards (`environment.instanceName !== SELF_INSTANCE_NAME`) and
  // hide actions that would silently 4xx if dispatched to the wrong port.
  const initSelfInstance = _selfInstanceEnv ? JSON.stringify(_selfInstanceEnv.instanceName) : 'null';
  // ui.dashboardheader — normalized card-header composition (config.json#ui
  // via @soma/slack/surface-config; docs/ui-surfaces.md). `<` is escaped so
  // an operator-supplied label cannot break out of the <script> block.
  const initDashboardHeaderConfig = JSON.stringify(getSurfaceLines('dashboardheader', 'default')).replace(
    /</g,
    '\\u003c',
  );
  // SSOT 2026-10-22 T4 — the representative models a card can switch to, with
  // their window and auto-compact threshold (escaped like the header config);
  // the model picker's tray and cost bar add the registry price per M tokens
  // (re-model-picker D5) — only for an id the registry knows.
  let representativeModels: unknown[] = [];
  try {
    representativeModels = listRepresentativeModels(productionModelCatalogDeps()).map(withPickerPrice);
  } catch (error) {
    logger.warn('Representative models unavailable for the dashboard', error);
  }
  const initRepresentativeModels = JSON.stringify(representativeModels).replace(/</g, '\\u003c');
  const initEffortLevels = JSON.stringify(EFFORT_LEVELS);
  // T8: the bot's Slack name (escaped like the header config — it comes from Slack).
  const initBotName = JSON.stringify(_botDisplayName || null).replace(/</g, '\\u003c');
  // Icon slots (<i data-ui-icon="…">) are filled from @2lab.ai/ui's icon set (fillUiIcons).
  return fillUiIcons(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>soma-work Dashboard</title>
<script type="module" src="/dashboard/ui/tool-call-card.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/ai-answer.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/agent-tree.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/agent-steering.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/context-window.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/approval-card.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/agent-inbox.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/toaster.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/compact-breakdown.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/model-picker.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/agent-queue.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/segmented.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/disclosure.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/tooltip.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/menu.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/dialog.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/drawer.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/conversation.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/work-log.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/choice-form.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/task-runs.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/task-plan.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/status-bar.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/deck-nav.js?v=${UI_LIB_VERSION}"></script>
<script data-fouc>
// FOUC prevention — apply theme before CSS paints
(function(){var t=localStorage.getItem('soma-theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();
</script>
<!-- @2lab.ai/ui kit (ui-kit.css): the light-DOM button, icon button, chip, status, kbd … classes on the
     --ui-* tokens below. Before the page sheet, so a page rule that places a kit control wins. -->
<style id="ui-kit">
${uiLibKitCss()}
</style>
<style>
/* ═══ @2lab.ai/ui language (ui.2lab.ai) ═══ Calm neutral planes, soft 6–16px rounding, medium weights,
   colour only where it carries status, one ink primary per surface, short ease-out motion. */
*,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
/* Tokens: the ui-tokens sheet after this one (@2lab.ai/ui tokens.css + the dashboard aliases). */
:root {
  /* Dashboard-only (no library counterpart). Motion is the contract's alone: --dur-press / -fade /
     -expand / -move with --ease-out / --ease-in-out; colour and border changes are 150ms ease. */
  /* Status tints — the library recipe (agent-inbox / context-window styles): a 14% wash of the status
     into the surface, the word 70% of the status toward the ink. Every pair is ≥ 4.5:1 in light and
     dark (numbers in the P5 commit). Derived here once so no rule below hard-codes a colour. */
  --tint-wait-bg: color-mix(in srgb, var(--st-wait) 14%, var(--surface));
  --tint-wait-soft: color-mix(in srgb, var(--st-wait) 8%, var(--surface));
  --tint-wait-line: color-mix(in srgb, var(--st-wait) 40%, var(--border));
  --tint-wait-fg: color-mix(in srgb, var(--st-wait) 70%, var(--text));
  --tint-done-soft: color-mix(in srgb, var(--st-done) 8%, var(--surface));
  --tint-done-line: color-mix(in srgb, var(--st-done) 40%, var(--border));
  --tint-done-fg: color-mix(in srgb, var(--st-done) 70%, var(--text));
  --tint-fail-bg: color-mix(in srgb, var(--st-fail) 14%, var(--surface));
  --tint-fail-bg-2: color-mix(in srgb, var(--st-fail) 22%, var(--surface));
  --tint-fail-line: color-mix(in srgb, var(--st-fail) 55%, var(--border));
  --tint-fail-fg: color-mix(in srgb, var(--st-fail-text) 70%, var(--text));
  --tint-accent-soft: color-mix(in srgb, var(--accent) 8%, var(--surface));
  --tint-accent-fg: color-mix(in srgb, var(--accent) 70%, var(--text));
  /* Scrim under overlays and dialogs (@2lab.ai/ui 0.5 --scrim; the installed 0.4.4 lacks it — once
     it ships, the ui-tokens alias after this sheet takes over). */
  --scrim: rgba(20, 20, 22, 0.32);
  /* Over a picture or a page the theme does not paint: a fixed dark wash with white type, the white
     page an HTML artifact renders on, and the letterbox behind a video. */
  --media-scrim: rgba(0, 0, 0, 0.55);
  --on-media: #fff;
  --media-paper: #fff;
  --media-black: #000;
}
[data-theme="dark"] { --scrim: rgba(0, 0, 0, 0.56); }
[data-theme="light"] ::selection { background: var(--accent); color: var(--surface); }
[data-theme="light"] ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--text-tertiary) 38%, var(--bg)); border-color: var(--bg); }

html,body {
  min-height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

::selection { background: var(--accent); color: var(--bg); }
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--border); border: 2px solid var(--bg); border-radius: 999px; }

/* ── FOCUS — visible outline for keyboard nav ── */
:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }

/* viewport-fit=cover (SSOT 2026-10-24): the page reaches under the notch and the
   Dynamic Island, so it keeps clear of the side insets itself (landscape phones,
   the iPhone Duo cover). */
.app { display: flex; flex-direction: column; min-height: 100vh; padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px); }

/* ── TOPBAR — strict horizontal grid ──
   One row from 1024px; below that the nav (user select · 대화 · 설정 · 기억 · admin
   toggle) takes its own row under brand · status · account (BOARD RESPONSIVE).
   No control ever wraps or cuts its label: everything is nowrap and flex: none.
   Only user names are ever shortened, always with a visible ellipsis and the
   full name in title: the pill's name when its row is full, and the selected
   user's name when it is wider than its cap — 180px on the one-row bar (≥1024,
   even when the row has room), the whole nav row below 1024px. */
.topbar {
  /* ui.2lab.ai's app bar: the page colour at 86% over what scrolls under it, blurred,
     one hairline; opaque when the reader asks for less transparency (below). */
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  min-width: 0;
  /* SSOT 2026-10-29 T3: the top bar is always on screen — it stays at the top
     while the board scrolls (the docked drawer sits under it: --topbar-b). Below
     840px the sheet covers it (90 < the panel's 100); docked, it sits above the
     panel (see the 840px block) so its menus stay clickable over the drawer. */
  position: sticky;
  top: 0;
  z-index: 90;
}
.topbar h1 {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
  flex: none;
}
@media (prefers-reduced-transparency: reduce) {
  .topbar { background: var(--bg); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
.topbar h1 .brand-mark { width: 22px; height: 22px; flex: none; }
.brand-mark .bm-bg { fill: var(--text); }
.brand-mark .bm-cell { fill: var(--surface); }
/* One row (≥1024): the nav never shrinks below its controls (so none of them
   paints past it into the account group); the selected name is capped instead
   (.user-select max-inline-size), and the account group is what gives way — the
   pill's name ends in an ellipsis. The cap keeps the pill's glyph and a realistic
   name whole at 1024px even with "다시 연결 중…" and touch padding. */
.topbar .nav { display: flex; gap: 6px; margin-left: auto; align-items: center; flex: none; }
.topbar .topbar-account { display: flex; gap: 6px; align-items: center; min-width: 0; flex: 0 1 auto; }
/* SSOT 2026-10-23 T6 — the owner's default model / effort, one click from the top. */
/* Above the full-screen panel overlay (99) and the panel (100): the chips stay
   clickable while a session panel is open — that is when "열린 세션에도 적용" exists. */
.topbar .topbar-defaults { position: relative; z-index: 101; display: flex; gap: 6px; align-items: center; flex: none; }
.topbar .topbar-defaults[hidden] { display: none; }
/* The defaults are triggers in the library model picker's trigger shape: a neutral well, 8px, a chevron. */
.topbar .td-chip { --td-well: color-mix(in srgb, var(--ib-text) 6%, var(--ib-card)); display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 13px; font-weight: 500; color: var(--ib-text-2); background: var(--ib-seg); border: 1px solid var(--ib-card-border); border-radius: 8px; padding: 0 8px 0 10px; min-height: 30px; cursor: pointer; white-space: nowrap; transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out); }
.topbar .td-chip b { color: var(--ib-text); font-weight: 500; }
.topbar .td-chip[aria-expanded="true"] { background: var(--td-well); color: var(--ib-text); }
.topbar .td-chip:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
@media (hover: hover) and (pointer: fine) { .topbar .td-chip:hover { background: var(--td-well); color: var(--ib-text); } }
.topbar .td-caret { width: 12px; height: 12px; flex: none; color: var(--ib-muted); transition: transform var(--dur-move) var(--ease-out); }
.topbar .td-chip[aria-expanded="true"] .td-caret { transform: rotate(180deg); }
/* The menu pops from its trigger's corner (the library menu / model-picker popover): in from translateY(-4px)
   scale(.96) with opacity 160ms + transform 220ms ease-out, out in 180ms; display is discrete, so after the
   exit a closed menu takes no hits and no room. */
/* The defaults menu is @2lab.ai/ui <ui-menu id="td-menu"> (A-07): it hangs from the chip that opened it. */
#td-menu { position: absolute; }
.topbar .td-status { font-size: 12px; color: var(--text-secondary); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar .td-status.is-error { color: var(--red); }
/* Nav: the site's chip links — no box at rest, the --ib-pill chip on hover; the user
   select is a trigger (a neutral well with a hairline) because it opens a list. */
.topbar .nav a,
.topbar .nav .user-select {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 10px;
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease, transform var(--dur-press) var(--ease-out);
  min-height: 32px;
  white-space: nowrap;
  flex: none;
}
.topbar .nav a { display: inline-flex; align-items: center; gap: 6px; }
.topbar .nav a svg { width: 15px; height: 15px; flex: none; }
/* User select: a visible label sized to the selected option, with the native
   <select> laid transparently over it (it still takes every click, tap and key).
   A native select cannot show an ellipsis in WebKit — it hard-cuts the text —
   so the label carries the ellipsis and the select carries the full name in title. */
.topbar .nav .user-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: space-between; /* chevron at the right edge when the select fills the row */
  gap: 8px;
  flex: 0 1 auto;
  min-width: 0;
  max-inline-size: 180px;
  background: var(--ib-seg);
  border-color: var(--ib-card-border);
  color: var(--ib-text);
  /* WebKit counts the ellipsized label's full text in this box's scrollable
     overflow and passes it up to the page (25px of sideways scroll at 320px
     with a long name selected); nothing in here is meant to extend past it. */
  overflow: hidden;
}
/* Decorations never take a tap: the chevron's transform makes it a stacking
   context painted above the select, so without pointer-events: none a tap on
   it would land on the wrapper and the picker would not open. */
.topbar .user-select-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
.topbar .user-select::after {
  content: '';
  pointer-events: none;
  flex: none;
  inline-size: 6px;
  block-size: 6px;
  margin: -3px 2px 0;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
}
.topbar .user-select select {
  position: absolute;
  z-index: 1;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  opacity: 0;
  cursor: pointer;
  appearance: none;
  border: 0;
  font: inherit;
}
.topbar .user-select:has(select:focus-visible) { outline: 2px solid var(--border-focus); outline-offset: 1px; }
@media (hover: hover) and (pointer: fine) {
  .topbar .nav a:hover { background: var(--ib-pill); color: var(--text); }
  .topbar .nav .user-select:hover { background: color-mix(in srgb, var(--ib-text) 6%, var(--ib-card)); }
}

/* ── USER PILL — the signed-in name, links to the /login account page, rendered from /auth/me ── */
.topbar .user-pill {
  display: none; /* toggled by JS once /auth/me resolves */
  text-decoration: none;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 5px 12px 5px 8px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  min-height: 32px;
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out);
  white-space: nowrap;
  max-width: 260px;
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}
.topbar .user-pill-prefix { display: inline-flex; flex: none; color: var(--text-tertiary); }
.topbar .user-pill-prefix svg { width: 15px; height: 15px; }
.topbar .user-pill .ic-admin, .topbar .user-pill.is-admin .ic-user { display: none; }
.topbar .user-pill.is-admin .ic-admin { display: block; }
.topbar .user-pill b {
  color: var(--text);
  font-weight: 500;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
}
@media (hover: hover) and (pointer: fine) { .topbar .user-pill:hover { background: var(--ib-pill); color: var(--text); } }
.topbar .user-pill:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }

/* ── ADMIN MODE TOGGLE — visible only for ADMIN_USERS (#716) ── */
.topbar .admin-toggle {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  min-height: 32px;
  white-space: nowrap;
  flex: none;
  align-items: center;
  transition: border-color 150ms ease, color 150ms ease, background-color 150ms ease, transform var(--dur-press) var(--ease-out);
}
@media (hover: hover) and (pointer: fine) { .topbar .admin-toggle:hover { border-color: var(--ib-muted); color: var(--text); } }
/* On = a write-anything mode: the fail tint, its word pulled toward the ink (≥ 4.5:1 both themes). */
.topbar .admin-toggle[aria-pressed="true"] {
  background: var(--tint-fail-bg);
  border-color: var(--tint-fail-line);
  color: var(--tint-fail-fg);
}
@media (hover: hover) and (pointer: fine) { .topbar .admin-toggle[aria-pressed="true"]:hover { background: var(--tint-fail-bg-2); color: var(--tint-fail-fg); } }
/* The site's 34px icon button: the sun in the dark theme, the moon in the light one (the theme it switches to). */
#theme-toggle {
  display: inline-grid;
  place-items: center;
  inline-size: 34px;
  block-size: 34px;
  padding: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-secondary);
  cursor: pointer;
  flex: none;
  transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out);
}
#theme-toggle svg { width: 16px; height: 16px; }
#theme-toggle .ic-moon, [data-theme="light"] #theme-toggle .ic-sun { display: none; }
[data-theme="light"] #theme-toggle .ic-moon { display: block; }
@media (hover: hover) and (pointer: fine) { #theme-toggle:hover { background: var(--ib-pill); color: var(--text); } }
/* Live updates: a tone dot and a word (library status: never colour alone). The tone moves with
   the state in 300ms; the word is the tone mixed 70% toward the ink (≥ 4.5:1 on the bar). */
.ws-badge {
  --ws-tone: var(--text-tertiary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  color: color-mix(in srgb, var(--ws-tone) 70%, var(--text));
  white-space: nowrap;
  flex: none;
  transition: color 300ms ease, background-color 300ms ease;
}
.ws-badge::before { content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ws-tone); transition: background-color 300ms ease; }
.ws-badge[data-state="live"] { --ws-tone: var(--st-done); }
.ws-badge[data-state="reconnecting"] { --ws-tone: var(--st-wait); }

/* ── MAIN — stats strip, then the board; capped at 1280px and centred (.prd/10 §3.1-2, §5) ── */
.main { flex: 1; padding: 20px; width: 100%; max-width: 1280px; margin: 0 auto; min-width: 0; }

/* ── PERIOD SELECTOR — @2lab.ai/ui <ui-segmented> (B-02), the same control as Board | List (D-02):
   the selected period is the raised neutral chip that slides; .period-bar places it. ── */

/* ── STATS STRIP — leads the page, above the board (.prd/10 §3.1-2) ──
   One row from 640px: period · 세션 · 토큰 · 비용 · 자세히. Below 640px the
   period control and 자세히 share the first row and the numbers take the
   second. 자세히 opens the other cards and the charts under the strip. */
.stats { margin-bottom: 18px; }
.stats-strip {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas: "period nums more";
  align-items: center;
  gap: 10px 16px;
}
.stats-strip .period-bar { grid-area: period; }
.strip-nums { grid-area: nums; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; min-width: 0; }
.strip-num { display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.strip-num .label { font-size: 12px; font-weight: 500; color: var(--text-tertiary); }
.strip-num .value { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--text); font-variant-numeric: tabular-nums; }
.strip-num .no-data { color: var(--text-tertiary); }
.stats-more {
  grid-area: more;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  min-height: 32px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out);
}
.stats-more svg { width: 12px; height: 12px; flex-shrink: 0; transition: transform var(--dur-expand) var(--ease-out); }
.stats-more[aria-expanded="true"] { color: var(--text); }
.stats-more[aria-expanded="true"] svg { transform: rotate(180deg); }
.stats-detail { margin-top: 12px; }

/* ── EXPAND / COLLAPSE (P6) — the library disclosure recipe for 자세히 (.stats), 세션 정보 (.panel-info) and the
   completed goals (.cg-hx): the region is the last row of its host's grid and that row goes 0fr ↔ 1fr on
   --dur-expand (ease-out) with an opacity fade. Closed, the region is
   [hidden] + inert but still painted at 0 rows, so it leaves the way it came (세션 정보, drawn only while
   open, folds first: .xp-shut). It clips only while the row moves (.xp-moving, xpMove), so focus rings
   inside are whole once it has settled. The panel's ResizeObserver re-measures the sections on every frame
   of it (sizePanelSections). ── */
.stats, .cg-hx, .panel-info { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; align-content: start; transition: grid-template-rows var(--dur-expand) var(--ease-out); }
.cg-hx { grid-template-rows: 1fr; }
.panel-info:has(> .pi-links) { grid-template-rows: auto auto 1fr; }
.stats:has(> .stats-detail[hidden]), .panel-info.xp-shut { grid-template-rows: auto 0fr; }
.panel-info.xp-shut:has(> .pi-links) { grid-template-rows: auto auto 0fr; }
.cg-hx:has(> .cg-hx-in[hidden]), .cg-hx.xp-shut { grid-template-rows: 0fr; }
.stats-detail, .cg-hx-in, .panel-info > .pi-body { min-height: 0; transition: opacity var(--dur-expand) var(--ease-out), margin-top var(--dur-expand) var(--ease-out), visibility 0s; }
.stats-detail[hidden], .cg-hx-in[hidden] { display: block; }
.stats-detail[hidden], .cg-hx-in[hidden], .cg-hx.xp-shut > .cg-hx-in, .panel-info.xp-shut > .pi-body { opacity: 0; visibility: hidden; overflow: hidden; margin-top: 0; transition: opacity var(--dur-expand) var(--ease-out), margin-top var(--dur-expand) var(--ease-out), visibility 0s linear var(--dur-expand); }
.xp-moving > .stats-detail, .xp-moving > .cg-hx-in, .xp-moving > .pi-body { overflow: hidden; }
.usage-cb-wrap { max-width: 440px; margin-bottom: 12px; }

/* ── STATS GRID — the cards behind 자세히: 5 columns, 2 below 1100px ── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--ib-shadow);
  padding: 12px 16px;
  transition: border-color 150ms ease;
}
.stat-card .label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}
.stat-card .value {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
/* Dim placeholder values */
.stat-card .value.no-data { color: var(--text-tertiary); opacity: 0.3; font-size: 18px; }
.stat-card .delta { font-size: 12px; color: var(--green); margin-top: 2px; font-weight: 600; }
.stat-card .delta.negative { color: var(--red); }

/* ═══ AGENT INBOX BOARD (.prd/10 §3.1) ═══
   NEEDS YOU (waiting) · RUNNING (working) · DONE (idle, then closed) — the
   board and its cards are @2lab.ai/ui <ui-agent-inbox>; the rules here are the
   page around it and the open card's body (light DOM in the card's slot). */
/* The inbox is the size container for the board columns (SSOT 2026-10-24): a docked
   drawer narrows it, so the column layout follows its width, not the viewport. */
.inbox { margin-bottom: 28px; container: inbox / inline-size; }
/* Visually hidden text (screen readers only). */
.ib-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.inbox-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 16px; min-width: 0; }
.crumbs { display: flex; align-items: baseline; gap: 10px; font-size: 17px; line-height: 1.3; min-width: 0; white-space: nowrap; overflow: hidden; }
.crumbs .crumb-root, .crumbs .crumb-sep { color: var(--ib-muted); }
.crumbs .crumb-cur { color: var(--ib-text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.view-seg { flex-shrink: 0; }
/* Board header tools: Show archives, then Board | List. Below 640px the tools
   take their own row under the breadcrumb. */
.inbox-tools { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
.archives-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: var(--ib-seg);
  color: var(--ib-muted);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 10px;
  min-height: 38px;
  white-space: nowrap;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease, transform var(--dur-press) var(--ease-out);
}
.archives-btn[hidden] { display: none; }
.archives-btn svg { width: 15px; height: 15px; flex-shrink: 0; }
.archives-btn[aria-pressed="true"] { background: var(--ib-seg-on); color: var(--ib-text); box-shadow: var(--ib-shadow); }
/* Session lifecycle dialog (admin, J-01) — @2lab.ai/ui <ui-dialog size="sm">: the element draws the panel, the
   scrim, the enter / exit motion and the phone sheet; the page keeps only its form's rules.
   The artifact viewer comes and goes the same way (P6): opacity + scale(.97) on --dur-expand, its scrim a 180ms
   fade; closing, both leave in 180ms (.is-closing, dialogCloseSoftly) before close(). */
.art-modal[open]::backdrop { animation: scrim-in var(--dur-fade) var(--ease-out); }
.art-modal.is-closing { opacity: 0; transform: scale(0.98); transition: opacity var(--dur-fade) var(--ease-out), transform var(--dur-fade) var(--ease-out); }
.art-modal.is-closing::backdrop { opacity: 0; transition: opacity var(--dur-fade) var(--ease-out); }
@keyframes dlg-in { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: none; } }
@keyframes scrim-in { from { opacity: 0; } to { opacity: 1; } }
.lifecycle-dialog .lc-note { margin: 0 0 12px; font-size: 12px; color: var(--ib-muted); }
.lifecycle-dialog label { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 8px; font-size: 13px; margin-bottom: 10px; }
.lifecycle-dialog label input { grid-column: 1 / -1; font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--ib-seg); color: var(--ib-text); }
.lifecycle-dialog .lc-unit { color: var(--ib-muted); font-size: 12px; }
.lifecycle-dialog .lc-status { min-height: 1.2em; margin: 4px 0 8px; font-size: 12px; color: var(--ib-muted); }
.lifecycle-dialog .lc-status.is-error { color: var(--st-fail-text); }
.lifecycle-dialog .lc-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* The board: @2lab.ai/ui <ui-agent-inbox> (re-agent-inbox) — its columns, cards, day groups, skeletons
   and narrow / list layouts are the element's, drawn with the dashboard tokens through .ui-tok (#inbox).
   An open card's body is light DOM in the card's slot (.card-slot > .card-body), styled here. */
ui-agent-inbox.kanban, ui-agent-inbox.cron-inbox { display: block; min-width: 0; }
.col-spark { color: var(--ib-spark); display: inline-flex; flex-shrink: 0; }
.col-spark svg { width: 14px; height: 14px; }
.col-empty { text-align: center; color: var(--ib-muted); font-size: 13px; padding: 14px 8px 18px; }

/* ── Loading skeletons — the shape of what is coming, never a false "0 · Nothing
   here". The board shows them until its first answer (data-load="loading"); the
   stats values and the panel turns until theirs. Opacity pulse only (compositor),
   staggered per card; still under reduced motion. ── */
@keyframes sk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.sk { background: var(--ib-pill); border-radius: 6px; animation: sk-pulse 1.6s ease-in-out infinite; }
.board-error { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px 12px; margin: 0 0 12px; padding: 12px 16px; border-radius: 12px; background: var(--ib-col); color: var(--ib-text-2); font-size: 13px; }
.board-error[hidden] { display: none; }
/* Stats values: a bar where the number will be. */
.strip-num .is-loading, .stat-card .value.is-loading { display: inline-block; vertical-align: middle; width: 3.2em; height: 0.9em; border-radius: 6px; background: var(--ib-pill); animation: sk-pulse 1.6s ease-in-out infinite; }
.stat-card .value.is-loading { width: 64px; height: 22px; }
.chart-row.is-loading { min-height: 132px; border-radius: 8px; background: var(--ib-pill); animation: sk-pulse 1.6s ease-in-out infinite; }
.io-row.io-skel { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.io-skel .sk-line { height: 10px; }
.io-skel + .io-skel .sk { animation-delay: 120ms; }

/* The working ring (the agent tree's running icons, the panel). */
.spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--ib-pill); border-top-color: var(--st-run); border-right-color: var(--st-run); display: inline-block; animation: spin 0.9s linear infinite; }
@keyframes agPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* The open card's agent tree: @2lab.ai/ui <ui-agent-tree> (compact) in a
   frame that scrolls past a dozen rows (a wide fan-out stays a card, not a
   page); the element draws the rows, the folds, the bar and the roll-up. */
.ag-tree { display: block; margin: 12px 0 2px; padding: 10px 12px 6px; border: 1px solid var(--ib-card-border); border-radius: 10px; background: var(--ib-card); }
.ag-tree > ui-agent-tree, .pa-tree > ui-agent-tree { display: block; min-width: 0; }
.ag-tree > ui-agent-tree { max-height: 420px; overflow-y: auto; overscroll-behavior: contain; }
.at-fallback { display: block; padding: 4px 0; font-size: 12px; color: var(--ib-muted); }
.ag-icon { grid-column: 2; grid-row: 1; width: 16px; height: 16px; display: grid; place-items: center; color: var(--ag-c); }
.ag-icon svg { width: 14px; height: 14px; }
.ag-icon .ag-spinner { width: 11px; height: 11px; border-width: 1.8px; }
.ag-id { flex-shrink: 0; font-size: 11.5px; color: var(--ib-muted); font-variant-numeric: tabular-nums; }
.ag-type { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.ag-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ib-text-2); }
.ag-st { color: var(--ag-c); font-weight: 600; }
.ag-more { margin: 4px 2px 0; font-size: 12px; color: var(--ib-muted); }
/* Armed automatic resume (turn retry / goal re-check): the open card's resume
   row takes the "waiting" hue, not the run hue. */
.card-resume svg { color: var(--st-wait); }
.card-resume { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; background: var(--ib-pill); font-size: 12.5px; line-height: 1.45; color: var(--ib-text-2); }
.card-resume svg { width: 13px; height: 13px; flex-shrink: 0; margin-top: 2px; }
.card-resume .cr-when { font-weight: 600; color: var(--ib-text); }
.card-resume .cr-reason { overflow-wrap: anywhere; }

.card-body { margin: 0 14px; padding: 12px 0 14px; border-top: 1px solid var(--ib-card-border); font-size: 13px; color: var(--ib-text-2); }
/* ── CONTROL STRIP — the open card's last row (spec 13): model · effort switch · the state action · Slack · 작업 로그 ── */
.card-foot-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--ib-card-border); }
.card-foot-bar .card-actions { margin: 0 0 0 auto; }
/* SSOT 2026-10-29 T1: the open card's actions (Stop · Close · Slack) — first row under the face. */
.card-actions-bar { display: flex; justify-content: flex-end; margin: 0 0 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--ib-card-border); }
.card-actions-bar .card-actions { margin: 0; }
.cfb-model { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-width: 0; color: var(--ib-muted); font-size: 13px; }
.card-foot-bar + .cb-model-note { margin-top: 6px; }
/* ── GOAL LINE — the goal on the open card, its home is the panel (spec 13) ── */
.card-goal-line { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding: 6px 10px; border: 1px solid var(--ib-card-border); border-radius: 8px; background: var(--ib-card-dim); font-size: 12.5px; min-width: 0; }
.card-goal-line .cgl-icon { flex-shrink: 0; display: inline-flex; color: var(--ib-muted); }
.card-goal-line .cgl-icon svg, .card-goal .cg-label svg { width: 14px; height: 14px; }
.card-goal-line .cgl-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ib-text); }
.card-goal-line .cgl-text.is-muted { color: var(--ib-muted); }
.card-goal-line .cg-status { flex-shrink: 0; }
.card-goal-line .cgl-n { flex-shrink: 0; color: var(--ib-muted); font-variant-numeric: tabular-nums; }
.cgl-go, .card-more-link { flex-shrink: 0; font: inherit; font-size: 12px; color: var(--accent); background: none; border: 0; padding: 4px 2px; min-height: 28px; cursor: pointer; white-space: nowrap; }
@media (hover: hover) and (pointer: fine) { .cgl-go:hover, .card-more-link:hover { text-decoration: underline; } }
.card-more-link { display: block; margin: 4px 0 0 auto; }
.cb-ac { font-variant-numeric: tabular-nums; }
.cb-model-note { margin-top: 4px; font-size: 12px; color: var(--ib-text-2); overflow-wrap: anywhere; }
.cb-model-note.is-error { color: var(--st-fail); }
/* Model · effort beside the composer (spec 13). */
.panel-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 0 0 8px; font-size: 13px; }
.panel-controls:empty { display: none; }
.panel-controls .pc-scope { font-size: 12px; font-weight: 600; color: var(--text-tertiary); }
.panel-controls .cb-model-note { flex-basis: 100%; margin-top: 0; }
/* The model · effort trigger and its menu: @2lab.ai/ui <ui-model-picker> (re-model-picker), drawn with
   the dashboard tokens through its .ui-tok wrapper, which takes no box of its own. Until the library has
   loaded the slot reads the model's name. */
.mp-slot { display: contents; }
.mp-fallback { color: var(--ib-text); }

/* ── SHORT REFS ROW — PROJ-123 · PR-123 ── */
.card-body .card-refs {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 12px;
  color: var(--ib-muted);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-top: 6px;
  flex-wrap: wrap;
}
.card-body .card-refs a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}
.card-body .card-refs a:focus-visible { text-decoration: underline; }
.card-body .card-refs .ref-sep { color: var(--ib-muted); opacity: 0.6; }

/* ── ENV BADGE — multi-instance origin tag (#814) ── */
.card-body .card-refs .env-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 0.78em;
  font-weight: 600;
  /* The tone (--env-tone) is set inline from getEnvBadgeColor() because we hash
     the instanceName at render time; the chip is its 14% tint and the word the
     tone 70% toward the ink (≥ 4.5:1 in both themes for every palette tone). */
  background: color-mix(in srgb, var(--env-tone, var(--ib-muted)) 14%, var(--ib-card));
  color: color-mix(in srgb, var(--env-tone, var(--ib-muted)) 70%, var(--ib-text));
  vertical-align: baseline;
}
/* Token breakdown (#814, B-04) — @2lab.ai/ui <ui-tooltip variant="card">: it pops below the figure after the hover
   delay, at once on keyboard focus, and on this page a tap toggles it (initTooltipTap). */
#stat-tokens-tooltip { vertical-align: baseline; }

/* ── CONTEXT USAGE BAR ── */
.card-body .context-bar { margin-top: 8px; height: 4px; background: var(--ib-pill); border-radius: 2px; overflow: hidden; }
.card-body .context-bar-fill { width: 100%; height: 100%; border-radius: 2px; transform-origin: left center; transition: transform var(--dur-move) var(--ease-out); background: var(--st-run); }
.card-body .context-bar-fill.ctx-warn { background: var(--st-wait); }
.card-body .context-bar-fill.ctx-danger { background: var(--st-fail); }

/* ── TASK TIMELINE — dot + step + time; only the current step's dot is solid ── */
.tl-wrap { margin-top: 10px; }
.tl { list-style: none; margin: 0; padding: 0; }
.tl-item { position: relative; display: flex; gap: 10px; padding: 0 0 8px 16px; line-height: 1.4; color: var(--ib-text-2); }
.tl-item::before { content: ''; position: absolute; left: 2px; top: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--ib-muted); opacity: 0.55; }
.tl-item::after { content: ''; position: absolute; left: 4.5px; top: 15px; bottom: 1px; width: 1px; background: var(--ib-card-border); }
.tl-item:last-child { padding-bottom: 0; }
.tl-item:last-child::after { display: none; }
.tl-item.is-current { color: var(--ib-text); }
.tl-item.is-current::before { background: var(--ib-text); opacity: 1; }
.tl-item.is-pending { color: var(--ib-muted); }
.tl-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.tl-time { flex-shrink: 0; color: var(--ib-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.tl-more { font-size: 12px; color: var(--ib-muted); padding: 0 0 6px 16px; }
.tl-id { flex-shrink: 0; color: var(--ib-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.tl-tools { white-space: nowrap; }
.tl-earlier-title { margin: 8px 0 4px; font-size: 11.5px; color: var(--ib-muted); }
.tl-earlier .tl-item { color: var(--ib-muted); }
.tl-toggle { margin-top: 6px; font: inherit; font-size: 12px; color: var(--ib-text-2); background: none; border: 1px solid var(--ib-card-border); border-radius: 6px; padding: 3px 10px; min-height: 28px; cursor: pointer; }
.spin { display: inline-block; animation: spin 0.9s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* ── INSTRUCTION / RESPONSE — latest pair, lazy-loaded on expand ── */
.card-io { margin-top: 12px; display: grid; gap: 6px; }
.io-row { border-radius: 8px; padding: 8px 10px; background: var(--ib-col); min-width: 0; }
.io-label { font-size: 11px; font-weight: 600; color: var(--ib-muted); margin-bottom: 3px; display: flex; gap: 6px; align-items: baseline; }
.io-label .io-who { font-weight: 500; letter-spacing: 0; }
.io-label .io-who.is-sys { color: var(--text-tertiary); }
.io-text { font-size: 13px; line-height: 1.45; color: var(--ib-text); white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
.io-text .io-title { font-weight: 600; }
.io-text.is-muted, .io-muted { color: var(--ib-muted); }
.card-io .io-sys::part(summary) { padding: 3px 6px; font-size: 12.5px; font-weight: 400; color: var(--ib-text-2); }
.io-sys-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-io .sys-detail { margin: 6px 0 0; }
.card-io .skill-badges { margin-top: 4px; }
.io-cp { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 22px; font-size: 12.5px; color: var(--ib-text-2); }

/* ── ACTION BUTTONS — secondary outline + one solid primary (reference "Approve") ── */
.card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; justify-content: flex-end; }
/* SSOT 2026-10-30 — ★ Star (pressed = amber) and 살리기 (the run tint), on the kit button. */
.ui-btn[data-action="star"][aria-pressed="true"] { color: var(--st-wait); border-color: var(--st-wait); }
.ui-btn[data-action="revive"] { color: var(--st-run); }

/* ── GOAL LIST (work item, SSOT 2026-10-21 T2/T3) ── */
.card-goal {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ib-card-border);
  border-radius: 8px;
  background: var(--ib-card-dim);
  font-size: 12.5px;
}
.card-goal .cg-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.card-goal .cg-label { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--ib-text); }
.card-goal .cg-label svg { color: var(--ib-muted); }
.card-goal .cg-progress { margin-left: auto; color: var(--ib-muted); font-variant-numeric: tabular-nums; }
.card-goal .cg-objective {
  color: var(--ib-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-goal .cg-gap { margin-top: 3px; color: var(--ib-muted); overflow-wrap: anywhere; }
.card-goal .cg-more { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; margin-top: 2px; padding: 0; font: inherit; font-size: 11.5px; color: var(--ib-text-2); background: none; border: 0; cursor: pointer; }
@media (hover: hover) and (pointer: fine) { .card-goal .cg-more:hover { color: var(--ib-text); text-decoration: underline; } }
.card-goal .cg-more:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; border-radius: 6px; }
.card-goal .cg-more[hidden] { display: none; }
.card-goal .cg-empty { color: var(--ib-muted); }
.card-goal .cg-row { display: flex; align-items: flex-start; gap: 6px; }
.card-goal .cg-row > :first-child { flex: 1; min-width: 0; }
.card-goal .cg-queue-title { margin-top: 8px; color: var(--ib-muted); font-size: 11.5px; }
.card-goal .cg-queue { list-style: decimal; margin: 2px 0 0 18px; }
.card-goal .cg-queue li { padding: 2px 0; }
.card-goal .cg-q-text { overflow-wrap: anywhere; color: var(--ib-text); }
.card-goal .cg-history-toggle { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; font: inherit; font-size: 11.5px; color: var(--ib-text-2); background: none; border: 1px solid var(--ib-card-border); border-radius: 6px; padding: 2px 8px; min-height: 26px; cursor: pointer; white-space: nowrap; }
.card-goal .cg-progress + .cg-history-toggle { margin-left: 8px; }
.card-goal .cg-history { list-style: none; margin: 4px 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.card-goal .cg-h-item { border-left: 2px solid var(--st-done); padding: 2px 0 2px 8px; }
.card-goal .cg-h-obj { color: var(--ib-text); overflow-wrap: anywhere; }
.card-goal .cg-h-meta { margin-top: 2px; color: var(--ib-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.card-goal .cg-h-reason { margin-top: 2px; color: var(--ib-text-2); font-size: 11.5px; overflow-wrap: anywhere; }
.card-goal .cg-add { display: flex; gap: 6px; margin-top: 8px; }
.card-goal .cg-add-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 12.5px;
  padding: 4px 8px;
  border: 1px solid var(--ib-card-border);
  border-radius: 6px;
  background: var(--ib-card);
  color: var(--ib-text);
}
.card-goal .cg-add-input:focus { outline: none; border-color: var(--border-focus); }
.card-goal .cg-error { margin-top: 6px; color: var(--st-fail); overflow-wrap: anywhere; }

/* ── PENDING QUESTION (dashboard choice buttons) ── */
.card-question {
  margin-top: 8px;
  padding: 8px;
  background: var(--tint-wait-soft);
  border: 1px solid var(--tint-wait-line);
  border-radius: 8px;
}
.card-question-text {
  font-size: 0.78em;
  color: var(--tint-wait-fg);
  font-weight: 600;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.card-question-multi {
  font-size: 0.72em;
  color: var(--text-secondary);
  margin-top: 4px;
}
.card-question-multi a {
  color: var(--accent);
  text-decoration: none;
}
@media (hover: hover) and (pointer: fine) { .card-question-multi a:hover { text-decoration: underline; } }
/* The multi-question form inside an open card (renderMultiChoiceCard): its
   title, progress and 답변하기, in the card's own button language. The
   single-choice question and the permission prompts are <ui-approval-card>s,
   which draw their own answers. */
.card-body .card-question { margin-top: 12px; padding: 10px 12px; background: var(--ib-col); border: 0; border-radius: 8px; }
.card-body .card-question-text { font-size: 13px; color: var(--ib-text); margin-bottom: 8px; }
.card-body .card-question-multi { font-size: 12px; color: var(--ib-muted); }
/* D10: one primary per open card — the owner's 답변하기 on this instance is the kit's ink button. */
.card-body .card-mc-go { width: 100%; margin-top: 8px; }
.card-question-na { color: var(--text-secondary); }

/* ── PANEL PENDING QUESTION ── */
.panel-permission { padding: 0 16px 12px; border-bottom: 1px solid var(--border); }
/* The question under 입력 필요: a <ui-approval-card> (data-ap="card") or the
   <ui-choice-form> (data-ap="form") — each draws its own card. */
.panel-question { padding: 0 16px 12px; border-bottom: 1px solid var(--border); }
.panel-question .mc-failed { padding: 8px 0; color: var(--st-fail-text); font-size: 13px; }

/* ── 입력 필요 (re-agent-run D8–D17) ──
   A head with the count; each prompt (and the single-choice question) is a
   <ui-approval-card> in its slot (.ac-slot) — the card's own look is the
   library's. No new tokens. */
.ar-vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
/* D3 E-13: the head is the kit's section head (.ui-section-head) with its count badge (.ui-count, wait tone,
   the arrival pop on [data-pop]); the page adds its padding and keeps the focus ring inside the scroll box. */
.panel-needs-head { padding: 12px 16px 8px; }
.panel-needs-head[hidden] { display: none; }
.panel-needs-head:focus-visible { outline-offset: -2px; }
/* One section: no rule between a prompt and the question card under it. */
.panel-permission:has(+ .panel-question[data-ap="card"]:not([style*="none"])) { border-bottom: 0; }
/* The <ui-approval-card> slots (batch 1): a gap between two prompts, and the open card's off what follows. */
.ac-slot + .ac-slot { margin-top: 10px; }
.card-body > .ac-slot { margin-bottom: 10px; }

/* ── CHARTS — flat, geometric ── */
.chart-row { display: flex; gap: 10px; margin-bottom: 16px; }
.chart-container {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--ib-shadow);
  padding: 12px 16px;
}
.chart-container h4 { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; }
.bar-chart { display: flex; align-items: flex-end; gap: 2px; height: 80px; }
.bar { background: var(--accent); border-radius: 3px 3px 0 0; min-width: 4px; flex: 1; transition: height var(--dur-move) var(--ease-out), opacity 150ms ease; }
@media (hover: hover) and (pointer: fine) { .bar:hover { opacity: 0.75; } }
/* Each bar is the trigger of its own <ui-tooltip> (B-08): the element takes the bar's flex share and full height. */
.bar-chart > ui-tooltip { display: block; flex: 1; min-width: 4px; height: 100%; }
.bar-chart > ui-tooltip::part(root) { height: 100%; align-items: flex-end; }
.bar-labels { display: flex; gap: 2px; margin-top: 4px; }
.bar-labels span { flex: 1; text-align: center; font-size: 10px; color: var(--text-tertiary); font-weight: 500; font-variant-numeric: tabular-nums; }

/* ── SLIDE PANEL — flat, structured, resizable ── */
/* SSOT 2026-10-24 — a full-screen sheet below 840px, docked beside the board from
   840px (the Drawer media blocks below). Hidden by a transform, so its width is
   CSS-only: JS stores a width preference (--panel-w-pref) and never writes the
   width or the right offset. It follows the visual viewport (--pv-h / --pv-t,
   syncPanelViewport) so the composer stays above the on-screen keyboard. */
.slide-panel {
  position: fixed;
  top: var(--pv-t, 0px); right: 0;
  width: var(--panel-w, 440px);
  height: 100vh;
  height: var(--pv-h, 100dvh);
  padding-right: env(safe-area-inset-right, 0px);
  background: var(--surface);
  border-left: 1px solid var(--border);
  z-index: 100;
  transform: translateX(100%);
  visibility: hidden;
  transition: transform var(--dur-move) var(--ease-out), visibility 0s linear var(--dur-move);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.slide-panel.open { transform: none; visibility: visible; transition: transform var(--dur-move) var(--ease-out); }
.slide-panel.resizing { transition: none; user-select: none; }
/* Resize handle — left edge */
.panel-resize-handle {
  position: absolute;
  top: 0; left: 0;
  width: 8px; height: 100%;
  cursor: col-resize;
  touch-action: none;
  z-index: 101;
  background: transparent;
  transition: background-color 150ms ease, opacity 150ms ease;
}
.panel-resize-handle.active { background: var(--ib-muted); opacity: 0.35; }
@media (hover: hover) and (pointer: fine) { .panel-resize-handle:hover { background: var(--ib-muted); opacity: 0.35; } }
/* Panel tasks (.prd/10 §3.1-6) — pinned between the token badges and the
   scroll area: always shown (an empty line when there are none yet), with its
   own scroll so a long list never pushes the work log and turns away. */
/* Agent section (.prd/12 §4.3, rev 2): a drill-down over the same tree — the
   path to the focused node, its header (the root's too), its subtree. */
.panel-agents { flex: none; padding: 6px 16px 8px; border-bottom: 1px solid var(--border); }
.pa-bar { display: flex; align-items: center; gap: 8px; min-height: 32px; min-width: 0; }
.pa-path { display: flex; align-items: center; gap: 2px; flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 13px; }
.pa-crumb { min-width: 0; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 6px; border: 0; border-radius: 6px; background: none; color: var(--text-secondary); font: inherit; cursor: pointer; }
.pa-crumb:first-child { flex-shrink: 0; }
.pa-crumb[aria-current="page"] { color: var(--text); font-weight: 600; cursor: default; }
.pa-crumb:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.pa-sep { flex-shrink: 0; color: var(--text-tertiary); }
.pa-focus { --ag-c: var(--text-tertiary); margin-top: 2px; border-radius: 6px; outline: none; }
.pa-focus:focus-visible { box-shadow: 0 0 0 2px var(--border-focus); }
.pa-name { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 14px; line-height: 1.35; }
.pa-name .ag-type { font-weight: 650; }
.pa-name .ag-id { font-size: 12px; }
.pa-tree { display: block; }
.pa-sum { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 7px; margin-top: 4px; font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.pa-dot { color: var(--text-tertiary); }
.pa-desc { margin-top: 2px; font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-desc .pa-act { color: var(--text-tertiary); }
.tasks-scope { font-weight: 600; color: var(--text); }
/* A child's block in its parent's log: the same node at row density. */
/* Panel body (task view, SSOT 2026-10-27): one scroll area between the head and
   the composer — the task's common surface, then the agent tabs (sticky at its
   top while the conversation scrolls) and the focused agent's tab. Nothing is
   pinned inside it, so a short screen gives the conversation every row. */
.panel-body {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  container: pbody / size;
  overflow: hidden;
}
/* The common surface (T1.1): 세션 정보 · goal · 입력 필요 · 산출물 as one grouped block. */
.panel-surface { border-bottom: 1px solid var(--border); background: var(--surface); }
.panel-surface > .panel-info, .panel-surface > .panel-goal, .panel-surface > .panel-permission, .panel-surface > .panel-artifacts { border-bottom: 0; }
.panel-surface > :not([hidden]):not([style*="display:none"]):not([style*="display: none"]) + :not([hidden]) { border-top: 1px solid var(--border); }
/* Agent tabs (T1.2): a segmented strip that scrolls sideways; Main stays at its
   left edge, the strip at the top of the scroll area. */
.panel-tabs {
  position: sticky;
  top: 0;
  z-index: 6;
  display: flex;
  gap: 4px;
  padding: 8px 16px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--border);
}
.panel-tabs::-webkit-scrollbar { display: none; }
.panel-tab {
  --ag-c: var(--text-tertiary);
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  min-height: 30px;
  padding: 4px 12px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out);
}
.panel-tab .pt-name { overflow: hidden; text-overflow: ellipsis; }
.panel-tab .pt-type { font-weight: 500; color: var(--text-tertiary); }
.panel-tab .ag-icon { display: inline-grid; place-items: center; width: 14px; height: 14px; color: var(--ag-c); }
.panel-tab .ag-icon svg { width: 12px; height: 12px; } .panel-tab .ag-icon .spinner { width: 10px; height: 10px; }
.panel-tab.is-running { --ag-c: var(--st-run); } .panel-tab.is-completed { --ag-c: var(--st-done); } .panel-tab.is-failed { --ag-c: var(--st-fail); } .panel-tab.is-waiting { --ag-c: var(--st-wait); }
.panel-tab[aria-selected="true"] { background: var(--ib-pill); color: var(--text); }
.panel-tab[aria-selected="true"] .pt-type { color: var(--text-secondary); }
.panel-tab:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.panel-tab.is-main {
  position: sticky;
  left: 0;
  z-index: 1;
  box-shadow: 8px 0 8px -6px color-mix(in srgb, var(--surface) 90%, transparent);
}
.panel-tab.is-main:not([aria-selected="true"]) { background: var(--surface); }
.panel-tabpanel { outline: none; }
/* A section head (T1.3): title · a one-line summary · chevron. Tasks and 지시와
   답변 share it; 작업 로그 keeps its own head (same look). */
.panel-sec-head {
  font: inherit;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 4px 0;
  border: 0;
  background: none;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}
.ps-sec-title { flex: none; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.ps-sec-sum { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.ps-sec-now { display: inline-flex; align-items: center; gap: 4px; color: var(--text); font-weight: 600; }
.ps-sec-now .spinner { width: 10px; height: 10px; }
.panel-sec-head .pi-chev { flex: none; width: 12px; height: 12px; transition: transform var(--dur-expand) var(--ease-out); }
.panel-sec-head[aria-expanded="true"] .pi-chev { transform: rotate(180deg); }
@media (hover: hover) and (pointer: fine) { .panel-sec-head:hover .ps-sec-title { color: var(--text); } }
.panel-sec-head:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; border-radius: 6px; }
.panel-tasks {
  padding: 4px 16px;
  border-bottom: 1px solid var(--border);
  outline: none;
}
.panel-tasks-body { padding: 2px 0 6px; }
/* Section tabs (SSOT 2026-10-29): 에이전트 트리 · 작업 로그 · 지시와 답변 — each its own
   scroll box (the reader's place is per tab), sized by sizePanelSections to the rest
   of the panel; the active one is the only one painted. */
.panel-sections { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.psec-tab { flex: 1 1 0; min-width: 0; min-height: 38px; padding: 6px 8px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-secondary); font: inherit; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: color 150ms ease, border-color 150ms ease, transform var(--dur-press) var(--ease-out); }
@media (hover: hover) and (pointer: fine) { .psec-tab:hover { color: var(--text); } }
.psec-tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--text); }
.psec-tab:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; border-radius: 6px; }
/* SSOT 2026-10-29 T6: Chat · 작업 로그 on the left at their own width; 에이전트 트리 at the right end. */
.panel-sections .psec-tab { flex: 0 1 auto; padding: 6px 12px; }
.panel-sections .psec-tab-tree { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-weight: 500; }
.psec-tab-tree svg { width: 13px; height: 13px; flex: none; }
.panel-sections-body { position: relative; height: 60vh; min-height: 160px; }
.psec { position: relative; height: 100%; overflow-y: auto; scroll-behavior: auto; outline: none; overflow-anchor: none; }
/* D3 E-25 — a section a library element draws is its own scroll box (<ui-conversation>'s
   <ui-log-scroller>: the pin, the older-page row, the kept place, the new-items pill):
   the panel's box only gives it the height. */
.psec.psec-el { overflow: hidden; display: flex; flex-direction: column; }
.psec-el > * { flex: 1 1 auto; min-height: 0; }
.psec-el > ui-conversation, .psec-el > ui-work-log { padding: 4px 8px 0; }
.cv-arts-slot .turn-arts-row { margin-top: 2px; }
.psec[hidden] { display: none; }
.psec:focus-visible { box-shadow: inset 0 0 0 2px var(--border-focus); }
.psec-older { display: block; margin: 10px auto 2px; padding: 5px 14px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
@media (hover: hover) and (pointer: fine) { .psec-older:hover { color: var(--text); border-color: var(--text-tertiary); } }
.psec-older:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.psec-older[aria-busy="true"] { cursor: progress; font-style: italic; color: var(--text-tertiary); }
.psec-start { margin: 12px 0 2px; text-align: center; font-size: 11.5px; color: var(--text-tertiary); }
.psec-older[hidden], .psec-start[hidden], .psec-pill[hidden] { display: none; }
.psec-empty { margin: 24px 16px; text-align: center; font-size: 12px; color: var(--text-tertiary); }
.psec-pill { position: absolute; left: 50%; bottom: 12px; z-index: 4; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 4px; min-height: 32px; padding: 4px 14px; border: 1px solid var(--ib-text); border-radius: 999px; background: var(--ib-text); color: var(--ib-card); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; box-shadow: var(--ib-shadow-raised); }
.psec-pill:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.panel-tree { padding: 6px 16px 12px; }
/* 자세히 (T1.6) — a button that behaves like a toggle (HIG Toggles: outside a list,
   not a switch; the background tells the state); the panel's class gates the
   detail-only parts. */
.panel-detail-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 11px 0 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out);
}
.pdt-icon { width: 14px; height: 14px; flex: none; }
.panel-detail-toggle[aria-pressed="true"] { background: var(--ib-pill); border-color: var(--ib-muted); color: var(--text); }
.panel-detail-toggle:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
/* Minimal by default: the agent path, the subtree and the main agent's own
   header are for 자세히 — the tabs already say where the reader is. */
.slide-panel:not(.is-detail) .pa-bar,
.slide-panel:not(.is-detail) .panel-agents.is-main { display: none !important; }
.slide-panel:not(.is-detail) .panel-arts-hint { display: none; }
.slide-panel:not(.is-detail) .panel-goal.is-empty { display: none !important; }
.panel-tasks-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-tasks-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
  padding: 4px 0;
  user-select: none;
  border: none;
  background: none;
  font-weight: 600;
}
@media (hover: hover) and (pointer: fine) { .panel-tasks-toggle:hover { text-decoration: underline; } }
/* ── PLAN + RUNS (D3 E-22/E-23) — the open Tasks section: <ui-task-runs> (the tasks that ran) and
   <ui-task-plan> (the plan left, the tasks dropped before they ran) draw themselves; the page keeps the
   older-runs toggle and the sums under them. ── */
.panel-tasks-body > ui-task-runs, .panel-tasks-body > ui-task-plan { display: block; min-width: 0; }
.panel-tasks-body > ui-task-runs + ui-task-plan { margin-top: 10px; }
.tr-total { display: flex; gap: 8px; align-items: baseline; margin: 6px 0 2px; padding-top: 6px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.tr-total + .tr-total { margin-top: 0; padding-top: 0; border-top: 0; }
.tr-total-k { flex: none; font-weight: 600; color: var(--text-tertiary); }
.pl-fold { padding: 0 0 4px; }
/* Panel work log (.prd/10 §3.1-6, §3.3) — what the agent did, in order: the
   작업 로그 section tab, scrolled by its section box (newest at the bottom). */
/* SSOT 2026-10-22 T10 — entries folded under the task they were made in. */
/* Each entry = a row (role=button: click, Enter or Space opens its raw output
   below it) + its detail block. */
.wl-tool-name { color: var(--text); font-weight: 600; flex-shrink: 0; }
/* A tool call and its result: one @2lab.ai/ui <ui-tool-call-card>, drawn with
   the dashboard's own tokens: each --ui-* the element reads is set here, on the
   wrapper, from the same-named dashboard token. Not on the element itself — its
   shadow :host defines --border: var(--ui-border, …), so --ui-border: var(--border)
   on the same element is a cycle and blanks both. Inherited from the wrapper,
   the values arrive already resolved and follow the theme switch. The same
   mapping serves every other library element's wrapper (.ui-tok: the approval
   cards, the toaster, the usage breakdown). */
.ui-tok {
  --ui-bg: var(--bg); --ui-surface: var(--surface); --ui-surface-raised: var(--surface-raised);
  --ui-border: var(--border); --ui-border-focus: var(--border-focus); --ui-text: var(--text);
  --ui-text-secondary: var(--text-secondary); --ui-text-tertiary: var(--text-tertiary); --ui-accent: var(--accent);
  --ui-accent-hover: var(--accent-hover); --ui-green: var(--green); --ui-yellow: var(--yellow); --ui-red: var(--red);
  --ui-purple: var(--purple); --ui-orange: var(--orange); --ui-ib-col: var(--ib-col); --ui-ib-card: var(--ib-card);
  --ui-ib-card-dim: var(--ib-card-dim); --ui-ib-card-border: var(--ib-card-border); --ui-ib-pill: var(--ib-pill);
  --ui-ib-text: var(--ib-text); --ui-ib-text-2: var(--ib-text-2); --ui-ib-muted: var(--ib-muted);
  --ui-ib-seg: var(--ib-seg); --ui-ib-seg-on: var(--ib-seg-on); --ui-ib-spark: var(--ib-spark);
  --ui-ib-shadow: var(--ib-shadow); --ui-ib-shadow-raised: var(--ib-shadow-raised); --ui-st-wait: var(--st-wait);
  --ui-st-run: var(--st-run); --ui-st-done: var(--st-done); --ui-st-fail: var(--st-fail);
  --ui-st-fail-text: var(--st-fail-text); --ui-ease: var(--ease); --ui-ease-out: var(--ease-out);
  --ui-ease-in-out: var(--ease-in-out); --ui-dur-press: var(--dur-press); --ui-dur-expand: var(--dur-expand);
  --ui-dur-move: var(--dur-move); --ui-dur-fade: var(--dur-fade); --ui-radius: var(--radius);
  --ui-font: var(--font); --ui-mono: var(--mono);
}
.worklog-list ui-tool-call-card { display: block; min-width: 0; }
.wl-card-fallback {
  display: block; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px;
  font-family: var(--mono); font-size: 11.5px; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.slide-panel-overlay {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  background: var(--scrim);
  z-index: 99;
  display: none;
  opacity: 0;
  transition: opacity var(--dur-fade) var(--ease-out), display var(--dur-fade) allow-discrete;
}
.slide-panel-overlay.open { display: block; opacity: 1; }
@starting-style { .slide-panel-overlay.open { opacity: 0; } }
.panel-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-header h3 {
  flex: 1;
  font-size: 13px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel-header { flex-wrap: wrap; row-gap: 8px; }
/* ── DETAIL DECK (SSOT 2026-10-29 T2) — every open card's detail card; the ones
   waiting behind the front card show their top edges above it, and ‹ n / m ›
   in the top right go through them. ── */
.panel-deck-peek { display: none; flex: none; flex-direction: column; align-items: center; padding-top: 8px; background: var(--bg); }
.slide-panel:not([data-deck="0"]) .panel-deck-peek { display: flex; }
.panel-deck-peek span { display: block; height: 7px; border: 1px solid color-mix(in srgb, var(--text-tertiary) 45%, var(--border)); border-bottom: 0; border-radius: 10px 10px 0 0; background: color-mix(in srgb, var(--surface) 70%, var(--bg)); }
.panel-deck-peek span:first-child { width: calc(100% - 48px); opacity: 0.75; }
.panel-deck-peek span:last-child { width: calc(100% - 24px); }
.slide-panel[data-deck="1"] .panel-deck-peek span:first-child { display: none; }
.slide-panel:not([data-deck="0"]) .panel-header { border-top: 1px solid color-mix(in srgb, var(--text-tertiary) 45%, var(--border)); border-radius: 10px 10px 0 0; background: var(--surface); box-shadow: 0 -4px 10px -6px var(--scrim); }
/* D3 E-05: ‹ n / m › is <ui-deck-nav> (its own pill, 44px on coarse pointers); the edges behind stay the page's
   (.panel-deck-peek above the header — the element's peek sits under its own nav). */
.panel-deck { flex: none; }
.panel-deck[hidden] { display: none; }
/* The subtitle is one line that ellipsizes: squeezed beside the nav it stacked one or two characters a line
   (phones also drop 자세히's word while the deck is shown — the phone block below). */
#panel-title-sub-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The deck switch (renderDeckNav → deckSlide) is WAAPI, not keyframes: the header and body glide in from
   the side the new front card came from, added onto whatever is still running — a quick second switch
   retargets from where they are drawn instead of restarting. Under reduced motion there is no slide. */
/* ── SESSION HEAD — the panel head (spec 13, D3 E-08): <ui-status-bar> draws status · time · Slack · actions
   (44px targets on coarse pointers, reduced motion); the page adds only an armed resume in its slot. ── */
.panel-status { flex-basis: 100%; min-width: 0; }
.ps-resume { min-width: 0; font-size: 12px; color: var(--st-wait); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ── 세션 정보 — one summary line + the links; opened, every number (spec 13) ── */
.panel-info { padding: 6px 16px 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-secondary); }
.panel-info:empty { display: none; }
.pi-head { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 2px 0; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.pi-title { flex-shrink: 0; font-size: 12px; font-weight: 600; color: var(--text-tertiary); }
.pi-sum { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.pi-dot { margin: 0 5px; color: var(--text-tertiary); }
.pi-chev { flex-shrink: 0; width: 14px; height: 14px; color: var(--text-tertiary); transition: transform var(--dur-press) var(--ease-out); }
.pi-head[aria-expanded="true"] .pi-chev { transform: rotate(180deg); }
.pi-head:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; border-radius: 6px; }
.pi-links { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 2px; }
.pi-links a { font-weight: 600; color: var(--accent); text-decoration: none; min-height: 24px; display: inline-flex; align-items: center; min-width: 0; overflow-wrap: anywhere; }
.pi-links a:focus-visible { text-decoration: underline; }
@media (hover: hover) and (pointer: fine) { .pi-links a:hover { text-decoration: underline; } }
.pi-body { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.pi-muted { color: var(--text-tertiary); font-weight: 400; }
/* 세부 (re-agent-run D19): label left, value right. */
/* 세부 and the token rows are the kit's fact list (.ui-dl, D3 E-10 — the disclosure itself stays: see D3-GAPS G6-2). */
.pi-thread { font-variant-numeric: tabular-nums; }
.pi-resume { color: var(--st-wait); overflow-wrap: anywhere; }
/* The summary line's ctx % carries the context level (re-context-window D16). */
.pi-cs.ctx-warn { color: var(--cw-warn); }
.pi-cs.ctx-danger { color: var(--st-fail-text); font-weight: 600; }
/* The summary's ctx % in amber: the light theme's darker yellow keeps it at 4.5:1. */
:root { --cw-warn: var(--st-wait); }
[data-theme="light"] { --cw-warn: var(--yellow); }
/* ── 컨텍스트 (.prd/affectui/re-context-window.md D5–D19): @2lab.ai/ui <ui-context-window>
   in its token wrapper, first in 세션 정보's open body, at the panel's 560px measure. ── */
.cw-slot > ui-context-window { display: block; max-width: 560px; }
.cw-fallback { font-size: 12.5px; color: var(--text-tertiary); }
/* ── GOAL — the editor's home (spec 13) ── */
.panel-goal { padding: 8px 16px; border-bottom: 1px solid var(--border); outline: none; }
.panel-goal .card-goal { margin-top: 0; }
/* The goal's home opens the objective folded to its first 3 lines on every opening
   (SSOT 2026-10-29, the card's line is the summary); 펼치기 shows all of it. */
.panel-goal .card-goal .cg-objective { -webkit-line-clamp: 3; line-height: 1.45; }
.panel-goal .card-goal.is-open .cg-objective { display: block; -webkit-line-clamp: unset; overflow: visible; }
.panel-goal:focus-visible { box-shadow: inset 0 0 0 2px var(--border-focus); }
/* Scroll container: the common surface (large UIAskQ choices included), the
   agent tabs, Tasks and the section tabs scroll together; each section scrolls
   in its own box inside it, and .panel-command stays pinned below. */
.panel-scroll { flex: 1 1 auto; overflow-y: auto; scroll-behavior: smooth; min-height: 0; }
/* P8: the text triangles are the icon set's chevron (16 grid, 1.5 stroke, round caps), drawn as a mask so
   it takes currentColor; .chev points down, .is-up / .is-right turn it, and a toggle's aria-expanded
   turns it open. */
:root { --chev: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E"); }
.chev { display: inline-block; flex-shrink: 0; width: 12px; height: 12px; vertical-align: -2px; background: currentColor; -webkit-mask: var(--chev) center / contain no-repeat; mask: var(--chev) center / contain no-repeat; transition: transform var(--dur-press) var(--ease-out); }
.chev.is-up, [aria-expanded="true"] > .chev { transform: rotate(180deg); }
.chev.is-right { transform: rotate(-90deg); }
/* The kit chip (.ui-chip) with its kind's colour on the word and the hairline. */
.sys-badge { flex: none; }
.sys-badge[data-kind="compact"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.sys-badge[data-kind="restart"], .sys-badge[data-kind="retry"] { color: var(--orange); border-color: color-mix(in srgb, var(--orange) 45%, transparent); }
.sys-badge[data-kind="goal"] { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 45%, transparent); }
.sys-badge[data-kind="cron"] { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.sys-badge[data-kind="bgwork"] { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); }
.sys-line { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-slot { display: contents; }
/* A narrow panel (phones): the bar's shrink weight (1000) dwarfs the line's (1),
   so the bar gives way first, then the line truncates from its end. Weights
   stay ≥ 1: below 1 the flex algorithm hands out only that fraction of the
   space and the row would overflow. */
.cp-time { flex: none; white-space: nowrap; }
.cp-over { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-bar { flex: 0 1000 120px; min-width: 0; max-width: 120px; height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
.cp-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 1s linear; }
.cp-bar.is-over > i { width: 100% !important; background: linear-gradient(90deg, transparent, var(--accent), transparent) no-repeat; background-size: 40% 100%; animation: cp-over 1.4s linear infinite; }
@keyframes cp-over { from { background-position: -40% 0; } to { background-position: 140% 0; } }
.cp-pct { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; }
.sys-detail { margin: 6px 0 4px; padding: 8px 10px; border-radius: 8px; background: var(--surface-raised); }
.sys-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 12px; margin: 0 0 8px; font-size: 12px; }
.sys-facts dt { color: var(--text-tertiary); }
.sys-facts dd { margin: 0; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.sys-raw-h { margin-bottom: 4px; font-size: 11px; color: var(--text-tertiary); }
.sys-raw, .skill-body { margin: 0; max-height: 320px; overflow: auto; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text-secondary); font: 11.5px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; }
/* T5 — the skills an instruction invoked: badges (name · estimated tokens) under its words. */
.skill-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.skill-badge { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; transition: background-color var(--dur-press) ease, border-color var(--dur-press) ease; }
@media (hover: hover) and (pointer: fine) { .skill-badge:hover { background: var(--ib-pill); } }
.skill-badge:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.skill-badge[aria-expanded="true"] { background: var(--ib-pill); border-color: var(--ib-muted); }
.skill-tok { color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.skill-detail { margin-top: 6px; }
.skill-detail-h { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; font-size: 12px; }
@media (pointer: coarse) { .skill-badge { min-height: 44px; } }
/* Slack link on cards */
.slack-link { color: var(--accent); text-decoration: none; font-size: 0.85em; margin-left: 4px; opacity: 0.7; }
@media (hover: hover) and (pointer: fine) { .slack-link:hover { text-decoration: underline; opacity: 1; } }
/* PR status badges */
.card-body .card-links .pr-badge { display: inline-block; padding: 1px 5px; border-radius: 6px; font-size: 10px; font-weight: 700; margin-left: 3px; text-transform: uppercase; letter-spacing: 0.03em; }
.card-body .card-links .pr-open { background: color-mix(in srgb, var(--accent) 14%, var(--ib-card)); color: color-mix(in srgb, var(--accent) 70%, var(--ib-text)); }
.card-body .card-links .pr-merged { background: color-mix(in srgb, var(--purple) 14%, var(--ib-card)); color: color-mix(in srgb, var(--purple) 70%, var(--ib-text)); }

/* ── COMMAND INPUT — flat ── */
.panel-command {
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}
/* The composer is <ui-agent-steering> (batch 2): its field, Send, queue and key
   hints are the element's; these are the page's slotted tools and chips. A file
   dragged over the composer outlines it. */
.pc-steer-wrap { display: block; min-width: 0; border-radius: 12px; }
.panel-command.is-drag .pc-steer-wrap { outline: 2px dashed var(--accent); outline-offset: 2px; }
.pc-tools { display: flex; align-items: center; gap: 2px; flex: none; }
.pc-tool-mic[aria-pressed="true"] { color: var(--st-fail); }
.pc-attachments { display: flex; gap: 8px; overflow-x: auto; padding: 0 0 8px; }
.pc-attachments:empty { display: none; }
.pc-recorder { margin: 0 0 8px; }
.pc-error { margin: 0 0 6px; font-size: 12px; color: var(--st-fail); }


/* ── PRESS — buttons and segments give 0.97 feedback (§4-5), pointer presses only:
   a keyboard-focused control matches :focus-visible, so Space/Enter never scale it (§4-9). ── */
/* PRESS — one rule for every button-like control: scale(.97) on --dur-press ease-out (each control's own
   transition carries the transform), pointer presses only — never a keyboard press (:focus-visible). The
   56px FAB presses to .95. */
:is(.archives-btn, .topbar .nav a, .topbar .td-chip, .topbar .user-pill, .topbar .admin-toggle, #theme-toggle, .stats-more, .panel-detail-toggle, .panel-tab, .psec-tab, .nt-rec-btn, .art-chip, .art-open, .art-play, .um-tile, .um-open):active:not(:disabled):not(:focus-visible) { transform: scale(0.97); }

/* ── HOVER — pointer devices only; colour/border, never movement (§4-6) ── */
@media (hover: hover) and (pointer: fine) {
  .archives-btn:hover { color: var(--ib-text); }
  .stats-more:hover { background: var(--surface-raised); color: var(--text); }
  .card-body .card-refs a:hover { text-decoration: underline; }
}

/* ── BOARD RESPONSIVE (.prd/10 §5, SSOT 2026-10-24) ──
   The columns follow the inbox's own width (container query): ≥840 three columns
   that always fit · <840 the three columns scroll sideways inside the board (the
   page itself never scrolls horizontally). <640 viewport: List by default, 44px
   taps. A docked drawer narrows the inbox, so this is not a viewport query. */
@media (max-width: 1023px) {
  /* Top bar: brand · status · account on the first row, the nav on its own row below, full labels. */
  .topbar { flex-wrap: wrap; padding: 8px 20px; row-gap: 8px; }
  /* Basis 0: the account group never pushes itself onto a row of its own — a
     long name ends in an ellipsis inside the pill instead. */
  .topbar .topbar-account { flex: 1 1 0; justify-content: flex-end; }
  .topbar .nav { order: 1; flex: 1 0 100%; margin-left: 0; flex-wrap: wrap; min-width: 0; }
  /* The nav row is full width: a selected name can use all of it (the other
     controls move to the next line first); only a name wider than the row ends
     in an ellipsis. */
  .topbar .nav .user-select { max-inline-size: 100%; }
}
@media (max-width: 639px) {
  .topbar .td-prefix, .topbar .td-status { display: none; }
  .main { padding: 14px 12px; }
  .ag-tree { padding: 8px 8px 4px; }
  .pa-crumb { min-height: 44px; }
  /* The path shrinks to "‹ parent › here". */
  .pa-crumb.is-far, .pa-sep.is-far { display: none; }
  .pa-crumb.is-up::before { content: '\\2039\\00a0'; }
  /* Panel head with the deck shown: <ui-deck-nav>'s 44px targets left the title ~85px, so 자세히 is its
     icon alone (the word stays its accessible name) and the title gets the word's width back. */
  .slide-panel:not([data-deck="0"]) .panel-detail-toggle { width: 44px; padding: 0; justify-content: center; }
  .slide-panel:not([data-deck="0"]) .pdt-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  /* Stats strip: period control + 자세히 on the first row, the numbers on the
     second. The period tabs share the row's width and keep 44px height with
     narrower sides, so the row fits 320px with the coarse-pointer padding. */
  .stats-strip { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "period more" "nums nums"; gap: 8px 12px; }
  .stats-strip .period-bar { min-width: 0; }
  /* Top bar: the status badge becomes a 10px dot (aria-label preserved for SR),
     the account glyph goes, and the user select fills the nav row (which
     wraps rather than overflow on very small screens). Labels stay whole. */
  .topbar { padding: 6px 12px; gap: 6px 8px; }
  .topbar h1 { font-size: 14px; gap: 6px; }
  .topbar h1 .brand-mark { width: 20px; height: 20px; }
  .topbar .ws-badge {
    display: inline-block;
    inline-size: 10px;
    block-size: 10px;
    padding: 0;
    background: var(--ws-tone);
    border-radius: 50%;
    text-indent: 100%;
    white-space: nowrap;
    overflow: hidden;
    flex-shrink: 0;
    min-width: 0;
  }
  .topbar .ws-badge::before { display: none; }
  .topbar .nav .user-select { flex: 1 1 auto; }
  .topbar .user-pill { padding: 4px 10px; }
  .topbar .user-pill-prefix { display: none; }
  .topbar .admin-toggle { padding: 4px 10px; }
  #theme-toggle { inline-size: 32px; block-size: 32px; padding: 0; flex-shrink: 0; }
  .inbox-head { margin-bottom: 12px; flex-wrap: wrap; row-gap: 8px; }
  /* The tools take the row under the breadcrumb; on the narrowest screens
     (320px) Show archives sits above Board | List instead of overflowing. */
  .inbox-tools { flex: 1 1 auto; min-width: 0; flex-wrap: wrap; justify-content: flex-end; row-gap: 8px; }
  .crumbs { font-size: 15px; gap: 7px; }
}

/* ── RESPONSIVE — Bauhaus grid adapts ── */
@media (max-width: 1100px) {
  .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  /* Workflows — the widest value — takes the last row on its own. */
  .stats-grid .stat-card:last-child { grid-column: 1 / -1; }
}
@media (max-width: 680px) {
  .stats-grid { gap: 6px; margin-bottom: 12px; }
  .stat-card { padding: 8px 12px; }
  .stat-card .value { font-size: 18px; }
  .stat-card .label { font-size: 11.5px; }
  .chart-row { flex-direction: column; }
}
@media (hover: hover) and (pointer: fine) {
  .pa-crumb:not([aria-current="page"]):hover { background: var(--surface-raised); color: var(--text); }
}
@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  :is(.archives-btn, .topbar .nav a, .topbar .td-chip, .topbar .user-pill, .topbar .admin-toggle, #theme-toggle, .stats-more, .panel-detail-toggle, .panel-tab, .psec-tab, .nt-rec-btn, .art-chip, .art-open, .art-play, .um-tile, .um-open):active:not(:disabled):not(:focus-visible) { transform: none; }
  /* Static working indicator: a full ring with a centre dot instead of a spin. */
  .spinner, .spin { animation: none !important; }
  /* Loading skeletons hold still. */
  .sk, .is-loading { animation: none !important; }
  .spinner { border-color: var(--st-run); background: radial-gradient(circle, var(--st-run) 0 2px, transparent 2.5px); }
}
@media (prefers-reduced-motion: reduce) {
  /* SSOT 2026-10-27 — a compaction past its estimate holds a still, dimmed bar
     instead of the sweep (the shared block above already stills transitions). */
  .cp-bar.is-over > i { animation: none !important; background: var(--accent); opacity: 0.6; }
}
/* ── TOUCH — coarse pointer enlargement ── */
@media (pointer: coarse) {
  .panel-tab, .psec-tab, .psec-older, .psec-pill, .panel-sec-head, .panel-detail-toggle { min-height: 44px; }
  .topbar .nav a, .topbar .nav .user-select { min-height: 40px; padding: 8px 16px; }
  .show-older-btn { min-height: 40px; padding: 8px 16px; }
}
/* ── #800: TOUCH x NARROW — restore tight padding so the coarse-pointer
   tap-target (16px horizontal) does not push the topbar past mobile
   widths. min-height stays at 40px for touch-target accessibility
   (WCAG 2.5.5); only the inline padding shrinks. These blocks must
   stay AFTER @media (pointer: coarse) in source order so the more
   specific (combined) query wins the cascade. ── */
@media (max-width: 680px) and (pointer: coarse) {
  .topbar .nav a, .topbar .nav .user-select { padding: 4px 8px; }
}
@media (max-width: 480px) and (pointer: coarse) {
  .topbar .nav a, .topbar .nav .user-select { padding: 4px 6px; }
}
/* ── 44px TARGETS — every remaining control on narrow (<640px) or touch screens.
   Heights only, so the #800 topbar width fit is untouched; the theme toggle keeps
   its 32px square (pinned by #800) and gets a 44px-wide hit slop instead. ── */
/* The composer's model · effort trigger shares the input's line on a narrow or a
   short screen (a phone sideways), so the reading area keeps its room; its menu opens above. */
@media (max-width: 639px), (max-height: 560px) {
  .panel-command { display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; }
  .panel-command .panel-controls { padding: 0; flex: 0 1 auto; }
  .panel-command .panel-controls .pc-scope { display: none; }
  .panel-command .panel-controls .cb-model-note { flex-basis: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Task view T1.5: the session's model (model · effort) on its own line above
     the composer — the tools sit inside <ui-agent-steering>'s field (batch 2). */
  .panel-command { row-gap: 6px; }
  .panel-command .panel-controls { min-width: 0; max-width: 100%; }
  .panel-command .pc-steer-wrap { flex-basis: 100%; }
}
@media (max-width: 639px), (pointer: coarse) {
  .topbar .nav a, .topbar .nav .user-select, .topbar .user-pill, .topbar .admin-toggle { min-height: 44px; }
  #theme-toggle { min-block-size: 44px; position: relative; }
  #theme-toggle::after { content: ''; position: absolute; inset: 0 -6px; }
  .topbar .td-chip { min-height: 44px; }
  .stats-more { min-height: 44px; }
  .inbox-head .archives-btn { min-height: 44px; }
  .card-body .card-refs a { display: inline-flex; align-items: center; min-height: 44px; }
  .pi-links a, .pi-head, .panel-tasks-toggle { min-height: 44px; }
  .cgl-go, .card-more-link, .tl-toggle { min-height: 44px; }
}

/* ── CRON badge · lane · drawer (SSOT 2026-10-23 T3/T4/T5) ── */
.cron-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px 1px 5px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  line-height: 1.5;
  color: var(--st-color, var(--ib-text-2));
  background: color-mix(in srgb, var(--st-color, var(--ib-muted)) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--st-color, var(--ib-muted)) 45%, transparent);
}
.cron-badge svg { width: 12px; height: 12px; }
/* LLM 가용량 and the CRON lane: @2lab.ai/ui <ui-agent-queue> (re-agent-queue), one each,
   drawn with the dashboard tokens through their .ui-tok wrappers. The lane's job cards
   are board cards in each job's box (.cron-cards, slot="job:<group key>"), light DOM. */
.capacity-host { margin-bottom: 18px; }
.cron-lane { margin-bottom: 12px; }
.capacity-host[hidden], .cron-lane[hidden] { display: none; }
.capacity-host > ui-agent-queue, .cron-lane > ui-agent-queue { display: block; min-width: 0; }
.cron-cards { display: flex; flex-direction: column; gap: 8px; position: relative; }
.cron-cards:empty, .cron-cards:has(> .cron-inbox.is-empty) { display: none; }
/* A cron job's runs (C-05) — @2lab.ai/ui <ui-drawer mode="sheet">: the element draws the sheet, its scrim, the
   slide on the drawer curve, the close button (44px on touch), the focus trap and the bottom inset. The head
   is the job's name after the CRON badge; the meta and the runs scroll together in the element's body. */
.cron-drawer-headline { display: inline-flex; align-items: center; gap: 10px; min-width: 0; max-width: 100%; }
.cron-drawer-headline #cron-drawer-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* P8: the close and regenerate glyphs are the icon set's (no ✕ / × / 🔄 characters). */
#panel-title-sub-regen svg { width: 12px; height: 12px; vertical-align: -2px; }
.cron-drawer-meta { padding: 0 0 4px; font-size: 13px; color: var(--text-secondary); }
.cron-dmeta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.cron-dmeta dt { color: var(--text-tertiary); }
.cron-dmeta dd { margin: 0; color: var(--text); }
.cron-dnote { margin: 8px 0 0; font-size: 12px; color: var(--text-tertiary); }
.cron-drawer-body { padding: 6px 0 0; }
.cron-runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.cron-run { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 4px 10px; align-items: start; padding: 10px 6px; border-bottom: 1px solid var(--border); }
.cr-glyph { font-size: 14px; line-height: 20px; text-align: center; color: var(--st-done); }
.cron-run.is-fail .cr-glyph { color: var(--st-fail); }
.cron-run.is-run .cr-glyph { color: var(--st-run); }
.cron-run.is-wait .cr-glyph { color: var(--st-wait); }
.cron-run.is-none .cr-glyph { color: var(--text-tertiary); }
.cr-title { font-weight: 600; font-size: 14px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-sub { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.cr-err { font-size: 12px; color: var(--st-fail); margin-top: 2px; }
.cr-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.aq-left { font-variant-numeric: tabular-nums; } /* the drawer's 다음 실행 countdown (aqTime) */


/* ═══ New task (SSOT 2026-10-23) — entry button, floating button, composer ═══
   The page's call to action, calm (ui.2lab.ai's one ink primary): PC an ink pill in
   the top bar with its N key hint opens a centered dialog; phones an ink extended
   floating button in the thumb zone opens a full-screen sheet sized to the visual
   viewport, so the toolbar stays above the keyboard. No sheen, pulse, glow, ring or
   hover lift — it moves only when pressed (0.97) and when the FAB arrives. */
/* The kit's ink primary (.ui-btn.is-primary); its N hint is a kit key tinted for the ink face. */
.new-task-btn { flex: none; padding-right: 6px; }
.new-task-btn .ui-kbd { background: color-mix(in srgb, var(--ib-card) 16%, transparent); box-shadow: none; color: color-mix(in srgb, var(--ib-card) 82%, transparent); }

.new-task-fab {
  position: fixed;
  right: max(16px, env(safe-area-inset-right, 0px));
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  z-index: 60;
  display: none;
  align-items: center;
  gap: 8px;
  height: 56px;
  padding: 0 20px 0 17px;
  border: 0;
  border-radius: 999px;
  background: var(--ib-text);
  color: var(--ib-card);
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--ib-shadow-raised);
  transition: padding var(--dur-expand) var(--ease-out), gap var(--dur-expand) var(--ease-out), transform var(--dur-press) var(--ease-out);
  animation: nt-fab-in 240ms var(--ease-out) both;
  -webkit-tap-highlight-color: transparent;
}
.new-task-fab:active:not(:focus-visible) { transform: scale(0.95); }
.new-task-fab:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 3px; }
.nt-fab-icon { width: 22px; height: 22px; flex: none; transition: transform var(--dur-move) var(--ease-out); }
.nt-fab-label { display: inline-block; max-width: 7em; overflow: hidden; white-space: nowrap; transition: max-width var(--dur-expand) var(--ease-out), opacity var(--dur-fade) var(--ease-out); }
.new-task-fab.is-compact { padding: 0 17px; gap: 0; }
.new-task-fab.is-compact .nt-fab-label { max-width: 0; opacity: 0; }
.new-task-fab.is-compact .nt-fab-icon { transform: rotate(90deg); }
.new-task-fab.is-floating { display: inline-flex; }
/* The open composer hides the FAB everywhere; an open drawer hides it only as a
   sheet (Drawer blocks) — docked, the board is live and the FAB keeps its own
   is-floating rule. */
body.nt-open .new-task-fab { display: none !important; }

.nt-dialog {
  width: min(720px, calc(100vw - 48px));
  max-height: min(86vh, 880px);
  margin: auto;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--ib-shadow-raised);
  overflow: hidden;
  opacity: 0;
  transform: translateY(10px) scale(0.97);
  transition: opacity var(--dur-fade) var(--ease-out), transform var(--dur-fade) var(--ease-out);
}
.nt-dialog.is-shown { opacity: 1; transform: none; transition-duration: var(--dur-expand); }
.nt-dialog::backdrop { background: var(--scrim); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); opacity: 0; transition: opacity var(--dur-fade) var(--ease-out); }
.nt-dialog.is-shown::backdrop { opacity: 1; }
.nt-form { display: flex; flex-direction: column; max-height: inherit; height: 100%; }
.nt-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 4px; }
.nt-head h2 { flex: 1; margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.nt-head-hint { font-size: 11px; color: var(--text-tertiary); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; }
.nt-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 10px 16px 14px; overscroll-behavior: contain; }
.nt-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.nt-config { display: flex; flex-wrap: wrap; gap: 8px; }
.nt-chip { display: inline-flex; align-items: center; gap: 4px; height: 36px; padding: 0 4px 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-raised); flex: none; max-width: 100%; }
.nt-chip:focus-within { border-color: var(--border-focus); }
.nt-chip > label { font-size: 11px; font-weight: 600; color: var(--text-secondary); white-space: nowrap; }
.nt-chip select {
  appearance: none;
  -webkit-appearance: none;
  min-width: 0;
  max-width: 220px;
  height: 100%;
  padding: 0 20px 0 4px;
  border: 0;
  outline: none;
  background-color: transparent;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 10px) 52%, calc(100% - 6px) 52%;
  background-size: 4px 4px, 4px 4px;
  background-repeat: no-repeat;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  cursor: pointer;
}
.nt-chip select option { background: var(--surface); color: var(--text); }
.nt-battery-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px; border: 0; border-radius: 8px; background: transparent; color: var(--text-tertiary); font: inherit; font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; cursor: pointer; }
@media (hover: hover) and (pointer: fine) { .nt-battery-btn:hover { background: var(--ib-pill); } }
.nt-battery { position: relative; display: inline-block; width: 24px; height: 12px; padding: 1px; border: 1.5px solid currentColor; border-radius: 3px; }
.nt-battery::after { content: ''; position: absolute; right: -4px; top: 2.5px; width: 2px; height: 4px; border-radius: 0 1px 1px 0; background: currentColor; }
.nt-battery-fill { display: block; width: 0; height: 100%; border-radius: 1px; background: currentColor; transition: width var(--dur-move) var(--ease-out); }
.nt-batt-high { color: var(--green); }
.nt-batt-mid { color: var(--yellow); }
.nt-batt-low { color: var(--red); }
.nt-batt-low .nt-battery-fill { animation: nt-blink 1.6s ease-in-out infinite; }
.nt-batt-unknown { color: var(--text-tertiary); }
.nt-usage { margin: -4px 0 0; padding: 8px 10px; border-radius: 10px; background: var(--bg); color: var(--text-secondary); font-size: 12px; line-height: 1.5; }

.nt-toggles { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.nt-toggle { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px 0 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-raised); color: var(--text-secondary); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; transition: background var(--dur-press) var(--ease-out), color var(--dur-press) var(--ease-out), border-color var(--dur-press) var(--ease-out); }
.nt-switch { position: relative; flex: none; width: 26px; height: 16px; border-radius: 999px; background: var(--border); transition: background var(--dur-press) var(--ease-out); }
.nt-switch::after { content: ''; position: absolute; left: 2px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--ib-seg-on); box-shadow: var(--ib-shadow); transition: transform var(--dur-press) var(--ease-out); }
.nt-toggle[aria-pressed="true"] { color: var(--text); border-color: var(--ib-muted); }
.nt-toggle[aria-pressed="true"] .nt-switch { background: var(--accent); }
.nt-toggle[aria-pressed="true"] .nt-switch::after { transform: translateX(10px); }
.nt-toggle-note { font-size: 11px; font-weight: 500; color: var(--text-tertiary); }

.nt-compose { position: relative; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 14px; background: var(--bg); transition: border-color var(--dur-press) var(--ease-out), box-shadow var(--dur-press) var(--ease-out); }
.nt-compose:focus-within { border-color: var(--border-focus); box-shadow: 0 0 0 3px color-mix(in srgb, var(--border-focus) 18%, transparent); }
.nt-prompt { display: block; width: 100%; min-height: 150px; max-height: 44vh; padding: 12px 14px; border: 0; outline: none; resize: none; background: transparent; color: var(--text); font: inherit; font-size: 14px; line-height: 1.55; }
.nt-prompt::placeholder { color: var(--text-tertiary); }
.nt-drop-hint { position: absolute; inset: 0; display: none; place-items: center; border-radius: inherit; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--tint-accent-fg); font-size: 13px; font-weight: 600; pointer-events: none; }
.nt-compose.is-drag { border-color: var(--accent); border-style: dashed; }
.nt-compose.is-drag .nt-drop-hint { display: grid; }
.nt-count { align-self: flex-end; padding: 0 10px 6px; font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

.nt-attachments { display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 4px; scroll-snap-type: x proximity; scrollbar-width: thin; }
.nt-attachments:empty { display: none; }
.nt-att { position: relative; flex: none; display: flex; align-items: center; gap: 8px; height: 58px; max-width: 230px; padding: 0 32px 0 6px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); scroll-snap-align: start; animation: nt-att-in 240ms var(--ease-out) both; }
.nt-att-thumb { display: grid; place-items: center; flex: none; width: 44px; height: 44px; border-radius: 8px; background: var(--bg); color: var(--text-secondary); object-fit: cover; overflow: hidden; }
.nt-att-thumb svg { width: 20px; height: 20px; }
.nt-att-text { display: flex; flex-direction: column; min-width: 0; }
.nt-att-name { font-size: 12px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nt-att-meta { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.nt-att-remove { position: absolute; top: 4px; right: 4px; display: grid; place-items: center; width: 22px; height: 22px; border: 0; border-radius: 50%; background: var(--media-scrim); color: var(--on-media); cursor: pointer; }
.nt-att-remove svg { width: 10px; height: 10px; }
.nt-att-play { display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 8px; background: var(--bg); color: var(--text); cursor: pointer; flex: none; }
.nt-att-play svg { width: 18px; height: 18px; }

.nt-recorder { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 12px; border: 1px solid var(--tint-fail-line); border-radius: 12px; background: var(--tint-fail-bg); font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; }
.nt-recorder[hidden] { display: none; }
.nt-rec-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--red); animation: nt-rec 1.2s ease-in-out infinite; }
.nt-rec-meter { flex: 1; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.nt-rec-level { display: block; width: 0; height: 100%; border-radius: 3px; background: var(--red); transition: width 80ms linear; }
.nt-rec-btn { height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: transform var(--dur-press) var(--ease-out); }
.nt-rec-btn.is-primary { border-color: transparent; background: var(--red); color: var(--surface); }
.nt-error { margin: 0; padding: 8px 10px; border-radius: 10px; background: var(--tint-fail-bg); color: var(--tint-fail-fg); font-size: 12.5px; }
.nt-error[hidden] { display: none; }
.nt-empty { margin: 0; color: var(--text-secondary); font-size: 12.5px; }

.nt-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 12px 12px 10px; border-top: 1px solid var(--border); background: var(--surface); }
.nt-tools { display: flex; align-items: center; gap: 2px; }
.nt-tool-camera { display: none; }
.nt-tool-mic[aria-pressed="true"] { background: var(--tint-fail-bg); color: var(--tint-fail-fg); }
.nt-status { flex: 1; min-width: 0; overflow: hidden; color: var(--text-secondary); font-size: 12px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.nt-submit-hint { flex: none; font-size: 11px; color: var(--text-tertiary); }
.nt-submit { flex: none; }
.nt-submit.is-busy svg { animation: nt-spin 0.9s linear infinite; }


/* The FAB arrives: opacity + scale from 0.95 (never from nothing), 240ms ease-out — once. */
@keyframes nt-fab-in { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: none; } }
@keyframes nt-att-in { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: none; } }
@keyframes nt-rec { 50% { opacity: 0.35; transform: scale(0.8); } }
@keyframes nt-blink { 50% { opacity: 0.45; } }
@keyframes nt-spin { to { rotate: 360deg; } }

@media (max-width: 639px) {
  /* New task — phones: the floating button replaces the top-bar one, and the
     composer is a full-screen sheet that follows the visual viewport (the
     keyboard) and the safe areas. */
  .new-task-btn { display: none; }
  .new-task-fab { display: inline-flex; }
  .nt-dialog {
    position: fixed;
    inset: auto 0 auto 0;
    top: var(--nt-vvt, 0px);
    width: 100vw;
    max-width: 100vw;
    height: var(--nt-vvh, 100dvh);
    max-height: none;
    margin: 0;
    border: 0;
    border-radius: 0;
    opacity: 1;
    transform: translateY(100%);
    transition: transform var(--dur-move) var(--ease-out);
  }
  .nt-dialog.is-shown { transform: none; }
  .nt-head { padding: calc(8px + env(safe-area-inset-top, 0px)) 12px 4px; }
  .nt-body { padding: 8px 14px 10px; gap: 10px; }
  .nt-config { flex-wrap: nowrap; overflow-x: auto; margin: 0 -14px; padding: 0 14px 2px; scrollbar-width: none; }
  .nt-config::-webkit-scrollbar { display: none; }
  .nt-chip select { max-width: 150px; }
  .nt-compose { flex: 1 1 auto; min-height: 140px; }
  .nt-prompt { flex: 1; max-height: none; }
  .nt-toolbar { padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px)); }
  .nt-submit-hint, .nt-head-hint { display: none; }
}
@media (pointer: coarse) {
  /* New task — touch: 44px targets, 16px text (iOS does not zoom into it),
     and the camera button (capture="environment" opens the camera directly). */
  .nt-battery-btn, .nt-toggle, .nt-chip, .nt-rec-btn { min-height: 44px; min-width: 44px; }
  .nt-att-remove { width: 28px; height: 28px; }
  .nt-prompt, .nt-chip select { font-size: 16px; }
  .nt-tool-camera { display: inline-grid; }
  .nt-kbd, .nt-submit-hint, .nt-head-hint { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  /* New task — no arrival, slide or scale; changes are instant. */
  .new-task-btn, .new-task-fab, .nt-dialog, .nt-att,
  .nt-rec-dot, .nt-battery-fill, .nt-fab-label, .nt-fab-icon, .nt-submit svg { animation: none !important; transition: none !important; }
}
/* ── Session artifacts (SSOT 2026-10-23): face chips, strips, minimap, viewer ── */
.art-glyph { width: 14px; height: 14px; flex-shrink: 0; }
.art-k-image { --art-tint: var(--green); }
.art-k-html { --art-tint: var(--orange); }
.art-k-audio { --art-tint: var(--purple); }
.art-k-video { --art-tint: var(--red); }
.art-k-markdown { --art-tint: var(--accent); }
.art-k-pdf { --art-tint: var(--red); }
.art-k-text, .art-k-file { --art-tint: var(--text-secondary); }
.art-chip { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 150px; height: 24px; padding: 0 8px; border: 1px solid var(--ib-card-border); border-radius: 999px; background: var(--ib-pill); color: var(--ib-text); font: inherit; font-size: 11.5px; line-height: 1; cursor: zoom-in; transition: border-color 150ms ease, background-color 150ms ease, transform var(--dur-press) var(--ease-out); }
.art-chip .art-glyph { color: var(--art-tint); }
.art-chip:focus-visible { border-color: var(--art-tint, var(--accent)); background: var(--surface-raised); outline: none; }
.art-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-artifacts { margin-top: 12px; }
.art-section-label { display: flex; align-items: center; gap: 6px; }
.art-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--ib-pill); color: var(--text-secondary); font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
.art-strip { display: flex; gap: 8px; overflow-x: auto; padding: 4px 2px 8px; scroll-snap-type: x proximity; scrollbar-width: thin; overscroll-behavior-x: contain; }
.art-tile { position: relative; flex: 0 0 auto; width: 128px; scroll-snap-align: start; }
.art-open { display: flex; flex-direction: column; width: 100%; padding: 0; overflow: hidden; border: 1px solid var(--ib-card-border); border-radius: 10px; background: var(--surface); color: var(--ib-text); font: inherit; text-align: left; cursor: zoom-in; transition: border-color 150ms ease, box-shadow 150ms ease, transform var(--dur-press) var(--ease-out); }
.art-open:focus-visible { border-color: var(--art-tint, var(--accent)); box-shadow: var(--ib-shadow-raised); outline: none; }
.art-thumb { position: relative; display: flex; align-items: center; justify-content: center; height: 76px; border-bottom: 1px solid var(--ib-card-border); background: var(--ib-col); color: var(--art-tint, var(--text-secondary)); }
.art-thumb .art-glyph { width: 28px; height: 28px; }
.art-thumb-img img { display: block; width: 100%; height: 100%; object-fit: cover; }
.art-thumb-ext { position: absolute; left: 6px; bottom: 5px; padding: 1px 5px; border-radius: 6px; background: var(--surface-raised); color: var(--text-secondary); font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em; }
.art-tile-name { padding: 6px 8px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 600; }
.art-tile-meta { padding: 2px 8px 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--ib-muted); }
.art-tile.is-remote .art-thumb { opacity: 0.55; }
.art-play { position: absolute; top: 46px; right: 6px; display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: none; border-radius: 50%; background: var(--purple); color: var(--surface); box-shadow: var(--ib-shadow); cursor: pointer; transition: transform var(--dur-press) var(--ease-out); }
.art-play svg { width: 14px; height: 14px; }
@media (hover: hover) and (pointer: fine) {
  .art-chip:hover { border-color: var(--ib-muted); background: var(--surface-raised); }
  .art-open:hover { border-color: var(--ib-muted); }
}
.art-play .ic-pause, .art-play.is-playing .ic-play { display: none; }
.art-play.is-playing .ic-pause { display: block; }
.art-play.is-playing { box-shadow: 0 0 0 4px color-mix(in srgb, var(--purple) 30%, transparent); }
.panel-artifacts { padding: 10px 16px 4px; border-bottom: 1px solid var(--border); min-height: 44px; }
.panel-arts-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 12px; font-weight: 600; color: var(--text); }
.panel-arts-hint { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--text-tertiary); }
.art-strip-panel .art-tile { width: 152px; }
.art-strip-panel .art-thumb { height: 94px; }
.turn-arts-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
/* ── User media (SSOT 2026-10-25): the files a user attached to an instruction ──
   Above the words, as chat apps show an attachment with its message. Fixed boxes
   (no layout shift once an image loads), 80px tiles, "+N" on the 4th past four,
   44px targets on touch, no motion beyond the shared press scale. */
.um-media { display: grid; gap: 6px; margin: 2px 0 6px; min-width: 0; }
.um-grid { display: flex; flex-wrap: wrap; gap: 4px; }
.um-tile { position: relative; flex: 0 0 auto; width: 80px; height: 80px; padding: 0; overflow: hidden; border: 1px solid var(--ib-card-border); border-radius: 8px; background: var(--ib-col); cursor: zoom-in; transition: border-color 150ms ease, transform var(--dur-press) var(--ease-out); }
.um-tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
.um-single .um-tile { width: 280px; max-width: 100%; height: 200px; background: var(--bg); }
.um-single .um-tile img { object-fit: contain; }
.um-tile:focus-visible, .um-open:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.um-more { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--media-scrim); color: var(--on-media); font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.um-tile.is-broken img { display: none; }
.um-tile.is-broken::after { content: '미리보기 불가'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4px; font-size: 10.5px; color: var(--ib-muted); text-align: center; }
.um-files { display: flex; flex-wrap: wrap; gap: 6px; }
.um-file { position: relative; display: flex; align-items: center; min-width: 0; width: 240px; max-width: 100%; height: 52px; border: 1px solid var(--ib-card-border); border-radius: 10px; background: var(--surface); transition: border-color 150ms ease; }
.um-open { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; height: 100%; padding: 0 10px; border: none; border-radius: 10px; background: none; color: var(--ib-text); font: inherit; text-align: left; cursor: zoom-in; transition: transform var(--dur-press) var(--ease-out); }
.um-open .art-glyph { width: 26px; height: 26px; color: var(--art-tint, var(--text-secondary)); }
.um-file-text { display: flex; flex-direction: column; min-width: 0; }
.um-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.um-file-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--ib-muted); }
.um-file.is-remote { border-style: dashed; }
.um-file.is-remote .art-glyph { opacity: 0.55; }
.um-file .um-play { position: static; flex: 0 0 auto; margin-right: 10px; }
.um-compact .um-tile { width: 40px; height: 40px; border-radius: 6px; }
.um-compact .um-more { font-size: 12px; }
.um-compact .um-file { width: auto; max-width: 200px; height: 30px; border-radius: 999px; }
.um-compact .um-open { gap: 6px; padding: 0 10px; }
.um-compact .um-open .art-glyph { width: 14px; height: 14px; }
.um-compact .um-file .um-play { width: 24px; height: 24px; margin-right: 4px; }
.io-row .um-media { margin: 4px 0 6px; }
.panel-user-media { margin-bottom: 6px; }
.panel-um-head { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 32px; padding: 2px 0; border: none; background: none; color: var(--text); font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
.panel-um-head:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; border-radius: 6px; }
.panel-um-head .um-chevron { width: 14px; height: 14px; flex-shrink: 0; color: var(--text-tertiary); transition: transform var(--dur-press) var(--ease-out); }
.panel-um-head[aria-expanded="true"] .um-chevron { transform: rotate(180deg); }
.panel-um-body { padding: 4px 0 2px; }
.panel-um-body .um-media { margin: 0; }
@media (hover: hover) and (pointer: fine) {
  .um-tile:hover, .um-file:hover { border-color: var(--ib-muted); }
}
@media (pointer: coarse) {
  .um-compact .um-tile { width: 44px; height: 44px; }
  .um-compact .um-file { height: 44px; }
  .panel-um-head { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .um-tile, .um-open, .panel-um-head .um-chevron { transition: none; }
}
.art-peek { position: fixed; z-index: 1000; left: 0; top: 0; width: 360px; max-width: calc(100vw - 16px); overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); box-shadow: var(--ib-shadow-raised); opacity: 0; visibility: hidden; transform: translateY(4px) scale(0.98); transform-origin: top left; pointer-events: none; transition: opacity var(--dur-fade) var(--ease-out), transform var(--dur-fade) var(--ease-out), visibility 0s linear var(--dur-fade); }
.art-peek.open { opacity: 1; visibility: visible; transform: none; pointer-events: auto; transition: opacity var(--dur-fade) var(--ease-out), transform var(--dur-fade) var(--ease-out); }
.art-peek-media { position: relative; display: flex; align-items: center; justify-content: center; height: 225px; overflow: hidden; background: var(--bg); cursor: zoom-in; color: var(--art-tint, var(--text-secondary)); }
.art-peek-img, .art-peek-video { max-width: 100%; max-height: 100%; object-fit: contain; }
.art-peek-frame { position: absolute; inset: 0; overflow: hidden; background: var(--media-paper); }
.art-peek-frame iframe { width: 1280px; height: 800px; border: 0; transform: scale(0.28125); transform-origin: 0 0; pointer-events: none; }
.art-peek-doc { align-self: stretch; width: 100%; padding: 10px 14px; overflow: hidden; color: var(--text); font-size: 11px; line-height: 1.5; -webkit-mask-image: linear-gradient(var(--media-black) 70%, transparent); mask-image: linear-gradient(var(--media-black) 70%, transparent); }
.art-peek-doc .md-doc h1, .art-peek-doc .md-doc h2, .art-peek-doc .md-doc h3 { font-size: 13px; margin: 4px 0; }
.art-peek-audio { display: flex; flex-direction: column; align-items: center; gap: 16px; width: 100%; padding: 0 16px; }
.art-peek-audio .art-glyph { width: 48px; height: 48px; }
.art-peek-audio audio { width: 100%; }
.art-peek-meta { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 0 18px; text-align: center; }
.art-peek-meta .art-glyph { width: 36px; height: 36px; }
.art-peek-sub { font-size: 12px; color: var(--text-secondary); word-break: break-all; }
.art-peek-foot { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px 10px; border-top: 1px solid var(--border); }
.art-peek-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; color: var(--text); }
.art-peek-info { font-size: 11px; color: var(--text-tertiary); }
.art-doc-loading { color: var(--text-tertiary); font-size: 12px; }
.art-modal { width: min(1240px, 94vw); height: 90vh; max-width: none; max-height: none; margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); color: var(--text); box-shadow: var(--ib-shadow-raised); }
.art-modal[open] { display: flex; flex-direction: column; animation: dlg-in var(--dur-expand) var(--ease-out); }
.art-modal::backdrop { background: var(--scrim); }
.art-modal-head { display: flex; align-items: center; gap: 12px; flex-shrink: 0; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--border); }
.art-modal-kind { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; padding: 3px 9px; border-radius: 999px; background: var(--ib-pill); color: var(--text-secondary); font-size: 11px; font-weight: 700; }
.art-modal-title { flex: 1; min-width: 0; }
.art-modal-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.art-modal-meta { font-size: 11.5px; color: var(--text-tertiary); }
.art-modal-nav, .art-modal-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.art-modal-pos { min-width: 40px; font-size: 12px; color: var(--text-secondary); text-align: center; font-variant-numeric: tabular-nums; }
.art-modal-actions .ui-btn[hidden] { display: none; }
.art-modal-body { position: relative; display: flex; flex: 1; min-height: 0; align-items: center; justify-content: center; overflow: auto; background: var(--bg); }
.art-full-imgwrap { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; overflow: auto; }
.art-full-img { max-width: 100%; max-height: 100%; object-fit: contain; cursor: zoom-in; }
.art-full-imgwrap.is-zoomed { display: block; }
.art-full-imgwrap.is-zoomed .art-full-img { max-width: none; max-height: none; cursor: zoom-out; }
.art-full-frame { width: 100%; height: 100%; border: 0; background: var(--media-paper); }
.art-full-video { max-width: 100%; max-height: 100%; background: var(--media-black); }
.art-full-audio { display: flex; flex-direction: column; align-items: center; gap: 18px; width: min(560px, 90%); color: var(--purple); }
.art-full-audio .art-glyph { width: 72px; height: 72px; }
.art-full-audio audio { width: 100%; }
.art-full-meta { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 460px; padding: 24px; text-align: center; color: var(--text-secondary); }
.art-full-meta .art-glyph { width: 56px; height: 56px; }
.art-full-meta-name { font-size: 15px; font-weight: 600; color: var(--text); word-break: break-all; }
.art-full-meta-sub { font-size: 12px; color: var(--text-tertiary); }
.art-full-doc { align-self: stretch; width: 100%; max-width: 880px; height: max-content; margin: 0 auto; padding: 28px 32px 56px; }
.art-text { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.6 var(--mono); }
.md-doc { font-size: 14px; line-height: 1.65; color: var(--text); word-break: break-word; }
.md-doc h1, .md-doc h2, .md-doc h3, .md-doc h4, .md-doc h5, .md-doc h6 { margin: 1.3em 0 0.5em; line-height: 1.3; letter-spacing: -0.01em; }
.md-doc h1 { font-size: 1.6em; } .md-doc h2 { font-size: 1.3em; } .md-doc h3 { font-size: 1.12em; } .md-doc h4, .md-doc h5, .md-doc h6 { font-size: 1em; }
.md-doc > :first-child { margin-top: 0; }
.md-doc p, .md-doc ul, .md-doc ol, .md-doc blockquote, .md-doc pre, .md-doc .md-table { margin: 0 0 0.9em; }
.md-doc ul, .md-doc ol { padding-left: 1.4em; }
.md-doc li + li { margin-top: 0.2em; }
.md-doc code { padding: 0.1em 0.35em; border-radius: 6px; background: var(--ib-pill); font: 0.88em var(--mono); }
.md-doc pre { padding: 12px 14px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--ib-col); }
.md-doc pre code { padding: 0; background: none; font-size: 12.5px; line-height: 1.55; }
.md-doc blockquote { padding: 2px 0 2px 12px; border-left: 3px solid var(--border-focus); color: var(--text-secondary); }
.md-doc hr { margin: 1.4em 0; border: 0; border-top: 1px solid var(--border); }
.md-doc a { color: var(--accent); }
.md-doc .md-table { overflow-x: auto; }
.md-doc table { border-collapse: collapse; font-size: 0.93em; }
.md-doc th, .md-doc td { padding: 6px 10px; border: 1px solid var(--border); text-align: left; vertical-align: top; }
.md-doc th { background: var(--ib-col); font-weight: 600; }
@media (prefers-reduced-motion: reduce) {
  .art-chip, .art-open, .art-play, .art-peek, .art-peek.open { transition: none; }
  .art-modal[open] { animation: none; }
  /* Gentler, not zero: a dialog's scrim still fades (opacity only, ≤ 180ms). */
  .art-modal[open] { animation: none; }
  .art-modal[open]::backdrop { animation: scrim-in 120ms ease both !important; }
}
@media (hover: none) {
  .art-chip { height: 32px; }
  .art-play { width: 40px; height: 40px; top: 40px; }
}

/* ═══ Device-responsive layout (SSOT 2026-10-24) ═══
   Targets: iPhone Duo (folded 382×580, unfolded 951×543), iPhone 18 Pro Max
   (440×956 / 956×440), Galaxy Z Fold8 (cover ≈476×751, main ≈933×704).
   Research: docs/misc/research/2026-10-24-dashboard-device-viewports.md.
   Two drawer modes only — a sheet below 840px, docked from 840px — so every
   fold, unfold and rotation of those devices crosses one boundary and
   runLayoutCheck animates it. */
@media (max-width: 839px) {
  /* Drawer — a full-screen sheet: the saved desktop width never applies, there is
     no resize handle, the top-bar chips stay under it, and its header and
     composer keep clear of the notch and the home indicator. */
  .slide-panel { width: 100%; }
  .slide-panel .panel-header, .slide-panel .panel-body, .slide-panel .panel-command { margin-left: env(safe-area-inset-left, 0px); }
  .panel-resize-handle { display: none; }
  .slide-panel .panel-header { padding-top: max(12px, env(safe-area-inset-top, 0px)); }
  .slide-panel .panel-command { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
  .topbar .topbar-defaults { z-index: auto; }
  .slide-panel.open ~ .new-task-fab { display: none !important; }
}
@media (min-width: 840px) {
  /* Drawer — docked beside the board (unfolded Duo / Fold8, tablets, PC): no dim,
     the board stays live, the drawer sits under the top bar until it scrolls
     away (--topbar-b, syncTopbarBottom), and the page narrows to what is left
     with its 1280px column centred there (never margin-right over width:100%). */
  :root { --panel-w: min(var(--panel-w-pref, 440px), 50vw); }
  .topbar { z-index: 101; }
  .slide-panel { width: var(--panel-w); top: calc(var(--pv-t, 0px) + var(--topbar-b, 0px)); height: calc(var(--pv-h, 100dvh) - var(--topbar-b, 0px)); }
  .slide-panel-overlay.open { display: none; }
  .app:has(> .slide-panel.open) > .main {
    max-width: min(1280px, calc(100% - var(--panel-w)));
    margin-left: max(0px, calc((100% - var(--panel-w) - 1280px) / 2));
    margin-right: auto;
  }
  .slide-panel.open ~ .new-task-fab { right: calc(var(--panel-w) + 16px); }
}
/* A short docked screen (a phone held sideways, an unfolded Duo) keeps the drawer
   under the top bar too (SSOT 2026-10-29 T3: the top bar is always visible). */
/* A short screen: the panel head drops its subtitle line unless 자세히 is on. */
@media (max-height: 560px) {
  .slide-panel:not(.is-detail) #panel-title-sub { display: none !important; }
}
@media (max-width: 639px) {
  /* Responsive (SSOT 2026-10-24) — phones: the last card clears the FAB (a board
     with cards only — an empty page must not turn scrollable), the
     defaults menu spans the bar instead of running off the edge, and the
     artifact viewer takes the whole screen. */
  .inbox.has-cards { padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px)); }
  /* The defaults chips take their own row under brand · status · account: sharing the brand row
     they could leave the account group (basis 0) no width at all, its pill and theme toggle
     painting over the chips. */
  .topbar .topbar-defaults { position: static; order: 1; flex: 0 0 100%; }
  .art-modal { width: 100vw; height: 100dvh; border: 0; border-radius: 0; }
  .art-modal-head { flex-wrap: wrap; row-gap: 6px; }
}
/* The cron run drawer (#374) on every device: the visible viewport, not 100vh
   behind the Safari toolbar, and clear of the insets that viewport-fit=cover
   makes real (the notch side of a landscape iPhone, the home indicator). Its
   width is a share of the viewport without a classic scrollbar (100%), not
   100vw, so a narrow window never pushes its left edge off screen. */
.cron-drawer::part(panel) { padding-right: env(safe-area-inset-right, 0px); }
.cron-drawer::part(header) { padding-top: max(14px, env(safe-area-inset-top, 0px)); }
/* Task view (T1.6): minimal — the artifacts are one row of name chips, like a
   short panel body below; 자세히 shows them as thumbnails. */
.slide-panel:not(.is-detail) .panel-artifacts { display: flex; align-items: center; gap: 10px; padding-top: 6px; padding-bottom: 6px; }
.slide-panel:not(.is-detail) .panel-arts-head { flex: none; margin-bottom: 0; }
.slide-panel:not(.is-detail) .panel-arts-hint { display: none; }
.slide-panel:not(.is-detail) .art-strip-panel { flex: 1 1 auto; min-width: 0; padding-top: 2px; padding-bottom: 2px; }
.slide-panel:not(.is-detail) .art-strip-panel .art-thumb, .slide-panel:not(.is-detail) .art-strip-panel .art-tile-meta { display: none; }
.slide-panel:not(.is-detail) .art-strip-panel .art-tile-name { padding-bottom: 6px; }
.slide-panel:not(.is-detail) .art-strip-panel .art-tile { display: flex; align-items: center; gap: 6px; width: auto; max-width: 200px; }
.slide-panel:not(.is-detail) .art-strip-panel .art-open { flex: 1 1 auto; min-width: 0; }
.slide-panel:not(.is-detail) .art-strip-panel .art-play { position: static; flex: none; width: 32px; height: 32px; }
/* A short panel body (landscape phones, the unfolded Duo, a docked drawer under a
   tall top bar; below 560px R/2 cannot hold full thumbnails plus a couple of task
   rows): artifacts become name chips with the play button inline, so the
   pinned strip stays one short row; every tile is still reachable sideways. */
@container pbody (max-height: 560px) {
  .panel-artifacts { display: flex; align-items: center; gap: 10px; padding-top: 6px; padding-bottom: 6px; }
  .panel-arts-head { flex: none; margin-bottom: 0; }
  .panel-arts-hint { display: none; }
  .art-strip-panel { flex: 1 1 auto; min-width: 0; padding-top: 2px; padding-bottom: 2px; }
  .art-strip-panel .art-thumb { display: none; }
  .art-strip-panel .art-tile-meta { display: none; }
  .art-strip-panel .art-tile-name { padding-bottom: 6px; }
  .art-strip-panel .art-tile { display: flex; align-items: center; gap: 6px; width: auto; max-width: 200px; }
  .art-strip-panel .art-open { flex: 1 1 auto; min-width: 0; }
  .art-strip-panel .art-play { position: static; flex: none; width: 32px; height: 32px; }
}
</style>
<!-- Tokens — @2lab.ai/ui is the single source (P10): its tokens.css puts every --ui-* on :root and
     [data-theme="light|dark"] (the light and dark palettes, geometry, type and motion), and the
     dashboard's names are aliases of them, so the page and the library elements cannot drift. Never
     alias on an element that also maps --ui-x: var(--x) (.ui-tok) — that is a cycle. -->
<style id="ui-tokens">
${uiLibTokensCss()}
${pageTokenAliases()}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <h1><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect class="bm-bg" width="32" height="32" rx="8"/><rect class="bm-cell" x="7" y="7" width="7" height="7" rx="1.5"/><rect class="bm-cell" x="18" y="7" width="7" height="7" rx="1.5" opacity=".55"/><rect class="bm-cell" x="7" y="18" width="7" height="7" rx="1.5" opacity=".55"/><rect class="bm-cell" x="18" y="18" width="7" height="7" rx="1.5" opacity=".25"/></svg>soma-work</h1>
    <span class="ws-badge" id="ws-status" role="status" aria-label="실시간 업데이트: 연결 중" data-state="connecting">연결 중…</span>
    <div class="topbar-defaults" id="topbar-defaults" hidden>
      <button type="button" class="td-chip" id="td-model" aria-haspopup="menu" aria-expanded="false" title="새 세션의 기본 모델 — 클릭해서 변경" onclick="openDefaultsMenu('model', this)"><span class="td-prefix">모델 </span><b id="td-model-value">…</b><i data-ui-icon="chevron-down" class="td-caret"></i></button>
      <button type="button" class="td-chip" id="td-effort" aria-haspopup="menu" aria-expanded="false" title="새 세션의 기본 effort — 클릭해서 변경" onclick="openDefaultsMenu('effort', this)"><span class="td-prefix">Effort </span><b id="td-effort-value">…</b><i data-ui-icon="chevron-down" class="td-caret"></i></button>
      <ui-menu id="td-menu" lang="ko"></ui-menu>
      <span class="td-status" id="td-status" role="status" aria-live="polite"></span>
    </div>
    <button type="button" class="ui-btn is-primary new-task-btn" id="new-task-btn" aria-keyshortcuts="n" title="새 작업 (N)" onclick="openNewTask()"><i data-ui-icon="plus"></i><span class="nt-btn-label">새 작업</span><kbd class="ui-kbd nt-kbd" aria-hidden="true">N</kbd></button>
    <div class="nav">
      <span class="user-select"><span class="user-select-label" id="user-select-label" aria-hidden="true">모든 사용자</span><select id="user-select" title="모든 사용자" aria-label="보드에 보일 사용자" onchange="selectUser(this.value)">
        <option value="">모든 사용자</option>
      </select></span>
      <a href="/conversations" title="대화 — 지난 대화를 모두 봅니다"><i data-ui-icon="chat"></i>대화</a>
      <a href="/dashboard/settings" id="settings-link" title="개인 설정 — Slack 명령으로 바꾸던 설정을 여기서 확인하고 바꿉니다"><i data-ui-icon="gear"></i>설정</a>
      <a href="/dashboard/settings#memory" id="memory-link" title="기억 — 에이전트가 기억하는 개인 메모리와 관찰 기록을 보고 고칩니다"><i data-ui-icon="brain"></i>기억</a>
      <button
        id="admin-mode-toggle"
        type="button"
        class="admin-toggle"
        style="display:none"
        aria-pressed="false"
        title="관리자 쓰기 모드 — 켜면 다른 사람의 세션도 바꿀 수 있습니다 (#716)"
        onclick="toggleAdminMode()"
      ><span id="admin-mode-label"><span class="admin-mode-prefix">관리자 </span><span class="admin-mode-state">끔</span></span></button>
    </div>
    <div class="topbar-account">
      <a
        class="user-pill"
        id="user-pill"
        href="/login"
        title="계정 — 다른 계정으로 전환하거나 로그아웃합니다"
      ><span class="user-pill-prefix"><i data-ui-icon="user" class="ic-user"></i><svg class="ic-admin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2l4.8 1.9v3.5c0 2.9-2 5.1-4.8 6.2-2.8-1.1-4.8-3.3-4.8-6.2V4.1z"/><path d="M5.9 8.1l1.5 1.5 2.8-2.9"/></svg><span class="ar-vh">로그인 계정 </span></span><b id="user-pill-name">…</b></a>
      <button id="theme-toggle" onclick="toggleTheme()" aria-label="테마 전환"><i data-ui-icon="sun" class="ic-sun"></i><i data-ui-icon="moon" class="ic-moon"></i></button>
    </div>
  </div>

  <div class="main">
    <!-- Stats strip (.prd/10 §3.1-2) leads; the agent inbox board follows it.
         Collapsed by default: period · 세션 · 토큰 · 비용 + 자세히, which opens the
         other cards and the charts below the strip (kept in localStorage). -->
    <section class="stats" id="stats" aria-label="사용량">
      <div class="stats-strip">
        <ui-segmented class="period-bar" id="period-seg" full></ui-segmented>
        <div class="strip-nums">
          <div class="strip-num"><span class="label">&#xC138;&#xC158;</span><span class="value is-loading" id="stat-sessions"></span></div>
          <div class="strip-num"><span class="label">&#xD1A0;&#xD070;</span><span class="value" id="stat-tokens-wrap"><ui-tooltip id="stat-tokens-tooltip" variant="card" placement="bottom" disabled><span id="stat-tokens" class="is-loading"></span></ui-tooltip></span></div>
          <div class="strip-num"><span class="label">&#xBE44;&#xC6A9;</span><span class="value is-loading" id="stat-cost"></span></div>
        </div>
        <button type="button" class="stats-more" id="stats-more" aria-expanded="false" aria-controls="stats-detail" onclick="toggleStatsDetail()"><span>&#xC790;&#xC138;&#xD788;</span><i data-ui-icon="chevron-down"></i></button>
      </div>
      <div class="stats-detail" id="stats-detail" hidden inert>
        <div class="ui-tok usage-cb-wrap"><ui-compact-breakdown id="usage-cb" lang="ko"></ui-compact-breakdown></div>
        <div class="stats-grid" id="stats-grid">
          <div class="stat-card"><div class="label">&#xD134; &#xC0AC;&#xC6A9;</div><div class="value is-loading" id="stat-turns"></div></div>
          <div class="stat-card"><div class="label">PR &#xC0DD;&#xC131;</div><div class="value is-loading" id="stat-prs"></div></div>
          <div class="stat-card"><div class="label">PR &#xBA38;&#xC9C0;</div><div class="value is-loading" id="stat-merged"></div></div>
          <div class="stat-card"><div class="label">&#xBA38;&#xC9C0; &#xCF54;&#xB4DC;</div><div class="value is-loading" id="stat-merge-lines"></div></div>
          <div class="stat-card"><div class="label">&#xC6CC;&#xD06C;&#xD50C;&#xB85C;&#xC6B0;</div><div class="value is-loading" id="stat-workflows" style="font-size:0.85em"></div></div>
        </div>
        <div style="display:none" id="stat-commits-hidden"></div>
        <div class="chart-row is-loading" id="chart-row"></div>
      </div>
    </section>

    <!-- LLM capacity (SSOT 2026-10-23 T7/T9/T10), between the stats strip and the inbox:
         @2lab.ai/ui <ui-agent-queue> with providers only (paintCapacity gives it its data; its
         own 펼치기 / 접기 sits in its head row), drawn with the dashboard tokens through its
         token wrapper (.ui-tok). Hidden until loaded, and on a deployment that does not
         route through llmux. -->
    <div class="capacity-host ui-tok" id="capacity" hidden><ui-agent-queue id="capacity-aq" lang="ko"></ui-agent-queue></div>

    <!-- Agent inbox (.prd/10 §3.1) — the board, right under the stats strip. -->
    <!-- The board and the CRON lane's cards are @2lab.ai/ui <ui-agent-inbox> elements: the token
         wrapper (.ui-tok) hands them the dashboard tokens. -->
    <section class="inbox ui-tok" id="inbox" aria-label="Agent inbox">
      <div class="inbox-head">
        <nav class="crumbs" aria-label="위치"><span class="crumb-root">soma-work</span><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-cur" aria-current="page">Agent inbox</span></nav>
        <div class="inbox-tools">
          <button type="button" class="archives-btn" id="archives-toggle" aria-pressed="false" hidden onclick="toggleArchives()"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="3" rx="0.8"/><path d="M3 6v6.2c0 .5.4.8.8.8h8.4c.4 0 .8-.3.8-.8V6M6.5 8.6h3"/></svg><span id="archives-label">Archives</span></button>
          <button type="button" class="archives-btn" id="sleeping-toggle" aria-pressed="true" hidden onclick="toggleSleeping()"><i data-ui-icon="moon"></i><span id="sleeping-label">Sleeping</span></button>
          <button type="button" class="archives-btn" id="lifecycle-btn" style="display:none" title="세션 수명 주기 (관리자)" onclick="openLifecycleDialog()"><i data-ui-icon="clock"></i><span>수명 주기</span></button>
          <ui-segmented class="view-seg" id="view-seg"></ui-segmented>
        </div>
      </div>
      <ui-dialog id="lifecycle-dialog" class="lifecycle-dialog" heading="세션 수명 주기" size="sm" lang="ko">
        <form id="lifecycle-form" onsubmit="saveLifecycle(event)" oninput="armLifecycleSave(null)">
          <p class="lc-note"><span id="lifecycle-scope">이 인스턴스</span>에만 적용되고, 다음 정리 주기(최대 5분)부터 반영됩니다. 값을 줄이면 그 기준을 넘긴 세션이 바로 Sleeping이 되거나 종료됩니다 — 저장 전에 몇 개인지 알려 줍니다. Sleeping 전환이 12시간 이하이면 12시간 전 확인 알림은 보내지 않습니다.</p>
          <label>마지막 활동 후 Sleeping 전환 <span class="lc-unit">시간</span><input id="lc-sleepAfterHours" type="number" min="1" max="720" step="any" required></label>
          <label>Sleeping 후 Archive(종료) 전환 <span class="lc-unit">일</span><input id="lc-archiveAfterDays" type="number" min="0.05" max="365" step="any" required></label>
          <label>보드에 Archive 표시 기간 <span class="lc-unit">시간</span><input id="lc-boardArchiveWindowHours" type="number" min="0" max="8760" step="any" required></label>
          <p class="lc-status" id="lifecycle-status" role="status" aria-live="polite"></p>
        </form>
        <div slot="footer" class="lc-actions">
          <button type="button" class="ui-btn" onclick="closeLifecycleDialog()">취소</button>
          <button type="submit" form="lifecycle-form" class="ui-btn is-primary lc-save" id="lifecycle-save">저장</button>
        </div>
      </ui-dialog>
      <!-- CRON lane (SSOT 2026-10-23 T4/T5): @2lab.ai/ui <ui-agent-queue> with the lane only —
           one tile per cron job, four numbers, the next-fire queue and 24 hours of runs
           (syncCronLane gives it its data); each job's latest run is its board card — a one-column
           <ui-agent-inbox> (paintCronLaneCards) in the job's slot box (slot="job:<group key>"). -->
      <div class="cron-lane ui-tok" id="cron-lane" hidden><ui-agent-queue id="cron-aq" lang="ko"></ui-agent-queue></div>
      <!-- Until the first board answer the columns show skeleton cards, not
           "0 · Nothing here" (a false empty board). A first load that fails says so
           here and offers a retry; the 30 s poll keeps retrying on its own. -->
      <div class="board-error" id="board-error" role="alert" hidden><span>보드를 불러오지 못했습니다.</span><button type="button" class="archives-btn" onclick="retryBoardLoad()">다시 시도</button></div>
      <!-- The board (re-agent-inbox): NEEDS YOU · RUNNING · DONE (by finish day) — renderBoard gives it its
           data; each open card's body is a light-DOM child in the card's slot (slot="body:<key>"). It says how
           many need you and how many run, politely (D6). -->
      <ui-agent-inbox id="kanban" class="kanban" view="board"></ui-agent-inbox>
    </section>
  </div>

  <!-- A cron job's past runs (SSOT 2026-10-23 T5). -->
  <ui-drawer class="cron-drawer" id="cron-drawer" mode="sheet" width="560" max-width="560" lang="ko">
    <span slot="header" class="cron-drawer-headline"><span class="cron-badge" id="cron-drawer-badge" aria-hidden="true"></span><span id="cron-drawer-title"></span></span>
    <div class="cron-drawer-meta" id="cron-drawer-meta"></div>
    <div class="cron-drawer-body" id="cron-drawer-body"></div>
  </ui-drawer>

  <!-- Slide panel: the detail card -->
  <div class="slide-panel-overlay" id="panel-overlay" onclick="closeDetailCard()"></div>
  <div class="slide-panel" id="slide-panel" data-deck="0">
    <!-- Detail deck (SSOT 2026-10-29 T2): the edges of the open cards' other detail cards, waiting behind this one. -->
    <div class="panel-deck-peek" id="panel-deck-peek" aria-hidden="true"><span></span><span></span></div>
    <div class="panel-resize-handle" id="panel-resize-handle"></div>
    <div class="panel-header">
      <div style="flex:1;min-width:0">
        <h3 id="panel-title" tabindex="-1">작업 카드</h3>
        <div id="panel-title-sub" style="font-size:11px;color:var(--text-secondary);margin-top:2px;display:flex;align-items:center;gap:6px">
          <span id="panel-title-sub-text"></span>
          <button type="button" id="panel-title-sub-regen" class="ui-icon-btn is-sm" style="display:none" aria-label="부제 다시 만들기" title="부제 다시 만들기" onclick="event.stopPropagation();generateTitleSub(panelConvId, !!_panelTitleSub)"><i data-ui-icon="refresh"></i></button>
        </div>
      </div>
      <!-- Detail deck (SSOT 2026-10-29 T2, D3 E-05): every open card has its detail card here; <ui-deck-nav>'s ‹ n / m › (and ←/→ on it) go through them, round the end. -->
      <ui-deck-nav class="panel-deck" id="panel-deck" lang="ko" wrap hidden></ui-deck-nav>
      <!-- 자세히 (task view T1.6): the panel shows what matters by default; on, every detail of every section. Saved per device. -->
      <button type="button" class="panel-detail-toggle" id="panel-detail-toggle" aria-pressed="false" title="모든 세부 정보 보기" onclick="togglePanelDetail()"><i data-ui-icon="list" class="pdt-icon"></i><span class="pdt-label">자세히</span></button>
      <button type="button" class="ui-icon-btn is-bordered panel-close" aria-label="작업 카드 닫기" title="작업 카드 닫기 (카드도 접힘)" onclick="closeDetailCard()"><i data-ui-icon="close"></i></button>
      <!-- Session head (spec 13, D3 E-08): <ui-status-bar> — status · this turn's time · Slack · the session's actions; an armed resume in its slot. -->
      <ui-status-bar class="panel-status" id="panel-status" lang="ko"></ui-status-bar>
    </div>
    <!-- Body (task view, SSOT 2026-10-27; section tabs 2026-10-29): one scroll area — the
         task's common surface on top, then the agent tabs (sticky) and the focused
         agent's tab: Tasks, then the section tabs 에이전트 트리 · 작업 로그 · 지시와 답변,
         each with its own scroll box. -->
    <div class="panel-body" id="panel-body">
    <div class="panel-scroll" id="panel-scroll">
      <section class="panel-surface" id="panel-surface" aria-label="작업 정보">
        <!-- 세션 정보 (spec 13): one summary line + the links, the complete numbers on demand (or with 자세히) — live. -->
        <div class="panel-info" id="panel-info"></div>
        <!-- Goal (spec 13): the editor's home — current, queue, add / delete, completed goals. -->
        <div class="panel-goal" id="panel-goal" role="region" tabindex="-1" aria-label="Goal" style="display:none"></div>
        <!-- 입력 필요 (re-agent-run D8–D17): a head with the count (kit section head + count, D3 E-13), approval cards for the
             permission prompts and the question; one polite status line says arrivals and
             answers (the cards themselves are not a live region — their expiry clock ticks). -->
        <div class="ui-section-head panel-needs-head" id="panel-needs-head" tabindex="-1" hidden><h4>입력 필요</h4><span class="ui-count" id="panel-needs-count" data-tone="wait" data-pop></span></div>
        <div class="panel-permission" id="panel-permission" style="display:none"></div>
        <div class="panel-question" id="panel-question" style="display:none"></div>
        <p class="ar-vh" id="panel-needs-status" role="status" aria-live="polite"></p>
        <!-- 산출물 (SSOT 2026-10-23 T6): what the task produced, and the files the user attached. -->
        <div class="panel-artifacts" id="panel-artifacts" style="display:none"></div>
      </section>
      <!-- Agent tabs (task view T1.2): Main always first and pinned at the left, then every subagent in spawn order. -->
      <div class="panel-tabs" id="panel-tabs" role="tablist" aria-label="에이전트" aria-orientation="horizontal"></div>
      <section class="panel-tabpanel" id="panel-tabpanel" role="tabpanel" aria-labelledby="panel-tab-main" tabindex="-1">
        <!-- The focused agent (.prd/12 §4.3): its header; with 자세히, its path. -->
        <div class="panel-agents" id="panel-agents" style="display:none"></div>
        <!-- Tasks (task view T1.3): folded to one line by default. -->
        <div class="panel-tasks" id="panel-tasks" role="region" aria-label="Tasks" tabindex="-1"></div>
        <!-- Section tabs (SSOT 2026-10-29): only the active section is in the DOM; each
             opens on its newest items and pages back as the reader scrolls up (a top
             control is the keyboard path), in its own scroll box. -->
        <!-- SSOT 2026-10-29 T6: Chat (지시와 답변) first and the default; 에이전트 트리 at the strip's right end — the bottom view's top right. -->
        <div class="panel-sections" id="panel-sections" role="tablist" aria-label="섹션" aria-orientation="horizontal">
          <button type="button" class="psec-tab" role="tab" id="psec-tab-conv" data-sec="conv" aria-selected="true" aria-controls="psec-conv" tabindex="0" title="지시와 답변">Chat</button>
          <button type="button" class="psec-tab" role="tab" id="psec-tab-log" data-sec="log" aria-selected="false" aria-controls="psec-log" tabindex="-1">작업 로그</button>
          <button type="button" class="psec-tab psec-tab-tree" role="tab" id="psec-tab-tree" data-sec="tree" aria-selected="false" aria-controls="psec-tree" tabindex="-1"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="3.5" r="1.6"/><circle cx="12" cy="8" r="1.6"/><circle cx="12" cy="12.5" r="1.6"/><path d="M4 5.1v5.4c0 1.1.9 2 2 2h4.4M4 8h6.4"/></svg>에이전트 트리</button>
        </div>
        <div class="panel-sections-body" id="panel-sections-body">
          <div class="psec" id="psec-tree" role="tabpanel" aria-labelledby="psec-tab-tree" tabindex="0" hidden>
            <button type="button" class="psec-older" data-sec="tree" hidden>이전 에이전트 보기</button>
            <p class="psec-start" hidden>에이전트 트리의 시작</p>
            <div class="psec-body panel-tree" id="panel-tree"></div>
          </div>
          <!-- 작업 로그 (D3 F-01..F-10): @2lab.ai/ui <ui-work-log> — task groups, entry rows, the raw viewer,
               child agents, its own scroll box (pages older entries in on scroll-up); the tool cards are
               this page's <ui-tool-call-card> children in each entry's tool-<seq> slot (wlPaint). -->
          <div class="psec psec-el ui-tok" id="psec-log" role="tabpanel" aria-labelledby="psec-tab-log" hidden>
            <ui-work-log class="worklog-list" id="worklog-list" lang="ko"></ui-work-log>
          </div>
          <!-- 지시와 답변 (D3 G-01..G-13, E-25): @2lab.ai/ui <ui-conversation> — its own scroll box
               (<ui-log-scroller>: follows the newest turn, keeps the place while older pages go in
               above, the "new" pill); the dashboard hands it turns (convPaint) and answers
               ui-load-older / ui-retry. The files beside a turn are its slotted children. -->
          <div class="psec psec-el ui-tok" id="psec-conv" role="tabpanel" aria-labelledby="psec-tab-conv">
            <ui-conversation class="panel-conv" id="panel-conv" lang="ko"></ui-conversation>
          </div>
          <!-- New items while the reader is up the list: one press goes to the newest. -->
          <button type="button" class="psec-pill" id="psec-pill" hidden></button>
        </div>
      </section>
    </div>
    </div>
    <!-- Command row is always visible: read-only for a viewer who is not the owner, off once the session ended. -->
    <div class="panel-command" id="panel-command">
      <!-- Model · effort beside the composer (spec 13): their own container — the input is never morphed. -->
      <div class="panel-controls" id="panel-controls" aria-label="이 세션의 모델과 effort"></div>
      <!-- The composer and the session's follow-up queue — @2lab.ai/ui <ui-agent-steering> (dashboard batch 2):
           multiline; images by paste, drop or picker; files; voice. Its slots hold this page's tools and file chips.
           The token wrapper (.ui-tok) hands it the dashboard tokens; renderPanelComposer gives it its data. -->
      <div class="ui-tok pc-steer-wrap">
        <ui-agent-steering id="cmd-steer" lang="ko">
          <div slot="attachments" class="pc-top">
            <div class="pc-attachments" id="pc-attachments" aria-live="polite" aria-label="첨부 파일"></div>
            <div class="nt-recorder pc-recorder" id="pc-recorder" role="status" aria-label="녹음 중" hidden><span class="nt-rec-dot" aria-hidden="true"></span><span id="pc-rec-time">0:00</span><span class="nt-rec-meter" aria-hidden="true"><span class="nt-rec-level" id="pc-rec-level"></span></span><button type="button" class="nt-rec-btn" onclick="pcStopRecording(false)">취소</button><button type="button" class="nt-rec-btn is-primary" onclick="pcStopRecording(true)">완료</button></div>
            <p class="pc-error" id="pc-error" role="alert" hidden></p>
          </div>
          <span slot="tools" class="pc-tools">
            <button type="button" class="ui-icon-btn pc-tool" id="pc-attach" aria-label="파일 첨부" title="파일 첨부" onclick="document.getElementById('pc-file-input').click()"><i data-ui-icon="attach"></i></button>
            <button type="button" class="ui-icon-btn pc-tool" id="pc-image" aria-label="이미지 첨부" title="이미지 첨부 (붙여넣기·끌어놓기도 됩니다)" onclick="document.getElementById('pc-image-input').click()"><i data-ui-icon="image"></i></button>
            <button type="button" class="ui-icon-btn pc-tool pc-tool-mic" id="pc-mic" aria-label="음성 녹음" aria-pressed="false" title="음성 녹음" onclick="pcToggleRecording()"><i data-ui-icon="mic"></i></button>
            <input type="file" id="pc-file-input" multiple hidden onchange="pcAddFiles(this.files); this.value = ''">
            <input type="file" id="pc-image-input" accept="image/*" multiple hidden onchange="pcAddFiles(this.files); this.value = ''">
            <input type="file" id="pc-audio-input" accept="audio/*" capture hidden onchange="pcAddFiles(this.files); this.value = ''">
          </span>
        </ui-agent-steering>
      </div>
    </div>
  </div>

  <!-- New task (SSOT 2026-10-23): floating button (phones, and PC once the top-bar
       button scrolls away), the composer dialog, and the launch toast. -->
  <button type="button" class="new-task-fab" id="new-task-fab" aria-label="새 작업 시작" onclick="openNewTask()"><i data-ui-icon="plus" class="nt-fab-icon"></i><span class="nt-fab-label">새 작업</span></button>
  <dialog id="nt-dialog" class="nt-dialog" aria-labelledby="nt-title" onclose="ntOnClosed()">
    <form id="nt-form" class="nt-form" onsubmit="submitNewTask(event)" novalidate>
      <header class="nt-head">
        <button type="button" class="ui-icon-btn nt-close" aria-label="닫기" onclick="closeNewTask()"><i data-ui-icon="close"></i></button>
        <h2 id="nt-title">새 작업</h2>
        <span class="nt-head-hint" aria-hidden="true">Esc</span>
      </header>
      <div class="nt-body" id="nt-body">
        <div class="nt-config" role="group" aria-label="작업 설정">
          <div class="nt-chip nt-chip-model"><label for="nt-model">모델</label><select id="nt-model" onchange="ntOnModelChange()"></select><button type="button" class="nt-battery-btn nt-batt-unknown" id="nt-battery-btn" aria-expanded="false" aria-controls="nt-usage" onclick="ntToggleUsage()"><span class="nt-battery" id="nt-battery" role="img" aria-label="잔여량 미확인"><span class="nt-battery-fill" id="nt-battery-fill"></span></span><span class="nt-battery-pct" id="nt-battery-pct">?</span></button></div>
          <div class="nt-chip"><label for="nt-effort">effort</label><select id="nt-effort" onchange="ntOnEffortChange()"></select></div>
          <div class="nt-chip nt-chip-channel"><label for="nt-channel">채널</label><select id="nt-channel" onchange="ntOnChannelChange()"></select></div>
        </div>
        <p class="nt-usage" id="nt-usage" hidden></p>
        <div class="nt-toggles" role="group" aria-label="자동 진행">
          <button type="button" class="nt-toggle" id="nt-autogoal" aria-pressed="false" title="이 작업의 첫 지시에만 적용 — 처음 값은 내 autogoal 설정, 설정 자체는 바뀌지 않습니다" onclick="ntToggle('autogoal')"><span class="nt-switch" aria-hidden="true"></span><span>autogoal</span></button>
          <button type="button" class="nt-toggle" id="nt-autoz" aria-pressed="false" title="켜면 지시 끝에 $autoz를 붙여 autoz 스킬이 끝까지 자동으로 진행합니다" onclick="ntToggle('autoz')"><span class="nt-switch" aria-hidden="true"></span><span>autoz</span></button>
          <span class="nt-toggle-note">이 작업에만 적용 · 설정은 그대로</span>
        </div>
        <div class="nt-compose" id="nt-compose">
          <label class="nt-sr" for="nt-prompt">작업 지시</label>
          <textarea id="nt-prompt" class="nt-prompt" rows="6" placeholder="무엇을 할까요? 예) soma-work 대시보드 개선해줘" oninput="ntOnInput()"></textarea>
          <span class="nt-count" id="nt-count" aria-hidden="true"></span>
          <div class="nt-drop-hint" aria-hidden="true">여기에 놓으면 첨부됩니다</div>
        </div>
        <div class="nt-attachments" id="nt-attachments" aria-live="polite" aria-label="첨부 파일"></div>
        <div class="nt-recorder" id="nt-recorder" role="status" aria-label="녹음 중" hidden><span class="nt-rec-dot" aria-hidden="true"></span><span id="nt-rec-time">0:00</span><span class="nt-rec-meter" aria-hidden="true"><span class="nt-rec-level" id="nt-rec-level"></span></span><button type="button" class="nt-rec-btn" onclick="ntStopRecording(false)">취소</button><button type="button" class="nt-rec-btn is-primary" onclick="ntStopRecording(true)">완료</button></div>
        <p class="nt-error" id="nt-error" role="alert" hidden></p>
      </div>
      <footer class="nt-toolbar">
        <div class="nt-tools">
          <button type="button" class="ui-icon-btn nt-tool nt-tool-camera" id="nt-camera" aria-label="사진 찍기" title="사진 찍기" onclick="ntEl('nt-camera-input').click()"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.5h3l1.5-2h6l1.5 2h3v9.5h-15z"/><circle cx="10" cy="11" r="3"/></svg></button>
          <button type="button" class="ui-icon-btn nt-tool" id="nt-attach" aria-label="파일 첨부" title="파일 첨부" onclick="ntEl('nt-file-input').click()"><i data-ui-icon="attach"></i></button>
          <button type="button" class="ui-icon-btn nt-tool nt-tool-mic" id="nt-mic" aria-label="음성 녹음" aria-pressed="false" title="음성 녹음" onclick="ntToggleRecording()"><i data-ui-icon="mic"></i></button>
          <input type="file" id="nt-camera-input" accept="image/*" capture="environment" hidden onchange="ntAddFiles(this.files, 'camera'); this.value = ''">
          <input type="file" id="nt-file-input" multiple hidden onchange="ntAddFiles(this.files, 'file'); this.value = ''">
          <input type="file" id="nt-audio-input" accept="audio/*" capture hidden onchange="ntAddFiles(this.files, 'voice'); this.value = ''">
        </div>
        <span class="nt-status" id="nt-status" role="status" aria-live="polite"></span>
        <span class="nt-submit-hint" id="nt-submit-hint" aria-hidden="true">⌘↵</span>
        <button type="submit" class="ui-btn is-primary is-lg nt-submit" id="nt-submit">작업 시작<i data-ui-icon="arrow-right"></i></button>
      </footer>
    </form>
  </dialog>
</div>
<!-- Artifacts (SSOT 2026-10-23): hover minimap + full-size viewer, shared by board and panel. -->
<div id="art-peek" class="art-peek" role="tooltip" aria-hidden="true"></div>
<dialog id="art-modal" class="art-modal" aria-labelledby="art-modal-name">
  <div class="art-modal-head">
    <span class="art-modal-kind" id="art-modal-kind"></span>
    <div class="art-modal-title"><div class="art-modal-name" id="art-modal-name"></div><div class="art-modal-meta" id="art-modal-meta"></div></div>
    <div class="art-modal-nav">
      <button type="button" class="ui-icon-btn is-bordered" id="art-modal-prev" aria-label="이전 산출물" onclick="artModalStep(-1)"><i data-ui-icon="chevron-left"></i></button>
      <span class="art-modal-pos" id="art-modal-pos"></span>
      <button type="button" class="ui-icon-btn is-bordered" id="art-modal-next" aria-label="다음 산출물" onclick="artModalStep(1)"><i data-ui-icon="chevron-right"></i></button>
    </div>
    <div class="art-modal-actions">
      <a class="ui-btn is-sm" id="art-modal-open" target="_blank" rel="noopener">새 탭</a>
      <a class="ui-btn is-sm" id="art-modal-download">다운로드</a>
      <a class="ui-btn is-sm" id="art-modal-slack" target="_blank" rel="noopener">Slack</a>
      <button type="button" class="ui-icon-btn" aria-label="닫기" onclick="closeArtifactModal()"><i data-ui-icon="close"></i></button>
    </div>
  </div>
  <div class="art-modal-body" id="art-modal-body"></div>
</dialog>

<script>
const INIT_USER = ${initUser};
// The page chrome's words, in one place and one language (the library's STRINGS pattern, lang="ko"):
// sentence case, "…" not "...", the library's short status vocabulary.
var STRINGS = {
  wsLive: '실시간',
  wsLiveLabel: '실시간 업데이트: 연결됨',
  wsReconnecting: '다시 연결 중…',
  wsReconnectingLabel: '실시간 업데이트: 다시 연결 중',
  on: '켬',
  off: '끔',
  adminOn: '관리자 켬',
  adminOff: '관리자 끔',
  viewerAdmin: '관리자',
  themeToDark: '어두운 테마로 전환',
  themeToLight: '밝은 테마로 전환',
  // P8: the panel's turn summaries, subtitle and the legacy question form — Korean, "…", no emoji.
  summaryFailed: '요약 실패',
  summaryPending: '요약 만드는 중…',
  retry: '다시 시도',
  titlePending: '부제 만드는 중…',
  titleFailed: '부제를 만들지 못했습니다',
  titleCooldown: '부제를 만들지 못했습니다 — 1분 뒤 다시 시도하세요',
  titleNoContent: '아직 부제를 붙일 대화가 없습니다',
  error: '오류',
  mcUnavailable: '복수 질문 데이터를 불러올 수 없습니다',
  mcLoadFailed: '복수 질문을 불러오지 못했습니다. 새로고침해 보세요.',
  mcCustomPlaceholder: '직접 입력…',
  effortTitle: '추론 강도',
};
// #814 — name of the dashboard's *home* instance (the one that served this
// HTML). Used by renderCard() to detect sibling cards and suppress action
// buttons that would post to the wrong instance. null when single-instance
// (no env wired) or pre-listen tests; the suppression check tolerates null.
const SELF_INSTANCE_NAME = ${initSelfInstance};
// SSOT 2026-10-29 T8: this instance's Slack bot name (null until resolved) — a card's own botName wins.
const BOT_NAME = ${initBotName};
// ui.dashboardheader (config.json#ui) — resolved card-header line composition.
// renderCard() consults this to decide which sub-blocks to emit and with
// what limits. Fields absent from the lines are hidden (isFieldVisible
// semantics on the server side).
const DASHBOARD_HEADER_CONFIG = ${initDashboardHeaderConfig};
// SSOT 2026-10-22 T4: [{ nickname, model, label, contextWindow, autoCompactTokens }]
const REPRESENTATIVE_MODELS = ${initRepresentativeModels};
const EFFORT_LEVELS = ${initEffortLevels};
// field → first config entry map (show/max/truncate lookups in renderCard).
const _dhFieldMap = {};
for (const _dhLine of DASHBOARD_HEADER_CONFIG) {
  for (const _dhField of (_dhLine.fields || [])) {
    if (!(_dhField.field in _dhFieldMap)) _dhFieldMap[_dhField.field] = _dhField;
  }
}
function dhShow(field) {
  const f = _dhFieldMap[field];
  return !!f && f.show !== false;
}
function dhMax(field, fallback) {
  const f = _dhFieldMap[field];
  return (f && typeof f.max === 'number') ? f.max : fallback;
}
function dhTruncate(field) {
  const f = _dhFieldMap[field];
  return (f && typeof f.truncate === 'number') ? f.truncate : null;
}
let currentUserId = INIT_USER || '';
// Displayed + placeholder copy when a non-owner views a session (Korean, like
// every other reason the page gives). Kept here so wording edits only touch one
// place: the action buttons, 지금 압축, the subtitle, a question card's lock.
const READ_ONLY_MSG = '읽기 전용 — 내 세션이 아닙니다';
let currentPeriod = 'day';
let ws = null;
let panelOpen = false;
let panelSessionKey = null;
let panelConvId = null;
var _panelTasksOpen = false; // the Tasks section of the focused tab is open (folded by default — task view T1.3)
var _panelTasksExpanded = false; // every completed step shown, none folded
var _panelTasksEarlier = false; // the earlier plans shown under the current one (spec 13, task view T2)
let _panelTitleSub = ''; // the subtitle the open panel shows ('' = none yet)
let _viewerIsAdmin = false; // /auth/me says ADMIN_USERS (or viewer token); UX only, the server re-checks
let _viewerUserId = ''; // the signed-in user (/auth/me) — not currentUserId, which is the board filter

// ── Theme toggle — sun/moon ──
function getPreferredTheme() {
  var saved = localStorage.getItem('soma-theme');
  if (saved) return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  var btn = document.getElementById('theme-toggle');
  if (btn) btn.setAttribute('aria-label', theme === 'light' ? STRINGS.themeToDark : STRINGS.themeToLight);
}
function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  var osTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  if (next === osTheme) {
    localStorage.removeItem('soma-theme');
  } else {
    localStorage.setItem('soma-theme', next);
  }
  applyTheme(next);
}
// Sync icon on load
applyTheme(getPreferredTheme());
// Listen for OS theme changes (if user hasn't manually chosen)
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function(e) {
  if (!localStorage.getItem('soma-theme')) {
    applyTheme(e.matches ? 'light' : 'dark');
  }
});

// ── Panel resize — drag the left edge of the docked drawer (SSOT 2026-10-24) ──
// The drag stores a width preference (--panel-w-pref, localStorage); CSS decides
// the applied width — the whole screen as a sheet (<840px), min(preference, 50vw)
// docked. JS never writes the drawer's width or right offset, so a width chosen on
// a wide screen can never push the drawer past a folded phone.
(function initPanelResize() {
  var panel = document.getElementById('slide-panel');
  var handle = document.getElementById('panel-resize-handle');
  var STORAGE_KEY = 'soma-panel-width';
  var MIN_W = 320, MAX_W = 1600;
  var root = document.documentElement;
  function applyPref(w) { root.style.setProperty('--panel-w-pref', w + 'px'); }

  var saved = NaN;
  try { saved = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10); } catch (_e) {}
  if (saved >= MIN_W && saved <= MAX_W) applyPref(saved);

  var dragging = false;
  var pref = 0;
  handle.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    pref = 0;
    try { handle.setPointerCapture(e.pointerId); } catch (_e) {}
    panel.classList.add('resizing');
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  handle.addEventListener('pointermove', function(e) {
    if (!dragging) return;
    pref = Math.round(Math.min(Math.max(window.innerWidth - e.clientX, MIN_W), window.innerWidth * 0.5));
    applyPref(pref);
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('resizing');
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (pref >= MIN_W) {
      try { localStorage.setItem(STORAGE_KEY, String(pref)); } catch (_e) {}
    }
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
})();

// ── Panel tasks rendering ──
function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  var sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ' + (sec % 60) + 's';
  var hr = Math.floor(min / 60);
  return hr + 'h ' + (min % 60) + 'm';
}

function formatTaskTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

// ── 입력 필요 — @2lab.ai/ui <ui-approval-card> (affectUI review batch 1) ──
// One element for the open card and the panel's 입력 필요: a permission prompt
// (the tool, its risk and matched dangerous-command rules, a preview of the
// input, Approve / Deny / Explain, "disable this rule", the expiry countdown)
// or the single-choice question (recommended first) — the answer in flight,
// a refusal with Retry, and the resolved row. The markup is a slot keyed by the
// request (static per request, so equal data still renders equal strings); the
// data — the prompt, the requester-only input, the answer's state — is set on
// the element by acHydrate. Answers leave it as ui-decide / ui-answer for
// answerPermission / answerChoice. The multi-question form keeps its own
// renderer (renderMultiChoicePanel): one element is one question.
//
// The board never carries the parameters (it is one document for every
// viewer): the requester's page fetches them from the requester-only route.
var _permDetails = Object.create(null); // approvalId → { input, truncated } | { error, retry?, tries?, at? }
var _permLoading = Object.create(null);
// A load that failed for a reason that may pass (the network, a 5xx) is asked
// again on a later push — AC_DETAIL_RETRY_MS after it failed, AC_DETAIL_TRIES
// loads at most, so a failing route never spins. A refusal is an answer.
var AC_DETAIL_RETRY_MS = 30000;
var AC_DETAIL_TRIES = 3;
function acDetailDue(detail, now) {
  if (!detail) return true;
  return !!detail.retry && toNum(detail.tries) < AC_DETAIL_TRIES && now - toNum(detail.at) >= AC_DETAIL_RETRY_MS;
}
// session key → { 'p|<approvalId>' | the question id → the card's state (sending · error · resolved) }.
// Per session: a question has no request id (its id is its content), so two
// sessions asking the same thing are two requests (PR #536 review P1).
var _acState = Object.create(null);
var AC_SENT = { approve: '승인을 보냈어요', deny: '거부를 보냈어요', explain: '설명을 요청했어요', approve_disable_rule: '승인을 보냈어요 · 규칙 끔' };
var AC_SIBLING = '다른 인스턴스의 세션입니다 — 그 대시보드에서 응답하세요';

function isPermissionRequester(p) {
  return !!(p && p.requesterId && currentUserId && p.requesterId === currentUserId);
}

function permissionSummary(s) {
  var list = s.pendingPermissions || [];
  if (!list.length) return '';
  return (list[0].toolName || 'tool') + ' 실행 승인 필요' + (list.length > 1 ? ' 외 ' + (list.length - 1) + '건' : '');
}

// Who may answer here, as the element's canAnswer: '' (yes) or why not. A
// prompt: its requester, on this instance. The question: the session's owner,
// on this instance (as Stop). The server re-checks both.
function acPermissionLock(s, p) {
  if (isSiblingSession(s)) return AC_SIBLING;
  return isPermissionRequester(p) ? '' : '이 요청의 요청자만 응답할 수 있습니다';
}
function acQuestionLock(s) {
  if (isSiblingSession(s)) return AC_SIBLING;
  return s.ownerId && s.ownerId === currentUserId ? '' : READ_ONLY_MSG;
}

// DashboardPermissionRequest (+ the requester's input, + this page's answer) → the card's data.
function acPermissionData(s, p) {
  var d = { kind: 'permission', id: String(p.approvalId), tool: p.toolName || 'tool', canExplain: true, canDisableRule: !!p.canDisableRule };
  var rules = (p.rules || []).map(function(r) {
    var o = { id: String(r.id), label: String(r.label || r.id) };
    if (r.description) o.description = String(r.description);
    return o;
  });
  if (rules.length) d.rules = rules;
  var created = toNum(p.createdAt);
  if (created > 0) d.createdAt = created;
  var until = toNum(p.expiresAt);
  if (until > 0) d.expiresAt = until;
  var lock = acPermissionLock(s, p);
  if (lock) {
    d.canAnswer = lock;
    d.notice = isSiblingSession(s) ? '파라미터는 그 인스턴스의 대시보드에서 볼 수 있습니다' : '파라미터는 요청자만 볼 수 있습니다';
  } else {
    var detail = _permDetails[p.approvalId];
    if (acDetailDue(detail, Date.now())) loadPermissionDetail(s.key, p.approvalId);
    if (!detail) d.loading = true;
    else if (detail.error) d.notice = detail.error;
    else {
      d.input = detail.input;
      if (detail.truncated) d.truncated = true;
    }
  }
  var st = _acState[s.key] && _acState[s.key]['p|' + p.approvalId];
  if (st) d.state = st;
  return d;
}
// A question's identity is its whole meaning — the text and every choice's id,
// label and description, serialized (no two meanings share it): a question
// rewritten in place is another card, never the old one's answer or focus
// (review R2 P1).
function acQuestionId(q) {
  return 'q|' + JSON.stringify([q.question, (q.choices || []).map(function(c) { return [c.id, c.label, c.description || '']; })]);
}
// pendingQuestion (single choice) → the card's data. The choices read as
// before ("1. label", the recommended marker stripped); the route takes one
// of them only (no free-text answer, so no allowOther).
function acQuestionData(s, q) {
  var id = acQuestionId(q);
  var d = {
    kind: 'question',
    id: id,
    question: String(q.question || ''),
    choices: q.choices.map(function(c) {
      var o = { id: String(c.id), label: c.id + '. ' + stripRecommendedMarker(c.label) };
      if (c.description) o.description = String(c.description);
      return o;
    }),
    allowOther: false,
  };
  var rec = resolveRecommendedId(q.recommendedChoiceId, q.choices);
  if (rec) d.recommendedId = String(rec);
  var lock = acQuestionLock(s);
  if (lock) d.canAnswer = lock;
  var st = _acState[s.key] && _acState[s.key][id];
  if (st) d.state = st;
  return d;
}
// A push of session key (s: its new data; none when it left the board): the
// answer states of what it no longer asks go — a prompt that left, a question
// gone or replaced. A question has no request id, so the same question asked
// again is a new, unanswered card only because the push that cleared the old
// one took its state along (PR #536 review P1).
function acEvict(key, s) {
  var states = _acState[key];
  if (!states) return;
  var keep = Object.create(null);
  var list = (s && s.pendingPermissions) || [];
  for (var i = 0; i < list.length; i++) keep['p|' + list[i].approvalId] = true;
  var q = s && s.pendingQuestion;
  if (q && q.type === 'user_choice' && q.choices) keep[acQuestionId(q)] = true;
  var left = 0;
  for (var id in states) {
    if (keep[id]) left++;
    else delete states[id];
  }
  if (!left) delete _acState[key];
}

// One request's slot: the token wrapper (.ui-tok) keyed by the request — a
// live morph never hands one request's element (its focus, an answer in
// flight) to another — the element, and a light-DOM line until the library
// has loaded.
function acSlotHtml(key, kind, mk, id, fallback) {
  return '<div class="ui-tok ac-slot" data-mk="' + escAttr('ac|' + mk) + '">'
    + '<ui-approval-card lang="ko" data-ac-key="' + escAttr(key) + '" data-ac-kind="' + kind + '"' + (id ? ' data-ac-id="' + escAttr(id) + '"' : '') + '>'
    + '<span class="ac-fallback">' + esc(fallback) + '</span></ui-approval-card></div>';
}
function acPermissionsHtml(s) {
  return ((s && s.pendingPermissions) || []).map(function(p) {
    return acSlotHtml(s.key, 'perm', 'p|' + p.approvalId, String(p.approvalId), (p.toolName || 'tool') + ' 실행 승인 — 응답 대기');
  }).join('');
}
function acQuestionHtml(s, q) {
  return acSlotHtml(s.key, 'question', acQuestionId(q), '', '질문 — ' + String(q.question || ''));
}
// A collapsed card paints no approval card (placeCard), but the requester's
// input is still fetched as the card's would be (acPermissionData), so opening
// the card shows it at once.
function acPrefetch(s, col) {
  var list = col === 'closed' ? [] : (s && s.pendingPermissions) || [];
  var now = Date.now();
  for (var i = 0; i < list.length; i++) {
    if (acDetailDue(_permDetails[list[i].approvalId], now) && !acPermissionLock(s, list[i])) loadPermissionDetail(s.key, list[i].approvalId);
  }
}

// What one slot's element shows now, from the session it belongs to.
function acDataFor(el) {
  var s = _sessionCache[el.getAttribute('data-ac-key')];
  if (!s) return null;
  if (el.getAttribute('data-ac-kind') === 'question') {
    var q = s.pendingQuestion;
    return q && q.type === 'user_choice' && q.choices ? acQuestionData(s, q) : null;
  }
  var id = el.getAttribute('data-ac-id');
  var list = s.pendingPermissions || [];
  for (var i = 0; i < list.length; i++) if (String(list[i].approvalId) === id) return acPermissionData(s, list[i]);
  return null;
}
// Set every approval card's data under root — only what changed (a push that
// changes nothing on a card does not re-render it). Data set before the
// element is defined is picked up when it upgrades.
function acHydrate(root) {
  if (!root || !root.querySelectorAll) return;
  var els = root.querySelectorAll('ui-approval-card[data-ac-key]');
  for (var i = 0; i < els.length; i++) {
    var d = acDataFor(els[i]);
    if (!d) continue;
    var sig = JSON.stringify(d);
    if (els[i]._acSig === sig) continue;
    els[i]._acSig = sig;
    els[i].data = d;
  }
}
// Re-draw what shows this session's prompts (its card, the open panel).
function acRepaint(key) {
  refreshCard(key);
  var s = _sessionCache[key];
  if (panelOpen && panelSessionKey === key && s) {
    renderPanelPermission(s);
    renderPanelQuestion(s);
  }
}

// The answers leave the element as composed events, retargeted to it here.
document.addEventListener('ui-decide', function(e) {
  var el = e.target;
  if (!el || !el.getAttribute || !e.detail || el.getAttribute('data-ac-kind') !== 'perm') return;
  answerPermission(el.getAttribute('data-ac-key'), String(e.detail.id), String(e.detail.decision));
});
document.addEventListener('ui-answer', function(e) {
  var el = e.target;
  if (!el || !el.getAttribute || !e.detail || el.getAttribute('data-ac-kind') !== 'question') return;
  answerChoice(el.getAttribute('data-ac-key'), String(e.detail.id), e.detail.choiceId === undefined ? '' : String(e.detail.choiceId));
});

// The pending question in the panel: the single-choice question is an
// approval card (written only when it changed, morphed so focus stays); the
// multi-question form keeps its own renderer.
function renderPanelQuestion(s) {
  var container = document.getElementById('panel-question');
  if (!container) return;
  renderPanelNeedsHead(s);
  var ae = document.activeElement;
  var had = !!(ae && container.contains && container.contains(ae));
  var q = s && s.activityState === 'waiting' ? s.pendingQuestion : null;
  if (!q) {
    container.style.display = 'none';
    container.innerHTML = '';
    container._html = '';
  } else if (q.type === 'user_choice' && q.choices) {
    container.style.display = '';
    container.setAttribute('data-ap', 'card');
    var html = acQuestionHtml(s, q);
    if (container._html !== html) {
      morphInnerHtml(container, html);
      container._html = html;
    }
    acHydrate(container);
  } else if (q.type === 'user_choices' && q.questions) {
    container.style.display = '';
    container.setAttribute('data-ap', 'form');
    container._html = '';
    renderMultiChoicePanel(s);
  } else {
    container.style.display = 'none';
  }
  if (had && !container.contains(document.activeElement)) apSafeFocus();
}

// The prompts in the panel. A prompt that arrives while the panel is open is
// said once in the status line (the first render of an opening is the
// baseline); an answer's outcome is said by its own card. Unchanged markup
// writes nothing; a change is morphed, so focus in a card stays in it.
function renderPanelPermission(s) {
  var container = document.getElementById('panel-permission');
  if (!container) return;
  var list = (s && s.pendingPermissions) || [];
  var key = s ? s.key : '';
  var seen = container._seenKey === key ? container._seen : null;
  var ids = Object.create(null);
  var said = [];
  for (var i = 0; i < list.length; i++) {
    ids[list[i].approvalId] = true;
    if (seen && !seen[list[i].approvalId]) said.push('승인 요청 — ' + (list[i].toolName || 'tool'));
  }
  container._seenKey = key;
  container._seen = ids;
  renderPanelNeedsHead(s);
  var html = s ? acPermissionsHtml(s) : '';
  var ae = document.activeElement;
  var had = !!(ae && container.contains(ae));
  if (!html) {
    container.style.display = 'none';
    container.innerHTML = '';
    container._html = '';
  } else {
    container.style.display = '';
    if (container._html !== html) {
      morphInnerHtml(container, html);
      container._html = html;
    }
    acHydrate(container);
  }
  if (had && !container.contains(document.activeElement)) apSafeFocus();
  if (said.length) apAnnounce(said.join('. '));
}
// Focus that was in a card that left (answered and gone, or a question
// rewritten in place): a place that answers nothing — the 입력 필요 head, else
// the panel title. Never a decision (re-agent-run D14).
function apSafeFocus() {
  var head = document.getElementById('panel-needs-head');
  var to = head && !head.hidden ? head : document.getElementById('panel-title');
  if (to && to.focus) to.focus({ preventScroll: true });
}
// The status line of 입력 필요 (polite, always in the page).
function apAnnounce(msg) {
  var el = document.getElementById('panel-needs-status');
  if (el) el.textContent = msg;
}
// D9: the head of the section — 입력 필요 + how many things wait on the user.
function panelQuestionShown(s) {
  var q = s && s.pendingQuestion;
  if (!q || s.activityState !== 'waiting') return false;
  return (q.type === 'user_choice' && !!q.choices) || q.type === 'user_choices';
}
function renderPanelNeedsHead(s) {
  var head = document.getElementById('panel-needs-head');
  if (!head) return;
  var n = s ? ((s.pendingPermissions || []).length + (panelQuestionShown(s) ? 1 : 0)) : 0;
  head.hidden = n === 0;
  var count = document.getElementById('panel-needs-count');
  if (count && count.textContent !== String(n)) count.textContent = String(n);
}
// The first card in root still waiting on an answer (not a resolved row).
function acFirstOpen(root) {
  if (!root || root.style.display === 'none') return null;
  var els = root.querySelectorAll('ui-approval-card');
  for (var i = 0; i < els.length; i++) if (els[i].status !== 'resolved') return els[i];
  return null;
}

function loadPermissionDetail(key, approvalId) {
  if (_permLoading[approvalId]) return;
  _permLoading[approvalId] = true;
  var prev = _permDetails[approvalId];
  var tries = (prev && prev.error ? toNum(prev.tries) : 0) + 1;
  // retry: the failure may pass (acDetailDue) — the network, a 5xx, 429; any other status is an answer.
  function failed(text, retry) {
    _permDetails[approvalId] = { error: text, retry: retry, tries: tries, at: Date.now() };
  }
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/permission/' + encodeURIComponent(approvalId);
  fetch(url)
    .then(function(res) {
      return res.json().catch(function() { return {}; }).then(function(body) {
        if (res.ok && typeof body.input === 'string') {
          _permDetails[approvalId] = { input: body.input, truncated: !!body.truncated };
        } else if (res.status === 404) {
          _permDetails[approvalId] = { error: '이미 응답되었거나 만료된 요청입니다' };
        } else {
          failed((body && body.error) || ('파라미터를 불러오지 못했습니다 (' + res.status + ')'), res.status >= 500 || res.status === 429);
        }
      });
    })
    .catch(function() { failed('파라미터를 불러오지 못했습니다', true); })
    .then(function() {
      delete _permLoading[approvalId];
      acRepaint(key);
    });
}

// POST with the CSRF retry (a 403 after the JWT rotated refreshes the token once).
async function acPost(url, body) {
  var headers = { 'Content-Type': 'application/json' };
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  var res = await fetch(url, { method: 'POST', headers: headers, body: body });
  if (res.status === 403) {
    await refreshCsrfToken();
    var retryHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
    res = await fetch(url, { method: 'POST', headers: retryHeaders, body: body });
  }
  return res;
}
// A refused answer as the card's error: the server's reason; a request that is
// gone (404) or already answered elsewhere (409) is final — no Retry.
async function acRefusal(res) {
  var data = {};
  try { data = await res.json(); } catch (_e) {}
  return { status: 'error', message: (data && data.error) || ('응답을 보내지 못했어요 (HTTP ' + res.status + ')'), retry: res.status !== 409 && res.status !== 404 };
}
function acToolOf(key, approvalId) {
  var s = _sessionCache[key];
  var list = (s && s.pendingPermissions) || [];
  for (var i = 0; i < list.length; i++) if (String(list[i].approvalId) === approvalId) return list[i].toolName || 'tool';
  return '';
}

// One answer per prompt. The card shows it in flight, then its resolved row —
// the permission MCP server takes the answer within a second and the board
// push removes the prompt, so a toast says it went through after the card is
// gone. A refusal stays on the card (the state): its reason, and Retry unless
// the request is gone or was answered elsewhere.
// ── Results as toasts — @2lab.ai/ui <ui-toaster> (affectUI review batch 1) ──
// One page stack for what an action did: Stop / Close / Trash, the answers,
// the multi-choice form, a launched task. The element sits in a token wrapper
// (.ui-tok, display: contents) — the dashboard tokens reach it resolved; on the
// element itself the mapping would be a custom-property cycle.
var _dashToastQ = null;
var _dashToastAct = Object.create(null); // toast id → what its action does
function dashToaster() {
  var t = document.getElementById('dash-toaster');
  if (t) return t;
  var wrap = document.createElement('div');
  wrap.className = 'ui-tok';
  wrap.style.display = 'contents';
  t = document.createElement('ui-toaster');
  t.id = 'dash-toaster';
  t.setAttribute('lang', 'ko');
  wrap.appendChild(t);
  document.body.appendChild(wrap);
  return t;
}
// Show a toast; onAction runs when its action (Retry, 카드 열기 …) is pressed.
// Before the library module has run, toasts wait and show once it is defined.
function dashToast(input, onAction) {
  var t = dashToaster();
  if (typeof t.show !== 'function') {
    if (!_dashToastQ) {
      _dashToastQ = [];
      if (window.customElements && customElements.whenDefined) {
        customElements.whenDefined('ui-toaster').then(function() {
          var q = _dashToastQ || [];
          _dashToastQ = null;
          for (var i = 0; i < q.length; i++) dashToast(q[i][0], q[i][1]);
        });
      }
    }
    _dashToastQ.push([input, onAction]);
    return '';
  }
  var id = t.show(input);
  if (onAction) _dashToastAct[id] = onAction;
  return id;
}
document.addEventListener('ui-action', function(e) {
  var d = e.detail;
  if (!d || !e.target || e.target.id !== 'dash-toaster') return;
  var fn = _dashToastAct[d.id];
  if (fn) fn(d.actionId);
});
document.addEventListener('ui-dismiss', function(e) {
  if (e.detail && e.target && e.target.id === 'dash-toaster') delete _dashToastAct[e.detail.id];
});
var DA_LABEL = { stop: '중지', close: '닫기', trash: '휴지통으로 이동' };
var DA_DONE = { stop: '세션을 중지했어요', close: '세션을 닫았어요', trash: '휴지통으로 옮겼어요' };

async function answerPermission(key, approvalId, decision) {
  var sk = 'p|' + approvalId;
  var states = _acState[key] || (_acState[key] = Object.create(null));
  var cur = states[sk];
  if (cur && (cur.status === 'sending' || cur.status === 'resolved')) return cur;
  states[sk] = { status: 'sending', decision: decision };
  acRepaint(key);
  var st;
  try {
    var res = await acPost('/api/dashboard/session/' + encodeURIComponent(key) + '/permission', JSON.stringify({ approvalId: approvalId, decision: decision }));
    if (res.ok) {
      st = { status: 'resolved', outcome: decision === 'deny' ? 'denied' : decision === 'explain' ? 'explained' : 'approved', at: Date.now() };
      if (decision === 'approve_disable_rule') st.ruleDisabled = true;
      dashToast({ title: AC_SENT[decision] || '응답을 보냈어요', description: acToolOf(key, approvalId), tone: 'success' });
    } else st = await acRefusal(res);
  } catch (e) {
    console.error('Permission answer error', e);
    st = { status: 'error', message: '네트워크 오류 — 다시 시도하세요', retry: true };
  }
  // Kept only while the session still asks it (a push may have taken it meanwhile).
  var still = ((_sessionCache[key] && _sessionCache[key].pendingPermissions) || []).some(function(p) { return String(p.approvalId) === String(approvalId); });
  if (still) (_acState[key] || (_acState[key] = Object.create(null)))[sk] = st;
  else acDrop(key, sk);
  acRepaint(key);
  return st;
}
// Forget one answer state (and the session's map once it is empty).
function acDrop(key, id) {
  var states = _acState[key];
  if (!states) return;
  delete states[id];
  for (var k in states) return;
  delete _acState[key];
}

// The single-choice answer, from the card or the panel (the same element): the
// choice travels with its label and the question, as the route wants. Same
// states as a prompt; a question that changed meanwhile takes no answer.
async function answerChoice(key, qid, choiceId) {
  var s = _sessionCache[key];
  var q = s && s.pendingQuestion;
  if (!q || q.type !== 'user_choice' || !q.choices || acQuestionId(q) !== qid) return null;
  var c = null;
  for (var i = 0; i < q.choices.length; i++) if (String(q.choices[i].id) === choiceId) c = q.choices[i];
  if (!c) return null;
  var states = _acState[key] || (_acState[key] = Object.create(null));
  var cur = states[qid];
  if (cur && (cur.status === 'sending' || cur.status === 'resolved')) return cur;
  states[qid] = { status: 'sending', choiceId: choiceId };
  acRepaint(key);
  var label = stripRecommendedMarker(c.label);
  var st;
  try {
    var res = await acPost('/api/dashboard/session/' + encodeURIComponent(key) + '/answer-choice', JSON.stringify({ choiceId: choiceId, label: label, question: q.question }));
    if (res.ok) {
      st = { status: 'resolved', outcome: 'answered', choiceId: choiceId, at: Date.now() };
      dashToast({ title: '답을 보냈어요', description: label, tone: 'success' });
    } else st = await acRefusal(res);
  } catch (e) {
    console.error('Answer choice error', e);
    st = { status: 'error', message: '네트워크 오류 — 다시 시도하세요', retry: true };
  }
  // Kept only while the session still asks this question: once a push took it
  // away (answered here or in Slack), a late result would otherwise answer the
  // next identical question.
  var nq = _sessionCache[key] && _sessionCache[key].pendingQuestion;
  if (nq && nq.type === 'user_choice' && nq.choices && acQuestionId(nq) === qid) (_acState[key] || (_acState[key] = Object.create(null)))[qid] = st;
  else acDrop(key, qid);
  acRepaint(key);
  return st;
}

// The panel's Tasks section (dashboard task view T1.3): a disclosure in the
// tab of the focused agent, folded by default. Folded, its head is the plan in
// one line — the step in progress, how many tasks ran and completed, what is
// left, how many a new plan dropped before they ran. Opened (SSOT 2026-10-29
// T5): the tasks that ran in the order they ran (a row opens its detail), the
// plan left, the dropped-before-running toggle and the totals. The first
// render of a scope is the baseline; a step that completes after it is
// announced (and its marker pops) once.
function renderPanelTasks(tasks, scopeLabel, earlier, outside) {
  var container = document.getElementById('panel-tasks');
  if (!container) return;
  container.style.display = '';
  var list = tasks || [];
  var prev = earlier || [];
  // Spec 12: a subagent's own tasks are labelled with that agent.
  var title = 'Tasks' + (scopeLabel ? ' <span class="tasks-scope">&middot; ' + esc(scopeLabel) + '</span>' : '');

  // D7: a step that completed since the last render of this scope is announced
  // (none on its first). An empty list is a baseline as well.
  var scope = scopeLabel || '';
  var seen = container._planScope === scope ? container._planSeen : null;
  var now = Object.create(null);
  var said = [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    now[t.id] = t.status;
    if (seen && seen[t.id] && seen[t.id] !== t.status && t.status === 'completed') said.push(t.id + ' 완료: ' + t.content);
  }
  container._planScope = scope;
  container._planSeen = now;

  var head = '<button type="button" class="panel-sec-head panel-tasks-header" aria-expanded="' + (_panelTasksOpen ? 'true' : 'false') + '"'
    + (_panelTasksOpen ? ' aria-controls="panel-tasks-body"' : '') + ' onclick="togglePanelTasks()">'
    + '<span class="ps-sec-title">' + title + '</span>'
    + '<span class="ps-sec-sum">' + planSummaryHtml(list, prev) + '</span>'
    + PI_CHEV_SVG + '</button>';
  var live = '<span class="ar-vh pl-live" role="status" aria-live="polite">' + esc(said.join('. ')) + '</span>';
  if (!_panelTasksOpen) { writePanelTasks(container, head + live); return; }

  // SSOT 2026-10-29 T5, D3 E-22/E-23: the tasks that actually ran, in the order
  // they ran — @2lab.ai/ui <ui-task-runs>: a row per run (status, start, run
  // time, tokens, tool calls) that opens its detail in place (start / end,
  // tokens in / out / cache, the tool calls of the main agent and of its
  // subagents, cost, the task's earlier texts) — past TASK_RUNS_SHOWN only the
  // newest, the older behind one toggle; then what is left of the plan —
  // <ui-task-plan>, the tasks a new plan dropped before they ran in its earlier
  // fold, its empty state while there is no list — then the sums (the runs' and
  // the work no task got). The model rewrites its list as it goes: the ledger
  // keeps a rewritten task as one task (its earlier texts in the detail).
  var runs = taskRunsOf(list, prev);
  var hiddenRuns = _panelTasksExpanded ? 0 : Math.max(0, runs.ran.length - TASK_RUNS_SHOWN);
  var body = '';
  if (runs.ran.length > TASK_RUNS_SHOWN) {
    body += '<div class="pl-fold">' + (_panelTasksExpanded
      ? '<button type="button" class="panel-tasks-toggle" onclick="_panelTasksExpanded=false;repaintPanelTasks()"><span class="chev is-up" aria-hidden="true"></span>최근 ' + TASK_RUNS_SHOWN + '개만 보기</button>'
      : '<button type="button" class="panel-tasks-toggle" onclick="_panelTasksExpanded=true;repaintPanelTasks()"><span class="chev" aria-hidden="true"></span>이전 실행 ' + hiddenRuns + '개 보기</button>') + '</div>';
  }
  if (runs.ran.length) body += '<ui-task-runs class="panel-task-runs" id="panel-task-runs" lang="ko"></ui-task-runs>';
  if (runs.plan.length || runs.skipped.length || !runs.ran.length) body += '<ui-task-plan class="panel-task-plan" id="panel-task-plan" lang="ko"></ui-task-plan>';
  var html = head + '<div class="panel-tasks-body ui-tok" id="panel-tasks-body">' + body
    + (runs.ran.length || outside ? taskTotalsHtml(runs.ran, outside) : '') + '</div>' + live;
  writePanelTasks(container, html);
  var runsEl = document.getElementById('panel-task-runs');
  if (runsEl) {
    taskElData(runsEl, { title: '실행된 태스크', runs: taskRunsData(runs.ran.slice(hiddenRuns)), totals: false });
    taskRunsRestore(runsEl);
  }
  var planEl = document.getElementById('panel-task-plan');
  if (planEl) taskElData(planEl, taskPlanData(runs));
  // Same data (a session push while a subagent is shown) writes nothing; a
  // change is morphed, so the focused toggle, a row and each element stay.
  function writePanelTasks(el, markup) {
    if (el._html === markup) return false;
    morphInnerHtml(el, markup);
    el._html = markup;
    return true;
  }
}
// An element's data, set only when it changed (an unchanged push re-renders nothing).
function taskElData(el, d) {
  var sig = JSON.stringify(d);
  if (el._taskSig === sig) return;
  el._taskSig = sig;
  el.data = d;
}
function togglePanelTasks() {
  _panelTasksOpen = !_panelTasksOpen;
  repaintPanelTasks();
}
// The folded head's one line (SSOT 2026-10-29 T5): the step in progress (its
// activeForm), then how many tasks ran and completed, what is left of the plan,
// and how many a new plan dropped before they ran.
function planSummaryHtml(tasks, earlier) {
  var runs = taskRunsOf(tasks, earlier);
  var parts = [];
  var cur = null;
  var done = 0;
  for (var i = 0; i < runs.ran.length; i++) {
    var f = taskFateOf(runs.ran[i]);
    if (f === 'done') done++;
    if (!cur && f === 'active') cur = runs.ran[i];
  }
  if (cur) parts.push('<span class="ps-sec-now">' + agentIconHtml('running') + esc(cur.activeForm || cur.content || '') + '</span>');
  if (runs.ran.length || runs.plan.length) {
    parts.push('실행 ' + runs.ran.length + ' · 완료 ' + done);
    if (runs.plan.length) parts.push('남은 ' + runs.plan.length);
  } else parts.push('목록 없음');
  if (runs.skipped.length) parts.push('빠짐 ' + runs.skipped.length);
  return parts.join('<span class="pi-dot" aria-hidden="true">&middot;</span>');
}
// ── Task fates (dashboard task view T2) ──
// TodoWrite replaces the whole list. What a task is, in one word:
//   done     — completed
//   active   — in progress, and the session (or agent) runs now
//   paused   — it had started; the session stopped before it completed (the
//              server shows an idle session's in-progress task as pending,
//              keeping its start time)
//   pending  — waiting its turn in the current list
//   dropped  — it ran, then a later list replaced it (교체됨 — its work stays on it)
//   skipped  — a later list dropped it before it ever ran (실행 안 됨)
// Only 'active' spins or ticks; a dropped task is never running or waiting.
var TASK_FATE_LABEL = { done: '완료', active: '진행 중', paused: '멈춤', pending: '대기', dropped: '교체됨', skipped: '실행 안 됨' };
function taskFateOf(t) {
  if (!t) return 'pending';
  if (t.dropped === 'started') return 'dropped';
  if (t.dropped === 'unstarted') return 'skipped';
  if (t.status === 'completed') return 'done';
  if (t.status === 'in_progress') return 'active';
  // It ran (and went back to waiting): paused — its run and numbers stay (review R1).
  return toNum(t.startedAt) > 0 || toNum(t.firstStartedAt) > 0 ? 'paused' : 'pending';
}
// The focused node's earlier task lists: the main agent's (s.earlierTasks) or
// the focused subagent's own.
function panelAgentEarlier() {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  if (!_panelAgent) return (s && s.earlierTasks) || [];
  var a = panelAgentOf(s);
  return (a && a.earlierTasks) || [];
}
function repaintPanelTasks() {
  renderPanelTasks(panelAgentTasks(), panelAgentLabel(), panelAgentEarlier(), panelAgentOutside());
}
// Work no task of the main agent got (a subagent's tab has none of its own).
function panelAgentOutside() {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  return !_panelAgent && s ? s.tasksOutside || null : null;
}

// ── Task runs (SSOT 2026-10-29 T5) ──
// The executed task list: every task that ran — completed, running, paused, or
// replaced by a new plan after it ran — oldest start first; the plan left (the
// current list's tasks that never started); and the tasks a new plan dropped
// before they ran.
var TASK_RUNS_SHOWN = 12; // runs shown before the oldest fold
var _panelTaskOpen = Object.create(null); // task id → its run's detail is open
function taskRunsOf(current, earlier) {
  var ran = [];
  var plan = [];
  var skipped = [];
  var all = (current || []).concat(earlier || []);
  for (var i = 0; i < all.length; i++) {
    var t = all[i];
    if (!t) continue;
    var f = taskFateOf(t);
    if (f === 'skipped') skipped.push(t);
    else if (f === 'pending') plan.push(t);
    else ran.push(t);
  }
  ran.sort(function(a, b) { return taskRunStart(a) - taskRunStart(b) || taskIdNum(a) - taskIdNum(b); });
  return { ran: ran, plan: plan, skipped: skipped };
}
function taskIdNum(t) { var m = /^T(\\d+)$/.exec(String((t && t.id) || '')); return m ? Number(m[1]) : 0; }
function taskRunStart(t) { return toNum(t.firstStartedAt) || toNum(t.startedAt) || toNum(t.completedAt) || toNum(t.removedAt); }
// When the run ended: completed, or left the plan (replaced); 0 while it runs or is paused.
function taskRunEnd(t) {
  var f = taskFateOf(t);
  if (f === 'done') return toNum(t.completedAt);
  if (f === 'dropped') return toNum(t.removedAt);
  return 0;
}
function taskTokTotal(tk) {
  return tk ? toNum(tk.input) + toNum(tk.output) + toNum(tk.cacheRead) + toNum(tk.cacheCreate) : 0;
}
// A run as <ui-task-runs> takes it. Ids are the ledger's (T1 …), kept unique
// across the lists (a repeated id gets its place as a suffix).
var TASK_RUN_STATUS = { done: 'done', active: 'running', paused: 'paused', dropped: 'dropped' };
function taskRunsData(ran) {
  var used = Object.create(null);
  return ran.map(function(t, i) {
    var id = t.id ? String(t.id) : 'run' + i;
    if (used[id]) id = id + '~' + i;
    used[id] = true;
    var r = { id: id, title: String(t.content || ''), status: TASK_RUN_STATUS[taskFateOf(t)] || 'paused' };
    if (t.id) r.ref = '#' + t.id;
    var start = taskRunStart(t);
    var end = taskRunEnd(t);
    if (start) r.startedAt = start;
    if (end) r.endedAt = end;
    // A count shared by tasks that ran together is fractional — a whole number on screen.
    var main = Math.round(toNum(t.toolCalls));
    var sub = Math.round(toNum(t.agentToolCalls));
    var tools = [];
    if (main) tools.push({ name: '메인', count: main });
    if (sub) tools.push({ name: '서브에이전트', count: sub });
    if (tools.length) r.tools = tools;
    r.toolCalls = main + sub;
    if (t.tokens) {
      r.tokens = { input: toNum(t.tokens.input), output: toNum(t.tokens.output), cacheRead: toNum(t.tokens.cacheRead), cacheWrite: toNum(t.tokens.cacheCreate) };
      r.costUsd = toNum(t.tokens.costUsd);
    }
    if (t.revisions && t.revisions.length) {
      r.revisions = t.revisions.map(function(v) {
        var o = { note: String(v.content || '') };
        if (toNum(v.at)) o.at = toNum(v.at);
        return o;
      });
    }
    return r;
  });
}
// What is left of the plan (the current list's tasks that never started) as
// <ui-task-plan> steps; the tasks a new plan dropped before they ran are its
// earlier fold (each one dropped). No list at all: the element's empty state.
function taskPlanData(runs) {
  var step = function(t, i) {
    var s = { id: t.id ? String(t.id) : 'step' + i, label: String(t.content || ''), status: 'pending' };
    if (t.id) s.ref = '#' + t.id;
    return s;
  };
  var d = { title: runs.ran.length || runs.plan.length ? '남은 계획' : '계획', steps: runs.plan.map(step) };
  if (runs.skipped.length) {
    d.earlier = [{
      id: 'skipped',
      title: '실행 전에 계획에서 빠진 태스크',
      steps: runs.skipped.map(function(t, i) {
        var s = step(t, i);
        s.id = 'skipped:' + s.id;
        s.fate = 'dropped';
        return s;
      }),
    }];
  }
  return d;
}
// The runs whose detail the reader opened stay open across a repaint that
// re-creates the element (the section folded and opened, another agent's tab
// and back is a new scope: selectPanelAgent clears them).
function taskRunsRestore(el) {
  if (!el || el._trRestored || typeof el.setOpen !== 'function') return;
  el._trRestored = true;
  for (var id in _panelTaskOpen) if (_panelTaskOpen[id]) el.setOpen(id, true);
}
// The elements' reports: a run's detail opened / closed (kept for the next
// element), the dropped-before-running fold opened / closed.
(function initPanelTasks() {
  var host = document.getElementById('panel-tasks');
  if (!host) return;
  host.addEventListener('ui-toggle', function(e) {
    var el = e.target;
    if (!el || !e.detail) return;
    if (el.tagName === 'UI-TASK-RUNS') {
      if (e.detail.open) _panelTaskOpen[String(e.detail.id)] = true;
      else delete _panelTaskOpen[String(e.detail.id)];
    } else if (el.tagName === 'UI-TASK-PLAN' && e.detail.id === 'earlier-plans') {
      _panelTasksEarlier = !!e.detail.open;
    }
  });
  if (window.customElements && customElements.whenDefined) {
    customElements.whenDefined('ui-task-runs').then(function() { taskRunsRestore(document.getElementById('panel-task-runs')); });
  }
})();
// The foot: the runs' sums (tool calls, tokens, cost) and the work no task got.
function taskTotalsHtml(ran, outside) {
  var tools = 0;
  var sub = 0;
  var tok = 0;
  var cost = 0;
  var known = false;
  for (var i = 0; i < ran.length; i++) {
    tools += toNum(ran[i].toolCalls);
    sub += toNum(ran[i].agentToolCalls);
    if (ran[i].tokens) { known = true; tok += taskTokTotal(ran[i].tokens); cost += toNum(ran[i].tokens.costUsd); }
  }
  var bits = ['툴 ' + Math.round(tools) + (sub >= 0.5 ? ' (+서브 ' + Math.round(sub) + ')' : '')];
  if (known) bits.push(formatTokens(tok) + ' tok', '$' + cost.toFixed(2));
  // Nothing ran yet (work before the first list): no sum, only the work outside any task.
  var html = ran.length ? '<div class="tr-total"><span class="tr-total-k">합계</span>' + esc(bits.join(' · ')) + '</div>' : '';
  if (outside && (toNum(outside.toolCalls) || toNum(outside.agentToolCalls) || taskTokTotal(outside.tokens))) {
    html += '<div class="tr-total tr-outside"><span class="tr-total-k">태스크 밖</span>' + esc('툴 ' + Math.round(toNum(outside.toolCalls))
      + (toNum(outside.agentToolCalls) >= 0.5 ? ' (+서브 ' + Math.round(toNum(outside.agentToolCalls)) + ')' : '')
      + ' · ' + formatTokens(taskTokTotal(outside.tokens)) + ' tok') + '</div>';
  }
  return html;
}

let _csrfToken = '';

/*
 * Populate the signed-in user's pill in the topbar.
 *
 * Rendered from /auth/me for three session types:
 *   - OAuth JWT (Google/Microsoft/Slack SSO) — shows user.name.
 *   - bearer_cookie (admin viewer token) — shows 관리자 with the admin shield glyph.
 *   - unauthenticated (/auth/me → 401) — pill stays hidden; auth middleware
 *     is about to redirect us to /login anyway.
 *
 * The pill is a link to /login, which for a signed-in browser is the account
 * page: who you are signed in as, continue, use a different account, or sign
 * out (GET /auth/logout).
 */
function _applyUserPill(data) {
  const pill = document.getElementById('user-pill');
  const nameEl = document.getElementById('user-pill-name');
  if (!pill || !nameEl) return;
  let label = '';
  let isAdmin = false;
  if (data && data.user && data.user.name) {
    label = data.user.name;
  } else if (data && data.isAdmin) {
    label = STRINGS.viewerAdmin;
    isAdmin = true;
  }
  if (!label) {
    pill.style.display = 'none';
    return;
  }
  nameEl.textContent = label;
  nameEl.title = label; // the name may end in an ellipsis
  pill.style.display = 'inline-flex';
  pill.classList.toggle('is-admin', isAdmin);

  // #716: admin-mode toggle visibility. Only ADMIN_USERS members see
  // the button; clicking it stores soma_admin_mode in localStorage and
  // _adminFetch attaches X-Admin-Mode: <on|off> to every API call.
  // Bearer-cookie admin (viewer token) is treated as always-admin and
  // also gets the toggle.
  const isAdminCapable = !!(data && (data.isAdmin || (data.user && data.user.name && data.isAdmin)));
  _viewerIsAdmin = isAdminCapable;
  if (typeof paintUsageBreakdown === 'function') paintUsageBreakdown(); // the by-user view is an admin's
  _viewerUserId = (data && data.user && data.user.slackUserId) || '';
  const lifecycleBtn = document.getElementById('lifecycle-btn');
  if (lifecycleBtn) lifecycleBtn.style.display = isAdminCapable ? 'inline-flex' : 'none';
  const toggle = document.getElementById('admin-mode-toggle');
  if (toggle) {
    if (isAdminCapable) {
      toggle.style.display = 'inline-flex';
      _renderAdminModeButton();
    } else {
      toggle.style.display = 'none';
      // Non-admin must NEVER ship X-Admin-Mode: on. Force-clear stored mode.
      try { localStorage.removeItem('soma_admin_mode'); } catch(_e) {}
    }
  }
}

// Admin mode (#716)
//
// Client-side safe-mode flag. The button only appears for users in
// ADMIN_USERS (server reports isAdmin:true on /auth/me). When ON,
// the dashboard sends X-Admin-Mode: on with every state-mutating
// request, which the server cross-checks against isAdminUser(sub)
// before allowing a write to a session the user does not own.
//
// Toggling OFF does NOT remove ADMIN_USERS membership; it just makes
// the session behave like a normal user (own-session writes only).
// This protects against accidental cross-user clicks during routine
// browsing.
function _isAdminModeOn() {
  try { return localStorage.getItem('soma_admin_mode') === 'on'; } catch(_e) { return false; }
}
function _setAdminMode(on) {
  try { localStorage.setItem('soma_admin_mode', on ? 'on' : 'off'); } catch(_e) {}
}
function _renderAdminModeButton() {
  const btn = document.getElementById('admin-mode-toggle');
  const lbl = document.getElementById('admin-mode-label');
  if (!btn || !lbl) return;
  const on = _isAdminModeOn();
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  // Prefer split-span structure (prefix + state): only the ON/OFF state is
  // rewritten, the "관리자 " prefix stays as rendered. Falls back to flat
  // textContent if the spans haven't been rendered yet (e.g. legacy
  // template / unit test setup).
  const stateEl = lbl.querySelector('.admin-mode-state');
  if (stateEl) stateEl.textContent = on ? STRINGS.on : STRINGS.off;
  else lbl.textContent = on ? STRINGS.adminOn : STRINGS.adminOff;
}
function toggleAdminMode() {
  _setAdminMode(!_isAdminModeOn());
  _renderAdminModeButton();
}

// #716: monkey-patch fetch ONCE at boot so every state-mutating request
// (POST/PUT/PATCH/DELETE) carries X-Admin-Mode: <on|off> from
// localStorage. The server cross-checks against ADMIN_USERS membership
// on the verified JWT; non-admins shipping "on" are rejected
// regardless. We do not touch GET requests because reads are
// world-readable for any authenticated user under the new policy.
(function _installAdminModeFetch() {
  if (typeof window === 'undefined' || !window.fetch) return;
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    try {
      const method = (init && init.method ? String(init.method) : (input && input.method) || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const mode = _isAdminModeOn() ? 'on' : 'off';
        const headers = new Headers((init && init.headers) || (input && input.headers) || {});
        // Don't clobber an explicit caller-set value.
        if (!headers.has('X-Admin-Mode')) headers.set('X-Admin-Mode', mode);
        const next = Object.assign({}, init || {}, { headers });
        return origFetch(input, next);
      }
    } catch (_e) {
      // fall through to origFetch on any unexpected shape
    }
    return origFetch(input, init);
  };
})();

// Fetch CSRF token (reusable — called on load and after JWT rotation invalidates token)
async function refreshCsrfToken() {
  try {
    const res = await fetch('/auth/me');
    if (res.ok) {
      const data = await res.json();
      _csrfToken = data.csrfToken || '';
      _applyUserPill(data);
    }
  } catch {}
}
refreshCsrfToken();

// ── Top bar: the owner's default model / effort (SSOT 2026-10-23 T6) ──
// One click opens a menu; picking saves the default at once (PATCH
// /api/settings/:key — the same path as Slack "model set" / "effort"). When the
// owner has a session panel open, "이 세션에도 적용" (on by default) also
// switches that session, like Slack's bare "effort <level>" applies to the
// current thread. Hidden when there is no signed-in Slack user (viewer token).
var _myDefaults = null; // { model: settingRow, effort: settingRow }
var _tdMenuKind = null;
async function loadMyDefaults() {
  var box = document.getElementById('topbar-defaults');
  if (!box) return;
  try {
    var res = await fetch('/api/settings');
    if (!res.ok) { box.hidden = true; return; }
    var data = await res.json();
    // Without admin acceptance the server refuses every settings write.
    if (data && data.accepted === false) { box.hidden = true; return; }
    var rows = (data && data.settings) || [];
    var model = null, effort = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === 'defaultModel') model = rows[i];
      if (rows[i].key === 'defaultEffort') effort = rows[i];
    }
    if (!model || !effort) { box.hidden = true; return; }
    _myDefaults = { model: model, effort: effort };
    renderDefaultsChips();
    box.hidden = false;
  } catch (_e) { box.hidden = true; }
}
function optionLabel(row, value) {
  var opts = (row && row.options) || [];
  for (var i = 0; i < opts.length; i++) if (opts[i].value === value) return opts[i].label;
  return String(value || '');
}
function renderDefaultsChips() {
  if (!_myDefaults) return;
  var m = document.getElementById('td-model-value');
  var e = document.getElementById('td-effort-value');
  if (m) m.textContent = optionLabel(_myDefaults.model, _myDefaults.model.value);
  if (e) e.textContent = optionLabel(_myDefaults.effort, _myDefaults.effort.value);
}
// The session model switch takes representative nicknames only.
function sessionAcceptsModel(value) {
  var models = REPRESENTATIVE_MODELS || [];
  for (var i = 0; i < models.length; i++) if (models[i].nickname === value) return true;
  return false;
}
// The open session the owner may switch together with the default, or null.
function defaultsScopeSession() {
  if (!panelOpen || !panelSessionKey) return null;
  var s = _sessionCache[panelSessionKey];
  if (!s || !s.ownerId || s.ownerId !== currentUserId || s.terminated || isSiblingSession(s)) return null;
  return s;
}
// <ui-menu id="td-menu"> (A-07): the page hands it the rows — a heading, the options as one radio group (the
// current one checked) and, for the open session the owner may switch too, a checkbox "열린 세션에도 적용" that is
// on each time the menu opens — and answers ui-select. The element hangs from the chip, moves focus to the checked
// row, does the arrows / typeahead / Esc / outside press, and gives focus back to the chip.
var TD_ALSO_SESSION = 'td-also-session';
var _tdAlsoSession = true;
function defaultsMenuData(kind) {
  var row = _myDefaults && (kind === 'model' ? _myDefaults.model : _myDefaults.effort);
  if (!row) return null;
  var title = kind === 'model' ? '새 세션 기본 모델' : '새 세션 기본 effort';
  var items = [{ kind: 'heading', label: title }];
  var opts = row.options || [];
  for (var i = 0; i < opts.length; i++) {
    var o = opts[i];
    var it = { kind: 'radio', value: String(o.value), label: String(o.label), checked: o.value === row.value };
    if (o.description && kind === 'model') it.description = String(o.description);
    items.push(it);
  }
  var s = defaultsScopeSession();
  if (s) {
    items.push({ kind: 'separator' });
    items.push({ kind: 'checkbox', value: TD_ALSO_SESSION, label: '열린 세션에도 적용', description: String(s.displayHeadline || s.title || s.key), checked: _tdAlsoSession });
  }
  return { label: title, items: items };
}
function openDefaultsMenu(kind, btn) {
  var menu = document.getElementById('td-menu');
  if (!menu || !_myDefaults || typeof menu.show !== 'function') return;
  if (menu.open && _tdMenuKind === kind) { closeDefaultsMenu(); return; }
  _tdAlsoSession = true;
  var d = defaultsMenuData(kind);
  if (!d) return;
  _tdMenuKind = kind;
  menu.data = d;
  menu.show(btn);
}
function closeDefaultsMenu() {
  var menu = document.getElementById('td-menu');
  if (menu && menu.open) menu.hide();
  _tdMenuKind = null;
}
(function initDefaultsMenu() {
  var menu = document.getElementById('td-menu');
  if (!menu) return;
  menu.addEventListener('ui-select', function(e) {
    var d = e.detail || {};
    if (d.kind === 'checkbox' && d.value === TD_ALSO_SESSION) { _tdAlsoSession = !!d.checked; return; }
    if (d.kind === 'radio' && _tdMenuKind) pickDefault(_tdMenuKind, d.value);
  });
  // Closed by the element (Esc, an outside press, focus leaving): the page forgets which chip it was.
  menu.addEventListener('ui-open-change', function(e) { if (e.detail && !e.detail.open) _tdMenuKind = null; });
})();
// Settings changed in Slack show up when the tab comes back.
document.addEventListener('visibilitychange', function() { if (!document.hidden) loadMyDefaults(); });
async function patchSetting(key, value) {
  var url = '/api/settings/' + encodeURIComponent(key);
  var body = JSON.stringify({ value: value });
  var headers = { 'Content-Type': 'application/json' };
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  var res = await fetch(url, { method: 'PATCH', headers: headers, body: body });
  if (res.status === 403) {
    await refreshCsrfToken();
    var retryHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
    res = await fetch(url, { method: 'PATCH', headers: retryHeaders, body: body });
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  return { ok: res.ok, setting: data && data.setting, error: (data && data.error) || ('HTTP ' + res.status) };
}
function setDefaultsStatus(text, isError) {
  var el = document.getElementById('td-status');
  if (!el) return;
  el.textContent = text || '';
  el.title = text || '';
  el.classList.toggle('is-error', !!isError);
}
async function pickDefault(kind, value) {
  var session = _tdAlsoSession ? defaultsScopeSession() : null;
  var skipSession = !!session && kind === 'model' && !sessionAcceptsModel(value);
  if (skipSession) session = null;
  closeDefaultsMenu();
  var key = kind === 'model' ? 'defaultModel' : 'defaultEffort';
  setDefaultsStatus('저장 중…', false);
  var r;
  try { r = await patchSetting(key, value); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  if (!r.ok) { setDefaultsStatus('저장하지 못했습니다: ' + r.error, true); return; }
  _myDefaults[kind] = r.setting;
  renderDefaultsChips();
  var msg = '기본 ' + (kind === 'model' ? '모델' : 'effort') + ' → ' + optionLabel(r.setting, r.setting.value) + ' (새 세션부터)';
  if (skipSession) msg += ' · 이 모델은 세션 전환 목록에 없어 열린 세션은 그대로';
  if (session && isBusy(session.key, kind)) {
    // The session is already switching (from its card or panel): one switch at a time.
    msg += ' · 열린 세션은 전환 중이라 그대로';
  } else if (session) {
    var sr;
    setBusy(session.key, kind, true);
    refreshCard(session.key);
    repaintPanelControlsFor(session.key);
    try {
      sr = kind === 'model' ? await postModelSwitch(session.key, value) : await postEffortSwitch(session.key, value);
    } catch (e) { sr = { ok: false, error: String(e && e.message || e) }; }
    setBusy(session.key, kind, false);
    _modelNotes[session.key] = kind === 'model' ? modelSwitchNote(sr) : effortSwitchNote(sr);
    msg += sr.ok ? ' · 열린 세션에도 적용' : ' · 열린 세션은 바꾸지 못함: ' + sr.error;
    refreshCard(session.key);
    repaintPanelControlsFor(session.key);
    loadSessions();
  }
  setDefaultsStatus(msg, false);
}
loadMyDefaults();

// ── Utility ──
function decodeSlackEntities(s) {
  return (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// Pure (no DOM) so the escaping can be exercised outside a browser. Same &, <, >
// output the textContent→innerHTML round-trip gave, plus " so a value can never
// close the attribute it is placed in. ' stays literal: escJs() relies on that.
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Only http(s) URLs become links; anything else (javascript:, data:) is inert.
function safeHref(u) {
  return /^https?:\\/\\//i.test(String(u || '')) ? escAttr(u) : '#';
}
function escJs(s) {
  return esc(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}
// Strip trailing "(Recommended · N/M)" or "(Recommended)" from a label for display.
function stripRecommendedMarker(label) {
  return (label || '').replace(/\\s*\\(Recommended(?:\\s*·[^)]*)?\\)\\s*$/i, '').trim();
}
// Resolve recommended choiceId: explicit first, else legacy label scan.
// Matches trailing "(Recommended)" / "(Recommended · N/M)" only — mirrors
// LEGACY_RECOMMENDED_SUFFIX_RE in somalib/model-commands/validator.ts. Kept
// duplicated because dashboard CSS/JS is a server-rendered string bundle, not
// an import graph.
function resolveRecommendedId(explicitId, options) {
  if (explicitId && (options || []).some(function(o) { return o.id === explicitId; })) return explicitId;
  var legacy = (options || []).find(function(o) { return /\\(Recommended(?:\\s*·\\s*\\d+\\/\\d+)?\\)\\s*$/i.test(o.label || ''); });
  return legacy ? legacy.id : null;
}
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
  return Math.floor(ms / 86400000) + 'd ago';
}
// A finite number or 0 — numeric fields pass through this before they reach markup.
function toNum(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}
// Compact token count: 999 · 1.5K · 2.5M · 3.1B · 4.2T. The unit is chosen
// after rounding (never "1000.0K"); a negative or non-number is 0, and anything
// that would round to 1000.0T or more (from 999.95T) is capped at 999.9T+ so an
// absurd value cannot print an exponent.
function formatTokens(n) {
  n = Math.max(0, toNum(n));
  if (n < 999.5) return String(Math.round(n));
  var units = ['K', 'M', 'B', 'T'];
  for (var i = 0; i < units.length; i++) {
    n /= 1000;
    if (n < 999.95) return n.toFixed(1) + units[i];
  }
  return '999.9T+';
}
// ── Live usage on the collapsed face (SSOT 2026-10-22 T1/T2) ──
// The session total of every token its API calls processed — input, output,
// cache read and cache write — the same tokens its API-equivalent cost is
// computed from. The server folds the running turn's usage in, so the numbers
// grow during a turn, not only when it ends.
function cardTotalTokens(u) {
  if (!u) return 0;
  return toNum(u.totalInputTokens) + toNum(u.totalOutputTokens) + toNum(u.totalCacheReadTokens) + toNum(u.totalCacheCreateTokens);
}
// SSOT 2026-10-26 T2 — a spend's tokens: every kind it was billed for.
function spendTotal(sp) {
  if (!sp) return 0;
  return toNum(sp.inputTokens) + toNum(sp.outputTokens) + toNum(sp.cacheReadTokens) + toNum(sp.cacheCreateTokens);
}
// "<tokens> tok · $<cost>" (API-equivalent). ≈ when part of it was priced at
// the fallback rate — a model the price table does not know.
function spendText(tokens, cost, estimate) {
  return formatTokens(tokens) + ' tok · ' + (estimate ? '≈' : '') + '$' + toNum(cost).toFixed(2);
}
// A subagent's own spend as its row and header show it. Calls that reported
// no usage at all (a provider that zeroes it) read as unreported, not as $0.
function spendLabel(sp) {
  if (!sp) return '';
  var tk = spendTotal(sp);
  if (tk <= 0) return toNum(sp.calls) > 0 ? '사용량 미보고' : '';
  return spendText(tk, sp.costUsd, (sp.unpricedModels && sp.unpricedModels.length) || toNum(sp.estimatedCalls) > 0);
}
function spendTitle(sp) {
  if (!sp) return '';
  // Foreground subagents it started have no row of their own: their calls are counted here.
  var nested = toNum(sp.nestedAgents);
  var t = (nested > 0
      ? '이 에이전트의 API 호출 ' + toNum(sp.calls) + '회 (트리에 따로 없는 하위 에이전트 ' + nested + '개 포함, 트리에 있는 하위 에이전트는 각자 행에)'
      : '이 에이전트 자신의 API 호출 ' + toNum(sp.calls) + '회 (하위 에이전트 제외)')
    + ' — 입력 ' + formatTokens(sp.inputTokens)
    + ' · 출력 ' + formatTokens(sp.outputTokens) + ' · 캐시 읽기 ' + formatTokens(sp.cacheReadTokens)
    + ' · 캐시 쓰기 ' + formatTokens(sp.cacheCreateTokens) + ' · API 환산 $' + toNum(sp.costUsd).toFixed(2);
  if (toNum(sp.estimatedCalls) > 0) t += ' · usage가 기록되지 않은 호출 ' + toNum(sp.estimatedCalls) + '회는 앞뒤 호출로 추정';
  if (sp.unpricedModels && sp.unpricedModels.length) t += ' · 단가표에 없는 모델(' + sp.unpricedModels.join(', ') + ')은 기본 단가로 추정';
  return t;
}
// Dashboard v2.1 — \`Nm SSs\` for the 1s live tick. Mirrors packages/common/src/format/duration.ts.
function formatNmSSs(ms) {
  if (!ms || ms < 0 || isNaN(ms)) return '0m 00s';
  var totalSec = Math.floor(ms / 1000);
  var m = Math.floor(totalSec / 60);
  var s = totalSec % 60;
  return m + 'm ' + (s < 10 ? '0' + s : s) + 's';
}
// 1-Hz tick: fill every time-dependent text from its data-* attrs.
// Runs unconditionally of WS state — WS feeds new data-* values, tick reads them.
// Body HTML never embeds Date.now(): the body is rewritten when its string
// changes, so a clock in the markup would make every poll look like a change.
// (The card faces' clocks are <ui-agent-inbox>'s own tick.)
//   .card-timer-live  data-leg-started / data-accumulated (the agent tree's root)
//   .rel-time         data-ts  → "6m ago"
//   .task-elapsed     data-since → running task duration
// (An approval card's expiry is <ui-approval-card>'s own countdown.)
function updateTimersIn(root) {
  var now = Date.now();
  var els = root.querySelectorAll('.card-timer-live');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var started = Number(el.dataset.legStarted) || 0;
    var accumulated = Number(el.dataset.accumulated) || 0;
    var elapsed = (started ? now - started : 0) + accumulated;
    var t = formatNmSSs(elapsed);
    if (el.textContent !== t) el.textContent = t;
  }
  var rel = root.querySelectorAll('.rel-time');
  for (var j = 0; j < rel.length; j++) {
    var r = timeAgo(Number(rel[j].dataset.ts) || 0);
    if (rel[j].textContent !== r) rel[j].textContent = r;
  }
  var run = root.querySelectorAll('.task-elapsed');
  for (var k = 0; k < run.length; k++) {
    var d = formatDuration(now - (Number(run[k].dataset.since) || now)) || '0s';
    if (run[k].textContent !== d) run[k].textContent = d;
  }
}
function updateTimers() { updateTimersIn(document); aqTick(); }
var _timerTick = setInterval(updateTimers, 1000);

// ── User list ──
async function loadUsers() {
  try {
    const res = await fetch('/api/dashboard/users');
    const data = await res.json();
    const select = document.getElementById('user-select');
    for (const u of data.users) {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name;
      if (u.id === currentUserId) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (e) { console.error('Failed to load users', e); }
  syncUserSelectLabel();
}

// The visible label over the transparent user <select> shows the selected
// option; the select's title keeps the full name when the label is ellipsized.
function syncUserSelectLabel() {
  const select = document.getElementById('user-select');
  const label = document.getElementById('user-select-label');
  if (!select || !label) return;
  const opt = select.options[select.selectedIndex];
  const text = opt ? opt.textContent : '';
  if (label.textContent !== text) label.textContent = text;
  select.title = text;
}

function selectUser(userId) {
  syncUserSelectLabel();
  currentUserId = userId;
  history.replaceState(null, '', userId ? '/dashboard/' + userId : '/dashboard');
  loadSessions();
  loadStats();
  loadCronJobs();
}

// ── Period ── <ui-segmented id="period-seg"> (B-02): the page hands it the choice and answers ui-change.
var PERIOD_OPTIONS = [{ value: 'day', label: '오늘' }, { value: 'week', label: '지난 7일' }, { value: 'month', label: '지난 30일' }];
function paintPeriodSeg() {
  var seg = document.getElementById('period-seg');
  if (seg) seg.data = { label: '기간', value: currentPeriod, options: PERIOD_OPTIONS };
}
function setPeriod(period) {
  currentPeriod = period;
  paintPeriodSeg();
  loadStats();
}

// ── Expand / collapse (P6, the library disclosure recipe — CSS "EXPAND / COLLAPSE") ──
// xpMove: the host's region clips while its row moves, then not (focus rings stay whole).
// xpEnter / xpLeave: a region drawn only while open (세션 정보) enters from 0 rows, and folds to 0
// rows before it is dropped (done). Reduced motion: the sheet's global rule makes both instant.
var XP_MS = 240;
function xpMove(host) {
  if (!host || !host.classList) return;
  host.classList.add('xp-moving');
  clearTimeout(host._xpMoveT);
  host._xpMoveT = setTimeout(function() { host.classList.remove('xp-moving'); }, XP_MS + 40);
}
function xpEnter(host) {
  if (!host || !host.classList) return;
  host.classList.add('xp-shut');
  void host.offsetHeight;
  host.classList.remove('xp-shut');
  xpMove(host);
}
function xpLeave(host, done) {
  if (!host || !host.classList || reduceMotion()) { done(); return; }
  host.classList.add('xp-shut');
  xpMove(host);
  clearTimeout(host._xpLeaveT);
  host._xpLeaveT = setTimeout(function() {
    host._xpLeaveT = 0;
    done();
    host.classList.remove('xp-shut');
  }, XP_MS);
}
// A fold in progress is undone (the reader opened it again): true when there was one.
function xpStay(host) {
  if (!host || !host._xpLeaveT) return false;
  clearTimeout(host._xpLeaveT);
  host._xpLeaveT = 0;
  host.classList.remove('xp-shut');
  xpMove(host);
  return true;
}

// ── Stats strip 자세히 (.prd/10 §3.1-2) — the other cards + charts, collapsed
// unless the user opened them (localStorage['soma-stats-detail'] = 'open'). ──
var STATS_DETAIL_KEY = 'soma-stats-detail';
function setStatsDetail(open) {
  var btn = document.getElementById('stats-more');
  var detail = document.getElementById('stats-detail');
  if (!btn || !detail) return;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  detail.hidden = !open;
  detail.inert = !open;
}
function toggleStatsDetail() {
  var open = document.getElementById('stats-more').getAttribute('aria-expanded') !== 'true';
  xpMove(document.getElementById('stats'));
  setStatsDetail(open);
  try { localStorage.setItem(STATS_DETAIL_KEY, open ? 'open' : 'closed'); } catch (_e) {}
}
(function initStatsDetail() {
  var saved = null;
  try { saved = localStorage.getItem(STATS_DETAIL_KEY); } catch (_e) {}
  setStatsDetail(saved === 'open');
})();

// ── Session cache ──
// Keyed by session key — prototype-free so any key string is just a key.
let _sessionCache = Object.create(null);

// ── Env badge helpers (#814) ──
// 4-color palette — kept in CSS-friendly order so the contrast against
// dark/light themes is decent for any of the four. Index = hash of
// instanceName mod 4. Two unrelated names hashing to the same slot is
// noise we can live with on a 4-instance host (operators rarely run more
// than 2-3 instances per box).
// Tones from the token palette (tinted in CSS: .env-badge) — not status colours, so no red / amber.
var ENV_BADGE_PALETTE = ['var(--st-run)', 'var(--green)', 'var(--purple)', 'var(--orange)'];

// _envIndex caches a deterministic palette-slot per instanceName so two
// envs sharing a hash bucket fall back to a "first-come, first-coloured"
// scheme based on the sorted set of envs in the current cache. Recomputed
// any time the cache changes (cleared in renderBoard).
var _envIndex = null;

function _hashStr(s) {
  // djb2 — small, deterministic, sufficient for a 4-bucket palette.
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function _buildEnvIndex() {
  var envs = Object.create(null);
  for (var k in _sessionCache) {
    var c = _sessionCache[k];
    if (c && c.environment && c.environment.instanceName) {
      envs[c.environment.instanceName] = true;
    }
  }
  var sorted = Object.keys(envs).sort();
  var assigned = Object.create(null);
  // First pass — try the hash bucket. If taken, mark conflict.
  var occupied = {};
  for (var i = 0; i < sorted.length; i++) {
    var name = sorted[i];
    var slot = _hashStr(name) % ENV_BADGE_PALETTE.length;
    if (!occupied[slot]) {
      assigned[name] = slot;
      occupied[slot] = name;
    } else {
      assigned[name] = -1; // mark for fallback pass
    }
  }
  // Second pass — fallback: walk sorted-order names that hashed into a
  // taken slot and assign the next free slot in palette order. This
  // keeps the assignment stable across renders so a card doesn't change
  // colour when an unrelated card is added.
  var nextSlot = 0;
  for (var j = 0; j < sorted.length; j++) {
    var name2 = sorted[j];
    if (assigned[name2] !== -1) continue;
    while (occupied[nextSlot] && nextSlot < ENV_BADGE_PALETTE.length) nextSlot++;
    if (nextSlot < ENV_BADGE_PALETTE.length) {
      assigned[name2] = nextSlot;
      occupied[nextSlot] = name2;
      nextSlot++;
    } else {
      // More envs than palette slots — wrap. Operators on a 5+ instance
      // host accept that two badges may collide on colour.
      assigned[name2] = _hashStr(name2) % ENV_BADGE_PALETTE.length;
    }
  }
  return assigned;
}

function getEnvBadgeColor(instanceName) {
  if (!_envIndex) _envIndex = _buildEnvIndex();
  var slot = _envIndex[instanceName];
  if (typeof slot !== 'number' || slot < 0) {
    slot = _hashStr(instanceName || '') % ENV_BADGE_PALETTE.length;
  }
  return ENV_BADGE_PALETTE[slot];
}

function _envCount() {
  if (!_envIndex) _envIndex = _buildEnvIndex();
  return Object.keys(_envIndex).length;
}

// ── Agent inbox board (.prd/10 §3.1, §4) on @2lab.ai/ui <ui-agent-inbox> ──
// NEEDS YOU = waiting · RUNNING = working · DONE = idle, then closed (SLEEPING +
// archives; archives behind the Archives toggle, sleeping cards behind the
// Sleeping toggle), filed under the day the work finished (T11/T12). The server
// buckets (KanbanBoard) are unchanged — only the client folds idle + closed
// into one column.
// The element (re-agent-inbox D1–D10) draws the board: keyed cards that keep
// their node, the new status shown in place for 900 ms before a card changes
// column (D5), FLIP moves, enter / exit fades, the status icon's pop (D4),
// tokens · cost counting up, the 1 Hz clocks, the polite announcement (D6), the
// DONE day groups, skeletons until the first answer, Board ↔ List glides. The
// page maps each session to a card (cardOf), builds the columns and the day
// groups, and owns the open card's body: the card's <slot name="body:<key>">
// takes a light-DOM div holding renderCardBody's markup — approval cards, the
// question, the agent tree, the goal line, model · effort, Stop / Close, 작업 로그
// and every gate (D10). A collapsed card builds no body (#548).
var BOARD_LABELS = { waiting: 'NEEDS YOU', working: 'RUNNING', done: 'DONE' };
var _expanded = new Set();           // keys whose card is open
var _cardClosing = Object.create(null); // key → timer: a closed card keeps its body until its collapse has run
var _boardRenders = 0;
var _ioCache = Object.create(null);  // conversationId → { state, stamp, data, dirty, fails, retryAt }
// What the elements draw, rebuilt by every board render. Prototype-free, so a
// key such as "__proto__" or "constructor" is just a key.
var _cardHost = Object.create(null);  // session key → the <ui-agent-inbox> that holds its card (the board, or a CRON job's)
var _cardCol = Object.create(null);   // session key → the column its card is drawn with (waiting / working / idle / closed)
var _cardData = Object.create(null);  // session key → the card the element was given (cardOf)
var _cardDrawn = Object.create(null); // session key → true when drawn (not in a closed DONE day)
var _cardBodies = Object.create(null); // session key → { el, html } — its light-DOM body while open or closing

// The board's wording (data.strings over lang="en"): English status words,
// Korean sub-agents, tooltips and announcement — as before the element.
var BOARD_STRINGS = {
  agents: '서브에이전트',
  agentsRunning: function(n) { return '실행 ' + n; },
  agentsFailed: function(n) { return '실패 ' + n; },
  arts: '모델이 만든 산출물',
  artOpen: function(name, kind) { return (ART_KIND_LABEL[kind] || '파일') + ' ' + name + ' — 크게 보기'; },
  announce: function(w, r) { return '응답이 필요한 세션 ' + w + '개, 실행 중 ' + r + '개'; },
  // The sentence is the counts only, never "<title>: <word>." first.
  changed: function() { return ''; },
  ago: function(at) { return timeAgo(at); },
  duration: function(ms) { return formatNmSSs(ms); },
};

// Motion tokens come from the CSS custom properties so CSS transitions and
// WAAPI share one source of truth (§4 table).
var MOTION = (function readMotionTokens() {
  var cs = getComputedStyle(document.documentElement);
  function ms(name, fallback) { var v = parseFloat(cs.getPropertyValue(name)); return isNaN(v) ? fallback : v; }
  function str(name, fallback) { var v = cs.getPropertyValue(name).trim(); return v || fallback; }
  return {
    move: ms('--dur-move', 320),
    fade: ms('--dur-fade', 180),
    expand: ms('--dur-expand', 240),
    easeOut: str('--ease-out', 'cubic-bezier(0.23, 1, 0.32, 1)'),
    easeInOut: str('--ease-in-out', 'cubic-bezier(0.77, 0, 0.175, 1)'),
  };
})();
var _reducedMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
function reduceMotion() { return _reducedMotionMq.matches; }
// The first paint and background tabs never animate.
function canAnimate() {
  return _boardRenders > 0 && !document.hidden && typeof Element.prototype.animate === 'function';
}
function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
function isSiblingSession(s) {
  return !!(SELF_INSTANCE_NAME && s.environment && s.environment.instanceName && s.environment.instanceName !== SELF_INSTANCE_NAME);
}

// Pure: the cards DONE holds for this render — idle cards, then closed cards.
// An archived (terminated) closed card is left out unless archives are shown;
// a sleeping one (closed, not terminated) unless sleeping cards are shown
// (showSleeping, on unless false). The one key a deep link revealed (revealKey)
// is always in. archivedCount / sleepingCount = those cards in the board data.
// The cards are then grouped by the day they finished (planDoneGroups).
function planDoneColumn(idle, closed, o) {
  var shown = [], archivedCount = 0, sleepingCount = 0;
  for (var i = 0; i < closed.length; i++) {
    var s = closed[i];
    var archived = s.terminated === true;
    var revealed = !!o.revealKey && s.key === o.revealKey;
    if (archived) archivedCount++;
    else sleepingCount++;
    if (archived && !o.showArchives && !revealed) continue;
    if (!archived && o.showSleeping === false && !revealed) continue;
    shown.push(s);
  }
  var done = idle.map(function(s) { return { s: s, col: 'idle' }; })
    .concat(shown.map(function(s) { return { s: s, col: 'closed' }; }));
  return { done: done, archivedCount: archivedCount, sleepingCount: sleepingCount };
}

// ── DONE by finish day (SSOT 2026-10-22 T11/T12) ──
// Each DONE card sits under the day its work finished (s.doneAt — the server's
// finish time; else its last activity), in the viewer's calendar: Today, 어제,
// then every earlier day, newest first, the cards in a day newest first. Today
// and 어제 start open; earlier days start closed and open on a click. The
// reader's choice per day lasts for the page (_doneGroupOpen) — the element's
// day groups (columns[].groups) tell it through ui-group-toggle.
var _doneGroupOpen = Object.create(null); // day key → open (reader's choice)
var DAY_MS = 24 * 60 * 60 * 1000;
function doneTimeOf(s) {
  var t = toNum(s && s.doneAt);
  if (t > 0) return t;
  var last = Date.parse(s && s.lastActivity);
  return isFinite(last) ? last : 0;
}
function dayKeyOf(ms) {
  var d = new Date(ms);
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}
function doneDayLabel(key, now) {
  if (key === dayKeyOf(now)) return 'Today';
  var y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKeyOf(y.getTime())) return '어제';
  var parts = key.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var opts = { month: 'long', day: 'numeric', weekday: 'short' };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('ko-KR', opts);
}
// Pure: [{ key, label, open, items }] — opened = the reader's choices.
// SSOT 2026-10-30 T2: a starred card leaves its day for the pinned group
// ('starred', ★ Starred), first and open until the reader folds it.
function planDoneGroups(done, now, opened) {
  var byKey = Object.create(null);
  var keys = [];
  var pinned = [];
  for (var i = 0; i < done.length; i++) {
    var t = doneTimeOf(done[i].s);
    if (done[i].s && done[i].s.starred === true) { pinned.push({ item: done[i], t: t }); continue; }
    var k = dayKeyOf(t);
    if (!byKey[k]) { byKey[k] = []; keys.push(k); }
    byKey[k].push({ item: done[i], t: t });
  }
  keys.sort(function(a, b) { return a < b ? 1 : a > b ? -1 : 0; });
  var today = dayKeyOf(now);
  var y = new Date(now);
  y.setDate(y.getDate() - 1);
  var yesterday = dayKeyOf(y.getTime());
  var groups = keys.map(function(k) {
    var list = byKey[k].slice().sort(function(a, b) { return b.t - a.t; });
    var open = opened && Object.prototype.hasOwnProperty.call(opened, k) ? !!opened[k] : (k === today || k === yesterday);
    return { key: k, label: doneDayLabel(k, now), open: open, items: list.map(function(x) { return x.item; }) };
  });
  if (pinned.length) {
    pinned.sort(function(a, b) { return b.t - a.t; });
    var pinOpen = opened && Object.prototype.hasOwnProperty.call(opened, 'starred') ? !!opened.starred : true;
    groups.unshift({ key: 'starred', label: '\\u2605 Starred', open: pinOpen, items: pinned.map(function(x) { return x.item; }) });
  }
  return groups;
}
var _lastBoardData = null;
// A targeted card push (sessionUpdated) lands in the last board too, so a
// re-render from it (a DONE day toggle) never rolls the card back.
function patchLastBoard(s) {
  if (!_lastBoardData || !s || !s.key) return;
  ['working', 'waiting', 'idle', 'closed'].forEach(function(col) {
    var arr = _lastBoardData[col] || [];
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].key === s.key) arr[i] = s;
  });
}

function renderBoard(board, partial) {
  // Partial: anything painted before the board is certified — this instance's
  // cards under the error, or re-rendered during 다시 시도 — is never announced as
  // the board. Unspecified means whatever the load state says, so a re-render
  // (cron poll, visibility, toggles) of partial data stays quiet too.
  if (partial === undefined) partial = _boardLoad !== 'ready';
  _sessionCache = Object.create(null); // Clear stale cache each render cycle
  // Populate cache from the entire board first so the env-palette pass
  // (which reads every card's environment) and the per-card renders share
  // one walk over the data.
  for (var col0 of ['working', 'waiting', 'idle', 'closed']) {
    var arr = board[col0] || [];
    for (var i0 = 0; i0 < arr.length; i0++) {
      _sessionCache[arr[i0].key] = arr[i0];
    }
  }
  // Answer states of requests the board no longer holds (a session gone, a prompt or question it no longer asks).
  for (var ak in _acState) acEvict(ak, _sessionCache[ak]);
  _envIndex = _buildEnvIndex();
  // Owner hues for every card in the board data (hidden archives too, so the
  // Show archives toggle never recolours anyone).
  var owners = [];
  for (var ok in _sessionCache) owners.push(_sessionCache[ok].ownerId || _sessionCache[ok].ownerName || '');
  _ownerIndex = assignOwnerHues(owners);
  _lastBoardData = board;
  // Cron runs leave the columns for the CRON lane, one group per job (SSOT
  // 2026-10-23 T4); the lane sections exist before their elements are filled.
  var cronPlan = planCronLane(board, _cronJobs, _cronRevealKey);
  _cronPlan = cronPlan;
  syncCronLane(cronPlan);
  var rest = cronPlan.board;
  var plan = planDoneColumn(rest.idle || [], rest.closed || [], {
    showArchives: showArchives,
    showSleeping: showSleeping,
    revealKey: _revealedKey,
  });
  var groups = planDoneGroups(plan.done, Date.now(), _doneGroupOpen);
  var kb = document.getElementById('kanban');
  var prevHost = _cardHost;
  _cardHost = Object.create(null);
  _cardCol = Object.create(null);
  _cardData = Object.create(null);
  _cardDrawn = Object.create(null);
  function keys(list, col, host) {
    return (list || []).map(function(s) { placeCard(s, col, host, true); return s.key; });
  }
  if (kb) {
    kb._ibPlan = {
      cols: [
        { id: 'waiting', label: BOARD_LABELS.waiting, keys: keys(rest.waiting, 'waiting', kb) },
        { id: 'working', label: BOARD_LABELS.working, keys: keys(rest.working, 'working', kb) },
        {
          id: 'done',
          label: BOARD_LABELS.done,
          keys: [],
          // A closed day's cards are counted, not drawn: they get no face until the day opens (T12).
          groups: groups.map(function(g) {
            return {
              id: g.key,
              label: g.label,
              open: g.open,
              keys: g.items.map(function(it) { placeCard(it.s, it.col, kb, g.open); return it.s.key; }),
            };
          }),
        },
      ],
      load: partial ? (_boardLoad === 'loading' ? 'loading' : 'failed') : 'ready',
      // D6: how many need you and how many run — the data as it came (CRON runs
      // waiting on a reply included), before the lane takes its runs and any hold.
      announce: { needs: (board.waiting || []).length, running: (board.working || []).length },
    };
    inboxPaint(kb);
  }
  // The CRON lane (Option A): each job's lead run in its own one-column element.
  paintCronLaneCards(cronLaneSlots(cronPlan));
  // Cards that left every element: closed for good (a card that comes back
  // comes back closed), their bodies and retry timers released.
  for (var gone in prevHost) {
    if (_cardHost[gone]) continue;
    _expanded.delete(gone);
    var goneS = _sessionCache[gone];
    releaseCardIoTimer(goneS ? goneS.conversationId : null);
  }
  syncCardBodies();
  // Open cards keep their 지시/응답 current (no DOM write unless a fetch settles).
  // Drawn ones only: a closed DONE day's cards are placed as stubs (_cardHost), not drawn.
  _expanded.forEach(function(key) { if (_cardDrawn[key]) ensureCardIo(key, false); });
  syncHasCards();
  renderArchivesToggle(plan.archivedCount);
  renderSleepingToggle(plan.sleepingCount);
  paintCronDrawer();
  // The #814 tokens tooltip describes this board (user switch, WS push).
  updateTokenBreakdown();
  _boardRenders++;
  // The board moved: the layout-shift cache measures it again once the
  // element's enter / move animations have settled (SSOT 2026-10-24).
  scheduleLayoutRefresh(MOTION.move + 40);
  openDeepLinkedSession();
}

// One card on an element this render: where it is, with what, and its data —
// the full card when drawn, a stub (counted, never drawn) in a closed day.
function placeCard(s, col, host, drawn) {
  _cardHost[s.key] = host;
  _cardCol[s.key] = col;
  if (drawn) {
    _cardData[s.key] = cardOf(s, col);
    _cardDrawn[s.key] = true;
    // A collapsed card paints no approval card, but the requester's input is
    // fetched as the card's would be (acPermissionData), so opening it shows it at once.
    if (!cardBodyShown(s.key)) acPrefetch(s, col);
  } else {
    _cardData[s.key] = { id: s.key, title: '', status: col === 'closed' ? 'idle' : 'done', bodyMode: 'slot' };
  }
}

// An element's data from its plan: columns (and DONE's day groups) of keys, the
// cards from _cardData. expanded: the open cards it holds, so a card that moves
// between the board and a CRON job's element opens there too (the element opens
// a listed card only the first time it draws it).
function inboxPaint(host) {
  var p = host._ibPlan;
  if (!p) return;
  var open = [];
  function cards(list) {
    return list.map(function(k) {
      if (_expanded.has(k)) open.push(k);
      return _cardData[k];
    });
  }
  var columns = p.cols.map(function(c) {
    var col = { id: c.id, label: c.label, cards: cards(c.keys) };
    if (c.bare) col.bare = true;
    if (c.groups) col.groups = c.groups.map(function(g) { return { id: g.id, label: g.label, open: g.open, cards: cards(g.keys) }; });
    return col;
  });
  host.data = { columns: columns, load: p.load, announce: p.announce, expanded: open, strings: BOARD_STRINGS, openLabel: false };
}

// The CRON lane (Option A): each job's card box (cronLaneSlots) holds its own
// <ui-agent-inbox view="list"> with one bare column — the job's lead run as the
// same card as on the board (cardOf), its body in the same slot. A run that
// moves between the lane and the board leaves one element and enters the other.
// The lane says nothing itself: the board's announcement counts its runs.
function paintCronLaneCards(slots) {
  for (var i = 0; i < slots.length; i++) {
    var box = slots[i].container;
    if (!box) continue;
    var el = box._inbox;
    if (!el) {
      el = document.createElement('ui-agent-inbox');
      el.className = 'cron-inbox';
      el.setAttribute('view', 'list');
      wireInbox(el);
      box._inbox = el;
    }
    if (el.parentNode !== box) box.appendChild(el);
    var items = slots[i].items;
    var lead = items.length ? items[0].s : null;
    el._ibPlan = {
      cols: [{
        id: 'cron',
        label: lead && lead.cronJob ? String(lead.cronJob.name || '') : '',
        bare: true,
        keys: items.map(function(it) { placeCard(it.s, it.col, el, true); return it.s.key; }),
      }],
      load: 'ready',
      announce: false,
    };
    el.classList.toggle('is-empty', !items.length);
    inboxPaint(el);
  }
}

// The element's events, wired once per element (the board's at load, a CRON job's when made).
// A board with drawn cards: on a phone the last card clears the floating button.
// After every board render and every DONE day opened or closed.
function syncHasCards() {
  var inbox = document.getElementById('inbox');
  if (inbox) inbox.classList.toggle('has-cards', Object.keys(_cardDrawn).length > 0);
}
function wireInbox(host) {
  // Open / close: the body follows (built before the row grows, let go after
  // it has collapsed), then the open card's 지시/응답 and artifacts are fetched.
  // The agent tree in an open body sends its own ui-toggle through here: not ours.
  host.addEventListener('ui-toggle', function(e) {
    if (e.target !== host || !e.detail) return;
    var key = String(e.detail.cardId);
    var open = !!e.detail.expanded;
    var s = _sessionCache[key];
    // A card whose session left the cache (off the board, before the next render
    // drops it) has nothing to build: it stays closed instead of growing an empty body.
    if (open && !s) {
      e.preventDefault();
      return;
    }
    if (open) _expanded.add(key);
    else _expanded.delete(key);
    if (!open) releaseCardIoTimer(s ? s.conversationId : null);
    syncCardBody(key, false);
    if (open) {
      ensureCardIo(key, true);
      if (s && s.conversationId && s.artifacts && !isSiblingSession(s)) ensureArtifacts(s.conversationId);
      // SSOT 2026-10-29 T2: its detail card opens beside the board, in front of the deck (focus stays on the card).
      openPanel(key);
    } else {
      // Folded: its detail card leaves the deck (the next one comes forward, or the panel closes).
      deckDrop(key);
    }
    // The cards below ride the growing (or shrinking) card: measured again once it has.
    scheduleLayoutRefresh(Math.max(MOTION.expand, MOTION.move) + 60);
  });
  // A DONE day opened or closed (a click, or reveal for a deep link): the
  // reader's choice for the page; the day's cards get their faces (or stubs)
  // now, so the element's own render right after this draws them.
  host.addEventListener('ui-group-toggle', function(e) {
    if (e.target !== host || !e.detail) return;
    var day = String(e.detail.groupId);
    var open = !!e.detail.open;
    _doneGroupOpen[day] = open;
    var p = host._ibPlan;
    if (!p) return;
    p.cols.forEach(function(c) {
      (c.groups || []).forEach(function(g) {
        if (c.id !== String(e.detail.columnId) || g.id !== day) return;
        g.open = open;
        g.keys.forEach(function(k) {
          var s = _sessionCache[k];
          if (s) placeCard(s, _cardCol[k] || 'idle', host, open);
          if (!open) delete _cardDrawn[k];
        });
      });
    });
    inboxPaint(host);
    syncCardBodies();
    syncHasCards();
    scheduleLayoutRefresh(MOTION.move + 60);
  });
  // A file chip on the face opens the viewer (never the card). The chip is the
  // opener focus returns to.
  host.addEventListener('ui-artifact', function(e) {
    if (e.target !== host || !e.detail) return;
    var s = _sessionCache[String(e.detail.cardId)];
    if (!s || !s.conversationId) return;
    var chip = inboxChipOf(host, String(e.detail.cardId), String(e.detail.artifactId));
    openArtifactModal(s.conversationId, String(e.detail.artifactId), chip || host);
  });
}
// The file chip the reader pressed. The element emits ui-artifact on itself
// (composedPath()[0] is the host), so the chip is found in its shadow root by
// its key (data-key="art:<card>:<file>"); none (re-rendered away): null.
function inboxChipOf(host, cardId, artifactId) {
  var root = host && host.shadowRoot;
  if (!root) return null;
  var want = 'art:' + cardId + ':' + artifactId;
  var chips = root.querySelectorAll('[data-art]');
  for (var i = 0; i < chips.length; i++) if (chips[i].getAttribute('data-key') === want) return chips[i];
  return null;
}

// Open, or still closing: the collapse runs over the body, so it stays until then.
function cardBodyShown(key) {
  return _expanded.has(key) || !!_cardClosing[key];
}
// The card's body follows its open state. Opened, it is built at once — its
// agent tree painted — before the row grows over it. Closed, it is let go once
// the collapse has run (at once without motion): the agent tree and every
// approval card leave the DOM with their shadow trees. Reopening (or closing
// again) drops a release still pending.
function syncCardBody(key, now) {
  if (_cardClosing[key]) clearTimeout(_cardClosing[key]);
  delete _cardClosing[key];
  if (_expanded.has(key) || now || !canAnimate()) {
    paintCardBody(key);
    return;
  }
  _cardClosing[key] = setTimeout(function() {
    delete _cardClosing[key];
    paintCardBody(key);
  }, Math.max(MOTION.expand, MOTION.fade) + 60);
}
function syncCardBodies() {
  var keys = Object.create(null);
  for (var k in _cardBodies) keys[k] = true;
  _expanded.forEach(function(x) { keys[x] = true; });
  for (var c in _cardClosing) keys[c] = true;
  for (var key in keys) paintCardBody(key);
}
// The open card's body: a light-DOM child of the element that draws the card,
// in the card's slot (slot="body:<key>"). Morphed, not rewritten (spec 12 §4.4):
// a focused control, a running spinner, a scrolled list, a goal draft and an
// open model menu survive a live update.
function paintCardBody(key) {
  var host = _cardHost[key];
  var s = _sessionCache[key];
  var b = _cardBodies[key];
  if (!host || !s || !_cardDrawn[key] || !cardBodyShown(key)) {
    if (b) {
      if (b.el.parentNode) b.el.parentNode.removeChild(b.el);
      delete _cardBodies[key];
    }
    return;
  }
  if (!b) {
    var el = document.createElement('div');
    el.className = 'card-slot';
    el.setAttribute('slot', 'body:' + key);
    el.setAttribute('data-session-key', key);
    b = _cardBodies[key] = { el: el, html: null };
  }
  if (b.el.parentNode !== host) host.appendChild(b.el);
  var col = _cardCol[key];
  var html = renderCardBody(s, col);
  if (b.html !== html && !isEditingGoal(b.el) && !isPickingModel(b.el)) {
    var goalDraft = captureGoalDraft(b.el);
    morphInnerHtml(b.el, html);
    restoreGoalDraft(b.el, goalDraft);
    b.html = html;
    updateTimersIn(b.el);
  }
  // The body's approval cards and model picker take their data where it
  // changed (also while an open menu holds the body still), the agent tree its
  // own (every agent's status, time and spend; the folds).
  acHydrate(b.el);
  mpHydrate(b.el);
  var tree = atCardData(s, col);
  atHydrate(b.el, { tree: tree, treeSig: tree ? JSON.stringify(tree) : '' });
}
// Single-card path (sessionUpdated push, title patch, 지시/응답 arrival, a write
// in flight) — the card's face data where it changed, then its body.
function refreshCard(key) {
  var host = _cardHost[key];
  var s = _sessionCache[key];
  if (!host || !s) return;
  if (_cardDrawn[key]) {
    var c = cardOf(s, _cardCol[key] || 'idle');
    if (JSON.stringify(c) !== JSON.stringify(_cardData[key])) {
      _cardData[key] = c;
      inboxPaint(host);
    }
  }
  paintCardBody(key);
}

// Second line of the collapsed card (§3.1-3): what the session needs or is doing.
function cardSummary(s, col, headline) {
  var current = cardCurrentTask(s);
  if (col !== 'closed' && s.pendingPermissions && s.pendingPermissions.length) return permissionSummary(s);
  var q = s.pendingQuestion;
  if (col === 'waiting' && q && (q.question || q.title)) return q.question || q.title;
  // Waiting out a retry: the error behind it is what this card is "doing".
  var resume = pendingAutoResume(s, col);
  if (resume && resume.reason) return '오류: ' + resume.reason;
  // The task row (cardTaskRow) names the running task — the summary
  // only does when that row is hidden.
  if (col === 'working' && current && !dhShow('tasks')) return current.content;
  if (s.summaryTitle && s.summaryTitle !== headline) return s.summaryTitle;
  // SSOT 2026-10-29 T4: the face names one task — the one in progress (the
  // task row). The summary never falls back to another task (the last done or
  // the last in the list read as a second task next to the running one).
  if (s.title && s.title !== headline) return s.title;
  return '';
}

// The armed automatic resume (server KanbanAutoResume) of a RUNNING card that
// is not running a turn right now — idle until a retry timer or a goal
// re-check starts it again. null when the card is running or has none.
function pendingAutoResume(s, col) {
  if (col !== 'working' || s.activityState === 'working' || !s.autoResume) return null;
  return s.autoResume;
}

// One line for an armed resume: what starts the session again, when, which
// attempt. Absolute clock time (no countdown), so equal data renders equal HTML.
function autoResumeLabel(r) {
  if (!r) return '';
  if (r.kind === 'goal-eval') return 'Goal 완료 판정 중';
  var at = Number(r.at) || 0;
  var what = r.kind === 'goal-eval-retry' ? 'Goal 판정 재시도' : '자동 재개';
  var text = (at ? formatTaskTime(at) + ' ' : '') + what;
  var attempt = Number(r.attempt) || 0;
  var max = Number(r.maxAttempts) || 0;
  if (attempt && max) text += ' · 시도 ' + attempt + '/' + max;
  return text;
}

// Owner badge (§3.1-3): in the All Users view every card head names its owner,
// right-aligned, in one of the 8 hues of --ob-N-*. Like the env badges
// (_buildEnvIndex), the owners on the board are assigned together: in sorted
// order each takes its hash slot (djb2 % 8) when free, the rest probe forward to
// the next free slot. Up to 8 owners never share a colour, and the result
// depends only on the set of owners — one person keeps one colour on every card
// and render while that set stands. An owner not on the board yet gets its
// hash slot.
var OWNER_BADGE_HUES = 8;
var _ownerIndex = null; // ownerId → hue slot for the board on screen (renderBoard)
function assignOwnerHues(ids) {
  var seen = Object.create(null);
  var sorted = [];
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i] || '');
    if (id && !seen[id]) { seen[id] = true; sorted.push(id); }
  }
  sorted.sort();
  var out = Object.create(null);
  var taken = [];
  var pending = [];
  for (var j = 0; j < sorted.length; j++) {
    var slot = _hashStr(sorted[j]) % OWNER_BADGE_HUES;
    if (!taken[slot]) { taken[slot] = true; out[sorted[j]] = slot; }
    else pending.push(sorted[j]);
  }
  for (var k = 0; k < pending.length; k++) {
    var start = _hashStr(pending[k]) % OWNER_BADGE_HUES;
    out[pending[k]] = start; // more owners than hues: share the hash slot
    for (var step = 1; step < OWNER_BADGE_HUES; step++) {
      var probe = (start + step) % OWNER_BADGE_HUES;
      if (!taken[probe]) { taken[probe] = true; out[pending[k]] = probe; break; }
    }
  }
  return out;
}
function ownerBadgeHue(ownerId) {
  var id = String(ownerId || '');
  var slot = _ownerIndex ? _ownerIndex[id] : undefined;
  return typeof slot === 'number' ? slot : _hashStr(id) % OWNER_BADGE_HUES;
}
// The task in progress (SSOT 2026-10-22 T3): first in_progress task in list order.
function cardCurrentTask(s) {
  var tasks = (s && s.tasks) || [];
  for (var i = 0; i < tasks.length; i++) if (tasks[i] && tasks[i].status === 'in_progress') return tasks[i];
  return null;
}
// The face's task row (T3): the task in progress, while the session runs or
// waits on the user (gated by the 'tasks' header field); null when none.
function cardTaskRow(s, col) {
  if (!dhShow('tasks') || (col !== 'working' && col !== 'waiting')) return null;
  return cardCurrentTask(s);
}
// Context level, one table for the face metric, the 세션 정보 summary and the
// context block. With the session's auto-compact point (re-context-window D9):
// from 0.8 of it a warning, from 0.95 danger — the point is where the history
// is cut to a summary, and it differs per session (750K of a Claude 1M window,
// 160K of a 200K one), so window bands never warned there. A scheduled
// compaction is danger. Point unknown (one argument, as before): bands of the
// window used — over 60% a warning, over 80% danger (spec 13 §3.7).
function ctxLevel(pct, used, auto, pending) {
  if (pending) return 'ctx-danger';
  var u = toNum(used), a = toNum(auto);
  if (u > 0 && a > 0) return u / a >= 0.95 ? 'ctx-danger' : u / a >= 0.8 ? 'ctx-warn' : '';
  var n = toNum(pct);
  return n > 80 ? 'ctx-danger' : n > 60 ? 'ctx-warn' : '';
}
// The context % as the dashboard writes it — face metric, 세션 정보 summary:
// rounded, never over 100 (the block's pill, <ui-context-window>, rounds and caps the same).
function ctxPercent(pct) {
  return Math.round(Math.min(toNum(pct), 100));
}
// The outcome on the face (spec 13 §3.7 — the compact tier's PR link in Copilot
// and Devin): the PR number and its state as a metric. The face is one toggle,
// so the metric is not a link; the open card's short ref and the titled link in
// 세션 정보 are. The state is a word on screen ("#12 머지됨") and a tone (colour,
// never alone); an unknown state shows the bare number. The title adds the PR's title.
var PR_STATE_LABEL = { open: '열림', draft: '초안', merged: '머지됨', closed: '닫힘' };
var PR_STATE_TONE = { open: 'run', merged: 'done', closed: 'fail' };
function cardPrMetric(s) {
  if (!dhShow('links') || !s.prUrl || !s.prShortRef) return null;
  var ref = String(s.prShortRef);
  var m = /([0-9]+)$/.exec(ref);
  var num = m ? '#' + m[1] : ref;
  var raw = String(s.prStatus || '').toLowerCase(); // a resource may say "MERGED"
  var st = Object.prototype.hasOwnProperty.call(PR_STATE_LABEL, raw) ? raw : '';
  var word = st ? PR_STATE_LABEL[st] : '';
  var metric = { text: num + (word ? ' ' + word : ''), glyph: 'pr', title: 'PR ' + num + (word ? ' ' + word : '') + (s.prTitle ? ' — ' + s.prTitle : '') };
  if (PR_STATE_TONE[st]) metric.tone = PR_STATE_TONE[st];
  return metric;
}
// The context metric's tooltip (re-context-window D16): how far to the session's
// auto-compact point when it is known.
function cardCtxTitle(s, pct) {
  var auto = toNum(s.autoCompactTokens), used = toNum(s.contextTokens);
  if (!(auto > 0 && used > 0)) return 'Context window used' + (toNum(pct) > 80 ? ' — 80% 넘게 찼다' : '');
  var short = function(n) { return formatTokens(n).replace(/[.]0(?=[KMBT]$)/, ''); };
  return '컨텍스트 ' + ctxPercent(pct) + '% · ' + (s.compactPending ? '다음 입력 때 자동 압축'
    : used >= auto ? '자동 압축 지점을 넘음'
    : '자동 압축 ' + short(auto) + '까지 ' + short(auto - used));
}
// A sub-agent's dot on the face, in spawn order (a stopped one is a square).
function agentDotOf(a) {
  var st = agentStatusOf(a);
  return st === 'completed' ? 'done' : st === 'running' || st === 'failed' || st === 'stopped' ? st : 'unknown';
}

// One session as the element's card (§2.1 reference anatomy, audited in spec 13
// §3.7): ✦ (or the CRON badge) + headline [+ owner badge] / why-here line /
// current task / sub-agents / tokens · cost / artifact chips / status · recency,
// tasks done/total · context % (levelled) · media · PR. Text only — the element
// escapes it. Equal data gives an equal card (clocks are the element's tick).
function cardOf(s, col) {
  // Server-resolved headline (#762) — displayHeadline reflects the full
  // priority chain (summaryTitle then issueTitle then prTitle then title then
  // 'Untitled'). The local fallback covers the WS patch path where
  // summaryTitleChanged / sessionUpdated may have rewritten only a subset.
  var headline = s.displayHeadline || s.summaryTitle || s.title;
  var trunc = dhTruncate('title');
  var card = {
    id: s.key,
    title: dhShow('title') ? String(trunc ? String(headline || '').slice(0, trunc) : (headline || '')) : '',
    status: 'done',
    bodyMode: 'slot',
  };
  var summary = cardSummary(s, col, headline);
  if (summary) card.summary = summary;
  // Status (the tinted tag, re-agent-inbox D1): an armed automatic resume waits.
  var resume = pendingAutoResume(s, col);
  var acc = Number(s.activeAccumulatedMs) || 0;
  if (resume) {
    card.status = 'waiting';
    card.statusText = autoResumeLabel(resume);
  } else if (col === 'waiting') {
    card.status = 'waiting';
    if (toNum(s.waitingSince) > 0) card.since = toNum(s.waitingSince);
  } else if (col === 'working') {
    card.status = 'running';
    var leg = Number(s.activeLegStartedAtMs) || 0;
    if (leg) card.since = leg;
    if (acc) card.elapsedMs = acc;
  } else if (col === 'closed') {
    card.status = 'idle';
    card.statusText = s.terminated ? 'Archived' : 'Sleeping';
  } else if (acc) {
    card.elapsedMs = acc;
  } else {
    card.statusText = 'Idle';
  }
  // Recency (spec 13 §3.7): a finished card since its work finished — only the
  // exact stamp, never lastActivity.
  if ((col === 'idle' || col === 'closed') && toNum(s.finishedAt) > 0) card.since = toNum(s.finishedAt);
  // The task in progress (T3), while the session runs or waits on the user.
  var task = cardTaskRow(s, col);
  if (task) {
    card.task = { label: String(task.content || '') };
    if (task.id) card.task.id = String(task.id);
    if (Number(task.startedAt) > 0) card.task.startedAt = Number(task.startedAt);
  }
  var agents = s.agents || [];
  if (agents.length) {
    var ac = agentCounts(agents);
    card.agents = { total: Math.max(toNum(s.agentsTotal), agents.length), running: ac.running, done: ac.completed, failed: ac.failed, dots: agents.slice(0, 6).map(agentDotOf) };
  }
  var titles = {};
  // Total tokens · API-equivalent cost (T1/T2), the task total: main agent and
  // every subagent (SSOT 2026-10-26 T3). Gated by the 'tokens' / 'cost' fields.
  var u = s.tokenUsage;
  if (u) {
    var sub = s.subagentSpend;
    var who = 'task 합계: 메인 + 서브에이전트' + (sub && toNum(sub.agents) > 0 ? ' ' + toNum(sub.agents) + '개' : '');
    var part = toNum(u.partialSince) > 0 ? ' · 부분 합계 (' + new Date(toNum(u.partialSince)).toLocaleString() + ' 이후 집계)' : '';
    if (dhShow('tokens')) {
      card.tokens = cardTotalTokens(u);
      titles.tokens = '총 토큰 (' + who + ') — 입력 ' + formatTokens(u.totalInputTokens) + ' · 출력 ' + formatTokens(u.totalOutputTokens)
        + ' · 캐시 읽기 ' + formatTokens(u.totalCacheReadTokens) + ' · 캐시 쓰기 ' + formatTokens(u.totalCacheCreateTokens) + part;
    }
    if (dhShow('cost')) {
      card.costUsd = toNum(u.totalCostUsd);
      titles.cost = 'API 환산 비용 (' + who + ')' + part;
    }
  }
  var sibling = isSiblingSession(s);
  // Artifacts (T5): the newest few as chips that open the viewer (ui-artifact),
  // never an image on the face. A sibling instance's files are not on this disk.
  var arts = s.artifacts;
  if (!sibling && s.conversationId && arts && toNum(arts.count) > 0 && arts.recent && arts.recent.length) {
    card.artifactsCount = toNum(arts.count);
    card.artifacts = arts.recent.slice(0, 4).map(function(a) { return { id: String(a.id), name: String(a.name || ''), kind: a.kind || 'file' }; });
  }
  if (dhShow('tasks') && s.tasks && s.tasks.length) {
    card.steps = { done: s.tasks.filter(function(t) { return t.status === 'completed'; }).length, total: s.tasks.length };
  }
  var ctxPct = u ? (u.contextUsagePercent || 0) : 0;
  if (dhShow('contextwindow') && ctxPct > 0) {
    // re-context-window D16: the level against the auto-compact point when known.
    var lv = ctxLevel(ctxPct, s.contextTokens, s.autoCompactTokens, s.compactPending);
    card.contextPct = ctxPct;
    card.contextLevel = lv === 'ctx-danger' ? 'danger' : lv === 'ctx-warn' ? 'warn' : '';
    titles.context = cardCtxTitle(s, ctxPct);
  }
  if (titles.tokens || titles.cost || titles.context) card.titles = titles;
  var metrics = [];
  // User media (SSOT 2026-10-25): a paperclip count, no image on the board.
  var media = !sibling && s.conversationId ? toNum(s.userMedia && s.userMedia.count) : 0;
  if (media > 0) metrics.push({ text: String(media), glyph: 'attach', title: '지시 첨부 ' + media + '개', label: '지시 첨부 ' + media + '개' });
  var pr = cardPrMetric(s);
  if (pr) metrics.push(pr);
  if (metrics.length) card.metrics = metrics;
  // A cron run leads with the CRON badge instead of the spark (SSOT 2026-10-23 T3).
  if (s.cronJob && s.cronJob.name) card.lead = { text: 'CRON', glyph: 'clock', title: '크론 잡: ' + s.cronJob.name };
  // A starred card leads with ★ (SSOT 2026-10-30 T1.3); a starred cron run reads ★ CRON.
  if (s.starred === true) {
    var starTitle = '즐겨찾기 — 항상 맨 위, 자동 sleep·보관 안 함';
    card.lead = card.lead
      ? { text: '\\u2605 ' + card.lead.text, glyph: card.lead.glyph, title: starTitle + ' · ' + card.lead.title }
      : { text: '\\u2605', title: starTitle };
  }
  // Owner badge (§3.1-3): in the All Users view every card names its owner.
  var owner = currentUserId ? '' : s.ownerName || s.ownerId || '';
  if (owner) card.badge = { text: String(owner), hue: ownerBadgeHue(s.ownerId || owner), title: String(owner) };
  return card;
}

// Task window on the open card (§3.1-4, spec 13): list order, the in-progress
// step is the solid dot. Every task shows its id (SSOT 2026-10-22 T8); a
// completed task its elapsed time and the tool calls made while it ran, the
// running one its live time and calls so far (T7). Over the dhMax('tasks')
// budget the earliest completed steps fold away first. The whole ledger —
// every task of the list and the earlier lists — is the panel's:
// 전체 task N개 → opens it (spec 13, the card is a window, not a second list).
function renderTaskMeta(t) {
  // Task timestamps come from the ledger: numbers only.
  var started = Number(t.startedAt) || 0;
  var completed = Number(t.completedAt) || 0;
  var removed = Number(t.removedAt) || 0;
  // Task view T2: a task a later plan dropped says so — never a running clock.
  var fate = taskFateOf(t);
  var parts = [];
  if (fate === 'done' && started && completed) parts.push(formatDuration(completed - started) || '0s');
  else if (fate === 'active' && started) parts.push('<span class="task-elapsed" data-since="' + started + '"></span>');
  else if (fate === 'dropped' || fate === 'skipped' || fate === 'paused') {
    parts.push(TASK_FATE_LABEL[fate] + (fate === 'dropped' && started && removed > started ? ' ' + formatDuration(removed - started) : ''));
  }
  // SSOT 2026-10-29 T5: a count shared by tasks that ran together is fractional — a whole number on screen.
  if (fate !== 'pending' && fate !== 'skipped') parts.push('<span class="tl-tools" title="툴 호출 수">툴 ' + Math.round(toNum(t.toolCalls)) + '회</span>');
  return parts.join(' &middot; ');
}
function renderTimelineItem(t) {
  var cls = t.status === 'in_progress' ? ' is-current' : (t.status === 'completed' ? ' is-done' : ' is-pending');
  var meta = renderTaskMeta(t);
  return '<li class="tl-item' + cls + '">'
    + (t.id ? '<span class="tl-id">#' + esc(t.id) + '</span>' : '')
    + '<span class="tl-text">' + esc(t.content) + '</span>'
    + (meta ? '<span class="tl-time">' + meta + '</span>' : '') + '</li>';
}
function renderTimeline(s) {
  if (!dhShow('tasks')) return '';
  var tasks = s.tasks || [];
  var earlier = s.earlierTasks || [];
  // Task view T2: steps a new plan dropped before they ran were never work —
  // the count (and the panel it opens) does not grow with them.
  var ran = 0;
  for (var e = 0; e < earlier.length; e++) if (taskFateOf(earlier[e]) !== 'skipped') ran++;
  if (tasks.length === 0 && ran === 0) return '';
  var max = dhMax('tasks', 5);
  var folded = 0;
  var tail = 0;
  var shown = [];
  var drop = Math.max(0, tasks.length - max);
  for (var i = 0; i < tasks.length; i++) {
    if (drop > 0 && tasks[i].status === 'completed') { drop--; folded++; continue; }
    shown.push(tasks[i]);
  }
  if (shown.length > max) { tail = shown.length - max; shown = shown.slice(0, max); }
  var hidden = folded + tail + ran;
  var html = '<div class="tl-wrap">';
  if (folded > 0) html += '<div class="tl-more">+' + folded + ' completed</div>';
  if (shown.length) html += '<ul class="tl">' + shown.map(renderTimelineItem).join('') + '</ul>';
  if (tail > 0) html += '<div class="tl-more">+' + tail + ' more</div>';
  if (hidden > 0) {
    html += '<button type="button" class="tl-toggle" onclick="event.stopPropagation();openPanel(\\'' + escJs(s.key) + '\\',\\'tasks\\',\\'\\',event.detail===0)">'
      + '전체 task ' + (tasks.length + ran) + '개 &rarr;</button>';
  }
  return html + '</div>';
}

// ── Agent tree (spec 12 §4, .prd/12-dashboard-agent-tree-spec.md) ──
// A card is the main agent; s.agents are the subagents it (or another
// subagent) started, in spawn order. Each has its own tasks and its own work
// log (entries with its agentId). Status always shows as an icon AND a word.
// The kit status (.ui-status) tone per agent status; the rest read as the muted dot.
var AGENT_STATUS_TONE = { running: 'run', waiting: 'wait', resuming: 'wait', completed: 'done', failed: 'fail' };
var AGENT_STATUS_LABEL = { running: '실행 중', completed: '완료', failed: '실패', stopped: '중단', unknown: '확인 불가', waiting: '입력 대기', idle: '대기', resuming: '재개 대기', sleeping: '휴면', archived: '보관' };
var _anOpen = Object.create(null); // tree namespace|node id → a fold the user chose (absent = the default)
var _panelAgent = ''; // the node the open panel shows ('' = the root, the main agent)
var _panelAgentIdsShown = Object.create(null); // agent ids the panel tree knows now
var _panelAgentsHtml = ''; // what the agent section last rendered (a live update with the same data writes nothing)

function agentStatusOf(a) {
  return a && Object.prototype.hasOwnProperty.call(AGENT_STATUS_LABEL, a.status) ? a.status : 'unknown';
}
function agentName(a) {
  return 'A' + toNum(a && a.n) + (a && a.type ? ' ' + a.type : '');
}
function agentCounts(agents) {
  var c = { running: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 };
  var list = agents || [];
  for (var i = 0; i < list.length; i++) {
    var st = agentStatusOf(list[i]);
    c[st] = (c[st] || 0) + 1;
  }
  return c;
}
// Status icon: shape + the word next to it; colour is a third cue, never the only one.
function agentIconHtml(st) {
  if (st === 'running') return '<span class="spinner ag-spinner" aria-hidden="true"></span>';
  if (st === 'completed') return '<i data-ui-icon="check"></i>';
  if (st === 'failed') return '<i data-ui-icon="cross"></i>';
  if (st === 'stopped') return '<i data-ui-icon="stop"></i>';
  if (st === 'waiting') return '<i data-ui-icon="clock"></i>';
  if (st === 'resuming') return '<i data-ui-icon="refresh"></i>';
  if (st === 'idle') return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="3"/></svg>';
  if (st === 'sleeping') return '<i data-ui-icon="moon"></i>';
  if (st === 'archived') return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="3" rx="0.8"/><path d="M3.5 6.5v6h9v-6M6.5 9h3"/></svg>';
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="4.5" stroke-dasharray="2.2 2"/></svg>';
}
// A node's time: the root's active time (live while it runs, by the 1 Hz
// tick), a running subagent's elapsed, else its run time.
function agentTimeHtml(a) {
  if (a && a.root) {
    var acc = toNum(a.activeMs);
    // An open leg runs on while the turn waits for a permission (the card reads waiting).
    var leg = a.status === 'running' || a.status === 'waiting' ? (Number(a.legStartedAt) || 0) : 0;
    if (!acc && !leg) return '';
    return '<span class="card-timer-live" data-leg-started="' + leg + '" data-accumulated="' + acc + '" title="활성 시간"></span>';
  }
  var started = Number(a.startedAt) || 0;
  if (agentStatusOf(a) === 'running') return started ? '<span class="task-elapsed" data-since="' + started + '"></span>' : '';
  var ms = toNum(a.durationMs) || (Number(a.endedAt) && started ? Number(a.endedAt) - started : 0);
  return ms > 0 ? (formatDuration(ms) || '0s') : '';
}
// The line under a node: its task in progress, else the SDK's summary, else its last tool.
function agentActivity(a) {
  var tasks = a.tasks || [];
  for (var i = 0; i < tasks.length; i++) if (tasks[i] && tasks[i].status === 'in_progress') return '#' + tasks[i].id + ' ' + (tasks[i].activeForm || tasks[i].content || '');
  if (a.summary) return a.summary;
  if (a.lastTool) return '마지막 도구 ' + a.lastTool;
  return '';
}

// ── One node type (recursive UI): the main agent is the root of the session's
// agent tree; every subagent is a node of the same shape under the agent that
// started it. One model feeds every surface — the card tree and the panel's
// subtree (<ui-agent-tree>, atTreeData), the panel's focused-node header and
// the work log's child blocks — so nothing about the root is special but its
// fields: active time instead of a run time, the model, the session's tasks.

// The root's status from lifecycle evidence — never "stopped" for a closed card.
// Same order as the card's status (cardOf): a waiting card
// reads waiting even while its activity says working.
function rootStatusOf(s, col) {
  if (s && s.terminated) return 'archived';
  if (col === 'closed') return 'sleeping';
  if (col === 'waiting' || (s && s.activityState === 'waiting')) return 'waiting';
  if (pendingAutoResume(s || {}, col)) return 'resuming';
  var act = s ? s.activityState : '';
  if (act === 'working') return 'running';
  if (act === 'sleeping') return 'sleeping';
  return 'idle';
}
// A subagent record as a node: its own fields, a normalised status and tool count.
function agentNodeOf(a) {
  var n = {};
  for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) n[k] = a[k];
  n.id = String(a.id);
  n.status = agentStatusOf(a);
  n.toolCalls = toNum(a.toolCalls);
  n.children = [];
  return n;
}
// Pure: the session's agent tree. The root is the main agent; a subagent hangs
// from the agent that started it, in spawn order (never re-sorted by status). A
// parent that is not on the card, the node itself or a cycle hangs it from the
// root. Agents known only from the log (extras) are root children marked
// unknown. root.byId maps every id ('' = the root) to its node.
function agentTreeOf(s, col, extras) {
  var r = (s && s.agentRoot) || {};
  var root = {
    id: '',
    root: true,
    label: '메인',
    status: rootStatusOf(s, col),
    model: String((s && s.model) || '').replace(/^claude-/, ''),
    tasks: (s && s.tasks) || [],
    toolCalls: toNum(r.toolCalls),
    lastTool: r.lastTool || '',
    activeMs: toNum(s && s.activeAccumulatedMs),
    legStartedAt: Number(s && s.activeLegStartedAtMs) || 0,
    parentId: '',
    children: [],
    byId: null,
  };
  var byId = Object.create(null);
  var nodes = [];
  var list = (s && s.agents) || [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || !a.id || byId[a.id]) continue;
    var n = agentNodeOf(a);
    byId[n.id] = n;
    nodes.push(n);
  }
  for (var j = 0; j < nodes.length; j++) {
    var node = nodes[j];
    var p = node.parentId && byId[node.parentId] && node.parentId !== node.id ? String(node.parentId) : '';
    // A walk up that comes back to this node is a cycle: hang it from the root.
    // (A loop above it that does not pass through it is broken by its own members.)
    var walked = Object.create(null);
    for (var up = p; up; ) {
      if (up === node.id) { p = ''; break; }
      if (walked[up]) break;
      walked[up] = true;
      var pn = byId[up];
      up = pn && pn.parentId && byId[pn.parentId] ? String(pn.parentId) : '';
    }
    node.parentId = p;
  }
  for (var m = 0; m < nodes.length; m++) (nodes[m].parentId ? byId[nodes[m].parentId] : root).children.push(nodes[m]);
  var ex = extras || [];
  for (var x = 0; x < ex.length; x++) {
    var xid = ex[x] ? String(ex[x]) : '';
    if (!xid || byId[xid]) continue;
    var lo = { id: xid, status: 'unknown', logOnly: true, toolCalls: 0, parentId: '', children: [] };
    byId[xid] = lo;
    root.children.push(lo);
  }
  byId[''] = root;
  root.byId = byId;
  return root;
}
// How many nodes are below this one (the panel's focused-node header).
function anDesc(node) {
  var out = { n: 0 };
  var stack = node.children.slice();
  var met = Object.create(null);
  while (stack.length) {
    var c = stack.pop();
    if (met[c.id]) continue;
    met[c.id] = true;
    out.n++;
    for (var i = 0; i < c.children.length; i++) stack.push(c.children[i]);
  }
  return out;
}
function agentNodeName(node) {
  if (node.root) return node.label;
  if (node.logOnly) return '에이전트 ' + node.id.slice(-6);
  return agentName(node);
}
// The name slot (the panel's focused-node header, a work log child block):
// the root's label and model; a subagent's spawn number and type.
function agentNodeLine(node) {
  if (node.root) return '<span class="ag-type">' + esc(node.label) + '</span>' + (node.model ? '<span class="ag-model">' + esc(node.model) + '</span>' : '');
  if (node.logOnly) return '<span class="ag-type">기타 에이전트</span><span class="ag-model">' + esc(node.id.slice(-6)) + '</span>';
  return '<span class="ag-id">A' + toNum(node.n) + '</span><span class="ag-type">' + esc(node.type || 'agent') + '</span>';
}
// The focused node header's one accessible name (its visual columns are not
// read one by one). The live time is not in it: it changes every second.
function agentNodeAria(node, desc) {
  var parts = [agentNodeName(node) + (node.root && node.model ? ' ' + node.model : '') + (node.description ? ' — ' + node.description : ''), AGENT_STATUS_LABEL[node.status] || '', '툴 ' + toNum(node.toolCalls)];
  if (node.root) {
    var tasks = node.tasks || [];
    var done = 0;
    for (var i = 0; i < tasks.length; i++) if (tasks[i] && tasks[i].status === 'completed') done++;
    if (tasks.length) parts.push('task ' + done + '/' + tasks.length);
  }
  if (node.background) parts.push('배경');
  if (desc && desc.n) parts.push('하위 ' + desc.n);
  var act = agentActivity(node);
  if (act) parts.push(act);
  return parts.join(', ');
}
// Spec 12: bring a live node in line with freshly rendered markup, keeping
// every node whose place did not change — so focus, a list's scroll and a
// running spinner's animation survive a live update. Children pair up in
// order; an agent's path crumb pairs only with the crumb of the same agent.
function domKeyOf(n) {
  if (n.nodeType !== 1) return '#' + n.nodeType;
  var k = n.getAttribute('data-agent-select');
  // data-mk: any row that stands for one record (a goal) pairs only with that record's row,
  // so a focused control is never rebound to the record that took its place.
  if (k === null) k = n.getAttribute('data-mk');
  if (k !== null) return n.tagName + '|@' + k;
  // Unkeyed: tag + id + the base class (the first token — state classes come
  // after it), so a section inserted before others does not shift them onto
  // each other.
  var cls = n.getAttribute('class') || '';
  var sp = cls.indexOf(' ');
  return n.tagName + '|' + (n.id || '') + '.' + (sp < 0 ? cls : cls.slice(0, sp));
}
function domMorph(a, b) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  var i;
  for (i = a.attributes.length - 1; i >= 0; i--) {
    if (!b.hasAttribute(a.attributes[i].name)) a.removeAttribute(a.attributes[i].name);
  }
  for (i = 0; i < b.attributes.length; i++) {
    var at = b.attributes[i];
    if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
  }
  domMorphChildren(a, b);
  // What a user changed in a control is live state, not an attribute: follow
  // the fresh markup (a rejected model pick shows the session's model again).
  // A control in use is never morphed (isEditingGoal / isPickingModel).
  var tag = a.tagName;
  if (tag === 'SELECT') {
    if (a.selectedIndex !== b.selectedIndex) a.selectedIndex = b.selectedIndex;
  } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (a.value !== b.value) a.value = b.value;
    if (a.checked !== b.checked) a.checked = b.checked;
  }
}
function domKeyLater(n, key) {
  for (; n; n = n.nextSibling) if (domKeyOf(n) === key) return true;
  return false;
}
function domMorphChildren(a, b) {
  var cur = a.firstChild;
  var next = b.firstChild;
  while (next) {
    // A live node the fresh markup no longer has (an agent row that left)
    // goes first, so the rows after it still pair with their own nodes.
    if (cur && domKeyOf(cur) !== domKeyOf(next) && !domKeyLater(next, domKeyOf(cur))) {
      var dropped = cur;
      cur = cur.nextSibling;
      a.removeChild(dropped);
      continue;
    }
    var after = next.nextSibling;
    if (cur && domKeyOf(cur) === domKeyOf(next)) {
      domMorph(cur, next);
      cur = cur.nextSibling;
    } else {
      a.insertBefore(next, cur); // moved out of the fresh tree, which is thrown away
    }
    next = after;
  }
  while (cur) {
    var gone = cur;
    cur = cur.nextSibling;
    a.removeChild(gone);
  }
}
// Write html into el's children through domMorph (one fresh parse, no node
// rebuilt that did not change).
function morphInnerHtml(el, html) {
  var tmp = document.createElement('div');
  tmp.innerHTML = html;
  domMorphChildren(el, tmp);
}
// ── Agent tree — @2lab.ai/ui <ui-agent-tree> (affectUI review batch 2) ──
// The session's agent tree (spec 12) in two places: the open card (compact —
// who is doing what now) and the panel's agents section (rich — the focused
// node's subtree, a card per agent on one waterfall axis). The element builds
// the tree from parentId, rolls every branch's tokens, cost and tool calls up,
// puts why an agent needs you or failed on its node, ticks the running times
// and owns the keyboard (the WAI-ARIA tree) and its focus across live updates.
// The dashboard maps the session onto its nodes (atTreeData), keeps the folds
// (_anOpen: on the card the root and its children start open, in the panel the
// focused node's children; deeper parents start folded) and answers its events:
// ui-select opens that agent in the panel (card) or drills into it (panel),
// ui-toggle folds. The markup is a slot per tree (static per session); the data
// is set on the element by atPaint, only where it changed.
var AT_ROOT = ':main'; // the main agent's node id (a tool call id never starts with ':')
var AT_STATUS = { running: 'running', completed: 'done', failed: 'failed', stopped: 'cancelled', unknown: 'unknown' };
// The main agent (rootStatusOf): waiting on the user is "needs you"; a resume
// or the next instruction is waiting for something else; a closed session is done.
var AT_ROOT_STATUS = { running: 'running', waiting: 'needs_you', resuming: 'waiting', idle: 'waiting', sleeping: 'done', archived: 'done' };
// Whether the last input was a key: ui-select carries only the id, and a
// keyboard opening moves focus into the panel (a click leaves it alone).
var _atKeyed = false;

function atIdOf(node) {
  return node.root ? AT_ROOT : String(node.id);
}
// What the main agent waits on: the permission prompt(s), else the question.
function atRootReason(s) {
  var perms = (s && s.pendingPermissions) || [];
  if (perms.length) return (perms[0].toolName || 'tool') + ' 실행 승인 필요' + (perms.length > 1 ? ' 외 ' + (perms.length - 1) + '건' : '');
  var q = s && s.pendingQuestion;
  return q ? String(q.question || q.title || '답변 대기') : '';
}
// Pure: one node of agentTreeOf as the element takes it (AgentTreeNode).
// The root is the main agent: its time is the session's active time (a
// running clock while a leg is open — also while the turn waits on a
// permission), its spend its own share of the task total (the task total less
// the subagents' share: the element adds the branch up again), its reason
// what it waits on, its line its current task unless the card face's task row
// already says it (rootLine). A subagent: A<n> type, its brief as the role,
// its own spend (none while its calls report no usage — never a false $0),
// what it does now — or, failed, what it last reported, as the reason.
function atNode(n, parentId, s, rootLine) {
  var d = { id: atIdOf(n), name: agentNodeName(n), status: 'unknown', toolCalls: toNum(n.toolCalls) };
  if (parentId) d.parentId = parentId;
  if (n.root) {
    d.status = AT_ROOT_STATUS[n.status] || 'waiting';
    var acc = toNum(n.activeMs);
    var leg = n.status === 'running' || n.status === 'waiting' ? toNum(n.legStartedAt) : 0;
    if (leg) d.startedAt = Math.max(0, leg - acc);
    else if (acc) { d.startedAt = 0; d.endedAt = acc; }
    var why = d.status === 'needs_you' ? atRootReason(s) : '';
    if (why) d.reason = why;
    var line = rootLine ? agentActivity(n) : '';
    if (line) d.summary = line;
    var tu = s && s.tokenUsage;
    var own = tu ? cardTotalTokens(tu) - spendTotal(s.subagentSpend) : 0;
    if (own > 0) {
      d.tokens = own;
      // Subagent costs are partly estimates: when they reach the task total the
      // root's share is unknown, not $0 — leave it off like any unreported spend.
      var ownCost = toNum(tu.totalCostUsd) - toNum(s.subagentSpend && s.subagentSpend.costUsd);
      if (ownCost > 0) d.costUsd = ownCost;
    }
    return d;
  }
  d.status = n.logOnly ? 'unknown' : AT_STATUS[n.status] || 'unknown';
  var role = n.logOnly ? '작업 로그에만 있는 에이전트' : (n.background ? '배경 · ' : '') + (n.description || '');
  if (role) d.role = role;
  var start = toNum(n.startedAt);
  if (start) {
    d.startedAt = start;
    var end = d.status === 'running' ? 0 : toNum(n.endedAt) || (toNum(n.durationMs) ? start + toNum(n.durationMs) : 0);
    if (end) d.endedAt = end;
  }
  var tk = spendTotal(n.spend);
  if (tk > 0) {
    d.tokens = tk;
    d.costUsd = toNum(n.spend.costUsd);
  }
  var act = agentActivity(n);
  if (act && d.status === 'failed') d.reason = act;
  else if (act) d.summary = act;
  return d;
}
// Pure: the subtree of anchor (an agentTreeOf node) as <ui-agent-tree> data —
// its nodes in spawn order (the anchor itself first when withRoot, else its
// children at the top) and the open branches: the reader's fold for this tree
// and node (_anOpen), else open down to openDepth. o.keep (atWindowOf): only
// the agents it names. Folds and selection are the host's (controlled): the
// element asks, the next paint answers.
function atTreeData(anchor, o) {
  var nodes = [];
  var expanded = [];
  function visit(n, parentId, depth) {
    var id = atIdOf(n);
    nodes.push(atNode(n, parentId, o.s, o.rootLine));
    var kids = o.keep ? n.children.filter(function(c) { return !!o.keep[c.id]; }) : n.children;
    if (!kids.length) return;
    var k = o.ns + '|' + id;
    if (Object.prototype.hasOwnProperty.call(_anOpen, k) ? !!_anOpen[k] : depth <= o.openDepth) expanded.push(id);
    for (var i = 0; i < kids.length; i++) visit(kids[i], id, depth + 1);
  }
  if (o.withRoot) visit(anchor, '', 0);
  else for (var i = 0; i < anchor.children.length; i++) if (!o.keep || o.keep[anchor.children[i].id]) visit(anchor.children[i], '', 0);
  return { nodes: nodes, density: o.density, title: o.title, selectedId: null, expanded: expanded };
}
// The open card's tree: the main agent at its root, compact (null: no subagents, no tree).
function atCardData(s, col) {
  if (!s || !s.agents || !s.agents.length) return null;
  return atTreeData(agentTreeOf(s, col, null), {
    s: s, ns: 'c|' + s.key, withRoot: true, openDepth: 1, density: 'compact', title: '에이전트', rootLine: !cardTaskRow(s, col),
  });
}
// One tree's slot: the token wrapper (.ui-tok) and the element, named by its
// tree (c|<key> the card, p|<key> the panel), with a light-DOM line until the
// library has loaded.
function atSlotHtml(cls, ns, fallback) {
  return '<div class="' + cls + ' ui-tok"><ui-agent-tree lang="ko" data-at-ns="' + escAttr(ns) + '">'
    + '<span class="at-fallback">' + esc(fallback) + '</span></ui-agent-tree></div>';
}
// Set a tree's data where it changed (a push that changes nothing writes
// nothing). Data set before the element is defined is taken when it upgrades.
function atPaint(el, d, sig) {
  if (!el || !d || el._atSig === sig) return;
  el._atSig = sig;
  el.data = d;
}
// The open card's tree takes its data from the body's paint (paintCardBody).
function atHydrate(body, p) {
  var el = p && p.tree && body && body.querySelector ? body.querySelector('ui-agent-tree[data-at-ns]') : null;
  if (el) atPaint(el, p.tree, p.treeSig);
}
// Open card (§4.2): the session's agent tree, the main agent at its root.
// Agents beyond the card's bound are named under it (the work log has them).
function renderAgentTree(s, col) {
  var list = s.agents || [];
  if (!list.length) return '';
  var total = Math.max(toNum(s.agentsTotal), list.length);
  return atSlotHtml('ag-tree', 'c|' + s.key, '에이전트 — 메인 + ' + total)
    + (total > list.length ? '<div class="ag-more">이전 에이전트 ' + (total - list.length) + '개는 카드 목록 밖 — 작업 로그에서 볼 수 있어요</div>' : '');
}
// What a tree asks for. Card: open the panel on that agent — by keyboard,
// focus lands on its header (openPanel's landing) and closing the panel gives
// it back to the tree, the opener. Panel (the 에이전트 트리 tab): focus that
// agent — the tabs, Tasks and the other sections follow; its header takes focus.
document.addEventListener('ui-select', function(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-AGENT-TREE' || !e.detail) return;
  var ns = el.getAttribute('data-at-ns') || '';
  var id = String(e.detail.id);
  var agentId = id === AT_ROOT ? '' : id;
  if (ns.indexOf('c|') === 0) {
    openPanel(ns.slice(2), 'agent', agentId, _atKeyed);
    return;
  }
  if (ns.indexOf('p|') !== 0) return;
  selectPanelAgent(agentId);
  var head = document.querySelector('#panel-agents .pa-focus');
  if (head && head.focus) head.focus();
});
// A fold the reader chose, kept per tree and node; the tree repaints with it.
document.addEventListener('ui-toggle', function(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-AGENT-TREE' || !e.detail) return;
  var ns = el.getAttribute('data-at-ns') || '';
  _anOpen[ns + '|' + String(e.detail.id)] = !!e.detail.expanded;
  if (ns.indexOf('c|') === 0) refreshCard(ns.slice(2));
  else paintTreeTab();
});
document.addEventListener('keydown', function() { _atKeyed = true; }, true);
document.addEventListener('pointerdown', function() { _atKeyed = false; }, true);

// ── Panel scope: which node's tasks and work log the panel shows (§4.3) ──
function panelAgentOf(s) {
  if (!_panelAgent || !s || !s.agents) return null;
  for (var i = 0; i < s.agents.length; i++) if (s.agents[i] && s.agents[i].id === _panelAgent) return s.agents[i];
  return null;
}
function panelAgentTasks() {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  if (!s) return undefined;
  if (!_panelAgent) return s.tasks;
  var a = panelAgentOf(s);
  return a ? (a.tasks || []) : [];
}
function panelAgentLabel() {
  if (!_panelAgent) return '';
  var a = panelAgentOf(panelSessionKey ? _sessionCache[panelSessionKey] : null);
  return a ? agentName(a) : '에이전트';
}
// Agents that wrote to the open log but are not on the card (over its bound): reachable all the same.
function panelLogOnlyAgents(s) {
  var known = Object.create(null);
  var list = (s && s.agents) || [];
  for (var i = 0; i < list.length; i++) known[list[i].id] = true;
  var out = [];
  var entries = (_wl && _wl.entries) || [];
  for (var j = 0; j < entries.length; j++) {
    var e = entries[j];
    if (!e) continue;
    // Its own entries or only the call that started it and that call's result.
    var ids = [e.agentId, e.agentRef];
    for (var k = 0; k < ids.length; k++) {
      var id = ids[k];
      if (id && !known[id]) { known[id] = true; out.push(String(id)); }
    }
  }
  return out;
}
// The board column a session sits in (the panel's root status reads it).
function sessionColOf(key) {
  var onCard = typeof _cardCol !== 'undefined' ? _cardCol[key] : '';
  if (onCard) return onCard;
  var s = _sessionCache[key];
  var cols = ['working', 'waiting', 'idle', 'closed'];
  for (var c = 0; c < cols.length; c++) {
    var arr = (_lastBoardData && _lastBoardData[cols[c]]) || [];
    for (var i = 0; i < arr.length; i++) if (arr[i] && (arr[i] === s || arr[i].key === key)) return cols[c];
  }
  return 'idle';
}
// The focused node's header — the same slots for every node, the root
// included: name, status in words, time, tools, tokens, description, activity.
// Spend (SSOT 2026-10-26 T2/T3): the root's is the task total — main agent and
// every subagent — with the subagents' share beside it (both summed by the
// server); a subagent's is its own API calls. Nothing is summed here.
function renderAgentFocus(node, s) {
  var st = node.status;
  var desc = anDesc(node);
  var bits = [];
  // The root's status and active time are the session's — the head chip shows
  // them (spec 13); its accessible name still says them. A subagent keeps its own.
  if (!node.root) {
    bits.push('<span class="ui-status pa-st"' + (AGENT_STATUS_TONE[st] ? ' data-tone="' + AGENT_STATUS_TONE[st] + '"' : '') + (st === 'running' ? ' data-live' : '') + '>' + esc(AGENT_STATUS_LABEL[st] || '') + '</span>');
    var time = agentTimeHtml(node);
    if (time) bits.push(time);
  }
  bits.push('툴 ' + toNum(node.toolCalls));
  if (node.root) {
    var tu = s && s.tokenUsage;
    var tk = cardTotalTokens(tu);
    if (tk > 0) bits.push('<span title="메인 + 서브에이전트 전체 — API 환산 비용">task 합계 ' + spendText(tk, tu.totalCostUsd, false) + '</span>');
    var sub = s && s.subagentSpend;
    if (sub && toNum(sub.agents) > 0) {
      bits.push('<span title="서브에이전트들 자신의 API 호출 합">서브 ' + toNum(sub.agents) + '개 ' + spendText(spendTotal(sub), sub.costUsd, sub.unpriced || sub.estimated) + '</span>');
    }
  } else if (spendLabel(node.spend)) {
    bits.push('<span title="' + escAttr(spendTitle(node.spend)) + '">' + esc(spendLabel(node.spend)) + '</span>');
  }
  if (node.background) bits.push('배경 실행');
  if (desc.n) bits.push('하위 전체 ' + desc.n);
  var line = node.description || '';
  var act = agentActivity(node);
  return '<div class="pa-focus is-' + st + '" role="group" tabindex="-1" aria-label="' + escAttr(agentNodeAria(node, desc)) + '">'
    + '<div class="pa-name">' + agentNodeLine(node) + '</div>'
    + '<div class="pa-sum">' + bits.join('<span class="pa-dot" aria-hidden="true">&middot;</span>') + '</div>'
    + (line || act ? '<div class="pa-desc">' + esc(line) + (line && act ? ' — ' : '') + (act ? '<span class="pa-act">' + esc(act) + '</span>' : '') + '</div>' : '')
    + '</div>';
}
// The panel's agent section (§4.3), a drill-down over the same tree: the path
// (the focused node's chain from the root) and the focused node's header. Its
// subtree is the 에이전트 트리 section tab (paintTreeTab).
function renderPanelAgents() {
  var el = document.getElementById('panel-agents');
  if (!el) return;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  if (!s) {
    el.style.display = 'none';
    if (_panelAgentsHtml) el.innerHTML = '';
    _panelAgentsHtml = '';
    return;
  }
  // Task view T1.6: the main agent's own header (tools, the task's spend) is a detail.
  el.classList.toggle('is-main', !_panelAgent);
  var root = agentTreeOf(s, sessionColOf(panelSessionKey), panelLogOnlyAgents(s));
  _panelAgentIdsShown = Object.create(null);
  for (var id in root.byId) if (id) _panelAgentIdsShown[id] = true;
  var node = root.byId[_panelAgent] || null;
  var chain = [];
  for (var cur = node || root, guard = 0; cur && guard < 64; guard++) {
    chain.unshift(cur);
    cur = cur.root ? null : root.byId[cur.parentId];
  }
  var path = '';
  for (var c = 0; c < chain.length; c++) {
    var far = c < chain.length - 2;
    var isCur = !!node && c === chain.length - 1;
    // On a phone only "‹ parent › here" shows: a step's separator goes with the step before it.
    path += (c ? '<span class="pa-sep' + (c - 1 < chain.length - 2 ? ' is-far' : '') + '" aria-hidden="true">&rsaquo;</span>' : '')
      + '<button type="button" class="pa-crumb' + (far ? ' is-far' : c === chain.length - 2 ? ' is-up' : '') + '"'
      + (isCur ? ' aria-current="page"' : '') + ' data-agent-select="' + escAttr(chain[c].id) + '">' + esc(agentNodeName(chain[c])) + '</button>';
  }
  if (!node) path += '<span class="pa-sep" aria-hidden="true">&rsaquo;</span><span class="pa-crumb" aria-current="page">에이전트 ' + esc(String(_panelAgent).slice(-6)) + '</span>';
  // The path shows where the focused node sits; the root has nothing above it.
  var html = chain.length > 1 || !node ? '<div class="pa-bar"><nav class="pa-path" aria-label="에이전트 경로">' + path + '</nav></div>' : '';
  if (node) html += renderAgentFocus(node, s);
  else html += '<div class="pa-focus is-unknown"><div class="pa-sum">카드 목록 밖의 에이전트 — 작업 로그만 있어요</div></div>';
  // A live update (sessionUpdated, a board push) with the same markup writes
  // nothing; a changed section is morphed, so a focused crumb stays.
  if (html !== _panelAgentsHtml || el.style.display !== '') {
    el.style.display = '';
    morphInnerHtml(el, html);
    _panelAgentsHtml = html;
    updateTimersIn(el);
  }
}
// Everything in the panel that follows the focused node, after any live
// update — whichever node it is (no main-only or subagent-only gate). Each part
// writes nothing when its markup is unchanged.
function repaintPanelScope() {
  renderPanelTabs();
  renderPanelAgents();
  repaintPanelTasks();
  renderPanelSections();
  // The section tab shown: the tree follows the agents; the work log's group
  // heads (the task ledger), child agents and cards their data; a subagent's
  // 지시와 답변 its log. The others are painted when they are opened.
  if (_psec === 'tree') paintTreeTab();
  wlPaint();
  renderAgentConv();
}
// ── Task view (SSOT 2026-10-27) — 자세히, agent tabs, 지시와 답변 ──
// 자세히 (T1.6): the panel shows what matters by default — one line of 세션 정보,
// what needs the user, the artifacts, the tabs, the section tabs; Tasks folded.
// On, every detail opens: the full 세션 정보, the plan with every completed step
// and the earlier plans, the agent's path. The choice is saved per device.
var PANEL_DETAIL_KEY = 'soma-panel-detail';
var _panelDetail = false;
function panelDetailFrom(saved) {
  return saved === '1';
}
function readPanelDetail() {
  try { return panelDetailFrom(localStorage.getItem(PANEL_DETAIL_KEY)); } catch (_e) { return false; }
}
function applyPanelDetail() {
  var panel = document.getElementById('slide-panel');
  if (panel) panel.classList.toggle('is-detail', _panelDetail);
  var btn = document.getElementById('panel-detail-toggle');
  if (btn) btn.setAttribute('aria-pressed', _panelDetail ? 'true' : 'false');
}
// The sections an opening starts with: every one open with 자세히 — except the goal,
// which always opens folded (SSOT 2026-10-29) — else the defaults.
function resetPanelSections() {
  _panelInfoOpen = _panelDetail;
  _panelGoalOpen = false; // SSOT 2026-10-29: the goal opens folded — 자세히 and a goal landing too
  _panelTasksOpen = _panelDetail || _panelLand === 'tasks';
  _panelTasksExpanded = _panelTasksOpen;
  _panelTasksEarlier = _panelDetail;
}
function togglePanelDetail() {
  _panelDetail = !_panelDetail;
  try { localStorage.setItem(PANEL_DETAIL_KEY, _panelDetail ? '1' : '0'); } catch (_e) {}
  applyPanelDetail();
  resetPanelSections();
  if (!panelSessionKey) return;
  repaintPanelSession();
}

// Agent tabs (T1.2): Main first — always, pinned at the strip's left — then each
// subagent in spawn order with its status. A tab scopes everything below it
// (Tasks, the work log, 지시와 답변) to its agent; selecting one is
// selectPanelAgent. Arrow keys move along the strip and select (automatic
// activation, the WAI-ARIA tabs pattern); one tab holds the tab stop.
function panelTabsHtml(s, active, mainSt) {
  var st0 = mainSt || (s && s.activityState === 'working' ? 'running' : s && s.activityState === 'waiting' ? 'waiting' : 'idle');
  var cur = active || '';
  var tab = function(id, domId, st, name, type, extra) {
    var on = id === cur;
    return '<button type="button" class="panel-tab' + extra + ' is-' + st + '" role="tab" id="' + domId + '" data-agent-tab="' + escAttr(id) + '"'
      + ' aria-selected="' + (on ? 'true' : 'false') + '" aria-controls="panel-tabpanel" tabindex="' + (on ? '0' : '-1') + '"'
      + ' title="' + escAttr(name + (type ? ' ' + type : '') + ' — ' + (AGENT_STATUS_LABEL[st] || '')) + '">'
      + '<span class="ag-icon">' + agentIconHtml(st) + '</span>'
      + '<span class="pt-name">' + esc(name) + '</span>'
      + (type ? '<span class="pt-type">' + esc(type) + '</span>' : '')
      + '</button>';
  };
  var model = s && s.model ? String(s.model).replace(/^claude-/, '') : '';
  var html = tab('', 'panel-tab-main', st0, 'Main', model, ' is-main');
  var list = ((s && s.agents) || []).slice().sort(function(a, b) { return toNum(a.n) - toNum(b.n); });
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || !a.id) continue;
    html += tab(String(a.id), 'panel-tab-a' + toNum(a.n), agentStatusOf(a), 'A' + toNum(a.n), a.type || '', '');
  }
  return html;
}
function renderPanelTabs() {
  var el = document.getElementById('panel-tabs');
  if (!el) return;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  if (!s) { writePanelPart(el, ''); return; }
  writePanelPart(el, panelTabsHtml(s, _panelAgent, rootStatusOf(s, sessionColOf(panelSessionKey))));
  var on = el.querySelector('[aria-selected="true"]');
  var panel = document.getElementById('panel-tabpanel');
  if (panel) panel.setAttribute('aria-labelledby', on ? on.id : 'panel-tab-main');
  // Bring the selected tab into the strip's view — sideways only, never the panel.
  if (on && !on.classList.contains('is-main')) {
    var main = el.querySelector('.panel-tab.is-main');
    var left = on.offsetLeft - (main ? main.offsetWidth + 8 : 0);
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (on.offsetLeft + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = on.offsetLeft + on.offsetWidth - el.clientWidth;
  }
}
function panelTabsKey(e) {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('#panel-tabs [role="tab"]'));
  var i = tabs.indexOf(e.target);
  if (i < 0) return;
  var to = e.key === 'ArrowRight' ? Math.min(tabs.length - 1, i + 1)
    : e.key === 'ArrowLeft' ? Math.max(0, i - 1)
    : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  if (to < 0) return;
  e.preventDefault();
  selectPanelAgent(tabs[to].getAttribute('data-agent-tab') || '');
  var next = document.querySelector('#panel-tabs [role="tab"][aria-selected="true"]');
  if (next) next.focus();
}
function bindPanelTabs() {
  var el = document.getElementById('panel-tabs');
  if (!el || el._bound) return;
  el._bound = true;
  el.addEventListener('click', function(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-agent-tab]') : null;
    if (t) selectPanelAgent(t.getAttribute('data-agent-tab') || '');
  });
  el.addEventListener('keydown', panelTabsKey);
}

// 지시와 답변 (T1.3; a section tab since 2026-10-29): the main agent's tab shows
// the session's turns (convPaint); a subagent's tab shows what it was told
// and what it answered (renderAgentConv).
// Pure: a subagent's instruction (the call that started it) and its result,
// from the work log — the latest of each.
// A background agent's spawn result only acknowledges its start (as the work
// log reads it, wlScopeEntries) — never its answer; a failed one is the spawn failing.
function agentConvEntries(entries, agentId, background) {
  var out = { spawn: null, result: null };
  var list = entries || [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || !agentId || e.agentRef !== agentId) continue;
    if (e.kind === 'tool') out.spawn = e;
    else if (e.kind === 'tool_result' && !(background && e.ok !== false)) out.result = e;
  }
  return out;
}
// Pure: the instruction text in a spawn call's input (its JSON) — the prompt,
// else the description; anything that is not that JSON is the text itself.
function agentPromptOf(raw) {
  var text = String(raw == null ? '' : raw);
  try {
    var o = JSON.parse(text);
    if (o && typeof o === 'object') return String(o.prompt || o.description || text);
  } catch (_e) {}
  return text;
}
var _agentConvRaw = Object.create(null); // work-log seq → its loaded raw (this panel opening)
var _agentConvFailed = Object.create(null); // work-log seq → { error } of a load that failed (this panel opening)
function agentConvRawOf(seq) {
  var key = String(seq);
  if (Object.prototype.hasOwnProperty.call(_agentConvRaw, key)) return _agentConvRaw[key];
  _agentConvRaw[key] = null;
  if (!_wl) return null;
  var gen = _panelGen;
  wlRawLoad(_wl, seq, wlFetchJson).then(function(r) {
    if (gen !== _panelGen) return;
    _agentConvRaw[key] = r && r.status === 'ok' ? r.raw : '';
    // A transient failure: the answer says so and offers 다시 시도 (agentConvRetry);
    // #488: it is also tried again on a later render (a poll, a log page) — after
    // a pause, so a failing load never spins.
    if (r && r.status === 'error') {
      var failure = _agentConvFailed[key] = { error: String(r.error || 'Error') };
      setTimeout(function() {
        if (gen !== _panelGen || _agentConvFailed[key] !== failure) return;
        delete _agentConvFailed[key];
        delete _agentConvRaw[key];
      }, 15000);
    }
    renderAgentConv();
  });
  return null;
}
// Why a subagent's raw failed to load ('' = it did not).
function agentConvFailure(seq) {
  var f = _agentConvFailed[String(seq)];
  return f ? f.error : '';
}
// 다시 시도 on a subagent's answer (ui-retry; its slot names the work-log seq):
// the failure is forgotten and the tab painted again, which loads it again.
function agentConvRetry(seq) {
  var key = String(seq);
  if (!_agentConvFailed[key]) return;
  delete _agentConvFailed[key];
  delete _agentConvRaw[key];
  renderAgentConv();
}
// Pure: a subagent's 지시와 답변 as the element's turns — the instruction Main
// sent (the prompt as sent; its one-line preview when the raw cannot be read)
// and the answer (ad: agentAnswerData); while it runs with no result, the
// writing row; without one at all, the agent's own one-line summary.
function agentConvTurns(agentId, a, io, prompt, answer, ad) {
  var base = 'agent:' + String(agentId || '');
  var name = a ? agentName(a) : '에이전트';
  var turns = [];
  if (io.spawn || (a && a.description)) {
    var said = prompt || (io.spawn ? String(io.spawn.text || '') : '');
    var desc = a && a.description ? String(a.description) : '';
    var u = { id: base + ':spawn', role: 'user', name: '지시 · Main', text: desc && said && said.indexOf(desc) !== 0 ? desc + '\\n\\n' + said : said || desc };
    if (io.spawn && toNum(io.spawn.ts) > 0) u.at = toNum(io.spawn.ts);
    turns.push(u);
  }
  var r = { id: base + ':result', role: 'assistant', name: name };
  if (a && a.summary) r.summary = { text: String(a.summary) };
  if (io.result) {
    if (toNum(io.result.ts) > 0) r.at = toNum(io.result.ts);
    r.markdown = String(ad.markdown || '');
    if (ad.loading) r.loading = true;
    if (ad.error) {
      r.error = String(ad.error);
      r.canRetry = true;
    }
    if (ad.linkTitles && Object.keys(ad.linkTitles).length) r.linkTitles = ad.linkTitles;
    if (typeof answer === 'string' && answer) r.source = answer;
    turns.push(r);
    return { turns: turns, pending: false };
  }
  if (a && agentStatusOf(a) === 'running') return { turns: turns, pending: true };
  r.markdown = '';
  if (!r.summary) r.summary = { text: '작업 로그에 결과가 없습니다' };
  turns.push(r);
  return { turns: turns, pending: false };
}
// Pure: what a subagent's answer element shows — the writing row while it runs
// (no result yet), loading while its raw is fetched, then the answer (a result
// that cannot be read reads as the agent's own one-line summary, if it has
// one). A raw that failed to load (failed: why) says so with 다시 시도, headed
// by that summary — never as an empty answer. Copy takes this text. No entry
// motion: the tab is painted again on every poll and every return to the agent.
function agentAnswerData(a, io, answer, s, failed) {
  if (!io.result) return { markdown: '', streaming: true };
  if (failed) {
    var d = { markdown: '', error: String(failed), canRetry: true };
    if (a && a.summary) d.title = String(a.summary);
    return d;
  }
  if (answer == null) return { markdown: '', loading: true };
  var shown = answer === '' && a && a.summary ? a.summary : answer;
  return { markdown: String(shown), linkTitles: ansLinkTitles(s), animate: false };
}
// A subagent's 지시와 답변 — painted only while it is the section shown (the main
// agent's turns are convPaint's), in the same <ui-conversation>. Its instruction
// is the spawn call in the work log: a log window that does not reach back to it
// yet pages back for it (wlSeekAgentSpawn), so the tab fills without the reader
// opening 작업 로그. 다시 시도 on its answer reloads the raw (agentConvRetry).
function renderAgentConv() {
  var el = convEl();
  if (!el || !_panelAgent || _psec !== 'conv') return;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var a = panelAgentOf(s);
  var io = agentConvEntries(_wl && _wl.entries, _panelAgent, !!(a && a.background));
  if (!io.spawn) wlSeekAgentSpawn(_wl, a, _panelAgent);
  var prompt = io.spawn && io.spawn.rawBytes ? agentConvRawOf(io.spawn.seq) : null;
  var answer = io.result ? (io.result.rawBytes ? agentConvRawOf(io.result.seq) : String(io.result.text || '')) : null;
  var failed = io.result && io.result.rawBytes ? agentConvFailure(io.result.seq) : '';
  var built = io.spawn || io.result || a
    ? agentConvTurns(_panelAgent, a, io, prompt != null ? agentPromptOf(prompt) : null, answer, agentAnswerData(a, io, answer, s, failed))
    : { turns: [], pending: false };
  el._agentSeq = io.result && io.result.rawBytes ? Math.floor(Number(io.result.seq) || 0) : null;
  convSlots(el, [], '');
  convSetData(el, {
    turns: built.turns,
    pending: built.pending,
    assistantName: a ? agentName(a) : '에이전트',
    clampLines: _panelDetail ? 200 : 12,
    label: '지시와 답변',
    emptyText: '이 에이전트의 지시와 결과를 찾지 못했습니다',
    startText: '',
  });
}
// ── Section tabs (SSOT 2026-10-29) — 에이전트 트리 · 작업 로그 · 지시와 답변 ──
// Inside the focused agent's tab, three section tabs, each with its own scroll
// box (the reader's place is per tab). Only the active one is in the DOM: the
// others keep their data (the work-log state, the turns, the agents) and are
// painted from it when they are opened. Each opens on its newest items, at its
// bottom; scrolling up pages back — a sentinel (the top control) within one box
// height of the view, the control itself the keyboard path — and the reader
// keeps their place. A new item at the bottom follows a reader who is there; one
// reading higher keeps their place and gets a pill that jumps to the newest.
var PSEC_ORDER = ['conv', 'log', 'tree'];
var PSEC_TEXT = {
  tree: { older: '이전 에이전트 보기', loading: '이전 에이전트 보기', start: '에이전트 트리의 시작' },
};
// The sections a library element draws as its own scroll box — it lands on the
// newest item, follows it, pages older ones in on scroll-up (ui-load-older →
// this page's loader), keeps the reader's place and says what arrived below:
// 지시와 답변 (<ui-conversation>), 작업 로그 (<ui-work-log>). 에이전트 트리 is this
// page's box (psecBox; D3-GAPS G1-1).
var PSEC_EL = { conv: 'panel-conv', log: 'worklog-list' };
function psecEl(sec) {
  var id = PSEC_EL[sec || _psec];
  return id ? document.getElementById(id) : null;
}
var PANEL_TURNS_PAGE = 20; // turns per page of 지시와 답변
var AT_PANEL_WINDOW = 20; // agents per step of 에이전트 트리
var _psec = 'conv'; // the section tab shown
var _psecPin = true; // the reader is at the newest (the bottom) of the section shown
var _psecNew = 0; // items that arrived below a reader reading higher up
var _treeWindow = AT_PANEL_WINDOW; // how many of the newest agents the tree shows (this opening)
var _treeMaxN = null; // the newest spawn number the tree showed (null: not painted yet)

// Pure: the section an opening lands on — 작업 로그 / ?session= → 작업 로그, a tree
// item → 에이전트 트리, else (답변하기, a blocker, a card) → 지시와 답변.
function psecForLanding(land) {
  return land === 'worklog' ? 'log' : land === 'agent' ? 'tree' : 'conv';
}
// Pure: the tab a key moves to on the section tablist (-1: not a tab key). The arrows wrap.
function psecKeyTarget(key, i, n) {
  if (!(n > 0) || i < 0) return -1;
  if (key === 'ArrowRight') return (i + 1) % n;
  if (key === 'ArrowLeft') return (i - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return -1;
}
// Pure: the section box height — the rest of the panel under the surface, Tasks
// and the tabs while that is at least 45% of it (the panel does not scroll and
// the newest item sits at its bottom), else 45%; never more than the view under
// the sticky tab strips.
function psecHeightOf(view, top, over) {
  return Math.max(160, Math.min(view - over, Math.max(view - top, Math.round(view * 0.45))));
}
// Pure: where an opening without a section landing puts the panel's scroll — the
// top when the section box ends in view, else the section tabs right under the
// sticky agent tabs (the whole box in view).
function psecLandingTop(secTop, boxBottom, view, under) {
  return boxBottom <= view + 1 ? 0 : Math.max(0, secTop - under);
}
// Pure: the agents the tree shows — the newest n under anchor by spawn order
// (agents known only from the log have none: the oldest), the agent pinned in
// view (the focused one), and the ancestors that connect them to the anchor.
// keep[id] = shown; hidden = how many wait above; maxN = the newest spawn
// number; newer = how many are newer than after (live arrivals).
function atWindowOf(anchor, n, pin, after) {
  var all = [];
  var parent = Object.create(null);
  (function walk(x) {
    for (var i = 0; i < x.children.length; i++) {
      var c = x.children[i];
      parent[c.id] = x;
      all.push(c);
      walk(c);
    }
  })(anchor);
  var order = all.slice().sort(function(a, b) { return toNum(a.n) - toNum(b.n); });
  var shown = order.slice(Math.max(0, order.length - Math.max(0, n)));
  var keep = Object.create(null);
  var add = function(node) {
    for (var cur = node; cur && cur !== anchor && !keep[cur.id]; cur = parent[cur.id]) keep[cur.id] = true;
  };
  for (var j = 0; j < shown.length; j++) add(shown[j]);
  var count = 0;
  var maxN = 0;
  var newer = 0;
  for (var k = 0; k < order.length; k++) {
    var o = order[k];
    if (pin && o.id === pin) add(o);
    var on = toNum(o.n);
    if (on > maxN) maxN = on;
    if (after !== null && after !== undefined && on > after) newer++;
  }
  for (var id in keep) if (keep[id]) count++;
  return { keep: keep, hidden: order.length - count, maxN: maxN, newer: newer };
}

function psecBox(sec) {
  return document.getElementById('psec-' + (sec || _psec));
}
function psecAtBottom(box) {
  return !!box && box.scrollHeight - box.clientHeight - box.scrollTop <= 4;
}
// The tab strip and the panels: aria-selected, the one tab stop, the one panel shown.
function renderPanelSections() {
  for (var i = 0; i < PSEC_ORDER.length; i++) {
    var sec = PSEC_ORDER[i];
    var on = sec === _psec;
    var tab = document.getElementById('psec-tab-' + sec);
    if (tab) {
      if (tab.getAttribute('aria-selected') !== String(on)) tab.setAttribute('aria-selected', String(on));
      if (tab.getAttribute('tabindex') !== (on ? '0' : '-1')) tab.setAttribute('tabindex', on ? '0' : '-1');
    }
    var box = psecBox(sec);
    if (box && box.hidden === on) box.hidden = !on;
  }
}
// A section not shown holds no nodes: its DOM goes, its data stays.
function psecClear(sec) {
  if (sec === 'conv') {
    if (_ansIo) { _ansIo.disconnect(); _ansIo = null; }
    var conv = convEl();
    if (conv) {
      convSlots(conv, [], '');
      convSetData(conv, { turns: [] });
    }
  } else if (sec === 'log') {
    wlClear();
    if (_wl) _wl.painted = false;
  } else if (sec === 'tree') {
    var tree = document.getElementById('panel-tree');
    if (tree) {
      if (tree.firstChild) tree.innerHTML = '';
      tree._html = '';
      tree._tree = null;
      tree._hidden = 0;
      tree._growing = false;
    }
    _treeMaxN = null;
  }
  psecSyncControls(sec);
}
function paintSection(sec) {
  if (sec === 'conv') convPaint();
  else if (sec === 'log') wlPaint();
  else paintTreeTab();
  psecSyncControls(sec);
}
// Show the section tab sec: the others leave the DOM; this one is painted from
// its data and lands on its newest items. focus: the tab takes focus (keys).
function selectPanelSection(sec, focus) {
  if (PSEC_ORDER.indexOf(sec) < 0) sec = 'conv';
  _psec = sec;
  renderPanelSections();
  for (var i = 0; i < PSEC_ORDER.length; i++) if (PSEC_ORDER[i] !== sec) psecClear(PSEC_ORDER[i]);
  if (panelSessionKey) paintSection(sec);
  psecToNewest();
  psecFillSoon(sec);
  if (focus) {
    var tab = document.getElementById('psec-tab-' + sec);
    if (tab) tab.focus();
  }
}
// A scroll the page makes (a landing, a kept place, following the newest): the
// box's scroll handler knows it for its own and reads no reader intent into it.
function psecSetTop(box, top) {
  if (Math.abs(box.scrollTop - top) >= 1) box.scrollTop = top;
  box._lastTop = box.scrollTop;
}
// The section shown, at its newest item; a later scroll up is the reader's.
function psecToNewest() {
  var box = psecBox();
  _psecPin = true;
  psecSetNew(0);
  var el = psecEl();
  if (el) {
    if (typeof el.scrollToLatest === 'function') el.scrollToLatest({ smooth: false });
    return;
  }
  if (!box) return;
  psecSetTop(box, box.scrollHeight);
  box._armed = false;
  box._anchor = null;
}
function psecJumpNewest() {
  psecToNewest();
  var box = psecBox();
  if (box && box.focus) box.focus({ preventScroll: true });
}
function psecSetNew(n) {
  _psecNew = Math.max(0, n);
  var pill = document.getElementById('psec-pill');
  if (!pill) return;
  var show = _psecNew > 0;
  if (show) setTextIfChanged(pill, '새 항목 ' + _psecNew + '개 ↓');
  if (pill.hidden === show) pill.hidden = !show;
}
// n new items landed at the bottom of the section shown: a reader who was at the
// newest (pinned) stays there; one reading higher keeps their place and is told.
function psecOnAppended(n, pinned) {
  var box = psecBox();
  if (!box || !(n > 0)) return;
  if (pinned) {
    psecSetTop(box, box.scrollHeight);
    _psecPin = true;
    return;
  }
  // Not followed (reading higher, or an entry's detail open): growth no longer pins.
  _psecPin = false;
  psecSetNew(_psecNew + n);
}
// Older items went in above the reader: measured from the bottom, their place stays.
function psecKeepPlace(box, fromBottom) {
  if (box) psecSetTop(box, box.scrollHeight - fromBottom);
}
// The items the reader is on — the first few agent-tree rows in view, those
// wholly below the top edge first (the one the edge cuts may still grow), top
// first — and how far below the box top each sits (null: none in view). Several:
// a step of older agents can take one away.
var PSEC_ANCHOR_MAX = 6;
// The 에이전트 트리 tab's rows live in <ui-agent-tree>'s (open) shadow root.
function psecTreeRoot(box) {
  var tree = box.querySelector('ui-agent-tree');
  return tree && tree.shadowRoot ? tree.shadowRoot : null;
}
function psecViewAnchor(box) {
  var tr = psecTreeRoot(box);
  if (!tr) return null;
  var top = box.getBoundingClientRect().top;
  var bottom = top + box.clientHeight;
  var out = [];
  var cut = [];
  var rows = tr.querySelectorAll('[role="treeitem"][data-id]');
  for (var i = 0; i < rows.length && out.length < PSEC_ANCHOR_MAX; i++) {
    // A tree item holds its own row, then its children: the row is where it is.
    var row = rows[i].firstElementChild;
    if (!row) continue;
    var r = row.getBoundingClientRect();
    if (!r.height || r.bottom <= top) continue;
    if (r.top >= bottom) break;
    var v = rows[i].getAttribute('data-id') || '';
    var key = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v;
    (r.top >= top ? out : cut).push({ sel: '[role="treeitem"][data-id="' + key + '"]', at: r.top - top });
  }
  out = out.concat(cut).slice(0, PSEC_ANCHOR_MAX);
  return out.length ? out : null;
}
// Where an anchor row is now (its tree item shown), else null.
function psecAnchorEl(box, c) {
  var tr = psecTreeRoot(box);
  var item = tr ? tr.querySelector(c.sel) : null;
  var el = item ? item.firstElementChild : null;
  return el && el.getClientRects().length ? el : null;
}
// The first of those rows still shown back where it was (false: all are gone).
function psecRestoreAnchor(box, a) {
  if (!a || !a.length) return false;
  for (var i = 0; i < a.length; i++) {
    var el = psecAnchorEl(box, a[i]);
    if (!el) continue;
    var shift = el.getBoundingClientRect().top - box.getBoundingClientRect().top - a[i].at;
    if (Math.abs(shift) >= 1) psecSetTop(box, box.scrollTop + shift);
    return true;
  }
  return false;
}
// A page went in above the reader: their item goes back where it was — and is
// held there while what was added settles (answers and cards render after it),
// until the reader moves on. Without an item in view, measured from the bottom.
// (The boxes have no native scroll anchoring: the place is this page's to keep.)
function psecHoldPlace(box, anchor, fromBottom) {
  if (!box) return;
  if (psecRestoreAnchor(box, anchor)) {
    box._anchor = anchor;
  } else {
    box._anchor = null;
    psecKeepPlace(box, fromBottom);
  }
}
// What the top of a section shows: 'older' (a control: older items exist),
// 'loading' (the control says the page is on its way), 'start' (everything is
// shown), or '' (nothing — loading, empty, a section an element draws).
function psecOlderState(sec) {
  if (PSEC_EL[sec]) return '';
  var host = document.getElementById('panel-tree');
  if (!host || !host._tree) return '';
  if (host._growing) return 'loading';
  return host._hidden > 0 ? 'older' : 'start';
}
function psecSyncControls(sec) {
  var box = psecBox(sec);
  if (!box) return;
  var btn = box.querySelector('.psec-older');
  var start = box.querySelector('.psec-start');
  var st = sec === _psec && panelSessionKey ? psecOlderState(sec) : '';
  if (btn) {
    var show = st === 'older' || st === 'loading';
    if (btn.hidden === show) btn.hidden = !show;
    if (show) setTextIfChanged(btn, PSEC_TEXT[sec][st === 'loading' ? 'loading' : 'older']);
    if (st === 'loading') btn.setAttribute('aria-busy', 'true');
    else if (btn.hasAttribute('aria-busy')) btn.removeAttribute('aria-busy');
  }
  if (start && start.hidden === (st === 'start')) start.hidden = st !== 'start';
}
// The page before the oldest item shown — for the control, the sentinel and the
// scroll; one at a time, nothing at the start.
function psecLoadOlder(sec) {
  if (sec !== _psec || psecOlderState(sec) !== 'older') return;
  showMoreTree();
}
// Pure: whether the next older page is due — the box cannot scroll (the reader
// would otherwise have only the control), or the reader moved up since the
// landing (armed) and the top (the sentinel) is within one box height of the view.
function psecPageDue(scrollTop, scrollHeight, clientHeight, armed) {
  if (!(clientHeight > 0)) return false;
  if (scrollHeight <= clientHeight + 1) return true;
  return !!armed && scrollTop <= clientHeight;
}
// After a landing, a page, a scroll or the sentinel: the next older page when it
// is due — so a page that still leaves the top near the view brings the next.
function psecMaybeFill(sec) {
  var box = psecBox(sec);
  if (!box || PSEC_EL[sec] || sec !== _psec || box.hidden) return;
  if (!psecPageDue(box.scrollTop, box.scrollHeight, box.clientHeight, box._armed)) return;
  if (psecOlderState(sec) === 'older') psecLoadOlder(sec);
}
// psecMaybeFill once the section's elements have rendered (<ui-tool-call-card>,
// <ui-agent-tree> render on the next microtask): their height decides.
function psecFillSoon(sec) {
  requestAnimationFrame(function() { psecMaybeFill(sec); });
}
// After a <ui-agent-tree> renders new data: one frame (the library's elements
// expose no update promise — an UiElement renders on the next microtask).
function psecAfterRender(_el, fn) {
  requestAnimationFrame(function() { fn(); });
}
// The section box takes the rest of the panel (psecHeightOf) as the parts above it change.
function sizePanelSections() {
  var scroll = document.getElementById('panel-scroll');
  var body = document.getElementById('panel-sections-body');
  if (!scroll || !body) return;
  var view = scroll.clientHeight;
  if (!view) return;
  var tabs = document.getElementById('panel-tabs');
  var secs = document.getElementById('panel-sections');
  var top = body.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  var h = psecHeightOf(view, top, (tabs ? tabs.offsetHeight : 0) + (secs ? secs.offsetHeight : 0));
  if (body._h === h) return;
  body._h = h;
  body.style.height = h + 'px';
}

// 지시와 답변's data for this opening: the turns loaded (oldest first), the id of
// their conversation, and what the list says before or without turns.
var _panelTurnsList = [];
var _panelTurnsCid = '';
var _panelTurnsMsg = ''; // 'loading' | 'none' | 'failed' | 'unrecorded' | '' (the turns)
var _panelTurnsWhy = ''; // why the first page failed (the element's error)
var _panelOlderWhy = ''; // why the last older page failed ('' = it did not)
// Pure: a turn into the list — in place of the one with its id (or replaceId:
// an optimistic turn the server's took over), else at the end.
function ptUpsert(list, turn, replaceId) {
  var id = replaceId || (turn && turn.id);
  if (id) {
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].id === id) {
        list[i] = turn;
        return 'update';
      }
    }
  }
  list.push(turn);
  return 'append';
}
// 에이전트 트리: the session's agents in <ui-agent-tree> (rich — a card per agent on
// one waterfall axis, every branch's spend rolled up), the main agent at its
// root and the focused one selected — the newest _treeWindow agents with what
// connects them (atWindowOf); scrolling up shows AT_PANEL_WINDOW more of the
// agents already loaded. A live arrival below a reader reading higher is counted.
function paintTreeTab() {
  var host = document.getElementById('panel-tree');
  if (!host || _psec !== 'tree') return;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var root = s ? agentTreeOf(s, sessionColOf(panelSessionKey), panelLogOnlyAgents(s)) : null;
  if (!root || !root.children.length) {
    host._tree = null;
    host._hidden = 0;
    writePanelPart(host, s ? '<p class="psec-empty">이 세션에는 하위 에이전트가 없습니다</p>' : '');
    psecSyncControls('tree');
    return;
  }
  var ns = 'p|' + panelSessionKey;
  var win = atWindowOf(root, _treeWindow, _panelAgent, _treeMaxN);
  var d = atTreeData(root, { s: s, ns: ns, withRoot: true, openDepth: 64, density: 'rich', title: '에이전트 트리', keep: win.keep });
  d.selectedId = _panelAgent ? String(_panelAgent) : AT_ROOT;
  var newer = _treeMaxN === null ? 0 : win.newer;
  _treeMaxN = win.maxN;
  host._tree = d;
  host._hidden = win.hidden;
  var pinned = psecAtBottom(psecBox('tree'));
  writePanelPart(host, atSlotHtml('pa-tree', ns, '에이전트 트리'));
  atPaint(host.querySelector('ui-agent-tree'), d, JSON.stringify(d));
  psecSyncControls('tree');
  if (newer) psecOnAppended(newer, pinned);
}
function showMoreTree() {
  var box = psecBox('tree');
  var host = document.getElementById('panel-tree');
  if (!box || !host || !(host._hidden > 0)) return;
  // The older agents go in where they belong in the tree (above the reader, or
  // inside a branch they are reading): the row they are on keeps its place.
  var fromBottom = box.scrollHeight - box.scrollTop;
  var anchor = psecViewAnchor(box);
  _treeWindow += AT_PANEL_WINDOW;
  paintTreeTab();
  // One step at a time: the next waits for this one's render (its height).
  host._growing = true;
  psecAfterRender(host.querySelector('ui-agent-tree'), function() {
    host._growing = false;
    if (_psec !== 'tree') return;
    psecHoldPlace(box, anchor, fromBottom);
    psecSyncControls('tree');
    // The root and the branches stay at the top (older agents go in inside them),
    // so the reader is still there: the next step waits for them to scroll up again
    // (or the control) — unless the box is still too short to scroll.
    box._armed = false;
    psecMaybeFill('tree');
  });
}
// The work log's older page — <ui-work-log> asks for it (ui-load-older) as the
// reader scrolls up, or to fill a box too short to scroll. The element shows
// the page on its way and keeps the reader's place when it lands; a failure or
// an empty page settles its loading row and waits for the reader.
function loadOlderWorkLog() {
  var st = _wl;
  if (!st) return Promise.resolve(null);
  var run = wlLoadOlderPage(st, wlFetchJson, paintWorkLog);
  wlPaint();
  return run.then(function(r) {
    if (st === _wl) wlPaint();
    return r;
  });
}
// One-time wiring: the tablist (click, ←/→/Home/End with automatic activation),
// the pill, each box's top control and sentinel, the scroll that tracks where
// the reader is (at the newest: pinned; moving up: older pages may load), the
// newest kept in view while content grows under a pinned reader, and the box's size.
(function initPanelSections() {
  var strip = document.getElementById('panel-sections');
  if (!strip) return;
  strip.addEventListener('click', function(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-sec]') : null;
    var sec = t ? t.getAttribute('data-sec') : '';
    if (sec && sec !== _psec) selectPanelSection(sec);
  });
  strip.addEventListener('keydown', function(e) {
    var tabs = Array.prototype.slice.call(strip.querySelectorAll('[role="tab"]'));
    var to = psecKeyTarget(e.key, tabs.indexOf(e.target), tabs.length);
    if (to < 0) return;
    e.preventDefault();
    selectPanelSection(tabs[to].getAttribute('data-sec'), true);
  });
  var pill = document.getElementById('psec-pill');
  if (pill) pill.addEventListener('click', psecJumpNewest);
  PSEC_ORDER.forEach(function(sec) {
    var box = document.getElementById('psec-' + sec);
    if (!box || PSEC_EL[sec]) return;
    var btn = box.querySelector('.psec-older');
    if (btn) btn.addEventListener('click', function() { psecLoadOlder(sec); });
    // The reader acting on a row (an entry's detail, a Raw, a fold) changes the
    // list by their own hand: nothing is held against it.
    ['pointerdown', 'keydown'].forEach(function(type) {
      box.addEventListener(type, function() { box._anchor = null; }, { passive: true });
    });
    box._lastTop = 0;
    box.addEventListener('scroll', function() {
      if (sec !== _psec) return;
      var top = box.scrollTop;
      // The page's own scroll (psecSetTop) — or none: no reader intent in it.
      if (Math.abs(top - box._lastTop) < 1) return;
      var up = top < box._lastTop;
      box._lastTop = top;
      _psecPin = psecAtBottom(box);
      if (_psecPin && _psecNew) psecSetNew(0);
      // The reader's own place now: the rows they see, read once a frame — what
      // changes above them later (an answer, a card rendering) does not move them.
      box._anchor = null;
      if (!_psecPin && !box._capture) {
        box._capture = true;
        requestAnimationFrame(function() {
          box._capture = false;
          if (sec === _psec && !_psecPin && !box.hidden) box._anchor = psecViewAnchor(box);
        });
      }
      // The reader moving up arms the sentinel; a landing never does, nor does
      // the box shrinking under a reader at the newest (they stay there).
      if (up && !_psecPin) box._armed = true;
      psecMaybeFill(sec);
    }, { passive: true });
    // The sentinel: the top control, observed within one box height above the view.
    if (btn && typeof IntersectionObserver === 'function') {
      new IntersectionObserver(function(entries) {
        for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) psecMaybeFill(sec);
      }, { root: box, rootMargin: '100% 0px 0px 0px' }).observe(btn);
    }
  });
  if (typeof ResizeObserver === 'function') {
    var pin = new ResizeObserver(function() {
      var box = psecBox();
      if (!box || box.hidden) return;
      if (_psecPin) psecSetTop(box, box.scrollHeight);
      else if (box._anchor) psecRestoreAnchor(box, box._anchor);
    });
    PSEC_ORDER.forEach(function(sec) {
      var box = PSEC_EL[sec] ? null : document.getElementById('psec-' + sec);
      var body = box ? box.querySelector('.psec-body') : null;
      if (body) pin.observe(body);
      if (box) pin.observe(box);
    });
    var size = new ResizeObserver(function() { sizePanelSections(); });
    ['panel-scroll', 'panel-surface', 'panel-tabs', 'panel-agents', 'panel-tasks', 'panel-sections'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) size.observe(el);
    });
  }
})();
// ── The panel as a whole (spec 13 — "understand and steer") ──
// One live path writes every part of the open panel that follows the session:
// the head chip, 세션 정보, the goal editor, the composer's model · effort and
// the node scope (agents, Tasks, the work log's group heads and child blocks).
// Each part writes nothing when its markup is unchanged, and the reader stays
// where they were reading when a section above them changes height.
function repaintPanelSession() {
  if (!panelSessionKey) return;
  var s = _sessionCache[panelSessionKey];
  if (!s) return;
  var anchor = panelLiveAnchor();
  renderPanelHead();
  renderPanelInfo();
  renderPanelGoal();
  renderPanelControls(s);
  renderPanelComposer(s);
  repaintPanelScope();
  convPaint(); // re-ai-answer D12 — the 응답 작성 중 row (and a /compact's progress) follow the session state
  restorePanelLiveAnchor(anchor);
}
// The reader's place across a live repaint: the anchor a layout shift keeps
// (panelScrollAnchor — the question, Tasks, the section tabs) — unless the
// reader is looking at a live section itself (it changes under them by
// design) or the panel rests at its top. Inside a section box the box keeps it.
var PANEL_LIVE_SECTIONS = { 'panel-info': true, 'panel-goal': true, 'panel-agents': true };
function panelLiveAnchor() {
  var scrollEl = document.getElementById('panel-scroll');
  if (!scrollEl || scrollEl.scrollTop <= 0) return null;
  var top = scrollEl.getBoundingClientRect().top;
  // Task view: the sections sit in the common surface and the tab panel.
  var kids = scrollEl.querySelectorAll('#panel-surface > *, #panel-tabpanel > *');
  for (var i = 0; i < kids.length; i++) {
    var r = kids[i].getBoundingClientRect();
    if (!r.height || r.bottom <= top) continue;
    if (PANEL_LIVE_SECTIONS[kids[i].id]) return null;
    break;
  }
  return panelScrollAnchor(scrollEl);
}
function restorePanelLiveAnchor(a) {
  var scrollEl = document.getElementById('panel-scroll');
  if (!a || !scrollEl || !document.body.contains(a.el)) return;
  var d = a.el.getBoundingClientRect().top - a.top;
  // Instant: under scroll-behavior: smooth a correction would glide.
  if (Math.abs(d) >= 1) scrollEl.scrollTo({ top: scrollEl.scrollTop + d, behavior: 'instant' });
}
// Write one panel part: nothing when unchanged, a morph otherwise (focus and
// nodes stay), the 1 Hz clocks filled at once.
function writePanelPart(el, html) {
  if (el._html === html) return false;
  morphInnerHtml(el, html);
  el._html = html;
  updateTimersIn(el);
  return true;
}

// The composer and the session's follow-up queue — @2lab.ai/ui <ui-agent-steering>
// (dashboard batch 2) — follow the session, also live (spec 13: the panel's own
// Close can end the session it shows). Non-owner takes precedence over closed
// (read-only: the queue shows, nothing can be done — like Stop); fail closed on a
// missing ownerId. The element keeps the text being typed (an IME composition
// too) across every update, so its data is written whenever it changed; a change
// of mode also switches the page's own tools and drops its files.
function renderPanelComposer(s, force) {
  var host = document.getElementById('panel-command');
  var el = document.getElementById('cmd-steer');
  if (!host || !el || !s) return;
  var mode = pcModeOf(s);
  if (force || host._mode !== mode) {
    host._mode = mode;
    // Task view T1.5: the composer's tools follow the field.
    ['pc-attach', 'pc-image', 'pc-mic'].forEach(function(id) {
      var tool = document.getElementById(id);
      if (tool) tool.disabled = mode !== 'open';
    });
    if (mode !== 'open') pcReset();
  }
  var data = steeringData(s, mode, pcHeldFiles());
  var sig = JSON.stringify(data);
  if (!force && el._sig === sig) return;
  el._sig = sig;
  el.data = data;
}
function pcModeOf(s) {
  var isOwnerPanel = !!s.ownerId && s.ownerId === currentUserId;
  var isClosed = s.terminated || s.sessionState === 'SLEEPING';
  return !isOwnerPanel ? 'readonly' : (isClosed ? 'closed' : 'open');
}
// The queue's ten states as the element's five: paused → queued (Send now runs
// it), reserved / claimed / dispatched → sending, uncertain → failed (Retry).
// Resolved and cancelled notes are history the server does not send.
var STEER_STATE = { queued: 'queued', paused: 'queued', steered: 'steered', reserved: 'sending', claimed: 'sending', dispatched: 'sending', failed: 'failed', uncertain: 'failed' };
// The element's data from the session payload (KanbanSession.followups): running
// while a turn works (Enter then queues for the next step), canAct for the owner
// only, Edit only where the server offers it, and the files this page holds for
// the next message (a recording counts — the send files it first).
function steeringData(s, mode, files) {
  var list = (s.followups && s.followups.items) || [];
  var items = [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    var state = f && STEER_STATE[f.state];
    if (!state || !f.id) continue;
    var it = { id: String(f.id), text: String(f.text || ''), state: state, canEdit: !!f.editable };
    if (f.enqueuedAt) it.at = Number(f.enqueuedAt);
    if (f.author) it.author = String(f.author);
    if (f.stateReason) it.reason = String(f.stateReason);
    if (f.files && f.files.length) it.files = f.files.map(String);
    items.push(it);
  }
  return { running: mode !== 'closed' && s.activityState === 'working', canAct: mode !== 'readonly', disabled: mode === 'closed', items: items, attachments: files || 0 };
}
// The note the element names (its host id) as the payload has it: the generation
// an action on it carries. A local row (a send that failed) is not in the queue.
function steerItemOf(s, id) {
  var list = (s && s.followups && s.followups.items) || [];
  for (var i = 0; i < list.length; i++) if (list[i] && String(list[i].id) === id) return list[i];
  return null;
}

// The panel head (spec 13) — @2lab.ai/ui <ui-status-bar> (D3 E-08): the session's status
// in the root vocabulary (rootStatusOf onto the bar's six states, the page's words — 재개
// 대기 / 휴면 / 보관 keep theirs; the bar announces a change, never the ticking clock);
// a turn in flight reads 시작 HH:MM · its own elapsed time, ticking in place (re-agent-run
// D18), otherwise the session's total 활성 time (also in 세부 — D19); Slack; the session's
// actions (sessionActionsOf — Stop takes the bar's two presses, then is busy until the next
// data). An armed resume's when / attempt / why is a note in the bar's slot.
var PS_BAR_STATUS = { running: 'running', waiting: 'waiting', resuming: 'waiting', idle: 'idle', sleeping: 'idle', archived: 'idle' };
function panelHeadData(s, col) {
  var st = rootStatusOf(s, col);
  var bar = PS_BAR_STATUS[st] || 'idle';
  var words = {};
  words[bar] = AGENT_STATUS_LABEL[st] || '';
  var d = { status: bar, words: words };
  var leg = st === 'running' || st === 'waiting' ? (Number(s.activeLegStartedAtMs) || 0) : 0;
  var acc = toNum(s.activeAccumulatedMs);
  if (leg) d.startedAt = leg;
  else if (acc) d.activeMs = acc;
  if (s.slackThreadUrl) d.link = { id: 'slack', href: String(s.slackThreadUrl), label: 'Slack' };
  d.actions = sessionActionsOf(s, col).map(function(a) {
    var x = { id: a.id, label: a.label };
    if (a.id === 'stop' && !a.sibling) { x.tone = 'danger'; x.icon = 'stop'; }
    if (a.lock) x.disabled = a.lock;
    if (a.busy) x.busy = true;
    return x;
  });
  return d;
}
// The bar's slot: an armed resume (what starts the session again, when, which attempt; why on hover).
function panelHeadNoteHtml(s, col) {
  var resume = pendingAutoResume(s, col);
  return resume ? '<span class="ps-resume" title="' + escAttr(resume.reason || '') + '">' + esc(autoResumeLabel(resume)) + '</span>' : '';
}
function renderPanelHead() {
  var el = document.getElementById('panel-status');
  if (!el) return;
  var key = panelSessionKey;
  var s = key ? _sessionCache[key] : null;
  if (!el._wired) {
    el._wired = true;
    el.addEventListener('ui-action', onPanelHeadAction);
  }
  var col = s ? sessionColOf(key) : '';
  writePanelPart(el, s ? panelHeadNoteHtml(s, col) : '');
  var data = s ? panelHeadData(s, col) : null;
  var sig = JSON.stringify(data);
  el._key = key;
  // Same data, same object: the bar keeps an armed Stop and its pending busy across live repaints.
  if (el._sig === sig) return;
  el._sig = sig;
  el.data = data;
}
// The bar's ui-action: the session it was drawn for (the deck may have moved on since). The
// Slack link opens in a new tab by itself.
function onPanelHeadAction(e) {
  var id = e.detail && e.detail.id;
  var key = e.currentTarget && e.currentTarget._key;
  var s = key ? _sessionCache[key] : null;
  if (!s || !id || id === 'slack') return;
  if (id === 'star') doStar(key, s.starred !== true);
  else if (id === 'revive') doRevive(key);
  else if (id === 'stop' || id === 'close' || id === 'trash') doAction(key, id);
}

// 세션 정보: a disclosure whose button is the one-line summary (owner ·
// workflow · tokens · cost · context · last activity, live); the links stay in
// view under it; opened, every number of the session. The panel is the
// complete record: the card header's dhShow gates do not apply here.
var _panelInfoOpen = false;
var PI_CHEV_SVG = '<i data-ui-icon="chevron-down" class="pi-chev"></i>';
function panelInfoHtml(s, open, col) {
  var u = s.tokenUsage || null;
  var ctx = u ? toNum(u.contextUsagePercent) : 0;
  var sum = [];
  if (s.ownerName) sum.push(esc(s.ownerName));
  if (s.workflow) sum.push(esc(s.workflow));
  if (u) sum.push(formatTokens(cardTotalTokens(u)) + ' tok', '$' + toNum(u.totalCostUsd).toFixed(2));
  if (ctx > 0) {
    var ctxCls = ctxLevel(ctx, s.contextTokens, s.autoCompactTokens, s.compactPending);
    sum.push('<span class="pi-cs' + (ctxCls ? ' ' + ctxCls : '') + '">ctx ' + ctxPercent(ctx) + '%</span>');
  }
  sum.push('<span class="rel-time" data-ts="' + (new Date(s.lastActivity).getTime() || 0) + '"></span>');
  var html = '<button type="button" class="pi-head" aria-expanded="' + (open ? 'true' : 'false') + '"' + (open ? ' aria-controls="panel-info-body"' : '') + ' onclick="togglePanelInfo()">'
    + '<span class="pi-title">세션 정보</span><span class="pi-sum">' + sum.join('<span class="pi-dot" aria-hidden="true">&middot;</span>') + '</span>'
    + PI_CHEV_SVG + '</button>';
  var links = [];
  if (s.issueUrl) links.push('<a href="' + safeHref(s.issueUrl) + '" target="_blank" rel="noopener">' + esc(s.issueLabel || s.issueShortRef || 'Issue') + (s.issueTitle ? ' &mdash; ' + esc(String(s.issueTitle).slice(0, 60)) : '') + '</a>');
  if (s.prUrl) links.push('<a href="' + safeHref(s.prUrl) + '" target="_blank" rel="noopener">' + esc(s.prLabel || s.prShortRef || 'PR') + (s.prTitle ? ' &mdash; ' + esc(String(s.prTitle).slice(0, 60)) : '') + '</a>');
  if (s.conversationId) links.push('<a href="/conversations/' + escAttr(s.conversationId) + '" target="_blank" rel="noopener">전체 대화</a>');
  if (links.length) html += '<div class="pi-links">' + links.join('') + '</div>';
  if (!open) return html;
  var rows = [];
  if (u) {
    rows.push(['누적 입력', formatTokens(u.totalInputTokens)]);
    rows.push(['누적 출력', formatTokens(u.totalOutputTokens)]);
    rows.push(['누적 캐시 읽기', formatTokens(u.totalCacheReadTokens)]);
    rows.push(['누적 캐시 쓰기', formatTokens(u.totalCacheCreateTokens)]);
    // SSOT 2026-10-26 T2/T3 — the numbers above are the task's (main + subagents);
    // the subagents' share, and since when a partial total counts.
    var sub = s.subagentSpend;
    if (sub && toNum(sub.agents) > 0) rows.push(['서브에이전트', toNum(sub.agents) + '개 · ' + spendText(spendTotal(sub), sub.costUsd, sub.unpriced || sub.estimated)]);
    if (toNum(u.partialSince) > 0) rows.push(['집계 시작', '<span class="rel-time" data-ts="' + toNum(u.partialSince) + '"></span> (그 전 지출 미포함)']);
  }
  // Open body order (re-agent-run D19 · re-context-window D5): the context block (cwSlotHtml, prepended on return) → 세부 → token grid → thread.
  var body = panelDetailsHtml(s, col) + '<dl class="ui-dl pi-grid">' + rows.map(function(r) { return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>'; }).join('') + '</dl>';
  var thread = ['&Sigma; ' + formatNmSSs(toNum(s.threadTotalActiveMs)), '압축 ' + toNum(s.compactionCount), '세션 ' + toNum(s.threadSessionCount)];
  if (s.mergeStats) thread.push('+' + toNum(s.mergeStats.totalLinesAdded) + ' / -' + toNum(s.mergeStats.totalLinesDeleted));
  body += '<div class="pi-thread">' + thread.join('<span class="pi-dot" aria-hidden="true">&middot;</span>') + '</div>';
  if (s.autoResume && s.autoResume.reason) body += '<div class="pi-resume">오류: ' + esc(s.autoResume.reason) + '</div>';
  return html + '<div class="pi-body" id="panel-info-body">' + cwSlotHtml(s) + body + '</div>';
}
// 세부 (re-agent-run D19) — who ran it, with what, how much, at what cost:
// 에이전트 (the model) · 시작한 사람 · 도구 호출 (the main agent's every call —
// agentRoot — plus each subagent's; a lower bound when the card carries fewer
// subagents than there are) · 비용 · 활성 시간 (live) · 워크플로 · 환경.
function panelDetailsHtml(s, col) {
  var u = s.tokenUsage || null;
  var rows = [];
  var model = String(s.model || '').replace(/^claude-/, '');
  if (model) rows.push(['에이전트', esc(model)]);
  if (s.ownerName) rows.push(['시작한 사람', esc(s.ownerName)]);
  var list = s.agents || [];
  if (s.agentRoot || list.length) {
    var main = toNum(s.agentRoot && s.agentRoot.toolCalls);
    var subs = 0;
    for (var i = 0; i < list.length; i++) subs += toNum(list[i] && list[i].toolCalls);
    var more = toNum(s.agentsTotal) > list.length ? '+' : '';
    rows.push(['도구 호출', '<span title="메인 ' + main + ' · 서브에이전트 ' + subs + '">' + (main + subs) + more + '</span>']);
  }
  if (u) rows.push(['비용', '$' + toNum(u.totalCostUsd).toFixed(2)]);
  var acc = toNum(s.activeAccumulatedMs);
  // The same status as the head chip (rootStatusOf): a turn in flight adds its live leg.
  var st = rootStatusOf(s, col);
  var leg = st === 'running' || st === 'waiting' ? (Number(s.activeLegStartedAtMs) || 0) : 0;
  if (acc || leg) rows.push(['활성 시간', '<span class="card-timer-live" data-leg-started="' + leg + '" data-accumulated="' + acc + '"></span>']);
  if (s.workflow) rows.push(['워크플로', esc(s.workflow)]);
  if (s.environment && s.environment.instanceName) rows.push(['환경', esc(s.environment.instanceName) + ' <span class="pi-muted">' + esc((s.environment.host || '') + ':' + (s.environment.port || '')) + '</span>']);
  return '<dl class="ui-dl pi-details">' + rows.map(function(r) { return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>'; }).join('') + '</dl>';
}
function renderPanelInfo() {
  var el = document.getElementById('panel-info');
  if (!el) return;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var now = Date.now();
  if (s) cwObserve(s, now);
  writePanelPart(el, s ? panelInfoHtml(s, _panelInfoOpen, sessionColOf(panelSessionKey)) : '');
  if (s) cwPaint(el.querySelector('ui-context-window'), s, now);
}
function togglePanelInfo() {
  var el = document.getElementById('panel-info');
  // Opened again while it folds: it stays.
  if (xpStay(el)) {
    var h = el.querySelector('.pi-head');
    if (h) h.setAttribute('aria-expanded', 'true');
    return;
  }
  // Closing: the body folds to 0 rows first, then the part is written without it.
  if (_panelInfoOpen && el && el.querySelector('.pi-body')) {
    var head = el.querySelector('.pi-head');
    if (head) head.setAttribute('aria-expanded', 'false');
    xpLeave(el, function() {
      _panelInfoOpen = false;
      renderPanelInfo();
    });
    return;
  }
  _panelInfoOpen = !_panelInfoOpen;
  renderPanelInfo();
  if (_panelInfoOpen) xpEnter(el);
}

// ── 컨텍스트 — @2lab.ai/ui <ui-context-window> (.prd/affectui/re-context-window.md D5–D20) ──
// What fills the context now — the field of 216 cells (one per window/216
// tokens) in the request's cache categories, the auto-compact point, the level
// against it, the tray line, the hover link, the rolling figure and the
// two-press 지금 압축 — is the element's. The dashboard keeps what only it
// knows: the card's numbers as the element's data (cwData), what the session
// did since the last render (cwObserve), who may compact (cwCanCompact) and the
// request itself (cwCompact: the owner's own 'compact --yes').
var CW_DONE_MS = 1500;
var CW_SAVED_MS = 3200;
var CW_FAIL_MS = 4000;
var CW_CEIL_MS = 300000;
var _cwCeil = 0; // the 5-minute ceiling timer of the latest request (cwCompact)
var _cw = { key: '', gen: 0, count: 0, reqId: 0, req: '', reqAt: 0, obsInReq: false, queued: false, doneAt: 0, observedAt: 0, savedWait: 0, usedAtRise: 0, lcSeen: '', lcAtRise: '', savedAt: 0, failAt: 0, timedOutAt: 0 };
var _cwSeq = 0; // request ids: an answer only ever updates the request it belongs to
// The request (D12): sending, then sent (the server took it) until a compaction
// is observed — the count rises — then done for 1.5s. Its own outcome (req:
// sending · sent · failed) is kept apart from what the card shows happened
// (observed). A count rise is "a compaction happened", never "yours": a running
// turn queues the request and another compaction (auto, Slack) can land first;
// the card carries no correlation to tell them apart.
function cwPhase(s, now) {
  var c = _cw.key === s.key ? _cw : null;
  if (!c) return 'idle';
  if (c.req === 'sending' || c.req === 'sent') return c.req;
  if (c.doneAt && now - c.doneAt < CW_DONE_MS) return 'done';
  return 'idle';
}
// Why this viewer cannot compact this session now ('' = can). The server's
// requireSessionOwner is the guard; this is UX and fails closed on a missing
// owner. A switch waiting on a compact, or one already scheduled, compacts anyway.
// Closed is the composer's rule: terminated or sleeping (a press would wake it).
function cwCanCompact(s) {
  if (!s || s.terminated || s.sessionState === 'SLEEPING') return '종료된 세션';
  var env = s.environment;
  if (isSiblingSession(s)) return 'Open ' + env.instanceName + ' (' + (env.host || '') + ':' + (env.port || '') + ') to act on this session';
  if (!s.ownerId || s.ownerId !== currentUserId) return READ_ONLY_MSG;
  if (s.pendingModel) return '모델 전환이 압축을 기다리는 중';
  if (s.compactPending) return '다음 입력 때 자동 압축됩니다';
  return '';
}
// The card's context (D1–D4) as <ui-context-window> data; null without a
// window (no block). The parts in prompt order, or one unsplit total said as
// what it is (D6); the model without its claude- prefix and date. compactState
// is the most urgent state, as the tray says it: the request (sending · sent ·
// queued behind a running turn), its failure or the 5-minute ceiling, then a
// compaction observed — with ITS saving only once its own counts arrived.
// canCompact: true, a reason (disabled, the reason as its tooltip), or false —
// no action: closed, a compaction observed that is not this request's (or its
// counts still on the way), nothing added since the last compaction.
function cwData(s, now) {
  var cp = s.contextParts;
  var win = cp ? toNum(cp.window) : 0;
  if (!(win > 0)) return null;
  var c = _cw.key === s.key ? _cw : null;
  var d = { window: win };
  var used;
  if (cp.unsplit) {
    used = toNum(cp.input);
    d.unsplit = { tokens: used, kind: cp.unsplit === 'compact' ? 'compact' : 'unknown' };
  } else {
    d.parts = { cacheRead: toNum(cp.cacheRead), cacheWrite: toNum(cp.cacheWrite), input: toNum(cp.input), output: toNum(cp.output) };
    used = d.parts.cacheRead + d.parts.cacheWrite + d.parts.input + d.parts.output;
  }
  var auto = toNum(s.autoCompactTokens);
  if (auto > 0) d.autoCompactAt = auto;
  var model = String(s.model || '').replace(/^claude-/, '').replace(/-\\d{8}$/, '');
  if (model && model !== 'unknown') d.model = model;
  if (s.compactPending) d.compactPending = true;
  var phase = cwPhase(s, now);
  var lc = s.lastCompact;
  var saved = !!(c && lc && c.savedAt && now - c.savedAt < CW_SAVED_MS);
  var observed = phase === 'done' || saved || !!(c && (c.savedWait || (c.observedAt && now - c.observedAt < CW_SAVED_MS)));
  d.compactState = phase === 'sending' ? 'sending'
    : phase === 'sent' ? (c.queued ? 'queued' : 'sent')
    : c && c.failAt && now - c.failAt < CW_FAIL_MS ? 'failed'
    : c && c.timedOutAt && now - c.timedOutAt < CW_FAIL_MS ? 'timeout'
    : observed ? 'observed' : 'idle';
  if (saved) d.lastCompact = { preTokens: toNum(lc.preTokens), postTokens: toNum(lc.postTokens) };
  if (s.terminated || s.sessionState === 'SLEEPING') d.canCompact = false;
  else if (phase !== 'idle') d.canCompact = true;
  else if (d.compactState === 'observed' || (c && c.savedWait) || (lc && used <= toNum(lc.postTokens))) d.canCompact = false;
  else d.canCompact = cwCanCompact(s) || true;
  return d;
}
// The block's slot (D5, first in the open body): the token wrapper (.ui-tok)
// keyed by the session and its start (cwObserve's gen) — another session, or
// one that started over, gets a fresh element (the figure jumps, nothing stays
// armed) — and a light-DOM line until the library has loaded.
function cwSlotHtml(s) {
  var cp = s.contextParts;
  var win = cp ? toNum(cp.window) : 0;
  if (!(win > 0)) return '';
  var gen = _cw.key === s.key ? _cw.gen : 0;
  return '<div class="ui-tok cw-slot" data-mk="' + escAttr('cw|' + s.key + '|' + gen) + '">'
    + '<ui-context-window lang="ko" data-cw-key="' + escAttr(s.key) + '"><span class="cw-fallback">컨텍스트 '
    + formatTokens(toNum(s.contextTokens)) + ' / ' + formatTokens(win) + ' 토큰</span></ui-context-window></div>';
}
// Hand the element its data where it changed (a push that changes nothing
// writes nothing). Data set before the module has loaded is taken on upgrade.
function cwPaint(el, s, now) {
  var d = el ? cwData(s, now) : null;
  if (!d) return;
  var sig = JSON.stringify(d);
  if (el._cwSig === sig) return;
  el._cwSig = sig;
  el.data = d;
}
// What the session did since the last render (D12/D20): a new panel session
// or a count that went down (the thread's session started over) resets it; a rise of its compaction count is a compaction observed —
// it ends a sent request (done) and waits for THAT compaction's SDK counts
// (lastCompact differs from what the card held before the rise; they are stored
// just after the boundary's broadcast) or the next context sample; a request
// never answered ends at 5 min.
function cwObserve(s, now) {
  var n = toNum(s.compactionCount);
  var lc = s.lastCompact;
  var sig = lc ? toNum(lc.preTokens) + '/' + toNum(lc.postTokens) : '';
  if (_cw.key !== s.key || n < _cw.count) {
    // Another session, or this thread's session started over (/new · /renew
    // zero its count): nothing carries over, an answer in flight is stale.
    _cw = { key: s.key, gen: _cw.gen + 1, count: n, reqId: 0, req: '', reqAt: 0, obsInReq: false, queued: false, doneAt: 0, observedAt: 0, savedWait: 0, usedAtRise: 0, lcSeen: sig, lcAtRise: '', savedAt: 0, failAt: 0, timedOutAt: 0 };
    return;
  }
  if (n > _cw.count) {
    _cw.count = n;
    _cw.observedAt = now;
    _cw.savedWait = now;
    _cw.usedAtRise = toNum(s.contextTokens);
    // Counts already on the card before this rise belong to an earlier compaction.
    _cw.lcAtRise = _cw.lcSeen;
    cwLater(CW_SAVED_MS);
    if (_cw.req === 'sent') {
      _cw.req = '';
      _cw.doneAt = now;
      cwLater(CW_DONE_MS);
    } else if (_cw.req === 'sending') {
      // Seen before the request was even answered: its answer decides (cwCompact).
      _cw.obsInReq = true;
    }
  }
  if (_cw.savedWait) {
    if (sig && sig !== _cw.lcAtRise) {
      // The new compaction's own SDK counts (recorded just after its boundary broadcast).
      _cw.savedWait = 0;
      _cw.savedAt = now;
      cwLater(CW_SAVED_MS);
    } else if (toNum(s.contextTokens) !== _cw.usedAtRise || now - _cw.savedWait >= CW_CEIL_MS) {
      _cw.savedWait = 0;
    }
  }
  _cw.lcSeen = sig;
  if ((_cw.req === 'sending' || _cw.req === 'sent') && now - _cw.reqAt >= CW_CEIL_MS) {
    _cw.req = '';
    _cw.timedOutAt = now;
    cwLater(CW_FAIL_MS);
  }
}
// Repaint the open panel's 세션 정보 once a timed state (done, saved, failed, the ceiling) ends.
function cwLater(ms) {
  return setTimeout(function() { if (panelOpen) renderPanelInfo(); }, ms + 20);
}
// 지금 압축 (D12): the element confirms it (the first press arms it for 4s, the
// second sends ui-compact); this sends the owner's own 'compact --yes' — the
// owner-gated command route (requireSessionOwner) and the text the model switch
// already sends (index.ts dispatchCompact); a running turn queues it. Sending,
// then sent, until a compaction is observed (cwObserve), the request fails, or
// the 5-minute ceiling. Gating is checked again here, at press time.
async function cwCompact() {
  var key = panelSessionKey;
  var s = key ? _sessionCache[key] : null;
  if (!s || cwCanCompact(s)) return;
  var now = Date.now();
  cwObserve(s, now);
  if (_cw.req === 'sending' || _cw.req === 'sent') return;
  var id = ++_cwSeq;
  _cw.reqId = id;
  _cw.req = 'sending';
  _cw.reqAt = now;
  _cw.obsInReq = false;
  _cw.queued = s.activityState === 'working' || s.activityState === 'waiting'; // a turn holds the slot: the command waits behind it
  _cw.failAt = 0;
  _cw.timedOutAt = 0;
  // One ceiling per request: a new request lets the previous one's go.
  clearTimeout(_cwCeil);
  _cwCeil = cwLater(CW_CEIL_MS);
  renderPanelInfo();
  var ok = false;
  try {
    var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/command';
    var body = JSON.stringify({ message: 'compact --yes' });
    var headers = { 'Content-Type': 'application/json' };
    if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
    var res = await fetch(url, { method: 'POST', headers: headers, body: body });
    if (res.status === 403) {
      await refreshCsrfToken();
      headers = { 'Content-Type': 'application/json' };
      if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
      res = await fetch(url, { method: 'POST', headers: headers, body: body });
    }
    ok = !!res.ok;
  } catch (e) {
    ok = false;
  }
  // Only this request's own state: a stale answer (another panel session, a
  // session that started over, a newer request) touches nothing.
  if (_cw.key === key && _cw.reqId === id && _cw.req === 'sending') {
    if (!ok) {
      _cw.req = 'failed';
      _cw.failAt = Date.now();
      cwLater(CW_FAIL_MS);
    } else if (_cw.obsInReq) {
      _cw.req = '';
      _cw.doneAt = Date.now();
      cwLater(CW_DONE_MS);
    } else {
      _cw.req = 'sent';
    }
  }
  if (panelSessionKey === key) renderPanelInfo();
}
// The element's second press of 지금 압축 — only from the panel session's own
// element (data-cw-key): one left over from another session asks nothing.
document.addEventListener('ui-compact', function(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-CONTEXT-WINDOW' || !panelSessionKey || el.getAttribute('data-cw-key') !== panelSessionKey) return;
  cwCompact();
});

// SSOT 2026-10-29 — "Goal 도 디폴트로 collapsed": the goal's objective opens
// folded to its first 3 lines on every opening (resetPanelSections — 자세히 and
// a goal landing included); 펼치기 · 접기 toggles it for this opening.
var _panelGoalOpen = false;
var GOAL_FOLD_LINES = 3; // the CSS clamp of .panel-goal .card-goal .cg-objective
function togglePanelGoal() {
  _panelGoalOpen = !_panelGoalOpen;
  renderPanelGoal();
}
// The toggle shows only where the fold cuts something: the objective runs past
// its 3 lines (scrollHeight is the whole text, folded or open). An unknown line
// height keeps it, so the text can always be opened.
function syncGoalMore(root) {
  var obj = root.querySelector('.cg-objective');
  var more = root.querySelector('.cg-more');
  if (!obj || !more) return;
  var lh = parseFloat(getComputedStyle(obj).lineHeight);
  more.hidden = lh > 0 && obj.scrollHeight <= lh * GOAL_FOLD_LINES + 1;
}

// The goal's home (spec 13, moved from the card): the shared goal component —
// current, queue, add / delete, the completed goals (T6) — with the card's
// gates. Typing survives every live render: while its input has focus nothing
// is written, and an unfocused draft is carried into the new markup.
function renderPanelGoal() {
  var el = document.getElementById('panel-goal');
  if (!el) return;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var col = s ? sessionColOf(panelSessionKey) : '';
  var isOwner = !!(s && s.ownerId) && s.ownerId === currentUserId;
  var canEdit = isOwner && !isSiblingSession(s);
  var html = s ? renderCardGoal(s, col, canEdit, _panelGoalOpen) : '';
  if (!html) {
    el.style.display = 'none';
    if (el._html) el.innerHTML = '';
    el._html = '';
    return;
  }
  el.style.display = '';
  el._key = panelSessionKey;
  // Task view T1.6: a session with no goal keeps the empty editor for 자세히.
  var g = s.goal;
  el.classList.toggle('is-empty', !(g && (g.current || (g.queue && g.queue.length) || (g.history && g.history.length))));
  if (el._html === html || isEditingGoal(el)) return;
  var draft = captureGoalDraft(el);
  var a = document.activeElement;
  var hadFocus = !!(a && a !== el && el.contains(a));
  // A morph keyed by goal id (data-mk): a focused goal button keeps its node
  // and focus while its goal is there, and is never rebound to another goal.
  morphInnerHtml(el, html);
  el._html = html;
  restoreGoalDraft(el, draft);
  // The fold toggle follows the text's height: now, and whenever the section resizes (panel width, first layout).
  syncGoalMore(el);
  if (!el._goalRo && typeof ResizeObserver === 'function') {
    el._goalRo = new ResizeObserver(function() { syncGoalMore(el); });
    el._goalRo.observe(el);
  }
  // Its goal left (deleted, started, finished): focus lands on the section, never on another goal's control.
  var now = document.activeElement;
  if (hadFocus && (!now || now === document.body || !el.contains(now)) && el.focus) el.focus({ preventScroll: true });
}

// Switch the panel's scope: its Tasks and section tabs follow the chosen agent
// (the section shown stays — the reader's tab is kept for the opening — and is
// painted again for the new scope, at its newest). The work log keeps one
// open/closed map of task groups per agent.
function selectPanelAgent(agentId) {
  var before = document.activeElement;
  var focusInPanel = !!(before && before !== document.body && before.closest && before.closest('#slide-panel'));
  var next = agentId || '';
  // Task ids belong to one agent (spec 12): an opened run's detail does not carry to another tab.
  if (next !== _panelAgent) _panelTaskOpen = Object.create(null);
  if (_wl) {
    var saved = _wl.groupOpenBy || (_wl.groupOpenBy = Object.create(null));
    saved[_panelAgent] = _wl.groupOpen || Object.create(null);
    _wl.groupOpen = saved[next] || Object.create(null);
  }
  _panelAgent = next;
  _panelTasksExpanded = _panelDetail;
  renderPanelTabs();
  renderPanelAgents();
  repaintPanelTasks();
  selectPanelSection(_psec);
  // A keyboard choice (a list row, 서브에이전트 열기) went with the list it was
  // in: focus lands on the agent now shown, not on <body>.
  var after = document.activeElement;
  if (focusInPanel && (!after || after === document.body || !document.body.contains(after))) {
    // The chosen node's header — the same landing as Enter on a card item.
    var here = document.querySelector('#panel-agents .pa-focus')
      || document.querySelector('#panel-agents .pa-crumb[aria-current="page"]');
    if (here && here.focus) here.focus();
  }
}
// Pure: how an entry reads in the scope of the given agent ('' = main), or null
// when it is not in that scope. The main agent's scope = entries without an
// agentId; a subagent's = its own entries plus the call that started it and
// that call's result (made by its parent: shown as 지시 / 결과, outside any task).
function wlScopeEntry(e, agent) {
  if (!e) return null;
  var who = e.agentId ? String(e.agentId) : '';
  if (who === agent) return e;
  if (agent && e.agentRef === agent) {
    var role = e.kind === 'tool' ? 'spawn' : 'result';
    var copy = {};
    for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k) && k !== 'taskId' && k !== 'taskTitle') copy[k] = e[k];
    copy._role = role;
    return copy;
  }
  return null;
}
function wlScopeEntries(entries) {
  var out = [];
  var list = entries || [];
  // A background agent's spawn result only acknowledges its start.
  var bg = false;
  if (_panelAgent) {
    var a = panelAgentOf(panelSessionKey ? _sessionCache[panelSessionKey] : null);
    bg = !!(a && a.background);
  }
  for (var i = 0; i < list.length; i++) {
    var v = wlScopeEntry(list[i], _panelAgent);
    if (!v) continue;
    // …but a failed result is the spawn failing, never a background start.
    if (bg && v._role === 'result' && v.ok !== false) v._role = 'ack';
    out.push(v);
  }
  return out;
}
// Pure: the log predates agent attribution and holds a subagent call, so its
// "main" entries may be a subagent's (spec 12 §2.4).
function wlLegacyMixed(entries) {
  var list = entries || [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e && !e.attributed && e.kind === 'tool' && (e.tool === 'Agent' || e.tool === 'Task')) return true;
  }
  return false;
}

// Latest user instruction + model response (§3.1-4), fetched lazily on
// expand from GET /api/dashboard/session/:conversationId?limit=2 and cached
// per conversation. Only a complete fetch for the session's current
// lastActivity counts as fresh. A failure — or a partial result (the
// instruction loaded, the raw response did not) — keeps what it has and is
// retried on a backoff (1, 2, 4 … 30 s).
// Two clocks, deliberately separate:
//   - the retry DEADLINE and backoff STEP belong to the conversation: they keep
//     growing through an outage no matter how often lastActivity changes;
//   - the retry BUDGET (IO_AUTO_RETRIES automatic attempts) belongs to one
//     lastActivity stamp: newer content earns a fresh budget, never an earlier
//     deadline.
// While in error, only the deadline timer (or an explicit reopen) sends a
// request; board renders and landed turns can at most arm that timer.
var IO_RETRY_MAX_MS = 30000;
var IO_AUTO_RETRIES = 6;
function ioBackoffMs(step) {
  return Math.min(IO_RETRY_MAX_MS, 1000 * Math.pow(2, Math.max(0, step - 1)));
}
// Pure: may this call send a request now? fromTimer = the deadline timer fired.
//   loading → no · ok → only for a newer stamp · error → reopen (force), or the
//   deadline timer once the deadline passed and this stamp still has budget
//   (a newer stamp always does).
function ioNeedsFetch(c, stamp, force, now, fromTimer) {
  if (!c) return true;
  if (c.state === 'loading') return false;
  if (c.state === 'ok') return c.stamp !== stamp;
  if (force) return true;
  if (!fromTimer || now < (c.retryAt || 0)) return false;
  return ioHasBudget(c, stamp);
}
// Pure: an errored entry still wants an automatic retry for this stamp.
function ioHasBudget(c, stamp) {
  return c.stamp !== stamp || (c.fails || 0) <= IO_AUTO_RETRIES;
}

// At most one pending retry timer per conversation: cid → { handle, at }.
// The earliest deadline wins — a pending timer is kept only if it fires at or
// before the new deadline, otherwise it is replaced. A success, or the last
// open card of the conversation going away, clears it.
var _ioTimers = Object.create(null);
function scheduleCardIoRetry(cid, at) {
  var cur = _ioTimers[cid];
  if (cur && cur.at <= at) return;
  if (cur) clearTimeout(cur.handle);
  var entry = { handle: null, at: at };
  entry.handle = setTimeout(function() {
    if (_ioTimers[cid] === entry) delete _ioTimers[cid];
    retryCardIo(cid);
  }, Math.max(0, at - Date.now()));
  _ioTimers[cid] = entry;
}
function cancelCardIoRetry(cid) {
  var cur = cid ? _ioTimers[cid] : null;
  if (!cur) return;
  clearTimeout(cur.handle);
  delete _ioTimers[cid];
}
// The open card on the board that consumes this conversation's retry, or null.
// A timer is armed only while one exists (retryCardIo fires into it). Drawn
// cards only: a stub in a closed DONE day shows nothing.
function cardIoConsumer(cid) {
  for (var k in _cardDrawn) {
    var s = _sessionCache[k];
    if (s && s.conversationId === cid && _expanded.has(k)) return k;
  }
  return null;
}
// A card closed or left the board: drop its conversation's timer unless
// another open card still shows that conversation.
function releaseCardIoTimer(cid) {
  if (!cid || cardIoConsumer(cid)) return;
  cancelCardIoRetry(cid);
}

// force = the card was just (re)opened (explicit user action).
// fromTimer = the conversation's retry deadline fired.
function ensureCardIo(key, force, fromTimer) {
  var s = _sessionCache[key];
  if (!s || !s.conversationId || isSiblingSession(s)) return;
  var cid = s.conversationId;
  var stamp = String(s.lastActivity || '');
  var c = _ioCache[cid];
  if (!ioNeedsFetch(c, stamp, force, Date.now(), fromTimer)) {
    // In error, a render or a landed turn only arms the deadline timer.
    if (c && c.state === 'error' && ioHasBudget(c, stamp)) scheduleCardIoRetry(cid, c.retryAt || 0);
    return;
  }
  var prev = c ? c.data : null;
  // Budget per stamp; deadline and step per conversation (they survive stamps).
  var fails = c && c.state === 'error' && c.stamp === stamp ? (c.fails || 0) : 0;
  var step = c ? (c.step || 0) : 0;
  _ioCache[cid] = { state: 'loading', stamp: stamp, data: prev, dirty: false, fails: fails, step: step, retryAt: c ? (c.retryAt || 0) : 0 };
  function failed(data) {
    var n = fails + 1;
    var nextStep = step + 1;
    var at = Date.now() + ioBackoffMs(nextStep);
    settleCardIo(cid, { state: 'error', stamp: stamp, data: data, fails: n, step: nextStep, retryAt: at });
    // The card may have closed or left the board while the request was in flight.
    if (n <= IO_AUTO_RETRIES && cardIoConsumer(cid)) scheduleCardIoRetry(cid, at);
  }
  fetchCardIo(cid).then(function(result) {
    if (result && result.partial) failed(result); // keep the instruction, retry the response
    else {
      cancelCardIoRetry(cid); // a later backoff timer must not outlive the recovery
      settleCardIo(cid, { state: 'ok', stamp: stamp, data: result, fails: 0, step: 0, retryAt: 0 });
    }
  }, function() { failed(prev); });
}
function renderCardIo(s) {
  if (!s.conversationId) return '';
  var c = _ioCache[s.conversationId];
  if (!c || !c.data) {
    if (c && c.state === 'error') return '<div class="card-io"><div class="io-row"><div class="io-text is-muted">지시/응답을 불러오지 못했습니다</div></div></div>';
    // In flight: the shape of 지시 and 응답, the words for screen readers only.
    return '<div class="card-io" aria-busy="true"><div class="io-row io-skel" aria-hidden="true"><div class="sk sk-line" style="width:44%"></div><div class="sk sk-line" style="width:86%"></div></div>'
      + '<div class="io-row io-skel" aria-hidden="true"><div class="sk sk-line" style="width:36%"></div><div class="sk sk-line" style="width:72%"></div></div>'
      + '<span class="ib-sr">지시/응답 불러오는 중…</span></div>';
  }
  var d = c.data;
  var who = d.instruction && d.instruction.who ? '<span class="io-who">' + esc(d.instruction.who) + '</span>' : '';
  // User media (SSOT 2026-10-25): the instruction's files, small, above its words.
  var atts = d.instruction && Array.isArray(d.instruction.attachments) ? d.instruction.attachments : [];
  var mediaHtml = atts.length ? renderUserMedia(s.conversationId, atts, { compact: true }) : '';
  // A turn the user did not type reads as the detail panel's one line (SSOT
  // 2026-10-28): its badge, opening to the facts and the raw prompt.
  var turn = d.instruction && d.instruction.turn ? d.instruction.turn : null;
  var info = turn ? sysTurnInfo(turn) : null;
  // SSOT 2026-10-29 T7: the harness sent it — System, not the user's name.
  if (info) who = '<span class="io-who is-sys">System</span>';
  var replyHtml = d.response && (d.response.title || d.response.body)
    ? '<div class="io-text">'
      + (d.response.title ? '<span class="io-title">' + esc(d.response.title) + '</span>' + (d.response.body ? '\\n' : '') : '')
      + esc(d.response.body || '') + '</div>'
    : '';
  // A /compact runs only while it is the latest turn of a working session.
  var cp = info && info.kind === 'compact' ? cpState(turn, Date.now(), !!replyHtml || s.activityState !== 'working') : null;
  var inHtml = ioInstructionHtml(s.conversationId, d, turn, info, cp, atts);
  var outHtml;
  if (cp) {
    // A compaction's answer is the compaction: its progress, then its numbers.
    outHtml = ioCompactOutHtml(info, cp) + replyHtml;
  } else if (replyHtml) {
    outHtml = replyHtml;
  } else if (d.partial) {
    outHtml = '<div class="io-text is-muted">응답을 불러오지 못했습니다</div>';
  } else if (s.activityState === 'working') {
    outHtml = '<div class="io-text is-muted">응답 작성 중…</div>';
  } else {
    outHtml = '<div class="io-text is-muted">응답 없음</div>';
  }
  return '<div class="card-io">'
    + '<div class="io-row io-in"><div class="io-label">지시' + who + '</div>' + mediaHtml + inHtml + '</div>'
    + '<div class="io-row io-out"><div class="io-label">응답</div>' + outHtml + '</div>'
    + '</div>';
}

// The open card's 지시 (SSOT 2026-10-28). A turn the user did not type: one
// line with its badge, opening to its facts and raw prompt. A person's turn:
// their words, and the skills it invoked as badges. What is open stays open
// across the card's morph re-render (kept per conversation in _ioOpen).
var _ioOpen = Object.create(null);
function ioOpenState(cid) {
  return _ioOpen[cid] || (_ioOpen[cid] = { sys: false, skill: -1 });
}
// <ui-disclosure class="io-sys">'s ui-toggle (one listener on the document, initDisclosures): what the reader asked for.
function ioSysToggle(cid, open) {
  ioOpenState(cid).sys = !!open;
}
function ioSkillToggle(cid, i) {
  var st = ioOpenState(cid);
  st.skill = st.skill === i ? -1 : i;
  ioRefreshCards(cid);
}
function ioRefreshCards(cid) {
  for (var k in _cardHost) {
    var s = _sessionCache[k];
    if (s && s.conversationId === cid) refreshCard(k);
  }
}
// The skill badges of the detail panel, written from state: the open one's
// body is in the markup, so the morph keeps it.
function ioSkillsHtml(cid, skills) {
  if (!skills.length) return '';
  var open = ioOpenState(cid).skill;
  var base = 'ios-' + String(cid).replace(/[^A-Za-z0-9_-]/g, '');
  var badges = '';
  var pane = '';
  for (var i = 0; i < skills.length; i++) {
    var id = base + '-' + i;
    var on = open === i;
    badges += '<button type="button" class="skill-badge" aria-expanded="' + (on ? 'true' : 'false') + '" aria-controls="' + id + '" onclick="ioSkillToggle(\\'' + escJs(cid) + '\\',' + i + ')"'
      + ' title="토큰 수는 추정치 — 영문 4자 또는 그 밖의 글자 1자를 1토큰으로 셈">'
      + '<span class="skill-name">' + esc(skills[i].name) + '</span><span class="skill-tok">≈' + formatTokens(skills[i].tokens) + ' tokens</span></button>';
    if (on) pane = '<div class="skill-detail" id="' + id + '">' + skillPaneHtml(skills[i]) + '</div>';
  }
  return '<div class="skill-badges" role="group" aria-label="활성화된 스킬 ' + skills.length + '개">' + badges + '</div>' + pane;
}
function ioInstructionHtml(cid, d, turn, info, cp, atts) {
  if (info) {
    var facts = cp ? info.facts.concat(cpFacts(cp)) : info.facts;
    var line = info.kind === 'compact' ? '컨텍스트 압축 (/compact)' : info.line;
    return '<ui-disclosure class="io-sys" data-cid="' + escAttr(cid) + '"' + (ioOpenState(cid).sys ? ' open' : '') + ' flush>'
      + '<span slot="summary" class="io-sys-row"><span class="ui-chip sys-badge" data-kind="' + info.kind + '">' + esc(info.label) + '</span>'
      + '<span class="sys-line">' + esc(line) + '</span></span>'
      + '<div class="sys-detail">' + sysFactsHtml(facts) + '<div class="sys-raw-h">원본 프롬프트</div><pre class="sys-raw">' + esc(info.raw) + '</pre></div></ui-disclosure>';
  }
  var none = atts.length ? '<div class="io-text is-muted">첨부 ' + atts.length + '개</div>' : '<div class="io-text is-muted">기록된 지시 없음</div>';
  if (!turn) return d.instruction && d.instruction.text ? '<div class="io-text">' + esc(d.instruction.text) + '</div>' : none;
  // The whole turn, not the 500-character cut: a skill block runs past it.
  var split = splitInvokedSkills(decodeSlackEntities(String(turn.rawContent || '')));
  var words = split.text.length > 500 ? split.text.slice(0, 500) + '…' : split.text;
  var wordsHtml = words.trim() ? '<div class="io-text">' + esc(words) + '</div>' : (split.skills.length ? '' : none);
  return wordsHtml + ioSkillsHtml(cid, split.skills);
}
// The 응답 of a /compact: elapsed / estimate while it runs (cpTick moves it),
// then its numbers.
function ioCompactOutHtml(info, cp) {
  var live = cp.phase === 'live';
  if (live) cpEnsureTicker();
  return '<div class="io-cp"' + (live ? ' data-cp-live="1" data-cp-start="' + cp.start + '" data-cp-est="' + cp.est + '" data-cp-label="' + escAttr(info.label) + '"' : '') + '>'
    + '<span class="cp-slot">' + cpLineHtml(info, cp, Date.now()) + '</span></div>';
}

// The latest instruction and the reply that answers it (only an assistant
// turn AFTER the latest user turn counts). Rejects on any HTTP failure.
function fetchCardIo(cid) {
  return fetch('/api/dashboard/session/' + encodeURIComponent(cid) + '?limit=2')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
      var turns = (data && data.turns) || [];
      var ui = -1;
      for (var i = turns.length - 1; i >= 0; i--) { if (turns[i].role === 'user') { ui = i; break; } }
      var reply = null;
      for (var j = turns.length - 1; j > ui; j--) { if (turns[j].role === 'assistant') { reply = turns[j]; break; } }
      var raw = ui >= 0 ? decodeSlackEntities(turns[ui].rawContent || '') : '';
      var attachments = ui >= 0 && Array.isArray(turns[ui].attachments) ? turns[ui].attachments : [];
      if (attachments.length) umRegister(cid, attachments, turns[ui]);
      var u = ui >= 0 ? turns[ui] : null;
      // The whole turn rides along: the card reads who sent it and its skills from it.
      var instruction = u
        ? { text: raw.slice(0, 500) + (raw.length > 500 ? '…' : ''), who: u.userName || '', attachments: attachments,
          turn: { id: u.id, role: 'user', timestamp: u.timestamp, userName: u.userName, rawContent: u.rawContent || '', origin: u.origin, compact: u.compact } }
        : null;
      if (reply && !reply.summaryTitle && !reply.summaryBody && reply.id) {
        // Summary not generated yet — fall back to the head of the raw response.
        // If that fails the result is partial: the instruction is kept, and the
        // caller retries for the response.
        return fetch('/api/conversations/' + encodeURIComponent(cid) + '/turns/' + encodeURIComponent(reply.id) + '/raw')
          .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function(rawData) {
            var text = rawData && typeof rawData.raw === 'string' ? rawData.raw : '';
            return { instruction: instruction, response: text ? { title: '', body: text.slice(0, 600) + (text.length > 600 ? '…' : '') } : null };
          }, function() { return { instruction: instruction, response: null, partial: true }; });
      }
      return { instruction: instruction, response: reply ? { title: reply.summaryTitle || '', body: reply.summaryBody || '' } : null };
    });
}

// Deadline timer fired: retry for the first card of that conversation still open.
function retryCardIo(cid) {
  var k = cardIoConsumer(cid);
  if (k) ensureCardIo(k, false, true);
}
function settleCardIo(cid, entry) {
  var wasDirty = !!(_ioCache[cid] && _ioCache[cid].dirty);
  _ioCache[cid] = entry;
  for (var k in _cardHost) {
    var s = _sessionCache[k];
    if (s && s.conversationId === cid) refreshCard(k);
  }
  if (wasDirty) invalidateCardIo(cid);
}
// A turn landed for this conversation — new content: refetch for any open card
// (in error: a fresh budget, still paced by the conversation's deadline).
function invalidateCardIo(cid) {
  var c = cid && _ioCache[cid];
  if (!c) return;
  if (c.state === 'loading') { c.dirty = true; return; }
  c.stamp = null;
  for (var k in _cardDrawn) {
    var s = _sessionCache[k];
    if (s && s.conversationId === cid && _expanded.has(k)) ensureCardIo(k, false);
  }
}

// Expanded body: model·effort → meta (env/workflow/owner/last activity) →
// refs → task timeline → instruction/response → pending question → stats →
// buttons. Every field the old card face showed is still gated by dhShow().
// The open card's resume row: when / which attempt, and the full error line
// the collapsed face clamps to two lines.
var RESUME_SVG = '<i data-ui-icon="clock"></i>';
function renderCardResume(s, col) {
  var r = pendingAutoResume(s, col);
  if (!r) return '';
  return '<div class="card-resume">' + RESUME_SVG + '<div>'
    + '<div class="cr-when">' + esc(autoResumeLabel(r)) + '</div>'
    + (r.reason ? '<div class="cr-reason">' + esc(r.reason) + '</div>' : '')
    + '</div></div>';
}

// The session's actions (spec 13) as data — the same on the open card (kit buttons,
// sessionActionHtml) and in the panel head (<ui-status-bar>, panelHeadData): ★ Star
// (pinned on top, kept alive — starring a sleeping or archived card brings it back),
// 살리기 on a sleeping or archived card (the conversation continues), then the state
// action — Stop while a turn runs, else Close; Trash once archived. Owner-gated (the
// server's requireSessionOwner is the guard; this is UX, fail closed on a missing
// ownerId): lock says why it cannot be pressed here ('' = it can). A sibling
// instance's session is one locked pointer to that instance (#814 — posting here
// would fail server-side). A write in flight is busy on both surfaces (Stop / Close /
// Trash: 'action'; Star and 살리기 share 'life' — SSOT 2026-10-30).
function sessionActionsOf(s, col) {
  var running = col === 'working' && !pendingAutoResume(s, col);
  var kind = running ? 'stop' : (col === 'closed' && s.terminated ? 'trash' : 'close');
  var label = kind === 'stop' ? 'Stop' : (kind === 'trash' ? 'Trash' : 'Close');
  var env = s.environment;
  if (SELF_INSTANCE_NAME && env && env.instanceName && env.instanceName !== SELF_INSTANCE_NAME) {
    return [{ id: kind, label: label + ' \\u2192 ' + env.instanceName, busy: false, sibling: true,
      lock: 'Open ' + env.instanceName + ' (' + (env.host || '') + ':' + (env.port || '') + ') to act on this session' }];
  }
  var isOwner = !!s.ownerId && s.ownerId === currentUserId;
  var lock = isOwner ? '' : READ_ONLY_MSG;
  var lifeBusy = isBusy(s.key, 'life');
  var starred = s.starred === true;
  var closed = col === 'closed' || s.terminated === true || s.sessionState === 'SLEEPING';
  var out = [{ id: 'star', label: starred ? '\\u2605 Starred' : '\\u2606 Star', pressed: starred, lock: lock, busy: lifeBusy,
    tip: !isOwner ? READ_ONLY_MSG
      : starred ? '즐겨찾기 해제 — 다시 자동 sleep·보관 대상이 돼요'
      : '즐겨찾기 — 항상 맨 위, 자동 sleep·보관 안 함' + (closed ? ' (지금 살려요)' : '') }];
  if (closed) out.push({ id: 'revive', label: '살리기', lock: lock, busy: lifeBusy,
    tip: isOwner ? '대화를 이어갈 수 있게 세션을 살려요 (작업 폴더 파일은 복구되지 않아요)' : READ_ONLY_MSG });
  out.push({ id: kind, label: label, lock: lock, busy: isBusy(s.key, 'action') });
  return out;
}
// The open card's action buttons (kit .ui-btn): Stop reads as the danger tone, Trash as a quiet one.
var SESSION_ACTION_TONE = { stop: ' is-danger', close: '', trash: ' is-quiet' };
function sessionActionHtml(s, col) {
  var key = escJs(s.key);
  return sessionActionsOf(s, col).map(function(a) {
    var off = (a.lock || a.busy ? ' disabled' : '') + (a.busy ? ' aria-busy="true"' : '');
    if (a.sibling) return '<button class="ui-btn' + SESSION_ACTION_TONE[a.id] + '" data-action="' + a.id + '" disabled title="' + escAttr(a.lock) + '">' + esc(a.label) + '</button>';
    if (a.id === 'star') {
      return '<button type="button" class="ui-btn" data-action="star" aria-pressed="' + a.pressed + '"' + off + ' title="' + escAttr(a.tip) + '"'
        + ' onclick="event.stopPropagation();doStar(\\'' + key + '\\',' + !a.pressed + ')">' + esc(a.label) + '</button>';
    }
    if (a.id === 'revive') {
      return '<button type="button" class="ui-btn" data-action="revive"' + off + ' title="' + escAttr(a.tip) + '"'
        + ' onclick="event.stopPropagation();doRevive(\\'' + key + '\\')">' + esc(a.label) + '</button>';
    }
    return '<button class="ui-btn' + SESSION_ACTION_TONE[a.id] + '" data-action="' + a.id + '"' + off + (a.lock ? ' title="' + escAttr(a.lock) + '"' : '')
      + ' onclick="event.stopPropagation();doAction(\\'' + key + '\\',\\'' + a.id + '\\')">' + esc(a.label) + '</button>';
  }).join('');
}

// The goal on the open card (spec 13): one line — objective · status · n/max ·
// 대기 n — pointing at its home, the panel's goal section (the editor, the
// queue, the completed goals). Closed sessions keep the line: it is the outcome.
function cardGoalLine(s, col, canEdit) {
  var g = s.goal || null;
  var cur = g && g.current;
  var editable = canEdit && col !== 'closed' && !s.terminated;
  var go = ' onclick="event.stopPropagation();openPanel(\\'' + escJs(s.key) + '\\',\\'goal\\',\\'\\',event.detail===0)"';
  var queued = g && g.queue ? g.queue.length : 0;
  if (!cur) {
    var done = g ? toNum(g.completedCount) : 0;
    if (!editable && !queued && !done) return '';
    var what = queued ? '대기 중인 goal ' + queued + '개' : (done ? '완료된 goal ' + done + '개' : '현재 goal 없음');
    return '<div class="card-goal-line"><span class="cgl-icon" aria-hidden="true">' + GOAL_SVG + '</span>'
      + '<span class="cgl-text is-muted">' + what + '</span>'
      + '<button type="button" class="cgl-go"' + go + '>' + (editable ? 'goal 추가 &rarr;' : '보기 &rarr;') + '</button></div>';
  }
  var bits = '<span class="ui-status cg-status"' + (GOAL_STATUS_TONE[cur.status] ? ' data-tone="' + GOAL_STATUS_TONE[cur.status] + '"' : '') + '>' + esc(GOAL_STATUS_LABELS[cur.status] || cur.status) + '</span>';
  if (cur.status === 'active' && toNum(cur.maxContinuations) > 0) {
    bits += '<span class="cgl-n" title="자동 이어하기 횟수 / 상한">' + toNum(cur.continuationCount) + '/' + toNum(cur.maxContinuations) + '</span>';
  }
  if (queued) bits += '<span class="cgl-n">대기 ' + queued + '</span>';
  return '<div class="card-goal-line"><span class="cgl-icon" aria-hidden="true">' + GOAL_SVG + '</span>'
    + '<span class="cgl-text" title="' + escAttr(cur.objective) + '">' + esc(cur.objective) + '</span>' + bits
    + '<button type="button" class="cgl-go"' + go + '>' + (editable ? '관리 &rarr;' : '보기 &rarr;') + '</button></div>';
}

// Open card body (spec 13 — "settle it here"): the face stays on screen above
// it, so nothing the face shows is drawn again (tokens, cost, context, status,
// the current task row, the subagent counts). What it holds follows the card:
//   blockers first, whatever the column: a permission prompt, an armed
//     automatic resume, the pending question with its choices;
//   working: task window → agents → the latest exchange;
//   waiting: the latest exchange → artifacts (the evidence to answer with) →
//     task window → agents;
//   idle / closed: the latest exchange → artifacts (the outcome) → agents;
//   then the goal line, the short refs, and the control strip: model · effort
//   (SSOT 2026-10-22 T4/T5, 10-23 T1 — a quick switch), the state action,
//   Slack, 작업 로그.
// The complete record — meta, every number, titled links, the goal editor, the
// whole task ledger, the rich agent tree — is the panel's.
function renderCardBody(s, col) {
  // Owner gating — server-side requireSessionOwner is the authoritative guard;
  // this is UX only. Fail closed: if ownerId is missing (legacy record) the
  // viewer is not treated as owner so the server-side reject is expected.
  const isOwner = !!s.ownerId && s.ownerId === currentUserId;
  const isSibling = !!(SELF_INSTANCE_NAME && s.environment && s.environment.instanceName && s.environment.instanceName !== SELF_INSTANCE_NAME);

  // The open card's quick switch (T4/T5, 10-23 T1; re-model-picker D1): the
  // owner's one trigger opens the model · effort menu; others read model · level.
  // ui.dashboardheader 'model' gates the read-only name only — the trigger is the
  // owner's control for effort too (the effort switch was never behind that gate).
  const modelShort = esc(s.model).replace(/^claude-/, '').replace(/-\\d{8}$/, '');
  const canSwitchModel = isOwner && col !== 'closed' && !s.terminated && !isSiblingSession(s);
  const modelParts = [];
  if (canSwitchModel) modelParts.push(renderModelPicker(s, true, modelShort, 'card'));
  else {
    if (dhShow('model') && modelShort) modelParts.push(renderModelPicker(s, false, modelShort, 'card'));
    if (s.effort) modelParts.push(renderEffortPicker(s));
  }
  const modelHtml = modelParts.length ? '<span class="cfb-model">' + modelParts.join('') + '</span>' : '';
  const modelNote = renderModelNote(s, canSwitchModel);

  // #814 env badge — only shown when multiple distinct envs are present in
  // the current cache (the action depends on which instance runs it).
  var envHtml = '';
  if (s.environment && s.environment.instanceName && _envCount() > 1) {
    var instName = s.environment.instanceName;
    var envColor = getEnvBadgeColor(instName);
    var envHostPort = (s.environment.host || '') + ':' + (s.environment.port || '');
    envHtml = '<span class="env-badge" style="--env-tone:' + envColor + '" title="' + escAttr(instName + ' (' + envHostPort + ')') + '">' + esc(instName) + '</span>';
  }
  // Short refs (PROJ-123 · PR-123), gated by ui.dashboardheader 'links'. The
  // titled links and the conversation are the panel's (세션 정보).
  const refParts = [];
  if (dhShow('links') && s.issueShortRef && s.issueUrl) {
    refParts.push('<a href="' + safeHref(s.issueUrl) + '" target="_blank" rel="noopener" title="' + escAttr(s.issueTitle || s.issueLabel || s.issueShortRef) + '">' + esc(s.issueShortRef) + '</a>');
  }
  if (dhShow('links') && s.prShortRef && s.prUrl) {
    refParts.push('<a href="' + safeHref(s.prUrl) + '" target="_blank" rel="noopener" title="' + escAttr(s.prTitle || s.prLabel || s.prShortRef) + '">' + esc(s.prShortRef) + '</a>');
  }
  const refsHtml = refParts.length || envHtml
    ? '<div class="card-refs">' + envHtml + refParts.join('<span class="ref-sep">&middot;</span>') + '</div>'
    : '';

  // The collapsed face already shows the pending question as its summary; the
  // open card then keeps only the choices, not the same sentence twice.
  const faceSummary = cardSummary(s, col, s.displayHeadline || s.summaryTitle || s.title);
  // The pending question of a waiting session. The single-choice question is
  // the same <ui-approval-card> as the panel's (acQuestionHtml — its answer is
  // ui-answer, locked for anyone but the owner on this instance); the element
  // titles the card with the whole question, so it reads the face's summary
  // again. The multi-question form opens the panel (답변하기).
  let questionHtml = '';
  if (s.pendingQuestion && col === 'waiting') {
    if (s.pendingQuestion.type === 'user_choice' && s.pendingQuestion.choices) {
      questionHtml = acQuestionHtml(s, s.pendingQuestion);
    } else if (s.pendingQuestion.type === 'user_choices') {
      questionHtml = renderMultiChoiceCard(s, faceSummary);
    }
  }

  // The permission prompts the turn is blocked on (SSOT 2026-10-24): one
  // <ui-approval-card> each (acPermissionsHtml), as in the panel.
  const permissionHtml = col === 'closed' ? '' : acPermissionsHtml(s);

  const ioHtml = isSiblingSession(s) ? '' : renderCardIo(s);
  // Artifacts live on this instance's disk: a sibling instance's card links nowhere here.
  const artsHtml = isSiblingSession(s) ? '' : renderCardArtifacts(s);
  const tasksHtml = renderTimeline(s);
  const agentsHtml = renderAgentTree(s, col);
  let middle;
  if (col === 'working') middle = tasksHtml + agentsHtml + ioHtml;
  else if (col === 'waiting') middle = ioHtml + artsHtml + tasksHtml + agentsHtml;
  else middle = ioHtml + artsHtml + agentsHtml;

  // SSOT 2026-10-29 T1/T2: the session's actions (Stop · Close · Trash) and
  // Slack sit right under the face — one reach from the click that opened the
  // card, never under a long body. There is no 작업 로그 button: an open card's
  // detail is always beside the board (the detail deck, openPanel).
  const slackBtn = (dhShow('links') && s.slackThreadUrl)
    ? '<a class="ui-btn" href="' + safeHref(s.slackThreadUrl) + '" target="_blank" rel="noopener">Slack</a>'
    : '';
  const actionsHtml = '<div class="card-actions-bar"><span class="card-actions">' + sessionActionHtml(s, col) + slackBtn + '</span></div>';
  const footHtml = modelHtml ? '<div class="card-foot-bar">' + modelHtml + '</div>' + modelNote : modelNote;

  return '<div class="card-body">'
    + actionsHtml
    + permissionHtml
    + renderCardResume(s, col)
    + questionHtml
    + middle
    + cardGoalLine(s, col, isOwner && !isSibling)
    + refsHtml
    + footHtml
    + '</div>';
}

// ── Model · effort on the open card and beside the panel's composer ──
// SSOT 2026-10-22 T4/T5 · 10-23 T1, shaped after affectUI Model Picker
// (.prd/affectui/re-model-picker.md): the owner gets one trigger per surface
// that opens one menu — the representative models (REPRESENTATIVE_MODELS) with
// window · autocompact · cost bars, the effort levels the model runs, a price
// tray. A model whose auto-compact threshold is below what the context holds
// now says the switch compacts first: the server compacts on the current model
// and switches at the compact's boundary (the strip shows the waiting switch).
// The trigger and its menu are @2lab.ai/ui <ui-model-picker> (the element this
// menu was ported to): the dashboard maps the session onto its data (mpData),
// sets it where it changed (mpHydrate) and answers its picks (mpOnChange) with
// the same writes as before — one per session and operation, the server deciding.
var _modelNotes = Object.create(null); // card key → { text, error }
// One write in flight per session and operation (model · effort · goal ·
// action), shared by the open card and the panel: every renderer reads it, so
// a control blurred while its request runs is never re-enabled by a live render.
var _busy = Object.create(null);
function isBusy(key, op) {
  return !!_busy[key + '|' + op];
}
function setBusy(key, op, on) {
  if (on) _busy[key + '|' + op] = true;
  else delete _busy[key + '|' + op];
}
// The owner's trigger: the element in a token wrapper (.ui-tok, display: contents),
// named by its session and surface — the panel's menu opens above it. Until the
// library has loaded it reads the model's name. Others read the model as text.
function renderModelPicker(s, canSwitch, modelShort, surface) {
  if (!canSwitch) return '<span class="cb-model-name">' + modelShort + '</span>';
  var where = surface === 'panel' ? 'panel' : 'card';
  return '<span class="ui-tok mp-slot" data-mk="' + escAttr('mp|' + where + '|' + s.key) + '">'
    + '<ui-model-picker lang="ko"' + (where === 'panel' ? ' side="top"' : '') + ' data-mp-key="' + escAttr(s.key) + '" data-mp-surface="' + where + '">'
    + '<span class="mp-fallback">' + (modelShort || '모델') + '</span></ui-model-picker></span>';
}
// The session's model outside the switch list is named by its short id.
function mpShort(s) {
  return String((s && s.model) || '').replace(/^claude-/, '').replace(/-\\d{8}$/, '');
}
// The levels the session's model runs (all of them when the catalog has no menu for it) — re-model-picker D6/D7.
function mpEffortLevels(s) {
  var all = EFFORT_LEVELS || [];
  var menu = s.effortLevels && s.effortLevels.length ? s.effortLevels : null;
  var out = [];
  for (var i = 0; i < all.length; i++) if (!menu || menu.indexOf(all[i]) >= 0) out.push(all[i]);
  return out.length ? out : all.slice();
}
// What the picker shows of one session: the representative models in server
// order, each named by its nickname (what POST /model takes); the session's
// model — the nickname of the row whose model it runs, else its short id, which
// the element draws as a first, current, unselectable row; the level set, the
// level that runs and the levels its model runs; the context (a row below it
// switches after compaction); the writes in flight — a switch waiting for its
// compaction locks the rows and says so under the trigger — and the last refusal.
function mpData(s) {
  var models = REPRESENTATIVE_MODELS || [];
  var rows = [];
  var cur = '';
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    if (m.model === s.model) cur = m.nickname;
    rows.push({ id: m.nickname, label: m.label || m.nickname, short: m.nickname, window: toNum(m.contextWindow), autoCompactAt: toNum(m.autoCompactTokens), price: m.price || null });
  }
  var value = { model: cur || mpShort(s), effortLevels: mpEffortLevels(s) };
  if (s.effort) value.effort = s.effort;
  if (s.effortEffective) value.effectiveEffort = s.effortEffective;
  var d = {
    models: rows,
    value: value,
    contextTokens: toNum(s.contextTokens),
    busy: {
      model: s.pendingModel ? 'compact 후 ' + s.pendingModel + '(으)로 전환 대기 중' : isBusy(s.key, 'model'),
      effort: isBusy(s.key, 'effort'),
    },
  };
  var note = _modelNotes[s.key];
  if (note && note.error) d.error = note.text;
  return d;
}
// What mpData reads that can change, as one string (the model list and the
// level set are the page's constants) — compared on every card render instead
// of serializing the data itself.
function mpDataSig(s) {
  var note = _modelNotes[s.key];
  return [
    s.key, s.model, s.effort, s.effortEffective, s.pendingModel, toNum(s.contextTokens), String(s.effortLevels || ''),
    isBusy(s.key, 'model'), isBusy(s.key, 'effort'), note && note.error ? note.text : '',
  ].join('|');
}
// Set every picker's data under root — only where it changed (a push that
// changes nothing on it builds and writes nothing). An open menu follows its
// session this way while its surface holds still (isPickingModel). Data set
// before the element is defined is taken when it upgrades.
function mpHydrate(root) {
  if (!root || !root.querySelectorAll) return;
  var els = root.querySelectorAll('ui-model-picker[data-mp-key]');
  for (var i = 0; i < els.length; i++) {
    var s = _sessionCache[els[i].getAttribute('data-mp-key')];
    if (!s) continue;
    var sig = mpDataSig(s);
    if (els[i]._mpSig === sig) continue;
    els[i]._mpSig = sig;
    els[i].data = mpData(s);
  }
}
// A pick leaves the element as ui-change (re-model-picker D11): cancelled, so it
// keeps showing the session's value until the server agrees; a model goes to
// changeModel, a level to changeEffort (each one write per session at a time).
function mpOnChange(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-MODEL-PICKER' || !e.detail) return;
  e.preventDefault();
  var key = el.getAttribute('data-mp-key');
  if (e.detail.changed === 'model') changeModel(key, String(e.detail.model || ''));
  else if (e.detail.changed === 'effort') changeEffort(key, String(e.detail.effort || ''));
}
document.addEventListener('ui-change', mpOnChange);
// The menu closed (a pick, Esc, a press outside, its trigger moved): the card
// and the panel controls held their live updates while it was open (D12).
function mpOnOpenChange(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-MODEL-PICKER' || !e.detail || e.detail.open) return;
  var key = el.getAttribute('data-mp-key');
  refreshCard(key);
  repaintPanelControlsFor(key);
}
document.addEventListener('ui-open-change', mpOnOpenChange);
// The note under the model: what a switch did. The owner's picker says a
// waiting switch and a refused write under its own trigger (busy.model, error).
function renderModelNote(s, picker) {
  if (s.pendingModel) {
    return picker ? '' : '<div class="cb-model-note" role="status">compact 후 ' + esc(s.pendingModel) + '(으)로 전환합니다…</div>';
  }
  var n = _modelNotes[s.key];
  if (!n || (picker && n.error)) return '';
  return '<div class="cb-model-note' + (n.error ? ' is-error' : '') + '"' + (n.error ? ' role="alert"' : ' role="status"') + '>' + esc(n.text) + '</div>';
}
async function postModelSwitch(key, nickname) {
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/model';
  var body = JSON.stringify({ model: nickname });
  var headers = { 'Content-Type': 'application/json' };
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  var res = await fetch(url, { method: 'POST', headers: headers, body: body });
  if (res.status === 403) {
    await refreshCsrfToken();
    var retryHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
    res = await fetch(url, { method: 'POST', headers: retryHeaders, body: body });
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  return { ok: res.ok, result: data && data.result, error: (data && data.error) || ('HTTP ' + res.status) };
}
// What the card says after a switch request.
function modelSwitchNote(r) {
  if (!r.ok) return { text: r.error, error: true };
  var res = r.result || {};
  if (res.status === 'compacting') return { text: '컨텍스트가 ' + res.nickname + '의 autocompact ' + formatTokens(res.autoCompactTokens) + '보다 커서 지금 모델로 compact한 뒤 전환합니다', error: false };
  if (res.status === 'unchanged') return { text: '이미 ' + res.nickname + '입니다', error: false };
  return { text: res.nickname + '(으)로 전환 · autocompact ' + formatTokens(res.autoCompactTokens), error: false };
}
async function changeModel(key, nickname) {
  if (!nickname) return;
  // One switch at a time per session, whichever surface asks (spec 13 §3.5).
  if (isBusy(key, 'model')) return;
  setBusy(key, 'model', true);
  // The other surface shows the switch in flight at once.
  refreshCard(key);
  repaintPanelControlsFor(key);
  var r;
  try { r = await postModelSwitch(key, nickname); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  setBusy(key, 'model', false);
  // A refused switch needs no undo: the surfaces render the session's model again.
  _modelNotes[key] = modelSwitchNote(r);
  refreshCard(key);
  repaintPanelControlsFor(key);
  loadSessions();
}

// ── Effort on the card and beside the panel's composer (SSOT 2026-10-23 T1, spec 13) ──
// The owner picks one of the five levels; the session runs it from the next
// turn (the %effort scope — the owner's default stays). When the session's
// model caps the level, the note says what actually runs.
var EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
function effortLabel(level) {
  return EFFORT_LABELS[level] || String(level || '');
}
function renderEffortPicker(s) {
  // The owner's control lives in the model menu (<ui-model-picker>); others read the level.
  var capped = s.effortEffective && s.effortEffective !== s.effort
    ? ' title="이 모델은 ' + escAttr(effortLabel(s.effortEffective)) + '까지 실행합니다"' : ' title="' + STRINGS.effortTitle + '"';
  return '<span class="meta-effort"' + capped + '>' + esc(effortLabel(s.effort))
    + (s.effortEffective && s.effortEffective !== s.effort ? ' &rarr; ' + esc(effortLabel(s.effortEffective)) : '') + '</span>';
}
async function postEffortSwitch(key, effort) {
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/effort';
  var body = JSON.stringify({ effort: effort });
  var headers = { 'Content-Type': 'application/json' };
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  var res = await fetch(url, { method: 'POST', headers: headers, body: body });
  if (res.status === 403) {
    await refreshCsrfToken();
    var retryHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
    res = await fetch(url, { method: 'POST', headers: retryHeaders, body: body });
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  return { ok: res.ok, result: data && data.result, error: (data && data.error) || ('HTTP ' + res.status) };
}
// What the card says after an effort change.
function effortSwitchNote(r) {
  if (!r.ok) return { text: r.error, error: true };
  var res = r.result || {};
  if (res.status === 'unchanged') return { text: '이미 effort ' + effortLabel(res.effort) + '입니다', error: false };
  var capped = res.effective && res.effective !== res.effort ? ' (이 모델은 ' + effortLabel(res.effective) + '까지 실행)' : '';
  return { text: 'effort ' + effortLabel(res.effort) + ' · 다음 턴부터 적용' + capped, error: false };
}
async function changeEffort(key, effort) {
  if (!effort) return;
  if (isBusy(key, 'effort')) return;
  setBusy(key, 'effort', true);
  refreshCard(key);
  repaintPanelControlsFor(key);
  var r;
  try { r = await postEffortSwitch(key, effort); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  setBusy(key, 'effort', false);
  _modelNotes[key] = effortSwitchNote(r);
  mpApplyEffort(key, r);
  refreshCard(key);
  repaintPanelControlsFor(key);
  loadSessions();
}
// What the server answered is the session's level now — the open menu's thumb
// does not wait for the next poll (a refusal changes nothing).
function mpApplyEffort(key, r) {
  var cs = _sessionCache[key];
  var res = r && r.ok ? r.result : null;
  if (!cs || !res || !res.effort) return;
  cs.effort = res.effort;
  if (res.effective && res.effective !== res.effort) cs.effortEffective = res.effective;
  else delete cs.effortEffective;
}
// Model · effort beside the composer (spec 13): this session's — one trigger
// for the owner (the menu opens above it), the plain text for others.
function renderPanelControls(s) {
  var el = document.getElementById('panel-controls');
  if (!el || !s) return;
  // An open menu holds its anchor here still until it closes; it follows the session through its data.
  // Only its own session's: a panel that moved to another session under it (openPanel from a deep
  // link) closes it (no ui-open-change) and is written for the new session — a pick there would go
  // to the session it was opened for.
  var held = el.querySelector('ui-model-picker[open]');
  if (held && held.getAttribute('data-mp-key') !== s.key) {
    held.open = false;
    held = null;
  }
  if (!held) {
    var isOwner = !!s.ownerId && s.ownerId === currentUserId;
    var canSwitch = isOwner && !s.terminated && s.sessionState !== 'SLEEPING' && !isSiblingSession(s);
    var modelShort = esc(s.model || '').replace(/^claude-/, '').replace(/-\\d{8}$/, '');
    var html = '<span class="pc-scope">이 세션</span>'
      + renderModelPicker(s, canSwitch, modelShort, 'panel')
      + (canSwitch ? '' : renderEffortPicker(s))
      + renderModelNote(s, canSwitch);
    if (el._html !== html) {
      morphInnerHtml(el, html);
      el._html = html;
    }
  }
  mpHydrate(el);
}
// After a switch on either surface: the panel's copy follows at once.
function repaintPanelControlsFor(key) {
  if (panelOpen && panelSessionKey === key && _sessionCache[key]) renderPanelControls(_sessionCache[key]);
}
// ── Goal list on the work item (SSOT 2026-10-21 T2/T3) ──
// The card shows the current goal, its state and the goals queued behind it,
// and lets the owner add a goal, delete the current goal (the next queued one
// starts — never \`goal clear\`, which also drops the queue) or delete a queued
// goal. Every write names WHERE the goal was seen (current / queued), so a goal
// that moved in the meantime is refused (409) instead of deleting the wrong one.
var GOAL_STATUS_LABELS = { active: '진행 중', paused: '일시정지', complete: '완료' };
var GOAL_STATUS_TONE = { active: 'run', paused: 'wait', complete: 'done' };
// The goal mark (P7): the 2lab icon set's target glyph, not the bullseye emoji.
var GOAL_SVG = '<i data-ui-icon="target"></i>';
var GOAL_VIA_LABELS = { user: '직접 완료', 'eval-model': '평가 모델 완료' };
// SSOT 2026-10-22 T6 — completed goals open from the goal head, per card.
var _goalHistoryOpen = Object.create(null); // card key → completed goals shown
function formatGoalTime(ms) {
  var n = Number(ms) || 0;
  if (!n) return '';
  return new Date(n).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
// One completed goal: objective, then when it closed · time spent · tokens ·
// cost · continuation turns · how it closed, then the evaluator's reason.
function renderGoalHistory(history) {
  var items = (history || []).map(function(h) {
    var meta = [];
    var at = formatGoalTime(h.completedAt);
    if (at) meta.push('완료 ' + at);
    if (toNum(h.activeMsUsed) > 0) meta.push('소요 ' + formatDuration(toNum(h.activeMsUsed)));
    if (h.tokens !== undefined) meta.push(formatTokens(h.tokens) + ' tok');
    if (h.costUsd !== undefined) meta.push('$' + toNum(h.costUsd).toFixed(2));
    if (toNum(h.continuationCount) > 0) meta.push('이어하기 ' + toNum(h.continuationCount) + '회');
    if (h.completedVia) meta.push(esc(Object.prototype.hasOwnProperty.call(GOAL_VIA_LABELS, h.completedVia) ? GOAL_VIA_LABELS[h.completedVia] : h.completedVia));
    var reason = h.completionReason && h.completionReason !== 'user' ? h.completionReason : '';
    return '<li class="cg-h-item">'
      + '<div class="cg-h-obj">' + esc(h.objective) + '</div>'
      + (meta.length ? '<div class="cg-h-meta">' + meta.join(' &middot; ') + '</div>' : '')
      + (reason ? '<div class="cg-h-reason">' + esc(reason) + '</div>' : '')
      + '</li>';
  }).join('');
  return '<ol class="cg-history">' + items + '</ol>';
}
// The completed-goal regions of one card (its face and the panel's goal editor).
function goalHxHosts(key) {
  var all = document.querySelectorAll ? document.querySelectorAll('.cg-hx') : [];
  var out = [];
  for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-hx') === key) out.push(all[i]);
  return out;
}
function toggleGoalHistory(key, folded) {
  var hosts = goalHxHosts(key);
  // Closing (P6): the open history folds to 0 rows first, then the card and the panel are drawn without it.
  if (!folded && _goalHistoryOpen[key] && hosts.length && !reduceMotion()) {
    if (hosts[0]._xpLeaveT) return;
    for (var j = 0; j < hosts.length; j++) {
      hosts[j].classList.add('xp-shut');
      xpMove(hosts[j]);
    }
    hosts[0]._xpLeaveT = setTimeout(function() {
      hosts[0]._xpLeaveT = 0;
      toggleGoalHistory(key, true);
    }, XP_MS);
    return;
  }
  if (_goalHistoryOpen[key]) delete _goalHistoryOpen[key];
  else _goalHistoryOpen[key] = true;
  refreshCard(key);
  // The goal editor's home is the panel (spec 13): its 완료된 goal toggle opens there.
  if (panelOpen && panelSessionKey === key) renderPanelGoal();
  // After the (morphing) re-render: the history's row clips while it moves.
  hosts = goalHxHosts(key);
  for (var i = 0; i < hosts.length; i++) xpMove(hosts[i]);
}
var _goalErrors = Object.create(null); // card key -> last refused goal action (shown until the next success)

function renderCardGoal(s, col, canEdit, open) {
  var g = s.goal || null;
  var live = col !== 'closed' && !s.terminated;
  // Read-only viewers and closed sessions only see a goal list that exists.
  if (!g && !(canEdit && live)) return '';
  var editable = canEdit && live;
  var dis = editable && !isBusy(s.key, 'goal') ? '' : ' disabled';
  var key = escJs(s.key);
  var queue = (g && g.queue) || [];
  var cur = g && g.current;
  var html = '<div class="card-goal' + (open ? ' is-open' : '') + '">';
  html += '<div class="cg-head"><span class="cg-label">' + GOAL_SVG + 'Goal</span>';
  if (cur) {
    html += '<span class="ui-status is-pill cg-status"' + (GOAL_STATUS_TONE[cur.status] ? ' data-tone="' + GOAL_STATUS_TONE[cur.status] + '"' : '') + '>' + esc(GOAL_STATUS_LABELS[cur.status] || cur.status) + '</span>';
    if (cur.status === 'active' && toNum(cur.maxContinuations) > 0) {
      html += '<span class="cg-progress" title="자동 이어하기 횟수 / 상한">' + toNum(cur.continuationCount) + '/' + toNum(cur.maxContinuations) + '</span>';
    }
  }
  // T6: the completed goals open from the head (any viewer, any column).
  var doneCount = g ? toNum(g.completedCount) : 0;
  var historyOpen = doneCount > 0 && !!_goalHistoryOpen[s.key];
  if (doneCount > 0) {
    html += '<button type="button" class="cg-history-toggle" aria-expanded="' + (historyOpen ? 'true' : 'false') + '"'
      + ' onclick="event.stopPropagation();toggleGoalHistory(\\'' + key + '\\')">완료된 goal ' + doneCount + '개'
      + '<span class="chev" aria-hidden="true"></span></button>';
  }
  html += '</div>';
  if (cur) {
    var dropLabel = queue.length ? '현재 goal 삭제 · 다음 시작' : '현재 goal 삭제';
    html += '<div class="cg-row" data-mk="' + escAttr('goal:' + cur.goalId) + '"><div class="cg-objective" id="panel-goal-obj" title="' + escAttr(cur.objective) + '">' + esc(cur.objective) + '</div>'
      + '<button type="button" class="ui-btn is-sm is-danger"' + dis
      + ' onclick="event.stopPropagation();goalAction(\\'' + key + '\\',{action:\\'delete\\',goalId:\\'' + escJs(cur.goalId) + '\\',expect:\\'current\\'},this)">'
      + dropLabel + '</button></div>';
    // SSOT 2026-10-29 — folded to its first 3 lines until opened; reading, so never disabled.
    // syncGoalMore keeps the toggle to an objective that runs past those lines.
    html += '<button type="button" class="cg-more" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="panel-goal-obj"'
      + ' onclick="event.stopPropagation();togglePanelGoal()">' + (open ? '접기' : '펼치기') + '<span class="chev" aria-hidden="true"></span></button>';
    if (cur.status === 'active' && cur.lastEvalReason) {
      html += '<div class="cg-gap">남은 것: ' + esc(String(cur.lastEvalReason).slice(0, 300)) + '</div>';
    }
  } else {
    html += '<div class="cg-empty">현재 goal 없음</div>';
  }
  if (queue.length) {
    html += '<div class="cg-queue-title">대기 중인 goal ' + queue.length + '개</div><ol class="cg-queue">';
    for (var i = 0; i < queue.length; i++) {
      var q = queue[i];
      html += '<li data-mk="' + escAttr('queued:' + q.goalId) + '"><div class="cg-row"><span class="cg-q-text">' + esc(q.objective) + '</span>'
        + '<button type="button" class="ui-btn is-sm is-danger" title="대기 goal 삭제" aria-label="대기 goal 삭제"' + dis
        + ' onclick="event.stopPropagation();goalAction(\\'' + key + '\\',{action:\\'delete\\',goalId:\\'' + escJs(q.goalId) + '\\',expect:\\'queued\\'},this)">삭제</button></div></li>';
    }
    html += '</ol>';
  }
  // The completed goals open under the current goal and its queue (T6), in a region that unfolds in place
  // (P6: its row 0fr → 1fr); closed it is empty, hidden and inert.
  if (doneCount > 0) {
    html += '<div class="cg-hx" data-hx="' + escAttr(s.key) + '"><div class="cg-hx-in"'
      + (historyOpen ? '><div class="cg-queue-title">완료된 goal</div>' + renderGoalHistory(g.history) : ' hidden inert>') + '</div></div>';
  }
  if (editable) {
    html += '<form class="cg-add" onsubmit="event.preventDefault();event.stopPropagation();addGoalFromCard(\\'' + key + '\\',this)">'
      + '<input class="cg-add-input" name="objective" maxlength="4000" autocomplete="off" aria-label="goal 추가"'
      + ' placeholder="' + (cur && cur.status !== 'complete' ? 'goal 추가 (현재 goal 다음에 시작)' : 'goal 추가 (바로 시작)') + '"'
      + ' onblur="goalInputBlur(\\'' + key + '\\')">'
      + '<button type="submit" class="ui-btn is-sm">추가</button></form>';
  }
  if (_goalErrors[s.key]) html += '<div class="cg-error" role="alert">' + esc(_goalErrors[s.key]) + '</div>';
  return html + '</div>';
}

// The goal input survives the card's live re-render: while it has focus the
// body is not replaced at all (typing and IME composition stay intact), and an
// unfocused draft is carried into the new body.
function isEditingGoal(root) {
  var a = document.activeElement;
  return !!(a && a.classList && a.classList.contains('cg-add-input') && root.contains(a));
}
// An open model menu holds its anchor's card still: the trigger is where the menu hangs (re-model-picker D12).
function isPickingModel(root) {
  return !!(root && root.querySelector && root.querySelector('ui-model-picker[open]'));
}
function captureGoalDraft(root) {
  var input = root.querySelector('.cg-add-input');
  return input && input.value ? input.value : '';
}
function restoreGoalDraft(root, value) {
  if (!value) return;
  var input = root.querySelector('.cg-add-input');
  if (input && !input.value) input.value = value;
}
function goalInputBlur(key) {
  // Let a click on 추가 land before the deferred re-render replaces the form.
  setTimeout(function() {
    var host = document.getElementById('panel-goal');
    if (host && panelSessionKey === key && !isEditingGoal(host)) renderPanelGoal();
  }, 200);
}

async function postGoalAction(key, payload) {
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/goal';
  var body = JSON.stringify(payload);
  var headers = { 'Content-Type': 'application/json' };
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  var res = await fetch(url, { method: 'POST', headers: headers, body: body });
  if (res.status === 403) {
    await refreshCsrfToken();
    var retryHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
    res = await fetch(url, { method: 'POST', headers: retryHeaders, body: body });
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  return { ok: res.ok, error: (data && data.error) || ('HTTP ' + res.status) };
}
function setGoalError(key, message) {
  if (message) _goalErrors[key] = message;
  else delete _goalErrors[key];
  refreshCard(key);
  if (panelOpen && panelSessionKey === key) renderPanelGoal();
}
async function goalAction(key, payload, btn) {
  if (isBusy(key, 'goal')) return; // one goal write at a time per session
  if (btn) btn.disabled = true;
  setBusy(key, 'goal', true);
  var r;
  try { r = await postGoalAction(key, payload); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  setBusy(key, 'goal', false);
  setGoalError(key, r.ok ? '' : r.error);
  if (!r.ok && btn) btn.disabled = false;
  loadSessions();
}
// One add in flight per card. The input is NOT disabled while it is sent:
// keeping its focus is what keeps a live re-render from replacing the form
// (and resurrecting the sent text as a fresh, submittable draft).
var _goalAdding = Object.create(null);
async function addGoalFromCard(key, form) {
  // One goal write at a time per session: an add never overlaps a delete (spec 13 §3.5).
  if (_goalAdding[key] || isBusy(key, 'goal')) return;
  var input = form.querySelector('.cg-add-input');
  var objective = input ? input.value.trim() : '';
  if (!objective) return;
  _goalAdding[key] = true;
  setBusy(key, 'goal', true);
  var btn = form.querySelector('button');
  if (btn) btn.disabled = true;
  var r;
  try { r = await postGoalAction(key, { action: 'add', objective: objective }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  // The form on screen may have been re-rendered meanwhile — act on the live one,
  // and only while the panel still shows this session (another session's draft is never touched).
  var host = panelSessionKey === key ? document.getElementById('panel-goal') : null;
  var live = (host && host.querySelector('.cg-add-input')) || input;
  var liveBtn = live.form ? live.form.querySelector('button') : btn;
  if (liveBtn) liveBtn.disabled = false;
  if (btn && btn !== liveBtn) btn.disabled = false;
  if (r.ok) {
    if (live.value.trim() === objective) live.value = '';
    live.blur();
  }
  // Released only once the sent text is gone from the form: a live render in
  // between cannot re-arm a submit that would send the same goal twice.
  delete _goalAdding[key];
  setBusy(key, 'goal', false);
  setGoalError(key, r.ok ? '' : r.error);
  loadSessions();
}

// Card click / Enter / Space = expand / collapse in place (§3.1-4), Esc inside
// an open card closes it — the element's (ui-toggle; keyboard without the
// transition, a finished text selection is not a toggle). The page follows
// through wireInbox: the body, the 지시/응답 and artifacts fetches.

// Board ↔ List (§3.1-2, §4-4): the element re-lays out the very same cards and
// glides each card and column head from its old place (translate only). The
// choice is remembered only when the reader makes it.
// <ui-segmented id="view-seg"> (D-02): Board | List with the icon set's glyphs.
var VIEW_OPTIONS = [{ value: 'board', label: '보드', icon: 'board' }, { value: 'list', label: '목록', icon: 'list' }];
function setBoardView(view, ev) {
  if (view !== 'board' && view !== 'list') return;
  if (ev) {
    try { localStorage.setItem('soma-board-view', view); } catch (_e) {}
  }
  var seg = document.getElementById('view-seg');
  if (seg && (!seg.data || seg.data.value !== view)) seg.data = { label: '보드 보기', value: view, options: VIEW_OPTIONS };
  var kb = document.getElementById('kanban');
  if (!kb || kb.getAttribute('view') === view) return;
  kb.setAttribute('view', view);
  // A reader's switch glides in the element; the layout-shift coordinator takes
  // the result as the new layout so it never animates the same change twice
  // (SSOT 2026-10-24). Without an event the coordinator runs the only glide.
  if (ev) adoptLayout();
}
// The board's elements on screen: the board, and each CRON job's.
function boardHosts() {
  var out = [];
  var kb = document.getElementById('kanban');
  if (kb) out.push(kb);
  var lane = document.querySelectorAll('ui-agent-inbox.cron-inbox');
  for (var i = 0; i < lane.length; i++) if (lane[i].isConnected && lane[i].getClientRects().length) out.push(lane[i]);
  return out;
}

// ── Layout shift (SSOT 2026-10-24) — fold, unfold, rotate, dock ──
// One coordinator. A change of the layout mode {board columns, panel
// closed|sheet|docked, applied view, the sections above the board} glides the
// board's cards from where they were on screen to where they are now
// (<ui-agent-inbox> flipFrom). A resize handler can only read the new layout,
// so the "before" is a cache of each element's measure(), refreshed when the
// board settles (render, scroll end, transition end, a finished shift) and
// corrected for the page's scroll since.
function defaultBoardView(innerWidth, saved) {
  if (saved === 'board' || saved === 'list') return saved;
  return innerWidth < 640 ? 'list' : 'board';
}
function savedBoardView() {
  try { return localStorage.getItem('soma-board-view'); } catch (_e) { return null; }
}
function layoutModeOf(innerW, inboxW, panelOpen, view) {
  return {
    cols: inboxW >= 840 ? 'full' : 'snap',
    panel: !panelOpen ? 'closed' : (innerW >= 840 ? 'docked' : 'sheet'),
    view: view,
  };
}
function layoutModeKey(m) {
  return m.cols + '|' + m.panel + '|' + m.view + (m.sec ? '|' + m.sec : '');
}
var _layoutSnap = []; // [element, its measure()] when the cache was taken
var _layoutScroll = { x: 0, y: 0 }; // window scroll when the cache was taken
var _lastScroll = { x: 0, y: 0 }; // the scroll the reader last saw (scroll events)
var _layoutModeKey = '';
var _layoutShiftUntil = 0;
var _layoutCheckQueued = false;
var _layoutRefreshTimer = null;
var _layoutCheckFrame = null; // document.timeline time of the frame the last check ran in
var _panelAnchor = null;
var _panelScrollGen = 0; // bumped by the reader's own input in the panel
var _layoutPanelW = 0; // the open drawer's width when the cache was taken
function currentLayoutMode() {
  var inbox = document.getElementById('inbox');
  var panel = document.getElementById('slide-panel');
  var kb = document.getElementById('kanban');
  var m = layoutModeOf(
    window.innerWidth,
    inbox ? inbox.getBoundingClientRect().width : 0,
    !!(panel && panel.classList.contains('open')),
    kb ? kb.getAttribute('view') : ''
  );
  // The secondary sections above the board (capacity, CRON lane) move it too.
  m.sec = secStateKey();
  return m;
}
function layoutScrollNow() {
  return { x: window.scrollX, y: window.scrollY };
}
// The first panel row in view and its offset in the scroll area — restored after
// a shift reflows the drawer, so the reader keeps their place.
function capturePanelAnchor() {
  var scrollEl = document.getElementById('panel-scroll');
  if (!scrollEl || !panelOpen) return null;
  // Read at its top (the task view's landing): the top is the place to keep, not a row.
  if (scrollEl.scrollTop <= 0) return { atTop: true, gen: _panelScrollGen };
  var a = panelScrollAnchor(scrollEl);
  return a ? { el: a.el, offset: a.top - scrollEl.getBoundingClientRect().top, gen: _panelScrollGen } : null;
}
function restorePanelAnchor(a) {
  var scrollEl = document.getElementById('panel-scroll');
  if (!scrollEl || !panelOpen) return;
  // Never pull the reader back from a place they scrolled to themselves.
  if (!a || a.gen !== _panelScrollGen) return;
  if (a.atTop) { if (scrollEl.scrollTop !== 0) scrollEl.scrollTo({ top: 0, behavior: 'instant' }); return; }
  if (!a.el.isConnected) return;
  var drift = a.el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - a.offset;
  if (Math.abs(drift) > 0.5) scrollEl.scrollTo({ top: scrollEl.scrollTop + drift, behavior: 'instant' });
}
// Measure the settled layout (never mid-shift: gliding cards are not at their places).
// A refresh that finds a new mode is a shift the coordinator has not seen yet (a
// timer can run between the resize and its event): hand it over instead, so the
// cache still holds the layout the reader saw.
function refreshLayoutCache() {
  if (Date.now() < _layoutShiftUntil) return;
  if (_layoutModeKey && layoutModeKey(currentLayoutMode()) !== _layoutModeKey) { requestLayoutCheck(); return; }
  measureLayout();
}
function measureLayout() {
  _layoutSnap = boardHosts().filter(function(el) { return typeof el.measure === 'function'; }).map(function(el) { return [el, el.measure()]; });
  _layoutScroll = layoutScrollNow();
  _lastScroll = _layoutScroll;
  _layoutModeKey = layoutModeKey(currentLayoutMode());
  _panelAnchor = capturePanelAnchor();
  _layoutPanelW = panelOpen ? document.getElementById('slide-panel').getBoundingClientRect().width : 0;
}
// A reader's Board/List switch (setBoardView with an event) glides in the
// element; the coordinator takes it as the new layout once it has landed.
function adoptLayout() {
  _layoutModeKey = layoutModeKey(currentLayoutMode());
  _layoutShiftUntil = Date.now() + MOTION.move;
  scheduleLayoutRefresh(MOTION.move + 40);
}
function scheduleLayoutRefresh(delay) {
  clearTimeout(_layoutRefreshTimer);
  _layoutRefreshTimer = setTimeout(refreshLayoutCache, delay);
}
function requestLayoutCheck() {
  if (_layoutCheckQueued) return;
  _layoutCheckQueued = true;
  requestAnimationFrame(function() { _layoutCheckQueued = false; runLayoutCheck(); });
}
// openPanel / closePanel call this right before they change the layout: what is
// on screen now is the "before" of the shift.
function layoutBeforeChange() {
  refreshLayoutCache();
  requestLayoutCheck();
}
// The cached spots where the reader saw them: moved by the page's scroll since.
function scrolledSpots(layout, sx, sy) {
  var spots = Object.create(null);
  var from = (layout && layout.spots) || {};
  for (var k in from) spots[k] = { x: from[k].x - sx, y: from[k].y - sy };
  return { spots: spots };
}
function runLayoutCheck() {
  var kb = document.getElementById('kanban');
  if (!kb) return;
  // Once per frame: the window resize (rAF) and the inbox ResizeObserver can both
  // land in one frame; the frame's own layout was already measured by the first.
  var frame = document.timeline ? document.timeline.currentTime : null;
  if (frame !== null && frame === _layoutCheckFrame) return;
  _layoutCheckFrame = frame;
  // The default view follows the screen until the reader picks one (no event:
  // setBoardView neither saves it nor adopts it — this runs the only glide).
  var autoView = defaultBoardView(window.innerWidth, savedBoardView());
  if (kb.getAttribute('view') !== autoView) setBoardView(autoView);
  // The secondary sections' defaults follow the window in this same frame, so a
  // fold or a window change that also folds them is one shift.
  if (applySectionState()) renderBoardForLayout();
  var mode = currentLayoutMode();
  var changed = layoutModeKey(mode) !== _layoutModeKey;
  var flying = Date.now() < _layoutShiftUntil;
  // Unchanged: a settled board is measured again; a glide in flight lands where
  // its element puts it (it is measured once it has landed).
  if (!changed) { if (!flying) measureLayout(); return; }
  var anchor = _panelAnchor;
  var gen = _panelScrollGen;
  var sx = _lastScroll.x - _layoutScroll.x, sy = _lastScroll.y - _layoutScroll.y;
  var animate = canAnimate();
  var reduce = reduceMotion();
  // Every card and head glides from where the reader saw it (the element does
  // nothing on its first paint, in a hidden tab or under reduced motion).
  if (animate && !reduce) {
    for (var i = 0; i < _layoutSnap.length; i++) {
      var el = _layoutSnap[i][0];
      if (el.isConnected && typeof el.flipFrom === 'function') el.flipFrom(scrolledSpots(_layoutSnap[i][1], sx, sy));
    }
  }
  if (animate && reduce) kb.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fade, easing: 'linear' });
  // The open drawer's own width (sheet ↔ dock) animates with the cards: from its
  // visible width (mid-flight, the running animation's) to the new one. Only here —
  // a CSS width transition would trail every desktop window drag.
  var panel = document.getElementById('slide-panel');
  var toW = 0;
  if (panel && panelOpen) {
    // Only a sheet ↔ dock change (or retargeting that same animation) — a drag of
    // the drawer's own edge that happens to cross 840px must follow the pointer.
    var prevPanel = _layoutModeKey.split('|')[1];
    var retarget = !!panel._wflip;
    var fromW = retarget ? panel.getBoundingClientRect().width : _layoutPanelW;
    if (panel._wflip) { panel._wflip.cancel(); panel._wflip = null; }
    toW = panel.getBoundingClientRect().width;
    var reshape = (prevPanel !== mode.panel || retarget) && !panel.classList.contains('resizing');
    if (reshape && fromW && animate && !reduce && Math.abs(fromW - toW) > 1) {
      panel._wflip = panel.animate([{ width: fromW + 'px' }, { width: toW + 'px' }], { duration: MOTION.move, easing: MOTION.easeOut });
      panel._wflip.onfinish = function() { panel._wflip = null; };
    }
  }
  _layoutPanelW = toW;
  _layoutModeKey = layoutModeKey(mode);
  restorePanelAnchor(anchor);
  _layoutShiftUntil = Date.now() + MOTION.move;
  setTimeout(function() {
    if (Date.now() < _layoutShiftUntil) return;
    if (gen === _panelScrollGen) restorePanelAnchor(anchor);
    refreshLayoutCache();
  }, MOTION.move + 20);
}

// ── Show archives (.prd/10 §3.1-1) — archived (terminated) cards are hidden
// unless the user turned them on (localStorage['soma-show-archives'] = 'on').
// The button sits in the board header and only appears while the board holds
// at least one archive. ──
var SHOW_ARCHIVES_KEY = 'soma-show-archives';
function readShowArchives() {
  try { return localStorage.getItem(SHOW_ARCHIVES_KEY) === 'on'; } catch (_e) { return false; }
}
var showArchives = readShowArchives();
// A deep link to a hidden archive shows that one card for this page load
// without touching the stored choice; the user's own toggle ends it.
var _revealedKey = null;
function toggleArchives() {
  showArchives = !showArchives;
  _revealedKey = null;
  try { localStorage.setItem(SHOW_ARCHIVES_KEY, showArchives ? 'on' : 'off'); } catch (_e) {}
  loadSessions();
}
// A toggle button: the label stays "Archives (N)" (N = archives on the board)
// and aria-pressed carries on / off — pressed it wears the selected-segment look.
function renderArchivesToggle(archivedCount) {
  var btn = document.getElementById('archives-toggle');
  var label = document.getElementById('archives-label');
  if (!btn || !label) return;
  var hide = archivedCount === 0;
  if (btn.hidden !== hide) btn.hidden = hide;
  var pressed = showArchives ? 'true' : 'false';
  if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
  setTextIfChanged(label, 'Archives (' + archivedCount + ')');
}

// ── Sleeping — the same on / off toggle for sleeping (closed, not archived)
// cards. Shown by default, as before this toggle existed; the choice persists
// in localStorage['soma-show-sleeping'] ('on' / 'off'). ──
var SHOW_SLEEPING_KEY = 'soma-show-sleeping';
function readShowSleeping() {
  try { return localStorage.getItem(SHOW_SLEEPING_KEY) !== 'off'; } catch (_e) { return true; }
}
var showSleeping = readShowSleeping();
function toggleSleeping() {
  showSleeping = !showSleeping;
  _revealedKey = null;
  try { localStorage.setItem(SHOW_SLEEPING_KEY, showSleeping ? 'on' : 'off'); } catch (_e) {}
  loadSessions();
}
function renderSleepingToggle(sleepingCount) {
  var btn = document.getElementById('sleeping-toggle');
  var label = document.getElementById('sleeping-label');
  if (!btn || !label) return;
  var hide = sleepingCount === 0;
  if (btn.hidden !== hide) btn.hidden = hide;
  var pressed = showSleeping ? 'true' : 'false';
  if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
  setTextIfChanged(label, 'Sleeping (' + sleepingCount + ')');
}

// ── Session lifecycle policy (sleep / archive / board windows). The board
// response carries it; admins edit it in the Lifecycle dialog (PUT
// /api/dashboard/lifecycle, which the server only accepts from an admin with
// Admin mode on). Sleep and the board archive window are edited in hours, the
// archive time in days. ──
var _lifecycle = null;
// The request body the Save button is armed to force (?confirm=1), or null.
var _lifecycleArmed = null;
function armLifecycleSave(body) {
  _lifecycleArmed = body;
  var btn = document.getElementById('lifecycle-save');
  if (btn) btn.textContent = body ? '그래도 저장' : '저장';
}
// [form field, policy field, ms per form unit]
var LIFECYCLE_FIELDS = [['sleepAfterHours', 'sleepAfterMs', 3600000], ['archiveAfterDays', 'archiveAfterMs', 86400000], ['boardArchiveWindowHours', 'boardArchiveWindowMs', 3600000]];
// Pure: policy (ms) → form values.
function lifecycleToForm(p) {
  var out = {};
  for (var i = 0; i < LIFECYCLE_FIELDS.length; i++) {
    var f = LIFECYCLE_FIELDS[i];
    out[f[0]] = Math.round((p[f[1]] / f[2]) * 100) / 100;
  }
  return out;
}
// Pure: form values → { ok, patch } in ms (whole minutes), or { ok: false, field }
// naming the first field that is not a non-negative number. Bounds are the
// server's job; it answers 400 with the field.
function lifecycleFromForm(form) {
  var patch = {};
  for (var i = 0; i < LIFECYCLE_FIELDS.length; i++) {
    var f = LIFECYCLE_FIELDS[i];
    var raw = form[f[0]];
    var n = typeof raw === 'number' ? raw : (String(raw == null ? '' : raw).trim() === '' ? NaN : Number(raw));
    if (!isFinite(n) || n < 0) return { ok: false, field: f[0] };
    patch[f[1]] = Math.round((n * f[2]) / 60000) * 60000;
  }
  return { ok: true, patch: patch };
}
function openLifecycleDialog() {
  var dlg = document.getElementById('lifecycle-dialog');
  if (!dlg || !_lifecycle) return;
  var form = lifecycleToForm(_lifecycle);
  for (var k in form) {
    var input = document.getElementById('lc-' + k);
    if (input) input.value = String(form[k]);
  }
  armLifecycleSave(null);
  setTextIfChanged(document.getElementById('lifecycle-scope'), SELF_INSTANCE_NAME ? '이 인스턴스(' + SELF_INSTANCE_NAME + ')' : '이 인스턴스');
  setLifecycleStatus(_lifecycle.degraded ? '저장된 정책 파일을 읽을 수 없어 Sleeping/종료 전환을 멈춘 상태입니다. 저장하면 다시 시작합니다.' : '', !!_lifecycle.degraded);
  // <ui-dialog> (J-01): show() opens it modal at once (focus trap, Esc / scrim / ✕ close it, focus goes back to the
  // opener); the first field takes focus as the native dialog gave it.
  if (typeof dlg.show !== 'function') return;
  dlg.show();
  var first = document.getElementById('lc-sleepAfterHours');
  if (first) first.focus();
}
function closeLifecycleDialog() {
  var dlg = document.getElementById('lifecycle-dialog');
  if (dlg && typeof dlg.hide === 'function') dlg.hide();
}
// A dialog leaves the way it came (P6): its box and scrim fade out in 180ms (.is-closing), then close() —
// at once under reduced motion. Opening it again meanwhile keeps it (dialogKeep).
var DIALOG_EXIT_MS = 180;
function dialogCloseSoftly(dlg) {
  if (!dlg || !dlg.open) return;
  if (dlg._closeT) return;
  if (reduceMotion()) { dlg.close(); return; }
  dlg.classList.add('is-closing');
  dlg._closeT = setTimeout(function() {
    dlg._closeT = 0;
    dlg.classList.remove('is-closing');
    if (dlg.open) dlg.close();
  }, DIALOG_EXIT_MS);
}
function dialogKeep(dlg) {
  if (!dlg || !dlg._closeT) return;
  clearTimeout(dlg._closeT);
  dlg._closeT = 0;
  dlg.classList.remove('is-closing');
}
function setLifecycleStatus(text, isError) {
  var el = document.getElementById('lifecycle-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', !!isError);
}
var LIFECYCLE_LABELS = {
  sleepAfterHours: 'Sleeping 전환', archiveAfterDays: 'Archive 전환', boardArchiveWindowHours: 'Archive 표시 기간',
  sleepAfterMs: 'Sleeping 전환', archiveAfterMs: 'Archive 전환', boardArchiveWindowMs: 'Archive 표시 기간',
};
async function saveLifecycle(ev) {
  if (ev) ev.preventDefault();
  var form = {};
  for (var i = 0; i < LIFECYCLE_FIELDS.length; i++) {
    var input = document.getElementById('lc-' + LIFECYCLE_FIELDS[i][0]);
    form[LIFECYCLE_FIELDS[i][0]] = input ? input.value : '';
  }
  var parsed = lifecycleFromForm(form);
  if (!parsed.ok) { setLifecycleStatus(LIFECYCLE_LABELS[parsed.field] + ': 0 이상의 숫자를 입력하세요.', true); return; }
  // Send only what the admin changed: the dialog shows rounded values, and
  // re-saving an untouched field must not rewrite it.
  var shown = lifecycleToForm(_lifecycle || {});
  for (var j = 0; j < LIFECYCLE_FIELDS.length; j++) {
    if (Number(form[LIFECYCLE_FIELDS[j][0]]) === shown[LIFECYCLE_FIELDS[j][0]]) delete parsed.patch[LIFECYCLE_FIELDS[j][1]];
  }
  if (Object.keys(parsed.patch).length === 0) { closeLifecycleDialog(); return; }
  // The server answers 409 with counts when the change would sleep or end live
  // sessions. The dialog shows them and arms the Save button; saving the same
  // values again sends ?confirm=1. Any edit disarms it.
  var body = JSON.stringify(parsed.patch);
  var force = _lifecycleArmed === body;
  setLifecycleStatus('저장 중…', false);
  try {
    var send = function() {
      var headers = { 'Content-Type': 'application/json' };
      if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
      var url = '/api/dashboard/lifecycle' + (force ? '?confirm=1' : '');
      return fetch(url, { method: 'PUT', headers: headers, body: body });
    };
    var res = await send();
    if (res.status === 403 && !_isAdminModeOn()) {
      setLifecycleStatus('Admin 모드를 ON으로 바꾼 뒤 저장하세요.', true);
      return;
    }
    if (res.status === 403) { await refreshCsrfToken(); res = await send(); }
    var data = await res.json().catch(function() { return {}; });
    if (res.status === 409 && data && data.needsConfirm) {
      armLifecycleSave(body);
      setLifecycleStatus('이 값으로 저장하면 다음 정리 주기에 ' + (data.willSleep || 0) + '개 세션이 Sleeping으로, '
        + (data.willArchive || 0) + '개 세션이 종료(Archive)됩니다. 종료는 되돌릴 수 없습니다. 그래도 저장하려면 한 번 더 누르세요.', true);
      return;
    }
    armLifecycleSave(null);
    if (!res.ok) {
      var why = data && data.field ? LIFECYCLE_LABELS[data.field] + ' 값이 허용 범위를 벗어났습니다.' : (data && data.error) || ('저장 실패 (' + res.status + ')');
      setLifecycleStatus(why, true);
      return;
    }
    _lifecycle = data.lifecycle;
    closeLifecycleDialog();
    loadSessions();
  } catch (e) {
    setLifecycleStatus('저장 실패: 네트워크 오류', true);
  }
}

// Deep link (§3.1-8): /dashboard/<ownerId>?session=<sessionKey> opens that card
// and the panel at its work log once the board has data. Slack links carry the
// registry key WITHOUT the #814 instance prefix ("work:C123:1700000000.000100"),
// while board cards are keyed "<instanceName>::work:C123:…" (composeSessionKey).
// Until a card matches (board still loading, sibling instance), retry on each
// board render for ~10 s, then give up silently.
var DEEP_LINK_WINDOW_MS = 10000;
var _deepLinkSession = (function() {
  try { return new URLSearchParams(location.search).get('session'); } catch (_e) { return null; }
})();
var _deepLinkDeadline = Date.now() + DEEP_LINK_WINDOW_MS;
// Pure: which board key does a ?session= value point at? Exact key first, then
// this instance's prefixed key, then the one card whose key ends in "::<ref>".
// Ambiguous suffix matches (same thread on two siblings) resolve to nothing.
function resolveDeepLinkKey(ref, keys, selfInstance) {
  if (!ref) return null;
  if (keys.indexOf(ref) >= 0) return ref;
  if (selfInstance && keys.indexOf(selfInstance + '::' + ref) >= 0) return selfInstance + '::' + ref;
  var suffix = '::' + ref;
  var hits = keys.filter(function(k) { return k.length > suffix.length && k.slice(-suffix.length) === suffix; });
  if (hits.length) return hits.length === 1 ? hits[0] : null;
  // No live card: the thread's latest archive. archivedToKanban keys it
  // "[<instance>::]archived_<registry key>_<archivedAt ms>".
  var mark = 'archived_' + ref + '_';
  var best = null;
  var bestAt = -1;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var at = k.indexOf(mark);
    if (at < 0 || (at > 0 && k.slice(at - 2, at) !== '::')) continue;
    var tail = k.slice(at + mark.length);
    if (!/^[0-9]+$/.test(tail)) continue;
    if (Number(tail) > bestAt) { bestAt = Number(tail); best = k; }
  }
  return best;
}
var _deepLinkWaiting = false; // waiting for <ui-agent-inbox> to be defined
function openDeepLinkedSession() {
  if (!_deepLinkSession) return;
  // The window bounds the whole attempt: a card that first shows up on a
  // later poll (30 s) must not pop the panel open long after page load.
  if (Date.now() > _deepLinkDeadline) { _deepLinkSession = null; return; }
  var key = resolveDeepLinkKey(_deepLinkSession, Object.keys(_sessionCache), SELF_INSTANCE_NAME);
  if (!key) return;
  var host = _cardHost[key];
  if (!host) {
    var linked = _sessionCache[key];
    // An older run of a cron job (the CRON lane shows one card per job): show
    // that run as the job's card and retry on that render.
    if (linked && linked.cronJob && linked.cronJob.name && _cronRevealKey !== key) {
      _cronRevealKey = key;
      // A folded lane holds no card of a job that is not waiting: open it for this
      // page load (the saved choice stays as it is).
      _cronLaneRevealed = true;
      applySectionState();
      renderBoard(_lastBoardData);
      return;
    }
    // A card hidden by the Archives / Sleeping toggle (any age): show just this
    // card for this page load — the stored choice stays as it is — and retry on
    // that render.
    var hiddenByToggle = linked && (linked.terminated === true ? !showArchives : !showSleeping);
    if (hiddenByToggle && _revealedKey !== key) {
      _revealedKey = key;
      loadSessions();
      return;
    }
    _deepLinkSession = null;
    return;
  }
  // The element's module can land after the first board answer: retry once it is defined.
  if (typeof host.reveal !== 'function') {
    if (!_deepLinkWaiting && window.customElements) {
      _deepLinkWaiting = true;
      customElements.whenDefined('ui-agent-inbox').then(function() { _deepLinkWaiting = false; openDeepLinkedSession(); });
    }
    return;
  }
  _deepLinkSession = null;
  // The revealed older cron run only had to be on screen for the link.
  _cronRevealKey = null;
  // On its element — in a closed DONE day too (T12): the day opens, the card
  // opens without a transition and scrolls to the centre — and its detail card
  // with it (ui-toggle → openPanel); a card already open lands on Chat too (T6).
  host.reveal(key);
  if (!panelOpen || panelSessionKey !== key) openPanel(key);
}

// The poll returns this instance's board merged with sibling instances' (#814);
// a WS session_update carries only this instance's. Keep the last polled board
// so a push re-attaches the sibling cards instead of animating them out.
var _lastPolledBoard = null;
function mergeSiblingCards(board) {
  if (!_lastPolledBoard) return board;
  var out = {};
  ['working', 'waiting', 'idle', 'closed'].forEach(function(col) {
    var mine = board[col] || [];
    var have = new Set(mine.map(function(s) { return s.key; }));
    var sibs = (_lastPolledBoard[col] || []).filter(function(s) { return isSiblingSession(s) && !have.has(s.key); });
    // Same shape as the server merge: this instance's cards, then siblings'.
    out[col] = mine.concat(sibs);
  });
  return out;
}

// The board's first load (spec: no false empty board). 'loading' — skeleton
// cards, no counts, no "Nothing here" — until the first poll answer paints,
// then 'ready' for good: a background poll never brings the skeleton back.
// Only a poll answer certifies the board (it carries every instance's cards);
// a WebSocket push is this instance's cards only. A first load that fails is
// 'failed' — the skeleton stops and the board says so, with 다시 시도, until a
// poll succeeds (the 30 s poll keeps retrying either way).
var _boardLoad = 'loading';
function setBoardLoad(state) {
  if (_boardLoad === 'ready') return;
  _boardLoad = state;
  // The board element's load state (data.load): skeletons and aria-busy while
  // loading; no counts, hints or announcement until a certified paint says ready.
  var kb = document.getElementById('kanban');
  if (kb && kb._ibPlan && kb._ibPlan.load !== 'ready') {
    kb._ibPlan.load = state;
    inboxPaint(kb);
  }
  var err = document.getElementById('board-error');
  if (err) err.hidden = state !== 'failed';
}
function retryBoardLoad() {
  setBoardLoad('loading');
  loadSessions();
}
// A WebSocket push carries this instance's cards only; before a poll answer
// there are no sibling cards to merge in, so a push while loading is held for
// the user it was filtered for — and painted, as partial data under the error,
// if that load fails. After a failed load pushes paint (the error stays).
var _heldWsBoard = null;
function paintPushedBoard(board) {
  if (_boardLoad === 'loading') { _heldWsBoard = { user: currentUserId, board: board }; return false; }
  renderBoard(mergeSiblingCards(board));
  return true;
}

// Until the board is certified a request that never answers would keep the
// skeleton up: it is cut off after BOARD_LOAD_TIMEOUT_MS (shorter than the 30 s
// poll) and ends in 다시 시도. The deadline is for the answer, not the transfer —
// a large board on a slow link still arrives. Certified, polls run unbounded.
var BOARD_LOAD_TIMEOUT_MS = 20000;
// Before certification there is one load waiting for its answer at a time. The
// same user's next ask (task_update, toggles, the 30 s poll, 다시 시도) joins it:
// killing it would restart the clock on a busy board, and a second request would
// pay a second sibling fan-out. A user switch aborts it — its answer would be
// dropped, and its abort is not a failure of whatever load comes next. Once the
// answer's headers are in the slot is free: a body that stalls never swallows
// the next ask.
var _sessionsInflight = null; // { user, ctl, done, settle, superseded }
async function loadSessions() {
  if (_sessionsInflight) {
    if (_sessionsInflight.user === currentUserId) return _sessionsInflight.done;
    _sessionsInflight.superseded = true;
    _sessionsInflight.ctl.abort();
    _sessionsInflight = null;
  }
  // An answer for a user no longer selected paints nothing and flags nothing.
  // Certified, same-user loads never cancel each other: a slow poll still paints.
  var forUser = currentUserId;
  var entry = null;
  var timer = 0;
  if (_boardLoad !== 'ready' && typeof AbortController === 'function') {
    entry = { user: forUser, ctl: new AbortController() };
    entry.done = new Promise(function(r) { entry.settle = r; });
    _sessionsInflight = entry;
    timer = setTimeout(function() { entry.ctl.abort(); }, BOARD_LOAD_TIMEOUT_MS);
  }
  try {
    const url = '/api/dashboard/sessions' + (currentUserId ? '?userId=' + currentUserId : '');
    const res = await fetch(url, entry ? { signal: entry.ctl.signal } : {});
    clearTimeout(timer);
    if (entry && _sessionsInflight === entry) _sessionsInflight = null; // answered: the next ask is a new request
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (forUser !== currentUserId) return;
    _heldWsBoard = null;
    _lastPolledBoard = data.board;
    if (data.lifecycle) _lifecycle = data.lifecycle;
    renderBoard(data.board, false);
    setBoardLoad('ready');
    if (panelOpen && panelSessionKey && _sessionCache[panelSessionKey]) {
      // Without the WebSocket (or for a sibling instance) the poll is the only
      // update: the whole panel follows it (spec 13).
      repaintPanelSession();
    }
  } catch (e) {
    clearTimeout(timer);
    if ((entry && entry.superseded) || forUser !== currentUserId) return;
    console.error('Failed to load sessions', e);
    var held = _boardLoad === 'loading' && _heldWsBoard && _heldWsBoard.user === forUser ? _heldWsBoard.board : null;
    _heldWsBoard = null;
    setBoardLoad('failed'); // a no-op once the board has painted: it stays as it is
    // This instance's cards are better than none — shown under the error, which
    // stays: they are not the whole board (painted as partial: no counts, no
    // "Nothing here", not announced).
    if (held) renderBoard(held);
  } finally {
    if (entry) {
      if (_sessionsInflight === entry) _sessionsInflight = null;
      entry.settle();
    }
  }
}

// ── Action handler (with CSRF retry on 403 after JWT rotation) ──
async function doAction(key, action) {
  if (isBusy(key, 'action')) return; // Stop / Close / Trash once, from either surface
  setBusy(key, 'action', true);
  refreshCard(key);
  if (panelOpen && panelSessionKey === key) renderPanelHead();
  try {
    const headers = {};
    if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
    const url = '/api/dashboard/session/' + encodeURIComponent(key) + '/' + action;
    let res = await fetch(url, { method: 'POST', headers });
    if (res.status === 403) {
      await refreshCsrfToken();
      const retryHeaders = {};
      if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
      res = await fetch(url, { method: 'POST', headers: retryHeaders });
    }
    var title = (_sessionCache[key] && _sessionCache[key].title) || '';
    if (res.ok) dashToast({ title: DA_DONE[action] || '완료했어요', description: title || undefined, tone: 'success' });
    else {
      console.error('Action failed', action, key);
      dashToast(
        { title: (DA_LABEL[action] || action) + ' 실패', description: 'HTTP ' + res.status + (title ? ' · ' + title : ''), tone: 'error', action: { id: 'retry' } },
        function() { doAction(key, action); },
      );
    }
  } catch (e) {
    console.error('Action error', e);
    dashToast(
      { title: (DA_LABEL[action] || action) + ' 실패', description: '네트워크 오류', tone: 'error', action: { id: 'retry' } },
      function() { doAction(key, action); },
    );
  }
  setBusy(key, 'action', false);
  refreshCard(key);
  if (panelOpen && panelSessionKey === key) renderPanelHead();
  loadSessions();
}

// ── Task star + revive (SSOT 2026-10-30) ──
// ★ Star pins a session on top and keeps it alive (starring a sleeping or
// archived card brings it back first); 살리기 wakes a sleeping card or restores
// an archived one so its conversation continues. The answer names the live
// key: an archived card comes back under another key, and the page follows it.
function doStar(key, starred) {
  return doLifeAction(key, '/star', { starred: !!starred },
    starred ? '별을 달았어요 — 항상 맨 위, 자동 sleep·보관 안 함' : '별을 뗐어요', starred ? '별 달기' : '별 떼기');
}
function doRevive(key) {
  return doLifeAction(key, '/revive', {}, '세션을 살렸어요 — 이어서 대화할 수 있어요', '살리기');
}
async function doLifeAction(key, path, payload, doneTitle, label) {
  if (isBusy(key, 'life')) return; // one star / revive at a time, from either surface
  setBusy(key, 'life', true);
  refreshCard(key);
  if (panelOpen && panelSessionKey === key) renderPanelHead();
  var title = (_sessionCache[key] && _sessionCache[key].title) || '';
  var body = null;
  var retry = function() { doLifeAction(key, path, payload, doneTitle, label); };
  try {
    var url = '/api/dashboard/session/' + encodeURIComponent(key) + path;
    var send = function() {
      var headers = { 'Content-Type': 'application/json' };
      if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
      return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload) });
    };
    var res = await send();
    if (res.status === 403) {
      await refreshCsrfToken();
      res = await send();
    }
    var answer = await res.json().catch(function() { return null; });
    if (res.ok && answer && answer.ok) {
      body = answer;
      // Its work directory was removed when it went to sleep: the conversation comes back, the files do not.
      var note = answer.revived ? '작업 폴더 파일은 복구되지 않아요' : '';
      dashToast({ title: doneTitle, description: [note, title].filter(Boolean).join(' · ') || undefined, tone: 'success' });
    } else {
      // A refusal (no transcript, another conversation in the thread…) says why; only a failure is retried.
      dashToast(
        { title: label + ' 실패', description: (answer && answer.error) || ('HTTP ' + res.status), tone: 'error', action: res.status >= 500 ? { id: 'retry' } : undefined },
        res.status >= 500 ? retry : undefined,
      );
    }
  } catch (e) {
    console.error('Lifecycle action error', e);
    dashToast({ title: label + ' 실패', description: '네트워크 오류', tone: 'error', action: { id: 'retry' } }, retry);
  }
  setBusy(key, 'life', false);
  // An open card follows its session to the live key before the board paints it.
  if (body && body.key && body.key !== key && _expanded.has(key)) {
    _expanded.delete(key);
    _expanded.add(body.key);
  }
  refreshCard(key);
  if (panelOpen && panelSessionKey === key) renderPanelHead();
  await loadSessions();
  if (body && body.key) followSessionKey(key, body.key);
}
// An archived card that came back is a live session under another key: its
// detail card follows it, and the archived key leaves the deck.
function followSessionKey(oldKey, newKey) {
  if (!newKey || newKey === oldKey || !_sessionCache[newKey]) return;
  var showing = panelOpen && panelSessionKey === oldKey;
  deckRemove(oldKey);
  if (showing) openPanel(newKey, false);
}

// ── 여러 질문 — @2lab.ai/ui <ui-choice-form> (D3 E-15/E-16) ──
// The panel's multi-question form (UIAskUserQuestion with several questions) is
// the library element: numbered question cards (title, markdown context, the
// choices with the recommended one first and tagged 추천, an own answer), the
// progress dots, 추천대로 모두 제출, 초기화 and one ink 제출. A pick folds the card
// into the answer (+ 변경) and moves to the next open question; digits pick.
// The page keeps, per session (_mcState[key]): the working answers the element
// reports (ui-change — they seed a redrawn form: the panel switching sessions
// and back), and the send: sending → the element's submitting, a refusal →
// its error line, success → its read-only summary until the push that clears
// the question. Same routes: /answer-multi-choice (selections by question id;
// an own answer is the 직접입력 choice with its text) and the one-click
// /submit-recommended.
var _mcState = Object.create(null);
var MC_CUSTOM_ID = '\\uC9C1\\uC811\\uC785\\uB825';
// The form's identity: a different question (or another session) starts clean.
function mcFormId(s, q) {
  return 'mc|' + s.key + '|' + JSON.stringify([q.title || q.question || '', (q.questions || []).map(function(x) { return [x.id, x.question]; })]);
}
// The session's form state, reset when its question is another one.
function mcStateOf(s, q) {
  var id = mcFormId(s, q);
  var st = _mcState[s.key];
  if (!st || st.id !== id) st = _mcState[s.key] = { id: id, answers: {} };
  return st;
}
// pendingQuestion (user_choices) → the element's data. A choice reads as its
// label (the recommended marker stripped) — the element numbers the choices
// itself, in the order it shows them (the recommended one first), so the id's
// "N. " would contradict its key badge; the recommendation is the explicit id,
// else the legacy "(Recommended)" label — never the 직접입력 sentinel. Every
// question takes an own answer, as before.
function mcFormData(s, q) {
  var st = mcStateOf(s, q);
  var d = {
    id: st.id,
    title: String(q.title || q.question || '\\uBCF5\\uC218 \\uC9C8\\uBB38'),
    questions: (q.questions || []).map(function(item) {
      var rec = resolveRecommendedId(item.recommendedChoiceId, item.choices);
      if (rec === MC_CUSTOM_ID) rec = null;
      var out = {
        id: String(item.id),
        title: String(item.question || ''),
        choices: (item.choices || []).map(function(c) {
          var o = { id: String(c.id), label: stripRecommendedMarker(c.label) };
          if (c.description) o.description = String(c.description);
          if (rec && c.id === rec) o.recommended = true;
          return o;
        }),
        allowCustom: true,
        customPlaceholder: STRINGS.mcCustomPlaceholder,
      };
      if (item.context) out.context = String(item.context);
      return out;
    }),
    answers: st.answers,
    // Several questions: 제출 sends (a pick never does).
    submitOnPick: false,
  };
  if (q.description) d.description = String(q.description);
  if (st.sending) d.submitting = true;
  if (st.sent) d.submitted = true;
  if (st.error) d.error = st.error;
  return d;
}
// A push: the form state of every session that no longer asks that form goes
// (answered, cleared, or another question in its place).
function mcEvict() {
  for (var key in _mcState) {
    var s = _sessionCache[key];
    var q = s && s.pendingQuestion;
    if (!q || q.type !== 'user_choices' || !q.questions || _mcState[key].id !== mcFormId(s, q)) delete _mcState[key];
  }
}
// The answers as the element reports them → the seed it is handed back.
function mcAnswersIn(list) {
  var out = {};
  (list || []).forEach(function(a) {
    if (!a || !a.questionId) return;
    out[a.questionId] = a.choiceId !== undefined ? { choiceId: String(a.choiceId) } : { custom: String(a.custom || a.label || '') };
  });
  return out;
}
// The answers as the route takes them: by question id, the choice and its label
// (the recommended marker stripped), an own answer as 직접입력 + its text.
function mcSelectionsOf(s, list) {
  var q = s && s.pendingQuestion;
  var byQ = Object.create(null);
  ((q && q.questions) || []).forEach(function(x) { byQ[x.id] = x; });
  var out = {};
  (list || []).forEach(function(a) {
    if (!a || !a.questionId) return;
    if (a.choiceId === undefined) {
      out[a.questionId] = { choiceId: MC_CUSTOM_ID, label: String(a.custom || a.label || '') };
      return;
    }
    var item = byQ[a.questionId];
    var ch = item && (item.choices || []).find(function(c) { return String(c.id) === String(a.choiceId); });
    out[a.questionId] = { choiceId: String(a.choiceId), label: ch ? stripRecommendedMarker(ch.label) : String(a.label || '') };
  });
  return out;
}

// faceSummary: the collapsed card's summary line — when it already reads the
// form's title, the open card does not repeat it. 답변하기 opens the panel on
// the form (the card's one primary for its owner on this instance).
function renderMultiChoiceCard(s, faceSummary) {
  var q = s.pendingQuestion;
  if (!q || !q.questions) {
    console.warn('renderMultiChoiceCard: missing questions data for session', s.key);
    return '<div class="card-question"><div class="card-question-text card-question-na">' + STRINGS.mcUnavailable + '</div></div>';
  }
  var total = q.questions.length;
  var st = _mcState[s.key];
  var answers = st && st.id === mcFormId(s, q) ? st.answers : {};
  var answered = 0;
  for (var i = 0; i < total; i++) {
    if (answers[q.questions[i].id]) answered++;
  }
  var progressText = answered + '/' + total + ' \\uC644\\uB8CC';
  var primary = s.ownerId && s.ownerId === currentUserId && !isSiblingSession(s);
  return '<div class="card-question">'
    + ((q.title || q.question) && (q.title || q.question) === faceSummary ? '' : '<div class="card-question-text">' + esc(q.title || q.question || '\\uBCF5\\uC218 \\uC9C8\\uBB38') + '</div>')
    + '<div class="card-question-multi">' + total + '\\uAC1C \\uC9C8\\uBB38 \\u00B7 ' + progressText + '</div>'
    + '<button type="button" class="ui-btn' + (primary ? ' is-primary' : '') + ' card-mc-go" onclick="event.stopPropagation();openPanel(\\'' + escJs(s.key) + '\\')">\\uB2F5\\uBCC0\\uD558\\uAE30</button>'
    + '</div>';
}

// The form in the panel's 입력 필요: one <ui-choice-form> (created once per
// question, handed data only when it changed — the element morphs in place, so
// focus stays where it is).
function renderMultiChoicePanel(s) {
  var container = document.getElementById('panel-question');
  if (!container) return;
  var q = s.pendingQuestion;
  container.style.display = '';
  if (!q || !q.questions) {
    console.warn('renderMultiChoicePanel: missing questions data for session', s.key);
    container.innerHTML = '<p class="mc-failed" role="alert">' + STRINGS.mcLoadFailed + '</p>';
    return;
  }
  var el = container.firstElementChild;
  if (!el || el.tagName !== 'UI-CHOICE-FORM') {
    container.innerHTML = '';
    el = document.createElement('ui-choice-form');
    el.className = 'mc-form';
    el.setAttribute('lang', 'ko');
    container.appendChild(el);
  }
  el.setAttribute('data-mc-key', s.key);
  var d = mcFormData(s, q);
  var sig = JSON.stringify(d);
  if (el._mcSig !== sig) {
    el._mcSig = sig;
    el.data = d;
  }
}
// The form of session key, when the panel shows it.
function mcFormEl(key) {
  var c = document.getElementById('panel-question');
  var el = c && c.firstElementChild;
  return el && el.tagName === 'UI-CHOICE-FORM' && el.getAttribute('data-mc-key') === key ? el : null;
}
// After a send changed the state: the form shows it — or, with the panel on
// something else, a refusal is a toast.
function mcSettle(key, err) {
  var s = _sessionCache[key];
  if (s && mcFormEl(key)) renderMultiChoicePanel(s);
  else if (err) dashToast({ title: '\\uC81C\\uCD9C \\uC2E4\\uD328: ' + err, tone: 'error' });
}

// The element's answers: the working ones kept (ui-change), a send (ui-submit —
// not cancelled: the element locks until the page hands it the outcome).
document.addEventListener('ui-change', function(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-CHOICE-FORM' || !e.detail) return;
  var s = _sessionCache[el.getAttribute('data-mc-key')];
  var q = s && s.pendingQuestion;
  if (!q || !q.questions) return;
  mcStateOf(s, q).answers = mcAnswersIn(e.detail.answers);
  refreshCard(s.key);
});
document.addEventListener('ui-submit', function(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-CHOICE-FORM' || !e.detail) return;
  var key = el.getAttribute('data-mc-key');
  var s = _sessionCache[key];
  var q = s && s.pendingQuestion;
  if (!q || !q.questions) {
    e.preventDefault();
    return;
  }
  var list = e.detail.answers || [];
  var st = mcStateOf(s, q);
  st.answers = mcAnswersIn(list);
  // 추천대로 모두 제출 where every answer is the recommended one: the server's
  // one-click path (it derives the same answers). The person's own picks kept
  // by the hero are a form submit.
  var allRec = e.detail.source === 'recommended' && list.length === q.questions.length
    && list.every(function(a) { return a.recommended === true; });
  if (allRec) submitAllRecommended(key);
  else submitMultiChoice(key, mcSelectionsOf(s, list));
});

// The POST with the page's CSRF retry: one refresh and one retry after a 403
// (a rotated token). A body-less POST sends no Content-Type (Fastify refuses a
// JSON Content-Type with an empty body: 400). Resolves to the error text, or ''.
async function mcPost(url, body) {
  function headers() {
    var h = body === undefined ? {} : { 'Content-Type': 'application/json' };
    if (_csrfToken) h['X-CSRF-Token'] = _csrfToken;
    return h;
  }
  try {
    var init = { method: 'POST', headers: headers() };
    if (body !== undefined) init.body = body;
    var res = await fetch(url, init);
    if (res.status === 403) {
      await refreshCsrfToken();
      init = { method: 'POST', headers: headers() };
      if (body !== undefined) init.body = body;
      res = await fetch(url, init);
    }
    if (res.ok) return '';
    var errData = {};
    try { errData = await res.json(); } catch (_) {}
    return String(errData.error || ('Failed (status ' + res.status + ')'));
  } catch (e) {
    console.error('multi-choice answer error', e);
    return '\\uB124\\uD2B8\\uC6CC\\uD06C \\uC624\\uB958: ' + (e && e.message ? e.message : e);
  }
}
// One send of session key's form: sending while the request is out, then the
// summary (the push clears the question) or the refusal on the form.
async function mcSend(key, url, body) {
  var s = _sessionCache[key];
  var q = s && s.pendingQuestion;
  var st = q && q.questions ? mcStateOf(s, q) : null;
  if (st) {
    if (st.sending || st.sent) return;
    st.sending = true;
    st.error = '';
    mcSettle(key, '');
  }
  var err = await mcPost(url, body);
  if (st && _mcState[key] === st) {
    st.sending = false;
    if (err) st.error = err;
    else st.sent = true;
  }
  mcSettle(key, err);
}
// 제출: every selection (by question id) — the element's, else the ones kept.
function submitMultiChoice(key, selections) {
  var s = _sessionCache[key];
  if (!s || !s.pendingQuestion || !s.pendingQuestion.questions) {
    console.warn('submitMultiChoice: session data unavailable', key);
    dashToast({ title: '\\uC138\\uC158 \\uB370\\uC774\\uD130\\uB97C \\uBD88\\uB7EC\\uC62C \\uC218 \\uC5C6\\uC2B5\\uB2C8\\uB2E4. \\uD398\\uC774\\uC9C0\\uB97C \\uC0C8\\uB85C\\uACE0\\uCE68\\uD574\\uC8FC\\uC138\\uC694.', tone: 'error' });
    return Promise.resolve();
  }
  var sel = selections || {};
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/answer-multi-choice';
  return mcSend(key, url, JSON.stringify({ selections: sel }));
}
// 추천대로 모두 제출 (group-only one-click): the server derives the selections
// from the session, so the request has no body.
function submitAllRecommended(key) {
  return mcSend(key, '/api/dashboard/session/' + encodeURIComponent(key) + '/submit-recommended', undefined);
}

// ── Stats ──
// Every number follows the selected period, for the selected user or — with
// no user (All Users) — for everyone: /api/dashboard/stats gives sessions,
// turns, PRs, merge lines, workflows and the charts; /api/dashboard/usage gives
// tokens (input + output) and cost. Each load takes a generation and paints
// only while it is still the latest, so an answer for a period or user that
// was since replaced is dropped (fast clicks end on the last selection).
var _statsGen = 0;
async function loadStats() {
  var gen = ++_statsGen;
  var q = 'period=' + encodeURIComponent(currentPeriod) + (currentUserId ? '&userId=' + encodeURIComponent(currentUserId) : '');
  updateTokenBreakdown();
  // A bar where each number will be — not the last period's (or user's) number
  // under the new selection while the answer is in flight (month: seconds).
  markStatsLoading();
  await Promise.all([
    statsJson('/api/dashboard/stats?' + q).then(
      function(data) { if (gen === _statsGen) paintStats(data); },
      function(e) { if (gen === _statsGen) { console.error('Failed to load stats', e); paintStats(null); } }
    ),
    statsJson('/api/dashboard/usage?' + q).then(
      function(report) { if (gen === _statsGen) paintUsage(report); },
      function(e) { if (gen === _statsGen) { console.error('Failed to load usage', e); paintUsage(null); } }
    ),
  ]);
}

function statsJson(url) {
  return fetch(url).then(function(res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

var STAT_IDS = ['stat-sessions', 'stat-tokens', 'stat-cost', 'stat-turns', 'stat-prs', 'stat-merged', 'stat-merge-lines', 'stat-workflows'];
function markStatsLoading() {
  STAT_IDS.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    stopStatRoll(el);
    el.textContent = '';
    el.classList.remove('no-data');
    el.classList.add('is-loading');
  });
  var chart = document.getElementById('chart-row');
  if (chart) chart.classList.add('is-loading');
}

// A failed load shows a dash rather than the previous period's number.
// With a value and its format (the strip's 세션 · 토큰 · 비용 and the counted cards), the figure
// rolls from the one it showed to the new one — the library's rolling figure, 620ms ease-out quart.
// The first paint, a change from or to a dash and reduced motion jump; a new load stops a roll.
var STAT_ROLL_MS = 620;
function stopStatRoll(el) {
  if (el._roll) { cancelAnimationFrame(el._roll); el._roll = 0; }
}
function setStat(id, text, value, fmt) {
  var el = document.getElementById(id);
  if (!el) return;
  stopStatRoll(el);
  var from = el._shown;
  el._shown = typeof value === 'number' && isFinite(value) ? value : undefined;
  el.classList.remove('is-loading');
  el.classList.toggle('no-data', text === '\\u2014');
  if (!fmt || typeof from !== 'number' || el._shown === undefined || from === value || reduceMotion() || typeof requestAnimationFrame !== 'function') {
    el.textContent = text;
    return;
  }
  var t0 = 0;
  var step = function(now) {
    if (!t0) t0 = now;
    var p = Math.min(1, (now - t0) / STAT_ROLL_MS);
    var k = 1 - Math.pow(1 - p, 4);
    var v = from + (value - from) * k;
    el._shown = p < 1 ? v : value;
    el.textContent = p < 1 ? fmt(v) : text;
    el._roll = p < 1 ? requestAnimationFrame(step) : 0;
  };
  el.textContent = fmt(from);
  el._roll = requestAnimationFrame(step);
}
function fmtCount(n) { return String(Math.round(n)); }
function fmtUsd(n) { return '$' + toNum(n).toFixed(2); }

function paintStats(data) {
  var t = data && data.totals;
  var dash = '\\u2014';
  setStat('stat-sessions', t ? String(toNum(t.sessionsCreated)) : dash, t ? toNum(t.sessionsCreated) : null, fmtCount);
  setStat('stat-turns', t ? String(toNum(t.turnsUsed)) : dash, t ? toNum(t.turnsUsed) : null, fmtCount);
  setStat('stat-prs', t ? String(toNum(t.prsCreated)) : dash, t ? toNum(t.prsCreated) : null, fmtCount);
  setStat('stat-merged', t ? String(toNum(t.prsMerged)) : dash, t ? toNum(t.prsMerged) : null, fmtCount);
  setStat('stat-commits-hidden', t ? String(toNum(t.commitsCreated)) : dash);
  setStat('stat-merge-lines', t ? '+' + toNum(t.mergeLinesAdded) + ' / -' + toNum(t.mergeLinesDeleted) : dash);
  var wfEntries = Object.entries((t && t.workflowCounts) || {}).sort(function(a, b) { return toNum(b[1]) - toNum(a[1]); });
  var wfEl = document.getElementById('stat-workflows');
  if (wfEl) {
    wfEl.classList.remove('is-loading');
    wfEl.innerHTML = wfEntries.length
      ? wfEntries.map(function(e) { return '<span style="display:inline-block;margin-right:8px;font-size:0.85em">' + esc(e[0]) + ': <b>' + toNum(e[1]) + '</b></span>'; }).join('')
      : '<span style="color:var(--text-secondary)">-</span>';
  }
  var chartEl = document.getElementById('chart-row');
  if (chartEl) chartEl.classList.remove('is-loading');
  if (data) renderCharts(Array.isArray(data.days) ? data.days : []);
  else if (chartEl) chartEl.innerHTML = '';
}

// ── Where the usage goes — @2lab.ai/ui <ui-compact-breakdown> (affectUI review batch 1) ──
// Spend or tokens by model for everyone; spend by user for an admin (the
// server sends per-user parts to admins only — usageForViewer).
var _usageView = 'cost';
var _usageReport = null;
var USAGE_VIEWS = [{ id: 'cost', label: '모델별 비용' }, { id: 'tokens', label: '모델별 토큰' }];
// Pure: the usage report → the card's data.
function usageBreakdownData(report, view, admin) {
  var options = admin ? USAGE_VIEWS.concat([{ id: 'user', label: '사용자별 비용' }]) : USAGE_VIEWS;
  if (view === 'user' && !admin) view = 'cost';
  var d = { title: '사용량', unit: view === 'tokens' ? 'tokens' : 'usd', options: options, value: view, optionsLabel: '보기', maxRows: 5, parts: [], emptyText: '이 기간에는 사용량이 없어요' };
  if (!report) {
    d.error = '사용량을 불러오지 못했어요';
    return d;
  }
  if (view === 'user') {
    var users = report.byUser || {};
    for (var uid in users) {
      if (!Object.prototype.hasOwnProperty.call(users, uid)) continue;
      d.parts.push({ key: uid, label: String((users[uid] && users[uid].userName) || uid), value: toNum(users[uid] && users[uid].totalCostUsd) });
    }
    return d;
  }
  var models = (report.totals && report.totals.byModel) || {};
  for (var m in models) {
    if (!Object.prototype.hasOwnProperty.call(models, m)) continue;
    var u = models[m] || {};
    d.parts.push({ key: m, label: m, value: view === 'tokens' ? toNum(u.inputTokens) + toNum(u.outputTokens) : toNum(u.costUsd) });
  }
  return d;
}
function paintUsageBreakdown() {
  var el = document.getElementById('usage-cb');
  if (!el) return;
  var d = usageBreakdownData(_usageReport, _usageView, !!_viewerIsAdmin);
  var sig = JSON.stringify(d);
  if (el._sig === sig) return;
  el._sig = sig;
  el.data = d;
}
document.addEventListener('ui-change', function(e) {
  if (!e.target || e.target.id !== 'usage-cb' || !e.detail) return;
  _usageView = String(e.detail.value);
  paintUsageBreakdown();
});

function paintUsage(report) {
  _usageReport = report || null;
  paintUsageBreakdown();
  var t = report && report.totals;
  var tok = t ? toNum(t.totalInputTokens) + toNum(t.totalOutputTokens) : null;
  setStat('stat-tokens', t ? formatTokens(tok) : '\\u2014', tok, formatTokens);
  setStat('stat-cost', t ? '$' + toNum(t.totalCostUsd).toFixed(2) : '\\u2014', t ? toNum(t.totalCostUsd) : null, fmtUsd);
}

function renderCharts(days) {
  const container = document.getElementById('chart-row');
  if (!days.length) {
    container.innerHTML = '<p style="color:var(--text-secondary)">No data for this period.</p>';
    return;
  }
  container.innerHTML = renderBarChart('&#xC138;&#xC158;', days, function(d) { return d.sessionsCreated; }, 'var(--accent)')
    + renderBarChart('&#xCF54;&#xB4DC; &#xBCC0;&#xACBD; (&#xBA38;&#xC9C0;)', days, function(d) { return d.mergeLinesAdded + d.mergeLinesDeleted; }, 'var(--green)');
}

function renderBarChart(title, days, valueFn, color) {
  const values = days.map(valueFn);
  const max = Math.max.apply(null, values.concat([1]));
  const bars = days.map(function(d, i) {
    const h = Math.max(2, (values[i] / max) * 100);
    const label = d.date.slice(5);
    return '<ui-tooltip text="' + escAttr(label + ': ' + values[i]) + '"><div class="bar" style="height:' + h + '%;background:' + color + '"></div></ui-tooltip>';
  }).join('');
  const labels = days.map(function(d) { return '<span>' + d.date.slice(8) + '</span>'; }).join('');
  return '<div class="chart-container"><h4>' + title + '</h4><div class="bar-chart">' + bars + '</div><div class="bar-labels">' + labels + '</div></div>';
}

// ── WebSocket ──
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws/dashboard');
  const statusEl = document.getElementById('ws-status');

  ws.onopen = function() {
    statusEl.dataset.state = 'live';
    statusEl.textContent = STRINGS.wsLive;
    statusEl.title = STRINGS.wsLiveLabel;
    statusEl.setAttribute('aria-label', STRINGS.wsLiveLabel);
    // Reconnect: recover the work-log entries broadcast while we were offline
    // (from the HTTP cursor; afterSeq=0 when the log was still empty).
    if (panelOpen && _wl) recoverWorkLog();
  };
  ws.onclose = function() {
    statusEl.dataset.state = 'reconnecting';
    statusEl.textContent = STRINGS.wsReconnecting;
    statusEl.title = STRINGS.wsReconnectingLabel;
    statusEl.setAttribute('aria-label', STRINGS.wsReconnectingLabel);
    setTimeout(connectWs, 3000);
  };
  ws.onerror = function() { ws.close(); };
  ws.onmessage = function(ev) {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'session_update') {
        if (currentUserId) {
          msg.board.working = (msg.board.working || []).filter(function(s) { return s.ownerId === currentUserId; });
          msg.board.waiting = (msg.board.waiting || []).filter(function(s) { return s.ownerId === currentUserId; });
          msg.board.idle = (msg.board.idle || []).filter(function(s) { return s.ownerId === currentUserId; });
          msg.board.closed = (msg.board.closed || []).filter(function(s) { return s.ownerId === currentUserId; });
        }
        if (!paintPushedBoard(msg.board)) return;
        // Refresh panel question if panel is open (session may have transitioned)
        if (panelOpen && panelSessionKey && _sessionCache[panelSessionKey]) {
          var panelS = _sessionCache[panelSessionKey];
          renderPanelPermission(panelS);
          renderPanelQuestion(panelS);
          // The board carries the server's one-current-task view; a turn that
          // just ended must stop spinning its task in the open panel too —
          // whichever node the panel shows (spec 12); the head chip, 세션 정보,
          // the goal and the model · effort follow the same push (spec 13).
          repaintPanelSession();
        }
        // A form whose session no longer asks it: its answers and outcome go.
        mcEvict();
      } else if (msg.type === 'task_update') {
        // Update cached session tasks and re-render
        if (_sessionCache[msg.sessionKey]) {
          _sessionCache[msg.sessionKey].tasks = msg.tasks;
          _sessionCache[msg.sessionKey].earlierTasks = msg.earlierTasks && msg.earlierTasks.length ? msg.earlierTasks : undefined;
          // SSOT 2026-10-29 T5: the work no task got rides with the list.
          if ('tasksOutside' in msg) _sessionCache[msg.sessionKey].tasksOutside = msg.tasksOutside || undefined;
        }
        loadSessions();
        // The panel repaints through the node it shows: the cache now holds the
        // main agent's new list, and a subagent's panel reads its own (spec 12).
        if (panelOpen && panelSessionKey === msg.sessionKey) repaintPanelSession();
      } else if (msg.type === 'conversation_update') {
        // A turn landed — an open card's 지시/응답 pair may be stale now.
        invalidateCardIo(msg.conversationId);
        umOnTurn(msg.conversationId, msg.turn);
        // If panel is open for this conversation, append or update the turn
        if (panelOpen && panelConvId === msg.conversationId && msg.turn) {
          // Dedupe: skip user turns that match our optimistic send (content + within 10s)
          if (msg.turn.role === 'user' && _lastSentContent && (Date.now() - _lastSentTime) < 10000
              && (msg.turn.rawContent || '').trim() === _lastSentContent.trim()) {
            _lastSentContent = '';
            _lastSentTime = 0;
            // The server's turn takes over the optimistic one, so a later push for
            // it (a /compact result, SSOT 2026-10-27) finds it by its real id.
            if (msg.turn.id) {
              var optId = '';
              for (var oi = _panelTurnsList.length - 1; oi >= 0 && !optId; oi--) {
                var ot = _panelTurnsList[oi];
                if (ot && ot._optimistic && String(ot.id || '').indexOf('optimistic-') === 0) optId = ot.id;
              }
              if (optId) appendTurnToPanel(msg.turn, false, optId);
            }
          } else {
            // A turn already held (a summary landing on its answer) is updated in
            // place in 지시와 답변's data; a new one goes at the end.
            appendTurnToPanel(msg.turn);
          }
        }
      } else if (msg.type === 'session_action') {
        // Immediate visual feedback already handled by loadSessions() in doAction
      } else if (msg.type === 'summaryTitleChanged') {
        // Dashboard v2.1 + #762 — targeted title patch. Server resolves the
        // displayHeadline through the full priority chain and sends both
        // values: summaryTitle is what gets cached, displayHeadline is what
        // the UI actually paints. Falls back to summaryTitle for backward
        // compat with payloads pre-#762.
        var cached = _sessionCache[msg.sessionKey];
        if (cached) {
          cached.summaryTitle = msg.summaryTitle;
          if (msg.displayHeadline) cached.displayHeadline = msg.displayHeadline;
        }
        var headline = msg.displayHeadline || msg.summaryTitle;
        // Re-render through the card patch path so the summary line (which
        // avoids repeating the headline) stays consistent with the title.
        refreshCard(msg.sessionKey);
        if (panelOpen && panelSessionKey === msg.sessionKey) {
          var pt = document.getElementById('panel-title');
          if (pt) pt.textContent = headline;
        }
      } else if (msg.type === 'sessionUpdated' && msg.session && msg.session.key) {
        // #762 — single-session card refresh from broadcastSingleSessionUpdate.
        // Patch just this card through the same keyed path as the board
        // reconciler so the link-derived title flow (which fires before the
        // next full board push) lands immediately without rebuilding the node
        // (an open card stays open). The column is the one the card is drawn in.
        var updatedKey = msg.session.key;
        _sessionCache[updatedKey] = msg.session;
        acEvict(updatedKey, msg.session);
        patchLastBoard(msg.session);
        if (_cardHost[updatedKey]) refreshCard(updatedKey);
        if (panelOpen && panelSessionKey === updatedKey) {
          renderPanelPermission(msg.session);
          var pt2 = document.getElementById('panel-title');
          if (pt2) pt2.textContent = msg.session.displayHeadline || msg.session.summaryTitle || msg.session.title || 'Untitled';
          // Spec 12: the agent tree moved (spawn, status, tool count, a node's tasks);
          // spec 13: the live numbers (tokens, cost, timer) move with every push.
          repaintPanelSession();
        }
      } else if (msg.type === 'artifact_update' && msg.conversationId) {
        // SSOT 2026-10-23 — a new file / markdown answer; the card face itself
        // follows through the sessionUpdated push the server sends with it.
        onArtifactUpdate(msg.conversationId, msg.artifact);
      } else if (msg.type === 'work_log' && msg.entry) {
        // .prd/10 §3.3 — live work-log entry. Append when its conversation is
        // open in the panel (seq-deduped against the initial fetch).
        if (panelOpen) pushLiveWorkLog(msg.conversationId, msg.entry);
        if (msg.entry.kind === 'instruction' || msg.entry.kind === 'final') invalidateCardIo(msg.conversationId);
      }
    } catch (e) { /* ignore */ }
  };
}

// ── Token breakdown by instance, from the session cache (#814) ──
function updateTokenBreakdown() {
  // #814 — group the board's session token usage by environment.instanceName
  // so the tokens tooltip can break down "instance-a: 12K | instance-b: 8K |
  // Total: 20K". The number itself is the period total from /api/dashboard/usage
  // (loadStats); this breakdown covers the sessions on the board, and says so.
  // Fallback bucket ('') is used for cards whose environment is missing
  // (legacy WS payloads, tests). When all cards share one env we suppress
  // the tooltip entirely — see _envCount() check below.
  var byEnv = Object.create(null);
  let totalTokens = 0;
  for (const key in _sessionCache) {
    const s = _sessionCache[key];
    if (currentUserId && s.ownerId !== currentUserId) continue;
    if (!s.tokenUsage) continue;
    var t = toNum(s.tokenUsage.totalInputTokens) + toNum(s.tokenUsage.totalOutputTokens);
    totalTokens += t;
    var envName = (s.environment && s.environment.instanceName) || '';
    if (!byEnv[envName]) byEnv[envName] = { tokens: 0 };
    byEnv[envName].tokens += t;
  }

  // Tooltip: only show when there's actually a breakdown (≥2 envs in
  // the cache). For the single-instance / empty-env case we leave the
  // tooltip dark so the topbar stays the same shape it was before #814.
  // Runs on every board render (renderBoard) and stats load — it writes only
  // what changed.
  // <ui-tooltip id="stat-tokens-tooltip"> (B-04): the page hands it the text; the figure is its trigger, a tab stop
  // only while there is something to describe.
  var tip = document.getElementById('stat-tokens-tooltip');
  var fig = document.getElementById('stat-tokens');
  var wrap = document.getElementById('stat-tokens-wrap');
  if (!tip || !fig || !wrap) return;
  var envNames = Object.keys(byEnv).filter(function(n) { return n.length > 0; });
  if (envNames.length < 2) {
    if (tip.getAttribute('text')) tip.removeAttribute('text');
    if (!tip.hasAttribute('disabled')) tip.setAttribute('disabled', '');
    if (fig.hasAttribute('tabindex')) fig.removeAttribute('tabindex');
    if (wrap.hasAttribute('data-has-breakdown')) wrap.removeAttribute('data-has-breakdown');
    return;
  }
  // Stable order: sort so the same env always renders in the same position.
  envNames.sort();
  var parts = [];
  for (var i = 0; i < envNames.length; i++) {
    var n = envNames[i];
    parts.push(n + ': ' + formatTokens(byEnv[n].tokens));
  }
  parts.push('Total: ' + formatTokens(totalTokens));
  // Plain text: the element never parses it as HTML.
  var text = '보드 세션 기준 · ' + parts.join(' · ');
  if (tip.getAttribute('text') !== text) tip.setAttribute('text', text);
  if (tip.hasAttribute('disabled')) tip.removeAttribute('disabled');
  if (fig.getAttribute('tabindex') !== '0') fig.setAttribute('tabindex', '0');
  if (!wrap.hasAttribute('data-has-breakdown')) wrap.setAttribute('data-has-breakdown', 'true');
}

// ── Panel work log (.prd/10 §3.1-7, §3.3) ──
// GET /api/dashboard/session/:conversationId/worklog → { entries, hasMore }:
// without afterSeq the LATEST page, with afterSeq=N (integer ≥ 0) the FIRST
// page after N — so afterSeq=0 is the oldest page and the initial load must
// omit it — and with beforeSeq=N the LAST page before N (the reader scrolling
// up; SSOT 2026-10-29). The panel loads the latest WL_PAGE entries and older
// pages only as the reader scrolls up (wlLoadOlderPage). Live entries arrive as WS { type: 'work_log', conversationId,
// entry } once the line is on disk. 403 = not the session owner (no retry),
// 404 = no log for this conversation.
// Entries merge by seq identity into one seq-ordered list, so a live entry that
// lands before the HTTP page never hides the older batch.
// Seqs only increase, but they are NOT contiguous: the store reserves them in
// blocks, so after a crash the next seq can jump (57 → 1001) and that hole is
// permanent. The cursor is therefore server-confirmed, not "no holes": every
// entry that exists up to the cursor is held. A page requested after seq c
// returns every existing entry > c (first page), so it confirms up to its last
// seq — and, when hasMore is false, up to every seq we held when the request
// went out (a live entry is on disk before it is broadcast). Live entries that
// directly follow the cursor advance it too. A live entry beyond cursor + 1 is
// a gap → backfill from the cursor; once the backfill is done the gap is closed
// even if nothing came back (the hole is permanent). A reconnect pages forward
// the same way (afterSeq=0 when the log was empty) while hasMore === true.
// A safety bound against a server that never stops saying hasMore — not a
// size limit: 2000 pages of 500 is a million entries (SSOT 2026-10-22 T9).
var WL_BACKFILL_MAX_PAGES = 2000;
// The latest window an opening loads, and each older page (SSOT 2026-10-29).
var WL_PAGE = 100;
var WL_LABELS = { instruction: '지시', narration: '', tool: '', tool_result: '', final: '응답', notice: '알림', error: '오류' };
var WL_EMPTY_MSG = '작업 로그 없음';
var _wlCardsWait = false;
var _wlDetailRev = 0;
var WL_FORBIDDEN_MSG = '작업 로그는 세션 소유자만 볼 수 있어요';
var WL_RAW_MISSING_MSG = '원본 출력이 저장되어 있지 않습니다';
var WL_RAW_ERROR_MSG = '원본 출력을 불러오지 못했어요';
var WL_RAW_DAMAGED_MSG = '로그가 손상되어 원본을 읽을 수 없습니다';
var _wl = null;  // work-log state of the conversation open in the panel
// Where an opening lands (spec 13): 'worklog' (작업 로그 / ?session=), 'answer',
// 'tasks', 'goal', 'agent', or '' (the default — a blocker, else the newest turns).
var _panelLand = '';
var _panelLanded = false; // a goal / agent landing is made once per opening
var _panelReturnFocus = null; // the control that opened the panel (focus goes back to it)

// ── Pure core (no DOM): state, merge, paging ──
function wlNewState(convId) {
  return {
    convId: convId, entries: [], seen: new Set(), cursor: 0, maxSeq: 0,
    loaded: false, latestOk: false, denied: false, closed: false,
    latest: null, recovering: null, againReconnect: false, againGap: false, painted: false,
  };
}
// afterSeq: null/undefined = latest window (no parameter); otherwise always a
// non-negative integer — the API answers 400 to anything else.
function wlUrl(convId, afterSeq) {
  var base = '/api/dashboard/session/' + encodeURIComponent(convId) + '/worklog';
  if (afterSeq === null || afterSeq === undefined) return base;
  var n = Math.max(0, Math.floor(Number(afterSeq) || 0));
  return base + '?afterSeq=' + n;
}
// The latest WL_PAGE entries; the WL_PAGE entries before seq beforeSeq.
function wlLatestUrl(convId) {
  return wlUrl(convId, null) + '?limit=' + WL_PAGE;
}
// offset: the previous page's byte cursor (nextBeforeOffset) — the scan resumes there.
function wlOlderUrl(convId, beforeSeq, offset) {
  var url = wlUrl(convId, null) + '?beforeSeq=' + Math.max(0, Math.floor(Number(beforeSeq) || 0)) + '&limit=' + WL_PAGE;
  var off = Math.floor(Number(offset) || 0);
  return off > 0 ? url + '&beforeOffset=' + off : url;
}
function wlValidSeq(seq) {
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0;
}
// Adds entries not seen before (by seq) and keeps state.entries sorted by seq.
// Returns the added entries in ascending seq order, each with its index in the
// merged list — inserting them in that order at that index reproduces the list.
function wlMerge(state, entries) {
  var fresh = [];
  var list = entries || [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || !wlValidSeq(e.seq) || state.seen.has(e.seq)) continue;
    state.seen.add(e.seq);
    if (e.seq > state.maxSeq) state.maxSeq = e.seq;
    fresh.push(e);
  }
  if (!fresh.length) return [];
  fresh.sort(function(a, b) { return a.seq - b.seq; });
  var old = state.entries;
  var merged = [];
  var added = [];
  var oi = 0;
  var fi = 0;
  while (oi < old.length || fi < fresh.length) {
    if (fi >= fresh.length || (oi < old.length && old[oi].seq < fresh[fi].seq)) {
      merged.push(old[oi++]);
    } else {
      added.push({ entry: fresh[fi], index: merged.length });
      merged.push(fresh[fi++]);
    }
  }
  state.entries = merged;
  return added;
}
function wlPageMaxSeq(entries) {
  var top = 0;
  var list = entries || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && wlValidSeq(list[i].seq) && list[i].seq > top) top = list[i].seq;
  }
  return top;
}
// Advance the cursor over every directly-following seq we hold.
function wlAdvance(state) {
  while (state.seen.has(state.cursor + 1)) state.cursor++;
}
// The server answered: every entry that exists up to seq upTo is now held.
function wlConfirm(state, upTo) {
  if (upTo > state.cursor) state.cursor = upTo;
  wlAdvance(state);
}
// 403 from any path (first load, latest retry, backfill page): stop for good
// and tell the UI once through state.onDenied (set by the DOM side).
function wlDeny(state) {
  if (state.denied) return;
  state.denied = true;
  if (state.onDenied && !state.closed) state.onDenied(state);
}
// A held entry beyond the contiguous cursor means something in between is missing.
function wlHasGap(state) {
  return state.loaded && !state.denied && !state.closed && state.maxSeq > state.cursor;
}
function wlStatusOf(err) {
  var status = err && err.status;
  if (status === 403) return 'denied';
  if (status === 404) return 'missing';
  return 'error';
}
// Initial load: the latest page (no afterSeq). Resolves 'ok' | 'denied' |
// 'missing' | 'error' | 'closed'. Early live entries beyond the page are a gap.
function wlLoadLatest(state, fetchJson, onAdded) {
  // The latest window holds the newest entries at request time — including
  // any live entry we already held — so it confirms up to both.
  var sentMax = state.maxSeq;
  state.latest = fetchJson(wlLatestUrl(state.convId)).then(function(data) {
    if (state.closed) return 'closed';
    var page = (data && data.entries) || [];
    var added = wlMerge(state, page);
    state.loaded = true;
    state.latestOk = true;
    // Entries older than this window exist: the reader scrolling up brings them in (wlLoadOlderPage).
    state.olderPending = !!(data && data.hasMore === true);
    wlConfirm(state, Math.max(wlPageMaxSeq(page), sentMax));
    if (added.length) onAdded(state, added);
    if (wlHasGap(state)) wlRecover(state, fetchJson, onAdded, 'gap');
    return 'ok';
  }, function(err) {
    if (state.closed) return 'closed';
    state.loaded = true;
    var status = wlStatusOf(err);
    if (status === 'denied') wlDeny(state);
    return status;
  });
  return state.latest;
}
// A live entry: merge it; one that skips past the cursor triggers a backfill.
function wlOnLive(state, entry, fetchJson, onAdded) {
  if (state.closed || state.denied) return [];
  var added = wlMerge(state, [entry]);
  if (!added.length) return added;
  if (state.loaded) wlAdvance(state);
  onAdded(state, added);
  if (wlHasGap(state)) wlRecover(state, fetchJson, onAdded, 'gap');
  return added;
}
// Recovery (reconnect or gap): after the initial load settles, page forward
// from the contiguous cursor while hasMore === true. Stops on a page that does
// not advance the cursor, after WL_BACKFILL_MAX_PAGES pages, on 403, or when
// the panel moved on. If the latest page itself never loaded, retry that instead.
// reason: 'reconnect' (default — the socket was down, anything may be missing)
// or 'gap' (a live entry skipped seqs). While a run is in flight, requests are
// coalesced: a reconnect always re-runs afterwards; a gap re-runs only if the
// in-flight run's confirmation did not already cover it.
function wlRecover(state, fetchJson, onAdded, reason) {
  if (state.closed || state.denied) return Promise.resolve(null);
  if (state.recovering) {
    if (reason === 'gap') state.againGap = true;
    else state.againReconnect = true;
    return state.recovering;
  }
  var pages = 0;
  function step() {
    if (state.closed || state.denied) return null;
    if (state.loaded && !state.latestOk) return wlLoadLatest(state, fetchJson, onAdded);
    var from = state.cursor;
    var sentMax = state.maxSeq; // every seq we hold now is on disk now
    pages++;
    return fetchJson(wlUrl(state.convId, from)).then(function(data) {
      if (state.closed) return null;
      var page = (data && data.entries) || [];
      var added = wlMerge(state, page);
      var more = !!(data && data.hasMore === true);
      // A full page confirms only up to its last seq; the last page confirms up
      // to everything that existed when it was requested — so a permanent hole
      // closes here instead of re-triggering a backfill on every live entry.
      wlConfirm(state, more ? wlPageMaxSeq(page) : Math.max(wlPageMaxSeq(page), sentMax));
      if (added.length) onAdded(state, added);
      if (more && state.cursor > from && pages < WL_BACKFILL_MAX_PAGES) return step();
      return null;
    }, function(err) {
      if (wlStatusOf(err) === 'denied') wlDeny(state);
      return null;
    });
  }
  var run = (state.latest || Promise.resolve()).then(step).then(null, function() { return null; }).then(function() {
    state.recovering = null;
    var reconnect = state.againReconnect;
    var gap = state.againGap && wlHasGap(state);
    state.againReconnect = false;
    state.againGap = false;
    if (state.closed) return null;
    if (reconnect) return wlRecover(state, fetchJson, onAdded);
    if (gap) return wlRecover(state, fetchJson, onAdded, 'gap');
    return null;
  });
  state.recovering = run;
  return run;
}

// The page before the oldest entry held (SSOT 2026-10-29) — the reader scrolling
// up, or a subagent's tab looking for the call that started it: GET
// …?beforeSeq=&limit=, merged by seq like every page. Older entries sit below the
// cursor, so the live / gap bookkeeping is untouched. One at a time (the promise
// is state.olderLoading); a failed page keeps olderPending (the control offers it
// again). A page that brings nothing older but says hasMore — the server's scan
// stopped at its byte budget inside a run of non-entry lines, not the start of the
// log — keeps it too. Its byte cursor (nextBeforeOffset, state.olderOffset) goes
// with the next ask so the scan resumes where it stopped; an empty page that did
// not move the cursor further back counts, and WL_OLDER_EMPTY_MAX of those in a
// row end the paging, so a server that keeps saying hasMore cannot spin it.
// Resolves 'ok' (entries came in), 'empty' (none: the next waits for the reader), 'error'.
var WL_OLDER_EMPTY_MAX = 3;
function wlLoadOlderPage(state, fetchJson, onAdded) {
  if (!state || state.closed || state.denied || !state.latestOk || !state.olderPending) return Promise.resolve(null);
  if (state.olderLoading) return state.olderLoading;
  var before = state.entries.length ? state.entries[0].seq : 0;
  if (!(before > 1)) {
    state.olderPending = false;
    return Promise.resolve(null);
  }
  var run = fetchJson(wlOlderUrl(state.convId, before, state.olderOffset)).then(function(data) {
    state.olderLoading = null;
    if (state.closed) return null;
    var page = (data && data.entries) || [];
    var older = page.filter(function(e) { return e && wlValidSeq(e.seq) && e.seq < before; });
    var added = wlMerge(state, older);
    var prev = state.olderOffset;
    var next = data && data.nextBeforeOffset;
    state.olderOffset = typeof next === 'number' && Number.isSafeInteger(next) && next > 0 ? next : undefined;
    var moved = !added.length && state.olderOffset !== undefined && (prev === undefined || state.olderOffset < prev);
    state.olderEmpty = added.length || moved ? 0 : (state.olderEmpty || 0) + 1;
    state.olderPending = !!(data && data.hasMore === true) && state.olderEmpty < WL_OLDER_EMPTY_MAX;
    if (!added.length) return 'empty';
    onAdded(state, added);
    return 'ok';
  }, function(err) {
    state.olderLoading = null;
    if (wlStatusOf(err) === 'denied') wlDeny(state);
    return 'error';
  });
  state.olderLoading = run;
  return run;
}
// A subagent's tab whose spawn call is older than the log window: page back for
// it — while older entries exist, the window has not reached back past the
// agent's start (its call cannot be older than that), and for at most
// WL_SEEK_MAX_PAGES pages per agent: one the bar does not know (a log-only
// agent has no start) would otherwise fetch the whole log looking for it.
var WL_SEEK_MAX_PAGES = 20;
function wlSeekAgentSpawn(state, a, agentId) {
  if (!state || !state.olderPending || state.olderLoading) return;
  var start = toNum(a && a.startedAt);
  var oldest = state.entries.length ? toNum(state.entries[0].ts) : 0;
  if (start && oldest && oldest < start - 60000) return;
  var seek = state.seek && state.seek.id === agentId ? state.seek : (state.seek = { id: agentId, pages: 0 });
  if (seek.pages >= WL_SEEK_MAX_PAGES) return;
  seek.pages++;
  loadOlderWorkLog();
}

// Raw output of one entry (§3.1-6). An entry with rawBytes has its full output
// stored: GET …/worklog/:seq/raw → { seq, raw, rawBytes, rawTruncated }, asked
// once per (panel state, seq) — the promise is kept on the state, and a new
// state (resetWorkLog) starts without it. 404 (not stored), 403 (owner only)
// and the server's 503 { error: 'unavailable' } (the log is damaged; the answer
// stays the same until it is repaired) settle for good. Everything else — a
// network failure, a 500 / 502, a 503 without that code (a proxy during a
// restart) — is not kept and offers 다시 시도.
function wlRawUrl(convId, seq) {
  return wlUrl(convId, null) + '/' + Math.max(0, Math.floor(Number(seq) || 0)) + '/raw';
}
function wlRawLoad(state, seq, fetchJson) {
  var cache = state.raw || (state.raw = Object.create(null));
  if (cache[seq]) return cache[seq];
  var p = fetchJson(wlRawUrl(state.convId, seq)).then(function(d) {
    return {
      status: 'ok',
      raw: d && typeof d.raw === 'string' ? d.raw : '',
      bytes: toNum(d && d.rawBytes),
      truncated: !!(d && d.rawTruncated === true),
    };
  }, function(err) {
    var status = err && err.status;
    if (status === 404) return { status: 'missing' };
    if (status === 403) return { status: 'denied' };
    if (status === 503 && err.code === 'unavailable') return { status: 'damaged' };
    if (cache[seq] === p) delete cache[seq];
    return { status: 'error', error: String((err && (err.message || err.name)) || 'Error') };
  });
  cache[seq] = p;
  return p;
}
function formatBytes(n) {
  n = Math.max(0, toNum(n));
  if (n < 1024) return Math.round(n) + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MiB';
  return (n / 1073741824).toFixed(1) + ' GiB';
}
// ── DOM side ──
// A failed answer rejects with err.status and err.code — the error string of a
// JSON error body ({ error: 'unavailable' }), or null for anything else (an
// HTML page from a proxy, no body).
function wlFetchJson(url) {
  return fetch(url).then(function(r) {
    if (r.ok) return r.json();
    return Promise.resolve().then(function() { return r.json(); }).then(function(b) {
      return b && typeof b.error === 'string' ? b.error : null;
    }, function() { return null; }).then(function(code) {
      var err = new Error('HTTP ' + r.status);
      err.status = r.status;
      err.code = code;
      throw err;
    });
  });
}

// A new work-log state for the conversation the panel opens (none: the panel
// closed, or a session without a conversation — 작업 로그 reads "작업 로그 없음").
// The list itself is the 작업 로그 tab's (wlPaint).
function resetWorkLog(convId) {
  if (_wl) _wl.closed = true; // late responses for the previous conversation are dropped
  _wl = convId ? wlNewState(convId) : null;
  if (_wl) _wl.onDenied = showWorkLogDenied;
  wlClear();
}
// The log element holds nothing (another section shown, another conversation):
// no groups, no cards; it lands on the newest again when painted.
function wlClear() {
  var el = wlEl();
  if (!el) return;
  var cards = el.querySelectorAll('ui-tool-call-card.wl-card');
  for (var i = 0; i < cards.length; i++) cards[i].remove();
  el._wlSig = '';
  el.data = { groups: [] };
}

// The latest window only (SSOT 2026-10-29): older pages wait for the reader to
// scroll up in 작업 로그 — never the whole history on an opening.
function loadWorkLog() {
  var st = _wl;
  if (!st) return;
  wlLoadLatest(st, wlFetchJson, paintWorkLog).then(function(result) {
    if (st.closed) return;
    // 'denied' was already shown by showWorkLogDenied (state.onDenied); an
    // empty or failed first page ends the element's loading state.
    if (result !== 'denied') wlPaint();
    // Spec 12: agents that wrote to the log but are not on the card get a place in the agent bar.
    if (result === 'ok') renderPanelAgents();
    if (result === 'ok' && _psec === 'tree') paintTreeTab();
  });
}
function recoverWorkLog() {
  if (_wl) wlRecover(_wl, wlFetchJson, paintWorkLog);
}
function pushLiveWorkLog(convId, entry) {
  if (!_wl || _wl.convId !== convId) return;
  wlOnLive(_wl, entry, wlFetchJson, paintWorkLog);
}
// Spec 12: entries that name an agent the bar does not show yet (their own
// entries, or a spawn/result row's agentRef) — on a live entry, an older page
// or a recovery merge alike.
function wlNamesNewAgent(added) {
  for (var i = 0; i < added.length; i++) {
    var e = added[i] && added[i].entry;
    if (!e) continue;
    if (e.agentId && !_panelAgentIdsShown[e.agentId]) return true;
    if (e.agentRef && !_panelAgentIdsShown[e.agentRef]) return true;
  }
  return false;
}

// ── 작업 로그 — @2lab.ai/ui <ui-work-log> (D3: F-01..F-10) ──
// The section is the library element: groups (a task: #id · title · count ·
// time, the newest open; a run of entries outside any task: its own group,
// open), entry rows (an instruction with the skills it invoked, progress, a
// response, a notice, an error, a turn soma-work sent as its one line), tool
// calls (this page's <ui-tool-call-card> in the entry's tool-<seq> slot),
// child agents (열기 → that agent's tab), the raw viewer (size, 복사, 다시
// 시도), the owner-only / empty / legacy states — and the scroll box (its
// <ui-log-scroller>: it follows the newest entry, pages older ones in on
// scroll-up — ui-load-older → loadOlderWorkLog — and keeps the reader's place).
// The page keeps the data layer (merged entries, paging, live WS, the raw
// cache) and hands the element data built from it (wlPaint).
function wlEl() {
  return document.getElementById('worklog-list');
}
function wlEntryBySeq(state, seq) {
  var list = (state && state.entries) || [];
  for (var i = 0; i < list.length; i++) if (list[i].seq === seq) return list[i];
  return null;
}
// An instruction entry as the conversation's turn: who sent it (by, kept
// since SSOT 2026-10-28) and a compaction turn; older entries carry neither
// and are read from their text.
function wlInstructionTurn(e, text) {
  return {
    role: 'user',
    rawContent: text,
    origin: e.by === 'user' || e.by === 'system' ? { by: e.by } : undefined,
    compact: e.compactTurn === true ? {} : undefined,
  };
}
// The facts an opened instruction row shows with its raw prompt (one line:
// the element's raw viewer note) — '' for a person's instruction and every
// other entry.
function wlEntryFactsText(e) {
  if (!e || e.kind !== 'instruction') return '';
  var info = sysTurnInfo(wlInstructionTurn(e, decodeSlackEntities(String(e.text || ''))));
  return info ? info.facts.map(function(f) { return f[0] + ': ' + f[1]; }).join(' · ') : '';
}
// An instruction text cut inside its <invoked_skills> block: the words before
// it, the names of the skills that start before the cut (in order, the last
// one cut), and that more may follow. null when there is no such block.
function wlCutSkills(text) {
  var at = text.indexOf('<invoked_skills>');
  if (at < 0) return null;
  var inner = text.slice(at + '<invoked_skills>'.length);
  var names = [];
  var i = 0;
  for (;;) {
    var m = /^\\s*<([^\\s<>\\/]+)>/.exec(inner.slice(i));
    if (!m) break;
    names.push(m[1]);
    var close = inner.indexOf('</' + m[1] + '>', i + m[0].length);
    if (close < 0) return { words: text.slice(0, at), names: names, more: true };
    i = close + m[1].length + 3;
  }
  if (!names.length) return null;
  return { words: text.slice(0, at), names: names, more: !/^\\s*<\\/invoked_skills>/.test(inner.slice(i)) };
}
// What the row stands for, in full — for an entry without stored raw output.
function wlFullText(e) {
  var text = String(e.text || '');
  return e.kind === 'instruction' ? decodeSlackEntities(text) : text;
}
// The stored original of one entry: loaded once (wlRawLoad caches the promise
// on the state), its outcome kept on the state for the element's data
// (st.rawDone[seq]) and the log painted again when it lands.
function wlRawFetch(st, seq) {
  if (!st || st.closed) return;
  var done = st.rawDone || (st.rawDone = Object.create(null));
  if (done[seq] && done[seq].status !== 'error') return;
  var e = wlEntryBySeq(st, seq);
  if (!e || !(toNum(e.rawBytes) > 0)) return;
  wlRawLoad(st, seq, wlFetchJson).then(function(r) {
    if (st !== _wl || st.closed) return;
    done[seq] = r;
    wlPaintSoon();
  });
}
// An entry's raw output as the element's viewer shows it (only while its row
// is open): the stored original, or the entry's own text when nothing is
// stored; the facts of a turn soma-work sent as the viewer's note.
function wlRawView(st, e) {
  var facts = wlEntryFactsText(e);
  var v;
  if (!(toNum(e.rawBytes) > 0)) v = { state: 'ready', text: wlFullText(e) };
  else {
    var r = st.rawDone && st.rawDone[e.seq];
    if (!r) return { state: 'loading' };
    if (r.status === 'missing') return { state: 'missing', note: WL_RAW_MISSING_MSG };
    if (r.status === 'denied') return { state: 'denied', note: WL_FORBIDDEN_MSG };
    if (r.status === 'damaged') return { state: 'error', note: WL_RAW_DAMAGED_MSG, canRetry: false };
    if (r.status !== 'ok') return { state: 'error', note: WL_RAW_ERROR_MSG, canRetry: true };
    v = { state: 'ready', text: String(r.raw), bytes: toNum(r.bytes) };
    if (r.truncated) v.truncated = true;
  }
  if (facts) v.note = facts;
  return v;
}
// A child agent the entry started, as the element's row (status, name, time,
// tools, what it does now; 열기). One that has not reached the card yet reads
// 확인 불가 until it does.
var WL_AGENT_STATUS = { running: 'running', waiting: 'waiting', completed: 'done', failed: 'failed', stopped: 'stopped' };
function wlAgentOf(id) {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var list = (s && s.agents) || [];
  var a = null;
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) { a = list[i]; break; }
  var node = a ? agentNodeOf(a) : { id: String(id), status: 'unknown', logOnly: true, toolCalls: 0, children: [] };
  var out = { id: String(id), name: agentNodeName(node), status: WL_AGENT_STATUS[node.status] || 'unknown', tools: Math.round(toNum(node.toolCalls)) };
  var started = Number(node.startedAt) || 0;
  if (started) out.startedAt = started;
  var ms = toNum(node.durationMs) || (Number(node.endedAt) && started ? Number(node.endedAt) - started : 0);
  if (ms > 0) out.duration = ms;
  var act = agentActivity(node);
  if (act) out.activity = act;
  return out;
}
// One entry as the element's data. A tool call is a card (this page's, in its
// tool-<seq> slot; a result whose call is on screen lives in the call's card
// and is not here — wlVisible); a spawn call carries its child's row. Spec 12:
// a subagent scope's 지시 / 결과 rows stay rows. Every other row opens to its
// raw output (raw only while open: the element keeps which rows are open).
function wlEntryOf(st, e) {
  var seq = Math.floor(Number(e.seq) || 0);
  var kind = Object.prototype.hasOwnProperty.call(WL_LABELS, e.kind) ? e.kind : 'narration';
  var x = { id: String(seq) };
  if (typeof e.ts === 'number' && isFinite(e.ts)) x.at = e.ts;
  var text = String(e.text || '');
  var tool = e.tool ? String(e.tool) : '';
  if ((kind === 'tool' || kind === 'tool_result') && !e._role) {
    var card = wlCardData(st, seq, false);
    x.kind = 'tool';
    x.tool = { name: tool || '툴', status: card ? card.status : 'interrupted' };
    var sum = kind === 'tool' ? wlToolSummary(tool, text) : e.ok === false ? '실패' : '완료';
    if (sum) x.tool.summary = sum;
    if (kind === 'tool' && e.agentRef) x.agent = wlAgentOf(String(e.agentRef));
    return x;
  }
  if (kind === 'tool' || kind === 'tool_result') {
    x.kind = e._role === 'spawn' ? 'instruction' : e._role === 'ack' ? 'notice' : kind === 'tool_result' && e.ok === false ? 'error' : 'final';
    x.label = e._role === 'spawn' ? '지시' : e._role === 'result' ? '결과' : '배경 실행 시작';
    var shown = tool && text === tool ? '' : tool && text.indexOf(tool + ' ') === 0 ? text.slice(tool.length + 1) : text;
    x.text = (tool ? tool + ' ' : '') + shown;
  } else if (kind === 'instruction') {
    var words = decodeSlackEntities(text);
    // A turn soma-work sent reads as the conversation's one line (SSOT 2026-10-28): badge, what it did, time.
    var info = sysTurnInfo(wlInstructionTurn(e, words));
    if (info) {
      x.kind = 'system';
      x.system = { kind: info.kind === 'bgwork' ? 'background' : info.kind, label: info.label };
      x.text = info.kind === 'compact' ? '컨텍스트 압축 (/compact)' : info.line;
    } else {
      // A person's: the words, and the skills it invoked as chips. The stored
      // text is cut at 4,000 characters, so a skill block is usually cut too:
      // the names readable before the cut until the original (loaded with the
      // log, wlPaint) gives every skill its text and tokens.
      var split = splitInvokedSkills(words);
      var cut = toNum(e.rawBytes) > 0 ? wlCutSkills(split.text) : null;
      var full = cut && st.rawDone && st.rawDone[seq] && st.rawDone[seq].status === 'ok'
        ? splitInvokedSkills(decodeSlackEntities(String(st.rawDone[seq].raw))).skills : null;
      x.kind = 'instruction';
      x.text = (cut ? cut.words : split.text).replace(/\\s+$/, '');
      var skills = full && full.length ? full : split.skills;
      var chips = skills.map(function(sk) { return { name: sk.name, tokens: sk.tokens, text: sk.body }; });
      if (cut && !(full && full.length)) chips = chips.concat(cut.names.map(function(n) { return { name: n }; }));
      if (chips.length) x.skills = chips;
    }
  } else {
    x.kind = kind;
    x.text = text;
  }
  x.hasRaw = true;
  if (st.open && st.open.has(seq)) x.raw = wlRawView(st, e);
  return x;
}
// Pure: a run of entries outside any task — what its head says (the kind of
// its first entry; an instruction's first line of words).
var WL_RUN_TITLE = { instruction: '지시', narration: '진행', final: '응답', notice: '알림', error: '오류', tool: '도구 호출', system: '시스템' };
function wlRunTitle(first) {
  var t = WL_RUN_TITLE[first.kind] || '진행';
  if (first.kind === 'system' && first.system) return first.system.label || t;
  var line = first.kind === 'instruction' ? String(first.text || '').split('\\n')[0].trim() : '';
  return line ? t + ' · ' + line : t;
}
// Open state of a group: the reader's choice (the element's ui-toggle, kept
// across repaints and tab switches), else open when it is the newest task
// group at first sight — a run outside any task is open.
function wlGroupOpen(state, id, newest) {
  var map = state.groupOpen || (state.groupOpen = Object.create(null));
  if (!(id in map)) map[id] = !!newest;
  return map[id];
}
// The task behind a group, from the open session's task ledger (status, time, tool calls).
function wlTaskInfo(taskId) {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  // Spec 12: task ids belong to one agent — look in the agent the panel shows.
  var owner = s && _panelAgent ? panelAgentOf(s) : s;
  var all = ((owner && owner.tasks) || []).concat((owner && owner.earlierTasks) || []);
  for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === taskId) return all[i];
  return null;
}
function wlGroupOf(e) {
  return e && typeof e.taskId === 'string' && e.taskId ? e.taskId : '';
}
// SSOT 2026-10-22 T10 — an entry made while a task was in progress carries
// that task (taskId / taskTitle): one group per task, at the place of its
// first entry, titled by the ledger (else its latest entry's title); the
// entries outside a task in runs, each its own group in line. A folded group
// is handed its count, not its entries: a long log's DOM stays the size of
// what is open — and the element's scroller never holds the reader's place on
// rows clipped inside a folded group (D3-GAPS G2-1).
function wlGroupsOf(st, entries) {
  var rows = [];
  var byTask = Object.create(null);
  var run = null;
  var newest = '';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var g = wlGroupOf(e);
    if (g) {
      run = null;
      var grp = byTask[g];
      if (!grp) {
        grp = byTask[g] = { id: 'task:' + g, taskId: g, title: '', at: e.ts, list: [] };
        rows.push(grp);
      }
      grp.list.push(e);
      if (e.taskTitle) grp.title = String(e.taskTitle);
      newest = grp.id;
      continue;
    }
    if (!run) {
      run = { id: 'run:' + Math.floor(Number(e.seq) || 0), at: e.ts, list: [] };
      rows.push(run);
    }
    run.list.push(e);
  }
  return rows.map(function(r) {
    var out = { id: r.id };
    if (typeof r.at === 'number' && isFinite(r.at)) out.at = r.at;
    if (r.taskId) {
      var task = wlTaskInfo(r.taskId);
      out.ref = '#' + r.taskId;
      out.title = (task && task.content) || r.title || '';
      out.open = wlGroupOpen(st, r.id, r.id === newest);
    } else {
      out.ref = '';
      out.title = wlRunTitle(wlEntryOf(st, r.list[0]));
      out.open = wlGroupOpen(st, r.id, true);
    }
    out.count = r.list.length;
    out.entries = out.open ? r.list.map(function(e) { return wlEntryOf(st, e); }) : [];
    return out;
  });
}
// The element's data for the log the panel shows: its groups, paging, and what
// it says without entries (owner-only, none, none for this agent, loading).
function wlLogData(st) {
  var d = { label: '작업 로그', startText: '작업 로그의 시작', emptyText: WL_EMPTY_MSG };
  if (!st) return Object.assign(d, { groups: [] });
  if (st.denied) return Object.assign(d, { groups: [], denied: WL_FORBIDDEN_MSG });
  var scoped = wlScopeEntries(st.entries);
  if (st.entries.length && !scoped.length) d.emptyText = '이 에이전트의 작업 로그 없음';
  d.groups = wlGroupsOf(st, wlVisible(st, scoped));
  d.hasMore = !!(st.loaded && st.latestOk && st.olderPending);
  d.loading = !st.loaded || !!st.olderLoading;
  // A log from before agent attribution that started subagents: its "main"
  // entries may be a subagent's — say so instead of claiming they are main's.
  if (!_panelAgent && wlLegacyMixed(st.entries)) d.legacy = '이전 통합 로그 — 메인/서브 귀속 미확인';
  return d;
}
// The cards the tool entries ask for: this page's <ui-tool-call-card> in each
// entry's tool-<seq> slot (created once, removed when its entry leaves),
// hydrated with their data (wlHydrateCards).
function wlCardSlots(el, d) {
  var want = Object.create(null);
  (d.groups || []).forEach(function(g) {
    (g.entries || []).forEach(function(x) { if (x.kind === 'tool') want[x.id] = x; });
  });
  var cards = el.querySelectorAll('ui-tool-call-card.wl-card');
  for (var i = 0; i < cards.length; i++) {
    var key = cards[i].getAttribute('data-key') || '';
    if (want[key]) delete want[key];
    else cards[i].remove();
  }
  for (var k in want) {
    var c = document.createElement('ui-tool-call-card');
    c.className = 'wl-card';
    c.setAttribute('lang', 'ko');
    c.setAttribute('slot', 'tool-' + k);
    c.setAttribute('data-key', k);
    // Each card's header is its own tab stop: the element's rows rove inside it,
    // a slotted card cannot join that (D3-GAPS G2-3).
    c.setAttribute('data-stop', '1');
    // Light-DOM text: shown until the element is defined (its shadow root has no slot).
    c.innerHTML = '<span class="wl-card-fallback"><span class="wl-tool-name">' + esc(want[k].tool.name) + '</span> ' + esc(want[k].tool.summary || '') + '</span>';
    el.appendChild(c);
  }
}
// 작업 로그 painted from the work-log state — only while it is the section
// shown (the others hold no nodes; it is painted again when it opens). A cut
// instruction's original is loaded so its skill chips get their text.
function wlPaint() {
  var el = wlEl();
  if (!el || _psec !== 'log') return;
  var st = _wl;
  var d = wlLogData(st);
  wlCardSlots(el, d);
  var sig = JSON.stringify(d);
  if (el._wlSig !== sig) {
    el._wlSig = sig;
    el.data = d;
  }
  if (!st) return;
  st.painted = true;
  wlHydrateCards(el);
  (d.groups || []).forEach(function(g) {
    (g.entries || []).forEach(function(x) {
      if (x.kind === 'instruction' && x.skills && x.skills.some(function(sk) { return sk.text === undefined; })) wlRawFetch(st, Number(x.id));
    });
  });
}
var _wlPaintQueued = false;
function wlPaintSoon() {
  if (_wlPaintQueued) return;
  _wlPaintQueued = true;
  requestAnimationFrame(function() {
    _wlPaintQueued = false;
    wlPaint();
  });
}
// Merged entries (a live entry, an older page, a backfill): the agents they
// name, a subagent's 지시와 답변, a card whose result arrived — then the log.
// The element keeps the reader's place and follows a reader at the newest.
function paintWorkLog(state, added) {
  if (state !== _wl || !added.length) return;
  // Spec 12: entries that name an agent the bar does not show yet.
  if (wlNamesNewAgent(added)) {
    renderPanelAgents();
    if (_psec === 'tree') paintTreeTab();
  }
  // Task view T1.3: a subagent tab's 지시와 답변 comes from these entries — the
  // tab may have opened (or the result may land) before they did.
  if (_panelAgent) renderAgentConv();
  if (_psec !== 'log') {
    state.painted = false;
    return;
  }
  // A result for a call whose card is open: the card fetches its output.
  for (var i = 0; i < added.length; i++) {
    var e = added[i] && added[i].entry;
    if (e && wlCardHidden(state, e)) wlOnToolResult(state, e);
  }
  wlPaint();
}
// Owner-only log (403 on any path) — only for the conversation still open.
function showWorkLogDenied(state) {
  if (state !== _wl || state.closed) return;
  // Live entries painted before the 403 go too: the log is owner-only.
  state.entries = [];
  wlPaint();
}

// ── Tool calls as cards (@2lab.ai/ui <ui-tool-call-card>) ──
// A call and its result are one card. The pair is matched by the SDK
// tool-use id. Entries written before the id was kept pair by agent + tool
// name: each result, from the newest back, takes the nearest earlier
// unanswered call — so a window that starts after a call leaves that call's
// result unpaired (its own card) rather than pinning it on a later call.
function wlPairKey(e) {
  return (e.agentId ? String(e.agentId) : '') + '|' + String(e.tool || '');
}
// Pure: resultOf[call seq] = result entry, callOf[result seq] = call seq.
function wlPairTools(entries) {
  var resultOf = Object.create(null);
  var callOf = Object.create(null);
  var byId = Object.create(null);
  var list = entries || [];
  function pair(call, res) {
    resultOf[call.seq] = res;
    callOf[res.seq] = call.seq;
  }
  // With ids: forward, first call of an id wins, first result of an id pairs.
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || (e.kind !== 'tool' && e.kind !== 'tool_result')) continue;
    var id = typeof e.toolUseId === 'string' && e.toolUseId ? e.toolUseId : '';
    if (!id) continue;
    if (e.kind === 'tool') {
      if (!Object.prototype.hasOwnProperty.call(byId, id)) byId[id] = e;
      continue;
    }
    var call = Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null;
    if (call && resultOf[call.seq] === undefined) pair(call, e);
  }
  // Without ids: backward, each result to the nearest earlier unanswered call of its key.
  var waiting = Object.create(null);
  for (var j = list.length - 1; j >= 0; j--) {
    var r = list[j];
    if (!r || (r.kind !== 'tool' && r.kind !== 'tool_result') || r.toolUseId) continue;
    var key = wlPairKey(r);
    if (r.kind === 'tool_result') {
      (waiting[key] || (waiting[key] = [])).push(r);
      continue;
    }
    var q = waiting[key];
    if (q && q.length) pair(r, q.shift());
  }
  return { resultOf: resultOf, callOf: callOf };
}
// Recomputed when the entries change (a live entry, an older page). A card
// whose result changed drops the input / output it loaded for the old pair.
function wlPairsOf(state) {
  var n = state && state.entries ? state.entries.length : 0;
  if (!state.pairs || state.pairsN !== n || state.pairsOf !== state.entries) {
    var before = state.pairs;
    state.pairs = wlPairTools(state.entries);
    state.pairsN = n;
    state.pairsOf = state.entries;
    if (before && state.cardDetail) {
      for (var k in state.cardDetail) {
        var was = before.resultOf[k];
        var now = state.pairs.resultOf[k];
        if ((was && was.seq) !== (now && now.seq)) delete state.cardDetail[k];
      }
    }
  }
  return state.pairs;
}
// A result whose call is in the log: it lives in the call's card.
function wlCardHidden(state, e) {
  return !!(e && !e._role && e.kind === 'tool_result' && state && wlPairsOf(state).callOf[e.seq] !== undefined);
}
function wlVisible(state, entries) {
  return (entries || []).filter(function(e) { return !wlCardHidden(state, e); });
}
// Pure: the emitter's text starts with the tool name ("Read {...}", "Glob ok");
// the card shows the name on its own, so the summary is only what follows.
function wlToolSummary(tool, text) {
  text = String(text || '');
  if (tool && text === tool) return '';
  if (tool && text.indexOf(tool + ' ') === 0) return text.slice(tool.length + 1);
  return text;
}
// A call without a result is running only while its session works on the
// turn it belongs to; otherwise the run ended before it returned.
function wlCallLive(state, call) {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var act = s && s.activityState;
  if (act !== 'working' && act !== 'waiting') return false;
  var list = (state && state.entries) || [];
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].turnId) return !call.turnId || call.turnId === list[i].turnId;
  }
  return true;
}
// The card's data for the entry that carries it (a call, or a result on its own).
function wlCardData(state, key, stop) {
  var carrier = wlEntryBySeq(state, key);
  if (!carrier) return null;
  var call = carrier.kind === 'tool' ? carrier : null;
  var res = call ? wlPairsOf(state).resultOf[call.seq] || null : carrier;
  var tool = String((call && call.tool) || (res && res.tool) || '');
  var status = res ? (res.ok === false ? 'error' : 'success') : wlCallLive(state, call) ? 'running' : 'interrupted';
  var d = { name: tool || '툴', status: status, focusable: !!stop, open: !!(state.open && state.open.has(key)) };
  var summary = call ? wlToolSummary(tool, call.text) : '';
  if (summary) d.summary = summary;
  if (call && typeof call.ts === 'number' && isFinite(call.ts)) {
    d.at = call.ts;
    d.startedAt = call.ts;
  }
  if (call && res && typeof res.ts === 'number' && typeof call.ts === 'number' && isFinite(res.ts) && isFinite(call.ts)) {
    d.duration = Math.max(0, res.ts - call.ts);
  }
  var det = state.cardDetail && state.cardDetail[key];
  if (det) {
    if (det.loading) d.loading = true;
    if (det.args !== undefined) d.args = det.args;
    if (det.result !== undefined) d.result = det.result;
    if (det.note) d.note = det.note;
    if (det.detailError) d.detailError = det.detailError;
  }
  if (status === 'error') {
    var msg = det && typeof det.result === 'string' ? det.result.slice(0, 600) : '';
    d.error = msg || '툴이 오류를 돌려줬어요 — 열면 출력을 볼 수 있어요';
  }
  return d;
}
// Same data → the card is left alone (no re-render, focus and timers kept).
// Input / output enter by the revision of the load that produced them (each
// load gets a new one), not by content: hashing 256 KiB on every push costs.
function wlCardSig(d, rev) {
  if (!d) return '';
  var keys = ['name', 'summary', 'status', 'focusable', 'open', 'at', 'duration', 'loading', 'note', 'detailError', 'error'];
  var out = [];
  for (var i = 0; i < keys.length; i++) out.push(d[keys[i]]);
  out.push(d.args === undefined ? -1 : 1, d.result === undefined ? -1 : 1, rev || 0);
  return JSON.stringify(out);
}
function wlPaintCard(state, el) {
  if (!el || !state) return;
  var key = Math.floor(Number(el.getAttribute('data-key')) || 0);
  var d = wlCardData(state, key, el.getAttribute('data-stop') === '1');
  if (!d) return;
  var det = state.cardDetail && state.cardDetail[key];
  // Open without its input / output (a re-pairing dropped them, a fresh render): fetch them.
  if (d.open && !det) {
    wlLoadCardDetail(state, key);
    return;
  }
  var sig = wlCardSig(d, det && det.rev);
  if (el._wlSig === sig) return;
  el._wlSig = sig;
  el.data = d;
}
function wlCardEl(key) {
  var list = document.getElementById('worklog-list');
  return list ? list.querySelector('ui-tool-call-card[data-key="' + Math.floor(Number(key) || 0) + '"]') : null;
}
// Give every card on screen its data — once the element is defined, so data
// never lands on an un-upgraded node (the library loads as a module).
function wlHydrateCards(root) {
  if (!root || !_wl) return;
  var cards = root.querySelectorAll('ui-tool-call-card.wl-card');
  if (!cards.length) return;
  var reg = window.customElements;
  if (reg && !reg.get('ui-tool-call-card')) {
    if (!_wlCardsWait && reg.whenDefined) {
      _wlCardsWait = true;
      reg.whenDefined('ui-tool-call-card').then(function() {
        _wlCardsWait = false;
        wlHydrateCards(document.getElementById('worklog-list'));
      });
    }
    return;
  }
  for (var i = 0; i < cards.length; i++) wlPaintCard(_wl, cards[i]);
}
// A stored raw → the card's text for that part (args / result) and its note.
function wlPartLoad(state, e) {
  if (!e) return Promise.resolve(null);
  if (!(toNum(e.rawBytes) > 0)) return Promise.resolve({ status: 'none' });
  return wlRawLoad(state, e.seq, wlFetchJson);
}
function wlLoadCardDetail(state, key) {
  var carrier = wlEntryBySeq(state, key);
  if (!carrier) return;
  var call = carrier.kind === 'tool' ? carrier : null;
  var res = call ? wlPairsOf(state).resultOf[call.seq] || null : carrier;
  var details = state.cardDetail || (state.cardDetail = Object.create(null));
  var pending = { loading: true, rev: ++_wlDetailRev };
  details[key] = pending;
  wlPaintCard(state, wlCardEl(key));
  Promise.all([wlPartLoad(state, call), wlPartLoad(state, res)]).then(function(parts) {
    // A newer load (or a re-pairing) owns this card now: drop the late answer.
    if (state !== _wl || state.closed || details[key] !== pending) return;
    var det = { loading: false, rev: ++_wlDetailRev };
    var notes = [];
    var fail = '';
    for (var i = 0; i < 2; i++) {
      var r = parts[i];
      if (!r || r.status === 'none') continue;
      var label = i === 0 ? '입력' : '결과';
      if (r.status === 'ok') {
        if (i === 0) det.args = r.raw;
        else det.result = r.raw;
        if (r.truncated) notes.push(label + ': 저장된 앞 256 KiB만 표시 — 원본 ' + formatBytes(r.bytes));
      } else if (r.status === 'missing') notes.push(label + ': ' + WL_RAW_MISSING_MSG);
      // Final answers (cached): a note — 다시 시도 would only get the same answer.
      else if (r.status === 'denied') notes.push(WL_FORBIDDEN_MSG);
      else if (r.status === 'damaged') notes.push(label + ': ' + WL_RAW_DAMAGED_MSG);
      else fail = fail || WL_RAW_ERROR_MSG;
    }
    if (notes.length) det.note = notes.join(' · ');
    if (fail) det.detailError = fail;
    details[key] = det;
    wlPaintCard(state, wlCardEl(key));
  });
}
// The list owns each card's open state (state.open), so a re-render, a live
// result or a page of older entries brings it back as it was.
function wlToggleCard(state, el, open) {
  if (!state || state.closed || !el) return;
  var key = Math.floor(Number(el.getAttribute('data-key')) || 0);
  var set = state.open || (state.open = new Set());
  if (open) set.add(key);
  else set.delete(key);
  if (open && !(state.cardDetail && state.cardDetail[key] && !state.cardDetail[key].detailError)) wlLoadCardDetail(state, key);
  else wlPaintCard(state, el);
}
// A result arrived for a call on screen: its card turns done / failed (and an
// open card fetches the output).
function wlOnToolResult(state, e) {
  var callSeq = wlPairsOf(state).callOf[e.seq];
  if (callSeq === undefined) return false;
  var el = wlCardEl(callSeq);
  if (state.open && state.open.has(callSeq)) wlLoadCardDetail(state, callSeq);
  else if (el) wlPaintCard(state, el);
  return true;
}
function wlIsCard(el) {
  return !!(el && el.tagName === 'UI-TOOL-CALL-CARD');
}
// The element's requests: a group or a row opened / closed (the page keeps
// which; a row's raw output loads when it opens), 다시 시도 on a raw output,
// 열기 on a child agent (Spec 12: the panel switches to it), the page before the
// oldest entry; and a card's own open / close and 다시 시도 (wlToggleCard).
(function initWorkLog() {
  var el = wlEl();
  if (!el) return;
  el.addEventListener('ui-toggle', function(e) {
    var st = _wl;
    if (wlIsCard(e.target)) {
      e.preventDefault();
      wlToggleCard(st, e.target, !!(e.detail && e.detail.open));
      return;
    }
    if (e.target !== el || !st || st.closed) return;
    var d = e.detail || {};
    if (d.kind === 'group') {
      (st.groupOpen || (st.groupOpen = Object.create(null)))[d.id] = !!d.open;
    } else if (d.kind === 'entry') {
      var seq = Math.floor(Number(d.id) || 0);
      var open = st.open || (st.open = new Set());
      if (d.open) {
        open.add(seq);
        wlRawFetch(st, seq);
      } else open.delete(seq);
    }
    wlPaint();
  });
  el.addEventListener('ui-retry', function(e) {
    var st = _wl;
    if (e.target !== el || !st || st.closed) return;
    var seq = Math.floor(Number(e.detail && e.detail.id) || 0);
    if (st.rawDone) delete st.rawDone[seq];
    wlRawFetch(st, seq);
  });
  el.addEventListener('ui-open', function(e) {
    if (e.target !== el) return;
    var id = e.detail && e.detail.id;
    if (id) selectPanelAgent(String(id));
  });
  el.addEventListener('ui-load-older', function(e) {
    var st = _wl;
    if (!st || st.closed || st.denied || !st.latestOk || !st.olderPending || st.olderLoading) {
      e.preventDefault();
      return;
    }
    loadOlderWorkLog();
  });
  el.addEventListener('ui-reload', function(e) {
    if (!wlIsCard(e.target) || !_wl || _wl.closed) return;
    wlLoadCardDetail(_wl, Math.floor(Number(e.target.getAttribute('data-key')) || 0));
  });
  if (window.customElements && customElements.whenDefined) {
    customElements.whenDefined('ui-work-log').then(function() {
      el._wlSig = '';
      wlPaint();
    });
  }
})();

// Where an opening lands (§3.1-6, spec 13) — on open, and again once the
// scroll area has its content. Its section tab is psecForLanding's (작업 로그,
// 에이전트 트리 or 지시와 답변), landed on its newest items in its own box; the
// panel's scroll, by the opening's intent (_panelLand):
//   goal / agent / tasks (관리 →, a tree item, 전체 N개 → 상세, 전체 task →):
//     that section at the top of the scroll area (under the sticky agent tabs),
//     once per opening — the turns loading below it never drag it away;
//   answer, default: the permission or question the session waits on, which
//     sits in the common surface at the top, so the answer form is in view at
//     once. The question landing is made once per opening: turns load below the
//     form and do not move it, and a reader who scrolled meanwhile stays;
//   worklog (작업 로그 / ?session=), or no question: the section tabs in view —
//     the top when the section box ends in view, else the tabs under the agent
//     tabs (psecLandingTop) — made again as the parts arrive, unless the reader
//     scrolled since.
var _panelOnQuestion = false;
var _panelLandAt = null; // where the last section landing left the scroll (null = none yet this opening)
var _panelHold = false; // a landed section is held in place while the panel settles, until the reader acts
var _panelHoldUntil = 0; // the settle window (3 s): after it, the panel's own moves are the reader's place too
function landPanel() {
  var scrollEl = document.getElementById('panel-scroll');
  if (!scrollEl) return;
  // Task view: Tasks sit in the tab under the sticky agent tabs — a tasks
  // opening lands on the (unfolded) plan's head, just under the tab strip.
  if (_panelLand === 'goal' || _panelLand === 'agent' || _panelLand === 'tasks') {
    if (_panelLanded) return;
    var sec = document.getElementById(_panelLand === 'goal' ? 'panel-goal' : _panelLand === 'tasks' ? 'panel-tasks' : 'panel-agents');
    if (sec && sec.style.display !== 'none') {
      // The reader scrolled since the last try: they stay where they are.
      if (_panelLandAt !== null && Math.abs(scrollEl.scrollTop - _panelLandAt) > 1) { _panelLanded = true; return; }
      var tabs = _panelLand === 'goal' ? null : document.getElementById('panel-tabs');
      var under = tabs ? tabs.offsetHeight || 0 : 0;
      var target = scrollEl.scrollTop + sec.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - under;
      // The landing is the reader's new place: an anchor the layout coordinator
      // captured before it (layoutBeforeChange) must not pull the panel back.
      _panelScrollGen++;
      scrollEl.scrollTo({ top: target, behavior: 'instant' });
      // Task view: the scroll area is the whole body, so before the turns load it
      // may be too short to bring the section up — landed only once it is there;
      // the landing after the turns arrive tries again.
      _panelLandAt = scrollEl.scrollTop;
      _panelLanded = Math.abs(scrollEl.scrollTop - target) <= 1;
      _panelHold = _panelLanded;
      _panelHoldUntil = Date.now() + 3000;
      return;
    }
  }
  if (_panelLand !== 'worklog') {
    // What the session waits on: a permission prompt (above the question slot)
    // or an open question. Either is where the panel lands.
    var permission = document.getElementById('panel-permission');
    var question = document.getElementById('panel-question');
    var target = permission && permission.style.display !== 'none' ? permission
      : question && question.style.display !== 'none' ? question : null;
    var onQuestion = !!target;
    if (onQuestion && _panelOnQuestion) return;
    _panelOnQuestion = onQuestion;
    if (onQuestion) {
      // The question sits under the session info that scrolls with the
      // conversation (SSOT 2026-10-24), so land on its own offset, not on 0.
      // The 입력 필요 head sits right above it: land with the head in view (re-agent-run D9).
      var needsHead = document.getElementById('panel-needs-head');
      var headH = needsHead && !needsHead.hidden ? (needsHead.offsetHeight || 0) : 0;
      var questionTop = Math.max(0, scrollEl.scrollTop + target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - headH);
      // Instant: the panel's scroll is the reader's place at once.
      // #488: the landing is the reader's new place — a layout anchor from before it is stale.
      _panelScrollGen++;
      scrollEl.scrollTo({ top: questionTop, behavior: 'instant' });
      return;
    }
  }
  // The section tabs in view; a reader who scrolled since the last landing stays.
  if (_panelLandAt !== null && Math.abs(scrollEl.scrollTop - _panelLandAt) > 1) return;
  var secs = document.getElementById('panel-sections');
  var body = document.getElementById('panel-sections-body');
  var tabs = document.getElementById('panel-tabs');
  var top = 0;
  if (secs && body) {
    var base = scrollEl.getBoundingClientRect().top - scrollEl.scrollTop;
    top = psecLandingTop(secs.getBoundingClientRect().top - base, body.getBoundingClientRect().bottom - base, scrollEl.clientHeight, tabs ? tabs.offsetHeight || 0 : 0);
  }
  _panelScrollGen++;
  scrollEl.scrollTo({ top: top, behavior: 'instant' });
  _panelLandAt = scrollEl.scrollTop;
}

// A held section landing: the section goes back under the tabs when the panel
// moved it without the reader (a re-render above it, the browser's own scroll
// anchoring) — as far as the body allows.
function holdPanelLanding() {
  // Past the settle window a move with no input (find in page, a scrollbar) is the reader's.
  if (Date.now() > _panelHoldUntil) { _panelHold = false; return; }
  var scrollEl = document.getElementById('panel-scroll');
  var sec = document.getElementById(_panelLand === 'goal' ? 'panel-goal' : _panelLand === 'tasks' ? 'panel-tasks' : 'panel-agents');
  if (!scrollEl || !sec || sec.style.display === 'none') return;
  var tabs = _panelLand === 'goal' ? null : document.getElementById('panel-tabs');
  var under = tabs ? tabs.offsetHeight || 0 : 0;
  var drift = sec.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - under;
  var top = Math.max(0, Math.min(scrollEl.scrollTop + drift, scrollEl.scrollHeight - scrollEl.clientHeight));
  if (Math.abs(top - scrollEl.scrollTop) <= 1) return;
  _panelScrollGen++;
  scrollEl.scrollTo({ top: top, behavior: 'instant' });
}

// ── Slide Panel ──
// focusWorkLog = opened from a card's 작업 로그 button or a ?session= deep link:
// the panel opens on its 작업 로그 tab (true), or names another landing
// ('answer', 'agent', 'goal', 'tasks' — psecForLanding picks the section tab).
function openPanel(sessionKey, focusWorkLog, agentId, byKey) {
  const s = _sessionCache[sessionKey];
  if (!s) return;
  // The detail deck (SSOT 2026-10-29 T2): this session's detail card joins it
  // (or comes to the front); a switch between cards slides in from its side.
  var deckDir = panelOpen && panelSessionKey && panelSessionKey !== sessionKey
    ? (_deck.indexOf(sessionKey) < 0 || _deck.indexOf(sessionKey) > _deck.indexOf(panelSessionKey) ? 1 : -1) : 0;
  deckAdd(sessionKey);
  // The intent of this opening: true is the 작업 로그 landing, as before.
  _panelLand = focusWorkLog === true ? 'worklog' : (focusWorkLog || '');
  _panelLanded = false;
  _panelLandAt = null;
  _panelHold = false;
  // The section tab of this opening (the reader's choice then holds until it closes).
  _psec = psecForLanding(_panelLand);
  _treeWindow = AT_PANEL_WINDOW;
  _treeMaxN = null;
  // The control that opened it gets focus back on close (not a control inside the panel).
  var opener = document.activeElement;
  if (opener && opener !== document.body && !(opener.closest && opener.closest('#slide-panel'))) _panelReturnFocus = document.activeElement;
  // Spec 12 §4.3: the agent whose tasks and work log the panel shows ('' = main).
  _panelAgent = agentId ? String(agentId) : '';

  // A card switch starts the composer clean: a fresh <ui-agent-steering> (the
  // old one's text, notes in flight and failed sends were that session's) and no
  // files. A send still in flight completes in the background without touching
  // this card. Re-landing on the session already open (관리 →, 전체 task →, a tree
  // item) keeps the message being typed and a send in flight (spec 13).
  var sameSession = panelOpen && panelSessionKey === sessionKey;
  if (!sameSession) {
    pcFreshSteer();
    pcReset();
    // Another session's task ids (T1 …) are other tasks: no run's detail carries over.
    _panelTaskOpen = Object.create(null);
  }

  // Reset pagination state before loading this session's turns. A new panel
  // generation makes every request of the previous one stale — including a
  // close + reopen of the same session, which session-key equality misses.
  _panelGen++;
  _panelTurnsHasMore = false;
  _panelTurnsLoading = false;
  _panelTurnsOldestId = null;
  _panelTurnsList = [];
  _panelTurnsCid = '';
  _panelTurnsMsg = s.conversationId ? 'loading' : 'unrecorded';
  _panelTurnsWhy = '';
  _panelOlderWhy = '';

  panelSessionKey = sessionKey;
  panelConvId = s.conversationId || null;
  resetWorkLog(panelConvId);
  // Artifacts (T6): the summary now, the full list as soon as it arrives.
  renderPanelArtifactsSection();
  if (panelConvId && !isSiblingSession(s)) ensureArtifacts(panelConvId, true);
  if (panelConvId && !isSiblingSession(s) && s.userMedia && toNum(s.userMedia.count) > 0) ensureUserMedia(panelConvId);
  // Every opening starts with the defaults (§3.1-6, task view T1.3): Tasks
  // folded — or every detail open with 자세히; the goal folded either way.
  resetPanelSections();
  _agentConvRaw = Object.create(null);
  _agentConvFailed = Object.create(null);
  _ansFailed = Object.create(null);
  // The previous opening's answers are gone from the list: stop watching them.
  if (_ansIo) { _ansIo.disconnect(); _ansIo = null; }
  _panelOnQuestion = false;

  // #762 — single source of truth for headline. displayHeadline carries the
  // server-resolved priority chain; older WS messages without it still get a
  // sensible fallback.
  document.getElementById('panel-title').textContent = s.displayHeadline || s.summaryTitle || s.title || 'Untitled';

  // TitleSub
  var titleSubTextEl = document.getElementById('panel-title-sub-text');
  var titleSubBtn = document.getElementById('panel-title-sub-regen');
  titleSubTextEl.textContent = '';
  titleSubBtn.style.display = 'none';
  _panelTitleSub = '';

  // The session parts — head chip, 세션 정보, goal, model · effort, the node
  // scope — go through the same live path as every update (spec 13).
  // A tasks opening (전체 task N개 →) unfolds the plan with every step and the earlier plans.
  if (_panelLand === 'tasks') { _panelTasksOpen = true; _panelTasksExpanded = true; _panelTasksEarlier = true; }
  // Another session's goal form (and its draft) never carries into this one;
  // reopening the same session keeps an unsent draft.
  var goalEl = document.getElementById('panel-goal');
  if (goalEl && goalEl._key !== sessionKey) { goalEl.innerHTML = ''; goalEl._html = ''; }
  // An opening's first plan and 입력 필요 renders are the baseline: nothing in
  // them is announced (re-agent-run D7, D15).
  var tasksEl = document.getElementById('panel-tasks');
  if (tasksEl) tasksEl._planScope = null;
  var permEl = document.getElementById('panel-permission');
  if (permEl) permEl._seenKey = null;
  repaintPanelSession();

  // Pending permission prompt + question in panel
  renderPanelPermission(s);
  renderPanelQuestion(s);


  // The section tab of this opening, painted from its data (지시와 답변: the
  // skeleton while the turns load) and landed on its newest items.
  selectPanelSection(_psec);
  sizePanelSections();
  landPanel(); // the answer form is in view while the turns load

  // 지시와 답변: the latest PANEL_TURNS_PAGE turns; older pages as the reader scrolls up.
  loadPanelTurns(true);

  // Command input — always visible; disabled + hint for terminated / sleeping
  // sessions, or when viewer is not the session owner (#708 read-only mode).
  document.getElementById('panel-command').style.display = '';
  // A re-landing on the open session leaves a send in flight alone (only a change of state writes).
  renderPanelComposer(s, !sameSession);

  // Docked (≥840px) the open drawer narrows the board: animate that shift too.
  layoutBeforeChange();
  document.getElementById('slide-panel').classList.add('open');
  document.getElementById('panel-overlay').classList.add('open');
  panelOpen = true;

  if (panelConvId) loadWorkLog();
  sizePanelSections();
  renderDeckNav(deckDir);
  // A keyboard opening puts focus where it landed (a click leaves it alone).
  if (byKey) focusPanelLanding();
}

// ── Detail deck (SSOT 2026-10-29 T2) ──
// An open card always has its detail card beside the board. The panel shows one
// of them; the others wait behind it — their edges peek above the panel and
// ‹ n / m › in its top right go through them. Opening a card puts its detail
// card in front; folding the card (or closing its detail card) takes it out
// and the next one comes to the front — with none left the panel closes.
var _deck = []; // session keys with a detail card in the deck, in opening order
function deckAdd(key) {
  if (_deck.indexOf(key) < 0) _deck.push(key);
}
function deckRemove(key) {
  var i = _deck.indexOf(key);
  if (i >= 0) _deck.splice(i, 1);
}
// Pure: the card that comes to the front when key leaves the deck — the
// next one, else the one before (null: the deck is empty after it).
function deckNextAfter(deck, key) {
  var i = deck.indexOf(key);
  if (i < 0) return deck.length ? deck[deck.length - 1] : null;
  return deck[i + 1] || deck[i - 1] || null;
}
// The detail card of key leaves the deck: the next one comes to the front, or the panel closes.
function deckDrop(key) {
  // A session gone from the board since it joined the deck is no next card (review R1).
  for (var i = _deck.length - 1; i >= 0; i--) if (_deck[i] !== key && !_sessionCache[_deck[i]]) _deck.splice(i, 1);
  var showing = panelOpen && panelSessionKey === key;
  var next = showing ? deckNextAfter(_deck, key) : null;
  deckRemove(key);
  if (!showing) { renderDeckNav(0); return; }
  if (next) openPanel(next);
  else closePanel();
}
// ✕ / Escape / the sheet's backdrop: this detail card closes — and its card on
// the board folds with it (an open card always has its detail card). The card
// folds as a press on its face would (its <ui-agent-inbox> has no fold method);
// the element's ui-toggle then takes the detail card out of the deck.
function closeDetailCard() {
  var key = panelSessionKey;
  if (!key) { closePanel(); return; }
  var face = _expanded.has(key) ? cardFaceOf(key) : null;
  if (face) face.click();
  if (_deck.indexOf(key) >= 0) deckDrop(key);
}
// The face of a card on its element (in the element's open shadow root), or null.
function cardFaceOf(key) {
  var host = _cardHost[key];
  var root = host && host.shadowRoot;
  if (!root) return null;
  var cards = root.querySelectorAll('li.ib-card[data-card]');
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].getAttribute('data-card') === key) return cards[i].querySelector('.ib-face[role="button"]');
  }
  return null;
}
// The deck's controls and the edges behind the panel; dir = the side a new front card came from.
// <ui-deck-nav> (D3 E-05) takes the deck as data — how many, which is in front, their names
// (its ‹ › title "이전: <name>", its position said once) — and asks with ui-page; the page
// opens that card, which repaints this with the new front.
function renderDeckNav(dir) {
  _deck = _deck.filter(function(k) { return !!_sessionCache[k]; });
  var panel = document.getElementById('slide-panel');
  var nav = document.getElementById('panel-deck');
  if (!panel || !nav) return;
  var n = _deck.length;
  var i = _deck.indexOf(panelSessionKey);
  var behind = panelOpen && i >= 0 ? Math.min(n - 1, 2) : 0;
  panel.setAttribute('data-deck', String(behind));
  nav.hidden = !(panelOpen && n > 1 && i >= 0);
  if (!nav._wired) {
    nav._wired = true;
    nav.addEventListener('ui-page', onDeckPage);
  }
  if (!nav.hidden) {
    var titles = _deck.map(function(k) { var x = _sessionCache[k]; return x ? String(x.displayHeadline || x.summaryTitle || x.title || '') : ''; });
    var data = { count: n, index: i, titles: titles, label: '열린 작업 카드' };
    var sig = JSON.stringify(data);
    if (nav._sig !== sig) {
      nav._sig = sig;
      nav._keys = _deck.slice();
      nav.data = data;
    }
  }
  if (dir && !reduceMotion()) deckSlide(panel, dir);
}
// ‹ / › (or ←/→ on the nav): the card at that place in the deck the nav was drawn for comes to the front.
function onDeckPage(e) {
  var keys = (e.currentTarget && e.currentTarget._keys) || [];
  var k = e.detail ? keys[e.detail.index] : null;
  if (k && k !== panelSessionKey && _sessionCache[k]) openPanel(k);
}
// The deck switch (P6): the header and body glide 18px in from the side the new front card came from,
// on --dur-move ease-out. The offset is composited ('add') onto any slide still running, so a quick
// second switch carries on from where they are drawn; the fade restarts from the drawn opacity.
var DECK_SLIDE_MS = 320;
function deckSlide(panel, dir) {
  var parts = panel.querySelectorAll ? panel.querySelectorAll('.panel-header, .panel-body') : [];
  for (var i = 0; i < parts.length; i++) {
    var el = parts[i];
    if (typeof el.animate !== 'function') continue;
    var from = el._deckFade && el._deckFade.playState === 'running' ? Number(getComputedStyle(el).opacity) : 0.35;
    if (el._deckFade) el._deckFade.cancel();
    el.animate([{ transform: 'translateX(' + (dir > 0 ? 18 : -18) + 'px)' }, { transform: 'translateX(0)' }],
      { duration: DECK_SLIDE_MS, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', composite: 'add' });
    el._deckFade = el.animate([{ opacity: Math.min(from, 1) }, { opacity: 1 }], { duration: DECK_SLIDE_MS, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  }
}
// The landing target of this opening, for the keyboard: the answer form, the
// goal section, the focused node's header, the Tasks head, the 작업 로그 tab —
// else the heading.
function focusPanelLanding() {
  var t = null;
  if (_panelLand === 'goal') t = document.querySelector('#panel-goal .cg-add-input') || document.getElementById('panel-goal');
  else if (_panelLand === 'agent') t = document.querySelector('#panel-agents .pa-focus');
  else if (_panelLand === 'tasks') t = document.getElementById('panel-tasks');
  else if (_panelLand === 'worklog') t = document.getElementById('psec-tab-log');
  if (!t || t.style.display === 'none') {
    // The first approval card still waiting on an answer, itself — its focus()
    // lands on the card, not a button: Esc there still closes the panel, ⌘↵
    // answers (re-agent-run D14); the multi-question form keeps its first control.
    var ask = acFirstOpen(document.getElementById('panel-permission')) || acFirstOpen(document.getElementById('panel-question'))
      || document.querySelector('#panel-question button:not([disabled]), #panel-question textarea');
    t = ask || document.getElementById('panel-title');
  }
  if (t && t.focus) t.focus({ preventScroll: true });
}

// 지시와 답변's first page: the latest PANEL_TURNS_PAGE turns of the open
// session (older pages come as the reader scrolls up). land: the panel lands
// once they are in (an opening); a Try again on a failed load does not.
function loadPanelTurns(land) {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  if (!s || !s.conversationId) return;
  _panelTurnsLoading = true;
  _panelTurnsWhy = '';
  var loadingConvId = s.conversationId;
  var loadingGen = _panelGen;
  fetch('/api/dashboard/session/' + encodeURIComponent(loadingConvId) + '?limit=' + PANEL_TURNS_PAGE)
    .then(function(r) {
      if (r && r.ok === false) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      // If the panel was switched, closed or reopened while loading, discard this result.
      if (loadingGen !== _panelGen) return;

      // Handle titleSub
      var tSubText = document.getElementById('panel-title-sub-text');
      var tSubBtn = document.getElementById('panel-title-sub-regen');
      if (data.titleSub) {
        _panelTitleSub = data.titleSub;
        tSubText.textContent = data.titleSub;
        tSubBtn.style.display = panelTitleSubCanRegen() ? 'inline-block' : 'none';
      } else if (loadingConvId) {
        generateTitleSub(loadingConvId, false); // fill: allowed for every signed-in viewer
      }

      var turns = (data && data.turns) || [];
      // A turn pushed while the page loaded (WS) and not in it stays, after it.
      var pushed = _panelTurnsList;
      _panelTurnsList = turns.slice();
      for (var i = 0; i < pushed.length; i++) ptUpsert(_panelTurnsList, pushed[i]);
      _panelTurnsCid = data.id || loadingConvId;
      _panelTurnsHasMore = turns.length > 0 && !!data.hasMore;
      _panelTurnsOldestId = turns.length ? turns[0].id : null;
      _panelTurnsMsg = _panelTurnsList.length ? '' : 'none';
      _panelTurnsLoading = false;
      if (_psec === 'conv') {
        convPaint();
        psecToNewest();
      }
      if (land) landPanel();
    })
    .catch(function(err) {
      if (loadingGen !== _panelGen) return;
      _panelTurnsLoading = false;
      _panelTurnsMsg = _panelTurnsList.length ? '' : 'failed';
      _panelTurnsWhy = String((err && err.message) || '네트워크 오류');
      if (_psec === 'conv') convPaint();
      if (land) landPanel();
    });
}

// ── Pagination state for 지시와 답변 (recent-first; older pages on scroll up) ──
var _panelTurnsHasMore = false;
var _panelTurnsLoading = false;
var _panelTurnsOldestId = null;
var _panelGen = 0; // bumped by openPanel / closePanel — the identity of one panel opening

// The first part of the panel the reader sees (the question, Tasks, the section
// tabs) and where it is — kept across a layout shift and a live repaint above it.
function panelScrollAnchor(scrollEl) {
  var viewTop = scrollEl.getBoundingClientRect().top;
  var nodes = scrollEl.querySelectorAll('#panel-question, #panel-tasks, #panel-sections');
  for (var i = 0; i < nodes.length; i++) {
    var r = nodes[i].getBoundingClientRect();
    if (r.height > 0 && r.bottom > viewTop) return { el: nodes[i], top: r.top };
  }
  return null;
}

// The page of turns before the oldest one held — the element asks for it as the
// reader scrolls up in 지시와 답변 (ui-load-older; its top row is the keyboard
// path). The turns go in above the reader, who keeps their place (the element
// holds the rows they were on); a page that fails says so above the turns with
// 다시 시도, and the element waits for the reader before asking again.
async function loadMorePanelTurns() {
  if (_panelTurnsLoading || !_panelTurnsHasMore || !panelConvId || !_panelTurnsOldestId) return;
  _panelTurnsLoading = true;
  _panelOlderWhy = '';
  var requestConvId = panelConvId;
  var requestGen = _panelGen; // this panel opening; any switch/close/reopen makes it stale
  var requestOldestId = _panelTurnsOldestId;
  convPaint(); // 이전 대화 불러오는 중…
  try {
    var url = '/api/dashboard/session/' + encodeURIComponent(requestConvId)
      + '?limit=' + PANEL_TURNS_PAGE + '&before=' + encodeURIComponent(requestOldestId);
    var r = await fetch(url);
    if (r && r.ok === false) throw new Error('HTTP ' + r.status);
    var data = await r.json();
    // Discard a stale response: the panel was switched, closed or reopened
    // (same session included) while this request was in flight.
    if (requestGen !== _panelGen) return;
    var turns = (data && data.turns) || [];
    _panelTurnsHasMore = turns.length > 0 && !!data.hasMore;
    if (turns.length) {
      _panelTurnsOldestId = turns[0].id;
      _panelTurnsList = turns.concat(_panelTurnsList);
    }
  } catch (err) {
    if (requestGen !== _panelGen) return;
    _panelOlderWhy = String((err && err.message) || '네트워크 오류');
    console.error('loadMorePanelTurns failed', err);
  } finally {
    // Only the current generation owns the in-flight flag; a stale request
    // settling must not clear the flag of the load that replaced it.
    if (requestGen === _panelGen) {
      _panelTurnsLoading = false;
      convPaint();
    }
  }
}

// ── Turns the user did not type (SSOT 2026-10-27 T1–T5) ──
// soma-work puts some user turns there itself: a /compact, a restart resume, an
// error retry, a goal continuation, a cron fire, a /renew save or load. Each
// reads as one line — a badge and what it did — that opens to its facts and the
// raw prompt. The wording each producer injects is pinned against its source by
// dashboard-system-turns-client.test.ts. A turn a person sent (origin.by
// 'user') is never read as one of the injected kinds; a command they may type
// themselves (/compact, /renew) is classified whoever sent it.
var SYS_RESTART_HEADS = ['The service was restarted and the previous task was interrupted.', '서비스가 재시작되어 이전 작업이 중단되었다.'];
var SYS_RESUME_CONTEXT = '--- 중단 시점 컨텍스트 ---';
var SYS_RETRY_MARK = '⚠️ 이전 시도 중 오류 발생:';
var CP_DEFAULT_EST_MS = 150000; // a /compact runs 2–3 min (compact-state.ts) — the estimate until the conversation has one of its own
var CP_MAX_MS = 600000; // COMPACTION_IN_PROGRESS_MAX_MS: past this a compaction without a result is dead
var _cpTimer = 0;
var _skillBodies = Object.create(null);
var _skillSeq = 0;

function sysOneLine(s, max) {
  var line = String(s || '').replace(/\\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
function sysBetween(s, open, close) {
  var a = s.indexOf(open);
  if (a < 0) return '';
  var b = s.indexOf(close, a + open.length);
  return s.slice(a + open.length, b < 0 ? s.length : b).trim();
}
// The "--- 중단 시점 컨텍스트 ---" lines a restart / retry resume carries (autoResumeSession).
function sysResumeContext(raw) {
  var out = { title: '', workflow: '', error: '' };
  var at = raw.indexOf(SYS_RESUME_CONTEXT);
  if (at < 0) return out;
  raw.slice(at + SYS_RESUME_CONTEXT.length).split('\\n').forEach(function(line) {
    var l = line.trim();
    if (l.indexOf('세션 제목: ') === 0) out.title = l.slice('세션 제목: '.length);
    else if (l.indexOf('워크플로우: ') === 0) out.workflow = l.slice('워크플로우: '.length);
    else if (l.indexOf(SYS_RETRY_MARK) === 0) out.error = l.slice(SYS_RETRY_MARK.length).trim();
  });
  return out;
}
// What a user turn is when soma-work put it there: { kind, label, line, raw,
// facts: [[term, value]] }, or null for a turn the user typed.
function sysTurnInfo(t) {
  if (!t || t.role !== 'user') return null;
  var raw = decodeSlackEntities(String(t.rawContent || ''));
  var head = raw.replace(/^\\s+/, '');
  var by = t.origin && t.origin.by ? t.origin.by : '';
  // A compaction turn: the recorder marks it (t.compact, from the executor —
  // a goal objective starting with "/compact" is literal, never marked). A turn
  // from before origins were kept is read from its text: the bare command.
  if (t.compact || (!by && raw.trim() === '/compact')) {
    var auto = by === 'system';
    var who = auto ? 'soma-work — 컨텍스트가 자동 압축 지점을 넘어 /compact 실행'
      : by === 'user' ? '사용자 요청' : '기록 없음 (출처를 저장하기 전의 턴)';
    return { kind: 'compact', label: auto ? '자동 압축' : '압축', line: '', raw: raw, facts: [['실행', who]] };
  }
  if (head.indexOf('Follow this exact sequence:') === 0 && head.indexOf('skill="local:save"') >= 0) {
    return { kind: 'renew', label: '세션 갱신', line: '컨텍스트 저장 (1/2)', raw: raw, facts: [['단계', '저장 — 다음 턴이 새 세션에서 불러옴']] };
  }
  if (by === 'user') return null;
  for (var i = 0; i < SYS_RESTART_HEADS.length; i++) {
    if (head.indexOf(SYS_RESTART_HEADS[i]) !== 0) continue;
    var ctx = sysResumeContext(raw);
    var facts = [];
    if (ctx.title) facts.push(['세션 제목', ctx.title]);
    if (ctx.workflow) facts.push(['워크플로우', ctx.workflow]);
    if (ctx.error) {
      facts.unshift(['이전 오류', ctx.error]);
      return { kind: 'retry', label: '자동 재시도', line: '오류 뒤 자동 재개 · ' + sysOneLine(ctx.error, 90), raw: raw, facts: facts };
    }
    facts.unshift(['원인', '서비스 재시작으로 중단된 작업']);
    return { kind: 'restart', label: '시스템 재시작', line: '중단된 작업 자동 재개' + (ctx.title ? ' · ' + sysOneLine(ctx.title, 60) : ''), raw: raw, facts: facts };
  }
  var g = /^\\[goal-continuation\\]\\s*/.exec(head);
  if (g) {
    var n = /Auto-continuation (\\d+)\\/(\\d+)/.exec(head);
    var reason = sysBetween(raw, '<previous-eval-reason>', '</previous-eval-reason>');
    var gf = [];
    if (n) gf.push(['회차', n[1] + ' / ' + n[2]]);
    if (reason) gf.push(['직전 평가에서 남은 일', reason]);
    return { kind: 'goal', label: n ? 'Goal #' + n[1] + '/' + n[2] : 'Goal', line: reason ? '직전 평가: ' + sysOneLine(reason, 90) : 'Goal 자동 계속', raw: raw, facts: gf };
  }
  // The host prompt that keeps a turn going while background work still runs
  // (packages/slack/src/pipeline/background-wait.ts buildBackgroundWaitPrompt).
  var bw = /^\\[background-work-resume (\\d+)\\/(\\d+)\\]/.exec(head);
  if (bw) {
    var bt = /You ended your turn while (\\d+) background tasks?(?: \\(([^)]*)\\))?/.exec(head);
    var what = bt ? bt[1] + '개' + (bt[2] ? ' (' + bt[2] + ')' : '') : '';
    var bf = [['회차', bw[1] + ' / ' + bw[2]]];
    if (what) bf.push(['실행 중인 작업', what]);
    bf.push(['이유', '턴이 끝났지만 런타임이 백그라운드 작업을 아직 실행 중으로 보고']);
    return { kind: 'bgwork', label: '백그라운드 재개 #' + bw[1] + '/' + bw[2], line: '실행 중인 백그라운드 작업' + (what ? ' ' + what : '') + ' — 턴을 이어감', raw: raw, facts: bf };
  }
  var c = /^\\[cron:([^\\]]+)\\]\\s*/.exec(head);
  if (c) {
    var prompt = head.slice(c[0].length);
    return { kind: 'cron', label: '크론', line: c[1] + (prompt ? ' · ' + sysOneLine(prompt, 80) : ''), raw: raw, facts: [['작업', c[1]]] };
  }
  if (head.indexOf("Use 'local:load' skill with this saved context:") === 0) {
    var instr = sysBetween(raw, '<user-instruction>', '</user-instruction>');
    var lf = [['단계', '불러오기 (2/2)']];
    if (instr) lf.push(['이어서 할 지시', instr]);
    return { kind: 'renew', label: '세션 갱신', line: '저장된 컨텍스트 불러오기' + (instr ? ' · ' + sysOneLine(instr, 70) : ''), raw: raw, facts: lf };
  }
  if (by === 'system') return { kind: 'system', label: '자동 입력', line: sysOneLine(head, 90), raw: raw, facts: [] };
  return null;
}
function cpClock(ms) {
  var s = Math.max(0, Math.round(toNum(ms) / 1000));
  return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
}
// A /compact turn's compaction. done: its result came. live: no result yet and
// younger than a compaction can run — cpTick confirms it is still the latest
// turn of a working session. unknown: no result and no longer running (from
// before results were kept, or it never ended).
function cpState(t, now, notLast) {
  var c = t.compact || {};
  var known = toNum(c.estimateMs) > 0;
  var st = { phase: 'unknown', c: c, start: toNum(t.timestamp), est: known ? toNum(c.estimateMs) : CP_DEFAULT_EST_MS, estKnown: known };
  if (c.endedAt) st.phase = 'done';
  else if (!notLast && (now || Date.now()) - st.start < CP_MAX_MS) st.phase = 'live';
  return st;
}
function cpProgressHtml(elapsed, est) {
  var over = elapsed > est;
  var pct = Math.max(0, Math.min(99, Math.floor((elapsed / est) * 100)));
  // The times first: on a narrow row the ellipsis cuts the overdue words before them.
  return '<span class="sys-line"><span class="cp-time"><span class="cp-verb">압축 중 · </span>' + cpClock(elapsed) + ' / 약 ' + cpClock(est) + '</span>'
    + (over ? '<span class="cp-over"> · 예상보다 오래 걸리는 중</span>' : '') + '</span>'
    // Decoration: inside <summary> (a button) AT drops a progressbar role — the
    // line's own text carries elapsed / estimate and the percentage.
    + '<span class="cp-bar' + (over ? ' is-over' : '') + '" aria-hidden="true"><i style="width:' + pct + '%"></i></span>'
    + (over ? '' : '<span class="cp-pct">' + pct + '%</span>');
}
// The one line of a /compact turn: progress while it runs, its numbers once done.
function cpLineHtml(info, st, now) {
  if (st.phase === 'live') return cpProgressHtml((now || Date.now()) - st.start, st.est);
  return '<span class="sys-line">' + esc(cpDoneText(info, st)) + '</span>';
}
// Pure: a /compact that is not running, in words — its numbers once done.
function cpDoneText(info, st) {
  var parts = [info.label + ' 처리'];
  var c = st.c;
  if (st.phase === 'done' && c.preTokens != null && c.postTokens != null) parts.push(formatTokens(c.preTokens) + ' → ' + formatTokens(c.postTokens) + ' 토큰');
  if (st.phase === 'done' && toNum(c.durationMs) > 0) parts.push(formatDuration(c.durationMs));
  return parts.join(' · ');
}
function cpFacts(st) {
  var c = st.c;
  var f = [['상태', st.phase === 'done' ? '완료' : st.phase === 'live' ? '진행 중' : '결과 기록 없음', 'cp-state']];
  if (st.phase === 'done' && c.preTokens != null && c.postTokens != null) {
    var pre = toNum(c.preTokens);
    var cut = pre > 0 ? Math.round((1 - toNum(c.postTokens) / pre) * 100) : 0;
    f.push(['압축 전 → 후', pre.toLocaleString('en-US') + ' → ' + toNum(c.postTokens).toLocaleString('en-US') + ' 토큰' + (pre > 0 ? ' (−' + cut + '%)' : '')]);
  }
  if (st.phase === 'done' && toNum(c.durationMs) > 0) f.push(['걸린 시간', formatDuration(c.durationMs)]);
  f.push(['예상 시간', formatDuration(st.est) + (st.estKnown ? ' (직전 압축 기준)' : ' (기본값)')]);
  if (c.trigger) f.push(['SDK trigger', c.trigger]);
  if (c.endedAt) f.push(['끝난 시각', new Date(toNum(c.endedAt)).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })]);
  return f;
}
function sysFactsHtml(facts) {
  if (!facts.length) return '';
  return '<dl class="sys-facts">' + facts.map(function(f) {
    return '<dt>' + esc(f[0]) + '</dt><dd' + (f[2] ? ' class="' + f[2] + '"' : '') + '>' + esc(f[1]) + '</dd>';
  }).join('') + '</dl>';
}
function cpEnsureTicker() {
  if (_cpTimer || typeof setInterval !== 'function') return;
  _cpTimer = setInterval(cpTick, 1000);
}
// Every second while a compaction runs in an open card: its elapsed time and
// progress. It stops being live once the session stopped working, or it
// outlived any compaction — then it says no result was kept.
function cpTick() {
  // An open inbox card's 응답 (ioCompactOutHtml): live while its session works.
  // (지시와 답변's own /compact row ticks inside <ui-conversation>.)
  var cardNodes = document.querySelectorAll('.card-io [data-cp-live]');
  if (!cardNodes.length) {
    clearInterval(_cpTimer);
    _cpTimer = 0;
    return;
  }
  var now = Date.now();
  for (var j = 0; j < cardNodes.length; j++) {
    var cn = cardNodes[j];
    var card = cn.closest ? cn.closest('.card-slot[data-session-key]') : null;
    var cs = card ? _sessionCache[card.getAttribute('data-session-key')] : null;
    var cstart = toNum(cn.getAttribute('data-cp-start'));
    var cslot = cn.querySelector('.cp-slot');
    if (cs && cs.activityState === 'working' && now - cstart < CP_MAX_MS) {
      if (cslot) cslot.innerHTML = cpProgressHtml(now - cstart, toNum(cn.getAttribute('data-cp-est')) || CP_DEFAULT_EST_MS);
      continue;
    }
    cn.removeAttribute('data-cp-live');
    if (cslot) cslot.innerHTML = '<span class="sys-line">' + esc((cn.getAttribute('data-cp-label') || '압축') + ' 처리') + '</span>';
  }
}
// A rough token count for a skill body: ~4 ASCII characters or 1 other
// character (Hangul, CJK, emoji) per token. Labeled an estimate wherever shown.
function estimateTokens(s) {
  var str = String(s || '');
  var ascii = 0;
  for (var i = 0; i < str.length; i++) if (str.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (str.length - ascii));
}
// The <invoked_skills> block a $skill / autoskill appends to the instruction
// (skill-force-handler.ts, autoskill-fire.ts): the user's own text, and each
// skill as { name, body, tokens }.
function splitInvokedSkills(raw) {
  var s = String(raw == null ? '' : raw);
  var OPEN = '<invoked_skills>';
  var CLOSE = '</invoked_skills>';
  var text = '';
  var skills = [];
  var from = 0;
  // Every closed block (a session's first turn carries two: autoskill, then the
  // deferred $skill). Each block starts at the last <invoked_skills> before its
  // closing tag, so a literal mention in the words stays words; so does one
  // never closed.
  for (;;) {
    var end = s.indexOf(CLOSE, from);
    if (end < 0) {
      text += s.slice(from);
      break;
    }
    var at = s.lastIndexOf(OPEN, end);
    if (at < from) {
      // A stray closing tag in the words: words, and look on past it.
      text += s.slice(from, end + CLOSE.length);
      from = end + CLOSE.length;
      continue;
    }
    text += s.slice(from, at);
    var inner = s.slice(at + OPEN.length, end);
    var before = skills.length;
    var i = 0;
    while (i < inner.length) {
      var m = /<([^\\s<>\\/]+)>/.exec(inner.slice(i));
      if (!m) break;
      var name = m[1];
      var bodyAt = i + m.index + m[0].length;
      var closeTag = '</' + name + '>';
      var bodyEnd = inner.indexOf(closeTag, bodyAt);
      if (bodyEnd < 0) {
        // A tag never closed is not a skill — skip it, keep reading.
        i = bodyAt;
        continue;
      }
      var body = inner.slice(bodyAt, bodyEnd).replace(/^\\n+|\\s+$/g, '');
      skills.push({ name: name, body: body, tokens: estimateTokens(body) });
      i = bodyEnd + closeTag.length;
    }
    // A closed block that held no skill is words too.
    if (skills.length === before) text += s.slice(at, end + CLOSE.length);
    from = end + CLOSE.length;
  }
  return { text: skills.length ? text.replace(/\\s+$/, '') : s, skills: skills };
}
// The skills a turn invoked, as badges (name · estimated tokens). A badge opens
// that skill's body under the row — one at a time; the body is written on
// first open, not with every turn.
function skillBadgesHtml(key, skills) {
  if (!skills.length) return '';
  var base = 'skd-' + String(key || 'n' + (++_skillSeq)).replace(/[^A-Za-z0-9_-]/g, '');
  var badges = '';
  var panes = '';
  for (var i = 0; i < skills.length; i++) {
    var id = base + '-' + i;
    _skillBodies[id] = skills[i];
    badges += '<button type="button" class="skill-badge" aria-expanded="false" aria-controls="' + id + '" data-skill="' + id + '" onclick="skillToggle(this)"'
      + ' title="토큰 수는 추정치 — 영문 4자 또는 그 밖의 글자 1자를 1토큰으로 셈">'
      + '<span class="skill-name">' + esc(skills[i].name) + '</span><span class="skill-tok">≈' + formatTokens(skills[i].tokens) + ' tokens</span></button>';
    panes += '<div class="skill-detail" id="' + id + '" hidden></div>';
  }
  return '<div class="skill-badges" role="group" aria-label="활성화된 스킬 ' + skills.length + '개">' + badges + '</div>' + panes;
}
function skillToggle(btn) {
  var id = btn.getAttribute('data-skill');
  var opening = btn.getAttribute('aria-expanded') !== 'true';
  var row = btn.parentNode;
  var open = row ? row.querySelectorAll('.skill-badge[aria-expanded="true"]') : [];
  for (var i = 0; i < open.length; i++) {
    open[i].setAttribute('aria-expanded', 'false');
    var pane = document.getElementById(open[i].getAttribute('data-skill'));
    if (pane) pane.hidden = true;
  }
  if (!opening) return;
  var d = document.getElementById(id);
  var sk = _skillBodies[id];
  if (!d || !sk) return;
  if (!d.firstChild) d.innerHTML = skillPaneHtml(sk);
  d.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
}
function skillPaneHtml(sk) {
  return '<div class="skill-detail-h"><span class="skill-name">' + esc(sk.name) + '</span><span class="skill-tok">≈' + formatTokens(sk.tokens) + ' tokens (추정)</span></div>'
    + '<pre class="skill-body">' + esc(sk.body) + '</pre>';
}

// SSOT 2026-10-29 T8: the answers' name — the Slack bot that runs the session
// (its card's botName — a sibling instance's own bot), else this instance's.
function botNameOf(s) {
  return (s && s.botName) || BOT_NAME || 'Assistant';
}
// ── 지시와 답변 — @2lab.ai/ui <ui-conversation> (D3: G-01..G-13, E-25) ──
// The section's turns are the library element's: the instruction (clamped,
// the media above it, the skills it invoked as chips), the answer (a nested
// <ui-ai-answer flat>, its response time in the head, Raw: summary · source),
// a turn soma-work put there (one line + badge that opens to its facts and the
// raw prompt; a running /compact's progress ticking in place), the writing row,
// and the scroll box itself (<ui-log-scroller>: it follows the newest turn,
// keeps the reader's place while an older page goes in above, and counts what
// arrived below). The dashboard keeps the data — the pages it fetched
// (_panelTurnsList), the answers it loaded (_rawLoadedCache), the files of each
// turn — hands the element turns built from it (convPaint), and answers its
// requests: ui-load-older → loadMorePanelTurns, ui-retry → the answer (or the
// page) again.
function convEl() {
  return document.getElementById('panel-conv');
}
// What the list says without turns (G-13: in Korean, the element's own empty state).
var CONV_EMPTY = { none: '아직 대화가 없습니다', unrecorded: '기록된 대화가 없습니다' };
// Pure: the turn's summary — the heading of an answer that is empty or failed,
// and Raw's 요약 view: its title and body, else that it is still being made or failed.
function convSummaryOf(t) {
  var title = t && t.summaryTitle ? String(t.summaryTitle) : '';
  var text = t && t.summaryBody ? String(t.summaryBody) : t && t.summarized ? STRINGS.summaryFailed : STRINGS.summaryPending;
  var out = {};
  if (title) out.title = title;
  if (text) out.text = text;
  return out;
}
// Pure: a turn soma-work put there (sysTurnInfo) as the element's system turn —
// its badge (kind + label), one line, the facts and the raw prompt. A /compact
// still running (the latest turn of a working session, younger than a
// compaction can run) carries its progress; once done, its numbers.
function convSysTurn(t, info, id, at, c, notLast) {
  var x = { id: id, role: 'system', name: 'System', kind: info.kind === 'bgwork' ? 'background' : info.kind, label: info.label, text: info.line };
  if (at) x.at = at;
  var facts = info.facts;
  if (info.kind === 'compact') {
    var st = cpState(t, c.now, notLast);
    if (st.phase === 'live' && !c.working) st.phase = 'unknown';
    facts = facts.concat(cpFacts(st));
    if (st.phase === 'live') x.progress = { startedAt: st.start, estimateMs: st.est, verb: '압축 중…' };
    else x.text = cpDoneText(info, st);
  }
  // The files the turn carried (the message an auto-compact intercepted): a
  // system turn has no media slot in the element (D3-GAPS G1-2) — their names.
  var atts = Array.isArray(t.attachments) ? t.attachments.filter(function(f) { return f && f.id; }) : [];
  if (atts.length) facts = facts.concat([['첨부 파일', atts.map(function(f) { return String(f.name || f.id); }).join(', ')]]);
  if (facts.length) x.facts = facts.map(function(f) { return [String(f[0]), String(f[1])]; });
  if (info.raw) x.raw = String(info.raw);
  return x;
}
// Pure: the element's turns for the main agent's turns (oldest first), and the
// slotted children they ask for — a user's files (media-<id>) and the files an
// answer produced (attachments-<id>: an artifact goes to the first answer whose
// turn window holds its turn start). c: { cid, bot, now, working, answers
// (cache key → raw), failed (cache key → why), arts, titles }.
function convTurnsOf(list, c) {
  var turns = [];
  var slots = [];
  var used = Object.create(null);
  var start = 0;
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!t) continue;
    var ts = toNum(t.timestamp);
    var id = String(t.id || (t.role + ':' + ts + ':' + i));
    var at = ts > 0 ? ts : 0;
    var prev = i > 0 ? list[i - 1] : null;
    if (t.role === 'user') {
      var atts = Array.isArray(t.attachments) ? t.attachments.filter(function(a) { return a && a.id; }) : [];
      var sys = sysTurnInfo(t);
      if (sys) turns.push(convSysTurn(t, sys, id, at, c, i < list.length - 1));
      else {
        var said = splitInvokedSkills(decodeSlackEntities(t.rawContent || ''));
        var u = { id: id, role: 'user', name: String(t.userName || 'User'), text: said.text };
        if (at) u.at = at;
        if (atts.length) {
          u.media = true;
          slots.push({ name: 'media-' + id, kind: 'media', list: atts, turn: t });
        }
        if (said.skills.length) u.skills = said.skills.map(function(sk) { return { name: sk.name, tokens: sk.tokens, text: sk.body }; });
        turns.push(u);
      }
    } else {
      var a = { id: id, role: 'assistant', name: c.bot };
      if (at) a.at = at;
      var sum = convSummaryOf(t);
      if (sum.title || sum.text) a.summary = sum;
      // D11 — from the instruction to the recorded answer; an optimistic
      // instruction carries this browser's clock, not the server's: no time.
      var pts = prev ? toNum(prev.timestamp) : 0;
      if (prev && prev.role === 'user' && pts > 0 && ts > pts && String(prev.id || '').indexOf('optimistic-') !== 0) a.responseMs = ts - pts;
      if (t.id && c.cid) {
        var key = ansCacheKey(c.cid, t.id);
        var raw = c.answers[key];
        if (typeof raw === 'string') {
          a.markdown = raw;
          if (c.titles && Object.keys(c.titles).length) a.linkTitles = c.titles;
        } else if (c.failed[key]) {
          a.markdown = '';
          a.error = String(c.failed[key]);
          a.canRetry = true;
        } else a.loading = true;
      } else a.markdown = '';
      var mine = (c.arts || []).filter(function(x) { return x && !used[x.id] && artInTurn(x, start, ts); });
      mine.forEach(function(x) { used[x.id] = true; });
      if (mine.length) {
        a.attachments = true;
        slots.push({ name: 'attachments-' + id, kind: 'arts', list: mine, start: start, end: ts });
      }
      turns.push(a);
    }
    start = ts;
  }
  return { turns: turns, slots: slots };
}
// The slotted children the turns ask for: written when their markup changed,
// removed when no turn asks for them (the files keep the page's own handlers:
// the viewer, the hover preview — they stay in the light DOM).
function convSlots(el, slots, cid) {
  var want = Object.create(null);
  for (var i = 0; i < slots.length; i++) {
    var sl = slots[i];
    if (sl.kind === 'media') umRegister(cid, sl.list, sl.turn);
    want[sl.name] = sl.kind === 'media' ? renderUserMedia(cid, sl.list) : renderTurnArtifacts(sl.list, cid, sl.start, sl.end);
  }
  var kids = Array.prototype.slice.call(el.children);
  for (var k = 0; k < kids.length; k++) {
    var name = kids[k].getAttribute('slot') || '';
    if (!(name in want)) {
      kids[k].remove();
      continue;
    }
    if (kids[k]._html !== want[name]) {
      kids[k].innerHTML = want[name];
      kids[k]._html = want[name];
    }
    delete want[name];
  }
  for (var n in want) {
    var d = document.createElement('div');
    d.slot = n;
    d.className = n.indexOf('media-') === 0 ? 'cv-media-slot' : 'cv-arts-slot';
    d.innerHTML = want[n];
    d._html = want[n];
    el.appendChild(d);
  }
}
// The element's data, written only when it changed (a poll that changes
// nothing re-renders nothing); the turns still loading their answer are
// watched once the element has rendered them.
function convSetData(el, d) {
  var sig = JSON.stringify(d);
  if (el._convSig === sig) return;
  el._convSig = sig;
  el.data = d;
  queueMicrotask(function() { convWatchAnswers(el); });
}
// The section's data now: the main agent's turns, or a subagent's 지시와 답변.
function convPaint() {
  var el = convEl();
  if (!el || _psec !== 'conv') return;
  if (_panelAgent) {
    renderAgentConv();
    return;
  }
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var cid = _panelTurnsCid || panelConvId || '';
  // The board refills the cache in one pass: a session missing from a loaded
  // board is not running; before the board's first load it is undecided.
  var working = s ? s.activityState === 'working' : Object.keys(_sessionCache).length === 0;
  var built = convTurnsOf(_panelTurnsList, {
    cid: cid, bot: botNameOf(s), now: Date.now(), working: working,
    answers: _rawLoadedCache, failed: _ansFailed,
    arts: cid && _artCache[cid] ? _artCache[cid].list || [] : [],
    titles: ansLinkTitles(ansSession(cid)),
  });
  var last = _panelTurnsList.length ? _panelTurnsList[_panelTurnsList.length - 1] : null;
  var msg = _panelTurnsMsg;
  var d = {
    turns: built.turns,
    hasMore: !!_panelTurnsHasMore,
    loading: msg === 'loading' || !!_panelTurnsLoading,
    // D12 — the writing row: the session works and the latest turn is the instruction.
    pending: ansPendingShow(s, panelConvId, last ? last.role : ''),
    assistantName: botNameOf(s),
    // T1.3 — a long instruction folds to 12 lines; 자세히 shows it whole.
    clampLines: _panelDetail ? 200 : 12,
    label: '지시와 답변',
    emptyText: CONV_EMPTY[msg] || CONV_EMPTY.none,
    startText: '대화의 시작',
  };
  var why = msg === 'failed' ? _panelTurnsWhy || '네트워크 오류' : _panelOlderWhy;
  if (why) d.error = why;
  convSlots(el, built.slots, cid);
  convSetData(el, d);
}
// Several answers land in one frame: one paint.
var _convPaintQueued = false;
function convPaintSoon() {
  if (_convPaintQueued) return;
  _convPaintQueued = true;
  requestAnimationFrame(function() {
    _convPaintQueued = false;
    convPaint();
  });
}
// A new turn (a WS push, or this browser's own instruction — own: the reader
// goes to it) into 지시와 답변's data, in place of the one with its id
// (replaceId: the optimistic turn the server's took over), else at the end.
// The element follows a reader at the newest and counts it for one higher up.
function appendTurnToPanel(turn, own, replaceId) {
  if (!turn) return;
  ptUpsert(_panelTurnsList, turn, replaceId);
  if (_panelTurnsMsg !== 'loading') _panelTurnsMsg = '';
  if (_psec !== 'conv' || _panelAgent || _panelTurnsMsg === 'loading') return;
  convPaint();
  var el = convEl();
  if (own && el && typeof el.scrollToLatest === 'function') el.scrollToLatest();
}
// A turn leaves the data (an instruction that could not be sent).
function dropTurnFromPanel(id) {
  for (var i = _panelTurnsList.length - 1; i >= 0; i--) {
    if (_panelTurnsList[i] && _panelTurnsList[i].id === id) {
      _panelTurnsList.splice(i, 1);
      convPaint();
      return true;
    }
  }
  return false;
}

var _rawLoadedCache = Object.create(null);
// Cache key → why its answer could not be had (this panel opening): the answer
// says so with 다시 시도 (the element's ui-retry with the turn id).
var _ansFailed = Object.create(null);
// Task view T1.4 — every answer loads as its turn nears the view (one fetch per
// answer, then the cache); an answer already cached is in the turn at once.
var _ansIo = null;
function convWatchAnswers(el) {
  if (!el || typeof el.turnElement !== 'function' || _psec !== 'conv' || _panelAgent) return;
  var d = el.data;
  var turns = d && d.turns ? d.turns : [];
  var cid = _panelTurnsCid || panelConvId || '';
  // #488 — a turn rebuilt (or gone) is a new node: the one it replaced is no longer watched.
  if (_ansIo) _ansIo._nodes = _ansIo._nodes.filter(function(n) {
    if (n.isConnected) return true;
    _ansIo.unobserve(n);
    return false;
  });
  for (var i = 0; i < turns.length; i++) {
    if (!turns[i].loading) continue;
    var node = el.turnElement(turns[i].id);
    if (!node || node._ansWatched) continue;
    node._ansWatched = true;
    node._ansCid = cid;
    if (!_ansIo && typeof IntersectionObserver === 'function') {
      _ansIo = new IntersectionObserver(function(entries) {
        entries.forEach(function(en) {
          if (!en.isIntersecting) return;
          _ansIo.unobserve(en.target);
          _ansIo._nodes = _ansIo._nodes.filter(function(n) { return n !== en.target; });
          convLoadAnswer(en.target._ansCid, en.target.getAttribute('data-item'));
        });
      }, { rootMargin: '800px 0px' });
      _ansIo._nodes = [];
    }
    if (_ansIo) {
      _ansIo.observe(node);
      _ansIo._nodes.push(node);
    } else convLoadAnswer(cid, turns[i].id);
  }
}
// ── AI answer (.prd/affectui/re-ai-answer.md) ──
// The dashboard fetches and caches each answer (convLoadAnswer), titles the
// links it knows (the session's PR and issue), and hands the element the turn
// with the answer, loading, or why it failed (다시 시도 → ui-retry).
// Pure (D5): the link titles the dashboard already knows — the session's PR and
// issue (the PR's wins when both are one URL).
function ansLinkTitles(s) {
  var t = {};
  if (s && s.issueUrl && s.issueTitle) t[String(s.issueUrl)] = String(s.issueTitle);
  if (s && s.prUrl && s.prTitle) t[String(s.prUrl)] = String(s.prTitle);
  return t;
}
// The panel's session, when it is the one this conversation belongs to (D5 titles).
function ansSession(cid) {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  return s && s.conversationId === cid ? s : null;
}
// Turn ids are unique per conversation only: the raw cache is keyed by both.
function ansCacheKey(convId, turnId) {
  return String(convId || '') + ':' + String(turnId || '');
}
// The request in flight per cache key and panel opening — a turn rebuilt
// mid-fetch joins it instead of asking again.
var _ansInflight = Object.create(null);
// D1 · D13 — the first time a turn nears the view its answer is fetched; later
// paints use the cache. A response lands only while it is current (review R1):
// for this panel opening (_panelGen) and if no newer request replaced it.
function convLoadAnswer(cid, id) {
  if (!cid || !id) return;
  var key = ansCacheKey(cid, id);
  if (typeof _rawLoadedCache[key] === 'string' || _ansFailed[key]) return;
  var gen = _panelGen;
  var req = _ansInflight[key];
  if (req && req.gen === gen) return;
  req = { gen: gen };
  _ansInflight[key] = req;
  fetch('/api/conversations/' + encodeURIComponent(cid) + '/turns/' + encodeURIComponent(id) + '/raw')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
      if (_ansInflight[key] !== req) return;
      delete _ansInflight[key];
      if (req.gen !== _panelGen) return;
      _rawLoadedCache[key] = data && typeof data.raw === 'string' ? data.raw : '';
      convPaintSoon();
    }, function(err) {
      if (_ansInflight[key] !== req) return;
      delete _ansInflight[key];
      if (req.gen !== _panelGen) return;
      _ansFailed[key] = String((err && (err.message || err.name)) || 'Error');
      convPaintSoon();
    });
}
// D13 — 다시 시도: on an answer (the turn's id) fetches it again; on the list
// (id null) the page that failed — the first, or the older one.
function convRetry(id) {
  if (id === null || id === undefined) {
    if (_panelAgent) return;
    if (_panelTurnsMsg === 'failed') {
      _panelTurnsMsg = 'loading';
      _panelTurnsWhy = '';
      convPaint();
      loadPanelTurns();
    } else if (_panelOlderWhy) {
      _panelOlderWhy = '';
      convPaint();
      loadMorePanelTurns();
    }
    return;
  }
  if (_panelAgent) {
    var el = convEl();
    if (el && el._agentSeq != null) agentConvRetry(el._agentSeq);
    return;
  }
  var cid = _panelTurnsCid || panelConvId || '';
  var key = ansCacheKey(cid, id);
  if (!_ansFailed[key]) return;
  delete _ansFailed[key];
  convPaint();
  convLoadAnswer(cid, id);
}
// D12 — the same rule the card's 응답 row uses (renderCardIo): the session is
// working and the latest turn is the instruction.
function ansPendingShow(s, convId, lastRole) {
  return !!(s && convId && s.conversationId === convId && s.activityState === 'working' && lastRole === 'user');
}
// One-time wiring: the element's requests (older page, try again) and, once its
// module has loaded, a paint of what it was handed before it could render.
(function initConversation() {
  var el = convEl();
  if (!el) return;
  el.addEventListener('ui-load-older', function(e) {
    if (_panelAgent || !_panelTurnsHasMore || _panelTurnsLoading) {
      e.preventDefault();
      return;
    }
    loadMorePanelTurns();
  });
  el.addEventListener('ui-retry', function(e) {
    var d = e.detail || {};
    convRetry(d.id);
  });
  if (window.customElements && customElements.whenDefined) {
    customElements.whenDefined('ui-conversation').then(function() {
      el._convSig = '';
      convPaint();
    });
  }
})();

// Panel subtitle (titleSub). Reads are open to every signed-in viewer (#716);
// so is filling a MISSING subtitle (POST ensure-title — it never overwrites).
// Replacing one (POST generate-title) stays with the owner or an admin in Admin
// mode, so 🔄 over an existing subtitle is offered to them only. 🔄 on a
// missing subtitle retries the fill and is offered to everyone.
function titleSubCanRegen(ownerId, viewerId, viewerIsAdmin, adminModeOn) {
  if (ownerId && ownerId === viewerId) return true;
  return !!(viewerIsAdmin && adminModeOn);
}
function panelTitleSubCanRegen() {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  return titleSubCanRegen(s && s.ownerId, _viewerUserId, _viewerIsAdmin, _isAdminModeOn());
}
function titleSubEndpoint(convId, regenerate) {
  return '/api/dashboard/session/' + encodeURIComponent(convId) + (regenerate ? '/generate-title' : '/ensure-title');
}
// Only a stale CSRF token earns the refresh + retry; any other 403 is a refusal.
function isCsrfRejection(status, data) {
  return status === 403 && !!data && data.code === 'csrf_failed';
}
// What the subtitle row shows after a reply. A permission refusal is not a
// generation failure: it keeps whatever was there and offers no 🔄.
function titleSubView(status, data, canRegen, previous) {
  if (data && data.titleSub) return { text: data.titleSub, titleSub: data.titleSub, regen: canRegen };
  if (status === 403 && !isCsrfRejection(status, data)) {
    return { text: previous || READ_ONLY_MSG, titleSub: previous || '', regen: false };
  }
  var code = data && data.code;
  var text = code === 'cooldown' ? STRINGS.titleCooldown
    : code === 'no_content' ? STRINGS.titleNoContent
    : STRINGS.titleFailed;
  return { text: text, titleSub: previous || '', regen: true };
}

async function generateTitleSub(convId, regenerate) {
  // The panel opening this request belongs to: once another panel opens (or
  // this one closes) the subtitle element shows someone else, so drop the result.
  var gen = _panelGen;
  var textEl = document.getElementById('panel-title-sub-text');
  var btn = document.getElementById('panel-title-sub-regen');
  var previous = _panelTitleSub;
  textEl.textContent = STRINGS.titlePending;
  btn.style.display = 'none';
  try {
    // #771 — CSRF-protected POST: attach X-CSRF-Token; when the server says the
    // token went stale (JWT rotation), refresh it and retry once.
    var url = titleSubEndpoint(convId, regenerate);
    var post = function() {
      var headers = {};
      if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
      return fetch(url, { method: 'POST', headers: headers });
    };
    var res = await post();
    if (gen !== _panelGen) return;
    var data = await res.json().catch(function() { return null; });
    if (gen !== _panelGen) return;
    if (isCsrfRejection(res.status, data)) {
      await refreshCsrfToken();
      if (gen !== _panelGen) return;
      res = await post();
      if (gen !== _panelGen) return;
      data = await res.json().catch(function() { return null; });
      if (gen !== _panelGen) return;
    }
    var view = titleSubView(res.status, data, panelTitleSubCanRegen(), previous);
    _panelTitleSub = view.titleSub;
    textEl.textContent = view.text;
    btn.style.display = view.regen ? 'inline-block' : 'none';
  } catch(e) {
    if (gen !== _panelGen) return;
    textEl.textContent = previous || STRINGS.error;
    btn.style.display = !previous || panelTitleSubCanRegen() ? 'inline-block' : 'none';
  }
}

function closePanel() {
  var closingKey = panelSessionKey;
  if (closingKey) deckRemove(closingKey);
  // Task view: a closed panel keeps no mic, no files and watches no answers.
  pcReset();
  if (_ansIo) { _ansIo.disconnect(); _ansIo = null; }
  layoutBeforeChange();
  document.getElementById('slide-panel').classList.remove('open');
  document.getElementById('panel-overlay').classList.remove('open');
  panelOpen = false;
  panelSessionKey = null;
  panelConvId = null;
  var panelArts = document.getElementById('panel-artifacts');
  if (panelArts) { panelArts.innerHTML = ''; panelArts.style.display = 'none'; }
  _panelAgent = '';
  _panelAgentsHtml = '';
  _rawLoadedCache = Object.create(null);
  _ansFailed = Object.create(null);
  _panelOlderWhy = '';
  _panelTurnsWhy = '';
  _panelGen++;
  _panelTurnsHasMore = false;
  _panelTurnsLoading = false;
  _panelTurnsOldestId = null;
  _panelTurnsList = [];
  _panelTurnsMsg = '';
  resetWorkLog(null);
  // A closed panel holds no section nodes.
  for (var si = 0; si < PSEC_ORDER.length; si++) psecClear(PSEC_ORDER[si]);
  psecSetNew(0);
  _panelLand = '';
  _panelLanded = false;
  _panelHold = false;
  _panelOnQuestion = false;
  renderDeckNav(0);
  // Focus goes back to whatever opened the panel (a tree item, a card button)
  // when it was in the panel; an opener that is gone (a folded DONE date, a
  // hidden archive) hands it to that session's open card (its 작업 로그), else
  // the board heading.
  var back = _panelReturnFocus;
  _panelReturnFocus = null;
  var a = document.activeElement;
  var wasInPanel = !a || a === document.body || !!(a.closest && a.closest('#slide-panel'));
  if (!wasInPanel) return;
  // An opener inside a card that has since folded (inert) cannot take focus: fall through.
  if (back && document.body.contains(back) && back.focus) {
    back.focus({ preventScroll: true });
    if (document.activeElement === back) return;
  }
  var body = closingKey && _cardBodies[closingKey] ? _cardBodies[closingKey].el : null;
  var log = body && body.isConnected ? body.querySelector('[data-card-worklog]') : null;
  if (log) {
    log.focus({ preventScroll: true });
    if (document.activeElement === log) return;
  }
  var heading = document.querySelector('.board-title, h1, h2');
  if (heading && heading.focus) { if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}

document.addEventListener('keydown', function(e) {
  // Escape in the artifact viewer closes the viewer only (the dialog's own cancel).
  // The cron drawer opens over a docked panel: Escape closes only that, the topmost. An element on top that
  // took the key (the drawer, the defaults menu, a dialog: preventDefault) keeps it from the panel too.
  if (e.key === 'Escape' && !e.defaultPrevented && panelOpen && !artModalIsOpen() && !_cronDrawerKey) closeDetailCard();
});

// The panel's own scroll (bound once): a held section landing goes back under
// the tabs while the panel settles, until the reader acts; a section landing the
// body was still too short for lands as it grows. Older pages and the newest
// items are each section box's (initPanelSections).
(function initPanelScrollHandler() {
  var scrollEl = document.getElementById('panel-scroll');
  if (!scrollEl) return;
  scrollEl.addEventListener('scroll', function() {
    if (_panelHold && panelOpen) holdPanelLanding();
  }, { passive: true });
  // Any input inside the panel (reading, typing, a tab) means the reader took over.
  var panel = document.getElementById('slide-panel');
  if (panel) {
    ['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function(type) {
      panel.addEventListener(type, function() { _panelHold = false; }, { passive: true, capture: true });
    });
  }
  if (typeof ResizeObserver === 'function') {
    var land = new ResizeObserver(function() {
      if (_panelHold && panelOpen) holdPanelLanding();
      // A section landing the body was still too short for (the parts load
      // after the opening) lands as it grows; a reader who scrolled meanwhile stays.
      else if (panelOpen && !_panelLanded && (_panelLand === 'goal' || _panelLand === 'agent' || _panelLand === 'tasks')) landPanel();
    });
    land.observe(scrollEl);
    ['panel-surface', 'panel-sections-body'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) land.observe(el);
    });
  }
})();

// ── Send command (optimistic UI) ──
let _lastSentContent = '';
let _lastSentTime = 0;

// A note from the composer — Enter, ⌘/Ctrl+Enter, Send, or Retry on a failed one
// (<ui-agent-steering> ui-submit: text, ref) — to the session's command route, the
// one path a dashboard instruction takes: while a turn runs the server queues it
// (and steers it into that turn when it can — the host decides, so ⌘/Ctrl+Enter
// goes the same way), idle it starts the next turn. The element shows the note at
// once (running: as a row until the queue lists it); idle, the turn shows in the
// transcript. A send that cannot go out puts the text back; one the server refuses
// is marked failed on its row (Retry) and said in a toast.
async function sendCommand(text, ref) {
  var el = document.getElementById('cmd-steer');
  if (!panelSessionKey || !el) return;
  // Capture the session this send belongs to — before any wait: an instruction
  // is never sent to a card opened meanwhile.
  const sendingSessionKey = panelSessionKey;
  var running = !!(el.data && el.data.running);
  var msg = String(text || '').trim();
  var files;
  _pcSending = true;
  try {
    // Task view T1.5: a recording in progress is the user's last words — filed first.
    // A recording running now, or stopped but not filed yet (a send that timed out before).
    var filing = _pcRec ? pcStopRecording(true) : _pcFiling;
    if (filing) {
      var filed = await Promise.race([
        filing.then(function() { return true; }),
        new Promise(function(resolve) { setTimeout(function() { resolve(false); }, 3000); }),
      ]);
      // #488: never send without the voice note the user just recorded — it is
      // filed as a chip when the recorder catches up; the text stays for a resend.
      if (!filed) {
        pcSetError('음성 녹음을 아직 마무리하는 중입니다 — 잠시 후 다시 보내 주세요');
        pcGiveBack(el, ref, msg, sendingSessionKey);
        return;
      }
    }
    files = _pcFiles.slice();
    if (!pcCanSend(msg, files)) { pcGiveBack(el, ref, msg, sendingSessionKey); return; }
    // Every file read in full (a failed read removes its chip and says so).
    try {
      await Promise.all(files.map(function(f) { return f.ready; }));
    } catch (_e) {
      pcGiveBack(el, ref, msg, sendingSessionKey);
      return;
    }
  } finally {
    _pcSending = false;
  }
  // The card changed while the files were read: this instruction was for the other one (its files went with pcReset).
  if (panelSessionKey !== sendingSessionKey) return;

  // Optimistic, idle only: the turn this starts shows in the transcript at once
  // (its files by name — the recorded turn brings their previews). A note sent
  // while a turn runs shows in the queue instead.
  var optimisticId = '';
  if (!running) {
    const shown = msg + (files.length ? (msg ? '\\n' : '') + '📎 ' + files.map(function(f) { return f.name; }).join(', ') : '');
    _lastSentContent = msg;
    _lastSentTime = Date.now();
    optimisticId = 'optimistic-' + Date.now();
    appendTurnToPanel({
      id: optimisticId,
      role: 'user',
      timestamp: Date.now(),
      userName: 'You',
      rawContent: shown,
      origin: { by: 'user' },
      _optimistic: true,
    }, true);
  }

  var why = '';
  try {
    const cmdUrl = '/api/dashboard/session/' + encodeURIComponent(sendingSessionKey) + '/command';
    const res = await acPost(cmdUrl, JSON.stringify(pcCommandBody(msg, files)));
    if (!res.ok) {
      var data = {};
      try { data = await res.json(); } catch (_e) {}
      why = ((data && data.error) || '') + ' (HTTP ' + res.status + ')';
    }
  } catch (e) {
    why = (e && e.message) || '네트워크 오류';
  }
  // Only the card that sent it changes: a late answer never touches the card opened meanwhile.
  if (panelSessionKey !== sendingSessionKey) return;
  // The session left the board meanwhile (archived, a folded day): fail closed. The next live
  // render that finds it again re-applies its real state (the mode cache is cleared).
  if (!_sessionCache[sendingSessionKey]) {
    var cmdHost = document.getElementById('panel-command');
    if (cmdHost) cmdHost._mode = '';
    el._sig = '';
    el.data = Object.assign({}, el.data, { disabled: true });
  }
  if (!why) {
    // Sent: the files went with it. Failed: they stay attached for the retry.
    files.forEach(function(f) { pcRemoveFile(f.id); });
    return;
  }
  // Not sent: the note's row says so with Retry (the element's), and the
  // optimistic turn leaves the transcript — found by its own id, not by being the
  // list's last child (the 응답 작성 중 row may follow it, re-ai-answer D12).
  if (optimisticId) dropTurnFromPanel(optimisticId);
  if (ref) el.setItemState(ref, 'failed', why.trim());
  dashToast({ title: '메시지를 보내지 못했어요', description: why.trim(), tone: 'error' });
}
// A note that did not go out at all (a recording still being filed, a file that
// could not be read): its row goes and its text returns to the field — unless the
// user has typed something new there, or moved to another card.
function pcGiveBack(el, ref, msg, key) {
  if (ref) el.setItemState(ref, 'cancelled');
  if (msg && panelSessionKey === key && !el.value) el.value = msg;
}

// Send now (Retry on a failed note), Cancel and Edit on a queued note → the
// session's queue route, owner-only like Stop, carrying the generation the panel
// showed: the item's epoch and the session's turnEpoch (Send now is fenced on
// it). The pushed list confirms the act; a refusal rolls the note back to its
// state with the queue's own words (setItemState) and says it in a toast.
var STEER_FAIL = { promote: '지금 보내지 못했어요', cancel: '취소하지 못했어요', edit: '수정하지 못했어요' };
async function steerAct(op, id, text) {
  var key = panelSessionKey;
  var s = key ? _sessionCache[key] : null;
  var item = steerItemOf(s, id);
  var el = document.getElementById('cmd-steer');
  // Not in the queue: a local row (Cancel on a failed send) — the element dropped it; nothing to tell the server.
  if (!item || !el) return;
  var body = { epoch: Number(item.epoch) || 0, turnEpoch: Number(s.followups && s.followups.turnEpoch) || 0 };
  if (op === 'edit') body.text = text;
  var ok = false;
  var said = '';
  try {
    var res = await acPost('/api/dashboard/session/' + encodeURIComponent(key) + '/queue/' + encodeURIComponent(id) + '/' + op, JSON.stringify(body));
    var data = {};
    try { data = await res.json(); } catch (_e) {}
    ok = res.ok;
    said = ok ? ((data && data.message) || '') : ((data && data.error) || ('HTTP ' + res.status));
  } catch (e) {
    said = (e && e.message) || '네트워크 오류';
  }
  if (ok) {
    // The queue's receipt (취소했습니다 …, 이미 전달되어 …) — Send now says nothing; its note moves.
    if (said) dashToast({ title: said, tone: 'success' });
    return;
  }
  // The element now shows another session's queue: the refusal is only a toast.
  if (panelSessionKey === key && document.getElementById('cmd-steer') === el) el.setItemState(id, STEER_STATE[item.state] || 'queued', said);
  dashToast({ title: STEER_FAIL[op] || '하지 못했어요', description: said, tone: 'error' });
}

// ── Secondary sections: LLM capacity and the CRON lane (SSOT 2026-10-24) ──
// Both sit above the board and once took the whole first screen of every phone and
// foldable (the first card at 989–1247px). Each is a disclosure: collapsed unless the
// window is large (840 wide and 1000 tall — a QHD or full-screen desktop), or as the
// reader chose. The choice is saved per device; the default never is. A folded CRON
// lane still shows every job whose run waits for a reply (never hidden behind a fold).
// Both are @2lab.ai/ui <ui-agent-queue> (re-agent-queue): its own 펼치기 / 접기 toggle in
// each section's head row asks through ui-collapse; the page decides and hands the state
// back as data.collapsed (paintCapacity, syncCronLane).
var SEC_OPEN_QUERY = '(min-width: 840px) and (min-height: 1000px)';
var _secMql = window.matchMedia ? window.matchMedia(SEC_OPEN_QUERY) : null;
// Capacity v2 unfolded is taller than any common first screen (two measures, lanes and
// per-account bars per provider; at 1440×1400 it pushed the first board card to 1670px).
// So it starts folded everywhere — its chips carry both measures as count and % — and
// the reader's unfold choice persists per device (trinity chip confirm, fable/astra).
var _secChoice = {};           // this page's choices, even when storage refuses the write
var _cronLaneRevealed = false; // a deep link into a folded lane opens it for this page load
var _cronFoldApplied = null;   // the fold the last CRON render used
var _capFoldApplied = null;    // the fold the last capacity paint used
function secOpen(saved, large) {
  if (saved === 'open') return true;
  if (saved === 'closed') return false;
  return !!large;
}
function secSaved(sec) {
  try { return localStorage.getItem('soma-sec-' + sec); } catch (_e) { return null; }
}
function secIsOpen(sec) {
  if (sec === 'cron' && _cronLaneRevealed) return true;
  var saved = _secChoice[sec] !== undefined ? _secChoice[sec] : secSaved(sec);
  return secOpen(saved, sec === 'capacity' ? false : !!(_secMql && _secMql.matches));
}
// A render for a disclosure change: entering and leaving cards animate as usual; the
// board's moves are the coordinator's (flipFrom), from the spots cached before the change.
function renderBoardForLayout() {
  if (_lastBoardData) renderBoard(_lastBoardData);
}
function cronLaneFolded() { return !secIsOpen('cron'); }
function secStateKey() { return (secIsOpen('capacity') ? 'C' : 'c') + (secIsOpen('cron') ? 'R' : 'r'); }
// Runs on every layout check (each resize frame): a changed capacity fold repaints its
// element; true when the CRON fold changed (the lane's data and cards then need a board
// render: a folded lane keeps its cards out of the DOM).
function applySectionState() {
  if (_capFoldApplied !== null && _capFoldApplied !== !secIsOpen('capacity')) paintCapacity();
  var folded = cronLaneFolded();
  var changed = _cronFoldApplied !== null && _cronFoldApplied !== folded;
  _cronFoldApplied = folded;
  return changed;
}
// The reader's toggle: the board moves by the layout coordinator's FLIP (the state is
// part of the layout mode), measured from where it is now.
function toggleSection(sec) {
  var open = !secIsOpen(sec);
  layoutBeforeChange();
  // This page first; the device's copy is best-effort (private mode, a full quota).
  _secChoice[sec] = open ? 'open' : 'closed';
  try { localStorage.setItem('soma-sec-' + sec, _secChoice[sec]); } catch (_e) {}
  if (sec === 'cron') _cronLaneRevealed = false;
  if (applySectionState()) renderBoardForLayout();
}
// A section's own toggle (<ui-agent-queue> ui-collapse, detail.collapsed = the state asked
// for): cancelled, so the element never folds on its own — the page's choice comes back
// as data.collapsed and the toggle keeps the focus across that render (its data-key).
document.addEventListener('ui-collapse', function(e) {
  var id = e.target && e.target.id;
  var sec = id === 'capacity-aq' ? 'capacity' : id === 'cron-aq' ? 'cron' : null;
  if (!sec) return;
  e.preventDefault();
  if (secIsOpen(sec) === !!(e.detail && e.detail.collapsed)) toggleSection(sec);
});

// ── CRON lane (SSOT 2026-10-23 T3/T4/T5) ──
// Sessions a cron fire created (KanbanSession.cronJob) leave the three columns
// for one full-width lane above them: @2lab.ai/ui <ui-agent-queue> with the lane only —
// one tile per job (schedule, next run, the last runs as a glyph-coded strip), the four
// numbers, the next-fire queue and 24 hours of runs. Each job's latest run is its board
// card, in the job's slot (slot="job:<group key>"). "지난 실행" opens a drawer with
// every kept run of the job.
var CLOCK_SVG = '<i data-ui-icon="clock"></i>';
var _cronJobs = [];          // GET /api/dashboard/cron — this instance's jobs
var _cronJobsRev = 0;        // bumped by every jobs fetch (laneSig)
var _cronPlan = null;        // last planCronLane() result
var _cronGroupEls = Object.create(null); // group key → the job's persistent card box (its slot)
var _cronDrawerKey = null;   // group key the drawer shows, null when closed
var _cronRevealKey = null;   // a deep-linked cron run shown as its job's card

function isCronCard(s) {
  return !!(s && s.cronJob && s.cronJob.name);
}
function cronGroupKey(s) {
  return s.cronJob.id ? 'id:' + s.cronJob.id : 'name:' + s.cronJob.name;
}
function cronCardTime(s) {
  var t = Date.parse(s && s.lastActivity);
  return isNaN(t) ? 0 : t;
}
// Split the board (T4): cron cards leave the columns and group by job. A job of
// this instance has a group even with no card on the board; a card whose job is
// not here (a sibling instance) groups by its stamp, without schedule data. A
// job waiting on the user leads the lane, then running ones, then the newest.
function planCronLane(board, jobs, revealKey) {
  var out = { working: [], waiting: [], idle: [], closed: [] };
  var groups = Object.create(null);
  var order = [];
  function group(key, jobId, name) {
    if (!groups[key]) {
      groups[key] = { key: key, jobId: jobId || null, name: name, job: null, cards: [], colOf: Object.create(null), waiting: false, running: false };
      order.push(key);
    }
    return groups[key];
  }
  (jobs || []).forEach(function(j) { if (j && j.id) group('id:' + j.id, j.id, j.name).job = j; });
  ['working', 'waiting', 'idle', 'closed'].forEach(function(col) {
    (board[col] || []).forEach(function(s) {
      // A starred cron run stays on the board, on top (SSOT 2026-10-30 T2).
      if (!isCronCard(s) || s.starred === true) { out[col].push(s); return; }
      var g = group(cronGroupKey(s), s.cronJob.id, s.cronJob.name);
      g.cards.push(s);
      g.colOf[s.key] = col;
      if (col === 'waiting') g.waiting = true;
      if (col === 'working') g.running = true;
    });
  });
  var list = order.map(function(k) { return groups[k]; });
  list.forEach(function(g) {
    g.cards.sort(function(a, b) { return cronCardTime(b) - cronCardTime(a); });
    var lead = null;
    // A deep link to an older run of this job shows that run as the card.
    for (var r = 0; r < g.cards.length && !lead; r++) if (revealKey && g.cards[r].key === revealKey) lead = g.cards[r];
    for (var i = 0; i < g.cards.length && !lead; i++) if (g.colOf[g.cards[i].key] === 'waiting') lead = g.cards[i];
    for (var j = 0; j < g.cards.length && !lead; j++) if (g.colOf[g.cards[j].key] === 'working') lead = g.cards[j];
    g.lead = lead || g.cards[0] || null;
    g.latestAt = g.cards.length ? cronCardTime(g.cards[0]) : 0;
  });
  list.sort(function(a, b) {
    if (a.waiting !== b.waiting) return a.waiting ? -1 : 1;
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (a.latestAt !== b.latestAt) return b.latestAt - a.latestAt;
    var an = a.job && a.job.nextRunAt ? a.job.nextRunAt : Infinity;
    var bn = b.job && b.job.nextRunAt ? b.job.nextRunAt : Infinity;
    if (an !== bn) return an - bn;
    return String(a.name).localeCompare(String(b.name));
  });
  return {
    board: out,
    groups: list,
    waitingCount: list.filter(function(g) { return g.waiting; }).length,
    runningCount: list.filter(function(g) { return g.running; }).length,
  };
}
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}
// Every run state has its own glyph — colour is never the only signal (T5).
function cronRunGlyph(run) {
  // A queue entry is an event, not a state: the drain that follows is not
  // recorded, and the thread's current activity is not this entry's run.
  if (run && run.status === 'queued') return { cls: 'none', glyph: '◌', label: '대기열에 넣음 (세션 사용 중 — 이후 실행 결과는 기록 없음)' };
  // A recorded failure stands even if the thread still reads as busy.
  if (run && run.status === 'failed') return { cls: 'fail', glyph: '✗', label: '실패' };
  var s = run && run.session;
  if (s && s.live && s.activityState === 'waiting') return { cls: 'wait', glyph: '▲', label: '응답 필요' };
  if (s && s.live && s.activityState === 'working') return { cls: 'run', glyph: '●', label: '실행 중' };
  if (run && run.status === 'unrecorded') return { cls: 'none', glyph: '◌', label: '실행 기록 없음 (보드 카드만 있음)' };
  if (run && run.executionPath === 'dm') return { cls: 'none', glyph: '◌', label: 'DM 전송 (세션 없음)' };
  if (run && run.executionPath === 'thread_reply') return { cls: 'none', glyph: '◌', label: '스레드 답글 (세션 없음)' };
  return { cls: 'ok', glyph: '✓', label: '성공' };
}
// Schedule in words for the common shapes; anything else stays the raw (UTC)
// expression. Clock times read in the viewer's zone, from the next fire.
function cronScheduleLabel(expr, nextRunAt) {
  var raw = String(expr || '').trim();
  var f = raw.split(/ +/);
  if (f.length !== 5) return raw;
  var min = f[0], hour = f[1], dom = f[2], mon = f[3], dow = f[4];
  var every = /^[*][/]([0-9]+)$/;
  var num = /^[0-9]+$/;
  var m;
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    m = every.exec(min);
    if (m) return m[1] + '분마다';
    if (min === '*') return '매분';
    if (num.test(min)) return Number(min) === 0 ? '매시 정각' : '매시 ' + Number(min) + '분';
  }
  if (dom === '*' && mon === '*' && dow === '*' && num.test(min)) {
    m = every.exec(hour);
    if (m) return m[1] + '시간마다';
  }
  if (dom === '*' && mon === '*' && num.test(min) && num.test(hour) && nextRunAt) {
    var d = new Date(nextRunAt);
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (dow === '*') return '매일 ' + hm;
    // A weekday set only reads in local words when the zone shift keeps the day.
    if (dow === '1-5' && d.getDay() === d.getUTCDay()) return '평일 ' + hm;
  }
  return raw;
}
function cronAgo(ms, nowMs) {
  return capCountdown((nowMs - ms) / 1000) + ' 전';
}
function cronRunWhen(ms, nowMs) {
  return capClockLabel(ms / 1000, nowMs) + ' · ' + cronAgo(ms, nowMs);
}
// The job's runs for the strip and the drawer, newest first: the stored run
// history plus every card of the job the history does not reference yet — a
// run still in progress is written to the history only when it ends, and a
// group without local job data (another instance) has only its cards.
function cronCardAsRun(g, s) {
  var col = g.colOf[s.key];
  // No history record backs this card: its outcome is unknown unless it is
  // live (running / waiting, read from the card itself).
  return {
    executedAt: Number(s.activeLegStartedAtMs) || cronCardTime(s),
    status: 'unrecorded',
    executionPath: 'new_thread',
    session: { headline: s.displayHeadline || s.title, activityState: col === 'closed' ? 'idle' : col, live: col !== 'closed', boardKey: s.key, conversationId: s.conversationId, slackThreadUrl: s.slackThreadUrl },
  };
}
function cronGroupRuns(g) {
  var runs = g.job && Array.isArray(g.job.runs) ? g.job.runs.slice() : [];
  var linked = Object.create(null);
  // A queue entry links to the thread but is not the run that owns it, so it
  // never stands in for the thread's card: the fire it waits behind may have
  // no record yet (records are written when a fire ends).
  for (var i = 0; i < runs.length; i++) if (runs[i].status !== 'queued' && runs[i].session && runs[i].session.boardKey) linked[runs[i].session.boardKey] = true;
  for (var j = 0; j < g.cards.length; j++) if (!linked[g.cards[j].key]) runs.push(cronCardAsRun(g, g.cards[j]));
  runs.sort(function(a, b) { return b.executedAt - a.executedAt; });
  return runs;
}
// ── The lane as the element's data (re-agent-queue; @2lab.ai/ui <ui-agent-queue>) ──
// A run as the element reads it, by the strip's rule (cronRunGlyph): ✓ ok · ● running ·
// ▲ waiting · ✗ failed · ◌ unknown (a queue entry, a card with no record, a DM or a thread
// reply), the glyph's words as its label. A card with no record yet is not one of the
// job's kept records (recorded: false), so it never counts toward historyCap.
var CRON_AQ_STATUS = { ok: 'ok', run: 'running', wait: 'waiting', fail: 'failed', none: 'unknown' };
function cronRunAsAq(r) {
  var gl = cronRunGlyph(r);
  var out = { at: r.executedAt, status: CRON_AQ_STATUS[gl.cls] || 'unknown', label: gl.label };
  if (r.error) out.error = String(r.error);
  if (r.status === 'unrecorded') out.recorded = false;
  return out;
}
// The last 24 hours' counts (lane.runs24h — the element windows them), from the run RECORDS
// only (review R1). When a record is written depends on its path (cron-scheduler.ts):
// new_thread and idle_inject await the injected turn until it settles, then write success /
// failed; dm and thread_reply write after the message is sent; busy_queue writes 'queued'
// when it queues (the drain writes nothing). So a run in progress has no record yet — its
// card is the 실행 중 tile. Whether the session is busy NOW is the linked session's: the
// server keeps live + working/waiting only on the newest run of a thread THIS job created;
// an injected run (someone else's session) and earlier / queued runs come back idle
// (cron-view.ts buildCronJobsView). Same rule as the strip (cronRunGlyph, trinity R2):
// failed → 실패; success whose session is live and working/waiting again (a reply to wait
// for, a follow-up turn) → 진행 중; else → 성공. A queue entry is an event, not a run. A board
// card with no record is not counted: a live one is the 실행 중 tile (the card IS the cron
// session), an idle one is of unknown result (+미확인). Where a job's kept history (FIFO
// historyCap) starts inside the window, the element turns the counts into lower bounds (≥)
// from the jobs' kept records.
// Every record goes, not just the last 24 hours: the element applies the window — do not cut it here.
function cronDayRuns(plan) {
  var out = [];
  ((plan && plan.groups) || []).forEach(function(g) {
    cronGroupRuns(g).forEach(function(r) {
      if (r.status === 'queued') return;
      var s = r.session;
      var live = !!(s && s.live && (s.activityState === 'working' || s.activityState === 'waiting'));
      if (r.status === 'unrecorded') {
        if (!live) out.push({ at: r.executedAt, status: 'unknown', jobId: g.key });
        return;
      }
      out.push({ at: r.executedAt, status: r.status === 'failed' ? 'failed' : live ? 'running' : 'ok', jobId: g.key });
    });
  });
  return out;
}
// The plan as the lane's data: one job per group, its id the group key (id:… / name:…), so
// ui-job-open names the drawer to open and slot="job:<key>" the group's card box. A group
// whose job is not on this instance has no schedule and says so (잡 정보 없음).
function laneData(plan) {
  var jobs = ((plan && plan.groups) || []).map(function(g) {
    var j = g.job;
    var job = {
      id: g.key,
      name: g.name,
      runs: cronGroupRuns(g).map(cronRunAsAq),
      state: g.waiting ? 'waiting' : g.running ? 'running' : 'idle',
    };
    if (j) {
      job.expression = j.expression;
      if (j.nextRunAt) job.nextRunAt = j.nextRunAt;
      job.historyCap = j.historyCap || 20;
    } else {
      job.note = { text: '잡 정보 없음', title: '이 인스턴스에 없는 잡 — 삭제됐거나 다른 인스턴스의 잡이라 스케줄 정보가 없습니다' };
    }
    return job;
  });
  return { lane: { jobs: jobs, runs24h: cronDayRuns(plan) }, collapsible: true, collapsed: { lane: cronLaneFolded() } };
}
// What the lane's data is made of, cheaply — compared on every board render instead
// of building laneData and serializing it: the jobs (their run records, schedules
// and caps change only with a fetch: its revision), each group in order with its
// live state and its cards (key, column, time — a card's run on the strip), and the fold.
function laneSig(plan) {
  var parts = [_cronJobsRev, cronLaneFolded() ? 1 : 0];
  var groups = (plan && plan.groups) || [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var cards = [];
    for (var j = 0; j < g.cards.length; j++) {
      var c = g.cards[j];
      cards.push(c.key + ':' + g.colOf[c.key] + ':' + (Number(c.activeLegStartedAtMs) || cronCardTime(c)));
    }
    parts.push(g.key + '|' + g.name + '|' + (g.job ? 'j' : '') + (g.waiting ? 'w' : '') + (g.running ? 'r' : '') + '|' + cards.join(','));
  }
  return parts.join(';');
}
// Hand an element its data only when it changed — or once a minute, so the 24-hour window
// and the timeline slide toward now (between renders the element ticks its own countdowns).
// Rendered at once: the layout coordinator measures the page right after a fold.
function aqPaint(el, data) {
  if (!el) return false;
  var sig = JSON.stringify(data) + '|' + Math.floor(Date.now() / 60000);
  if (el._aqSig === sig) return false;
  el._aqSig = sig;
  el.data = data;
  if (typeof el.renderNow === 'function') el.renderNow();
  return true;
}
// One persistent card box per job group, a light-DOM child of the element in its job's slot,
// so the reconciler moves each job's lead card under its tile and the element's re-renders
// never touch it.
function syncCronLane(plan) {
  var lane = document.getElementById('cron-lane');
  var el = document.getElementById('cron-aq');
  if (!lane || !el) return;
  lane.hidden = plan.groups.length === 0;
  var keep = Object.create(null);
  for (var i = 0; i < plan.groups.length; i++) {
    var g = plan.groups[i];
    keep[g.key] = true;
    var box = _cronGroupEls[g.key];
    if (!box) {
      box = document.createElement('div');
      box.className = 'cards cron-cards';
      box.setAttribute('slot', 'job:' + g.key);
      _cronGroupEls[g.key] = box;
    }
    if (box.parentNode !== el) el.appendChild(box);
  }
  for (var key in _cronGroupEls) {
    if (keep[key]) continue;
    var old = _cronGroupEls[key];
    delete _cronGroupEls[key];
    // Its card fades out first (its <ui-agent-inbox>), then the box goes.
    setTimeout(function(node) { return function() { if (node.parentNode) node.parentNode.removeChild(node); }; }(old), MOTION.fade + 40);
  }
  // The data is built (and compared, aqPaint) only when what it is made of changed, or a minute on.
  var sig = laneSig(plan) + '#' + Math.floor(Date.now() / 60000);
  if (el._laneSig === sig) return;
  el._laneSig = sig;
  aqPaint(el, laneData(plan));
}
// The lane's card slots: each job group shows its lead card (waiting, else running,
// else newest) in its own box — a one-column <ui-agent-inbox> there (paintCronLaneCards).
function cronLaneSlots(plan) {
  // A folded lane keeps no card of a job that does not wait for a reply in the DOM —
  // like a closed DONE day (T12) — so the layout coordinator never caches a hidden one.
  var folded = cronLaneFolded();
  return plan.groups.map(function(g) {
    var show = g.lead && !(folded && !g.waiting);
    return { container: _cronGroupEls[g.key] || null, items: show ? [{ s: g.lead, col: g.colOf[g.lead.key] }] : [] };
  });
}

function renderCronRunRow(run, g, nowMs) {
  var gl = cronRunGlyph(run);
  var s = run.session;
  // An earlier run in a thread a later run reused: the thread's title belongs to the later run.
  var title = s && s.earlierInThread ? '같은 스레드의 이전 실행' : s && s.headline ? s.headline : gl.label;
  var bits = [];
  bits.push('<time datetime="' + escAttr(new Date(run.executedAt).toISOString()) + '">' + esc(cronRunWhen(run.executedAt, nowMs)) + '</time>');
  bits.push(esc(run.triggeredBy ? '수동 실행 (' + run.triggeredBy + ')' : '예약 실행'));
  if (s && s.activeMs) bits.push(esc('소요 ' + capCountdown(s.activeMs / 1000)));
  if (s && typeof s.tokens === 'number' && s.tokens > 0) bits.push(esc(formatTokens(s.tokens) + ' tok'));
  if (s && typeof s.costUsd === 'number' && s.costUsd > 0) bits.push(esc('$' + s.costUsd.toFixed(2)));
  if (!s && run.status === 'success' && run.executionPath !== 'dm' && run.executionPath !== 'thread_reply') bits.push(esc('세션 연결 없음'));
  var actions = [];
  if (s && s.boardKey && _sessionCache[s.boardKey]) actions.push('<button type="button" class="ui-btn is-sm" data-cron-open="' + escAttr(s.boardKey) + '">작업 로그</button>');
  if (s && s.conversationId) actions.push('<a class="ui-btn is-sm" href="/conversations/' + encodeURIComponent(s.conversationId) + '" target="_blank" rel="noopener">대화 기록</a>');
  if (s && s.slackThreadUrl) actions.push('<a class="ui-btn is-sm" href="' + safeHref(s.slackThreadUrl) + '" target="_blank" rel="noopener">Slack</a>');
  return '<li class="cron-run is-' + gl.cls + '">'
    + '<span class="cr-glyph" title="' + escAttr(gl.label) + '">' + gl.glyph + '</span>'
    + '<div class="cr-main"><div class="cr-title">' + esc(title) + '</div>'
    + '<div class="cr-sub">' + bits.join('<span aria-hidden="true"> · </span>') + '</div>'
    + (run.error ? '<div class="cr-err">' + esc(run.error) + '</div>' : '')
    + '</div>'
    + (actions.length ? '<div class="cr-actions">' + actions.join('') + '</div>' : '')
    + '</li>';
}
function renderCronDrawerMeta(g, nowMs) {
  var j = g.job;
  if (!j) return '<p class="cron-dmeta">이 인스턴스에 없는 잡입니다 — 삭제됐거나 다른 인스턴스의 잡이라 스케줄·실행 기록이 없습니다. 보드에 있는 실행만 보입니다.</p>';
  // Values are markup (escaped here): 다음 실행 counts down live like the tile (#444 review R1).
  var rows = [
    ['스케줄', esc(cronScheduleLabel(j.expression, j.nextRunAt) + ' · ' + j.expression + ' (UTC)')],
    ['다음 실행', j.nextRunAt ? esc(capClockLabel(j.nextRunAt / 1000, nowMs)) + ' (' + aqTime(j.nextRunAt, nowMs, ' 후') + ')' : '8일 안에 없음'],
    ['실행 방식', esc((j.mode === 'fastlane' ? '항상 새 스레드' : '세션이 쉬면 주입, 없으면 새 스레드') + ' · 출력 ' + j.target + ' · 모델 ' + j.model)],
  ];
  return '<dl class="cron-dmeta">' + rows.map(function(r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>'
    + '<p class="cron-dnote">실행 기록은 잡마다 최근 ' + (j.historyCap || 20) + '회까지 보관됩니다.</p>';
}
function paintCronDrawer() {
  if (!_cronDrawerKey) return;
  var g = null;
  var groups = _cronPlan ? _cronPlan.groups : [];
  for (var i = 0; i < groups.length; i++) if (groups[i].key === _cronDrawerKey) g = groups[i];
  if (!g) { closeCronDrawer(); return; }
  var now = Date.now();
  var runs = cronGroupRuns(g);
  document.getElementById('cron-drawer-title').textContent = g.name;
  document.getElementById('cron-drawer-badge').innerHTML = CLOCK_SVG + '<span class="cron-badge-text">CRON</span>';
  document.getElementById('cron-drawer-meta').innerHTML = renderCronDrawerMeta(g, now);
  document.getElementById('cron-drawer-body').innerHTML = runs.length
    ? '<ol class="cron-runs">' + runs.map(function(r) { return renderCronRunRow(r, g, now); }).join('') + '</ol>'
    : '<p class="col-empty">아직 실행 기록이 없습니다</p>';
}
// The control that opened the drawer, to return to on close: a press inside an element's
// shadow root (the lane's 지난 실행, strip or next-fire chip) is that control — and its
// data-key, because a lane render while the drawer is open replaces it.
var _cronDrawerReturnFocus = null; // { el, host, key }
function openCronDrawer(key) {
  var host = document.activeElement;
  var el = host;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  _cronDrawerReturnFocus = { el: el, host: el !== host ? host : null, key: el && el.getAttribute ? el.getAttribute('data-key') : null };
  _cronDrawerKey = key;
  paintCronDrawer();
  // <ui-drawer mode="sheet"> (C-05): show() opens it modal (focus moves in, the page behind is inert).
  var d = document.getElementById('cron-drawer');
  if (d && typeof d.show === 'function') d.show();
}
function closeCronDrawer() {
  _cronDrawerKey = null;
  var d = document.getElementById('cron-drawer');
  if (!d) return;
  if (typeof d.hide === 'function') d.hide();
  // Focus goes back now (before the element's exit ends) — to the control, or its twin a lane render put in its place.
  var back = _cronDrawerReturnFocus;
  _cronDrawerReturnFocus = null;
  var to = back && back.el;
  if (to && !to.isConnected && back.host && back.key && back.host.shadowRoot) {
    var same = back.host.shadowRoot.querySelectorAll('[data-key]');
    to = null;
    for (var i = 0; i < same.length && !to; i++) if (same[i].getAttribute('data-key') === back.key) to = same[i];
  }
  if (to && to.isConnected && typeof to.focus === 'function') to.focus();
}
// Escape, the scrim and ✕ arrive as the element's ui-close; the page closes it itself (closeCronDrawer) so focus
// returns to the control that opened it even when the lane re-rendered that control meanwhile.
(function initCronDrawer() {
  var d = document.getElementById('cron-drawer');
  if (d) d.addEventListener('ui-close', function(e) { e.preventDefault(); closeCronDrawer(); });
})();
document.addEventListener('click', function(e) {
  var t = e.target && e.target.closest ? e.target : null;
  if (!t) return;
  var open = t.closest('[data-cron-open]');
  if (open) { var k = open.getAttribute('data-cron-open'); closeCronDrawer(); openPanel(k); }
});
// The lane's next-fire chip, a job's 지난 실행 or its run strip (<ui-agent-queue> ui-job-open):
// the job's id is its group key.
document.addEventListener('ui-job-open', function(e) {
  if (!e.target || e.target.id !== 'cron-aq') return;
  var key = e.detail && e.detail.jobId;
  if (key) openCronDrawer(String(key));
});
async function loadCronJobs() {
  if (document.hidden) return;
  try {
    var res = await fetch('/api/dashboard/cron' + (currentUserId ? '?userId=' + encodeURIComponent(currentUserId) : ''));
    if (!res.ok) return;
    var data = await res.json();
    _cronJobs = Array.isArray(data.jobs) ? data.jobs : [];
    _cronJobsRev++;
    if (_lastBoardData) renderBoard(_lastBoardData);
  } catch (e) { console.error('Failed to load cron jobs', e); }
}

// ── The drawer's live countdowns (the Agent Queue grammar, #444 D3) ──
// <ui-agent-queue> ticks its own; the drawer's 다음 실행 rides the page's 1 Hz tick.
// Time left, floored (spec 12 T9): 1일 5시간 · 1시간 20분 · 24분 · 42초 · 곧 (D3).
function aqLeft(atMs, nowMs) {
  var s = Math.floor((Number(atMs) - Number(nowMs)) / 1000);
  if (!(s > 0)) return '곧';
  if (s < 60) return s + '초';
  var m = Math.floor(s / 60);
  var h = Math.floor(m / 60);
  if (h >= 24) return Math.floor(h / 24) + '일 ' + (h % 24) + '시간';
  if (h) return h + '시간 ' + (m % 60) + '분';
  return m + '분';
}
// Time left with what follows it: ' 후 복귀' reads "24분 후 복귀", and at zero "곧 복귀" — never
// "곧 후" (PR review R1). sfx starts with ' 후' when it says "after".
function aqLeftSfx(atMs, nowMs, sfx) {
  var t = aqLeft(atMs, nowMs);
  var tail = String(sfx || '');
  return t === '곧' ? t + tail.replace(/^ 후/, '') : t + tail;
}
// A countdown aqTick keeps live, its suffix inside it (data-aq-sfx); role=timer is never read
// out on each tick.
function aqTime(atMs, nowMs, sfx) {
  var at = Math.round(Number(atMs));
  if (!isFinite(at)) return '';
  return '<time class="aq-left" role="timer" datetime="' + new Date(at).toISOString() + '" data-aq-at="' + at + '"' + (sfx ? ' data-aq-sfx="' + escAttr(sfx) + '"' : '') + '>' + aqLeftSfx(at, nowMs, sfx) + '</time>';
}
// The drawer's countdowns ride the shared 1 Hz tick (updateTimers → aqTick).
function aqTickIn(root, nowMs) {
  if (!root) return;
  var els = root.querySelectorAll('[data-aq-at]');
  for (var i = 0; i < els.length; i++) {
    var t = aqLeftSfx(Number(els[i].getAttribute('data-aq-at')) || 0, nowMs, els[i].getAttribute('data-aq-sfx') || '');
    if (els[i].textContent !== t) els[i].textContent = t;
  }
}
function aqTick() {
  if (document.hidden) return;
  aqTickIn(document.getElementById('cron-drawer'), Date.now());
}

// ── LLM capacity v2 (2026-10-25) and its accounts as workers (#444 D8–D14) — @2lab.ai/ui
// <ui-agent-queue> with providers only. The server (capacity-view.ts) counts each provider in
// max accounts' worth (tier-weighted) and replays every account's resets in time order, in
// epoch SECONDS: the element is told so (timeUnit 's') and converts once. capData maps the
// view; the element draws the folded chips, the bars, the disclosure line, the account marks
// and their card, the 7-day timeline, ticks every countdown, and speaks a pool's change.
var CAP_TIERS = { 'claude-max-5x': { short: 'x5', label: 'Max x5' }, 'claude-max-20x': { short: 'x20', label: 'Max x20' }, 'chatgpt-pro-200': { short: '$200', label: 'Pro ($200)' }, 'chatgpt-pro-500': { short: '$500', label: 'Pro ($500)' } };
var _capacityView = null;

// Floor to the minute and keep the minutes: 3h59m never reads "3h".
function capCountdown(secs) {
  var s = Math.max(0, Math.floor(Number(secs) || 0));
  if (s < 60) return '<1m';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
function capClockLabel(atSec, nowMs) {
  var d = new Date(atSec * 1000);
  var n = new Date(nowMs);
  var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (d.toDateString() === n.toDateString()) return hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
// A unit's state from its own fields (review R1): counted / blocked / unmeasured5h / now —
// binding only says which window binds first (5h or 7d). Held accounts are the element's
// paused, the ones left out its excluded; a counted, blocked one is limited.
function capUnitState(u) {
  if (!u.counted) return u.excluded === 'held' ? 'paused' : 'excluded';
  if (u.blocked) return 'limited';
  if (u.unmeasured5h) return 'unmeasured';
  return Number(u.now) > 0 ? 'available' : 'spent';
}
// Why, as the element's reason keys (it says them in Korean); a block it has no word for is
// 차단. A usable, spent or unmeasured account has none: its state word says it.
function capReason(u) {
  var b = u.blocks || {};
  if (u.excluded === 'held') return u.held === 'paused' ? 'paused' : u.held === 'auth' ? 'auth' : 'held';
  if (u.excluded === 'noMeasure') return 'noMeasure';
  if (u.excluded === 'unknownTier') return 'unknownTier';
  if (b.weekly) return 'weekly';
  if (b.fiveHour) return '5h';
  if (b.scopedUntil) return 'model';
  if (b.cooldownUntil) return 'cooldown';
  return u.blocked ? '차단' : '';
}
// Does the group show the same display name twice (anonymous llmux masks names to "a***")?
function capDupNames(g) {
  var seen = {};
  var dup = false;
  (g.units || []).forEach(function(u) {
    if (seen['#' + u.name]) dup = true;
    seen['#' + u.name] = true;
  });
  return dup;
}
// One llmux account as a worker. Its id is its display name, so the open card and the roving
// stop follow it to its new place in a new response — except in a pool that shows a name twice
// (masked a***; the raw email never reaches the client): there its id carries the response's
// fetch time and place, so it matches nothing in the next response and the card closes instead
// of showing another account (final review R3). An assumed tier reads "x20 가정".
function capAccount(u, i, mint) {
  var t = CAP_TIERS[u.tier];
  var a = { id: mint ? mint + '|' + i + '|' + u.name : u.name, name: u.name, state: capUnitState(u), fiveHour: u.now, weekly: u.week };
  var why = capReason(u);
  if (why) a.reason = why;
  if (u.returnAt) a.returnAt = u.returnAt;
  if (u.binding) a.binding = u.binding;
  if (u.tierAssumed) { a.tier = t ? t.short : 'x20'; a.tierAssumed = true; }
  else if (t) a.tier = t.label;
  if (u.estimated) a.estimated = true;
  return a;
}
// The capacity view as the element's data: groups → providers (has5h → two measures, else the
// weekly one), units → accounts in llmux order, events → refills; the server's own counts for
// the disclosure line; an unavailable view → its reason in place of the cards.
function capData(v) {
  var d = { timeUnit: 's', capacityNote: '계정 = 최대 플랜 계정 1개 분량 · llmux', collapsible: true, collapsed: { capacity: !secIsOpen('capacity') } };
  if (v.fetchedAtMs) d.fetchedAt = v.fetchedAtMs / 1000;
  if (!v.available) {
    d.capacityError = v.reason || '알 수 없는 오류';
    return d;
  }
  d.providers = (v.groups || []).map(function(g) {
    var mint = capDupNames(g) ? 'r' + v.fetchedAtMs : '';
    var p = {
      id: g.group,
      name: g.label,
      source: 'llmux',
      total: g.total,
      weekly: g.week,
      state: g.state,
      accountCount: g.accountCount,
      countedAccounts: g.countedAccounts,
      excluded: g.excluded,
      estimated: g.estimated,
      unmeasured5h: g.unmeasured5h,
      refills: (g.events || []).map(function(e) { return { at: e.at, cause: e.cause, fiveHour: e.dNow, weekly: e.dWeek, account: e.account }; }),
      accounts: (g.units || []).map(function(u, i) { return capAccount(u, i, mint); }),
    };
    if (g.has5h) p.fiveHour = g.now;
    if (g.oldestRefreshAt) p.measuredAt = g.oldestRefreshAt;
    return p;
  });
  return d;
}
function paintCapacity() {
  var el = document.getElementById('capacity');
  if (!el || !_capacityView || document.hidden) return;
  // A deployment that does not route through llmux shows no section at all.
  var off = !_capacityView.available && /^auth mode/.test(_capacityView.reason || '');
  el.hidden = off;
  if (off) return;
  _capFoldApplied = !secIsOpen('capacity');
  aqPaint(document.getElementById('capacity-aq'), capData(_capacityView));
}
async function loadCapacity() {
  if (document.hidden) return;
  try {
    var res = await fetch('/api/dashboard/capacity');
    if (!res.ok) return;
    var data = await res.json();
    _capacityView = data.capacity || null;
    paintCapacity();
  } catch (e) { console.error('Failed to load capacity', e); }
}

// ── Session artifacts (SSOT 2026-10-23) ──
// What the model produced: the files it sent to Slack (html / png / wav …) and
// its markdown final answers. The card face shows glyph chips (no image is
// fetched for the board), the open card a thumbnail strip, the panel a pinned
// strip plus the files each answer turn produced. Hover (or keyboard focus) →
// minimap preview in #art-peek; click → full-size viewer in <dialog #art-modal>.
// Every render function here is pure; the DOM work sits in the functions after
// renderArtModalBody and in initArtifactInteractions.
var ART_KIND_LABEL = { image: '이미지', audio: '오디오', video: '비디오', html: 'HTML', markdown: '답변', pdf: 'PDF', text: '텍스트', file: '파일' };
var ART_GLYPH = { image: '<i data-ui-icon="file-image" class="art-glyph"></i>', audio: '<i data-ui-icon="file-audio" class="art-glyph"></i>', video: '<i data-ui-icon="file-video" class="art-glyph"></i>', html: '<i data-ui-icon="file-code" class="art-glyph"></i>', markdown: '<i data-ui-icon="file-text" class="art-glyph"></i>', pdf: '<i data-ui-icon="file-text" class="art-glyph"></i>', text: '<i data-ui-icon="file-text" class="art-glyph"></i>', file: '<i data-ui-icon="file" class="art-glyph"></i>' };
var ART_PEEK_DELAY_MS = 350; // hover intent before the minimap opens (300–500 ms keeps a sweep across chips quiet)
var ART_PEEK_CLOSE_MS = 200; // grace to move the pointer into the minimap (WCAG 1.4.13: hoverable)
var _artCache = Object.create(null); // conversationId → { state: 'loading'|'ok'|'error', list, promise }
var _artDocCache = Object.create(null); // 'cid|id' → text of a markdown / text artifact
var _artPeek = { anchor: null, openTimer: null, closeTimer: null };
var _artModal = { cid: null, list: [], idx: 0, opener: null };
var _artAudio = { el: null, key: null };

function artUrl(cid, id, download) {
  // A user's attachment (SSOT 2026-10-25) shares the viewer, not the route.
  if (umGet(cid, id)) return umUrl(cid, id, download);
  return '/api/dashboard/session/' + encodeURIComponent(cid) + '/artifacts/' + encodeURIComponent(id) + '/content' + (download ? '?download=1' : '');
}

// ── User media (SSOT 2026-10-25): the files a user attached to an instruction ──
// Shown with the instruction that carried them (panel turn, open card 지시 row),
// counted on the card face, listed in one collapsed pinned row, and opened in the
// artifact viewer — but never mixed into 산출물 (the model's output). Ids the
// page has seen on a user turn are registered here; artUrl sends them to the
// media route.
var _userMedia = Object.create(null); // cid → { byId: { id → item } }
var UM_GRID_MAX = 4; // image tiles shown; past it the 4th tile says "+N"
var _umList = Object.create(null); // cid → every attachment of the session (pinned row)
var _umPanelOpen = false; // the pinned row starts collapsed

// Remember a turn's attachments: the viewer, the hover preview and artUrl look them up.
function umRegister(cid, list, turn) {
  if (!cid || !list || !list.length) return;
  var c = _userMedia[cid] || (_userMedia[cid] = { byId: Object.create(null) });
  var who = turn && turn.userName ? String(turn.userName) : '';
  list.forEach(function(a) {
    if (!a || !a.id) return;
    var prev = c.byId[a.id];
    c.byId[a.id] = Object.assign({}, a, {
      source: 'user_upload',
      turnId: (turn && turn.id) || a.turnId || (prev && prev.turnId) || '',
      createdAt: toNum(turn && turn.timestamp) || toNum(a.turnTs) || (prev && toNum(prev.createdAt)) || 0,
      title: who ? '지시 첨부 · ' + who : (prev && prev.title) || '지시 첨부',
    });
  });
}

function umGet(cid, id) {
  var c = cid ? _userMedia[cid] : null;
  return c && c.byId[id] ? c.byId[id] : null;
}

function umUrl(cid, id, download) {
  return '/api/dashboard/session/' + encodeURIComponent(cid) + '/media/' + encodeURIComponent(id) + '/content' + (download ? '?download=1' : '');
}

// The viewer's page list: the files of the same instruction, or every file of the session.
function umSiblings(cid, id, all) {
  var c = cid ? _userMedia[cid] : null;
  var a = umGet(cid, id);
  if (!c || !a) return [];
  var out = [];
  for (var k in c.byId) if (all || c.byId[k].turnId === a.turnId) out.push(c.byId[k]);
  return out;
}

// "very-long-design-guide-v3.pdf" → "very-long-de…v3.pdf": the extension stays visible.
function umMiddleName(name, max) {
  var str = String(name || '');
  max = max || 28;
  if (str.length <= max) return str;
  var dot = str.lastIndexOf('.');
  var tail = dot > 0 && str.length - dot <= 8 ? str.slice(dot - 3) : str.slice(-6);
  return str.slice(0, Math.max(1, max - tail.length - 1)) + '…' + tail;
}

// One attachment: an image tile, or a file card (glyph, name, kind · size).
// pos / total name the action ("이미지 열기 2/5: login.png"); more > 0 puts "+more" on the tile.
function umTile(cid, a, pos, total, more, compact) {
  var attrs = ' data-art-cid="' + escAttr(cid) + '" data-art-id="' + escAttr(a.id) + '"';
  var label = (a.kind === 'image' ? '이미지' : artKindLabel(a)) + ' 열기 ' + pos + '/' + total + ': ' + a.name + (more > 0 ? ' 외 ' + more + '개' : '');
  if (a.kind === 'image' && a.stored) {
    return '<button type="button" class="um-tile um-img"' + attrs + ' aria-label="' + escAttr(label) + '" title="' + escAttr(a.name) + '">'
      + '<img src="' + escAttr(umUrl(cid, a.id)) + '" alt="" loading="lazy" decoding="async" onerror="this.parentNode.classList.add(\\'is-broken\\')">'
      + (more > 0 ? '<span class="um-more" aria-hidden="true">+' + more + '</span>' : '')
      + '</button>';
  }
  var meta = [artKindLabel(a)];
  if (toNum(a.size) > 0) meta.push(artFormatSize(a.size));
  if (!a.stored) meta.push(a.unavailable === 'too_large' ? '50 MB 초과 · Slack에만 있음' : 'Slack에만 있음');
  var play = (a.kind === 'audio' && a.stored)
    ? '<button type="button" class="art-play um-play" data-art-play="1"' + attrs + ' aria-pressed="false" aria-label="' + escAttr(a.name + ' 재생/일시정지') + '" title="재생">'
      + '<svg class="ic-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>'
      + '<svg class="ic-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" fill="currentColor"/></svg></button>'
    : '';
  return '<div class="um-file art-k-' + escAttr(a.kind || 'file') + (a.stored ? '' : ' is-remote') + (compact ? ' um-file-compact' : '') + '">'
    + '<button type="button" class="um-open"' + attrs + ' aria-label="' + escAttr(label) + '" title="' + escAttr(a.name) + '">'
    + artGlyph(a.kind)
    + '<span class="um-file-text"><span class="um-file-name">' + esc(umMiddleName(a.name, compact ? 20 : 30)) + '</span>'
    + (compact ? '' : '<span class="um-file-meta">' + esc(meta.join(' · ')) + '</span>') + '</span>'
    + '</button>' + play + '</div>';
}

// The files of one instruction: images first as a grid of tiles (one image on
// its own in a fixed box), then the other files as cards. opts.compact: the
// open card's 지시 row and the pinned row — small tiles, name-only chips.
function renderUserMedia(cid, list, opts) {
  var items = (list || []).filter(function(a) { return a && a.id; });
  if (!cid || !items.length) return '';
  var compact = !!(opts && opts.compact);
  var total = items.length;
  var imgs = [];
  var files = [];
  items.forEach(function(a, i) { (a.kind === 'image' && a.stored ? imgs : files).push({ a: a, pos: i + 1 }); });
  var html = '';
  if (imgs.length) {
    var shown = imgs.slice(0, UM_GRID_MAX);
    var more = imgs.length - shown.length;
    html += '<div class="um-grid' + (imgs.length === 1 && !compact ? ' um-single' : '') + '">'
      + shown.map(function(x, k) { return umTile(cid, x.a, x.pos, total, k === shown.length - 1 ? more : 0, compact); }).join('')
      + '</div>';
  }
  if (files.length) {
    html += '<div class="um-files">' + files.map(function(x) { return umTile(cid, x.a, x.pos, total, 0, compact); }).join('') + '</div>';
  }
  return '<div class="um-media' + (compact ? ' um-compact' : '') + '">' + html + '</div>';
}

// Why a user's file has no copy here, in the viewer.
function umMissingReason(a) {
  if (a.unavailable === 'too_large') return '50 MB를 넘어 봇이 받지 못한 파일입니다. Slack에서 열 수 있습니다.';
  if (a.unavailable === 'download_failed') return '봇이 이 파일을 내려받지 못했습니다. Slack에서 열 수 있습니다.';
  return '이 파일은 대시보드에 사본이 없습니다. Slack에서 열 수 있습니다.';
}

// Pinned row of the panel: "지시 첨부 N", collapsed by default so it costs one
// line; opened, the session's files in a compact strip. Nothing when none.
function renderPanelUserMedia(list, cid, open) {
  if (!cid || !list || !list.length) return '';
  var head = '<button type="button" class="panel-um-head" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="panel-um-body" onclick="togglePanelUserMedia()">'
    + '<i data-ui-icon="attach" class="art-glyph"></i>'
    + '<span>지시 첨부</span><span class="art-count">' + list.length + '</span>'
    + '<span class="panel-arts-hint">유저가 지시와 함께 보낸 파일</span>'
    + '<i data-ui-icon="chevron-down" class="um-chevron"></i>'
    + '</button>';
  return head + (open ? '<div class="panel-um-body" id="panel-um-body">' + renderUserMedia(cid, list, { compact: true }) + '</div>' : '');
}

function togglePanelUserMedia() {
  _umPanelOpen = !_umPanelOpen;
  renderPanelArtifactsSection();
}

// The session's attachments for the pinned row, fetched when the card says it has some.
function ensureUserMedia(cid) {
  if (!cid) return;
  fetch('/api/dashboard/session/' + encodeURIComponent(cid) + '/media')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
      var list = Array.isArray(data && data.media) ? data.media : [];
      list.forEach(function(a) { umRegister(cid, [a], null); });
      _umList[cid] = list;
      if (panelOpen && panelConvId === cid) renderPanelArtifactsSection();
    })
    .catch(function() {});
}

// A user turn landed with files: the pinned row grows with it.
function umOnTurn(cid, turn) {
  var atts = turn && turn.role === 'user' && Array.isArray(turn.attachments) ? turn.attachments : [];
  if (!cid || !atts.length) return;
  umRegister(cid, atts, turn);
  var list = _umList[cid] || [];
  atts.forEach(function(a) {
    if (!list.some(function(x) { return x.id === a.id; })) list = list.concat([Object.assign({}, a, { turnId: turn.id, turnTs: turn.timestamp })]);
  });
  _umList[cid] = list;
  if (panelOpen && panelConvId === cid) renderPanelArtifactsSection();
}

function artFormatSize(n) {
  n = toNum(n);
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(1) + ' GB';
}

function artKindLabel(a) {
  return ART_KIND_LABEL[a && a.kind] || '파일';
}

function artGlyph(kind) {
  return ART_GLYPH[kind] || ART_GLYPH.file;
}

// "HTML · 47 KB · 14:23" — and says so when only Slack has the bytes.
function artMeta(a) {
  var parts = [artKindLabel(a)];
  if (toNum(a.size) > 0) parts.push(artFormatSize(a.size));
  var d = new Date(toNum(a.createdAt));
  if (toNum(a.createdAt) > 0 && !isNaN(d.getTime())) parts.push(d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
  if (!a.stored) parts.push('Slack에만 있음');
  return parts.join(' · ');
}

// One chip: glyph + name. data-art-cid / data-art-id drive hover and click.
function artChip(cid, a) {
  return '<button type="button" class="art-chip art-k-' + escAttr(a.kind || 'file') + '" data-art-cid="' + escAttr(cid) + '" data-art-id="' + escAttr(a.id)
    + '" aria-label="' + escAttr(artKindLabel(a) + ' ' + a.name + ' — 크게 보기') + '">'
    + artGlyph(a.kind) + '<span class="art-chip-name">' + esc(a.name) + '</span></button>';
}

// Files newest first, then answers newest first: the html/png the user looks for
// is never buried under a long chat's answers.
function artSortForDisplay(list) {
  var files = [];
  var answers = [];
  (list || []).forEach(function(a) { if (a) (a.source === 'final_answer' ? answers : files).push(a); });
  var newest = function(x, y) { return toNum(y.createdAt) - toNum(x.createdAt); };
  return files.sort(newest).concat(answers.sort(newest));
}

function artThumb(cid, a) {
  if (a.kind === 'image' && a.stored) {
    return '<span class="art-thumb art-thumb-img"><img src="' + escAttr(artUrl(cid, a.id)) + '" alt="" loading="lazy" decoding="async"></span>';
  }
  var name = String(a.name || '');
  var dot = name.lastIndexOf('.');
  var ext = a.source === 'final_answer' ? 'MD' : (dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1).toUpperCase() : artKindLabel(a));
  return '<span class="art-thumb">' + artGlyph(a.kind) + '<span class="art-thumb-ext">' + esc(ext) + '</span></span>';
}

// Is this clip the one the shared inline player is playing right now?
function artAudioPlaying(cid, id) {
  return !!(_artAudio.el && !_artAudio.el.paused && _artAudio.key === cid + '|' + id);
}

// A strip tile: open button (thumbnail, name, meta) + a play button for audio (T8).
// The play state is part of the markup: a live card body is morphed to it on every push.
function artTile(cid, a) {
  var attrs = ' data-art-cid="' + escAttr(cid) + '" data-art-id="' + escAttr(a.id) + '"';
  var on = a.kind === 'audio' && a.stored && artAudioPlaying(cid, a.id);
  var play = (a.kind === 'audio' && a.stored)
    ? '<button type="button" class="art-play' + (on ? ' is-playing' : '') + '" data-art-play="1"' + attrs + ' aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + escAttr(a.name + ' 재생/일시정지') + '" title="재생">'
      + '<svg class="ic-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>'
      + '<svg class="ic-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" fill="currentColor"/></svg></button>'
    : '';
  return '<div class="art-tile art-k-' + escAttr(a.kind || 'file') + (a.stored ? '' : ' is-remote') + '">'
    + '<button type="button" class="art-open"' + attrs + ' aria-label="' + escAttr(artKindLabel(a) + ' ' + a.name + ' — 크게 보기') + '">'
    + artThumb(cid, a)
    + '<span class="art-tile-name">' + esc(a.name) + '</span>'
    + '<span class="art-tile-meta">' + esc(artMeta(a)) + '</span>'
    + '</button>' + play + '</div>';
}

// The full list once fetched, else the card's summary (the newest few).
function artListFor(s) {
  var c = s && s.conversationId ? _artCache[s.conversationId] : null;
  if (c && c.list) return c.list;
  return (s && s.artifacts && s.artifacts.recent) || [];
}

// Open card (T5): "산출물 N" + a horizontal strip of tiles.
// Open card (T5, spec 13): the newest CARD_ART_TILES as tiles — the evidence
// to answer with and the outcome; the gallery is the panel's (전체 N개 →).
var CARD_ART_TILES = 4;
function renderCardArtifacts(s) {
  if (!s || !s.conversationId) return '';
  var list = artSortForDisplay(artListFor(s));
  if (!list.length) return '';
  var c = _artCache[s.conversationId];
  var total = c && c.list ? c.list.length : Math.max(toNum(s.artifacts && s.artifacts.count), list.length);
  var shown = list.slice(0, CARD_ART_TILES);
  return '<div class="card-artifacts"><div class="io-label art-section-label">산출물 <span class="art-count">' + total + '</span></div>'
    + '<div class="art-strip">' + shown.map(function(a) { return artTile(s.conversationId, a); }).join('') + '</div>'
    + (total > shown.length ? '<button type="button" class="card-more-link" onclick="event.stopPropagation();openPanel(\\'' + escJs(s.key) + '\\',\\'\\',\\'\\',event.detail===0)">전체 ' + total + '개 &rarr;</button>' : '')
    + '</div>';
}

// Panel (T6): pinned above the conversation, so it is in view wherever the reader is.
function renderPanelArtifacts(list, cid) {
  var sorted = artSortForDisplay(list);
  if (!sorted.length || !cid) return '';
  return '<div class="panel-arts-head"><span>산출물</span><span class="art-count">' + sorted.length + '</span>'
    + '<span class="panel-arts-hint">올리면 미리보기 · 누르면 크게</span></div>'
    + '<div class="art-strip art-strip-panel">' + sorted.map(function(a) { return artTile(cid, a); }).join('') + '</div>';
}

// Did this artifact come from the turn that ran between startTs and endTs?
// turnStartedAt is the turn's own start (from its work-log turn id) — it sits at
// the user message that began it, so a 5 s slack covers recording order.
function artInTurn(a, startTs, endTs) {
  var t = toNum(a.turnStartedAt) || toNum(a.createdAt);
  return t > 0 && t >= toNum(startTs) - 5000 && t <= toNum(endTs);
}

function renderTurnArtifacts(list, cid, startTs, endTs) {
  if (!cid) return '';
  var hits = artSortForDisplay((list || []).filter(function(a) { return artInTurn(a, startTs, endTs); }));
  if (!hits.length) return '';
  return '<div class="turn-arts-row">' + hits.map(function(a) { return artChip(cid, a); }).join('') + '</div>';
}

// Hover minimap (T2). html renders live but WITHOUT scripts (sandbox=""), media
// never autoplays, markdown/text are fetched and drawn small.
function renderArtPeekBody(cid, a) {
  var url = escAttr(artUrl(cid, a.id));
  var media;
  if (!a.stored) {
    media = '<div class="art-peek-meta">' + artGlyph(a.kind) + '<span class="art-peek-sub">' + esc(a.name) + '</span><span class="art-peek-sub">대시보드에 사본이 없습니다 — Slack에서 열 수 있습니다</span></div>';
  } else if (a.kind === 'image') {
    media = '<img class="art-peek-img" src="' + url + '" alt="' + escAttr(a.name) + '">';
  } else if (a.kind === 'html') {
    media = '<div class="art-peek-frame"><iframe sandbox="" src="' + url + '" title="' + escAttr(a.name) + '" tabindex="-1" loading="lazy" referrerpolicy="no-referrer"></iframe></div>';
  } else if (a.kind === 'audio') {
    media = '<div class="art-peek-audio">' + artGlyph('audio') + '<audio controls preload="metadata" src="' + url + '"></audio></div>';
  } else if (a.kind === 'video') {
    media = '<video class="art-peek-video" preload="metadata" muted playsinline src="' + url + '#t=0.1"></video>';
  } else if (a.kind === 'markdown' || a.kind === 'text') {
    media = '<div class="art-peek-doc" data-art-doc="' + escAttr(cid + '|' + a.id) + '" data-art-doc-kind="' + escAttr(a.kind) + '"><span class="art-doc-loading">불러오는 중…</span></div>';
  } else {
    media = '<div class="art-peek-meta">' + artGlyph(a.kind) + '<span class="art-peek-sub">' + esc(a.name) + '</span></div>';
  }
  return '<div class="art-peek-media art-k-' + escAttr(a.kind || 'file') + '">' + media + '</div>'
    + '<div class="art-peek-foot"><span class="art-peek-name">' + esc(a.title || a.name) + '</span>'
    + '<span class="art-peek-info">' + esc(artMeta(a)) + ' · 클릭하면 크게</span></div>';
}

// Full-size viewer body (T3/T8). html: scripts only — never same-origin, no
// popups (the header's buttons open a tab or download). Audio and video start at once.
function renderArtModalBody(cid, a) {
  var url = escAttr(artUrl(cid, a.id));
  var title = escAttr(a.name);
  if (!a.stored) {
    var link = /^https:\\/\\//i.test(String(a.permalink || '')) ? '<a class="ui-btn is-primary" href="' + escAttr(a.permalink) + '" target="_blank" rel="noopener">Slack에서 열기</a>' : '';
    return '<div class="art-full-meta">' + artGlyph(a.kind) + '<div class="art-full-meta-name">' + esc(a.name) + '</div>'
      + '<div class="art-full-meta-sub">' + esc(artMeta(a)) + '</div>'
      + '<p>' + (a.source === 'user_upload' ? umMissingReason(a) : '이 파일은 대시보드에 사본이 없습니다 (100 MB 초과이거나 업로드 전에 지워졌습니다).') + '</p>' + link + '</div>';
  }
  if (a.kind === 'image') return '<div class="art-full-imgwrap"><img class="art-full-img" src="' + url + '" alt="' + title + '" data-art-zoom="1"></div>';
  // A user's own upload never runs (the route serves it inert as well).
  if (a.kind === 'html') return '<iframe class="art-full-frame" sandbox="' + (a.source === 'user_upload' ? '' : 'allow-scripts') + '" src="' + url + '" title="' + title + '" referrerpolicy="no-referrer"></iframe>';
  if (a.kind === 'pdf') return '<iframe class="art-full-frame" src="' + url + '" title="' + title + '"></iframe>';
  if (a.kind === 'audio') return '<div class="art-full-audio">' + artGlyph('audio') + '<div class="art-full-meta-name">' + esc(a.name) + '</div><audio controls autoplay preload="auto" src="' + url + '"></audio></div>';
  if (a.kind === 'video') return '<video class="art-full-video" controls autoplay playsinline preload="metadata" src="' + url + '"></video>';
  if (a.kind === 'markdown' || a.kind === 'text') {
    return '<div class="art-full-doc" data-art-doc="' + escAttr(cid + '|' + a.id) + '" data-art-doc-kind="' + escAttr(a.kind) + '"><span class="art-doc-loading">불러오는 중…</span></div>';
  }
  return '<div class="art-full-meta">' + artGlyph(a.kind) + '<div class="art-full-meta-name">' + esc(a.name) + '</div>'
    + '<div class="art-full-meta-sub">' + esc(artMeta(a)) + '</div>'
    + '<a class="ui-btn is-primary" href="' + escAttr(artUrl(cid, a.id, true)) + '">다운로드</a></div>';
}

// Inline marks on one line: escape first, then code spans, links (http(s) only),
// bold, italic, strike. Raw HTML never survives.
function mdInline(s) {
  var codes = [];
  var t = String(s == null ? '' : s).replace(/\\x60([^\\x60]+)\\x60/g, function(_m, c) {
    codes.push('<code>' + esc(c) + '</code>');
    return '\\u0000' + (codes.length - 1) + '\\u0000';
  });
  t = esc(t);
  t = t.replace(/!?\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function(_m, label, href) {
    var h = safeHref(href.replace(/&amp;/g, '&'));
    return h === '#' ? label : '<a href="' + h + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\\w])\\*([^*\\s][^*]*?)\\*(?!\\w)/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return t.replace(/\\u0000(\\d+)\\u0000/g, function(_m, i) { return codes[Number(i)] || ''; });
}

// Markdown answers as documents (T1): headings, paragraphs, lists (nested),
// tables, fenced code, quotes, rules. Everything is escaped before it is marked up.
function renderMarkdownDoc(src) {
  var lines = String(src == null ? '' : src).replace(/\\r\\n?/g, '\\n').split('\\n');
  var out = [];
  var para = [];
  var i = 0;
  var flush = function() {
    if (para.length) out.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
    para = [];
  };
  var cells = function(l) {
    return l.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(function(c) { return c.trim(); });
  };
  var listRe = /^(\\s*)([-*+]|\\d{1,3}[.)])\\s+(.*)$/;
  while (i < lines.length) {
    var line = lines[i];
    var fence = line.match(/^\\s{0,3}(\\x60{3,}|~{3,})\\s*([\\w+#.-]*)/);
    if (fence) {
      flush();
      var code = [];
      i++;
      while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) { code.push(lines[i]); i++; }
      i++;
      out.push('<pre class="md-code"><code' + (fence[2] ? ' data-lang="' + escAttr(fence[2]) + '"' : '') + '>' + esc(code.join('\\n')) + '</code></pre>');
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    var h = line.match(/^\\s{0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$/);
    if (h) {
      flush();
      out.push('<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>');
      i++;
      continue;
    }
    if (/^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\\s{0,3}>/.test(line)) {
      flush();
      var quote = [];
      while (i < lines.length && /^\\s{0,3}>/.test(lines[i])) { quote.push(lines[i].replace(/^\\s{0,3}>\\s?/, '')); i++; }
      out.push('<blockquote>' + renderMarkdownDoc(quote.join('\\n')) + '</blockquote>');
      continue;
    }
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && /^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)*\\|?\\s*$/.test(lines[i + 1])) {
      flush();
      var head = cells(line);
      var rows = [];
      i += 2;
      while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
      out.push('<div class="md-table"><table><thead><tr>' + head.map(function(c) { return '<th>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>'
        + rows.map(function(r) { return '<tr>' + head.map(function(_c, k) { return '<td>' + mdInline(r[k] || '') + '</td>'; }).join('') + '</tr>'; }).join('')
        + '</tbody></table></div>');
      continue;
    }
    if (listRe.test(line)) {
      flush();
      var items = [];
      while (i < lines.length) {
        var m = lines[i].match(listRe);
        if (m) { items.push({ indent: m[1].replace(/\\t/g, '    ').length, ordered: /\\d/.test(m[2]), text: m[3] }); i++; continue; }
        if (items.length && /^\\s{2,}\\S/.test(lines[i])) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      var html = '';
      var stack = [];
      items.forEach(function(it) {
        while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';
        var top = stack[stack.length - 1];
        if (!top || it.indent > top.indent) {
          var tag = it.ordered ? 'ol' : 'ul';
          stack.push({ indent: it.indent, tag: tag });
          html += '<' + tag + '><li>';
        } else {
          html += '</li><li>';
        }
        html += mdInline(it.text);
      });
      while (stack.length) html += '</li></' + stack.pop().tag + '>';
      out.push(html);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\\n');
}

// ── Artifact DOM: fetch, settle, peek, viewer, inline audio ──

function artFind(cid, id) {
  var c = _artCache[cid];
  var hit = c && c.list ? c.list.find(function(a) { return a.id === id; }) : null;
  if (hit) return hit;
  for (var k in _sessionCache) {
    var s = _sessionCache[k];
    if (s && s.conversationId === cid && s.artifacts && s.artifacts.recent) {
      hit = s.artifacts.recent.find(function(a) { return a.id === id; });
      if (hit) return hit;
    }
  }
  return umGet(cid, id);
}

// The conversation's full list, fetched once and kept fresh by artifact_update.
function ensureArtifacts(cid, force) {
  if (!cid) return Promise.resolve([]);
  var c = _artCache[cid];
  if (c && c.state === 'loading') return c.promise;
  if (c && c.state === 'ok' && !force) return Promise.resolve(c.list);
  var entry = { state: 'loading', list: c ? c.list : null, promise: null };
  _artCache[cid] = entry;
  entry.promise = fetch('/api/dashboard/session/' + encodeURIComponent(cid) + '/artifacts')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
      entry.state = 'ok';
      entry.list = Array.isArray(data && data.artifacts) ? data.artifacts : [];
      artSettle(cid);
      return entry.list;
    })
    .catch(function() { entry.state = 'error'; return entry.list || []; });
  return entry.promise;
}

// Re-render what shows this conversation's artifacts: open cards, the panel strip,
// the turn chips and the viewer's position counter.
function artSettle(cid) {
  _expanded.forEach(function(key) {
    var s = _sessionCache[key];
    if (s && s.conversationId === cid) refreshCard(key);
  });
  if (panelOpen && panelConvId === cid) renderPanelArtifactsSection();
  if (artModalIsOpen() && _artModal.cid === cid) {
    var cur = _artModal.list[_artModal.idx];
    var list = artSortForDisplay((_artCache[cid] && _artCache[cid].list) || []);
    var at = cur ? list.findIndex(function(a) { return a.id === cur.id; }) : -1;
    if (at >= 0) { _artModal.list = list; _artModal.idx = at; renderArtModal(true); }
  }
  artAudioMark(_artAudio.el && !_artAudio.el.paused ? _artAudio.key : null);
}

// WS artifact_update: a new file or answer landed in a conversation.
// A list already fetched merges the push; otherwise anything showing this
// conversation right now (an open card — even one opened before its first
// artifact — or the panel) fetches the full list.
function onArtifactUpdate(cid, artifact) {
  var c = _artCache[cid];
  if (c && c.list && artifact && artifact.id) {
    if (!c.list.some(function(a) { return a.id === artifact.id; })) c.list = c.list.concat([artifact]);
    artSettle(cid);
    return;
  }
  var shown = panelOpen && panelConvId === cid;
  _expanded.forEach(function(key) {
    var s = _sessionCache[key];
    if (s && s.conversationId === cid) shown = true;
  });
  if (shown) ensureArtifacts(cid, true);
}

function renderPanelArtifactsSection() {
  var el = document.getElementById('panel-artifacts');
  if (!el) return;
  var cid = panelConvId;
  var c = cid ? _artCache[cid] : null;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var list = c && c.list ? c.list : ((s && s.artifacts && s.artifacts.recent) || []);
  // The user's files (지시 첨부) first, one collapsed line; then the model's 산출물.
  var umHtml = cid ? renderPanelUserMedia(_umList[cid] || [], cid, _umPanelOpen) : '';
  var html = cid ? (umHtml ? '<div class="panel-user-media" id="panel-user-media">' + umHtml + '</div>' : '') + renderPanelArtifacts(list, cid) : '';
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
  // The files each answer produced go under it (convTurnsOf: an artifact goes to
  // the first answer whose turn window holds its turn start).
  convPaint();
}

function artPeekEl() {
  return document.getElementById('art-peek');
}

function showArtPeek(anchor) {
  var el = artPeekEl();
  if (!el || !anchor || !anchor.isConnected) return;
  var cid = anchor.getAttribute('data-art-cid');
  var a = artFind(cid, anchor.getAttribute('data-art-id'));
  if (!a) return;
  clearTimeout(_artPeek.closeTimer);
  if (_artPeek.anchor === anchor && el.classList.contains('open')) return;
  _artPeek.anchor = anchor;
  el.innerHTML = renderArtPeekBody(cid, a);
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  // Beside the trigger, inside the viewport; never following the pointer.
  var r = anchor.getBoundingClientRect();
  var w = el.offsetWidth || 360;
  var h = el.offsetHeight || 270;
  var left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  var top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  fillArtDocs(el);
}

function hideArtPeek(now) {
  clearTimeout(_artPeek.openTimer);
  clearTimeout(_artPeek.closeTimer);
  var done = function() {
    var el = artPeekEl();
    _artPeek.anchor = null;
    if (!el) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = ''; // stops a playing preview and drops the iframe
  };
  if (now) done();
  else _artPeek.closeTimer = setTimeout(done, ART_PEEK_CLOSE_MS);
}

// Fill markdown / text containers ([data-art-doc]) from the content route.
function fillArtDocs(root) {
  if (!root) return;
  Array.prototype.forEach.call(root.querySelectorAll('[data-art-doc]'), function(n) {
    var key = n.getAttribute('data-art-doc') || '';
    var kind = n.getAttribute('data-art-doc-kind');
    var sep = key.indexOf('|');
    if (sep < 0) return;
    var paint = function(text) {
      if (!n.isConnected) return;
      var src = n.closest('#art-peek') ? text.slice(0, 6000) : text;
      n.innerHTML = kind === 'markdown' ? '<div class="md-doc">' + renderMarkdownDoc(src) + '</div>' : '<pre class="art-text">' + esc(src) + '</pre>';
    };
    if (_artDocCache[key] != null) { paint(_artDocCache[key]); return; }
    // The minimap needs the head only: ask for the first 64 KB (the route serves
    // ranges); the viewer fetches, and caches, the whole document.
    var peek = !!n.closest('#art-peek');
    fetch(artUrl(key.slice(0, sep), key.slice(sep + 1)), peek ? { headers: { Range: 'bytes=0-65535' } } : undefined)
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function(t) {
        if (peek) { paint(t); return; }
        _artDocCache[key] = t.length > 2000000 ? t.slice(0, 2000000) : t;
        paint(_artDocCache[key]);
      })
      .catch(function() { if (n.isConnected) n.innerHTML = '<span class="art-doc-loading">불러오지 못했습니다</span>'; });
  });
}

function artModalIsOpen() {
  var d = document.getElementById('art-modal');
  return !!(d && (d.open || d.hasAttribute('open')));
}

function openArtifactModal(cid, id, opener) {
  var dlg = document.getElementById('art-modal');
  if (!dlg || !cid || !id) return;
  var c = _artCache[cid];
  var list = artSortForDisplay((c && c.list) || []);
  if (umGet(cid, id)) {
    // A user's attachment pages through the files of its own instruction — or,
    // opened from the pinned 지시 첨부 row, through every file of the session.
    list = umSiblings(cid, id, !!(opener && opener.closest && opener.closest('#panel-user-media')));
  } else if (!list.some(function(a) { return a.id === id; })) {
    var one = artFind(cid, id);
    if (!one) return;
    list = artSortForDisplay(list.concat([one]));
  }
  if (_artAudio.el) _artAudio.el.pause();
  _artModal.cid = cid;
  _artModal.list = list;
  _artModal.idx = Math.max(0, list.findIndex(function(a) { return a.id === id; }));
  _artModal.opener = opener || null;
  renderArtModal(false);
  dialogKeep(dlg);
  if (!artModalIsOpen()) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  if (!c || c.state !== 'ok') ensureArtifacts(cid);
}

function renderArtModal(headerOnly) {
  var a = _artModal.list[_artModal.idx];
  if (!a) return;
  var cid = _artModal.cid;
  var n = _artModal.list.length;
  document.getElementById('art-modal-kind').innerHTML = artGlyph(a.kind) + esc(artKindLabel(a));
  document.getElementById('art-modal-name').textContent = a.title && a.title !== a.name ? a.title + ' — ' + a.name : a.name;
  document.getElementById('art-modal-meta').textContent = artMeta(a);
  document.getElementById('art-modal-pos').textContent = n > 1 ? (_artModal.idx + 1) + ' / ' + n : '';
  document.getElementById('art-modal-prev').disabled = _artModal.idx <= 0;
  document.getElementById('art-modal-next').disabled = _artModal.idx >= n - 1;
  var openA = document.getElementById('art-modal-open');
  var dlA = document.getElementById('art-modal-download');
  var slackA = document.getElementById('art-modal-slack');
  openA.hidden = !a.stored;
  dlA.hidden = !a.stored;
  if (a.stored) {
    openA.href = artUrl(cid, a.id);
    dlA.href = artUrl(cid, a.id, true);
  }
  var slackOk = /^https:\\/\\//i.test(String(a.permalink || ''));
  slackA.hidden = !slackOk;
  if (slackOk) slackA.href = a.permalink;
  if (headerOnly) return;
  var body = document.getElementById('art-modal-body');
  body.innerHTML = renderArtModalBody(cid, a);
  body.scrollTop = 0;
  fillArtDocs(body);
  // Start audio / video now: the autoplay attribute alone is not honoured for
  // markup inserted after load in every browser.
  var media = body.querySelector('audio, video');
  if (media && typeof media.play === 'function') {
    var started = media.play();
    if (started && typeof started.catch === 'function') started.catch(function() {});
  }
}

function artModalStep(delta) {
  var next = _artModal.idx + delta;
  if (next < 0 || next >= _artModal.list.length) return;
  _artModal.idx = next;
  renderArtModal(false);
}

function closeArtifactModal() {
  var dlg = document.getElementById('art-modal');
  if (!dlg) return;
  if (typeof dlg.close === 'function' && dlg.open) dialogCloseSoftly(dlg);
  else { dlg.removeAttribute('open'); artModalClosed(); }
}

// Runs on every close (button, Escape, backdrop): stop media, give focus back.
function artModalClosed() {
  var body = document.getElementById('art-modal-body');
  if (body) body.innerHTML = '';
  var opener = _artModal.opener;
  _artModal.opener = null;
  if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
}

// Inline audio (T8): one shared player; ▶ on a tile plays, again pauses.
function toggleArtAudio(btn) {
  var cid = btn.getAttribute('data-art-cid');
  var id = btn.getAttribute('data-art-id');
  var key = cid + '|' + id;
  if (!_artAudio.el) {
    _artAudio.el = new Audio();
    _artAudio.el.preload = 'auto';
    _artAudio.el.addEventListener('play', function() { artAudioMark(_artAudio.key); });
    _artAudio.el.addEventListener('pause', function() { artAudioMark(null); });
    _artAudio.el.addEventListener('ended', function() { artAudioMark(null); });
  }
  var au = _artAudio.el;
  if (_artAudio.key === key && !au.paused) { au.pause(); return; }
  _artAudio.key = key;
  au.src = artUrl(cid, id);
  au.play().catch(function() { artAudioMark(null); });
}

function artAudioMark(key) {
  Array.prototype.forEach.call(document.querySelectorAll('[data-art-play]'), function(b) {
    var on = !!key && b.getAttribute('data-art-cid') + '|' + b.getAttribute('data-art-id') === key;
    b.classList.toggle('is-playing', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// Keys, in the capture phase so they are seen before the panel's Escape: the
// viewer pages with ← / →; Escape with only the minimap open closes the minimap.
function artHandleKey(e) {
  if (artModalIsOpen()) {
    // A focused audio / video / field keeps its own arrow keys (seeking, caret).
    var tag = e.target && e.target.tagName ? String(e.target.tagName).toUpperCase() : '';
    if (tag === 'AUDIO' || tag === 'VIDEO' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); artModalStep(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); artModalStep(-1); }
    return;
  }
  if (e.key === 'Escape' && _artPeek.anchor) {
    e.stopPropagation();
    hideArtPeek(true);
  }
}

(function initArtifactInteractions() {
  var canHover = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
  var trigger = function(t) { return t && t.closest ? t.closest('[data-art-id]:not([data-art-play])') : null; };
  document.addEventListener('pointerover', function(e) {
    if (!canHover || e.pointerType === 'touch') return;
    var t = trigger(e.target);
    if (t) {
      clearTimeout(_artPeek.closeTimer);
      if (_artPeek.anchor === t) return;
      clearTimeout(_artPeek.openTimer);
      // Moving between chips while a minimap is open swaps it quickly.
      var warm = !!_artPeek.anchor;
      _artPeek.openTimer = setTimeout(function() { showArtPeek(t); }, warm ? 90 : ART_PEEK_DELAY_MS);
    } else if (e.target.closest && e.target.closest('#art-peek')) {
      clearTimeout(_artPeek.closeTimer);
    }
  });
  document.addEventListener('pointerout', function(e) {
    var from = e.target.closest ? (trigger(e.target) || e.target.closest('#art-peek')) : null;
    if (!from) return;
    var to = e.relatedTarget;
    if (to && to.closest && (to.closest('#art-peek') || trigger(to) === from)) return;
    clearTimeout(_artPeek.openTimer);
    if (_artPeek.anchor) hideArtPeek(false);
  });
  document.addEventListener('focusin', function(e) {
    var t = trigger(e.target);
    if (t && !t.closest('#art-modal') && t.matches(':focus-visible')) { clearTimeout(_artPeek.openTimer); showArtPeek(t); }
  });
  document.addEventListener('focusout', function(e) {
    if (trigger(e.target)) hideArtPeek(false);
  });
  document.addEventListener('click', function(e) {
    var play = e.target.closest ? e.target.closest('[data-art-play]') : null;
    if (play) { e.preventDefault(); toggleArtAudio(play); return; }
    var t = trigger(e.target);
    if (t && !t.closest('#art-modal')) {
      e.preventDefault();
      hideArtPeek(true);
      openArtifactModal(t.getAttribute('data-art-cid'), t.getAttribute('data-art-id'), t);
      return;
    }
    // A click on the minimap itself opens the same artifact full size (its audio controls excepted).
    if (e.target.closest && e.target.closest('#art-peek .art-peek-media') && !e.target.closest('audio') && _artPeek.anchor) {
      var anchor = _artPeek.anchor;
      hideArtPeek(true);
      openArtifactModal(anchor.getAttribute('data-art-cid'), anchor.getAttribute('data-art-id'), anchor);
      return;
    }
    var zoom = e.target.closest ? e.target.closest('.art-full-img') : null;
    if (zoom) zoom.parentNode.classList.toggle('is-zoomed');
  });
  window.addEventListener('keydown', artHandleKey, true);
  window.addEventListener('scroll', function() { if (_artPeek.anchor) hideArtPeek(true); }, true);
  var dlg = document.getElementById('art-modal');
  if (dlg) {
    dlg.addEventListener('close', artModalClosed);
    // Escape leaves the same way as the close button (the 180ms fade, then close()).
    dlg.addEventListener('cancel', function(e) { e.preventDefault(); closeArtifactModal(); });
    // A click on the backdrop (the dialog element itself, outside its box) closes.
    dlg.addEventListener('click', function(e) { if (e.target === dlg) closeArtifactModal(); });
  }
})();

// ── The board element: its events (wireInbox), skeleton cards until the first
// answer (no counts, no "Nothing here"), the view. Face click / Enter / Space
// and Esc are the element's own. (Drag and drop and its confirm dialogs were
// removed: .prd/10 §3.1-5 — the same Stop / Close / Trash actions live on the
// open card.)
(function initBoardInteractions() {
  var kb = document.getElementById('kanban');
  if (kb) {
    wireInbox(kb);
    kb._ibPlan = {
      cols: [
        { id: 'waiting', label: BOARD_LABELS.waiting, keys: [] },
        { id: 'working', label: BOARD_LABELS.working, keys: [] },
        { id: 'done', label: BOARD_LABELS.done, keys: [] },
      ],
      load: 'loading',
      announce: false,
    };
    inboxPaint(kb);
  }
  // View: the saved choice, else List on narrow screens (§3.1-2); runLayoutCheck
  // re-evaluates the default when a fold or rotation crosses 640px.
  setBoardView(defaultBoardView(window.innerWidth, savedBoardView()));
  // The secondary sections' disclosure state, before the first board render.
  applySectionState();
})();
// The two <ui-segmented> controls (B-02 period, D-02 Board | List): a reader's choice arrives as
// ui-change — the element has already moved its chip; the page follows through.
(function initSegmented() {
  var viewSeg = document.getElementById('view-seg');
  if (viewSeg) viewSeg.addEventListener('ui-change', function(e) { setBoardView(e.detail.value, e); });
  paintPeriodSeg();
  var periodSeg = document.getElementById('period-seg');
  if (periodSeg) periodSeg.addEventListener('ui-change', function(e) { setPeriod(e.detail.value); });
})();
// <ui-disclosure> (K-06): Raw, a system turn and a card's system instruction open and close by
// themselves; the page only keeps a card's choice across its morph re-render (_ioOpen).
// <ui-tooltip> (B-04, B-08) never opens on touch — there is no hover to end it. The breakdown and the chart values
// exist nowhere else, so on this page a tap on a tooltip's trigger toggles it (the element's show() / hide()); a tap
// anywhere else closes it, as do the element's own Esc, focus-out and scroll-away rules.
var _tapTip = null;
(function initTooltipTap() {
  var pressed = null;
  document.addEventListener('pointerdown', function(e) {
    pressed = null;
    if (e.pointerType !== 'touch') return;
    var tip = e.target && e.target.closest ? e.target.closest('ui-tooltip') : null;
    if (_tapTip && _tapTip !== tip) { _tapTip.hide(); _tapTip = null; }
    if (tip) pressed = { tip: tip, open: _tapTip === tip };
  }, true);
  document.addEventListener('click', function(e) {
    var p = pressed;
    pressed = null;
    if (!p || !p.tip.contains(e.target) || p.tip.hasAttribute('disabled')) return;
    if (p.open) { p.tip.hide(); _tapTip = null; } else { p.tip.show(); _tapTip = p.tip.open ? p.tip : null; }
  });
})();
// @2lab.ai/ui 0.5.0 toggles a <ui-disclosure> only when the click's target is inside its own head, and a click on
// slotted summary content (a System row's words and badge, a card's instruction line) keeps the light-DOM span as
// its target — so it did nothing (D1-GAPS G4-4). The page toggles it then, with the element's toggle() (its
// cancelable ui-toggle, its motion) — unless the element already toggled itself in that click (a fixed release).
// Pure: the disclosure whose slotted summary a click target sits in, or null.
function dcSummaryHost(t) {
  var s = t && t.closest ? t.closest('[slot="summary"]') : null;
  var d = s ? s.parentElement : null;
  return d && d.tagName === 'UI-DISCLOSURE' ? d : null;
}
(function initDisclosures() {
  var pending = null; // the disclosure a click on its summary content is passing through
  document.addEventListener('click', function(e) { pending = dcSummaryHost(e.target); }, true);
  document.addEventListener('ui-toggle', function(e) {
    var t = e.target;
    if (t === pending) pending = null;
    if (t && t.classList && t.classList.contains('io-sys')) ioSysToggle(t.getAttribute('data-cid') || '', e.detail && e.detail.open);
  });
  document.addEventListener('click', function() {
    var d = pending;
    pending = null;
    if (d && d.isConnected && typeof d.toggle === 'function') d.toggle();
  });
})();
// Spec 12 §4.3 — the panel's agent section: a path step drills into that node
// (a subtree row is <ui-agent-tree>'s ui-select).
(function initPanelAgentInteractions() {
  var bar = document.getElementById('panel-agents');
  if (!bar) return;
  bar.addEventListener('click', function(e) {
    var pick = e.target.closest('.pa-crumb[data-agent-select]');
    if (pick && bar.contains(pick) && pick.getAttribute('aria-current') !== 'page') {
      selectPanelAgent(pick.getAttribute('data-agent-select') || '');
    }
  });
})();

// ── New task (SSOT 2026-10-23) ──
// The composer behind the New task button / floating button. It loads what
// this user may choose (GET /api/dashboard/new-task/context: models with a
// shared-pool quota battery, efforts, repo channels, the autogoal default),
// collects the instruction and attachments (file picker, camera on phones,
// voice via MediaRecorder, drag-and-drop and pasted screenshots on PC) and
// starts the task (POST /api/dashboard/new-task, XHR for upload progress).
// The task then runs in the chosen Slack channel; its card arrives over the
// WebSocket like any other session.
var NT_DRAFT_KEY = 'soma-nt-draft';
var NT_MAX_RECORD_SEC = 600;
var NT_ICON_X = '<i data-ui-icon="close"></i>';
var NT_ICON_FILE = '<i data-ui-icon="file"></i>';
var NT_ICON_PLAY = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z"/></svg>';
var NT_ICON_PAUSE = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z"/></svg>';
var _ntCtx = null;
var _ntState = null;
var _ntFiles = [];
var _ntSeq = 0;
var _ntBusy = false;
var _ntRequestId = null;
var _ntRec = null;
var _ntAudio = null;
var _ntPlayingId = 0;

function ntBatteryView(b) {
  if (!b || typeof b.level !== 'number') {
    return { cls: 'nt-batt-unknown', pct: '?', fill: 0, label: '잔여량 미확인 · 공유 풀 추정' };
  }
  var pct = Math.round(b.level * 100);
  var cls = b.level >= 0.5 ? 'nt-batt-high' : b.level >= 0.2 ? 'nt-batt-mid' : 'nt-batt-low';
  var parts = ['공유 풀 추정 ' + pct + '%'];
  (b.windows || []).forEach(function (w) {
    if (typeof w.remaining === 'number') parts.push(w.label + ' ' + Math.round(w.remaining * 100) + '%');
  });
  if (b.accounts) parts.push('가용 ' + b.accounts.available + '/' + b.accounts.total);
  if (typeof b.best === 'number') parts.push('최대 ' + Math.round(b.best * 100) + '%');
  return { cls: cls, pct: pct + '%', fill: pct, label: parts.join(' · ') };
}

function ntDefaultState(ctx, draft) {
  return {
    model: ctx.defaultModel,
    effort: ctx.defaultEffort,
    channelId: ctx.defaultChannelId || null,
    autogoal: !!ctx.autogoalDefault,
    autoz: false,
    prompt: draft && typeof draft.prompt === 'string' ? draft.prompt : '',
  };
}

function ntBuildPayload(state, attachments, requestId) {
  return {
    requestId: requestId,
    prompt: state.prompt,
    model: state.model,
    effort: state.effort,
    channelId: state.channelId,
    autogoal: state.autogoal,
    autoz: state.autoz,
    attachments: attachments.map(function (a) {
      return { name: a.name, mimetype: a.mimetype, data: a.data };
    }),
  };
}

function ntCanSubmit(state, attachments) {
  if (!state || !state.channelId) return false;
  return String(state.prompt || '').trim().length > 0 || (attachments || []).length > 0;
}

function ntPickRecorderMime(isSupported) {
  // MP4/AAC first (Safari, Chrome, Edge), then Ogg/Opus (Firefox). WebM last:
  // a .webm file reads as video and would skip transcription.
  var candidates = ['audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (isSupported(candidates[i])) return candidates[i];
    } catch (e) {}
  }
  return '';
}

function ntExtForMime(m) {
  var t = String(m || '').toLowerCase();
  if (t.indexOf('audio/mp4') === 0 || t.indexOf('audio/aac') === 0 || t.indexOf('audio/x-m4a') === 0) return 'm4a';
  if (t.indexOf('ogg') >= 0) return 'ogg';
  if (t.indexOf('webm') >= 0) return 'webm';
  if (t.indexOf('mpeg') >= 0) return 'mp3';
  if (t.indexOf('wav') >= 0) return 'wav';
  return 'bin';
}

function ntFormatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return Math.round((n / 1024 / 1024) * 10) / 10 + ' MB';
}

function ntFormatDuration(sec) {
  var s = Math.max(0, Math.floor(sec));
  var r = s % 60;
  return Math.floor(s / 60) + ':' + (r < 10 ? '0' : '') + r;
}

function ntStamp(d) {
  var p = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function ntEl(id) {
  return document.getElementById(id);
}

function ntNewRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function ntIsTouch() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

function ntIsTypingTarget(t) {
  if (document.querySelector('dialog[open]')) return true;
  if (!t) return false;
  var tag = String(t.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
}

function ntReadDraft() {
  try {
    return JSON.parse(localStorage.getItem(NT_DRAFT_KEY) || 'null');
  } catch (e) {
    return null;
  }
}

function ntSaveDraft() {
  try {
    if (_ntState && _ntState.prompt) localStorage.setItem(NT_DRAFT_KEY, JSON.stringify({ prompt: _ntState.prompt }));
    else localStorage.removeItem(NT_DRAFT_KEY);
  } catch (e) {}
}

function ntSetStatus(text) {
  var s = ntEl('nt-status');
  if (s) s.textContent = text || '';
}

function ntSetError(text) {
  var e = ntEl('nt-error');
  if (!e) return;
  e.textContent = text || '';
  e.hidden = !text;
}

async function openNewTask() {
  var dlg = ntEl('nt-dialog');
  if (!dlg || dlg.open) return;
  document.body.classList.add('nt-open');
  ntSetError('');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  ntSyncViewport();
  requestAnimationFrame(function () {
    dlg.classList.add('is-shown');
  });
  if (!_ntRequestId) _ntRequestId = ntNewRequestId();
  if (_ntState) ntRender();
  else ntEl('nt-submit').disabled = true;
  if (!ntIsTouch()) {
    setTimeout(function () {
      var p = ntEl('nt-prompt');
      if (p && dlg.open) p.focus();
    }, 60);
  }
  ntSetStatus(_ntCtx ? '' : '불러오는 중…');
  await ntLoadContext();
}

function closeNewTask() {
  var dlg = ntEl('nt-dialog');
  if (!dlg || !dlg.open) return;
  if (_ntRec) ntStopRecording(false);
  dlg.classList.remove('is-shown');
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  setTimeout(function () {
    if (dlg.open) dlg.close();
  }, reduce ? 0 : 180);
}

function ntOnClosed() {
  document.body.classList.remove('nt-open');
  if (_ntRec) ntStopRecording(false);
  if (_ntAudio) _ntAudio.pause();
  var dlg = ntEl('nt-dialog');
  if (dlg) dlg.classList.remove('is-shown');
}

async function ntLoadContext() {
  try {
    var res = await fetch('/api/dashboard/new-task/context');
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      ntSetStatus('');
      ntSetError(data.error || '새 작업 정보를 불러오지 못했습니다 (' + res.status + ')');
      return;
    }
    _ntCtx = data.context;
    if (!_ntState) _ntState = ntDefaultState(_ntCtx, ntReadDraft());
    else ntReconcileState();
    ntSetStatus('');
    ntRender();
  } catch (e) {
    ntSetStatus('');
    ntSetError('새 작업 정보를 불러오지 못했습니다 — 네트워크를 확인해 주세요');
  }
}

function ntReconcileState() {
  // A choice that is no longer offered falls back to the default.
  var hasModel = _ntCtx.models.some(function (m) {
    return m.nickname === _ntState.model;
  });
  if (!hasModel) _ntState.model = _ntCtx.defaultModel;
  if (_ntCtx.efforts.indexOf(_ntState.effort) < 0) _ntState.effort = _ntCtx.defaultEffort;
  var hasChannel = _ntCtx.channels.some(function (c) {
    return c.id === _ntState.channelId;
  });
  if (!hasChannel) _ntState.channelId = _ntCtx.defaultChannelId || null;
}

function ntRender() {
  if (!_ntCtx || !_ntState) return;
  ntEl('nt-model').innerHTML = _ntCtx.models
    .map(function (m) {
      var sel = m.nickname === _ntState.model ? ' selected' : '';
      return '<option value="' + escAttr(m.nickname) + '" title="' + escAttr(m.label) + '"' + sel + '>' + esc(m.nickname) + '</option>';
    })
    .join('');
  ntEl('nt-effort').innerHTML = _ntCtx.efforts
    .map(function (e) {
      return '<option value="' + escAttr(e) + '"' + (e === _ntState.effort ? ' selected' : '') + '>' + esc(e) + '</option>';
    })
    .join('');
  var channel = ntEl('nt-channel');
  if (_ntCtx.channels.length) {
    channel.innerHTML = _ntCtx.channels
      .map(function (c) {
        var repos = (c.repos || []).map(function (r) {
          return r.split('/').pop();
        });
        var label = '#' + c.name + (repos.length ? ' · ' + repos.join(', ') : '');
        return '<option value="' + escAttr(c.id) + '"' + (c.id === _ntState.channelId ? ' selected' : '') + '>' + esc(label) + '</option>';
      })
      .join('');
    channel.disabled = false;
  } else {
    channel.innerHTML = '<option value="">' + (_ntCtx.membershipUnknown ? '채널 확인 실패' : '채널 없음') + '</option>';
    channel.disabled = true;
    ntSetError(
      _ntCtx.membershipUnknown
        ? 'Slack 채널 멤버십을 확인하지 못해 채널을 보여 드릴 수 없습니다 — 잠시 후 다시 열어 주세요'
        : '작업을 올릴 수 있는 채널이 없습니다 — repo가 연결된 Slack 채널에 참여해 주세요',
    );
  }
  ntEl('nt-autogoal').setAttribute('aria-pressed', _ntState.autogoal ? 'true' : 'false');
  ntEl('nt-autoz').setAttribute('aria-pressed', _ntState.autoz ? 'true' : 'false');
  var p = ntEl('nt-prompt');
  if (p.value !== _ntState.prompt) p.value = _ntState.prompt;
  ntRenderBattery();
  ntRenderFiles();
  ntRenderCount();
  ntAutosize();
  ntUpdateSubmit();
}

function ntRenderBattery() {
  var m = _ntCtx.models.find(function (x) {
    return x.nickname === _ntState.model;
  });
  var v = ntBatteryView(m ? m.battery : null);
  var btn = ntEl('nt-battery-btn');
  btn.className = 'nt-battery-btn ' + v.cls;
  btn.title = v.label;
  ntEl('nt-battery-fill').style.width = v.fill + '%';
  ntEl('nt-battery-pct').textContent = v.pct;
  ntEl('nt-battery').setAttribute('aria-label', '모델 잔여량 ' + v.label);
  var usage = _ntCtx.usage || {};
  var extra = [];
  if (usage.source) extra.push(usage.source === 'llmux' ? 'llmux 계정 풀' : 'CCT 슬롯');
  if (usage.fetchedAt) {
    var min = Math.max(0, Math.round((Date.now() - usage.fetchedAt) / 60000));
    extra.push(min < 1 ? '방금 측정' : min + '분 전 측정');
  }
  ntEl('nt-usage').textContent = v.label + (extra.length ? ' · ' + extra.join(' · ') : '');
}

function ntToggleUsage() {
  var u = ntEl('nt-usage');
  u.hidden = !u.hidden;
  ntEl('nt-battery-btn').setAttribute('aria-expanded', u.hidden ? 'false' : 'true');
}

function ntOnModelChange() {
  _ntState.model = ntEl('nt-model').value;
  ntRenderBattery();
}

function ntOnEffortChange() {
  _ntState.effort = ntEl('nt-effort').value;
}

function ntOnChannelChange() {
  _ntState.channelId = ntEl('nt-channel').value || null;
  ntUpdateSubmit();
}

function ntToggle(which) {
  if (!_ntState) return;
  _ntState[which] = !_ntState[which];
  ntEl('nt-' + which).setAttribute('aria-pressed', _ntState[which] ? 'true' : 'false');
  if (navigator.vibrate) {
    try {
      navigator.vibrate(8);
    } catch (e) {}
  }
}

function ntOnInput() {
  if (!_ntState) return;
  _ntState.prompt = ntEl('nt-prompt').value;
  ntSaveDraft();
  ntAutosize();
  ntRenderCount();
  ntUpdateSubmit();
}

function ntRenderCount() {
  var max = _ntCtx ? _ntCtx.limits.maxPromptChars : 12000;
  var len = (_ntState && _ntState.prompt ? _ntState.prompt : '').length;
  var el = ntEl('nt-count');
  el.textContent = len > max * 0.8 ? len + ' / ' + max : '';
}

function ntAutosize() {
  var p = ntEl('nt-prompt');
  if (!p || (window.matchMedia && window.matchMedia('(max-width: 639px)').matches)) return;
  p.style.height = 'auto';
  p.style.height = Math.min(p.scrollHeight + 2, Math.round(window.innerHeight * 0.44)) + 'px';
}

function ntUpdateSubmit() {
  var b = ntEl('nt-submit');
  if (b) b.disabled = _ntBusy || !ntCanSubmit(_ntState, _ntFiles);
}

function ntKindOf(mime) {
  var t = String(mime || '');
  if (t.indexOf('image/') === 0) return 'image';
  if (t.indexOf('audio/') === 0) return 'audio';
  if (t.indexOf('video/') === 0) return 'video';
  return 'file';
}

function ntAddFiles(list, source) {
  Array.prototype.slice.call(list || []).forEach(function (f) {
    var type = f.type || 'application/octet-stream';
    var name = f.name || 'file';
    if (source === 'camera' && ntKindOf(type) === 'image') {
      var ext = (name.split('.').pop() || 'jpg').toLowerCase();
      name = 'photo-' + ntStamp(new Date()) + '.' + ext;
    }
    ntAddBlob(f, name, type, source);
  });
}

function ntAddBlob(blob, name, mimetype, source, extra) {
  var limits = _ntCtx ? _ntCtx.limits : { maxFiles: 10, maxFileBytes: 20971520, maxTotalBytes: 31457280 };
  if (_ntFiles.length >= limits.maxFiles) {
    ntSetError('첨부는 최대 ' + limits.maxFiles + '개까지 가능합니다');
    return;
  }
  if (!blob.size) {
    ntSetError(name + ' — 빈 파일은 첨부할 수 없습니다');
    return;
  }
  if (blob.size > limits.maxFileBytes) {
    ntSetError(name + ' — 파일 하나는 ' + ntFormatBytes(limits.maxFileBytes) + '까지 첨부할 수 있습니다');
    return;
  }
  var total = _ntFiles.reduce(function (sum, f) {
    return sum + f.size;
  }, 0);
  if (total + blob.size > limits.maxTotalBytes) {
    ntSetError('첨부는 모두 합쳐 ' + ntFormatBytes(limits.maxTotalBytes) + '까지입니다');
    return;
  }
  ntSetError('');
  var entry = {
    id: ++_ntSeq,
    name: name,
    mimetype: mimetype,
    size: blob.size,
    kind: ntKindOf(mimetype),
    data: null,
    url: null,
    duration: extra && extra.duration ? extra.duration : 0,
    source: source,
  };
  if (entry.kind === 'image' || entry.kind === 'audio') {
    try {
      entry.url = URL.createObjectURL(blob);
    } catch (e) {}
  }
  entry.ready = new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var s = String(reader.result || '');
      var comma = s.indexOf(',');
      entry.data = comma >= 0 ? s.slice(comma + 1) : '';
      resolve();
    };
    reader.onerror = function () {
      reject(new Error(name));
    };
    reader.readAsDataURL(blob);
  });
  entry.ready.catch(function () {
    ntRemoveFile(entry.id);
    ntSetError(name + ' — 파일을 읽지 못했습니다');
  });
  _ntFiles.push(entry);
  ntRenderFiles();
  ntUpdateSubmit();
  var box = ntEl('nt-attachments');
  if (box) box.scrollLeft = box.scrollWidth;
}

function ntRemoveFile(id) {
  _ntFiles = _ntFiles.filter(function (f) {
    if (f.id === id && f.url) {
      try {
        URL.revokeObjectURL(f.url);
      } catch (e) {}
    }
    return f.id !== id;
  });
  if (_ntPlayingId === id && _ntAudio) _ntAudio.pause();
  ntRenderFiles();
  ntUpdateSubmit();
}

function ntRenderFiles() {
  var box = ntEl('nt-attachments');
  if (!box) return;
  box.innerHTML = _ntFiles
    .map(function (f) {
      var thumb;
      if (f.kind === 'image' && f.url) {
        thumb = '<img class="nt-att-thumb" src="' + escAttr(f.url) + '" alt="">';
      } else if (f.kind === 'audio' && f.url) {
        var playing = _ntPlayingId === f.id;
        thumb = '<button type="button" class="nt-att-play" aria-label="' + escAttr(f.name) + (playing ? ' 정지' : ' 재생') + '" onclick="ntPlay(' + f.id + ')">' + (playing ? NT_ICON_PAUSE : NT_ICON_PLAY) + '</button>';
      } else {
        thumb = '<span class="nt-att-thumb" aria-hidden="true">' + NT_ICON_FILE + '</span>';
      }
      var meta = (f.duration ? ntFormatDuration(f.duration) + ' · ' : '') + ntFormatBytes(f.size);
      return (
        '<div class="nt-att" data-id="' + f.id + '">' + thumb +
        '<span class="nt-att-text"><span class="nt-att-name" title="' + escAttr(f.name) + '">' + esc(f.name) + '</span>' +
        '<span class="nt-att-meta">' + esc(meta) + '</span></span>' +
        '<button type="button" class="nt-att-remove" aria-label="' + escAttr(f.name) + ' 삭제" onclick="ntRemoveFile(' + f.id + ')">' + NT_ICON_X + '</button></div>'
      );
    })
    .join('');
}

function ntPlay(id) {
  var f = _ntFiles.find(function (x) {
    return x.id === id;
  });
  if (!f || !f.url) return;
  if (!_ntAudio) {
    _ntAudio = new Audio();
    _ntAudio.onended = _ntAudio.onpause = function () {
      _ntPlayingId = 0;
      ntRenderFiles();
    };
  }
  if (_ntPlayingId === id) {
    _ntAudio.pause();
    return;
  }
  _ntAudio.src = f.url;
  _ntPlayingId = id;
  _ntAudio.play().catch(function () {
    _ntPlayingId = 0;
  });
  ntRenderFiles();
}

async function ntToggleRecording() {
  if (_ntRec) {
    ntStopRecording(true);
    return;
  }
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!canRecord) {
    ntEl('nt-audio-input').click();
    return;
  }
  var stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    ntSetError('마이크를 쓸 수 없습니다 (' + (e && e.name ? e.name : '권한 거부') + ') — 기기 녹음기로 녹음해 첨부해 주세요');
    ntEl('nt-audio-input').click();
    return;
  }
  var mime = ntPickRecorderMime(function (t) {
    return MediaRecorder.isTypeSupported(t);
  });
  var recorder;
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    recorder = new MediaRecorder(stream);
  }
  var state = {
    recorder: recorder,
    stream: stream,
    chunks: [],
    started: Date.now(),
    mime: recorder.mimeType || mime || 'audio/mp4',
    keep: true,
    finished: false,
    timer: 0,
    raf: 0,
    audioCtx: null,
  };
  _ntRec = state;
  recorder.ondataavailable = function (ev) {
    if (ev.data && ev.data.size) state.chunks.push(ev.data);
  };
  recorder.onstop = function () {
    ntFinishRecording(state);
  };
  recorder.start(1000);
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AC();
    var analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    state.audioCtx.createMediaStreamSource(stream).connect(analyser);
    var buf = new Uint8Array(analyser.fftSize);
    var tick = function () {
      if (_ntRec !== state) return;
      analyser.getByteTimeDomainData(buf);
      var peak = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = Math.abs(buf[i] - 128);
        if (v > peak) peak = v;
      }
      ntEl('nt-rec-level').style.width = Math.min(100, Math.round((peak / 128) * 160)) + '%';
      state.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {}
  ntEl('nt-recorder').hidden = false;
  ntEl('nt-rec-time').textContent = '0:00';
  var mic = ntEl('nt-mic');
  mic.setAttribute('aria-pressed', 'true');
  mic.setAttribute('aria-label', '녹음 완료');
  state.timer = setInterval(function () {
    var sec = Math.floor((Date.now() - state.started) / 1000);
    ntEl('nt-rec-time').textContent = ntFormatDuration(sec);
    if (sec >= NT_MAX_RECORD_SEC) ntStopRecording(true);
  }, 250);
  if (navigator.vibrate) {
    try {
      navigator.vibrate(12);
    } catch (e) {}
  }
}

function ntStopRecording(keep) {
  var state = _ntRec;
  if (!state) return;
  _ntRec = null;
  state.keep = keep;
  state.stoppedAt = Date.now();
  clearInterval(state.timer);
  cancelAnimationFrame(state.raf);
  try {
    if (state.recorder.state !== 'inactive') state.recorder.stop();
    else ntFinishRecording(state);
  } catch (e) {
    ntFinishRecording(state);
  }
  state.stream.getTracks().forEach(function (t) {
    t.stop();
  });
  if (state.audioCtx) {
    try {
      state.audioCtx.close();
    } catch (e) {}
  }
  ntEl('nt-recorder').hidden = true;
  var mic = ntEl('nt-mic');
  mic.setAttribute('aria-pressed', 'false');
  mic.setAttribute('aria-label', '음성 녹음');
}

function ntFinishRecording(state) {
  if (state.finished) return;
  state.finished = true;
  if (!state.keep || !state.chunks.length) return;
  var type = String(state.mime).split(';')[0] || 'audio/mp4';
  var blob = new Blob(state.chunks, { type: type });
  var sec = Math.max(1, Math.round(((state.stoppedAt || Date.now()) - state.started) / 1000));
  ntAddBlob(blob, 'voice-' + ntStamp(new Date()) + '.' + ntExtForMime(type), type, 'voice', { duration: sec });
}

async function submitNewTask(ev) {
  if (ev) ev.preventDefault();
  if (_ntBusy || !_ntCtx || !_ntState) return;
  if (_ntRec) {
    ntStopRecording(true);
    await new Promise(function (resolve) {
      setTimeout(resolve, 300);
    });
  }
  _ntState.prompt = ntEl('nt-prompt').value;
  if (!ntCanSubmit(_ntState, _ntFiles)) {
    ntSetError(_ntState.channelId ? '작업 지시를 쓰거나 파일을 첨부해 주세요' : '작업을 올릴 채널을 골라 주세요');
    return;
  }
  _ntBusy = true;
  ntSetError('');
  var btn = ntEl('nt-submit');
  btn.classList.add('is-busy');
  ntUpdateSubmit();
  try {
    if (_ntFiles.length) ntSetStatus('첨부 준비 중…');
    await Promise.all(
      _ntFiles.map(function (f) {
        return f.ready;
      }),
    );
    var body = JSON.stringify(ntBuildPayload(_ntState, _ntFiles, _ntRequestId));
    ntSetStatus('작업을 올리는 중…');
    var res = await ntPostTask(body);
    // Only a stale CSRF token is worth one retry (not "no Slack identity").
    if (res.status === 403 && res.data && /CSRF/i.test(String(res.data.error || ''))) {
      await refreshCsrfToken();
      res = await ntPostTask(body);
    }
    var data = res.data || {};
    if (res.status < 200 || res.status >= 300 || !data.ok) {
      ntSetStatus('');
      ntSetError(data.error || '작업을 시작하지 못했습니다 (' + res.status + ')');
      return;
    }
    ntOnLaunched(data);
  } catch (e) {
    ntSetStatus('');
    ntSetError('작업을 시작하지 못했습니다 — 네트워크를 확인하고 다시 눌러 주세요 (같은 요청은 두 번 실행되지 않습니다)');
  } finally {
    _ntBusy = false;
    btn.classList.remove('is-busy');
    ntUpdateSubmit();
  }
}

function ntPostTask(body) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/dashboard/new-task');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-CSRF-Token', _csrfToken);
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable && e.total > 65536) {
        ntSetStatus('업로드 중… ' + Math.round((e.loaded / e.total) * 100) + '%');
      }
    };
    xhr.upload.onload = function () {
      ntSetStatus('Slack에 작업을 올리는 중…');
    };
    xhr.onload = function () {
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {}
      resolve({ status: xhr.status, data: data });
    };
    xhr.onerror = function () {
      reject(new Error('network'));
    };
    xhr.send(body);
  });
}

function ntOnLaunched(data) {
  // The next task starts clean: a new idempotency key, no text, no files;
  // the channel just used stays selected.
  _ntRequestId = ntNewRequestId();
  _ntFiles.forEach(function (f) {
    if (f.url) {
      try {
        URL.revokeObjectURL(f.url);
      } catch (e) {}
    }
  });
  _ntFiles = [];
  _ntState = ntDefaultState(_ntCtx, null);
  _ntState.channelId = data.channel || _ntState.channelId;
  try {
    localStorage.removeItem(NT_DRAFT_KEY);
  } catch (e) {}
  ntSetStatus('');
  ntRender();
  closeNewTask();
  var channel = _ntCtx.channels.find(function (c) {
    return c.id === data.channel;
  });
  // A toast on the page's <ui-toaster>: 카드 열기 opens this launch's card
  // (not a later launch's), Slack에서 보기 its thread.
  var toast = {
    title: data.status === 'running' ? '작업을 시작했어요' : '작업을 접수했어요',
    description: '#' + (channel ? channel.name : data.channel),
    tone: 'success',
    action: { id: 'open', label: '카드 열기' },
    duration: 12000,
  };
  if (data.permalink) toast.link = { label: 'Slack에서 보기', href: String(data.permalink) };
  dashToast(toast, function () { ntOpenLaunched(data); });
  if (typeof loadSessions === 'function') setTimeout(loadSessions, 800);
}

async function ntOpenLaunched(launch) {
  var key = launch && launch.sessionKey;
  if (!key) return;
  var find = function () {
    var cache = typeof _sessionCache === 'object' && _sessionCache ? _sessionCache : {};
    return Object.keys(cache).find(function (k) {
      return k === key || k.slice(-(key.length + 2)) === '::' + key;
    });
  };
  var found = find();
  if (!found && typeof loadSessions === 'function') {
    await loadSessions();
    found = find();
  }
  if (found) openPanel(found);
  else if (launch.permalink) window.open(launch.permalink, '_blank', 'noopener');
}

function ntSyncViewport() {
  var vv = window.visualViewport;
  var dlg = ntEl('nt-dialog');
  if (!vv || !dlg) return;
  dlg.style.setProperty('--nt-vvh', Math.round(vv.height) + 'px');
  dlg.style.setProperty('--nt-vvt', Math.round(vv.offsetTop) + 'px');
}

function ntInit() {
  var dlg = ntEl('nt-dialog');
  if (!dlg) return;
  // Esc closes with the same animation as the close button.
  dlg.addEventListener('cancel', function (e) {
    e.preventDefault();
    closeNewTask();
  });
  dlg.addEventListener('click', function (e) {
    if (e.target === dlg) closeNewTask();
  });
  // PC: drop files anywhere on the composer; paste screenshots into the text.
  // (File drop into the composer only — board cards stay non-draggable, §3.1-5.)
  var compose = ntEl('nt-compose');
  var hasFiles = function (e) {
    return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
  };
  dlg.ondragenter = function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    compose.classList.add('is-drag');
  };
  dlg.ondragover = function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    compose.classList.add('is-drag');
  };
  dlg.ondragleave = function (e) {
    if (!e.relatedTarget || !dlg.contains(e.relatedTarget)) compose.classList.remove('is-drag');
  };
  dlg.ondrop = function (e) {
    compose.classList.remove('is-drag');
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    ntAddFiles(e.dataTransfer.files, 'dragged');
  };
  var prompt = ntEl('nt-prompt');
  prompt.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files ? Array.prototype.slice.call(e.clipboardData.files) : [];
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    files.forEach(function (f) {
      var type = f.type || 'application/octet-stream';
      var generic = !f.name || f.name === 'image.png' || f.name === 'image.jpeg';
      var name = generic ? 'screenshot-' + ntStamp(new Date()) + '.' + (type.split('/')[1] || 'png') : f.name;
      ntAddBlob(f, name, type, 'paste');
    });
  });
  prompt.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitNewTask();
    }
  });
  // N opens the composer from anywhere outside a text field.
  document.addEventListener('keydown', function (e) {
    var key = String(e.key || '').toLowerCase();
    if (key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && !ntIsTypingTarget(e.target)) {
      e.preventDefault();
      openNewTask();
    }
  });
  // Phones: the floating button folds to a circle while scrolling down.
  var fab = ntEl('new-task-fab');
  var lastY = window.scrollY;
  window.addEventListener(
    'scroll',
    function () {
      var y = window.scrollY;
      if (Math.abs(y - lastY) < 8) return;
      fab.classList.toggle('is-compact', y > lastY && y > 80);
      lastY = y;
    },
    { passive: true },
  );
  // PC: once the top-bar button scrolls out of view, the floating one appears.
  var topBtn = ntEl('new-task-btn');
  if (topBtn && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      fab.classList.toggle('is-floating', !entries[0].isIntersecting);
    }).observe(topBtn);
  }
  // Phones: keep the sheet (and its toolbar) above the on-screen keyboard.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', ntSyncViewport);
    window.visualViewport.addEventListener('scroll', ntSyncViewport);
  }
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  var hint = ntEl('nt-submit-hint');
  if (hint) hint.textContent = isMac ? '⌘↵' : 'Ctrl+↵';
  var nkbd = document.querySelector('#new-task-btn .nt-kbd');
  if (nkbd && ntIsTouch()) nkbd.hidden = true;
}

// ── Drawer geometry (SSOT 2026-10-24) ──
// The drawer follows the visual viewport, so its composer stays above the
// on-screen keyboard (the new-task sheet's ntSyncViewport, for the drawer).
function syncPanelViewport() {
  var vv = window.visualViewport;
  var panel = document.getElementById('slide-panel');
  if (!vv || !panel) return;
  panel.style.setProperty('--pv-h', Math.round(vv.height) + 'px');
  panel.style.setProperty('--pv-t', Math.round(vv.offsetTop) + 'px');
}
// Docked, the drawer sits under the top bar (sticky, SSOT 2026-10-29 T3 — always on screen).
function syncTopbarBottom() {
  var bar = document.querySelector('.topbar');
  if (!bar) return;
  var b = Math.max(0, Math.round(bar.getBoundingClientRect().bottom));
  document.documentElement.style.setProperty('--topbar-b', b + 'px');
}
(function initPanelViewport() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncPanelViewport);
    window.visualViewport.addEventListener('scroll', syncPanelViewport);
  }
  syncPanelViewport();
  var queued = false;
  function queueTopbar() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function() { queued = false; syncTopbarBottom(); });
  }
  window.addEventListener('scroll', queueTopbar, { passive: true });
  window.addEventListener('resize', queueTopbar, { passive: true });
  var bar = document.querySelector('.topbar');
  if (bar && 'ResizeObserver' in window) new ResizeObserver(syncTopbarBottom).observe(bar);
  syncTopbarBottom();
})();
// Layout-shift signals: the window (fold, unfold, rotation — the resize event runs
// before this frame's paint), the inbox's own size (a docked drawer, a drag of its
// edge; ResizeObserver also runs before paint), and openPanel / closePanel.
(function initLayoutTransitions() {
  window.addEventListener('resize', requestLayoutCheck, { passive: true });
  var inbox = document.getElementById('inbox');
  if (inbox && 'ResizeObserver' in window) new ResizeObserver(function() { runLayoutCheck(); }).observe(inbox);
  // What the reader last saw: the scroll at every scroll event, and a fresh cache
  // once scrolling (page, board, drawer) or a card transition settles.
  function onScroll() {
    _lastScroll = layoutScrollNow();
    scheduleLayoutRefresh(120);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  var ps = document.getElementById('panel-scroll');
  if (ps) ps.addEventListener('scroll', function() { scheduleLayoutRefresh(120); }, { passive: true });
  // The reader's own input in the panel: a shift no longer restores the old place.
  var panel = document.getElementById('slide-panel');
  if (panel) {
    ['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function(type) {
      panel.addEventListener(type, function() { _panelScrollGen++; }, { passive: true, capture: true });
    });
  }
})();

// ── Init ──
loadUsers();
loadSessions();
loadStats();
connectWs();
// ── Steering composer (task view T1.5; dashboard batch 2) ──
// The panel's composer is <ui-agent-steering>: a multiline instruction to the
// session above its follow-up queue. The element owns the field — Enter, Shift+
// Enter, ⌘/Ctrl+Enter, an IME composition (한글) that never sends, a phone's Enter
// as a line break, the field's growth — and the queue's rows; this page owns what
// goes in its slots: images (pasted, dropped or picked), files and voice notes.
// The files ride in the command body as base64 (pcCommandBody) under the new-task
// limits; the server puts them in the session's Slack thread like files the user
// attached there. The pure helpers of the new-task composer are shared (ntKindOf,
// ntStamp, ntFormatBytes, ntFormatDuration, ntPickRecorderMime, ntExtForMime).
var PC_LIMITS = { maxFiles: 10, maxFileBytes: 20971520, maxTotalBytes: 31457280 };
var _pcFiles = [];
var _pcSeq = 0;
var _pcRec = null;
var _pcRecGen = 0; // bumped by pcReset: a recording (or a pending mic permission) from before belongs to no one
var _pcFiling = null; // a stopped recording not filed yet (its done promise) — every send waits on it (#488)
var _pcSending = false; // one send at a time, from the first wait on
function pcCanSend(message, files) {
  return String(message || '').trim().length > 0 || (files || []).length > 0;
}
function pcCommandBody(message, files) {
  var list = files || [];
  if (!list.length) return { message: message };
  return {
    message: message,
    attachments: list.map(function(f) { return { name: f.name, mimetype: f.mimetype, data: f.data }; }),
  };
}
// What this page holds for the next message: its files, and a recording still
// running (the send files it first) — the element lets a note with no text go then.
function pcHeldFiles() {
  return (_pcFiles ? _pcFiles.length : 0) + (_pcRec ? 1 : 0);
}
// The held files changed: the element's data follows (attachments).
function pcSyncSteer() {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  if (s) renderPanelComposer(s);
}
// A fresh element for another session: what the old one showed — the text being
// typed, notes in flight, a failed send's Retry — was the other session's. The
// page's slotted tools and chips move across; the listeners sit on #panel-command.
function pcFreshSteer() {
  var old = document.getElementById('cmd-steer');
  if (!old) return;
  var el = document.createElement('ui-agent-steering');
  el.id = 'cmd-steer';
  el.setAttribute('lang', 'ko');
  while (old.firstChild) el.appendChild(old.firstChild);
  old.replaceWith(el);
}
function pcSetError(text) {
  var el = document.getElementById('pc-error');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}
function pcAddFiles(list) {
  Array.prototype.slice.call(list || []).forEach(function(f) {
    pcAddBlob(f, f.name || 'file', f.type || 'application/octet-stream');
  });
}
function pcAddBlob(blob, name, mimetype, extra) {
  if (_pcFiles.length >= PC_LIMITS.maxFiles) { pcSetError('첨부는 최대 ' + PC_LIMITS.maxFiles + '개까지 가능합니다'); return; }
  if (!blob.size) { pcSetError(name + ' — 빈 파일은 첨부할 수 없습니다'); return; }
  if (blob.size > PC_LIMITS.maxFileBytes) { pcSetError(name + ' — 파일 하나는 ' + ntFormatBytes(PC_LIMITS.maxFileBytes) + '까지 첨부할 수 있습니다'); return; }
  var total = _pcFiles.reduce(function(sum, f) { return sum + f.size; }, 0);
  if (total + blob.size > PC_LIMITS.maxTotalBytes) { pcSetError('첨부는 모두 합쳐 ' + ntFormatBytes(PC_LIMITS.maxTotalBytes) + '까지입니다'); return; }
  pcSetError('');
  var entry = { id: ++_pcSeq, name: name, mimetype: mimetype, size: blob.size, kind: ntKindOf(mimetype), data: null, url: null, duration: extra && extra.duration ? extra.duration : 0 };
  if (entry.kind === 'image' || entry.kind === 'audio') {
    try { entry.url = URL.createObjectURL(blob); } catch (_e) {}
  }
  entry.ready = new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() {
      var str = String(reader.result || '');
      var comma = str.indexOf(',');
      entry.data = comma >= 0 ? str.slice(comma + 1) : '';
      resolve();
    };
    reader.onerror = function() { reject(new Error(name)); };
    reader.readAsDataURL(blob);
  });
  entry.ready.catch(function() {
    pcRemoveFile(entry.id);
    pcSetError(name + ' — 파일을 읽지 못했습니다');
  });
  _pcFiles.push(entry);
  pcRenderFiles();
}
function pcRemoveFile(id) {
  _pcFiles = _pcFiles.filter(function(f) {
    if (f.id === id && f.url) { try { URL.revokeObjectURL(f.url); } catch (_e) {} }
    return f.id !== id;
  });
  pcRenderFiles();
}
// The chips of the new-task composer (.nt-att), with this composer's remove.
function pcRenderFiles() {
  var box = document.getElementById('pc-attachments');
  if (!box) return;
  box.innerHTML = _pcFiles.map(function(f) {
    var thumb = f.kind === 'image' && f.url
      ? '<img class="nt-att-thumb" src="' + escAttr(f.url) + '" alt="">'
      : '<span class="nt-att-thumb" aria-hidden="true">' + NT_ICON_FILE + '</span>';
    var meta = (f.duration ? ntFormatDuration(f.duration) + ' · ' : '') + ntFormatBytes(f.size);
    return '<div class="nt-att" data-id="' + f.id + '">' + thumb
      + '<span class="nt-att-text"><span class="nt-att-name" title="' + escAttr(f.name) + '">' + esc(f.name) + '</span>'
      + '<span class="nt-att-meta">' + esc(meta) + '</span></span>'
      + '<button type="button" class="nt-att-remove" aria-label="' + escAttr(f.name) + ' 삭제" onclick="pcRemoveFile(' + f.id + ')">' + NT_ICON_X + '</button></div>';
  }).join('');
  box.scrollLeft = box.scrollWidth;
  pcSyncSteer();
}
// Every file and any recording go with the session they were added for.
function pcReset() {
  _pcRecGen++;
  _pcFiling = null;
  if (_pcRec) pcStopRecording(false);
  _pcFiles.forEach(function(f) { if (f.url) { try { URL.revokeObjectURL(f.url); } catch (_e) {} } });
  _pcFiles = [];
  pcRenderFiles();
  pcSetError('');
}
// A recording belongs to the session it was started for (gen + key): a mic
// permission granted, or a recorder that stops, after the panel closed or moved
// to another card attaches nothing and releases the mic.
function pcRecCurrent(gen, key) {
  return gen === _pcRecGen && key === panelSessionKey && !!panelOpen;
}
async function pcToggleRecording() {
  if (_pcRec) { pcStopRecording(true); return; }
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!canRecord) { document.getElementById('pc-audio-input').click(); return; }
  var gen = _pcRecGen;
  var key = panelSessionKey;
  var stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    if (!pcRecCurrent(gen, key)) return;
    pcSetError('마이크를 쓸 수 없습니다 (' + (e && e.name ? e.name : '권한 거부') + ') — 기기 녹음기로 녹음해 첨부해 주세요');
    document.getElementById('pc-audio-input').click();
    return;
  }
  if (!pcRecCurrent(gen, key) || _pcRec) {
    stream.getTracks().forEach(function(t) { t.stop(); });
    return;
  }
  var mime = ntPickRecorderMime(function(t) { return MediaRecorder.isTypeSupported(t); });
  var recorder;
  try { recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch (_e) { recorder = new MediaRecorder(stream); }
  var state = { recorder: recorder, stream: stream, chunks: [], started: Date.now(), mime: recorder.mimeType || mime || 'audio/mp4', keep: true, finished: false, timer: 0, raf: 0, audioCtx: null, gen: gen, key: key };
  state.done = new Promise(function(resolve) { state.resolve = resolve; });
  _pcRec = state;
  recorder.ondataavailable = function(ev) { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
  recorder.onstop = function() { pcFinishRecording(state); };
  recorder.start(1000);
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AC();
    var analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    state.audioCtx.createMediaStreamSource(stream).connect(analyser);
    var buf = new Uint8Array(analyser.fftSize);
    var tick = function() {
      if (_pcRec !== state) return;
      analyser.getByteTimeDomainData(buf);
      var peak = 0;
      for (var i = 0; i < buf.length; i++) { var v = Math.abs(buf[i] - 128); if (v > peak) peak = v; }
      document.getElementById('pc-rec-level').style.width = Math.min(100, Math.round((peak / 128) * 160)) + '%';
      state.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (_e) {}
  document.getElementById('pc-recorder').hidden = false;
  document.getElementById('pc-rec-time').textContent = '0:00';
  var mic = document.getElementById('pc-mic');
  mic.setAttribute('aria-pressed', 'true');
  mic.setAttribute('aria-label', '녹음 완료');
  pcSyncSteer();
  state.timer = setInterval(function() {
    var sec = Math.floor((Date.now() - state.started) / 1000);
    document.getElementById('pc-rec-time').textContent = ntFormatDuration(sec);
    if (sec >= NT_MAX_RECORD_SEC) pcStopRecording(true);
  }, 250);
}
// Resolves once the recording is filed (or dropped) — the send waits on it.
function pcStopRecording(keep) {
  var state = _pcRec;
  if (!state) return Promise.resolve();
  _pcRec = null;
  state.keep = keep;
  state.stoppedAt = Date.now();
  clearInterval(state.timer);
  cancelAnimationFrame(state.raf);
  try {
    if (state.recorder.state !== 'inactive') state.recorder.stop();
    else pcFinishRecording(state);
  } catch (_e) { pcFinishRecording(state); }
  state.stream.getTracks().forEach(function(t) { t.stop(); });
  if (state.audioCtx) { try { state.audioCtx.close(); } catch (_e) {} }
  document.getElementById('pc-recorder').hidden = true;
  var mic = document.getElementById('pc-mic');
  mic.setAttribute('aria-pressed', 'false');
  mic.setAttribute('aria-label', '음성 녹음');
  pcSyncSteer();
  // Kept and not filed yet: a send right now (or after a timed-out one) waits on
  // it. A dropped one (a reset, a cancel) leaves nothing to wait on.
  if (keep) {
    _pcFiling = state.done;
    state.done.then(function() { if (_pcFiling === state.done) _pcFiling = null; });
  }
  return state.done;
}
function pcFinishRecording(state) {
  if (state.finished) return;
  state.finished = true;
  // Kept, and still this card's: the panel did not close or move on meanwhile.
  if (state.keep && state.chunks.length && pcRecCurrent(state.gen, state.key)) {
    var type = String(state.mime).split(';')[0] || 'audio/mp4';
    var blob = new Blob(state.chunks, { type: type });
    var sec = Math.max(1, Math.round(((state.stoppedAt || Date.now()) - state.started) / 1000));
    pcAddBlob(blob, 'voice-' + ntStamp(new Date()) + '.' + ntExtForMime(type), type, { duration: sec });
  }
  if (state.resolve) state.resolve();
}
// Paste an image (a screenshot) into the field; drop files on the composer. The
// element's events reach #panel-command (they bubble and are composed), so they
// keep working when pcFreshSteer swaps the element.
function pcInit() {
  var host = document.getElementById('panel-command');
  if (!host) return;
  var open = function() { return host._mode === 'open'; };
  host.addEventListener('paste', function(e) {
    var files = e.clipboardData && e.clipboardData.files ? Array.prototype.slice.call(e.clipboardData.files) : [];
    if (!files.length || !open()) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    files.forEach(function(f) {
      var type = f.type || 'application/octet-stream';
      var generic = !f.name || f.name === 'image.png' || f.name === 'image.jpeg';
      pcAddBlob(f, generic ? 'screenshot-' + ntStamp(new Date()) + '.' + (type.split('/')[1] || 'png') : f.name, type);
    });
  });
  var hasFiles = function(e) {
    return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) && open();
  };
  host.addEventListener('dragover', function(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    host.classList.add('is-drag');
  });
  host.addEventListener('dragleave', function(e) {
    if (!e.relatedTarget || !host.contains(e.relatedTarget)) host.classList.remove('is-drag');
  });
  host.addEventListener('drop', function(e) {
    host.classList.remove('is-drag');
    if (!hasFiles(e) || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    pcAddFiles(e.dataTransfer.files);
  });
  host.addEventListener('ui-submit', pcOnSubmit);
  host.addEventListener('ui-promote', function(e) { if (e.detail) steerAct('promote', String(e.detail.id)); });
  host.addEventListener('ui-cancel', function(e) { if (e.detail) steerAct('cancel', String(e.detail.id)); });
  host.addEventListener('ui-edit', function(e) { if (e.detail) steerAct('edit', String(e.detail.id), String(e.detail.text || '')); });
}
// ui-submit: a send already reading its files (or a card with no open composer)
// takes nothing — cancelled, the text stays in the field.
function pcOnSubmit(e) {
  var d = e.detail || {};
  var host = document.getElementById('panel-command');
  if (!panelSessionKey || _pcSending || !host || host._mode !== 'open') {
    e.preventDefault();
    return;
  }
  sendCommand(d.text || '', d.ref || '');
}
ntInit();
pcInit();
// Task view: 자세히 as this device saved it; the agent tabs answer clicks and arrows.
_panelDetail = readPanelDetail();
applyPanelDetail();
bindPanelTabs();
setInterval(loadSessions, 30000);
// CRON lane jobs and the llmux capacity view poll on their own cadence (the
// server caches llmux for 30s); capacity is handed again every 30s, so its element
// re-lays out once a minute and the timeline's markers slide toward now (it ticks
// its countdowns itself). A hidden tab polls nothing and catches up when shown.
loadCronJobs();
loadCapacity();
setInterval(loadCronJobs, 60000);
setInterval(loadCapacity, 60000);
setInterval(paintCapacity, 30000);
document.addEventListener('visibilitychange', function() {
  if (!document.hidden) { loadCapacity(); loadCronJobs(); }
});
// The capacity section sits above the board, outside #inbox: no observer sees the
// board move when it appears, folds or changes height, so the shift cache learns it
// here. (Its element sizes its own timeline on its own width — a docked session panel
// narrows the page without a window resize, SSOT 2026-10-24.)
(function initCapacityResize() {
  var cap = document.getElementById('capacity');
  if (!cap || typeof ResizeObserver === 'undefined') return;
  var lastH = -1;
  new ResizeObserver(function(entries) {
    var h = Math.round(entries[0].contentRect.height);
    if (h === lastH) return;
    lastH = h;
    scheduleLayoutRefresh(40);
  }).observe(cap);
})();
</script>
</body>
</html>`);
}

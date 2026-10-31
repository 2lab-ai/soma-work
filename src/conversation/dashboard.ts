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

import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants as zlibConstants } from 'node:zlib';
import type { FollowupItem, FollowupItemState } from '@soma/slack/followup-queue';
import type { FollowupQueueView } from '@soma/slack/followup-queue-blocks';
import { sumLiveUsage } from '@soma/slack/live-usage';
import { livePendingModelSwitch } from '@soma/slack/model-switch';
import type { FastifyInstance } from 'fastify';
import type { CronExecutionRecord, CronJob } from 'somalib/cron/cron-storage';
import {
  type AdminApprovalSnapshot,
  adminApprovalSnapshot,
  answerAdminApproval,
  onAdminApprovalsChanged,
  startAdminApprovalWatch,
  stopAdminApprovalWatch,
} from '../admin-approvals';
import { isAdminUser } from '../admin-utils';
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
  type PermissionPromptTarget,
  promptBelongsToThread,
} from '../permission-prompt-response';
import { getVersionInfo } from '../release-notifier';
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
import type { TaskAnswer } from '../task-turn/task-answer';
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
  parseDashboardTaskSubmission,
  parseNewTaskSubmission,
} from './new-task';
import type { NewTaskLaunchResult } from './new-task-launcher';
import { verifyDashboardTokenRaw } from './oauth';
import {
  type DashboardPermissionRequest,
  pendingPermissionsFor,
  pendingTaskPermissionsFor,
  permissionPromptDetail,
  refreshPendingPermissions,
  startPermissionPromptWatch,
  stopPermissionPromptWatch,
} from './permission-prompts';
import { getConversation, resummarizeTurn } from './recorder';
import { soundClientJs } from './sound-client';
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
  /**
   * The goal's open cap decision ("Goal 계속 진행할까요?") — the same request
   * the owner's DM asks, answered on either surface
   * (`POST /api/dashboard/session/:key/goal-decision`). While it is open the
   * card reads `activityState: 'waiting'`.
   */
  pendingGoalDecision?: KanbanGoalDecision;
  /** #600 ⑥ — a Slack-less dashboard task (the client gates task-only UI on it). Absent for Slack sessions. */
  slackless?: true;
  /**
   * #598 ④c — a Slack-less task's last turn outcome (D10): what the last turn
   * ended as, why, and whether recording it failed. Absent for Slack sessions.
   */
  lastTurnOutcome?: {
    outcome: 'completed' | 'failed' | 'cancelled' | 'waiting' | 'interrupted';
    category: string;
    reason?: string;
    recordFailure?: string;
    at: number;
  };
  /** Pending user choice question (present when activityState === 'waiting' and a question was asked) */
  pendingQuestion?: {
    type: 'user_choice' | 'user_choices';
    /** #599 ⑤ — a Slack-less task's question id, sent back with the answer. */
    askId?: string;
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

/** The goal's open cap decision as the card shows it — what the owner's DM says. */
export interface KanbanGoalDecision {
  /** The round's id; the answer names it, so an answer never lands on a later round. */
  decisionId: string;
  goalId: string;
  objective: string;
  maxContinuations: number;
  /** The completion eval's latest "not yet" reason (the DM's "Latest reason"). */
  reason?: string;
  /** Epoch ms the decision opened. */
  askedAt: number;
  /** Slack user id of the goal's owner — the only one who may answer. */
  ownerId: string;
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
function resolveSelfActionKeyAndOwner(
  request: any,
  reply: any,
  opts: { allowSlackless?: boolean; taskOwnerOnly?: boolean } = {},
): { wireKey: string; originalKey: string } | null {
  const wireKey: string = request.params?.key ?? '';
  const originalKey = resolveSelfActionKey(wireKey, reply);
  if (originalKey === null) return null;
  // Owner first: someone else's task answers 403, not a hint of what it is.
  if (!requireSessionOwner(request, reply, originalKey)) return null;
  // #637 R1 — a task's instruction or answer runs under its owner's identity
  // (`executionContextForTask`), so only the signed-in owner may send one: the
  // #716 bearer and admin-mode overrides do not apply. Stop / close / trash keep
  // them — they cannot run anything.
  if (opts.taskOwnerOnly) {
    const target = _getSessionsFn?.()?.get(originalKey);
    if (target?.slackless === true && !isTaskOwner(request, target.ownerId)) {
      reply.status(403).send({ error: 'only the task owner can instruct or answer a dashboard task' });
      return null;
    }
  }
  // Fail closed (#612 review): a Slack-less task takes only the routes that opt in —
  // stop / close / trash, and `command`, which hands it to the task turn
  // controller (#598 ④c). Goal, model, effort, the queue and answers are not
  // supported on a task yet (answers: ⑤ #599).
  if (!opts.allowSlackless && _getSessionsFn?.()?.get(originalKey)?.slackless === true) {
    reply.status(409).send({ error: 'not supported on a dashboard task yet' });
    return null;
  }
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

// ── Build identity (build skew, 2026-10-31) ────────────────────────
// A dashboard tab outlives the server that served it: after a deploy its
// socket reconnects and its poll goes on, so the new server's data meets the
// old page script. On a dev deployment a goal's 10/10 decision arrived as a waiting card
// (#624) on a tab opened before that build — "Waiting for you", no choices.
// The page, the socket's hello and every board poll name this build; a tab on
// another build reloads (client onServerBuild).

/** A deployed build is its commit and build time (dist/version.json); without one, the caller's per-process id. */
export function resolveDashboardBuildId(
  info: { commitHash?: string; buildTime?: string } | null | undefined,
  fallback: string,
): string {
  const commit = typeof info?.commitHash === 'string' ? info.commitHash.trim() : '';
  if (!commit) return fallback;
  const built = typeof info?.buildTime === 'string' ? info.buildTime.trim() : '';
  return built ? `${commit}@${built}` : commit;
}

/**
 * Without dist/version.json (the release track, a local run) the build is this module's file as built — its
 * mtime — so a restart of the same code (a crash loop under launchd) never reloads every open tab; only when
 * that cannot be read is it the process.
 */
function codeBuildFallback(): string {
  try {
    return `file-${Math.trunc(statSync(__filename).mtimeMs).toString(36)}`;
  } catch {
    return `proc-${process.pid}-${Date.now().toString(36)}`;
  }
}

let _dashboardBuildId: string | undefined;
/** This server's build — read once: the code a running process serves never changes under it. */
export function dashboardBuildId(): string {
  _dashboardBuildId ??= resolveDashboardBuildId(getVersionInfo(), codeBuildFallback());
  return _dashboardBuildId;
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

/** The signed-in user is the task's owner — a user identity, never a bearer token. */
function isTaskOwner(request: any, ownerId: string | undefined): boolean {
  const authContext = request.authContext;
  if (!authContext || authContext.mode === 'bearer_header' || authContext.mode === 'bearer_cookie') return false;
  return !!authContext.userId && !!ownerId && authContext.userId === ownerId;
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
/**
 * #598 ④c — a Slack-less task's instruction: the task turn controller refuses
 * (D8, D9) or accepts it, and the route answers with its status and body.
 */
type TaskCommandHandler = (
  sessionKey: string,
  message: string,
  files: NewTaskAttachment[],
  /** The signed-in user sending it — the route has checked it is the task's owner (#637 R2). */
  actorUserId: string,
) => Promise<{ status: number; body: Record<string, unknown> }>;

let _stopHandlerFn: StopHandler | null = null;
let _closeHandlerFn: CloseHandler | null = null;
let _trashHandlerFn: TrashHandler | null = null;
let _commandHandlerFn: CommandHandler | null = null;
let _taskCommandHandlerFn: TaskCommandHandler | null = null;

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
export function setDashboardTaskCommandHandler(fn: TaskCommandHandler | null): void {
  _taskCommandHandlerFn = fn;
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
 * The goal's cap decision answered from its approval card. Wired in
 * src/index.ts to `answerGoalCapDecision` (slack/goal-cap-decision.ts) — the
 * same path as the owner-DM buttons, so an answer here rewrites the DM.
 */
export type GoalDecisionAnswerResult =
  | { ok: true; decision: 'continue' | 'cancel' }
  | { ok: false; reason: 'invalid' | 'stale' | 'not_owner' | 'unavailable' };
type GoalDecisionHandler = (
  sessionKey: string,
  answer: { goalId: string; decisionId: string; decision: 'continue' | 'cancel' },
  actorUserId: string | undefined,
) => GoalDecisionAnswerResult;
let _goalDecisionHandlerFn: GoalDecisionHandler | null = null;

export function setDashboardGoalDecisionHandler(fn: GoalDecisionHandler | null): void {
  _goalDecisionHandlerFn = fn;
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
/**
 * #599 ⑤ — a Slack-less task's answer, bound to the question's `askId`; the
 * task turn controller answers with the route's status and body.
 */
type TaskAnswerHandler = (
  sessionKey: string,
  askId: string,
  answer: TaskAnswer,
  /** The signed-in user answering — the route has checked it is the task's owner. */
  actorUserId: string,
) => Promise<{ status: number; body: Record<string, unknown> }>;
let _taskAnswerHandlerFn: TaskAnswerHandler | null = null;
export function setDashboardTaskAnswerHandler(fn: TaskAnswerHandler | null): void {
  _taskAnswerHandlerFn = fn;
}

/**
 * #599 ⑤ — on a Slack-less task, an answer route hands the answer to the task
 * answer handler (askId required) and returns true; on a Slack session it
 * returns false and the route goes on as before.
 */
async function routeTaskAnswer(request: any, reply: any, sessionKey: string, answer: TaskAnswer): Promise<boolean> {
  if (_getSessionsFn?.()?.get(sessionKey)?.slackless !== true) return false;
  const askId = (request.body as { askId?: unknown } | undefined)?.askId;
  if (typeof askId !== 'string' || !askId || askId.length > 200) {
    reply.status(400).send({ error: 'askId is required to answer a dashboard task' });
    return true;
  }
  if (!_taskAnswerHandlerFn) {
    reply.status(501).send({ error: 'Task answer handler not configured' });
    return true;
  }
  try {
    const outcome = await _taskAnswerHandlerFn(sessionKey, askId, answer, String(request.authContext?.userId ?? ''));
    reply.status(outcome.status).send(outcome.body);
  } catch (error) {
    logger.error('Error answering a dashboard task', error);
    reply.status(500).send({ error: 'Internal Server Error' });
  }
  return true;
}

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

// ── Admin approvals (#620) — the admins' Slack DM requests, as approval cards ──

/**
 * Who may see the admin approvals: a Slack-signed-in admin. A viewer token or
 * a deployment without auth reads as `isAdmin` elsewhere, but carries no
 * identity — the requests (who asked, where, which skill) are not shown there.
 */
function isSlackAdmin(auth: { mode?: string; userId?: string; isAdmin?: boolean } | undefined): boolean {
  return !!auth && auth.mode === 'oauth_jwt' && !!auth.userId && auth.isAdmin === true && isAdminUser(auth.userId);
}

/**
 * When a dashboard socket's sign-in stops being valid: a session JWT's expiry,
 * or its absolute lifetime if that comes first. Viewer-token and no-auth
 * sockets carry no expiring credential (`undefined`).
 */
export function wsAuthDeadline(mode: string | undefined, cookieHeader: string | undefined): number | undefined {
  if (mode !== 'oauth_jwt') return undefined;
  const m = (cookieHeader || '').match(/soma_dash_token=([^;]+)/);
  const payload = m ? verifyDashboardTokenRaw(decodeURIComponent(m[1])) : null;
  if (!payload) return Date.now();
  const originalIat = (payload as { originalIat?: number }).originalIat || payload.iat || 0;
  const absoluteEnd = (originalIat + Math.max(config.oauth.jwtExpiresIn * 4, 30 * 86400)) * 1000;
  return Math.min(payload.exp * 1000, absoluteEnd);
}

/** The snapshot as admin viewers receive it: ids carry this instance's prefix (#814), like card keys. */
export function adminApprovalsForWire(snapshot: AdminApprovalSnapshot): AdminApprovalSnapshot {
  return {
    pending: snapshot.pending.map((a) => ({ ...a, id: composeSessionKey(a.id) })),
    resolved: snapshot.resolved.map((r) => ({ ...r, id: composeSessionKey(r.id) })),
  };
}

/** Push the admin approvals to admin viewers only — never on the shared board. */
let _adminBroadcastSeq = 0;
let _adminBroadcastSent = 0;
export async function broadcastAdminApprovals(): Promise<void> {
  if (![...wsClients].some((c) => c.slackAdmin)) return;
  // The snapshot read is async: a slower, older read must never land after a newer one.
  const seq = ++_adminBroadcastSeq;
  try {
    const snapshot = await adminApprovalSnapshot();
    if (seq < _adminBroadcastSent) return;
    _adminBroadcastSent = seq;
    const payload = JSON.stringify({ type: 'admin_approvals', snapshot: adminApprovalsForWire(snapshot) });
    const now = Date.now();
    for (const client of wsClients) {
      // A socket outliving its sign-in gets nothing (the expiry timer closes it; this is the backstop).
      if (!client.slackAdmin || (client.authUntil !== undefined && client.authUntil <= now)) continue;
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast admin approvals', error);
  }
}

let _adminApprovalUnsub: (() => void) | null = null;

/** Follow the admin approval stores while the web server listens; push admins on a change. */
export function startDashboardAdminApprovalWatch(): void {
  stopDashboardAdminApprovalWatch();
  _adminApprovalUnsub = onAdminApprovalsChanged(() => void broadcastAdminApprovals());
  startAdminApprovalWatch();
}

export function stopDashboardAdminApprovalWatch(): void {
  stopAdminApprovalWatch();
  _adminApprovalUnsub?.();
  _adminApprovalUnsub = null;
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

/** #600 ⑥ — makes and starts a Slack-less dashboard task (`createTaskLauncher`), and lists its folders. */
interface DashboardTaskLauncher {
  launch(request: {
    ownerId: string;
    ownerName: string;
    prompt: string;
    folder?: string;
    model?: string;
  }): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The folders a user may name for a task (`listTaskFolders`). */
  folders(ownerId: string): Array<{ name: string }>;
}
let _taskLauncher: DashboardTaskLauncher | null = null;
export function setDashboardTaskLauncher(launcher: DashboardTaskLauncher | null): void {
  _taskLauncher = launcher;
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

/** The live goal's open cap decision (`KanbanSession.pendingGoalDecision`); undefined when none is open. */
export function goalDecisionToKanban(s: any): KanbanGoalDecision | undefined {
  const goal = s?.goal;
  if (!goal || goal.status !== 'active' || typeof goal.goalId !== 'string') return undefined;
  const askedAt = finiteNumber(goal.capDmPendingAt);
  if (askedAt === undefined || typeof goal.capDecisionId !== 'string' || !goal.capDecisionId) return undefined;
  return {
    decisionId: goal.capDecisionId,
    goalId: goal.goalId,
    objective: String(goal.objective ?? ''),
    maxContinuations: Number(goal.maxContinuations) || 0,
    ...(typeof goal.lastEvalReason === 'string' && goal.lastEvalReason ? { reason: goal.lastEvalReason } : {}),
    askedAt,
    ownerId: String(goal.createdBy ?? ''),
  };
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
  // A Slack-less task (#596) has no thread to share: its aggregate is its own,
  // not that of every other task with no channel either.
  const aggregate = computeThreadAggregate(
    s.channelId,
    s.threadTs,
    s.slackless === true ? new Map([[key, s]]) : getAllSessions(),
    Date.now(),
  );
  const headline = displayTitle(s);
  // A Slack-less task's (#599 ⑤b) prompts are keyed by its own session key: it
  // has no thread, and a thread lookup ('' : '') would match every task.
  const permissions =
    s.slackless === true
      ? pendingTaskPermissionsFor(key, s.activeTaskTurnId)
      : pendingPermissionsFor(s.channelId, s.threadTs);
  const goalDecision = goalDecisionToKanban(s);
  // What the session waits on its user for: its permission prompts and the goal's cap decision.
  const asks = goalDecision ? [...permissions, { createdAt: goalDecision.askedAt }] : permissions;
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
    activityState: asks.length > 0 ? 'waiting' : s.activityState || 'idle',
    sessionState: s.state || 'MAIN',
    terminated: s.terminated === true,
    trashed: s.trashed === true,
    ...(s.starred === true ? { starred: true } : {}),
    conversationId: s.conversationId,
    lastActivity: s.lastActivity instanceof Date ? s.lastActivity.toISOString() : String(s.lastActivity),
    ...(permissions.length > 0 ? { pendingPermissions: permissions } : {}),
    ...(goalDecision ? { pendingGoalDecision: goalDecision } : {}),
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
    waitingSince: liveWaitingSince(s, asks),
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
    ...(s.slackless === true ? { slackless: true as const } : {}),
    ...(s.slackless === true && s.lastTurnOutcome
      ? {
          lastTurnOutcome: {
            outcome: s.lastTurnOutcome.outcome,
            category: s.lastTurnOutcome.category,
            ...(s.lastTurnOutcome.reason ? { reason: s.lastTurnOutcome.reason } : {}),
            ...(s.lastTurnOutcome.recordFailure ? { recordFailure: s.lastTurnOutcome.recordFailure } : {}),
            at: s.lastTurnOutcome.at,
          },
        }
      : {}),
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
            ...taskAskId(s),
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
              ...taskAskId(s),
            }
          : undefined // Unknown question type — skip
      : undefined,
  };
}

/** #599 ⑤ — a Slack-less task's question carries its `askId`; the panel echoes it with the answer. */
function taskAskId(s: { slackless?: boolean; actionPanel?: { pendingQuestion?: { askId?: unknown } } }): {
  askId?: string;
} {
  const askId = s.actionPanel?.pendingQuestion?.askId;
  return s.slackless === true && typeof askId === 'string' && askId ? { askId } : {};
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
 * the task total outlives the reset, so the card does too) — or a Slack-less
 * task, from its creation on, before it has run (#596).
 */
function onBoard(s: { sessionId?: string; taskUsage?: unknown; slackless?: boolean }): boolean {
  return !!s.sessionId || !!s.taskUsage || s.slackless === true;
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

type WsClient = {
  send: (data: string) => void;
  close: () => void;
  userId?: string;
  isAdmin?: boolean;
  /** A Slack-signed-in admin (ADMIN_USERS) — the only audience of admin approvals (#620). */
  slackAdmin?: boolean;
  /** Epoch ms the connection's sign-in stops being valid (JWT expiry / absolute lifetime). */
  authUntil?: number;
};
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
      // The build this board comes from: a tab on another build reloads (build skew).
      reply.header('x-dashboard-build', dashboardBuildId());
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
      const resolved = resolveSelfActionKeyAndOwner(request, reply, { allowSlackless: true });
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
      const resolved = resolveSelfActionKeyAndOwner(request, reply, { allowSlackless: true });
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
      const resolved = resolveSelfActionKeyAndOwner(request, reply, { allowSlackless: true });
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
      const resolved = resolveSelfActionKeyAndOwner(request, reply, { allowSlackless: true, taskOwnerOnly: true });
      if (!resolved) return;
      const { originalKey } = resolved;
      const files = parseAttachments(attachments);
      if (!files.ok) {
        reply.status(400).send({ error: files.error });
        return;
      }
      // #598 ④c — a Slack-less task's instruction runs through the task turn
      // controller, which answers 202 once the turn's start is saved.
      if (_getSessionsFn?.()?.get(originalKey)?.slackless === true) {
        if (!_taskCommandHandlerFn) {
          reply.status(501).send({ error: 'Task turn handler not configured' });
          return;
        }
        try {
          const outcome = await _taskCommandHandlerFn(
            originalKey,
            message,
            files.value,
            String((request as { authContext?: { userId?: string } }).authContext?.userId ?? ''),
          );
          reply.status(outcome.status).send(outcome.body);
        } catch (error) {
          logger.error('Error starting a dashboard task turn', error);
          reply.status(500).send({ error: 'Internal Server Error' });
        }
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

  // ── Admin approvals (#620): read for admins, answer for admins in admin mode ──

  server.get('/api/dashboard/admin-approvals', { preHandler: [authMiddleware] }, async (request, reply) => {
    if (
      !isSlackAdmin((request as { authContext?: { mode?: string; userId?: string; isAdmin?: boolean } }).authContext)
    ) {
      reply.status(403).send({ error: 'Slack 계정으로 로그인한 관리자만 볼 수 있습니다' });
      return;
    }
    reply.header('Cache-Control', 'no-store').send(adminApprovalsForWire(await adminApprovalSnapshot()));
  });

  server.post<{ Body: { id?: unknown; choiceId?: unknown } }>(
    '/api/dashboard/admin-approvals/answer',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { id, choiceId } = request.body || {};
      if (
        typeof id !== 'string' ||
        !id ||
        id.length > 300 ||
        typeof choiceId !== 'string' ||
        !choiceId ||
        choiceId.length > 64
      ) {
        reply.status(400).send({ error: 'id and choiceId are required' });
        return;
      }
      // An admin approval is answered by a signed-in admin (a Slack identity —
      // the DM rewrites name who answered) with admin mode on. A bearer token
      // carries no identity, and the owner shortcut of _hasWriteAccess does not apply.
      const auth = (request as { authContext?: { mode?: string; userId?: string; isAdmin?: boolean } }).authContext;
      const actor = auth?.userId;
      const modeHeader = request.headers?.['x-admin-mode'];
      const adminModeOn = Array.isArray(modeHeader) ? modeHeader[0] === 'on' : modeHeader === 'on';
      // The same gate as the reads (GET, WebSocket): one definition, so the two cannot drift.
      if (!actor || !isSlackAdmin(auth)) {
        reply.status(403).send({ error: 'Slack 계정으로 로그인한 관리자만 응답할 수 있습니다' });
        return;
      }
      if (!adminModeOn) {
        reply.status(403).send({ error: '관리자 모드를 켜야 응답할 수 있습니다' });
        return;
      }
      const localId = stripSelfInstancePrefix(id);
      if (localId === null) {
        reply.status(409).send({ error: '다른 인스턴스의 요청입니다 — 그 인스턴스의 대시보드에서 응답하세요', id });
        return;
      }
      try {
        const result = await answerAdminApproval(localId, choiceId, actor);
        // Every admin viewer sees the outcome at once (the store watch would see it within a second).
        void broadcastAdminApprovals();
        if (result.ok) {
          logger.info('Admin approval answered from the dashboard', { id: localId, choiceId, actor });
          reply.send({ ok: true, outcome: result.outcome });
          return;
        }
        if (result.reason === 'already_answered') {
          reply.status(409).send({
            error: '이미 다른 곳에서 응답한 요청입니다',
            ...(result.resolution ? { resolution: { ...result.resolution, id } } : {}),
          });
          return;
        }
        if (result.reason === 'invalid') {
          reply.status(400).send({ error: '이 요청에 없는 선택지입니다' });
          return;
        }
        if (result.reason === 'forbidden') {
          reply.status(403).send({ error: '관리자만 응답할 수 있습니다' });
          return;
        }
        if (result.reason === 'busy') {
          // Not a decision: the card stays answerable (the client offers a retry).
          reply.status(423).send({ error: '다른 관리자의 응답을 처리하는 중입니다 — 잠시 후 다시 시도하세요' });
          return;
        }
        reply.status(404).send({ error: '만료되었거나 더 이상 없는 요청입니다' });
      } catch (error) {
        logger.error('Error answering an admin approval from the dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Goal cap decision (the owner-DM "Goal 계속 진행할까요?", as an approval card) ──

  server.post<{ Params: { key: string }; Body: { goalId?: unknown; decisionId?: unknown; decision?: unknown } }>(
    '/api/dashboard/session/:key/goal-decision',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { goalId, decisionId, decision } = request.body || {};
      if (
        typeof goalId !== 'string' ||
        !goalId ||
        goalId.length > 200 ||
        typeof decisionId !== 'string' ||
        !decisionId ||
        decisionId.length > 100 ||
        (decision !== 'continue' && decision !== 'cancel')
      ) {
        reply.status(400).send({ error: "goalId, decisionId and decision ('continue' | 'cancel') are required" });
        return;
      }
      // The goal's creator answers — who may is the decision's own check (the
      // creator can differ from the session owner), so only the instance is resolved here.
      const originalKey = resolveSelfActionKey(String(request.params?.key ?? ''), reply);
      if (originalKey === null) return;
      const resolved = { originalKey };
      if (!_goalDecisionHandlerFn) {
        reply.status(501).send({ error: 'Goal decision handler not configured' });
        return;
      }
      try {
        // Only the goal's owner answers: a bearer client or an admin carries no
        // owner identity here and is refused by the handler.
        const actor = (request as { authContext?: { userId?: string } }).authContext?.userId;
        const result = _goalDecisionHandlerFn(resolved.originalKey, { goalId, decisionId, decision }, actor);
        if (result.ok) {
          logger.info('Goal cap decision answered from the dashboard', {
            sessionKey: resolved.originalKey,
            decision,
          });
          reply.send({ ok: true, decision: result.decision });
          return;
        }
        if (result.reason === 'stale') {
          reply.status(409).send({ error: '이미 처리되었거나 더 이상 유효하지 않은 요청입니다' });
          return;
        }
        if (result.reason === 'unavailable') {
          reply.status(503).send({ error: '지금은 처리할 수 없습니다 — 잠시 후 다시 시도하세요' });
          return;
        }
        reply.status(403).send({ error: 'goal 소유자만 응답할 수 있습니다' });
      } catch (error) {
        logger.error('Error answering a goal cap decision from the dashboard', error);
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
      const context = await _newTaskProvider.context(userId);
      // #600 ⑥ — with dashboard tasks wired, the folders a task may name (names only).
      const taskFolders = _taskLauncher?.folders(userId).map((f) => ({ name: f.name }));
      reply.send({ context: taskFolders ? { ...context, taskFolders } : context });
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
      const requestId = (request.body as { requestId?: unknown } | null)?.requestId;
      // #600 ⑥ — a Slack-less dashboard task: no channel, no Slack provider.
      if ((request.body as { destination?: unknown } | null)?.destination === 'task') {
        const launcher = _taskLauncher;
        if (!launcher) {
          reply.status(501).send({ error: 'Dashboard tasks are not configured' });
          return;
        }
        const parsed = parseDashboardTaskSubmission(request.body);
        if (!parsed.ok) {
          reply.status(400).send({ error: parsed.error });
          return;
        }
        const ownerName = (request as { authContext?: { name?: string } }).authContext?.name || userId;
        try {
          const result = await _newTaskGate.run(userId, parsed.value.requestId, async () => {
            const { requestId: _rid, ...rest } = parsed.value;
            // The model nickname is resolved by the launcher from the model catalog —
            // never through the Slack-dependent new-task context (#640 R2).
            const outcome = await launcher.launch({ ownerId: userId, ownerName, ...rest });
            // A refusal is not remembered by the gate, so the same request may be retried.
            if (outcome.status >= 400) {
              throw new NewTaskError(outcome.status, String(outcome.body.error ?? 'refused'));
            }
            return outcome.body;
          });
          reply.send({ ok: true, ...result });
        } catch (error) {
          if (error instanceof NewTaskError) {
            reply.status(error.statusCode).send({ error: error.message });
            return;
          }
          logger.error('Error starting a dashboard task', error);
          reply.status(500).send({ error: 'Internal Server Error' });
        }
        return;
      }
      const provider = _newTaskProvider;
      if (!provider) {
        reply.status(501).send({ error: 'New task is not configured' });
        return;
      }
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
      const resolved = resolveSelfActionKeyAndOwner(request, reply, { allowSlackless: true, taskOwnerOnly: true });
      if (!resolved) return;
      const { originalKey } = resolved;
      if (await routeTaskAnswer(request, reply, originalKey, { kind: 'single', choiceId })) return;
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
      const resolved = resolveSelfActionKeyAndOwner(request, reply, { allowSlackless: true, taskOwnerOnly: true });
      if (!resolved) return;
      const { originalKey } = resolved;
      if (await routeTaskAnswer(request, reply, originalKey, { kind: 'multi', selections })) return;
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
    thread: PermissionPromptTarget;
    pending: NonNullable<Awaited<ReturnType<typeof loadPermissionPrompt>>>;
  } | null> {
    const originalKey = resolveSelfActionKey(request.params?.key ?? '', reply);
    if (originalKey === null) return null;
    const session = getAllSessions().get(originalKey);
    // A Slack-less task (#599 ⑤b) answers its own prompts, keyed by its session key.
    const slackless = session?.slackless === true;
    if (!session || (!slackless && !session.channelId)) {
      reply.status(404).send({ error: 'Session not found' });
      return null;
    }
    // A task's prompt is answerable only while the turn that raised it runs:
    // that turn's hook is its only waiter.
    const thread: PermissionPromptTarget = slackless
      ? { taskKey: originalKey, turnId: String(session.activeTaskTurnId ?? '') }
      : { channel: String(session.channelId), threadTs: session.threadTs || undefined };
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
      const resolved = resolveSelfActionKeyAndOwner(request, reply, { allowSlackless: true, taskOwnerOnly: true });
      if (!resolved) return;
      const { originalKey } = resolved;
      if (await routeTaskAnswer(request, reply, originalKey, { kind: 'recommended' })) return;
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
      const authUntil = wsAuthDeadline(authContext?.mode, request?.headers?.cookie);
      const client: WsClient = {
        send: (data: string) => socket.send(data),
        close: () => socket.close(),
        userId: authContext?.userId,
        isAdmin: authContext?.isAdmin,
        slackAdmin: isSlackAdmin(authContext),
        ...(authUntil !== undefined ? { authUntil } : {}),
      };
      wsClients.add(client);
      // The sign-in this socket was opened with ends: close it. The page reconnects with its
      // current (rotated) cookie, or stops receiving if it no longer has a valid one.
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      if (authUntil !== undefined) {
        expiryTimer = setTimeout(
          () => {
            wsClients.delete(client);
            try {
              socket.close(4401, 'Sign-in expired');
            } catch {
              /* already closed */
            }
          },
          Math.min(Math.max(authUntil - Date.now(), 0), 2_147_000_000),
        );
        expiryTimer.unref?.();
      }
      logger.debug('WebSocket client connected', { total: wsClients.size });

      // Send initial state — the build first (hello): a tab on another build reloads before it reads the board.
      try {
        socket.send(JSON.stringify({ type: 'hello', build: dashboardBuildId() }));
        const board = buildKanbanBoard();
        socket.send(JSON.stringify({ type: 'session_update', board }));
      } catch {
        /* ignore */
      }

      socket.on('close', () => {
        if (expiryTimer) clearTimeout(expiryTimer);
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
  // `<` escaped like every other injected constant: the userId is the URL's, a `</script>` in it must stay data.
  const initUser = userId ? JSON.stringify(userId).replace(/</g, '\\u003c') : 'null';
  // #814 — inject the local instance's name so the frontend can identify
  // sibling cards (`environment.instanceName !== SELF_INSTANCE_NAME`) and
  // hide actions that would silently 4xx if dispatched to the wrong port.
  const initSelfInstance = _selfInstanceEnv ? JSON.stringify(_selfInstanceEnv.instanceName) : 'null';
  // Build skew — the build this page's script comes from (onServerBuild compares every hello and poll with it).
  const initBuild = JSON.stringify(dashboardBuildId()).replace(/</g, '\\u003c');
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
<title>soma-work 대시보드</title>
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
<script type="module" src="/dashboard/ui/menu.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/dialog.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/drawer.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/app-bar.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/stat-strip.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/bar-chart.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/file-card.js?v=${UI_LIB_VERSION}"></script>
<!-- The peek's inside is the library's (peekHtml under peekPageCss, 0.12.0 — D4 G5-3): reached from the page's own
     script as window.uiPeek. Modules run in order, so this one is in place before <ui-hovercard> is defined below. -->
<script type="module">
import { peekHtml, peekPageCss } from '/dashboard/ui/artifact-viewer.js?v=${UI_LIB_VERSION}';
import { fileItemKind } from '/dashboard/ui/file-card.js?v=${UI_LIB_VERSION}';
var sheet = document.createElement('style');
sheet.id = 'art-peek-sheet';
sheet.textContent = peekPageCss;
document.head.appendChild(sheet);
window.uiPeek = { html: peekHtml, kind: fileItemKind };
</script>
<script type="module" src="/dashboard/ui/hovercard.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/artifact-viewer.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/composer.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/conversation.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/work-log.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/choice-form.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/task-runs.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/task-plan.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/status-bar.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/deck-nav.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/tabs.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/goal-card.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/log-scroller.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/elapsed.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/meter.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/media-grid.js?v=${UI_LIB_VERSION}"></script>
<script data-fouc>
// FOUC prevention — apply theme before CSS paints
(function(){var t=localStorage.getItem('soma-theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();
</script>
<!-- Interface sound (@2lab.ai/ui/sound, sound-cuelume): off until the speaker beside the theme switch turns it on. -->
<script data-sound>${soundClientJs(UI_LIB_VERSION)}</script>
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

/* ── TOPBAR — @2lab.ai/ui <ui-app-bar id="app-bar"> (A-03..A-14) ──
   The bar is the library's: 56px (52 on phones), translucent over the page, one hairline;
   brand (the page's h1) · 대화 · 설정 · 기억 · toolbar · actions · status · account · speaker · theme, the
   links folded into 메뉴 whenever the bar is short of room. The header around it stays at the top
   while the board scrolls (SSOT 2026-10-29 T3; the docked drawer sits under it: --topbar-b). The
   page's own controls: the scope group (default model / effort, the board's user, admin write
   mode) is the bar's toolbar — inline while it fits, the bar's own wrapping row under it below
   toolbarAt (1280px) or when it would overflow (0.10.0, D2-GAPS G1-1) — and 새 작업 its action.
   No control cuts its label; only the selected user's name ends in an ellipsis (full name in title). */
.topbar {
  position: sticky;
  top: 0;
  z-index: 90;
  min-width: 0;
}
/* Until the element is defined: its height, none of the raw controls. */
ui-app-bar:not(:defined) { display: block; height: 56px; }
ui-app-bar:not(:defined) > * { visibility: hidden; }
.topbar-scope { display: flex; align-items: center; gap: 6px; min-width: 0; flex: none; }
/* In the bar's row under it (toolbar-row) the scope group wraps, and the row is the user select's cap:
   only a name wider than it ends in an ellipsis. */
ui-app-bar[toolbar-row] .topbar-scope { flex: 1 1 auto; flex-wrap: wrap; }
ui-app-bar[toolbar-row] .user-select { --ui-select-max: 100%; }
/* 새 작업 in the bar: the ink kit button; its word steps aside on a narrow bar (the + and title stay). */
ui-app-bar[narrow] .nt-btn-label { display: none; }
/* SSOT 2026-10-23 T6 — the owner's default model / effort, one click from the top. */
/* Above the full-screen panel overlay (99) and the panel (100): the chips stay
   clickable while a session panel is open — that is when "열린 세션에도 적용" exists. */
.topbar .topbar-defaults { position: relative; z-index: 101; display: flex; gap: 6px; align-items: center; flex: none; }
.topbar .topbar-defaults[hidden] { display: none; }
/* The defaults are kit chips (.ui-chip, D7 A-06) that open the library menu (A-07): the word before the value is
   quiet; while the menu is open the chip wears the kit's "on" look and its chevron is turned. */
.topbar .td-prefix { color: var(--ib-muted); }
.topbar .td-chip[aria-expanded="true"] { background: var(--ib-seg-on); box-shadow: var(--ib-shadow); }
.topbar .td-caret { transition: transform var(--dur-move) var(--ease-out); }
.topbar .td-chip[aria-expanded="true"] .td-caret { transform: rotate(180deg); }
/* The menu pops from its trigger's corner (the library menu / model-picker popover): in from translateY(-4px)
   scale(.96) with opacity 160ms + transform 220ms ease-out, out in 180ms; display is discrete, so after the
   exit a closed menu takes no hits and no room. */
/* The defaults menu is @2lab.ai/ui <ui-menu id="td-menu"> (A-07): it hangs from the chip that opened it. */
#td-menu { position: absolute; }
/* The save line is the kit's status line (.ui-status-line, data-tone="fail" for a refused write), capped in the bar. */
.topbar .td-status { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The user switcher is the kit's select chip (select.ui-select-chip, D7 A-11): a native <select> read as a label,
   as wide as its selected name, an ellipsis past the bar's cap (--ui-select-max); the full name rides in its title. */
.topbar .user-select { --ui-select-max: 180px; flex: 0 1 auto; }

/* ── ADMIN MODE TOGGLE — visible only for ADMIN_USERS (#716): a kit chip (.ui-chip[aria-pressed], D7 A-12). On = a
   write-anything mode, so the chip takes the fail tint instead of the kit's neutral "on" (colour where it carries
   status), its word pulled toward the ink (≥ 4.5:1 both themes). ── */
.topbar .admin-toggle { flex: none; }
.topbar .admin-toggle[aria-pressed="true"] { background: var(--tint-fail-bg); border-color: var(--tint-fail-line); color: var(--tint-fail-fg); }
/* Admin approvals (#620): the admins' Slack DM requests, counted in the top bar (a kit chip with a kit count badge,
   the wait tone while any wait), answered in a sheet. */
.admin-inbox-head { font-weight: 600; outline: none; }
.admin-inbox-body { display: flex; flex-direction: column; gap: 12px; padding: 6px 0 16px; }
.admin-inbox-empty { color: var(--text-secondary); font-size: 13px; padding: 12px 0; }
/* ── MAIN — stats strip, then the board; capped at 1280px and centred (.prd/10 §3.1-2, §5) ── */
.main { flex: 1; padding: 20px; width: 100%; max-width: 1280px; margin: 0 auto; min-width: 0; }

/* ── STATS STRIP — @2lab.ai/ui <ui-stat-strip> (B-01..B-05, B-09), above the board (.prd/10 §3.1-2) ──
   The element lays out period · 세션 · 토큰 · 비용 · 자세히 (one line; narrow, the figures under the
   period) and opens 자세히's region (0fr → 1fr, inert while closed) over its default slot: the cards
   and the charts in .stats-detail. */
.stats { margin-bottom: 18px; }
ui-stat-strip { display: block; }
ui-stat-strip:not(:defined) { min-height: 44px; }
ui-stat-strip:not(:defined) > * { display: none; }
.stats-detail { padding-top: 12px; }

/* ── EXPAND / COLLAPSE (P6, D4 K-06) — @2lab.ai/ui <ui-disclosure> for 세션 정보 (.pi-dc), Tasks (.panel-tasks-dc)
   and 지시 첨부 (.panel-um-dc): the summary row, the region's 0fr ↔ 1fr grow with its fade, inert while closed,
   the keyboard and the settle notice (ui-toggled — the page drops a closed region's nodes then) are the
   element's. flush: the page's own padding under the row. In the panel the row's press surface bleeds 8px past
   the text so the words line up with the rows around it. (The completed goals fold inside <ui-goal-card>, D6b.) ── */
.pi-dc, .panel-tasks-dc, .panel-um-dc { display: block; }
.pi-dc::part(summary), .panel-tasks-dc::part(summary), .panel-um-dc::part(summary) { width: calc(100% + 16px); margin: 0 -8px; }
.usage-cb-wrap { max-width: 440px; margin-bottom: 12px; }

/* ── STAT CARDS — the cards behind 자세히 (B-07): <ui-stat-strip id="stats-grid"> in layout 'cards' draws the
   tiles (12px cards on the resting shadow, as many 140px+ columns as fit, 워크플로우 wide). The page only
   writes the two slotted figures: 머지 코드 (+a / -d) and 워크플로우 (name: n, wrapping). ── */
.stats-grid { display: block; margin-bottom: 16px; }
.stat-wf { display: inline-flex; flex-wrap: wrap; gap: 2px 10px; font-size: 0.8em; }
.stat-wf b { font-weight: 600; }

/* ═══ AGENT INBOX BOARD (.prd/10 §3.1) ═══
   NEEDS YOU (waiting) · RUNNING (working) · DONE (idle, then closed) — the
   board and its cards are @2lab.ai/ui <ui-agent-inbox>; the rules here are the
   page around it and the open card's body (light DOM in the card's slot). */
/* The inbox is the size container for the board columns (SSOT 2026-10-24): a docked
   drawer narrows it, so the column layout follows its width, not the viewport. */
.inbox { margin-bottom: 28px; container: inbox / inline-size; }
.inbox-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 16px; min-width: 0; }
.crumbs { display: flex; align-items: baseline; gap: 10px; font-size: 17px; line-height: 1.3; min-width: 0; white-space: nowrap; overflow: hidden; }
.crumbs .crumb-root, .crumbs .crumb-sep { color: var(--ib-muted); }
.crumbs .crumb-cur { color: var(--ib-text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.view-seg { flex-shrink: 0; }
/* Board header tools: Show archives, then Board | List. Below 640px the tools
   take their own row under the breadcrumb. */
.inbox-tools { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
/* 보관함 · 휴면 · 수명 주기 are kit chips (.ui-chip[aria-pressed], D7 D-03); a chip the board has no use for yet stays out. */
.archives-btn[hidden] { display: none; }
/* Session lifecycle dialog (admin, J-01) — @2lab.ai/ui <ui-dialog size="sm">: the element draws the panel, the
   scrim, the enter / exit motion and the phone sheet; the page keeps only its form's rules. */
.lifecycle-dialog .lc-note { margin: 0 0 12px; font-size: 12px; color: var(--ib-muted); }
.lifecycle-dialog label { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 8px; font-size: 13px; margin-bottom: 10px; }
.lifecycle-dialog label input { grid-column: 1 / -1; font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--ib-seg); color: var(--ib-text); }
.lifecycle-dialog .lc-unit { color: var(--ib-muted); font-size: 12px; }
/* The save line is the kit's status line (.ui-status-line; data-tone="fail" when a save is refused). */
.lifecycle-dialog .lc-status { margin: 4px 0 8px; }
.lifecycle-dialog .lc-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* The board: @2lab.ai/ui <ui-agent-inbox> (re-agent-inbox) — its columns, cards, day groups, skeletons
   and narrow / list layouts are the element's, drawn with the dashboard tokens through .ui-tok (#inbox).
   An open card's body is light DOM in the card's slot (.card-slot > .card-body), styled here. */
ui-agent-inbox.kanban, ui-agent-inbox.cron-inbox { display: block; min-width: 0; }

/* ── Loading skeletons — the shape of what is coming, never a false "0 · Nothing here". The board shows the
   element's until its first answer (data-load="loading"); the open card's 지시 / 응답 lines are the kit's
   .ui-skeleton (the opacity pulse, the second row staggered with --i, still under reduced motion). ── */
/* A first board load that fails: the kit's fail notice (.ui-notice, D7 D-06) with its 다시 시도 before the board. */
.board-error { align-items: center; margin: 0 0 12px; }
.board-error > span { flex: 1 1 auto; }
.board-error[hidden] { display: none; }
.io-row.io-skel { display: flex; flex-direction: column; gap: 8px; padding: 10px; }

/* The working ring (the Tasks head's running step) is the kit's spinner (.ui-spinner.is-sm, D7 K-01): the run tone,
   still under reduced motion by its own rule. */

/* The open card's agent tree: @2lab.ai/ui <ui-agent-tree> (compact) in a
   frame that scrolls past a dozen rows (a wide fan-out stays a card, not a
   page); the element draws the rows, the folds, the bar and the roll-up. */
.ag-tree { display: block; margin: 12px 0 2px; padding: 10px 12px 6px; border: 1px solid var(--ib-card-border); border-radius: 10px; background: var(--ib-card); }
.ag-tree > ui-agent-tree, ui-agent-tree.pa-tree { display: block; min-width: 0; }
.ag-tree > ui-agent-tree { max-height: 420px; overflow-y: auto; overscroll-behavior: contain; }
.at-fallback { display: block; padding: 4px 0; font-size: 12px; color: var(--ib-muted); }
.ag-id { flex-shrink: 0; font-size: 11.5px; color: var(--ib-muted); font-variant-numeric: tabular-nums; }
.ag-type { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.ag-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ib-text-2); }
.ag-st { color: var(--ag-c); font-weight: 600; }
.ag-more { margin: 4px 2px 0; font-size: 12px; color: var(--ib-muted); }
/* Armed automatic resume (turn retry / goal re-check): the open card's resume row is the kit's notice in the
   "waiting" tone (.ui-notice[data-tone="wait"], D7 D-10), not the run hue. */
.card-resume { margin: 0 0 10px; }

.card-body { margin: 0 14px; padding: 12px 0 14px; border-top: 1px solid var(--ib-card-border); font-size: 13px; color: var(--ib-text-2); }
/* ── CONTROL STRIP — the open card's last row (spec 13): model · effort switch · the state action · Slack · 작업 로그 ── */
.card-foot-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--ib-card-border); }
.card-foot-bar .card-actions { margin: 0 0 0 auto; }
/* SSOT 2026-10-29 T1: the open card's actions (Stop · Close · Slack) — first row under the face. */
.card-actions-bar { display: flex; justify-content: flex-end; margin: 0 0 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--ib-card-border); }
/* #600 ⑥ — a dashboard task's last turn on its card */
.card-task-outcome { display: flex; flex-wrap: wrap; gap: 4px 8px; margin: 0 0 8px; font-size: 12px; color: var(--text-secondary); }
.card-task-outcome .cto-label { font-weight: 600; }
.card-task-outcome[data-outcome="failed"] .cto-label, .card-task-outcome[data-outcome="interrupted"] .cto-label { color: var(--red); }
.card-task-outcome .cto-warn { color: var(--red); font-weight: 600; }
.card-actions-bar .card-actions { margin: 0; }
.cfb-model { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-width: 0; color: var(--ib-muted); font-size: 13px; }
.card-foot-bar + .cb-model-note { margin-top: 6px; }
/* ── GOAL LINE — the goal on the open card, its home is the panel (spec 13) ── */
.card-goal-line { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding: 6px 10px; border: 1px solid var(--ib-card-border); border-radius: 8px; background: var(--ib-card-dim); font-size: 12.5px; min-width: 0; }
.card-goal-line .cgl-icon { flex-shrink: 0; display: inline-flex; color: var(--ib-muted); }
.card-goal-line .cgl-icon svg { width: 14px; height: 14px; }
.card-goal-line .cgl-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ib-text); }
.card-goal-line .cgl-text.is-muted { color: var(--ib-muted); }
.card-goal-line .cg-status { flex-shrink: 0; }
.card-goal-line .cgl-n { flex-shrink: 0; color: var(--ib-muted); font-variant-numeric: tabular-nums; }
.cgl-go, .card-more-link { flex-shrink: 0; font: inherit; font-size: 12px; color: var(--accent); background: none; border: 0; padding: 4px 2px; min-height: 28px; cursor: pointer; white-space: nowrap; }
@media (hover: hover) and (pointer: fine) { .cgl-go:hover, .card-more-link:hover { text-decoration: underline; } }
.card-more-link { display: block; margin: 4px 0 0 auto; }
/* The note under the model is the kit's status line (.ui-status-line, data-tone="fail" for a refused switch; D7 A-08). */
.cb-model-note { margin-top: 4px; }
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
.tl-toggle { margin-top: 6px; font: inherit; font-size: 12px; color: var(--ib-text-2); background: none; border: 1px solid var(--ib-card-border); border-radius: 6px; padding: 3px 10px; min-height: 28px; cursor: pointer; }

/* ── INSTRUCTION / RESPONSE — latest pair, lazy-loaded on expand ── */
.card-io { margin-top: 12px; display: grid; gap: 6px; }
.io-row { border-radius: 8px; padding: 8px 10px; background: var(--ib-col); min-width: 0; }
.io-label { font-size: 11px; font-weight: 600; color: var(--ib-muted); margin-bottom: 3px; display: flex; gap: 6px; align-items: baseline; }
.io-label .io-who { font-weight: 500; letter-spacing: 0; }
.io-label .io-who.is-sys { color: var(--text-tertiary); }
.io-text { font-size: 13px; line-height: 1.45; color: var(--ib-text); white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
.io-text .io-title { font-weight: 600; }
.io-text.is-muted { color: var(--ib-muted); }
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
   library's. No new tokens. The live lines for screen readers are the kit's .ui-sr-only (D7 A-18). */
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

/* ── CHARTS — @2lab.ai/ui <ui-bar-chart> (B-08): 세션 and 코드 변경 (머지) per day, side by side behind 자세히.
   Each element is its own 12px card on the resting shadow, with dashed gridlines, a tooltip that follows the hot
   bar (hover, keys, a tap holds it), skeleton bars while loading and its own empty line. ── */
.chart-row { display: flex; gap: 10px; margin-bottom: 16px; }
.chart-row > ui-bar-chart { display: block; flex: 1; min-width: 0; }
.chart-row > ui-bar-chart:not(:defined) { min-height: 214px; border-radius: 12px; background: var(--ib-pill); }

/* ── SLIDE PANEL — @2lab.ai/ui <ui-drawer id="slide-panel"> (D4 E-01, E-02) ── */
/* SSOT 2026-10-24 — a full-screen sheet below 840px (modal, over the element's scrim), docked beside the board
   from 840px (dock-at="840": no scrim, the board stays live). The slide on the drawer curve both ways, the sheet ↔
   dock switch in place while open (the same nodes — the composer's draft and every scroll place stay — its box
   morphing 320ms), the resize from its inner edge (resizable: pointer or arrows, ui-resize), Esc / the scrim
   (ui-close) and the visual viewport (its box ends above the soft keyboard in both modes) are the element's. The
   page keeps its own head, body and composer in the default slot (hide-close and no heading: the element's own
   head is out), the dock's top under the sticky top bar (--ui-drawer-top), its layer under the bar (--ui-drawer-z)
   and the saved width (initPanelResize: the width attribute; --panel-w for the board beside it). */
ui-drawer:not(:defined) { display: none; }
.slide-panel { --ui-drawer-top: var(--topbar-b, 0px); --ui-drawer-z: 100; }
.slide-panel::part(panel) { background: var(--surface); color: var(--text); padding-right: env(safe-area-inset-right, 0px); }
.slide-panel::part(body) { display: flex; flex-direction: column; min-height: 0; padding: 0; overflow: hidden; font-size: 14px; line-height: 1.45; color: var(--text); overflow-wrap: normal; }
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
/* Agent tabs (T1.2, D4 E-19): @2lab.ai/ui <ui-tabs shared-panel> — the tabs, the ink underline, the
   sideways scroll, Main pinned at the start edge with its fade (TabItem.pinned), the type as the muted
   second label (meta), the status as the tone dot (the word in the title), arrows and Home / End are
   the element's. Its list sticks at the top of the scroll area while the tab below it scrolls, on the
   strip's translucent surface; the pinned tab's opaque face is the surface. */
.panel-tabs { display: block; --ui-tabs-bg: var(--surface); }
.panel-tabs::part(list) {
  position: sticky;
  top: 0;
  z-index: 6;
  padding: 4px 12px 0;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  backdrop-filter: saturate(180%) blur(12px);
}
/* The Tasks head (T1.3, D4 K-06): the summary slotted into <ui-disclosure> — title · a one-line summary. */
.ps-sec-title { flex: none; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.ps-sec-sum { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 400; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.ps-sec-now { display: inline-flex; align-items: center; gap: 4px; color: var(--text); font-weight: 600; }
.panel-tasks {
  padding: 4px 16px;
  border-bottom: 1px solid var(--border);
  outline: none;
}
.panel-tasks-body { padding: 2px 0 6px; }
/* Section tabs (SSOT 2026-10-29, D4 E-24): @2lab.ai/ui <ui-tabs> — Chat · 작업 로그 at their own width,
   에이전트 트리 at the strip's far end (TabItem.end, T6) with the tree glyph; each section is its own scroll
   box slotted as its tab's panel (panel-focus="none": the box, not the element's wrapper, is the tab stop),
   sized by sizePanelSections (--psec-h) to the rest of the panel; only the one shown holds nodes. */
.panel-sections { display: block; --ui-tabs-bg: var(--surface); }
.panel-sections::part(list) { padding: 0 12px; background: var(--surface); }
.panel-sections-body { position: relative; }
.psec { position: relative; height: var(--psec-h, 60vh); min-height: 160px; }
/* D3 E-25 — every section is a library element's own scroll box (<ui-log-scroller>: the pin, the
   older-page row, the kept place, the new-items pill): the panel's box only gives it the height. */
.psec.psec-el { overflow: hidden; display: flex; flex-direction: column; }
.psec-el > * { flex: 1 1 auto; min-height: 0; }
.psec-el > ui-conversation, .psec-el > ui-work-log, .psec-el > ui-log-scroller { padding: 4px 8px 0; }
.cv-arts-slot .turn-arts-row { margin-top: 2px; }
.psec[hidden] { display: none; }
/* 자세히 (T1.6) — a button that behaves like a toggle (HIG Toggles: outside a list, not a switch; the background
   tells the state): the kit chip (.ui-chip[aria-pressed], D7 E-06). The panel's class gates the detail-only parts. */
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
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
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
   waiting behind the front card show their top edges above it (<ui-deck-nav peek="only">
   above the header, full width — D3 G6-3, 0.12.0), and ‹ n / m › in the top right go
   through them. The element draws the edges (one or two, by its data); the page gives
   the strip its place and hides it while nothing waits behind. ── */
.panel-deck-peek { display: none; flex: none; padding-top: 8px; background: var(--bg); }
.slide-panel:not([data-deck="0"]) .panel-deck-peek { display: block; }
.slide-panel:not([data-deck="0"]) .panel-header { border-top: 1px solid color-mix(in srgb, var(--text-tertiary) 45%, var(--border)); border-radius: 10px 10px 0 0; background: var(--surface); box-shadow: 0 -4px 10px -6px var(--scrim); }
/* D3 E-05: ‹ n / m › is <ui-deck-nav> (its own pill, 44px on coarse pointers). */
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
/* The 세션 정보 row (D4 K-06): the summary slotted into <ui-disclosure> — title · the one-line summary. */
.pi-head { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; }
.pi-title { flex-shrink: 0; font-size: 12px; font-weight: 600; color: var(--text-tertiary); }
.pi-sum { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.pi-dot { margin: 0 5px; color: var(--text-tertiary); }
.pi-links { display: flex; flex-wrap: wrap; gap: 4px 12px; }
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
/* ── GOAL — the editor's home (spec 13): @2lab.ai/ui <ui-goal-card> (E-12, D6b). The objective opens folded to
   its first 3 lines on every opening (SSOT 2026-10-29) — the element's fold, 펼치기 / 접기 its own. ── */
.panel-goal { padding: 8px 16px; border-bottom: 1px solid var(--border); outline: none; }
.panel-goal > ui-goal-card { display: block; }
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

/* ── COMMAND INPUT — flat ── */
.panel-command {
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}
/* The composer is <ui-agent-steering> (batch 2) with a <ui-composer slot="composer"> as its field (E-30): the
   field, tools, chips, recorder, drop outline, Send, queue and key hints are the elements'. */
.pc-steer-wrap { display: block; min-width: 0; border-radius: 12px; }


/* ── PRESS — buttons and segments give 0.97 feedback (§4-5), pointer presses only:
   a keyboard-focused control matches :focus-visible, so Space/Enter never scale it (§4-9). ── */
/* PRESS — one rule for every button-like control: scale(.97) on --dur-press ease-out (each control's own
   transition carries the transform), pointer presses only — never a keyboard press (:focus-visible). The
   56px FAB presses to .95. */

/* ── HOVER — pointer devices only; colour/border, never movement (§4-6) ── */
@media (hover: hover) and (pointer: fine) {
  .card-body .card-refs a:hover { text-decoration: underline; }
}

/* ── BOARD RESPONSIVE (.prd/10 §5, SSOT 2026-10-24) ──
   The columns follow the inbox's own width (container query): ≥840 three columns
   that always fit · <840 the three columns scroll sideways inside the board (the
   page itself never scrolls horizontally). <640 viewport: List by default, 44px
   taps. A docked drawer narrows the inbox, so this is not a viewport query. */
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

  /* Top bar (the app bar narrows itself: the status dot, the account's initials, 메뉴; its
     toolbar row keeps 12px sides): the user select fills what the chips leave of its line
     (it wraps rather than overflow). Labels stay whole. */
  ui-app-bar[toolbar-row] .user-select { flex: 1 1 auto; }
  .inbox-head { margin-bottom: 12px; flex-wrap: wrap; row-gap: 8px; }
  /* The tools take the row under the breadcrumb; on the narrowest screens
     (320px) Show archives sits above Board | List instead of overflowing. */
  .inbox-tools { flex: 1 1 auto; min-width: 0; flex-wrap: wrap; justify-content: flex-end; row-gap: 8px; }
  .crumbs { font-size: 15px; gap: 7px; }
}

/* ── RESPONSIVE — Bauhaus grid adapts ── */
@media (max-width: 680px) {
  .stats-grid { margin-bottom: 12px; }
  .chart-row { flex-direction: column; }
}
@media (hover: hover) and (pointer: fine) {
  .pa-crumb:not([aria-current="page"]):hover { background: var(--surface-raised); color: var(--text); }
}
@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  /* Loading skeletons hold still (the kit's .ui-skeleton stills itself; the kit's spinner stands as a ring with a dot). */
  .is-loading { animation: none !important; }
}
@media (prefers-reduced-motion: reduce) {
  /* SSOT 2026-10-27 — a compaction past its estimate holds a still, dimmed bar
     instead of the sweep (the shared block above already stills transitions). */
  .cp-bar.is-over > i { animation: none !important; background: var(--accent); opacity: 0.6; }
}
/* ── TOUCH — coarse pointer enlargement ── */
@media (pointer: coarse) {
}
/* ── 44px TARGETS — every remaining control on narrow (<640px) or touch screens (heights only). ── */
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
  /* The bar's chips (defaults, admin), the user select chip, 보관함 · 휴면 and 자세히 are kit chips: their 44px hit
     area is the kit's own rule. */
  .card-body .card-refs a { display: inline-flex; align-items: center; min-height: 44px; }
  .pi-links a, .panel-tasks-toggle { min-height: 44px; }
  .cgl-go, .card-more-link, .tl-toggle { min-height: 44px; }
}

/* ── CRON lane · drawer (SSOT 2026-10-23 T3/T4/T5); the drawer head's CRON badge is a kit chip with the clock glyph
   (.ui-chip, D7 C-06), the board cards' is the element's. ── */
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
.cron-drawer-headline > .ui-chip { flex: none; }
.cron-drawer-headline #cron-drawer-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* P8: the close and regenerate glyphs are the icon set's (no ✕ / × / 🔄 characters). */
#panel-title-sub-regen svg { width: 12px; height: 12px; vertical-align: -2px; }
/* The job's facts are the kit's fact list (.ui-dl, D7 C-07 / K-05), a job this instance lacks a kit notice; the runs
   are kit rows (.ui-row in the run's tone, D7 C-08) and no run yet the kit's empty state (.ui-empty, D7 C-09). */
.cron-drawer-meta { padding: 0 0 4px; }
.cron-drawer-body { padding: 6px 0 0; }
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

/* The floating entry is the kit's extended FAB (.ui-fab.is-extended, D7 H-10): the + with 새 작업 beside it, folding to
   the round button (.is-folded) while the page scrolls down. The page says when it shows — phones always, PC once the
   bar's button has scrolled away (.is-floating) — and keeps it above the board's layers. The open composer hides it
   everywhere; an open drawer hides it only as a sheet (Drawer blocks) — docked, the board is live and the FAB keeps
   its own is-floating rule. */
.new-task-fab.ui-fab { display: none; z-index: 60; }
.new-task-fab.is-floating { display: inline-flex; }
body.nt-open .new-task-fab { display: none !important; }

/* New task (H-01) is @2lab.ai/ui <ui-dialog size="lg" size-phone="full">: the element draws the 720px panel, its
   heading and ✕, the scrim, the rise / settle, the focus trap and, on phones, the full sheet that follows the visual
   viewport (above the soft keyboard). The page keeps its form whole inside and pads it itself (the element's body
   padding is off). */
.nt-dialog::part(body) { padding: 0; }
.nt-form { display: flex; flex-direction: column; color: var(--text); font-size: 13px; line-height: 1.45; }
.nt-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 20px 16px; }

.nt-config { display: flex; flex-wrap: wrap; gap: 8px; }
/* 모델 · effort · 채널 are kit select chips (.ui-select-chip, D7 H-02); the battery beside the model is <ui-meter
   shape="battery"> (H-03) in the page's quiet button that opens the usage line. */
.nt-battery-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; }
@media (hover: hover) and (pointer: fine) { .nt-battery-btn:hover { background: var(--ib-pill); } }
.nt-usage { margin: -4px 0 0; padding: 8px 10px; border-radius: 10px; background: var(--bg); color: var(--text-secondary); font-size: 12px; line-height: 1.5; }

/* autogoal · autoz are kit switches (.ui-switch, D7 H-04), the note beside them the page's. */
.nt-toggles { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.nt-toggle-note { font-size: 11px; font-weight: 500; color: var(--text-tertiary); }

/* The error and the upload status are kit status lines (.ui-status-line, D7 H-08 / A-08): the error in the fail tone. */
/* #640 R1: chips and rows set display, which beats the hidden attribute's UA style. */
.nt-dialog [hidden] { display: none !important; }

.nt-composer { display: block; }
.nt-foot { display: flex; align-items: center; gap: 8px; min-height: 18px; margin: 0; }
.nt-status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nt-submit-hint { flex: none; margin-left: auto; font-size: 11px; color: var(--text-tertiary); }


/* The FAB arrives: opacity + scale from 0.95 (never from nothing), 240ms ease-out — once. */

@media (max-width: 639px) {
  /* New task — phones: the floating button replaces the top-bar one; the composer is <ui-dialog>'s bottom sheet,
     which follows the visual viewport (the keyboard) itself — the page keeps the form clear of the home indicator. */
  .new-task-btn { display: none; }
  .new-task-fab.ui-fab { display: inline-flex; }
  .nt-body { padding: 4px 14px 10px; gap: 10px; }
  .nt-config { flex-wrap: nowrap; overflow-x: auto; margin: 0 -14px; padding: 0 14px 2px; scrollbar-width: none; }
  .nt-config::-webkit-scrollbar { display: none; }
  .nt-config .ui-select-chip { --ui-select-max: 150px; }
  .nt-body { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
  .nt-submit-hint { display: none; }
}
@media (pointer: coarse) {
  /* New task — touch: 44px targets. The composer's own tools, chips and camera are 44px on touch by its rules; the
     select chips are 44px with 16px text (iOS does not zoom into them) by the kit's. */
  .nt-battery-btn { min-height: 44px; min-width: 44px; }
  .nt-kbd, .nt-submit-hint { display: none; }
}
/* New task under reduced motion: the FAB's arrival and fold, the meter's fill and the dialog's slide are the kit's
   and the elements' own stilled rules; the bar's entry has no motion of its own. */
/* ── Session artifacts (SSOT 2026-10-23): face chips, strips, the peek's inside, the viewer's slot ── */
.art-glyph { width: 14px; height: 14px; flex-shrink: 0; }
.art-k-image { --art-tint: var(--green); }
.art-k-html { --art-tint: var(--orange); }
.art-k-audio { --art-tint: var(--purple); }
.art-k-video { --art-tint: var(--red); }
.art-k-markdown { --art-tint: var(--accent); }
.art-k-pdf { --art-tint: var(--red); }
.art-k-text, .art-k-file { --art-tint: var(--text-secondary); }
.card-artifacts { margin-top: 12px; }
.art-section-label { display: flex; align-items: center; gap: 6px; }
.art-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--ib-pill); color: var(--text-secondary); font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
.art-strip { display: flex; gap: 8px; overflow-x: auto; padding: 4px 2px 8px; scroll-snap-type: x proximity; scrollbar-width: thin; overscroll-behavior-x: contain; }
.art-tile { position: relative; flex: 0 0 auto; scroll-snap-align: start; --fc-tile-w: 128px; }
/* A strip tile / an answer's chip is @2lab.ai/ui <ui-file-card> (D2 I-01..I-03): its kind wash and glyph, the
   thumbnail, name and meta, its own hover, press and 44px chip on touch. The audio play button (T8) sits on the
   thumbnail's lower right: 4px card inset + the 16:10 thumbnail of a (--fc-tile-w − 8px) wide box. */
.art-tile > ui-file-card { display: block; }
.art-tile:has(> ui-file-card[variant="chip"]) { max-width: 240px; }
.panel-artifacts { padding: 10px 16px 4px; border-bottom: 1px solid var(--border); min-height: 44px; }
.panel-arts-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 12px; font-weight: 600; color: var(--text); }
.panel-arts-hint { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--text-tertiary); }
.art-strip-panel .art-tile { --fc-tile-w: 152px; }
.turn-arts-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
/* ── User media (SSOT 2026-10-25): the files a user attached to an instruction ──
   Above the words, as chat apps show an attachment with its message. The pictures are @2lab.ai/ui <ui-media-grid>
   (D7 I-09 / I-11): fixed 80px tiles (one picture alone in a wide box that shows it whole), "+N" on the last tile
   past four, 40px tiles in the compact size (44px on touch), each tile a button named by its action that asks to
   open (ui-open → the artifact viewer); the other files are cards. */
.um-media { display: grid; gap: 6px; margin: 2px 0 6px; min-width: 0; }
.um-media > ui-media-grid { display: block; min-width: 0; }
.um-files { display: flex; flex-wrap: wrap; gap: 6px; }
/* A non-image attachment is a <ui-file-card variant="row" playable> (D4 I-09): the card draws the glyph, the name,
   the kind · size · age line and the voice note's play toggle; the page sizes the box. */
.um-file { display: flex; min-width: 0; width: 240px; max-width: 100%; }
.um-file > ui-file-card { display: block; flex: 1 1 auto; min-width: 0; }
.um-file.is-remote { opacity: 0.8; }
.um-compact .um-file { width: auto; max-width: 200px; }
.io-row .um-media { margin: 4px 0 6px; }
/* A row of its own above the 산출물 (the section lays its head and chips out as one flex row in the minimal
   view and on a short body: this one wraps onto a full line of its own there). */
.panel-user-media { flex: 1 1 100%; margin-bottom: 6px; }
/* The 지시 첨부 row (D4 K-06): the summary slotted into <ui-disclosure> — glyph · 지시 첨부 · count · hint. */
.panel-um-head { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--text); font-size: 12px; font-weight: 600; }
.panel-um-body { padding: 4px 0 2px; }
.panel-um-body .um-media { margin: 0; }
/* The peek (I-05) is <ui-hovercard id="art-peek">: the element draws the raised card beside its trigger (360px —
   its width attribute) and runs the hover / focus / Esc / press rules; its inside is the library's peekHtml (the
   media box — an image, a document head, the page scaled, the kind's glyph — then name · kind · meta) under
   peekPageCss, put in by the module in <head> (0.12.0, D4 G5-3). The page adds the press on the media (the viewer)
   and the markdown head's own rules: the artifact-viewer entry exports no mdDocCss (D6-GAPS). */
#art-peek { --ui-hovercard-z: 1000; }
#art-peek .av-pk-media { cursor: zoom-in; }
#art-peek .av-pk-doc p, #art-peek .av-pk-doc ul, #art-peek .av-pk-doc ol, #art-peek .av-pk-doc pre, #art-peek .av-pk-doc blockquote { margin: 0 0 0.6em; }
#art-peek .av-pk-doc ul, #art-peek .av-pk-doc ol { padding-left: 1.3em; }
#art-peek .av-pk-doc blockquote { padding-left: 0.8em; border-left: 2px solid var(--border); color: var(--text-secondary); }
#art-peek .av-pk-doc code { padding: 0.1em 0.3em; border-radius: 4px; background: var(--ib-pill); font: 0.9em var(--mono); }
#art-peek .av-pk-doc pre { padding: 6px 8px; overflow: hidden; border-radius: 6px; background: var(--ib-col); }
#art-peek .av-pk-doc pre code { padding: 0; background: none; }
/* The viewer (I-06, I-07) is <ui-artifact-viewer tiles="none">: its <ui-dialog size="xl"> draws the panel, the head
   (kind badge · name · meta · ✕), the body — the model's page running its scripts (items[].scripts), a stored PDF
   in the browser's own viewer (items[].frame), the document, the media, the calm card — and the foot (‹ n / m › ·
   새 탭 · 다운로드 · Slack). The page slots no body of its own (0.12.0, D4 G5-1 / G5-2). */

/* ═══ Device-responsive layout (SSOT 2026-10-24) ═══
   Targets: iPhone Duo (folded 382×580, unfolded 951×543), iPhone 18 Pro Max
   (440×956 / 956×440), Galaxy Z Fold8 (cover ≈476×751, main ≈933×704).
   Research: docs/misc/research/2026-10-24-dashboard-device-viewports.md.
   Two drawer modes only — a sheet below 840px, docked from 840px — so every
   fold, unfold and rotation of those devices crosses one boundary and
   runLayoutCheck animates it. */
@media (max-width: 839px) {
  /* Drawer — a full-screen sheet (the element's modal sheet: the top-bar chips stay under it): the saved
     desktop width never applies, there is no resize handle, and its header keeps clear of the notch (the
     element's panel keeps the composer clear of the home indicator). */
  .slide-panel::part(panel) { width: 100%; }
  .slide-panel::part(handle) { display: none; }
  .slide-panel .panel-header, .slide-panel .panel-body, .slide-panel .panel-command { margin-left: env(safe-area-inset-left, 0px); }
  .slide-panel .panel-header { padding-top: max(12px, env(safe-area-inset-top, 0px)); }
  .slide-panel[open] ~ .new-task-fab { display: none !important; }
}
@media (min-width: 840px) {
  /* Drawer — docked beside the board (unfolded Duo / Fold8, tablets, PC): no dim,
     the board stays live, the drawer sits under the top bar until it scrolls
     away (--topbar-b → --ui-drawer-top, syncTopbarBottom), and the page narrows to what is left
     with its 1280px column centred there (never margin-right over width:100%). --panel-w is the
     drawer's own clamped width (syncPanelWidth writes it on the root from the element). */
  .topbar { z-index: 101; }
  .app:has(> .slide-panel[open]) > .main {
    max-width: min(1280px, calc(100% - var(--panel-w, 440px)));
    margin-left: max(0px, calc((100% - var(--panel-w, 440px) - 1280px) / 2));
    margin-right: auto;
  }
  .slide-panel[open] ~ .new-task-fab { right: calc(var(--panel-w, 440px) + 16px); }
}
/* A short docked screen (a phone held sideways, an unfolded Duo) keeps the drawer
   under the top bar too (SSOT 2026-10-29 T3: the top bar is always visible). */
/* A short screen: the panel head drops its subtitle line unless 자세히 is on. */
@media (max-height: 560px) {
  .slide-panel:not(.is-detail) #panel-title-sub { display: none !important; }
}
@media (max-width: 639px) {
  /* Responsive (SSOT 2026-10-24) — phones: the last card clears the FAB (a board
     with cards only — an empty page must not turn scrollable); the defaults
     menu and the artifact viewer are the elements' own sheets. */
  .inbox.has-cards { padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px)); }
}
/* The cron run drawer (#374) on every device: the visible viewport, not 100vh
   behind the Safari toolbar, and clear of the insets that viewport-fit=cover
   makes real (the notch side of a landscape iPhone, the home indicator). Its
   width is a share of the viewport without a classic scrollbar (100%), not
   100vw, so a narrow window never pushes its left edge off screen. */
.cron-drawer::part(panel) { padding-right: env(safe-area-inset-right, 0px); }
.cron-drawer::part(header) { padding-top: max(14px, env(safe-area-inset-top, 0px)); }
/* Task view (T1.6): minimal — the artifacts are one row of name chips, like a
   short panel body below; 자세히 shows them as thumbnails. The chips are the file cards' chip variant
   (artPanelVariant); this row only lays them out. */
.slide-panel:not(.is-detail) .panel-artifacts { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding-top: 6px; padding-bottom: 6px; }
.slide-panel:not(.is-detail) .panel-arts-head { flex: none; margin-bottom: 0; }
.slide-panel:not(.is-detail) .panel-arts-hint { display: none; }
.slide-panel:not(.is-detail) .art-strip-panel { flex: 1 1 auto; min-width: 0; padding-top: 2px; padding-bottom: 2px; }
/* A short panel body (landscape phones, the unfolded Duo, a docked drawer under a
   tall top bar; below 560px R/2 cannot hold full thumbnails plus a couple of task
   rows): artifacts become name chips with the play button inline, so the
   pinned strip stays one short row; every tile is still reachable sideways. */
@container pbody (max-height: 560px) {
  .panel-artifacts { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding-top: 6px; padding-bottom: 6px; }
  .panel-arts-head { flex: none; margin-bottom: 0; }
  .panel-arts-hint { display: none; }
  .art-strip-panel { flex: 1 1 auto; min-width: 0; padding-top: 2px; padding-bottom: 2px; }
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
  <!-- The top bar is @2lab.ai/ui <ui-app-bar id="app-bar"> (A-03..A-14): brand (the page's h1), the 대화 · 설정 ·
       기억 links with their titles (folded into 메뉴 when the bar is short of room), the live-update status, the
       signed-in account and the theme toggle are its data (paintAppBar). The page's own controls: the scope group
       (default model / effort, the board's user, admin write mode) is its toolbar — the bar's own row under it
       below toolbarAt or when it would overflow — and 새 작업 its action. -->
  <header class="topbar" id="topbar">
    <ui-app-bar id="app-bar" lang="ko">
    <div class="topbar-scope" id="topbar-scope" slot="toolbar">
    <div class="topbar-defaults" id="topbar-defaults" hidden>
      <button type="button" class="ui-chip td-chip" id="td-model" aria-haspopup="menu" aria-expanded="false" title="새 세션의 기본 모델 — 클릭해서 변경" onclick="openDefaultsMenu('model', this)"><span class="td-prefix">모델 </span><b id="td-model-value">…</b><i data-ui-icon="chevron-down" class="td-caret"></i></button>
      <button type="button" class="ui-chip td-chip" id="td-effort" aria-haspopup="menu" aria-expanded="false" title="새 세션의 기본 추론 강도 — 클릭해서 변경" onclick="openDefaultsMenu('effort', this)"><span class="td-prefix">추론 </span><b id="td-effort-value">…</b><i data-ui-icon="chevron-down" class="td-caret"></i></button>
      <ui-menu id="td-menu" lang="ko"></ui-menu>
      <span class="ui-status-line td-status" id="td-status" role="status" aria-live="polite"></span>
    </div>
    <select class="ui-select-chip user-select" id="user-select" title="모든 사용자" aria-label="보드에 보일 사용자" onchange="selectUser(this.value)">
      <option value="">모든 사용자</option>
    </select>
    <button
      id="admin-inbox-btn"
      type="button"
      class="ui-chip admin-toggle admin-inbox-btn"
      style="display:none"
      aria-haspopup="dialog"
      aria-label="관리자 승인 0건 대기"
      title="관리자 승인 — Slack DM으로 오는 승인 요청을 여기서도 보고 답합니다"
      onclick="openAdminInbox()"
    ><i data-ui-icon="shield"></i><span>승인</span><span class="ui-count" id="admin-inbox-count" aria-hidden="true">0</span></button>
    <button
      id="admin-mode-toggle"
      type="button"
      class="ui-chip admin-toggle"
      style="display:none"
      aria-pressed="false"
      title="관리자 쓰기 모드 — 켜면 다른 사람의 세션도 바꿀 수 있습니다 (#716)"
      onclick="toggleAdminMode()"
    ><span id="admin-mode-label"><span class="admin-mode-prefix">관리자 </span><span class="admin-mode-state">끔</span></span></button>
    </div>
    <button type="button" class="ui-btn is-primary new-task-btn" id="new-task-btn" slot="actions" aria-keyshortcuts="n" title="새 작업 (N)" onclick="openNewTask()"><i data-ui-icon="plus"></i><span class="nt-btn-label">새 작업</span><kbd class="ui-kbd nt-kbd" aria-hidden="true">N</kbd></button>
    </ui-app-bar>
  </header>

  <div class="main">
    <!-- Stats strip (.prd/10 §3.1-2) leads; the agent inbox board follows it. It is @2lab.ai/ui
         <ui-stat-strip id="stats-strip"> (B-01..B-05, B-09): period · 세션 · 토큰 · 비용 + 자세히 are its
         data (paintStatsStrip) — the figures roll, a loading figure pulses, 토큰 carries the per-instance
         breakdown as its tooltip. 자세히 opens the element's own region: the other cards (B-07, a second
         <ui-stat-strip> in layout 'cards': 턴 · PR 생성 · PR 머지 roll, 머지 코드 and 워크플로우 are slotted
         figures) and the charts below (its default slot; the choice is kept in localStorage). -->
    <section class="stats" id="stats">
      <ui-stat-strip id="stats-strip" lang="ko">
      <div class="stats-detail" id="stats-detail">
        <div class="ui-tok usage-cb-wrap"><ui-compact-breakdown id="usage-cb" lang="ko"></ui-compact-breakdown></div>
        <ui-stat-strip id="stats-grid" class="stats-grid" lang="ko"><span id="stat-merge-lines"></span><span id="stat-workflows" class="stat-wf"></span></ui-stat-strip>
        <div class="chart-row" id="chart-row"><ui-bar-chart id="chart-sessions" lang="ko"></ui-bar-chart><ui-bar-chart id="chart-merge" lang="ko"></ui-bar-chart></div>
      </div>
      </ui-stat-strip>
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
    <section class="inbox ui-tok" id="inbox" aria-label="에이전트 인박스">
      <div class="inbox-head">
        <nav class="crumbs" aria-label="위치"><span class="crumb-root">soma-work</span><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-cur" aria-current="page">에이전트 인박스</span></nav>
        <div class="inbox-tools">
          <button type="button" class="ui-chip archives-btn" id="archives-toggle" aria-pressed="false" hidden onclick="toggleArchives()"><i data-ui-icon="archive"></i><span id="archives-label">보관함</span></button>
          <button type="button" class="ui-chip archives-btn" id="sleeping-toggle" aria-pressed="true" hidden onclick="toggleSleeping()"><i data-ui-icon="moon"></i><span id="sleeping-label">휴면</span></button>
          <button type="button" class="ui-chip archives-btn" id="lifecycle-btn" style="display:none" title="세션 수명 주기 (관리자)" onclick="openLifecycleDialog()"><i data-ui-icon="clock"></i><span>수명 주기</span></button>
          <ui-segmented class="view-seg" id="view-seg"></ui-segmented>
        </div>
      </div>
      <ui-dialog id="lifecycle-dialog" class="lifecycle-dialog" heading="세션 수명 주기" size="sm" lang="ko">
        <form id="lifecycle-form" onsubmit="saveLifecycle(event)" oninput="armLifecycleSave(null)">
          <p class="lc-note"><span id="lifecycle-scope">이 인스턴스</span>에만 적용되고, 다음 정리 주기(최대 5분)부터 반영됩니다. 값을 줄이면 그 기준을 넘긴 세션이 바로 휴면이 되거나 종료됩니다 — 저장 전에 몇 개인지 알려 줍니다. 휴면 전환이 12시간 이하이면 12시간 전 확인 알림은 보내지 않습니다.</p>
          <label>마지막 활동 후 휴면 전환 <span class="lc-unit">시간</span><input id="lc-sleepAfterHours" type="number" min="1" max="720" step="any" required></label>
          <label>휴면 후 보관(종료) 전환 <span class="lc-unit">일</span><input id="lc-archiveAfterDays" type="number" min="0.05" max="365" step="any" required></label>
          <label>보드에 보관함 표시 기간 <span class="lc-unit">시간</span><input id="lc-boardArchiveWindowHours" type="number" min="0" max="8760" step="any" required></label>
          <p class="ui-status-line lc-status" id="lifecycle-status" role="status" aria-live="polite"></p>
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
      <div class="ui-notice board-error" id="board-error" data-tone="fail" role="alert" hidden><i data-ui-icon="alert"></i><span>보드를 불러오지 못했습니다.</span><button type="button" class="ui-btn is-sm" onclick="retryBoardLoad()">다시 시도</button></div>
      <!-- The board (re-agent-inbox): NEEDS YOU · RUNNING · DONE (by finish day) — renderBoard gives it its
           data; each open card's body is a light-DOM child in the card's slot (slot="body:<key>"). It says how
           many need you and how many run, politely (D6). -->
      <ui-agent-inbox id="kanban" class="kanban" view="board" lang="ko"></ui-agent-inbox>
    </section>
  </div>

  <!-- A cron job's past runs (SSOT 2026-10-23 T5). -->
  <ui-drawer class="cron-drawer" id="cron-drawer" mode="sheet" width="560" max-width="560" lang="ko">
    <span slot="header" class="cron-drawer-headline"><span class="ui-chip" id="cron-drawer-badge" aria-hidden="true"></span><span id="cron-drawer-title"></span></span>
    <div class="cron-drawer-meta" id="cron-drawer-meta"></div>
    <div class="cron-drawer-body" id="cron-drawer-body"></div>
  </ui-drawer>

  <!-- Admin approvals (#620): the requests the admins get by Slack DM, answerable here too. -->
  <ui-drawer class="cron-drawer" id="admin-inbox-drawer" mode="sheet" width="480" max-width="480" lang="ko">
    <span slot="header" class="admin-inbox-head" id="admin-inbox-head" tabindex="-1">관리자 승인</span>
    <div class="admin-inbox-body" id="admin-inbox-body"></div>
  </ui-drawer>
  <p class="ui-sr-only" id="admin-inbox-status" role="status" aria-live="polite"></p>

  <!-- Slide panel: the detail card — @2lab.ai/ui <ui-drawer> (D4 E-01, E-02): a modal sheet over its own scrim below
       840px, docked beside the board from 840px (dock-at), switched in place while open; resizable from its inner edge
       (the saved width: initPanelResize); Esc and the scrim arrive as ui-close (→ closeDetailCard, as the ✕ below). Its
       own head is out (hide-close, no heading): the page's header, body and composer fill it. -->
  <ui-drawer class="slide-panel" id="slide-panel" data-deck="0" dock-at="840" width="440" min-width="320" resizable hide-close label="작업 카드" lang="ko">
    <!-- Detail deck (SSOT 2026-10-29 T2, D3 G6-3 → D6b): the edges of the open cards' other detail cards, waiting behind
         this one — <ui-deck-nav peek="only">, the edges alone from the same data as the ‹ n / m › in the header. -->
    <ui-deck-nav class="panel-deck-peek" id="panel-deck-peek" peek="only" lang="ko" aria-hidden="true"></ui-deck-nav>
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
      <button type="button" class="ui-chip panel-detail-toggle" id="panel-detail-toggle" aria-pressed="false" title="모든 세부 정보 보기" onclick="togglePanelDetail()"><i data-ui-icon="list"></i><span class="pdt-label">자세히</span></button>
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
        <div class="panel-goal" id="panel-goal" role="region" tabindex="-1" aria-label="목표" style="display:none"></div>
        <!-- 입력 필요 (re-agent-run D8–D17): a head with the count (kit section head + count, D3 E-13), approval cards for the
             permission prompts and the question; one polite status line says arrivals and
             answers (the cards themselves are not a live region — their expiry clock ticks). -->
        <div class="ui-section-head panel-needs-head" id="panel-needs-head" tabindex="-1" hidden><h4>입력 필요</h4><span class="ui-count" id="panel-needs-count" data-tone="wait" data-pop></span></div>
        <div class="panel-permission" id="panel-permission" style="display:none"></div>
        <div class="panel-question" id="panel-question" style="display:none"></div>
        <p class="ui-sr-only" id="panel-needs-status" role="status" aria-live="polite"></p>
        <!-- 산출물 (SSOT 2026-10-23 T6): what the task produced, and the files the user attached. -->
        <div class="panel-artifacts" id="panel-artifacts" style="display:none"></div>
      </section>
      <!-- Agent tabs (task view T1.2, D4 E-19): @2lab.ai/ui <ui-tabs shared-panel> — Main always first and pinned at the
           left (TabItem.pinned), then every subagent in spawn order (renderPanelTabs: label · type as meta · status as the
           tone dot). Every tab controls the one panel below it (the focused agent's header, Tasks, the section tabs);
           panel-focus="none": that panel is no tab stop of its own. ui-change → selectPanelAgent. -->
      <ui-tabs class="panel-tabs" id="panel-tabs" shared-panel panel-focus="none">
      <section class="panel-tabpanel" id="panel-tabpanel">
        <!-- The focused agent (.prd/12 §4.3): its header; with 자세히, its path. -->
        <div class="panel-agents" id="panel-agents" style="display:none"></div>
        <!-- Tasks (task view T1.3): folded to one line by default. -->
        <div class="panel-tasks" id="panel-tasks" role="region" aria-label="작업" tabindex="-1"></div>
        <!-- Section tabs (SSOT 2026-10-29, D4 E-24): @2lab.ai/ui <ui-tabs> over the section boxes, each slotted as its
             tab's panel (slot="<id>"); only the active section holds nodes (psecClear); each opens on its newest items
             and pages back as the reader scrolls up (a top control is the keyboard path), in its own scroll box
             (panel-focus="none": the box is the tab stop, not the element's wrapper). The strip's data is PSEC_TABS
             (renderPanelSections); ui-change → selectPanelSection. -->
        <!-- SSOT 2026-10-29 T6: Chat (지시와 답변) first and the default; 에이전트 트리 at the strip's right end (TabItem.end) — the bottom view's top right. -->
        <div class="panel-sections-body" id="panel-sections-body">
          <ui-tabs class="panel-sections" id="panel-sections" panel-focus="none">
          <!-- 에이전트 트리 (E-25, D3 G1-1 → D6b): @2lab.ai/ui <ui-log-scroller> around the one <ui-agent-tree> —
               it lands on the newest agents, pages older ones in on scroll-up (ui-load-older → showMoreTree) and
               holds the reader's row while the tree grows above it (the rows' data-anchor in the tree's shadow
               root), the "new" pill for a live arrival; the page keeps the window (atWindowOf, paintTreeTab). -->
          <div class="psec psec-el ui-tok" id="psec-tree" slot="tree">
            <ui-log-scroller class="panel-tree" id="panel-tree" lang="ko"></ui-log-scroller>
          </div>
          <!-- 작업 로그 (D3 F-01..F-10): @2lab.ai/ui <ui-work-log> — task groups, entry rows, the raw viewer,
               child agents, its own scroll box (pages older entries in on scroll-up); the tool cards are
               this page's <ui-tool-call-card> children in each entry's tool-<seq> slot (wlPaint). -->
          <div class="psec psec-el ui-tok" id="psec-log" slot="log">
            <ui-work-log class="worklog-list" id="worklog-list" lang="ko"></ui-work-log>
          </div>
          <!-- 지시와 답변 (D3 G-01..G-13, E-25): @2lab.ai/ui <ui-conversation> — its own scroll box
               (<ui-log-scroller>: follows the newest turn, keeps the place while older pages go in
               above, the "new" pill); the dashboard hands it turns (convPaint) and answers
               ui-load-older / ui-retry. The files beside a turn are its slotted children. -->
          <div class="psec psec-el ui-tok" id="psec-conv" slot="conv">
            <ui-conversation class="panel-conv" id="panel-conv" lang="ko"></ui-conversation>
          </div>
          </ui-tabs>
        </div>
      </section>
      </ui-tabs>
    </div>
    </div>
    <!-- Command row is always visible: read-only for a viewer who is not the owner, off once the session ended. -->
    <div class="panel-command" id="panel-command">
      <!-- Model · effort beside the composer (spec 13): their own container — the input is never morphed. -->
      <div class="panel-controls" id="panel-controls" aria-label="이 세션의 모델과 effort"></div>
      <!-- The composer and the session's follow-up queue — @2lab.ai/ui <ui-agent-steering> (dashboard batch 2) with
           a <ui-composer slot="composer"> as its field (E-30, 0.10.0): multiline; files, images (paste, drop, picker)
           and voice, their chips, the limits and the error line are the composer's; Enter queues, ⌘/Ctrl+Enter
           steers. The token wrapper (.ui-tok) hands them the dashboard tokens; renderPanelComposer gives the
           steering its data, pcComposerData the composer its limits. -->
      <div class="ui-tok pc-steer-wrap">
        <ui-agent-steering id="cmd-steer" lang="ko"><ui-composer id="pc-composer" slot="composer" lang="ko"></ui-composer></ui-agent-steering>
      </div>
    </div>
  </ui-drawer>

  <!-- New task (SSOT 2026-10-23): floating button (phones, and PC once the top-bar
       button scrolls away), the composer dialog, and the launch toast. -->
  <button type="button" class="ui-fab is-extended new-task-fab" id="new-task-fab" aria-label="새 작업 시작" onclick="openNewTask()"><i data-ui-icon="plus"></i><span>새 작업</span></button>
  <!-- The composer dialog is @2lab.ai/ui <ui-dialog> (D4 H-01): its heading and ✕, scrim, focus trap, Esc / scrim
       close (ui-close; ui-closed after the exit → ntOnClosed), focus return to the opener, and on phones the sheet
       edge to edge (size-phone="full", 0.12.0 — D4 G6-1) above the soft keyboard. The page's form stays whole
       inside it; ui-submit from the composer posts as before. -->
  <ui-dialog id="nt-dialog" class="nt-dialog" heading="새 작업" size="lg" size-phone="full" lang="ko">
    <form id="nt-form" class="nt-form" onsubmit="event.preventDefault()" novalidate>
      <div class="nt-body" id="nt-body">
        <div class="nt-toggles nt-dest" id="nt-dest" role="group" aria-label="어디서 할까요" hidden>
          <button type="button" class="ui-chip" id="nt-dest-slack" aria-pressed="true" onclick="ntSetDestination('slack')"><span>Slack 채널</span></button>
          <button type="button" class="ui-chip" id="nt-dest-task" aria-pressed="false" title="슬랙 스레드 없이 대시보드에서만 진행하는 작업" onclick="ntSetDestination('task')"><span>대시보드 작업</span></button>
        </div>
        <div class="nt-config" role="group" aria-label="작업 설정">
          <!-- Kit select chips (.ui-select-chip, D7 H-02): the word, then the native select sized to its option; the model's
               remaining usage beside it is @2lab.ai/ui <ui-meter shape="battery"> (H-03) in a button that opens the usage line. -->
          <label class="ui-select-chip"><span>모델</span><select id="nt-model" onchange="ntOnModelChange()"></select></label><button type="button" class="nt-battery-btn" id="nt-battery-btn" aria-expanded="false" aria-controls="nt-usage" onclick="ntToggleUsage()"><ui-meter id="nt-battery" shape="battery" low="0.2" high="0.5" label="모델 잔여량" lang="ko"></ui-meter></button>
          <label class="ui-select-chip nt-chip-effort"><span>추론</span><select id="nt-effort" onchange="ntOnEffortChange()"></select></label>
          <label class="ui-select-chip nt-chip-folder" id="nt-folder-chip" hidden><span>폴더</span><select id="nt-folder" onchange="ntOnFolderChange()"></select></label>
          <label class="ui-select-chip nt-chip-channel"><span>채널</span><select id="nt-channel" onchange="ntOnChannelChange()"></select></label>
        </div>
        <p class="nt-usage" id="nt-usage" hidden></p>
        <div class="nt-toggles" role="group" aria-label="자동 진행">
          <label class="ui-switch" title="이 작업의 첫 지시에만 적용 — 처음 값은 내 autogoal 설정, 설정 자체는 바뀌지 않습니다"><input type="checkbox" role="switch" id="nt-autogoal" onchange="ntToggle('autogoal')"><span>autogoal</span></label>
          <label class="ui-switch" title="켜면 지시 끝에 $autoz를 붙여 autoz 스킬이 끝까지 자동으로 진행합니다"><input type="checkbox" role="switch" id="nt-autoz" onchange="ntToggle('autoz')"><span>autoz</span></label>
          <span class="nt-toggle-note">이 작업에만 적용 · 설정은 그대로</span>
        </div>
        <!-- The instruction, its files and the voice note — @2lab.ai/ui <ui-composer> (D2 H-05..H-09): the field grows
             with its text, drop / paste / attach / record / phone camera, chips with thumbnails and play, 작업 시작.
             ⌘/Ctrl+Enter sends; a plain Enter is a new line (enter: 'newline'); the files are capped each and
             together (maxTotalBytes). The page answers ui-submit (it posts) and ui-input (the draft). -->
        <ui-composer id="nt-composer" class="nt-composer" lang="ko"></ui-composer>
        <p class="ui-status-line nt-error" id="nt-error" data-tone="fail" role="alert" hidden></p>
        <p class="nt-foot"><span class="ui-status-line nt-status" id="nt-status" role="status" aria-live="polite"></span><span class="nt-submit-hint" aria-hidden="true">⌘↵</span></p>
      </div>
    </form>
  </dialog>
</div>
<!-- Artifacts (SSOT 2026-10-23): the peek and the viewer, shared by the board, the open cards and the panel —
     @2lab.ai/ui <ui-hovercard> (I-05: one card for every tile, filled on ui-open) and <ui-artifact-viewer
     tiles="none"> (I-06 / I-07: opened over the page's own cards with open(items, index, opener)). -->
<ui-hovercard id="art-peek" for="ui-file-card[data-art-id], .ib-chip[data-art], .mg-tile[data-mk]" width="360"></ui-hovercard>
<ui-artifact-viewer id="art-viewer" tiles="none" lang="ko"></ui-artifact-viewer>

<script>
const INIT_USER = ${initUser};
// The build this script came from (dashboardBuildId): a socket hello or a board poll naming another build means
// the server was redeployed under this tab — onServerBuild reloads it (build skew).
const PAGE_BUILD = ${initBuild};
// The page chrome's words, in one place and one language (the library's STRINGS pattern, lang="ko"):
// sentence case, "…" not "...", the library's short status vocabulary.
var STRINGS = {
  // The live-update status in the app bar (a tone dot and these words; narrow, the dot alone), read after
  // what it is about: "실시간 업데이트: 연결됨" (its description — visually hidden, and its hover title).
  wsAbout: '실시간 업데이트',
  wsConnecting: '연결 중…',
  wsLive: '연결됨',
  wsReconnecting: '다시 연결 중…',
  on: '켬',
  off: '끔',
  adminOn: '관리자 켬',
  adminOff: '관리자 끔',
  viewerAdmin: '관리자',
  // P8: the panel's turn summaries, subtitle and the legacy question form — Korean, "…", no emoji.
  summaryFailed: '요약 실패',
  summaryPending: '요약 만드는 중…',
  retry: '다시 시도',
  retrying: '다시 시도 중…',
  titlePending: '부제 만드는 중…',
  titleFailed: '부제를 만들지 못했습니다',
  titleCooldown: '부제를 만들지 못했습니다 — 1분 뒤 다시 시도하세요',
  titleNoContent: '아직 부제를 붙일 대화가 없습니다',
  error: '오류',
  mcUnavailable: '복수 질문 데이터를 불러올 수 없습니다',
  mcLoadFailed: '복수 질문을 불러오지 못했습니다. 새로고침해 보세요.',
  mcCustomPlaceholder: '직접 입력…',
  effortTitle: '추론 강도',
  // The board (D2 group 6) in the language of <ui-agent-inbox lang="ko">, whose own words (입력 대기 · 비어 있음 ·
  // 완료 · …) match: the column heads, the finish-day heads, the status words the page sets, the two toggles.
  boardNeeds: '응답 필요',
  boardRunning: '실행 중',
  boardDone: '완료',
  today: '오늘',
  yesterday: '어제',
  statusIdle: '대기',
  statusSleeping: '휴면',
  statusArchived: '보관됨',
  archives: '보관함',
  sleeping: '휴면',
  // #814: why a sibling instance's session cannot be acted on here (the actions' lock, 지금 압축's reason).
  siblingLock: function(env) { return '이 세션은 ' + env.instanceName + ' (' + (env.host || '') + ':' + (env.port || '') + ')에서 열어 조작하세요'; },
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

// ── Top bar — @2lab.ai/ui <ui-app-bar id="app-bar"> (A-03..A-14) ──
// The page hands the bar its data — brand, the three page links, the live-update status, the signed-in
// account, the current theme and the sound choice — and answers its events: ui-theme-change (the page
// owns the theme and its storage), ui-sound-change (the head's sound script, somaSoundBindBar),
// ui-navigate / ui-account (not cancelled: the links are real links). The bar draws and folds them; the
// page's own controls ride in its toolbar (the scope group) and actions (새 작업) slots. The brand is the
// page's h1; each link's title says what the page is for (its hover title, and the folded menu row's
// second line); the status says what it is about before its word.
var APP_BAR_NAV = [
  { id: 'conversations', label: '대화', href: '/conversations', icon: 'chat', title: '지난 대화를 모두 봅니다' },
  { id: 'settings', label: '설정', href: '/dashboard/settings', icon: 'gear', title: 'Slack 명령으로 바꾸던 설정을 여기서 확인하고 바꿉니다' },
  { id: 'memory', label: '기억', href: '/dashboard/settings#memory', icon: 'brain', title: '에이전트가 기억하는 개인 메모리와 관찰 기록을 보고 고칩니다' },
];
// The scope group takes the bar's row under it below this bar width (it may also when the bar would overflow).
var APP_BAR_TOOLBAR_AT = 1280;
var _appBarStatus = { tone: 'run', label: STRINGS.wsConnecting, live: true, description: STRINGS.wsAbout };
var _appBarAccount = null; // { name, href, role? } once /auth/me resolves; null = no pill
function paintAppBar() {
  var bar = document.getElementById('app-bar');
  if (!bar) return;
  var data = {
    brand: { label: 'soma-work', mark: true, heading: true },
    nav: APP_BAR_NAV,
    navLabel: '주 메뉴',
    toolbarAt: APP_BAR_TOOLBAR_AT,
    status: _appBarStatus,
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    // The speaker before the theme toggle (interface sound, #614): the head script's choice; its
    // ui-sound-change is answered there (somaSoundBindBar), which also re-hands the bar its state.
    sound: typeof _somaOn !== 'undefined' && !!_somaOn,
  };
  if (_appBarAccount) data.account = _appBarAccount;
  bar.data = data;
}
// ── Theme — the bar's sun / moon; stored only while it differs from the OS ──
function getPreferredTheme() {
  var saved = localStorage.getItem('soma-theme');
  if (saved) return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  paintAppBar();
}
function setTheme(next) {
  var osTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  if (next === osTheme) {
    localStorage.removeItem('soma-theme');
  } else {
    localStorage.setItem('soma-theme', next);
  }
  applyTheme(next);
}
function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
}
// Sync the bar on load
applyTheme(getPreferredTheme());
// Listen for OS theme changes (if user hasn't manually chosen)
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function(e) {
  if (!localStorage.getItem('soma-theme')) {
    applyTheme(e.matches ? 'light' : 'dark');
  }
});
(function initAppBar() {
  var bar = document.getElementById('app-bar');
  if (!bar) return;
  bar.addEventListener('ui-theme-change', function(e) {
    var t = e.detail && e.detail.theme;
    if (t === 'light' || t === 'dark') setTheme(t);
  });
})();
// ── Panel width — the docked drawer's inner edge (SSOT 2026-10-24, D4 E-01) ──
// The drag and the handle's arrow keys are <ui-drawer resizable>'s: it clamps the width to
// [min-width, min(max-width, viewport − 48)] and says ui-resize. The page keeps the saved
// preference (localStorage) as the element's width attribute, caps it at half the window
// (max-width follows a resize) and writes the drawer's own clamped width as --panel-w on the
// root for the board beside it. JS never writes the drawer's width or right offset itself:
// the sheet below 840px is the whole screen whatever was saved on a wide one.
(function initPanelResize() {
  var panel = document.getElementById('slide-panel');
  if (!panel) return;
  var STORAGE_KEY = 'soma-panel-width';
  var MIN_W = 320, MAX_W = 1600;
  var saved = NaN;
  try { saved = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10); } catch (_e) {}
  if (saved >= MIN_W && saved <= MAX_W) panel.setAttribute('width', String(saved));
  panel.addEventListener('ui-resize', function(e) {
    var w = e.detail && e.detail.width;
    if (w >= MIN_W) { try { localStorage.setItem(STORAGE_KEY, String(w)); } catch (_e) {} }
    syncPanelWidth();
  });
  window.addEventListener('resize', syncPanelWidth, { passive: true });
  syncPanelWidth();
})();
// The cap (half the window, never under the drawer's minimum) and --panel-w: the element's clamped width
// — the saved width capped the same way until the element is defined.
function syncPanelWidth() {
  var panel = document.getElementById('slide-panel');
  if (!panel) return;
  var half = Math.max(320, Math.round(window.innerWidth / 2));
  if (panel.getAttribute('max-width') !== String(half)) panel.setAttribute('max-width', String(half));
  var w = typeof panel.width === 'number' ? panel.width : Math.min(parseInt(panel.getAttribute('width') || '', 10) || 440, half);
  document.documentElement.style.setProperty('--panel-w', w + 'px');
}

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
  // A dashboard task's question names itself (#599): the same text asked twice is
  // two questions, so a late answer to the first never resolves the second (#637 R1).
  return (q.askId ? 'a|' + q.askId + '|' : '') + 'q|' + JSON.stringify([q.question, (q.choices || []).map(function(c) { return [c.id, c.label, c.description || '']; })]);
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
  var gd = s && s.pendingGoalDecision;
  if (gd && gd.decisionId) keep['g|' + gd.decisionId] = true;
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
// The goal's cap decision — the owner's DM "Goal 계속 진행할까요?" as the same
// card: the question, the objective and the latest reason, 계속 / 취소 (no
// recommended choice, as the DM has none). The owner answers here or in the
// DM; either answer resolves both (the server rewrites the DM, the push takes
// the card away).
var GOAL_DECISION_CHOICES = [{ id: 'continue', label: '✅ 계속' }, { id: 'cancel', label: '🛑 취소' }];
var GOAL_DECISION_SENT = { continue: '계속 진행을 보냈어요', cancel: '취소를 보냈어요' };
function acGoalDecisionLock(s, d) {
  if (isSiblingSession(s)) return AC_SIBLING;
  return d.ownerId && d.ownerId === _viewerUserId ? '' : '목표 소유자만 응답할 수 있습니다';
}
function acGoalDecisionData(s, d) {
  var n = toNum(d.maxContinuations);
  var context = ['목표: ' + String(d.objective || '')];
  if (d.reason) context.push('직전 사유: ' + String(d.reason));
  var data = {
    kind: 'question',
    id: String(d.decisionId),
    label: '목표 자동 진행 ' + n + '/' + n,
    question: '목표 자동 진행이 ' + n + '회 한도에 닿았습니다.\\n계속 진행할까요?',
    description: context.join('\\n'),
    choices: GOAL_DECISION_CHOICES.map(function(c) { return { id: c.id, label: c.label }; }),
    allowOther: false,
  };
  var asked = toNum(d.askedAt);
  if (asked > 0) data.createdAt = asked;
  var lock = acGoalDecisionLock(s, d);
  if (lock) data.canAnswer = lock;
  var st = _acState[s.key] && _acState[s.key]['g|' + d.decisionId];
  if (st) data.state = st;
  return data;
}
function acGoalDecisionHtml(s) {
  var d = s && s.pendingGoalDecision;
  if (!d || !d.decisionId) return '';
  return acSlotHtml(s.key, 'goal', 'g|' + d.decisionId, String(d.decisionId), '목표 계속 진행할까요? — 응답 대기');
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
  if (el.getAttribute('data-ac-kind') === 'admin') return adminApprovalData(el.getAttribute('data-ac-id'));
  var s = _sessionCache[el.getAttribute('data-ac-key')];
  if (!s) return null;
  if (el.getAttribute('data-ac-kind') === 'question') {
    var q = s.pendingQuestion;
    return q && q.type === 'user_choice' && q.choices ? acQuestionData(s, q) : null;
  }
  if (el.getAttribute('data-ac-kind') === 'goal') {
    var gd = s.pendingGoalDecision;
    return gd && String(gd.decisionId) === el.getAttribute('data-ac-id') ? acGoalDecisionData(s, gd) : null;
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
  if (!el || !el.getAttribute || !e.detail) return;
  var kind = el.getAttribute('data-ac-kind');
  if (kind === 'perm') answerPermission(el.getAttribute('data-ac-key'), String(e.detail.id), String(e.detail.decision));
  else if (kind === 'admin') answerAdminApproval(String(e.detail.id), String(e.detail.decision));
});
document.addEventListener('ui-answer', function(e) {
  var el = e.target;
  if (!el || !el.getAttribute || !e.detail) return;
  var kind = el.getAttribute('data-ac-kind');
  var choice = e.detail.choiceId === undefined ? '' : String(e.detail.choiceId);
  if (kind === 'question') answerChoice(el.getAttribute('data-ac-key'), String(e.detail.id), choice);
  else if (kind === 'goal') answerGoalDecision(el.getAttribute('data-ac-key'), String(e.detail.id), choice);
  else if (kind === 'admin') answerAdminApproval(String(e.detail.id), choice);
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
  var gd = s && s.pendingGoalDecision;
  if (gd && gd.decisionId) {
    ids['g|' + gd.decisionId] = true;
    if (seen && !seen['g|' + gd.decisionId]) said.push('목표 계속 진행할까요?');
  }
  container._seenKey = key;
  container._seen = ids;
  renderPanelNeedsHead(s);
  var html = s ? acPermissionsHtml(s) + acGoalDecisionHtml(s) : '';
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
  var n = s ? ((s.pendingPermissions || []).length + (s.pendingGoalDecision ? 1 : 0) + (panelQuestionShown(s) ? 1 : 0)) : 0;
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

// The goal's cap decision from its card: one answer per round. The server
// rewrites the owner's DM and the push takes the card away; a refusal (409:
// answered in the DM meanwhile, 403: not the owner) stays on the card.
async function answerGoalDecision(key, decisionId, choiceId) {
  var s = _sessionCache[key];
  var d = s && s.pendingGoalDecision;
  if (!d || String(d.decisionId) !== decisionId || !GOAL_DECISION_SENT[choiceId]) return null;
  var sk = 'g|' + decisionId;
  var states = _acState[key] || (_acState[key] = Object.create(null));
  var cur = states[sk];
  if (cur && (cur.status === 'sending' || cur.status === 'resolved')) return cur;
  states[sk] = { status: 'sending', choiceId: choiceId };
  acRepaint(key);
  var st;
  try {
    var res = await acPost('/api/dashboard/session/' + encodeURIComponent(key) + '/goal-decision', JSON.stringify({ goalId: d.goalId, decisionId: decisionId, decision: choiceId }));
    if (res.ok) {
      st = { status: 'resolved', outcome: 'answered', choiceId: choiceId, at: Date.now() };
      dashToast({ title: GOAL_DECISION_SENT[choiceId], description: 'Slack DM도 같은 결과로 바뀝니다', tone: 'success' });
    } else st = await acRefusal(res);
  } catch (e) {
    console.error('Goal decision answer error', e);
    st = { status: 'error', message: '네트워크 오류 — 다시 시도하세요', retry: true };
  }
  var now = _sessionCache[key] && _sessionCache[key].pendingGoalDecision;
  if (now && String(now.decisionId) === decisionId) (_acState[key] || (_acState[key] = Object.create(null)))[sk] = st;
  else acDrop(key, sk);
  acRepaint(key);
  return st;
}

// ── Admin approvals (#620) — @2lab.ai/ui <ui-approval-card> in a sheet ──
// The requests that reach the admins by Slack DM (an environment skill run, an
// MCP tool grant, a new user, a bot-message delete), for admins signed in here:
// a count in the top bar, a toast when one arrives, the cards in a sheet. An
// answer here runs the same decision as the Slack button (every admin's DM is
// rewritten); a Slack answer takes the card away. Admin viewers get them over the
// WebSocket (admin_approvals) and from GET /api/dashboard/admin-approvals on load
// and on every reconnect.
var _adminApprovals = { pending: [], resolved: [] };
var _adminKnown = null; // pending ids seen so far — the first load is the baseline (no toast)
var _adminLast = Object.create(null); // id → the last record seen, for the row it becomes
var _adminKeep = Object.create(null); // ids that ended while the sheet is open — shown until it closes
var _adminState = Object.create(null); // id → this page's answer (sending · error · resolved)
var _adminInboxOpen = false;
var _adminPushSeq = 0; // WebSocket snapshots seen — a GET that started before a push is older than it
var _adminInboxReturn = null;
var ADMIN_KIND_LABEL = { env_skill: '환경 스킬', mcp_grant: 'MCP 권한', new_user: '새 사용자', bot_delete: '메시지 삭제' };

function adminInboxLoad() {
  if (!_viewerIsAdmin || !_viewerUserId) return;
  var seq = _adminPushSeq;
  fetch('/api/dashboard/admin-approvals')
    .then(function(res) { return res.ok ? res.json() : null; })
    // A push that landed while this GET was in flight is newer: the GET's snapshot is dropped.
    .then(function(snap) { if (snap && seq === _adminPushSeq) applyAdminApprovals(snap); })
    .catch(function() {});
}
// A name for a Slack user id: the owner name a board card carries, else the id.
function adminUserName(id) {
  if (!id) return '';
  for (var k in _sessionCache) {
    var s = _sessionCache[k];
    if (s && s.ownerId === id && s.ownerName && s.ownerName !== id) return s.ownerName;
  }
  return id;
}
function adminApprovalTitle(a) {
  return (ADMIN_KIND_LABEL[a.kind] || '승인') + ' — ' + String(a.title || '');
}
function applyAdminApprovals(snap) {
  var pending = (snap && snap.pending) || [];
  var resolved = (snap && snap.resolved) || [];
  var ids = Object.create(null);
  var arrivals = [];
  for (var i = 0; i < pending.length; i++) {
    var a = pending[i];
    ids[a.id] = true;
    if (_adminKnown && !_adminKnown[a.id]) arrivals.push(a);
    _adminLast[a.id] = a;
  }
  if (_adminInboxOpen && _adminKnown) {
    for (var gone in _adminKnown) if (!ids[gone] && _adminLast[gone]) _adminKeep[gone] = true;
  }
  _adminKnown = ids;
  _adminApprovals = { pending: pending, resolved: resolved };
  for (var sid in _adminState) if (!ids[sid] && !_adminKeep[sid]) delete _adminState[sid];
  paintAdminInboxButton();
  if (_adminInboxOpen) paintAdminInbox();
  if (!arrivals.length) return;
  if (_adminInboxOpen) {
    adminInboxAnnounce('새 승인 요청 — ' + adminApprovalTitle(arrivals[0]));
    return;
  }
  var first = arrivals[0];
  dashToast({
    title: '관리자 승인 요청' + (arrivals.length > 1 ? ' ' + arrivals.length + '건' : ''),
    description: adminApprovalTitle(first) + ' · ' + adminUserName(first.requesterId),
    action: { id: 'open' },
  }, function() { openAdminInbox(first.id); });
}
function paintAdminInboxButton() {
  var btn = document.getElementById('admin-inbox-btn');
  if (!btn) return;
  var n = _adminApprovals.pending.length;
  var c = document.getElementById('admin-inbox-count');
  if (c && c.textContent !== String(n)) c.textContent = String(n);
  // The kit count badge takes the wait tone while any request waits.
  if (c) { if (n > 0) c.setAttribute('data-tone', 'wait'); else c.removeAttribute('data-tone'); }
  btn.setAttribute('aria-label', '관리자 승인 ' + n + '건 대기');
}
function adminInboxAnnounce(msg) {
  var el = document.getElementById('admin-inbox-status');
  if (el) el.textContent = msg;
}
// Who may answer here: a Slack-signed-in admin with admin mode on (the server checks again).
function adminApprovalLock() {
  if (!_viewerUserId) return 'Slack 계정으로 로그인한 관리자만 응답할 수 있습니다';
  if (!_isAdminModeOn()) return '관리자 모드를 켜면 응답할 수 있습니다';
  return '';
}
function adminResolutionOf(id) {
  var list = _adminApprovals.resolved || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
// The resolved row of a request that ended elsewhere: the real outcome and who answered, when known.
function adminResolvedState(a, r) {
  if (!r) return { status: 'resolved', outcome: 'elsewhere' };
  var st = { status: 'resolved', at: toNum(r.at) || Date.now() };
  if (a.card === 'question') {
    // The stored outcome is the truth: a grant choice that ended as a denial (the skill left the host) shows denied.
    if (r.outcome === 'denied' && !(r.choiceId && /deny/.test(String(r.choiceId)))) st.outcome = 'denied';
    else {
      st.outcome = 'answered';
      if (r.choiceId) st.choiceId = String(r.choiceId);
    }
  } else st.outcome = r.outcome === 'denied' ? 'denied' : 'approved';
  if (r.by) st.by = adminUserName(r.by) + (r.via === 'dashboard' ? ' · 대시보드' : r.via === 'slack' ? ' · Slack' : '');
  return st;
}
// One request → the card's data.
function adminApprovalData(id) {
  var a = _adminLast[id];
  if (!a) return null;
  var d = {
    id: String(a.id),
    label: (ADMIN_KIND_LABEL[a.kind] || '승인') + ' · ' + adminUserName(a.requesterId) + ' 요청',
  };
  var created = toNum(a.createdAt);
  if (created > 0) d.createdAt = created;
  var until = toNum(a.expiresAt);
  if (until > 0) d.expiresAt = until;
  if (a.card === 'question') {
    d.kind = 'question';
    d.question = String(a.title || '');
    var place = a.place && a.place.channel ? '요청 위치: #' + a.place.channel + (a.place.threadTs ? ' 스레드 ' + a.place.threadTs : '') : '';
    var desc = [a.description || '', place].filter(Boolean).join('\\n');
    if (desc) d.description = desc;
    d.choices = (a.choices || []).map(function(c) { return { id: String(c.id), label: String(c.label) }; });
    d.allowOther = false;
    if (a.recommendedId) d.recommendedId = String(a.recommendedId);
  } else {
    d.kind = 'permission';
    d.tool = String(a.tool || 'approval');
    d.title = String(a.title || '');
    if (a.description) d.description = String(a.description);
    if (a.rows) d.input = a.rows;
    if (a.risk) d.risk = a.risk;
    d.canExplain = false;
    d.canDisableRule = false;
  }
  var lock = adminApprovalLock();
  if (lock) d.canAnswer = lock;
  var st = _adminState[id];
  var open = !!(_adminKnown && _adminKnown[id]);
  if (!open) d.state = st && st.status === 'resolved' ? st : adminResolvedState(a, adminResolutionOf(id));
  else if (st) d.state = st;
  return d;
}
function paintAdminInbox() {
  var body = document.getElementById('admin-inbox-body');
  if (!body) return;
  var ids = _adminApprovals.pending.map(function(a) { return a.id; });
  for (var k in _adminKeep) if (ids.indexOf(k) < 0) ids.push(k);
  var html = ids.length
    ? ids.map(function(id) {
        var a = _adminLast[id];
        return acSlotHtml('admin', 'admin', 'a|' + id, id, adminApprovalTitle(a) + ' — 응답 대기');
      }).join('')
    : '<p class="admin-inbox-empty">대기 중인 승인 요청이 없습니다.</p>';
  var ae = document.activeElement;
  var had = !!(ae && body.contains(ae));
  if (body._html !== html) {
    morphInnerHtml(body, html);
    body._html = html;
  }
  acHydrate(body);
  if (had && !body.contains(document.activeElement)) {
    var head = document.getElementById('admin-inbox-head');
    if (head && head.focus) head.focus({ preventScroll: true });
  }
}
function openAdminInbox(focusId) {
  _adminInboxReturn = document.activeElement;
  _adminInboxOpen = true;
  _adminKeep = Object.create(null);
  paintAdminInbox();
  var d = document.getElementById('admin-inbox-drawer');
  if (d && typeof d.show === 'function') d.show();
  adminInboxLoad();
  requestAnimationFrame(function() {
    var body = document.getElementById('admin-inbox-body');
    var els = body ? body.querySelectorAll('ui-approval-card[data-ac-id]') : [];
    var to = null;
    for (var i = 0; i < els.length && !to; i++) if (focusId && els[i].getAttribute('data-ac-id') === focusId) to = els[i];
    to = to || acFirstOpen(body);
    if (to && to.focus) to.focus({ preventScroll: true });
  });
}
function closeAdminInbox() {
  _adminInboxOpen = false;
  _adminKeep = Object.create(null);
  var d = document.getElementById('admin-inbox-drawer');
  if (d && typeof d.hide === 'function') d.hide();
  var back = _adminInboxReturn;
  _adminInboxReturn = null;
  var btn = document.getElementById('admin-inbox-btn');
  var to = back && back.isConnected ? back : btn;
  if (to && to.focus) setTimeout(function() { to.focus({ preventScroll: true }); }, 0);
}
// One answer per request: in flight, then the row; a refusal stays on the card
// (answered elsewhere → its real outcome, no Retry).
async function answerAdminApproval(id, choiceId) {
  var a = _adminLast[id];
  if (!a) return null;
  var cur = _adminState[id];
  if (cur && (cur.status === 'sending' || cur.status === 'resolved')) return cur;
  _adminState[id] = a.card === 'question' ? { status: 'sending', choiceId: choiceId } : { status: 'sending', decision: choiceId };
  paintAdminInbox();
  var st;
  try {
    var res = await acPost('/api/dashboard/admin-approvals/answer', JSON.stringify({ id: id, choiceId: choiceId }));
    if (res.ok) {
      var done = {};
      try { done = await res.json(); } catch (_e) {}
      // The server's outcome is the truth: a grant can end as a denial (the skill left the host).
      var deniedInstead = done && done.outcome === 'denied' && !/deny/.test(choiceId);
      st = deniedInstead
        ? { status: 'resolved', outcome: 'denied', at: Date.now() }
        : a.card === 'question'
          ? { status: 'resolved', outcome: 'answered', choiceId: choiceId, at: Date.now() }
          : { status: 'resolved', outcome: choiceId === 'deny' ? 'denied' : 'approved', at: Date.now() };
      dashToast(deniedInstead
        ? { title: '거부로 처리됐어요', description: adminApprovalTitle(a) + ' — 서버가 요청을 거부했습니다', tone: 'warning' }
        : { title: '응답을 보냈어요', description: adminApprovalTitle(a) + ' — 관리자들의 Slack DM도 같은 결과로 바뀝니다', tone: 'success' });
    } else if (res.status === 409) {
      var data = {};
      try { data = await res.json(); } catch (_e) {}
      st = adminResolvedState(a, data && data.resolution);
    } else st = await acRefusal(res);
  } catch (e) {
    console.error('Admin approval answer error', e);
    st = { status: 'error', message: '네트워크 오류 — 다시 시도하세요', retry: true };
  }
  _adminState[id] = st;
  if (st.status === 'resolved' && _adminInboxOpen) _adminKeep[id] = true;
  paintAdminInbox();
  adminInboxLoad();
  return st;
}
(function initAdminInbox() {
  var d = document.getElementById('admin-inbox-drawer');
  if (d) d.addEventListener('ui-close', function(e) { e.preventDefault(); closeAdminInbox(); });
})();

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
    var acBody = { choiceId: choiceId, label: label, question: q.question };
    // #599 — a dashboard task's question names itself; the answer carries its id back.
    if (q.askId) acBody.askId = q.askId;
    var res = await acPost('/api/dashboard/session/' + encodeURIComponent(key) + '/answer-choice', JSON.stringify(acBody));
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
  var title = '작업' + (scopeLabel ? ' <span class="tasks-scope">&middot; ' + esc(scopeLabel) + '</span>' : '');

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

  // The head is <ui-disclosure>'s row (D4 K-06): the title and the one-line summary slotted in; the body is its
  // region, painted only while open and through the fold ('folding') — the choice is _panelTasksOpen.
  var open = _panelTasksOpen === true;
  var head = '<ui-disclosure class="panel-tasks-dc" flush' + (open ? ' open' : '') + '>'
    + '<span slot="summary" class="panel-tasks-header">'
    + '<span class="ps-sec-title">' + title + '</span>'
    + '<span class="ps-sec-sum">' + planSummaryHtml(list, prev) + '</span></span>';
  var live = '<span class="ui-sr-only pl-live" role="status" aria-live="polite">' + esc(said.join('. ')) + '</span>';
  if (!open && _panelTasksOpen !== 'folding') { writePanelTasks(container, head + '</ui-disclosure>' + live); return; }

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
  // The sums are the runs element's totals row (over every run, shown or not — D3-GAPS G5-2): with
  // nothing run yet (work before the first list), the work outside any task is the page's one line.
  var html = head + '<div class="panel-tasks-body ui-tok" id="panel-tasks-body">' + body
    + (!runs.ran.length && outside ? taskOutsideHtml(outside) : '') + '</div></ui-disclosure>' + live;
  writePanelTasks(container, html);
  var runsEl = document.getElementById('panel-task-runs');
  if (runsEl) {
    var rd = { title: '실행된 태스크', runs: taskRunsData(runs.ran.slice(hiddenRuns)), totals: taskTotalsOf(runs.ran) };
    if (hiddenRuns) rd.hidden = hiddenRuns;
    var ex = taskOutsideNote(outside);
    if (ex) rd.extraTotals = [ex];
    taskElData(runsEl, rd);
    taskRunsRestore(runsEl);
  }
  var planEl = document.getElementById('panel-task-plan');
  if (planEl) {
    taskElData(planEl, taskPlanData(runs));
    taskPlanRestore(planEl);
  }
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
    // Its numbers are a share (it ran together with other tasks) or its start was inferred (it went from
    // waiting straight to completed): ≈ on the row and the detail, and a note saying why (D3-GAPS G5-1).
    var shared = Math.round(toNum(t.shared));
    var notes = [];
    if (shared > 1) notes.push({ label: '분배', value: shared + '개 태스크가 함께 진행 — 수치는 그 몫(1/' + shared + ')' });
    if (t.startEstimated) notes.push({ label: '시작', value: '진행 중 표시 없이 완료 — 직전 목록의 시각', approx: true });
    if (notes.length) {
      r.approx = true;
      r.notes = notes;
    }
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
// The plan's earlier fold (the tasks a new plan dropped before they ran) opens with 자세히
// (resetPanelSections → _panelTasksEarlier) — on the element once it is defined (D3-GAPS G5-3,
// 0.12.0 setOpen); the reader's own toggle is kept the same way (ui-toggle).
function taskPlanRestore(el) {
  if (!el || typeof el.setOpen !== 'function') return;
  el.setOpen('earlier-plans', !!_panelTasksEarlier);
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
    customElements.whenDefined('ui-task-plan').then(function() { taskPlanRestore(document.getElementById('panel-task-plan')); });
  }
})();
// The runs' sums over every run (shown or not) as the element's totals row (D3-GAPS G5-2):
// how many ran, the tool calls (the main agent's and the subagents' together — the rows
// count them so), the tokens and cost of the runs that recorded them.
function taskTotalsOf(ran) {
  var tools = 0;
  var tok = 0;
  var cost = 0;
  var known = false;
  for (var i = 0; i < ran.length; i++) {
    tools += toNum(ran[i].toolCalls) + toNum(ran[i].agentToolCalls);
    if (ran[i].tokens) { known = true; tok += taskTokTotal(ran[i].tokens); cost += toNum(ran[i].tokens.costUsd); }
  }
  // Shares add up to whole calls; a whole number on screen.
  var out = { runs: ran.length, tools: Math.round(tools) };
  if (known) { out.tokens = tok; out.costUsd = cost; }
  return out;
}
// The work no task got (태스크 밖): its words — tool calls (+서브), tokens; '' when there is none.
function taskOutsideText(outside) {
  if (!outside || !(toNum(outside.toolCalls) || toNum(outside.agentToolCalls) || taskTokTotal(outside.tokens))) return '';
  return '툴 ' + Math.round(toNum(outside.toolCalls))
    + (toNum(outside.agentToolCalls) >= 0.5 ? ' (+서브 ' + Math.round(toNum(outside.agentToolCalls)) + ')' : '')
    + ' · ' + formatTokens(taskTokTotal(outside.tokens)) + ' 토큰';
}
// … as a row under the element's totals (extraTotals), or null.
function taskOutsideNote(outside) {
  var text = taskOutsideText(outside);
  return text ? { label: '태스크 밖', value: text } : null;
}
// … as the page's one line while nothing ran yet (no runs element, so no totals row to sit under).
function taskOutsideHtml(outside) {
  var text = taskOutsideText(outside);
  return text ? '<div class="tr-total tr-outside"><span class="tr-total-k">태스크 밖</span>' + esc(text) + '</div>' : '';
}

let _csrfToken = '';

/*
 * The signed-in account in the app bar (data.account of <ui-app-bar id="app-bar">).
 *
 * Rendered from /auth/me for three session types:
 *   - OAuth JWT (Google/Microsoft/Slack SSO) — shows user.name.
 *   - bearer_cookie (admin viewer token) — shows 관리자.
 *   - unauthenticated (/auth/me → 401) — no account pill; auth middleware
 *     is about to redirect us to /login anyway.
 *
 * The pill is a link to /login, which for a signed-in browser is the account
 * page: who you are signed in as, continue, use a different account, or sign
 * out (GET /auth/logout).
 */
function _applyUserPill(data) {
  let label = '';
  if (data && data.user && data.user.name) {
    label = data.user.name;
  } else if (data && data.isAdmin) {
    label = STRINGS.viewerAdmin;
  }
  // The app bar's account pill: initials, the name (ellipsis past 160px), a link to the account page.
  _appBarAccount = label ? { name: label, href: '/login' } : null;
  paintAppBar();
  if (!label) return;

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
  // Admin approvals (#620): a Slack-signed-in admin only (a viewer token names nobody — the
  // server refuses it the requests). The button stays visible at zero so the bar does not shift.
  const seesApprovals = isAdminCapable && !!_viewerUserId;
  const inboxBtn = document.getElementById('admin-inbox-btn');
  if (inboxBtn) inboxBtn.style.display = seesApprovals ? 'inline-flex' : 'none';
  if (seesApprovals) adminInboxLoad();
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
  // The admin approval cards lock and unlock with admin mode.
  if (_adminInboxOpen) paintAdminInbox();
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
  menu.addEventListener('ui-open-change', function(e) {
    var open = !!(e.detail && e.detail.open);
    if (!open) _tdMenuKind = null;
    // The element marks only the chip it hangs from; the other chip keeps saying it is collapsed.
    ['td-model', 'td-effort'].forEach(function(id) {
      var chip = document.getElementById(id);
      if (chip && (!open || chip.getAttribute('aria-expanded') !== 'true')) chip.setAttribute('aria-expanded', 'false');
    });
  });
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
  if (isError) el.setAttribute('data-tone', 'fail'); else el.removeAttribute('data-tone');
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
  var msg = '기본 ' + (kind === 'model' ? '모델' : '추론 강도') + ' → ' + optionLabel(r.setting, r.setting.value) + ' (새 세션부터)';
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
// "<tokens> 토큰 · $<cost>" (API-equivalent). ≈ when part of it was priced at
// the fallback rate — a model the price table does not know.
function spendText(tokens, cost, estimate) {
  return formatTokens(tokens) + ' 토큰 · ' + (estimate ? '≈' : '') + '$' + toNum(cost).toFixed(2);
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
// Dashboard v2.1 — \`Nm SSs\` for a settled total (the thread's Σ, a closed 활성 시간). Mirrors
// packages/common/src/format/duration.ts; the same words <ui-elapsed> says for a span past a minute.
function formatNmSSs(ms) {
  if (!ms || ms < 0 || isNaN(ms)) return '0m 00s';
  var totalSec = Math.floor(ms / 1000);
  var m = Math.floor(totalSec / 60);
  var s = totalSec % 60;
  return m + 'm ' + (s < 10 ? '0' + s : s) + 's';
}
// Every live time on the page is @2lab.ai/ui <ui-elapsed> (D7 K-03): the root's active time (a leg under way:
// since = the leg's start less what ran before it), a running task's or subagent's elapsed (since), the session's
// last activity (format="ago"). The element ticks them on its own shared whole-second timer, changes the text in
// place and stops by itself; a morph keeps it (its attributes are the data, never Date.now() — a clock in the
// markup would make every poll look like a change). The words are the page's own short form (1m 05s · 6m ago),
// beside formatDuration / formatNmSSs; a closed total is plain text. (The card faces' clocks are <ui-agent-inbox>'s
// own tick; an approval card's expiry <ui-approval-card>'s.) The page's 1 Hz tick keeps one job: the cron
// drawer's 다음 실행 countdown (aqTick — its "곧 … 후" words are the page's).
function elapsedHtml(sinceMs, title) {
  return '<ui-elapsed since="' + Math.round(Number(sinceMs) || 0) + '"' + (title ? ' title="' + escAttr(title) + '"' : '') + '></ui-elapsed>';
}
function activeTimeHtml(legStartedMs, accumulatedMs, title) {
  var leg = Number(legStartedMs) || 0;
  var acc = toNum(accumulatedMs);
  if (leg) return elapsedHtml(leg - acc, title);
  return '<span' + (title ? ' title="' + escAttr(title) + '"' : '') + '>' + formatNmSSs(acc) + '</span>';
}
function agoHtml(atMs) {
  return '<ui-elapsed since="' + Math.round(Number(atMs) || 0) + '" format="ago"></ui-elapsed>';
}
function updateTimers() { aqTick(); }
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
  syncUserSelectTitle();
}

// The user select is the kit's select chip (sized to its option, an ellipsis past the cap): its title keeps the
// selected name in full.
function syncUserSelectTitle() {
  const select = document.getElementById('user-select');
  if (!select) return;
  const opt = select.options[select.selectedIndex];
  select.title = opt ? opt.textContent : '';
}

function selectUser(userId) {
  syncUserSelectTitle();
  currentUserId = userId;
  history.replaceState(null, '', userId ? '/dashboard/' + userId : '/dashboard');
  loadSessions();
  loadStats();
  loadCronJobs();
}

// ── Stats strip — @2lab.ai/ui <ui-stat-strip id="stats-strip"> (B-01..B-05, B-09) ──
// The page hands it the period, the three figures (null = no data "—"; loading = a pulsing bar where the
// figure will be) and 자세히. The element rolls a changed figure (620ms ease-out quart; first paint and
// reduced motion jump) — from: 'last' keeps a figure's value under its loading bar, so a load's answer rolls
// from the previous period's — shows 토큰's per-instance breakdown as the figure's tooltip (hover, focus, a press —
// touch too) and opens 자세히's region over its default slot (.stats-detail). It sends ui-period (the page
// loads that period) and ui-more (the page keeps the choice in localStorage['soma-stats-detail']).
var PERIOD_OPTIONS = [{ value: 'day', label: '오늘' }, { value: 'week', label: '지난 7일' }, { value: 'month', label: '지난 30일' }];
var STATS_DETAIL_KEY = 'soma-stats-detail';
var _strip = { sessions: { value: null, loading: true }, tokens: { value: null, loading: true }, cost: { value: null, loading: true } };
var _tokenBreakdown = null; // { title, rows } while the board's sessions span two or more instances (#814)
var _statsDetailOpen = false;
function setStripFigure(key, value, loading) {
  _strip[key] = { value: typeof value === 'number' && isFinite(value) ? value : null, loading: !!loading };
}
function statsStripData() {
  var tokens = { key: 'tokens', label: '토큰', value: _strip.tokens.value, format: 'tokens', loading: _strip.tokens.loading, from: 'last' };
  if (_tokenBreakdown) tokens.breakdown = _tokenBreakdown;
  return {
    label: '사용량',
    period: { label: '기간', value: currentPeriod, options: PERIOD_OPTIONS },
    metrics: [
      { key: 'sessions', label: '세션', value: _strip.sessions.value, format: 'int', loading: _strip.sessions.loading, from: 'last' },
      tokens,
      { key: 'cost', label: '비용', value: _strip.cost.value, format: 'usd', loading: _strip.cost.loading, from: 'last' },
    ],
    more: { label: '자세히', open: _statsDetailOpen },
  };
}
function paintStatsStrip() {
  var el = document.getElementById('stats-strip');
  if (el) el.data = statsStripData();
}
// The cards behind 자세히 (B-07) — <ui-stat-strip id="stats-grid"> in layout 'cards': 턴 사용 · PR 생성 · PR 머지
// roll like the strip's figures (from: 'last'); 머지 코드 and 워크플로우 are free-form figures in its slots (the
// page's #stat-merge-lines / #stat-workflows). A slotted figure without data leaves its slot, so the element
// shows its own "—".
var _statCards = { turns: null, prs: null, merged: null, loading: true };
function statCardsData() {
  var c = _statCards;
  return {
    layout: 'cards',
    label: '세부 사용량',
    metrics: [
      { key: 'turns', label: '턴 사용', value: c.turns, format: 'int', loading: c.loading, from: 'last' },
      { key: 'prs', label: 'PR 생성', value: c.prs, format: 'int', loading: c.loading, from: 'last' },
      { key: 'merged', label: 'PR 머지', value: c.merged, format: 'int', loading: c.loading, from: 'last' },
      { key: 'lines', label: '머지 코드', slot: 'lines', loading: c.loading },
      { key: 'wf', label: '워크플로우', slot: 'wf', wide: true, loading: c.loading },
    ],
  };
}
function paintStatCards() {
  var el = document.getElementById('stats-grid');
  if (el) el.data = statCardsData();
}
function fillStatSlot(id, slot, html) {
  var el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = html;
  if (html) el.setAttribute('slot', slot);
  else el.removeAttribute('slot');
}
function setPeriod(period) {
  currentPeriod = period;
  paintStatsStrip();
  loadStats();
}

// ── Expand / collapse (P6, D4 K-06) — @2lab.ai/ui <ui-disclosure> (initDisclosures) ──
// A region the page paints only while open (세션 정보, Tasks, 지시 첨부, the completed goals) keeps its
// choice in one value: true (open), 'folding' (closing — the nodes stay for the element's fold until
// ui-toggled), else closed.

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
var BOARD_LABELS = { waiting: STRINGS.boardNeeds, working: STRINGS.boardRunning, done: STRINGS.boardDone };
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

// The board's wording: <ui-agent-inbox lang="ko">'s table (status words, sub-agents, the announcement, the
// relative time), with the page's differences on top (data.strings).
var BOARD_STRINGS = {
  artOpen: function(name, kind) { return (ART_KIND_LABEL[kind] || '파일') + ' ' + name + ' — 크게 보기'; },
  // The sentence is the counts only, never "<title>: <word>." first.
  changed: function() { return ''; },
  // A running card's clock is the ko table's own (12초 · 3분 7초 · 2시간 3분 — 0.10.0, D2-GAPS G6-1).
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
  if (key === dayKeyOf(now)) return STRINGS.today;
  var y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKeyOf(y.getTime())) return STRINGS.yesterday;
  var parts = key.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var opts = { month: 'long', day: 'numeric', weekday: 'short' };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('ko-KR', opts);
}
// Pure: [{ key, label, open, items }] — opened = the reader's choices.
// SSOT 2026-10-30 T2: a starred card leaves its day for the pinned group
// ('starred', ★ 즐겨찾기), first and open until the reader folds it.
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
    groups.unshift({ key: 'starred', label: '\\u2605 즐겨찾기', open: pinOpen, items: pinned.map(function(x) { return x.item; }) });
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
      el.setAttribute('lang', 'ko');
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
    openArtifactViewer(s.conversationId, String(e.detail.artifactId), chip || host);
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
  if (b.html !== html && !isPickingModel(b.el)) {
    morphInnerHtml(b.el, html);
    b.html = html;
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
  if (col !== 'closed' && s.pendingGoalDecision) return '목표 계속 진행할까요? — 응답 대기';
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
  if (r.kind === 'goal-eval') return '목표 완료 판정 중';
  var at = Number(r.at) || 0;
  var what = r.kind === 'goal-eval-retry' ? '목표 판정 재시도' : '자동 재개';
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
  if (!(auto > 0 && used > 0)) return '컨텍스트 윈도우 사용량' + (toNum(pct) > 80 ? ' — 80% 넘게 찼다' : '');
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
    card.statusText = s.terminated ? STRINGS.statusArchived : STRINGS.statusSleeping;
  } else if (acc) {
    card.elapsedMs = acc;
  } else {
    card.statusText = STRINGS.statusIdle;
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
// (D7 D-12: the panel's plan is <ui-task-plan>; this window stays the page's — the element draws the whole plan
// with its phase foot and its own done-steps fold, and has no row cap: research/D7-GAPS.md.)
function renderTaskMeta(t) {
  // Task timestamps come from the ledger: numbers only.
  var started = Number(t.startedAt) || 0;
  var completed = Number(t.completedAt) || 0;
  var removed = Number(t.removedAt) || 0;
  // Task view T2: a task a later plan dropped says so — never a running clock.
  var fate = taskFateOf(t);
  var parts = [];
  if (fate === 'done' && started && completed) parts.push(formatDuration(completed - started) || '0s');
  else if (fate === 'active' && started) parts.push(elapsedHtml(started));
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
  if (folded > 0) html += '<div class="tl-more">+' + folded + ' 완료</div>';
  if (shown.length) html += '<ul class="tl">' + shown.map(renderTimelineItem).join('') + '</ul>';
  if (tail > 0) html += '<div class="tl-more">+' + tail + '개 더</div>';
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
// The kit status (.ui-status) tone per agent status: stopped / unknown / sleeping / archived take the muted
// hollow dot (idle tone); idle — alive, between turns — keeps the plain muted dot. Sleeping and archived
// show their glyph in place of the dot (a leading svg in .ui-status), so the chip keeps the board's cue.
var AGENT_STATUS_TONE = { running: 'run', waiting: 'wait', resuming: 'wait', completed: 'done', failed: 'fail', stopped: 'idle', unknown: 'idle', sleeping: 'idle', archived: 'idle' };
var AGENT_STATUS_GLYPH = { sleeping: '<i data-ui-icon="moon"></i>', archived: '<i data-ui-icon="archive"></i>' };
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
  if (st === 'running') return '<span class="ui-spinner is-sm" aria-hidden="true"></span>';
  if (st === 'completed') return '<i data-ui-icon="check"></i>';
  if (st === 'failed') return '<i data-ui-icon="cross"></i>';
  if (st === 'stopped') return '<i data-ui-icon="stop"></i>';
  if (st === 'waiting') return '<i data-ui-icon="clock"></i>';
  if (st === 'resuming') return '<i data-ui-icon="refresh"></i>';
  if (st === 'idle') return '<i data-ui-icon="dot"></i>';
  if (st === 'sleeping') return '<i data-ui-icon="moon"></i>';
  if (st === 'archived') return '<i data-ui-icon="archive"></i>';
  return '<i data-ui-icon="circle-dashed"></i>';
}
// A node's time: the root's active time (live while it runs — <ui-elapsed>), a running subagent's elapsed, else
// its run time.
function agentTimeHtml(a) {
  if (a && a.root) {
    var acc = toNum(a.activeMs);
    // An open leg runs on while the turn waits for a permission (the card reads waiting).
    var leg = a.status === 'running' || a.status === 'waiting' ? (Number(a.legStartedAt) || 0) : 0;
    if (!acc && !leg) return '';
    return activeTimeHtml(leg, acc, '활성 시간');
  }
  var started = Number(a.startedAt) || 0;
  if (agentStatusOf(a) === 'running') return started ? elapsedHtml(started) : '';
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
  // A control in use is never morphed (isPickingModel).
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
    bits.push('<span class="ui-status pa-st"' + (AGENT_STATUS_TONE[st] ? ' data-tone="' + AGENT_STATUS_TONE[st] + '"' : '') + (st === 'running' ? ' data-live' : '') + '>' + (AGENT_STATUS_GLYPH[st] || '') + esc(AGENT_STATUS_LABEL[st] || '') + '</span>');
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
  syncPanelArtVariant();
}
// The sections an opening starts with: every one open with 자세히 — except the goal,
// which always opens folded (SSOT 2026-10-29) — else the defaults.
function resetPanelSections() {
  _panelInfoOpen = _panelDetail;
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

// Agent tabs (T1.2, D4 E-19): @2lab.ai/ui <ui-tabs shared-panel> — Main first,
// always, pinned at the strip's left (the element's sticky tab, its fade once the
// others scroll under it), then each subagent in spawn order; the type is the
// muted second label (meta), the status the tone dot with its word in the title.
// Every tab controls the one panel below the strip (Tasks, the work log, 지시와
// 답변), scoped to its agent; the element's arrows / Home / End move and select
// (automatic activation) and its ui-change is selectPanelAgent.
var PT_MAIN = 'main'; // the Main tab's id; a subagent's is 'a:' + its id
var AGENT_TAB_TONE = { running: 'run', waiting: 'wait', resuming: 'wait', completed: 'done', failed: 'fail', stopped: 'fail' };
function panelTabId(agentId) {
  return agentId ? 'a:' + agentId : PT_MAIN;
}
function panelTabAgent(tabId) {
  return typeof tabId === 'string' && tabId.slice(0, 2) === 'a:' ? tabId.slice(2) : '';
}
// Pure: the strip's data — the tabs, the selected one ('' = Main), the list's name.
function panelTabsData(s, active, mainSt) {
  var st0 = mainSt || (s && s.activityState === 'working' ? 'running' : s && s.activityState === 'waiting' ? 'waiting' : 'idle');
  var tab = function(id, st, name, type, pinned) {
    var t = { id: id, label: name, tone: AGENT_TAB_TONE[st] || 'rest', title: name + (type ? ' ' + type : '') + ' — ' + (AGENT_STATUS_LABEL[st] || '') };
    if (type) t.meta = type;
    if (pinned) t.pinned = true;
    return t;
  };
  var model = s && s.model ? String(s.model).replace(/^claude-/, '') : '';
  var tabs = [tab(PT_MAIN, st0, '메인', model, true)];
  var list = ((s && s.agents) || []).slice().sort(function(a, b) { return toNum(a.n) - toNum(b.n); });
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || !a.id) continue;
    tabs.push(tab(panelTabId(String(a.id)), agentStatusOf(a), 'A' + toNum(a.n), a.type || '', false));
  }
  return { label: '에이전트', value: panelTabId(active || ''), tabs: tabs };
}
// The strip follows the session (a live update with the same data writes nothing);
// without one it keeps Main alone, so the panel under it stays slotted.
function renderPanelTabs() {
  var el = document.getElementById('panel-tabs');
  if (!el) return;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var d = s ? panelTabsData(s, _panelAgent, rootStatusOf(s, sessionColOf(panelSessionKey))) : panelTabsData(null, '', '');
  var sig = JSON.stringify(d);
  if (el._sig === sig) return;
  el._sig = sig;
  el.data = d;
}
// The agent strip's height — the element's sticky list; the shared panel under it
// is the element's too, so the panel's top against the host's is the list.
function panelTabsHeight() {
  var el = document.getElementById('panel-tabs');
  var pane = document.getElementById('panel-tabpanel');
  if (!el || !pane) return 0;
  return Math.max(0, Math.round(pane.getBoundingClientRect().top - el.getBoundingClientRect().top));
}
// Focus a <ui-tabs>' selected tab (the keyboard landing on the 작업 로그 tab): the
// element has no focus() of its own, so the tab is reached through its open shadow root.
function uiTabsFocus(el) {
  var tab = el && el.shadowRoot ? el.shadowRoot.querySelector('[role="tab"][aria-selected="true"]') : null;
  if (tab && tab.focus) tab.focus({ preventScroll: true });
  return !!tab;
}
function bindPanelTabs() {
  var el = document.getElementById('panel-tabs');
  if (!el || el._bound) return;
  el._bound = true;
  el.addEventListener('ui-change', function(e) {
    selectPanelAgent(panelTabAgent(e.detail && e.detail.value));
  });
  renderPanelTabs();
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
      var failure = _agentConvFailed[key] = { error: String(r.error || STRINGS.error) };
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
// Inside the focused agent's tab, three section tabs, each a library element in
// its own scroll box (<ui-log-scroller>: the reader's place is per tab). Only the
// active one is in the DOM: the others keep their data (the work-log state, the
// turns, the agents) and are painted from it when they are opened. Each opens on
// its newest items, at its bottom; scrolling up pages back (the element's top row
// is the keyboard path; ui-load-older → this page's loader) and the reader keeps
// their place. A new item at the bottom follows a reader who is there; one
// reading higher keeps their place and gets the element's pill to the newest.
var PSEC_ORDER = ['conv', 'log', 'tree'];
// The element that draws each section as its own scroll box: 지시와 답변
// (<ui-conversation>), 작업 로그 (<ui-work-log>), 에이전트 트리 (<ui-log-scroller>
// around the one <ui-agent-tree> — D3-GAPS G1-1, closed by 0.12.0: the scroller
// holds the reader's row through the tree's open shadow root).
var PSEC_EL = { conv: 'panel-conv', log: 'worklog-list', tree: 'panel-tree' };
function psecEl(sec) {
  var id = PSEC_EL[sec || _psec];
  return id ? document.getElementById(id) : null;
}
var PANEL_TURNS_PAGE = 20; // turns per page of 지시와 답변
var AT_PANEL_WINDOW = 20; // agents per step of 에이전트 트리
var _psec = 'conv'; // the section tab shown
var _treeWindow = AT_PANEL_WINDOW; // how many of the newest agents the tree shows (this opening)
var _treeMaxN = null; // the newest spawn number the tree showed (null: not painted yet)

// Pure: the section an opening lands on — 작업 로그 / ?session= → 작업 로그, a tree
// item → 에이전트 트리, else (답변하기, a blocker, a card) → 지시와 답변.
function psecForLanding(land) {
  return land === 'worklog' ? 'log' : land === 'agent' ? 'tree' : 'conv';
}
// The section strip's tabs (D4 E-24): Chat · 작업 로그 at the start, 에이전트 트리 at the
// far end (TabItem.end) with the tree glyph; each one's panel is the box slotted by its id.
var PSEC_TABS = [
  { id: 'conv', label: '대화', title: '지시와 답변' },
  { id: 'log', label: '작업 로그' },
  { id: 'tree', label: '에이전트 트리', icon: 'tree', end: true },
];
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
// The tab strip and the panels — <ui-tabs>: the selected tab, the one tab stop, the
// one panel shown are its own from the data; the same section writes nothing.
function renderPanelSections() {
  var el = document.getElementById('panel-sections');
  if (!el || el._sec === _psec) return;
  el._sec = _psec;
  el.data = { label: '섹션', value: _psec, tabs: PSEC_TABS };
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
      if (typeof tree.clearItems === 'function') tree.clearItems();
      else if (tree.firstChild) tree.innerHTML = '';
      tree._tree = null;
      tree._hidden = 0;
      tree._growing = false;
      tree._sig = '';
    }
    _treeMaxN = null;
  }
}
function paintSection(sec) {
  if (sec === 'conv') convPaint();
  else if (sec === 'log') wlPaint();
  else paintTreeTab();
}
// Show the section tab sec: the others leave the DOM; this one is painted from
// its data and lands on its newest items. (A key or a click keeps the element's
// focus on the tab it moved to.)
function selectPanelSection(sec) {
  if (PSEC_ORDER.indexOf(sec) < 0) sec = 'conv';
  _psec = sec;
  renderPanelSections();
  for (var i = 0; i < PSEC_ORDER.length; i++) if (PSEC_ORDER[i] !== sec) psecClear(PSEC_ORDER[i]);
  if (panelSessionKey) paintSection(sec);
  psecToNewest();
}
// The section shown, at its newest item (the element's); a later scroll up is the reader's.
function psecToNewest() {
  var el = psecEl();
  if (el && typeof el.scrollToLatest === 'function') el.scrollToLatest({ smooth: false });
}
// The section box takes the rest of the panel (psecHeightOf) as the parts above it
// change — its height is --psec-h on the wrapper (the box is slotted into <ui-tabs>,
// under the element's strip: the box's top against the host's is that strip).
function sizePanelSections() {
  var scroll = document.getElementById('panel-scroll');
  var body = document.getElementById('panel-sections-body');
  var secs = document.getElementById('panel-sections');
  var box = psecBox();
  if (!scroll || !body || !secs || !box) return;
  var view = scroll.clientHeight;
  if (!view) return;
  var secTop = secs.getBoundingClientRect().top;
  var strip = Math.max(0, box.getBoundingClientRect().top - secTop);
  var top = secTop + strip - scroll.getBoundingClientRect().top + scroll.scrollTop;
  var h = psecHeightOf(view, top, panelTabsHeight() + strip);
  if (body._h === h) return;
  body._h = h;
  body.style.setProperty('--psec-h', h + 'px');
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
// root and the focused one selected — the one item of the tab's <ui-log-scroller>
// (the tree itself, so the scroller reads the rows' data-anchor through its open
// shadow root): the newest _treeWindow agents with what connects them
// (atWindowOf); the scroller's older row / a scroll-up asks for AT_PANEL_WINDOW
// more of the agents already loaded (ui-load-older → showMoreTree). A live
// arrival below a reader reading higher is counted on the scroller's pill.
var TREE_SCROLLER = { label: '에이전트 트리', startText: '에이전트 트리의 시작', emptyText: '이 세션에는 하위 에이전트가 없습니다' };
function treeScrollerData(host, hasMore) {
  var d = { label: TREE_SCROLLER.label, startText: TREE_SCROLLER.startText, emptyText: TREE_SCROLLER.emptyText, hasMore: !!hasMore };
  var sig = JSON.stringify(d);
  if (host._sig === sig) return;
  host._sig = sig;
  host.data = d;
}
function paintTreeTab() {
  var host = document.getElementById('panel-tree');
  if (!host || _psec !== 'tree') return;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var root = s ? agentTreeOf(s, sessionColOf(panelSessionKey), panelLogOnlyAgents(s)) : null;
  if (!root || !root.children.length) {
    host._tree = null;
    host._hidden = 0;
    if (host.querySelector('ui-agent-tree')) {
      if (typeof host.clearItems === 'function') host.clearItems();
      else host.innerHTML = '';
    }
    treeScrollerData(host, false);
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
  var tree = host.querySelector('ui-agent-tree');
  if (!tree) {
    // The element is the item (data-item): made once per opening, given data from then on.
    tree = document.createElement('ui-agent-tree');
    tree.className = 'pa-tree';
    tree.setAttribute('lang', 'ko');
    tree.setAttribute('data-item', 'tree');
    tree.innerHTML = '<span class="at-fallback">에이전트 트리</span>';
    if (typeof host.upsertItem === 'function') host.upsertItem('tree', tree, { animate: false });
    else host.appendChild(tree);
  }
  if (tree.getAttribute('data-at-ns') !== ns) tree.setAttribute('data-at-ns', ns);
  atPaint(tree, d, JSON.stringify(d));
  treeScrollerData(host, win.hidden > 0);
  if (newer && typeof host.noteUnread === 'function') host.noteUnread(newer);
}
// The scroller asked for older agents (ui-load-older): AT_PANEL_WINDOW more of the
// agents already loaded go in where they belong in the tree (above the reader, or
// inside a branch they are reading — the scroller holds their row). One step at a
// time: the next waits for this one's render (a frame — the element renders on the
// next microtask), then the scroller hears the page landed and whether more wait.
function showMoreTree() {
  var host = document.getElementById('panel-tree');
  if (!host || !(host._hidden > 0) || host._growing) return false;
  _treeWindow += AT_PANEL_WINDOW;
  host._growing = true;
  // The scroller asks from its scroll handler and takes the reader's place in the next frame (its own frame,
  // queued before this one): the tree grows a frame later, after that capture, so the scroller restores the
  // reader's row when the growth lands (D6b review P1). A frame after the growth it hears that more still wait.
  requestAnimationFrame(function() {
    if (_psec !== 'tree') {
      host._growing = false;
      return;
    }
    paintTreeTab();
    requestAnimationFrame(function() {
      host._growing = false;
      if (_psec !== 'tree') return;
      if (typeof host.prependItems === 'function') host.prependItems([], { hasMore: host._hidden > 0 });
    });
  });
  return true;
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
// One-time wiring: the tablist (<ui-tabs>: click, ←/→/Home/End with automatic
// activation are its own; its ui-change is the choice), the tree's older page
// (the scroller's ui-load-older), and the boxes' size.
(function initPanelSections() {
  var strip = document.getElementById('panel-sections');
  if (!strip) return;
  strip.addEventListener('ui-change', function(e) {
    var sec = e.detail ? e.detail.value : '';
    if (sec && sec !== _psec) selectPanelSection(sec);
  });
  renderPanelSections();
  var tree = document.getElementById('panel-tree');
  if (tree) {
    tree.addEventListener('ui-load-older', function(e) {
      if (!showMoreTree()) e.preventDefault();
    });
  }
  if (typeof ResizeObserver === 'function') {
    var size = new ResizeObserver(function() { sizePanelSections(); syncPanelArtVariant(); });
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
// nodes stay; a live time is <ui-elapsed>'s own).
function writePanelPart(el, html) {
  if (el._html === html) return false;
  morphInnerHtml(el, html);
  el._html = html;
  return true;
}

// The composer and the session's follow-up queue — @2lab.ai/ui <ui-agent-steering>
// (dashboard batch 2) — follow the session, also live (spec 13: the panel's own
// Close can end the session it shows). Non-owner takes precedence over closed
// (read-only: the queue shows, nothing can be done — like Stop); fail closed on a
// missing ownerId. The element keeps the text being typed (an IME composition
// too) across every update, so its data is written whenever it changed. It turns
// its slotted composer off with its field (tools too, a recording discarded); a
// change of mode away from open also drops the composer's files.
function renderPanelComposer(s, force) {
  var host = document.getElementById('panel-command');
  var el = document.getElementById('cmd-steer');
  if (!host || !el || !s) return;
  var mode = pcModeOf(s);
  if (force || host._mode !== mode) {
    host._mode = mode;
    // A dashboard task takes no attachments yet (D8, #600 ⑥): the composer's
    // tools are off and a pasted or dropped file is refused (#640 R2).
    host._takesFiles = pcToolsOpen(s, mode);
    pcComposerSetup(document.getElementById('pc-composer'), host._takesFiles);
    if (mode !== 'open') pcReset();
  }
  var data = steeringData(s, mode);
  var sig = JSON.stringify(data);
  if (!force && el._sig === sig) return;
  el._sig = sig;
  el.data = data;
}
// The composer's attach / image / mic: an open session's — but not a dashboard
// task's, which takes no attachments yet (D8, #600 ⑥).
function pcToolsOpen(s, mode) {
  return mode === 'open' && !(s && s.slackless);
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
// only, Edit only where the server offers it. The files of the next message are
// the slotted composer's (a note leaves with them).
function steeringData(s, mode) {
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
  return { running: mode !== 'closed' && s.activityState === 'working', canAct: mode !== 'readonly', disabled: mode === 'closed', items: items };
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
// The bar's buttons named for what they do to the session (D3-GAPS G6-1, 0.12.0 ariaLabel): Close is never
// taken for the panel's ✕ (작업 카드 닫기). Star carries its pressed state and its tooltip; Trash the quiet tone.
var SESSION_ACTION_ARIA = { stop: '중지 — 세션 중지', close: '닫기 — 세션 종료', trash: '휴지통 — 세션 휴지통으로' };
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
    if (SESSION_ACTION_ARIA[a.id] && !a.sibling) x.ariaLabel = SESSION_ACTION_ARIA[a.id];
    if (a.id === 'stop' && !a.sibling) { x.tone = 'danger'; x.icon = 'stop'; }
    if (a.id === 'trash') x.tone = 'quiet';
    if (a.id === 'star') x.pressed = !!a.pressed;
    if (a.tip) x.title = a.tip;
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

// 세션 정보: a <ui-disclosure> (D4 K-06) whose row is the one-line summary (owner ·
// workflow · tokens · cost · context · last activity, live); opened, every number
// of the session in its region (painted only while open — keep: through the fold);
// the links stay in view under it. The panel is the complete record: the card
// header's dhShow gates do not apply here. _panelInfoOpen: true · 'folding' · false.
var _panelInfoOpen = false;
function panelInfoHtml(s, open, col, keep) {
  var u = s.tokenUsage || null;
  var ctx = u ? toNum(u.contextUsagePercent) : 0;
  var sum = [];
  if (s.ownerName) sum.push(esc(s.ownerName));
  if (s.workflow) sum.push(esc(s.workflow));
  if (u) sum.push(formatTokens(cardTotalTokens(u)) + ' 토큰', '$' + toNum(u.totalCostUsd).toFixed(2));
  if (ctx > 0) {
    var ctxCls = ctxLevel(ctx, s.contextTokens, s.autoCompactTokens, s.compactPending);
    sum.push('<span class="pi-cs' + (ctxCls ? ' ' + ctxCls : '') + '">컨텍스트 ' + ctxPercent(ctx) + '%</span>');
  }
  sum.push(agoHtml(new Date(s.lastActivity).getTime() || 0));
  var html = '<ui-disclosure class="pi-dc" flush' + (open ? ' open' : '') + '>'
    + '<span slot="summary" class="pi-head"><span class="pi-title">세션 정보</span><span class="pi-sum">' + sum.join('<span class="pi-dot" aria-hidden="true">&middot;</span>') + '</span></span>';
  var links = [];
  if (s.issueUrl) links.push('<a href="' + safeHref(s.issueUrl) + '" target="_blank" rel="noopener">' + esc(s.issueLabel || s.issueShortRef || '이슈') + (s.issueTitle ? ' &mdash; ' + esc(String(s.issueTitle).slice(0, 60)) : '') + '</a>');
  if (s.prUrl) links.push('<a href="' + safeHref(s.prUrl) + '" target="_blank" rel="noopener">' + esc(s.prLabel || s.prShortRef || 'PR') + (s.prTitle ? ' &mdash; ' + esc(String(s.prTitle).slice(0, 60)) : '') + '</a>');
  if (s.conversationId) links.push('<a href="/conversations/' + escAttr(s.conversationId) + '" target="_blank" rel="noopener">전체 대화</a>');
  // The links stay in view under the summary while the record is folded: the element's links slot (D3-GAPS G6-2, 0.12.0).
  if (links.length) html += '<div slot="links" class="pi-links">' + links.join('') + '</div>';
  var foot = '</ui-disclosure>';
  if (!open && !keep) return html + foot;
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
    if (toNum(u.partialSince) > 0) rows.push(['집계 시작', agoHtml(toNum(u.partialSince)) + ' (그 전 지출 미포함)']);
  }
  // Open body order (re-agent-run D19 · re-context-window D5): the context block (cwSlotHtml, prepended on return) → 세부 → token grid → thread.
  var body = panelDetailsHtml(s, col) + '<dl class="ui-dl pi-grid">' + rows.map(function(r) { return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>'; }).join('') + '</dl>';
  var thread = ['&Sigma; ' + formatNmSSs(toNum(s.threadTotalActiveMs)), '압축 ' + toNum(s.compactionCount), '세션 ' + toNum(s.threadSessionCount)];
  if (s.mergeStats) thread.push('+' + toNum(s.mergeStats.totalLinesAdded) + ' / -' + toNum(s.mergeStats.totalLinesDeleted));
  body += '<div class="pi-thread">' + thread.join('<span class="pi-dot" aria-hidden="true">&middot;</span>') + '</div>';
  if (s.autoResume && s.autoResume.reason) body += '<div class="pi-resume">오류: ' + esc(s.autoResume.reason) + '</div>';
  return html + '<div class="pi-body" id="panel-info-body">' + cwSlotHtml(s) + body + '</div>' + foot;
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
  if (acc || leg) rows.push(['활성 시간', activeTimeHtml(leg, acc)]);
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
  writePanelPart(el, s ? panelInfoHtml(s, _panelInfoOpen === true, sessionColOf(panelSessionKey), _panelInfoOpen === 'folding') : '');
  if (s) cwPaint(el.querySelector('ui-context-window'), s, now);
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
  // A task turn refuses commands (D8): "compact now" would run as an instruction (#600 ⑥).
  if (s.slackless) return '대시보드 작업에서는 아직 지원하지 않아요';
  var env = s.environment;
  if (isSiblingSession(s)) return STRINGS.siblingLock(env);
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
// The goal's home (spec 13): <ui-goal-card lang="ko"> in #panel-goal — one per session, made when the panel
// turns to that session (another session's draft never carries over; the same session reopened keeps an
// unsent one), handed data only when it changed (the element morphs in place: typing, focus and its folds
// survive a live render; the objective opens folded to 3 lines on every opening — a new goal id starts folded).
function renderPanelGoal() {
  var el = document.getElementById('panel-goal');
  if (!el) return;
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var col = s ? sessionColOf(panelSessionKey) : '';
  var isOwner = !!(s && s.ownerId) && s.ownerId === currentUserId;
  var live = !!s && col !== 'closed' && !s.terminated;
  var canEdit = isOwner && live && !isSiblingSession(s);
  var g = s ? s.goal : null;
  // Read-only viewers and closed sessions only see a goal list that exists.
  if (!s || !(g || canEdit)) {
    el.style.display = 'none';
    if (el._key) { el.innerHTML = ''; el._key = null; }
    return;
  }
  el.style.display = '';
  // Task view T1.6: a session with no goal keeps the empty editor for 자세히.
  el.classList.toggle('is-empty', !(g && (g.current || (g.queue && g.queue.length) || (g.history && g.history.length))));
  var card = el.firstElementChild;
  // A new card for every panel opening (SSOT 2026-10-29: each opening starts with the past goals folded — the
  // element keeps its fold across data); reopening the same session carries the unsent add-box draft over
  // (D6b review P2). Repaints within one opening keep the card and its fold.
  if (!card || card.tagName !== 'UI-GOAL-CARD' || el._key !== panelSessionKey || el._gen !== _panelGen) {
    var draft = card && card.tagName === 'UI-GOAL-CARD' && el._key === panelSessionKey && typeof card.draft === 'string' ? card.draft : '';
    el.innerHTML = '';
    card = document.createElement('ui-goal-card');
    card.setAttribute('lang', 'ko');
    card.setAttribute('data-goal-key', panelSessionKey);
    el.appendChild(card);
    if (draft) card.draft = draft;
    el._key = panelSessionKey;
    el._gen = _panelGen;
  }
  var d = goalCardData(s, canEdit);
  var sig = JSON.stringify(d);
  if (card._gcSig !== sig) {
    card._gcSig = sig;
    card.data = d;
  }
}
// The goal landing (관리 → / goal 추가 →): the element's add box when it has one, else its group — read through
// the open shadow root by element / role, as uiTabsFocus does (the card has no focus API of its own).
function goalCardFocusTarget() {
  var card = document.querySelector('#panel-goal > ui-goal-card');
  var root = card && card.shadowRoot;
  return root ? (root.querySelector('textarea') || root.querySelector('[role="group"]')) : null;
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
    // In flight: the shape of 지시 and 응답 (kit skeleton lines, the second row a beat later), the words for screen readers only.
    return '<div class="card-io" aria-busy="true"><div class="io-row io-skel" aria-hidden="true"><div class="ui-skeleton is-line" style="width:44%"></div><div class="ui-skeleton is-line" style="width:86%"></div></div>'
      + '<div class="io-row io-skel" aria-hidden="true"><div class="ui-skeleton is-line" style="width:36%;--i:1"></div><div class="ui-skeleton is-line" style="width:72%;--i:1"></div></div>'
      + '<span class="ui-sr-only">지시/응답 불러오는 중…</span></div>';
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
  if (info) who = '<span class="io-who is-sys">시스템</span>';
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
      + '<span class="skill-name">' + esc(skills[i].name) + '</span><span class="skill-tok">≈' + formatTokens(skills[i].tokens) + ' 토큰</span></button>';
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
  return '<div class="ui-notice card-resume" data-tone="wait">' + RESUME_SVG + '<div>'
    + '<strong>' + esc(autoResumeLabel(r)) + '</strong>'
    + (r.reason ? '<div>' + esc(r.reason) + '</div>' : '')
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
  var label = kind === 'stop' ? '중지' : (kind === 'trash' ? '휴지통' : '닫기');
  var env = s.environment;
  if (SELF_INSTANCE_NAME && env && env.instanceName && env.instanceName !== SELF_INSTANCE_NAME) {
    return [{ id: kind, label: label + ' \\u2192 ' + env.instanceName, busy: false, sibling: true, lock: STRINGS.siblingLock(env) }];
  }
  var isOwner = !!s.ownerId && s.ownerId === currentUserId;
  var lock = isOwner ? '' : READ_ONLY_MSG;
  var lifeBusy = isBusy(s.key, 'life');
  var starred = s.starred === true;
  var closed = col === 'closed' || s.terminated === true || s.sessionState === 'SLEEPING';
  var out = [{ id: 'star', label: starred ? '\\u2605 즐겨찾기' : '\\u2606 즐겨찾기', pressed: starred, lock: lock, busy: lifeBusy,
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
  // The goal's cap decision sits with them: the same card as the owner's DM.
  const permissionHtml = col === 'closed' ? '' : acPermissionsHtml(s) + acGoalDecisionHtml(s);

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
    + taskOutcomeHtml(s)
    + questionHtml
    + middle
    + cardGoalLine(s, col, isOwner && !isSibling)
    + refsHtml
    + footHtml
    + '</div>';
}

// #600 ⑥ — a dashboard task's last turn as its card says it: how it ended, why,
// and a recording failure (the outcome was not saved).
var TASK_OUTCOME_LABEL = { completed: '완료', failed: '실패', cancelled: '중지됨', interrupted: '중단됨', waiting: '입력 대기' };
function taskOutcomeHtml(s) {
  var o = s && s.slackless && s.lastTurnOutcome;
  if (!o) return '';
  var kind = String(o.outcome || '');
  return '<div class="card-task-outcome" data-outcome="' + escAttr(kind) + '">'
    + '<span class="cto-label">마지막 턴 · ' + esc(TASK_OUTCOME_LABEL[kind] || kind) + '</span>'
    + (o.reason ? '<span class="cto-reason">' + esc(o.reason) + '</span>' : '')
    + (o.recordFailure ? '<span class="cto-warn" role="alert">기록하지 못함 · ' + esc(o.recordFailure) + '</span>' : '')
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
    return picker ? '' : '<div class="ui-status-line cb-model-note" role="status">compact 후 ' + esc(s.pendingModel) + '(으)로 전환합니다…</div>';
  }
  var n = _modelNotes[s.key];
  if (!n || (picker && n.error)) return '';
  return '<div class="ui-status-line cb-model-note"' + (n.error ? ' data-tone="fail" role="alert"' : ' role="status"') + '>' + esc(n.text) + '</div>';
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
  if (res.status === 'compacting') return { text: '컨텍스트가 ' + res.nickname + '의 자동 압축 지점 ' + formatTokens(res.autoCompactTokens) + '보다 커서 지금 모델로 압축한 뒤 전환합니다', error: false };
  if (res.status === 'unchanged') return { text: '이미 ' + res.nickname + '입니다', error: false };
  return { text: res.nickname + '(으)로 전환 · 자동 압축 ' + formatTokens(res.autoCompactTokens), error: false };
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
var EFFORT_LABELS = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };
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
  return { text: '추론 강도 ' + effortLabel(res.effort) + ' · 다음 턴부터 적용' + capped, error: false };
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
// ── Goal (E-12): @2lab.ai/ui <ui-goal-card> — the goal's home (spec 13) ──
// The board card's line (cardGoalLine) reads the status words; the editor is the element in #panel-goal
// (renderPanelGoal): the current goal (status chip, the objective folded to 3 lines with 펼치기 / 접기, the
// 이어하기 budget, the evaluator's 남은 것), the queue, the past goals in its own fold (T6), the add box and the
// error alert are the element's — as are the second press on Delete, the typed draft across every data write
// (it morphs in place) and the focus that lands on the card when its goal left. The page keeps the data
// (goalCardData), the one goal write in flight per session (_goalBusy → busy / busyId) and the routes. Every
// write names WHERE the goal was seen (current / queued), so a goal that moved in the meantime is refused
// (409) instead of deleting the wrong one — never goal clear, which also drops the queue. actions is
// ['delete']: POST /session/:key/goal takes add and delete only (the host layer has no complete / pause,
// D3 G4-1), so the card never offers them.
var GOAL_STATUS_LABELS = { active: '진행 중', paused: '일시정지', complete: '완료' };
var GOAL_STATUS_TONE = { active: 'run', paused: 'wait', complete: 'done' };
// The goal mark (P7): the 2lab icon set's target glyph, not the bullseye emoji.
var GOAL_SVG = '<i data-ui-icon="target"></i>';
var GOAL_VIA_LABELS = { user: '직접 완료', 'eval-model': '평가 모델 완료' };
var GOAL_OBJECTIVE_MAX = 4000; // the route's cap on an objective
var GOAL_ACTIONS = ['delete']; // what the goal route answers besides add
var _goalErrors = Object.create(null); // session key → last refused goal action (shown until the next success)
var _goalBusy = Object.create(null); // session key → { op: 'add' | 'delete', id } while that write is out
// One past goal for the element: time spent · tokens · cost · continuation turns · how it closed on its meta
// line, the evaluator's reason as its note (when it ended is the element's, from endedAt).
function goalPastItem(h) {
  var meta = [];
  if (toNum(h.activeMsUsed) > 0) meta.push('소요 ' + formatDuration(toNum(h.activeMsUsed)));
  if (h.tokens !== undefined) meta.push(formatTokens(h.tokens) + ' 토큰');
  if (h.costUsd !== undefined) meta.push('$' + toNum(h.costUsd).toFixed(2));
  if (toNum(h.continuationCount) > 0) meta.push('이어하기 ' + toNum(h.continuationCount) + '회');
  if (h.completedVia) meta.push(Object.prototype.hasOwnProperty.call(GOAL_VIA_LABELS, h.completedVia) ? GOAL_VIA_LABELS[h.completedVia] : String(h.completedVia));
  var item = { id: String(h.goalId), objective: String(h.objective || ''), status: 'complete' };
  if (toNum(h.completedAt) > 0) item.endedAt = toNum(h.completedAt);
  if (meta.length) item.meta = meta;
  if (h.completionReason && h.completionReason !== 'user') item.note = String(h.completionReason);
  return item;
}
// The element's data for session s. canEdit: the owner on a live session (a read-only viewer and a closed
// session see the list, no controls); busy / error are this page's write state.
function goalCardData(s, canEdit) {
  var g = s.goal || null;
  var cur = g && g.current;
  var d = { canEdit: !!canEdit, actions: GOAL_ACTIONS, maxLength: GOAL_OBJECTIVE_MAX, current: null, queue: [], history: [] };
  if (cur) {
    d.current = { id: String(cur.goalId), objective: String(cur.objective || ''), status: cur.status };
    if (cur.status === 'active') {
      // The auto-continue count is a budget, not progress: the quiet meta line, never the bar.
      if (toNum(cur.maxContinuations) > 0) d.current.meta = [{ label: '이어하기', value: toNum(cur.continuationCount) + '/' + toNum(cur.maxContinuations) }];
      if (cur.lastEvalReason) d.current.note = '남은 것: ' + String(cur.lastEvalReason).slice(0, 300);
    }
  }
  d.queue = ((g && g.queue) || []).map(function(q) { return { id: String(q.goalId), objective: String(q.objective || '') }; });
  d.history = ((g && g.history) || []).map(goalPastItem);
  var busy = _goalBusy[s.key];
  if (busy) {
    d.busy = busy.op;
    if (busy.id) d.busyId = busy.id;
  }
  if (_goalErrors[s.key]) d.error = _goalErrors[s.key];
  return d;
}
// An open model menu holds its anchor's card still: the trigger is where the menu hangs (re-model-picker D12).
function isPickingModel(root) {
  return !!(root && root.querySelector && root.querySelector('ui-model-picker[open]'));
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
  repaintPanelGoalFor(key);
}
function repaintPanelGoalFor(key) {
  if (panelOpen && panelSessionKey === key) renderPanelGoal();
}
// One goal write at a time per session (spec 13 §3.5: an add never overlaps a delete), shown on the element's
// button (busy; busyId for a queued goal's remove) until the outcome lands. Resolves to whether it went through.
async function goalAction(key, payload, busyId) {
  if (isBusy(key, 'goal')) return false;
  setBusy(key, 'goal', true);
  _goalBusy[key] = { op: payload.action, id: busyId || '' };
  repaintPanelGoalFor(key);
  var r;
  try { r = await postGoalAction(key, payload); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  setBusy(key, 'goal', false);
  delete _goalBusy[key];
  setGoalError(key, r.ok ? '' : r.error);
  loadSessions();
  return r.ok;
}
// ui-add is prevented, so the element keeps the words in its box: they are cleared only once the add went
// through (a refusal leaves them to fix), and only on this session's live card (never another session's draft).
async function addGoal(key, objective, card) {
  objective = String(objective || '').trim();
  if (!objective) return;
  var ok = await goalAction(key, { action: 'add', objective: objective });
  if (ok && card && card.isConnected && card.getAttribute('data-goal-key') === key && card.draft.trim() === objective) card.draft = '';
}
// The element's events: a confirmed Delete (the current goal, or a queued one — its own remove spins), an Add.
document.addEventListener('ui-delete', function(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-GOAL-CARD' || !e.detail) return;
  var key = el.getAttribute('data-goal-key');
  if (!key || !_sessionCache[key]) { e.preventDefault(); return; }
  var id = String(e.detail.id || '');
  goalAction(key, { action: 'delete', goalId: id, expect: e.detail.queued ? 'queued' : 'current' }, e.detail.queued ? id : '');
});
document.addEventListener('ui-add', function(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-GOAL-CARD' || !e.detail) return;
  e.preventDefault();
  var key = el.getAttribute('data-goal-key');
  if (!key || !_sessionCache[key]) return;
  addGoal(key, e.detail.objective, el);
});

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
function currentLayoutMode() {
  var inbox = document.getElementById('inbox');
  var panel = document.getElementById('slide-panel');
  var kb = document.getElementById('kanban');
  var m = layoutModeOf(
    window.innerWidth,
    inbox ? inbox.getBoundingClientRect().width : 0,
    !!(panel && panel.hasAttribute('open')),
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
  // The open drawer's own box (sheet ↔ dock) morphs with the cards: <ui-drawer>'s in-place switch
  // (D4 E-01) — 320ms on the drawer curve from where it was drawn, retargeting a morph still running,
  // none under reduced motion. The page animates nothing of it.
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
  setTextIfChanged(label, STRINGS.archives + ' (' + archivedCount + ')');
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
  setTextIfChanged(label, STRINGS.sleeping + ' (' + sleepingCount + ')');
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
  setLifecycleStatus(_lifecycle.degraded ? '저장된 정책 파일을 읽을 수 없어 휴면/종료 전환을 멈춘 상태입니다. 저장하면 다시 시작합니다.' : '', !!_lifecycle.degraded);
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
function setLifecycleStatus(text, isError) {
  var el = document.getElementById('lifecycle-status');
  if (!el) return;
  el.textContent = text;
  if (isError) el.setAttribute('data-tone', 'fail'); else el.removeAttribute('data-tone');
}
var LIFECYCLE_LABELS = {
  sleepAfterHours: '휴면 전환', archiveAfterDays: '보관 전환', boardArchiveWindowHours: '보관함 표시 기간',
  sleepAfterMs: '휴면 전환', archiveAfterMs: '보관 전환', boardArchiveWindowMs: '보관함 표시 기간',
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
      setLifecycleStatus('이 값으로 저장하면 다음 정리 주기에 ' + (data.willSleep || 0) + '개 세션이 휴면으로, '
        + (data.willArchive || 0) + '개 세션이 종료(보관)됩니다. 종료는 되돌릴 수 없습니다. 그래도 저장하려면 한 번 더 누르세요.', true);
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
    // The board's build (build skew): the poll is the only word from a server whose socket never connects.
    if (onServerBuild(res.headers && res.headers.get ? res.headers.get('x-dashboard-build') : '')) return;
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
      // …its question too: a form must show the ask its actions answer (#637 R2).
      renderPanelQuestion(_sessionCache[panelSessionKey]);
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
  // An opening still waiting for <ui-drawer> was for the archived key: it opens the live one (D4 review P3).
  if (_panelOpenWaiting && _panelOpenWaiting[0] === oldKey) _panelOpenWaiting[0] = newKey;
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
// A dashboard task's question carries its askId (#599 ⑤): a new ask is a new
// form, even when it reads the same — picks for one ask never carry to the next.
function mcFormId(s, q) {
  return 'mc|' + s.key + '|' + (q.askId ? 'a|' + q.askId + '|' : '')
    + JSON.stringify([q.title || q.question || '', (q.questions || []).map(function(x) { return [x.id, x.question]; })]);
}
// The ask a form was drawn for (#637 R2): an action from a form whose ask is no
// longer the session's (a push the panel has not painted yet) answers nothing.
function mcAskShown(el, q) {
  return (el.getAttribute('data-mc-ask') || '') === ((q && q.askId) || '');
}
function mcAskChanged(key) {
  dashToast({ title: '\uC9C8\uBB38\uC774 \uBC14\uB00C\uC5C8\uC5B4\uC694 \u2014 \uB2E4\uC2DC \uD655\uC778\uD574\uC8FC\uC138\uC694.', tone: 'error' });
  var s = _sessionCache[key];
  if (s && mcFormEl(key)) renderMultiChoicePanel(s);
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
  // Who may answer here (the session's owner, on this instance — the server re-checks):
  // else the element holds every control and says why (D3-GAPS G3-1, 0.12.0 canAnswer).
  var lock = acQuestionLock(s);
  if (lock) d.canAnswer = lock;
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
  el.setAttribute('data-mc-ask', q.askId || '');
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
function mcOnChange(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-CHOICE-FORM' || !e.detail) return;
  var s = _sessionCache[el.getAttribute('data-mc-key')];
  var q = s && s.pendingQuestion;
  if (!q || !q.questions || !mcAskShown(el, q)) return;
  mcStateOf(s, q).answers = mcAnswersIn(e.detail.answers);
  refreshCard(s.key);
}
function mcOnSubmit(e) {
  var el = e.target;
  if (!el || el.tagName !== 'UI-CHOICE-FORM' || !e.detail) return;
  var key = el.getAttribute('data-mc-key');
  var s = _sessionCache[key];
  var q = s && s.pendingQuestion;
  if (!q || !q.questions) {
    e.preventDefault();
    return;
  }
  if (!mcAskShown(el, q)) {
    e.preventDefault();
    mcAskChanged(key);
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
}
document.addEventListener('ui-change', mcOnChange);
document.addEventListener('ui-submit', mcOnSubmit);

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
  // A dashboard task's answer names its ask (#599 ⑤); a Slack session's has none.
  var askId = s.pendingQuestion.askId;
  return mcSend(key, url, JSON.stringify(askId ? { selections: sel, askId: askId } : { selections: sel }));
}
// 추천대로 모두 제출 (group-only one-click): the server derives the selections
// from the session, so the request has no body.
function submitAllRecommended(key) {
  var s = _sessionCache[key];
  var askId = s && s.pendingQuestion && s.pendingQuestion.askId;
  // A dashboard task's question names itself (#599 ⑤): its id as JSON. A Slack
  // session's request stays body-less (mcPost sends no Content-Type then).
  var body = askId ? JSON.stringify({ askId: askId }) : undefined;
  return mcSend(key, '/api/dashboard/session/' + encodeURIComponent(key) + '/submit-recommended', body);
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

function markStatsLoading() {
  // Each figure keeps its last value under its loading bar (from: 'last'), so the answer rolls from it.
  ['sessions', 'tokens', 'cost'].forEach(function(k) { setStripFigure(k, _strip[k].value, true); });
  paintStatsStrip();
  _statCards.loading = true;
  paintStatCards();
  paintCharts(_chartDays, true);
}

// A failed load (null) is a dash rather than the previous period's number.
function paintStats(data) {
  var t = data && data.totals;
  setStripFigure('sessions', t ? toNum(t.sessionsCreated) : null, false);
  paintStatsStrip();
  _statCards = {
    turns: t ? toNum(t.turnsUsed) : null,
    prs: t ? toNum(t.prsCreated) : null,
    merged: t ? toNum(t.prsMerged) : null,
    loading: false,
  };
  fillStatSlot('stat-merge-lines', 'lines', t ? '+' + toNum(t.mergeLinesAdded) + ' / -' + toNum(t.mergeLinesDeleted) : '');
  var wfEntries = Object.entries((t && t.workflowCounts) || {}).sort(function(a, b) { return toNum(b[1]) - toNum(a[1]); });
  fillStatSlot('stat-workflows', 'wf', wfEntries.map(function(e) { return '<span>' + esc(e[0] === 'default' ? '기본' : e[0]) + ': <b>' + toNum(e[1]) + '</b></span>'; }).join(''));
  paintStatCards();
  _chartDays = data ? (Array.isArray(data.days) ? data.days : []) : null;
  paintCharts(_chartDays, false);
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
  setStripFigure('tokens', t ? toNum(t.totalInputTokens) + toNum(t.totalOutputTokens) : null, false);
  setStripFigure('cost', t ? toNum(t.totalCostUsd) : null, false);
  paintStatsStrip();
}

// ── Charts — @2lab.ai/ui <ui-bar-chart> (B-08) ──
// The page hands each chart the period's days (stats.days: date 'YYYY-MM-DD' + the day's totals); the element
// scales the axis, thins the x labels, says each bar ("10월 5일: 세션 12") and shows the value in its tooltip.
// Loading keeps the last bars dimmed (skeleton bars before the first); a failed load says so in the plot.
var _chartDays = []; // the last answer's days; null = the load failed
var CHARTS = [
  { id: 'chart-sessions', title: '세션', unit: '세션', value: function(d) { return toNum(d.sessionsCreated); } },
  { id: 'chart-merge', title: '코드 변경 (머지)', unit: '변경 줄', value: function(d) { return toNum(d.mergeLinesAdded) + toNum(d.mergeLinesDeleted); } },
];
function chartDayTitle(date) {
  var m = /^[0-9]{4}-([0-9]{2})-([0-9]{2})/.exec(date);
  return m ? Number(m[1]) + '월 ' + Number(m[2]) + '일' : date;
}
function chartData(c, days, loading) {
  return {
    title: c.title,
    unit: c.unit,
    bars: (days || []).map(function(d) {
      var date = String(d.date || '');
      return { key: date, label: String(Number(date.slice(8)) || date), title: chartDayTitle(date), value: c.value(d) };
    }),
    empty: days ? '이 기간에 데이터가 없습니다' : '통계를 불러오지 못했어요',
    loading: !!loading,
  };
}
function paintCharts(days, loading) {
  CHARTS.forEach(function(c) {
    var el = document.getElementById(c.id);
    if (el) el.data = chartData(c, days, loading);
  });
}

// ── Build skew (2026-10-31) ──
// A tab outlives the server that served it: after a deploy its socket reconnects and its poll goes on, so the new
// server's data meets this page's old script — on a dev deployment a goal's 10/10 decision arrived as a waiting card this
// script's predecessor could not draw ("Waiting for you", no choices). The socket's hello and every board poll name
// the server's build (dashboardBuildId); on another build the tab reloads, or — holding something unsent — says a
// new version is out and reloads when asked. Once per server build: a page still skewed after its reload (a proxy
// that served the old page again) asks instead of looping.
var _buildSkewToast = ''; // the server build the 새 버전 toast was shown for
var _recording = []; // composers recording a voice note now (ui-record start … stop / cancel / error)
document.addEventListener('ui-record', function(e) {
  var i = _recording.indexOf(e.target);
  if (e.detail && e.detail.state === 'start') {
    if (i < 0) _recording.push(e.target);
  } else if (i >= 0) {
    _recording.splice(i, 1);
  }
});
function buildSkewed(serverBuild) {
  return !!PAGE_BUILD && !!serverBuild && String(serverBuild) !== PAGE_BUILD;
}
// What a reload would throw away: the panel composer (text or files), an open dialog (new task, lifecycle …), a
// filled field — in the page or in an element's open shadow root (a choice form's typed answer before Enter, a
// queued note being edited). A closed dialog's fields are not unsent: the lifecycle form keeps the saved policy
// there, the new task keeps its draft in localStorage (review round 2, fable P2/P3).
function hasUnsentInput() {
  // A note on its way out — its files being read (_pcSending), its POST not answered yet (_pcInFlight) …
  if (_pcSending || _pcInFlight > 0) return true;
  // … a voice note being recorded, a note whose send failed (its row offers Retry; the text is only there) …
  // (a composer swapped out mid-recording is cancelled after it left the page — its event never reaches us)
  _recording = _recording.filter(function(el) { return el && el.isConnected !== false; });
  if (_recording.length) return true;
  for (var fr in _pcFailed) return true;
  // … a new task being launched (its dialog may already be closed), an answer on its way (an approval card sending) …
  if (_ntBusy) return true;
  for (var ak in _acState) {
    for (var aid in _acState[ak]) if (_acState[ak][aid] && _acState[ak][aid].status === 'sending') return true;
  }
  // … a multi-question form with answers picked but not yet submitted (kept per session, across panel switches) …
  for (var mk in _mcState) {
    var mst = _mcState[mk];
    if (mst && mst.answers && Object.keys(mst.answers).length && !mst.sent) return true;
  }
  var c = document.getElementById('pc-composer');
  if (c && (String(c.value || '').trim() || (c.files && c.files.length))) return true;
  // The new task's draft keeps its text (when localStorage took it), not its files: with the dialog closed, its
  // files count, and so does text the saved draft does not hold.
  var nt = document.getElementById('nt-composer');
  if (nt && nt.files && nt.files.length) return true;
  var ntText = nt ? String(nt.value || '').trim() : '';
  if (ntText && ntText !== ntSavedPrompt()) return true;
  var dialogs = document.querySelectorAll('ui-dialog, dialog');
  for (var d = 0; d < dialogs.length; d++) if (dialogs[d].open) return true;
  return filledField(document, 0);
}
function ntSavedPrompt() {
  try {
    var d = JSON.parse(localStorage.getItem(NT_DRAFT_KEY) || 'null');
    return d && typeof d.prompt === 'string' ? d.prompt.trim() : '';
  } catch (e) {
    return '';
  }
}
function inClosedDialog(el) {
  var d = el && el.closest ? el.closest('ui-dialog, dialog') : null;
  return !!(d && !d.open);
}
function filledField(root, depth) {
  var fields = root.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea');
  for (var j = 0; j < fields.length; j++) {
    if (!inClosedDialog(fields[j]) && String(fields[j].value || '').trim()) return true;
  }
  if (depth > 4) return false;
  var all = root.querySelectorAll('*');
  for (var k = 0; k < all.length; k++) {
    if (all[k].shadowRoot && !inClosedDialog(all[k]) && filledField(all[k].shadowRoot, depth + 1)) return true;
  }
  return false;
}
// Reload for this server build unless this tab already reloaded for it lately (the last 3 builds — two builds
// answering in turn behind one origin stop after two reloads); false when it did, or cannot remember.
function buildReload(serverBuild) {
  var b = String(serverBuild);
  try {
    var seen = JSON.parse(sessionStorage.getItem('soma-dash-build-reload') || '[]');
    if (!Array.isArray(seen)) seen = [];
    if (seen.indexOf(b) >= 0) return false;
    seen.push(b);
    sessionStorage.setItem('soma-dash-build-reload', JSON.stringify(seen.slice(-3)));
  } catch (e) {
    return false;
  }
  location.reload();
  return true;
}
// true when the tab is reloading (the caller stops: this script must not draw the new build's data).
function onServerBuild(serverBuild) {
  if (!buildSkewed(serverBuild)) return false;
  var b = String(serverBuild);
  if (!hasUnsentInput() && buildReload(b)) return true;
  if (_buildSkewToast === b) return false;
  _buildSkewToast = b;
  dashToast(
    {
      id: 'build-skew',
      title: '대시보드 새 버전이 나왔어요',
      description: '새로고침해야 최신 화면과 응답 선택지가 보여요. 쓰던 내용을 보낸 뒤 새로고침하세요.',
      tone: 'warning',
      duration: 0,
      action: { id: 'reload', label: '새로고침' },
    },
    function() { location.reload(); },
  );
  return false;
}

// ── WebSocket ──
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws/dashboard');

  // The app bar's status (role=status, polite): a tone dot and a word; the dot pulses while live.
  ws.onopen = function() {
    _appBarStatus = { tone: 'done', label: STRINGS.wsLive, live: true, description: STRINGS.wsAbout };
    paintAppBar();
    // Reconnect: recover the work-log entries broadcast while we were offline
    // (from the HTTP cursor; afterSeq=0 when the log was still empty).
    if (panelOpen && _wl) recoverWorkLog();
    // Admin approvals that arrived or ended while we were offline.
    if (_viewerIsAdmin && _viewerUserId) adminInboxLoad();
  };
  ws.onclose = function() {
    _appBarStatus = { tone: 'wait', label: STRINGS.wsReconnecting, live: true, description: STRINGS.wsAbout };
    paintAppBar();
    setTimeout(connectWs, 3000);
  };
  ws.onerror = function() { ws.close(); };
  ws.onmessage = function(ev) {
    try {
      const msg = JSON.parse(ev.data);
      // The server's build, first on every connection (build skew).
      if (msg.type === 'hello') {
        onServerBuild(msg.build);
        return;
      }
      if (msg.type === 'admin_approvals') {
        _adminPushSeq++;
        applyAdminApprovals(msg.snapshot);
        return;
      }
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
          renderPanelQuestion(msg.session); // the form shows the ask its actions answer (#637 R2)
          var pt2 = document.getElementById('panel-title');
          if (pt2) pt2.textContent = msg.session.displayHeadline || msg.session.summaryTitle || msg.session.title || '제목 없음';
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

  // Breakdown: only when there is one (≥2 envs in the cache). For the single-instance / empty-env case
  // 토큰 stays a plain figure (no tooltip, no tab stop). It becomes <ui-stat-strip>'s breakdown on the
  // 토큰 figure (B-04): a card tooltip with the title and a label · value list in the figure's format.
  // Runs on every board render (renderBoard) and stats load — it repaints the strip only on a change.
  var envNames = Object.keys(byEnv).filter(function(n) { return n.length > 0; });
  var next = null;
  if (envNames.length >= 2) {
    // Stable order: sort so the same env always renders in the same position.
    envNames.sort();
    var rows = envNames.map(function(n) { return { label: n, value: byEnv[n].tokens }; });
    rows.push({ label: '합계', value: totalTokens });
    next = { title: '보드 세션 기준', rows: rows };
  }
  if (JSON.stringify(next) === JSON.stringify(_tokenBreakdown)) return;
  _tokenBreakdown = next;
  paintStatsStrip();
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
    return { status: 'error', error: String((err && (err.message || err.name)) || STRINGS.error) };
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
    var card = wlCardData(st, seq);
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
// Pure: a task group's ledger meta — the element's quiet line under the head's
// title (D3-GAPS G2-2, 0.12.0 WorkGroup.meta): how the task ended (its time
// when done, the fate word else — a running one says so, no live clock in a
// head), and 툴 N회 once it ran. The words are the task list's (renderTaskMeta).
function wlTaskMeta(t) {
  var started = Number(t.startedAt) || 0;
  var completed = Number(t.completedAt) || 0;
  var removed = Number(t.removedAt) || 0;
  var fate = taskFateOf(t);
  var parts = [];
  if (fate === 'done') {
    var took = started && completed ? formatDuration(completed - started) || '0s' : '';
    parts.push(took ? took + ' 만에 완료' : TASK_FATE_LABEL.done);
  } else if (fate === 'active' || fate === 'paused' || fate === 'dropped' || fate === 'skipped') {
    parts.push(TASK_FATE_LABEL[fate] + (fate === 'dropped' && started && removed > started ? ' ' + formatDuration(removed - started) : ''));
  }
  // SSOT 2026-10-29 T5: a count shared by tasks that ran together is fractional — a whole number on screen.
  if (fate !== 'pending' && fate !== 'skipped') parts.push({ label: '툴', value: Math.round(toNum(t.toolCalls)) + '회' });
  return parts;
}
// Open state of a task group: the reader's choice (the element's ui-toggle, kept
// across repaints and tab switches), else open when it is the newest task
// group at first sight. (A run outside any task has no head to fold: headless.)
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
// first entry, titled by the ledger (else its latest entry's title) with the
// ledger's meta under it; the entries outside a task (the instruction that
// starts a turn, the response that ends it) in runs, each a headless group in
// line — no head, always shown (D3-GAPS G2-2, 0.12.0). A folded task group is
// handed its count, not its entries: a long log's DOM stays the size of what
// is open — and the element's scroller never holds the reader's place on rows
// clipped inside a folded group (D3-GAPS G2-1).
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
    if (!r.taskId) {
      out.headless = true;
      out.entries = r.list.map(function(e) { return wlEntryOf(st, e); });
      return out;
    }
    var task = wlTaskInfo(r.taskId);
    out.ref = '#' + r.taskId;
    out.title = (task && task.content) || r.title || '';
    if (task) out.meta = wlTaskMeta(task);
    out.open = wlGroupOpen(st, r.id, r.id === newest);
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
    // The card is a row on the log's arrow path: the element sets its head-tabindex
    // (one tab stop across rows and cards — D3-GAPS G2-3, 0.12.0).
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
function wlCardData(state, key) {
  var carrier = wlEntryBySeq(state, key);
  if (!carrier) return null;
  var call = carrier.kind === 'tool' ? carrier : null;
  var res = call ? wlPairsOf(state).resultOf[call.seq] || null : carrier;
  var tool = String((call && call.tool) || (res && res.tool) || '');
  var status = res ? (res.ok === false ? 'error' : 'success') : wlCallLive(state, call) ? 'running' : 'interrupted';
  var d = { name: tool || '툴', status: status, open: !!(state.open && state.open.has(key)) };
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
  var keys = ['name', 'summary', 'status', 'open', 'at', 'duration', 'loading', 'note', 'detailError', 'error'];
  var out = [];
  for (var i = 0; i < keys.length; i++) out.push(d[keys[i]]);
  out.push(d.args === undefined ? -1 : 1, d.result === undefined ? -1 : 1, rev || 0);
  return JSON.stringify(out);
}
function wlPaintCard(state, el) {
  if (!el || !state) return;
  var key = Math.floor(Number(el.getAttribute('data-key')) || 0);
  var d = wlCardData(state, key);
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
      var under = _panelLand === 'goal' ? 0 : panelTabsHeight();
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
  var top = 0;
  if (secs && body) {
    var base = scrollEl.getBoundingClientRect().top - scrollEl.scrollTop;
    top = psecLandingTop(secs.getBoundingClientRect().top - base, body.getBoundingClientRect().bottom - base, scrollEl.clientHeight, panelTabsHeight());
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
  var under = _panelLand === 'goal' ? 0 : panelTabsHeight();
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
// An opening asked for before <ui-drawer> is defined (a deep link or a fast first click on a cold load: the
// drawer's module is one of the last): its arguments, opened once the element is — one wait, the latest asked.
var _panelOpenWaiting = null;
function openPanel(sessionKey, focusWorkLog, agentId, byKey) {
  var drawerEl = document.getElementById('slide-panel');
  if (drawerEl && typeof drawerEl.show !== 'function' && typeof customElements !== 'undefined') {
    var waiting = _panelOpenWaiting;
    _panelOpenWaiting = [sessionKey, focusWorkLog, agentId, byKey];
    if (!waiting) {
      customElements.whenDefined('ui-drawer').then(function() {
        var args = _panelOpenWaiting;
        _panelOpenWaiting = null;
        if (args) openPanel(args[0], args[1], args[2], args[3]);
      });
    }
    return;
  }
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

  // A card switch starts the composer clean: a fresh <ui-agent-steering> with a
  // fresh composer (the old one's text, files, notes in flight and failed sends
  // were that session's). A send still in flight completes in the background
  // without touching this card. Re-landing on the session already open (관리 →,
  // 전체 task →, a tree item) keeps the message being typed and a send in flight
  // (spec 13).
  var sameSession = panelOpen && panelSessionKey === sessionKey;
  if (!sameSession) {
    pcFreshSteer();
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
  document.getElementById('panel-title').textContent = s.displayHeadline || s.summaryTitle || s.title || '제목 없음';

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


  // The drawer opens here (D4 E-01: a closed <dialog> has no layout — the sections below are sized and
  // the landing scrolled on the open one; its slide-in starts after this task, the content painted). Docked
  // (≥840px) the open drawer narrows the board: animate that shift too. A card switch keeps it open.
  var panel = document.getElementById('slide-panel');
  layoutBeforeChange();
  panel.show();
  panelOpen = true;
  panel.setAttribute('label', document.getElementById('panel-title').textContent);
  syncPanelWidth();

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
  // An opening still waiting for <ui-drawer> was for this card: it is dropped with it (D4 review P3).
  if (_panelOpenWaiting && _panelOpenWaiting[0] === key) _panelOpenWaiting = null;
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
// opens that card, which repaints this with the new front. The peek strip above the header
// (<ui-deck-nav peek="only">) draws the edges of the cards behind from the same data.
function renderDeckNav(dir) {
  _deck = _deck.filter(function(k) { return !!_sessionCache[k]; });
  var panel = document.getElementById('slide-panel');
  var nav = document.getElementById('panel-deck');
  var peek = document.getElementById('panel-deck-peek');
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
      if (peek) peek.data = data;
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
  if (_panelLand === 'goal') t = goalCardFocusTarget() || document.getElementById('panel-goal');
  else if (_panelLand === 'agent') t = document.querySelector('#panel-agents .pa-focus');
  else if (_panelLand === 'tasks') t = document.getElementById('panel-tasks');
  // The 작업 로그 tab is <ui-tabs>' own (D4 E-24): its selected tab — the one this opening chose — takes focus.
  else if (_panelLand === 'worklog' && uiTabsFocus(document.getElementById('panel-sections'))) return;
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
    return { kind: 'goal', label: n ? '목표 #' + n[1] + '/' + n[2] : '목표', line: reason ? '직전 평가: ' + sysOneLine(reason, 90) : '목표 자동 계속', raw: raw, facts: gf };
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
  if (c.trigger) f.push(['SDK 트리거', c.trigger]);
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
      + '<span class="skill-name">' + esc(skills[i].name) + '</span><span class="skill-tok">≈' + formatTokens(skills[i].tokens) + ' 토큰</span></button>';
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
  return '<div class="skill-detail-h"><span class="skill-name">' + esc(sk.name) + '</span><span class="skill-tok">≈' + formatTokens(sk.tokens) + ' 토큰 (추정)</span></div>'
    + '<pre class="skill-body">' + esc(sk.body) + '</pre>';
}

// SSOT 2026-10-29 T8: the answers' name — the Slack bot that runs the session
// (its card's botName — a sibling instance's own bot), else this instance's.
function botNameOf(s) {
  return (s && s.botName) || BOT_NAME || '어시스턴트';
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
// Pure: the turn's summary — the heading of an answer that is empty or failed, and Raw's 요약 view: its title
// and body; else that it is still being made; else that it failed (summary.error, the alert mark) with the
// element's Retry (summary.canRetry → ui-retry { id, what: 'summary' } → convResummarize; G-04) when the turn
// can be asked for again — or, once asked (c.resum), that the retry is on its way until the next poll brings
// the summary.
function convSummaryOf(t, c) {
  var title = t && t.summaryTitle ? String(t.summaryTitle) : '';
  var out = {};
  if (title) out.title = title;
  if (t && t.summaryBody) out.text = String(t.summaryBody);
  else if (!(t && t.summarized)) out.text = STRINGS.summaryPending;
  else {
    var askable = !!(c && c.cid && t.id);
    if (askable && c.resum && c.resum[resumKey(c.cid, t.id)]) out.text = STRINGS.retrying;
    else {
      out.error = STRINGS.summaryFailed;
      if (askable) out.canRetry = true;
    }
  }
  return out;
}
// Pure: a turn soma-work put there (sysTurnInfo) as the element's system turn —
// its badge (kind + label), one line, the facts and the raw prompt. A /compact
// still running (the latest turn of a working session, younger than a
// compaction can run) carries its progress; once done, its numbers. No name:
// a turn's own name wins over the element's words, so the element says its
// own 시스템 (lang="ko") — D8.
function convSysTurn(t, info, id, at, c, notLast) {
  var x = { id: id, role: 'system', kind: info.kind === 'bgwork' ? 'background' : info.kind, label: info.label, text: info.line };
  if (at) x.at = at;
  var facts = info.facts;
  if (info.kind === 'compact') {
    var st = cpState(t, c.now, notLast);
    if (st.phase === 'live' && !c.working) st.phase = 'unknown';
    facts = facts.concat(cpFacts(st));
    if (st.phase === 'live') x.progress = { startedAt: st.start, estimateMs: st.est, verb: '압축 중…' };
    else x.text = cpDoneText(info, st);
  }
  if (facts.length) x.facts = facts.map(function(f) { return [String(f[0]), String(f[1])]; });
  if (info.raw) x.raw = String(info.raw);
  return x;
}
// Pure: the element's turns for the main agent's turns (oldest first), and the
// slotted children they ask for — the files a turn carried (media-<id>: a
// person's above their words; a system turn's — the message an auto-compact
// intercepted — in its open detail) and the files an answer produced
// (attachments-<id>: an artifact goes to the first answer whose turn window
// holds its turn start). c: { cid, bot, now, working, answers (cache key → raw),
// failed (cache key → why), arts, titles, resum (summary retries asked for) }.
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
      var u;
      if (sys) u = convSysTurn(t, sys, id, at, c, i < list.length - 1);
      else {
        var said = splitInvokedSkills(decodeSlackEntities(t.rawContent || ''));
        u = { id: id, role: 'user', name: String(t.userName || '사용자'), text: said.text };
        if (at) u.at = at;
        if (said.skills.length) u.skills = said.skills.map(function(sk) { return { name: sk.name, tokens: sk.tokens, text: sk.body }; });
      }
      if (atts.length) {
        u.media = true;
        slots.push({ name: 'media-' + id, kind: 'media', list: atts, turn: t });
      }
      turns.push(u);
    } else {
      var a = { id: id, role: 'assistant', name: c.bot };
      if (at) a.at = at;
      var sum = convSummaryOf(t, c);
      if (sum.title || sum.text || sum.error) a.summary = sum;
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
// 요약 실패 · 다시 시도 (G-04): the element's Retry on a turn's summary (Raw's 요약 view) asks the server to
// summarize the turn again (POST …/resummarize/:turnId, the page's CSRF token, one retry after a refresh). While
// the request is out, and until the next poll brings the summary, the view reads 다시 시도 중…; a refused request
// puts the Retry back. A subagent's turns carry no summary: only the main agent's conversation asks.
var _resumSent = Object.create(null); // resumKey → the resummarize asked for (until the summary lands)
function resumKey(cid, turnId) {
  return cid + '|' + turnId;
}
function convResummarize(id) {
  if (_panelAgent || id === null || id === undefined || id === '') return;
  var cid = _panelTurnsCid || panelConvId || '';
  if (cid) resummarize(cid, String(id));
}
async function resummarize(convId, turnId) {
  var key = resumKey(convId, turnId);
  if (_resumSent[key]) return;
  _resumSent[key] = true;
  convPaint();
  var url = '/api/dashboard/session/' + encodeURIComponent(convId) + '/resummarize/' + encodeURIComponent(turnId);
  var ok = false;
  try {
    var res = await fetch(url, { method: 'POST', headers: _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {} });
    if (res.status === 403) {
      await refreshCsrfToken();
      res = await fetch(url, { method: 'POST', headers: _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {} });
    }
    ok = res.ok;
  } catch (_e) {}
  if (!ok) {
    delete _resumSent[key];
    convPaint();
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
    answers: _rawLoadedCache, failed: _ansFailed, resum: _resumSent,
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
// The element's scroll viewport (<ui-conversation> → <ui-log-scroller> → .ls-vp, open shadow roots), or null.
function convViewport(el) {
  var sc = el && el.shadowRoot ? el.shadowRoot.querySelector('ui-log-scroller') : null;
  return (sc && sc.shadowRoot && sc.shadowRoot.querySelector('.ls-vp')) || null;
}
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
  // The box that clips the turns is the element's own viewport (inside <ui-log-scroller>'s shadow
  // root): the 800px lead counts against it, not the page. A new viewport starts a new observer.
  var vp = convViewport(el);
  if (_ansIo && _ansIo._root !== vp) {
    _ansIo.disconnect();
    _ansIo._nodes.forEach(function(n) { n._ansWatched = false; });
    _ansIo = null;
  }
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
      }, vp ? { root: vp, rootMargin: '800px 0px' } : { rootMargin: '800px 0px' });
      _ansIo._nodes = [];
      _ansIo._root = vp;
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
      _ansFailed[key] = String((err && (err.message || err.name)) || STRINGS.error);
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
  // Try again on an answer or the list (convRetry), or on a turn's summary (what: 'summary' — G-04).
  el.addEventListener('ui-retry', function(e) {
    var d = e.detail || {};
    if (d.what === 'summary') convResummarize(d.id);
    else convRetry(d.id);
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
  // An opening still waiting for the element is dropped; a drawer not yet defined has nothing open to close.
  _panelOpenWaiting = null;
  var drawerEl = document.getElementById('slide-panel');
  if (drawerEl && typeof drawerEl.hide === 'function') drawerEl.hide();
  panelOpen = false;
  panelSessionKey = null;
  panelConvId = null;
  // The 산출물 part is written through writePanelPart (nothing when unchanged): emptied here, it forgets what it
  // last wrote too, so the same card reopened paints its strip again (D4 K-06 review).
  var panelArts = document.getElementById('panel-artifacts');
  if (panelArts) { panelArts.innerHTML = ''; panelArts._html = ''; panelArts.style.display = 'none'; }
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
  // Escape in the artifact viewer closes the viewer only (its dialog's own).
  // The cron drawer opens over a docked panel: Escape closes only that, the topmost. An element on top that
  // took the key (the drawer, the defaults menu, a dialog: preventDefault) keeps it from the panel too.
  if (e.key === 'Escape' && !e.defaultPrevented && panelOpen && !artViewerIsOpen() && !_cronDrawerKey) closeDetailCard();
});
// Esc inside the drawer and a press on its scrim arrive as <ui-drawer>'s cancelable ui-close (D4 E-01, E-02): the
// page closes the detail card itself (the card folds, the deck moves on — closeDetailCard, as the panel's own ✕).
(function initPanelDrawer() {
  var d = document.getElementById('slide-panel');
  if (d) d.addEventListener('ui-close', function(e) { e.preventDefault(); closeDetailCard(); });
})();

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
// (<ui-agent-steering> ui-submit: text, ref, and the slotted composer's files) — to
// the session's command route, the one path a dashboard instruction takes: while a
// turn runs the server queues it (and steers it into that turn when it can — the
// host decides, so ⌘/Ctrl+Enter goes the same way), idle it starts the next turn.
// The element shows the note at once (running: as a row until the queue lists it);
// idle, the turn shows in the transcript. A voice note being recorded is filed by
// the composer before the note leaves (#488). A send that cannot go out puts the
// text and files back; one the server refuses is marked failed on its row (Retry,
// which re-emits the ref without files: they are kept by ref) and said in a toast.
var _pcNoteFiles = Object.create(null); // a note's ref → its File list, until it went out
async function sendCommand(text, ref, files) {
  var el = document.getElementById('cmd-steer');
  if (!panelSessionKey || !el) return;
  // Capture the session this send belongs to — before any wait: an instruction
  // is never sent to a card opened meanwhile.
  const sendingSessionKey = panelSessionKey;
  var running = !!(el.data && el.data.running);
  var msg = String(text || '').trim();
  var list = files && files.length ? Array.prototype.slice.call(files) : (ref && _pcNoteFiles[ref]) || [];
  if (ref && list.length) _pcNoteFiles[ref] = list;
  var attachments;
  _pcSending = true;
  try {
    if (!pcCanSend(msg, list)) { pcGiveBack(el, ref, msg, sendingSessionKey); return; }
    // Every file read in full (base64, as the command route takes them).
    try {
      attachments = await Promise.all(list.map(ntReadFile));
    } catch (readErr) {
      dashToast({ title: '파일을 읽지 못했어요', description: String((readErr && readErr.message) || '').slice(5), tone: 'error' });
      pcGiveBack(el, ref, msg, sendingSessionKey);
      return;
    }
  } finally {
    _pcSending = false;
  }
  // The card changed while the files were read: this instruction was for the other one.
  if (panelSessionKey !== sendingSessionKey) return;

  // Optimistic, idle only: the turn this starts shows in the transcript at once
  // (its files by name — the recorded turn brings their previews). A note sent
  // while a turn runs shows in the queue instead.
  var optimisticId = '';
  if (!running) {
    const shown = msg + (list.length ? (msg ? '\\n' : '') + '📎 ' + list.map(function(f) { return f.name; }).join(', ') : '');
    _lastSentContent = msg;
    _lastSentTime = Date.now();
    optimisticId = 'optimistic-' + Date.now();
    appendTurnToPanel({
      id: optimisticId,
      role: 'user',
      timestamp: Date.now(),
      userName: '나',
      rawContent: shown,
      origin: { by: 'user' },
      _optimistic: true,
    }, true);
  }

  var why = '';
  _pcInFlight++; // until the server answered: a reload now would drop a note the composer no longer holds
  try {
    const cmdUrl = '/api/dashboard/session/' + encodeURIComponent(sendingSessionKey) + '/command';
    const res = await acPost(cmdUrl, JSON.stringify(pcCommandBody(msg, attachments)));
    if (!res.ok) {
      var data = {};
      try { data = await res.json(); } catch (_e) {}
      why = ((data && data.error) || '') + ' (HTTP ' + res.status + ')';
    }
  } catch (e) {
    why = (e && e.message) || '네트워크 오류';
  } finally {
    _pcInFlight--;
  }
  // Sent: its files went with it. Failed: they stay kept by ref for the Retry.
  if (!why && ref) {
    delete _pcNoteFiles[ref];
    delete _pcFailed[ref];
  }
  // Only the card that sent it changes: a late answer never touches the card opened meanwhile.
  if (panelSessionKey !== sendingSessionKey) return;
  // The session left the board meanwhile (archived, a folded day): fail closed. The next live
  // render that finds it again re-applies its real state (the mode cache is cleared).
  if (!_sessionCache[sendingSessionKey]) {
    var cmdHost = document.getElementById('panel-command');
    if (cmdHost) {
      cmdHost._mode = '';
      cmdHost._takesFiles = false;
    }
    el._sig = '';
    el.data = Object.assign({}, el.data, { disabled: true });
  }
  if (!why) return;
  // Not sent: the note's row says so with Retry (the element's), and the
  // optimistic turn leaves the transcript — found by its own id, not by being the
  // list's last child (the 응답 작성 중 row may follow it, re-ai-answer D12).
  if (optimisticId) dropTurnFromPanel(optimisticId);
  if (ref) {
    el.setItemState(ref, 'failed', why.trim());
    _pcFailed[ref] = true;
  }
  dashToast({ title: '메시지를 보내지 못했어요', description: why.trim(), tone: 'error' });
}
// A note that did not go out at all (a file that could not be read): its row goes
// and its text and files return to the composer — unless the user has typed or
// attached something new there, or moved to another card.
function pcGiveBack(el, ref, msg, key) {
  var files = (ref && _pcNoteFiles[ref]) || [];
  if (ref) { delete _pcNoteFiles[ref]; delete _pcFailed[ref]; el.setItemState(ref, 'cancelled'); }
  if (panelSessionKey !== key) return;
  if (msg && !el.value) el.value = msg;
  var c = document.getElementById('pc-composer');
  if (files.length && c && typeof c.addFiles === 'function' && !c.files.length) c.addFiles(files);
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
// Every run state has its own glyph — colour is never the only signal (T5): the icon set's check / cross / dot /
// alert / dashed circle (the row's leading glyph), in the kit row's tone (done / fail / run / wait, none for an
// entry that is not a run of its own). The slots are literals so the page fills them with the library's glyphs.
var CRON_RUN_GLYPHS = { check: '<i data-ui-icon="check"></i>', cross: '<i data-ui-icon="cross"></i>', dot: '<i data-ui-icon="dot"></i>', alert: '<i data-ui-icon="alert"></i>', 'circle-dashed': '<i data-ui-icon="circle-dashed"></i>' };
function cronRunGlyph(run) {
  // A queue entry is an event, not a state: the drain that follows is not
  // recorded, and the thread's current activity is not this entry's run.
  if (run && run.status === 'queued') return { tone: '', glyph: 'circle-dashed', label: '대기열에 넣음 (세션 사용 중 — 이후 실행 결과는 기록 없음)' };
  // A recorded failure stands even if the thread still reads as busy.
  if (run && run.status === 'failed') return { tone: 'fail', glyph: 'cross', label: '실패' };
  var s = run && run.session;
  if (s && s.live && s.activityState === 'waiting') return { tone: 'wait', glyph: 'alert', label: '응답 필요' };
  if (s && s.live && s.activityState === 'working') return { tone: 'run', glyph: 'dot', label: '실행 중' };
  if (run && run.status === 'unrecorded') return { tone: '', glyph: 'circle-dashed', label: '실행 기록 없음 (보드 카드만 있음)' };
  if (run && run.executionPath === 'dm') return { tone: '', glyph: 'circle-dashed', label: 'DM 전송 (세션 없음)' };
  if (run && run.executionPath === 'thread_reply') return { tone: '', glyph: 'circle-dashed', label: '스레드 답글 (세션 없음)' };
  return { tone: 'done', glyph: 'check', label: '성공' };
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
// A run as the element reads it, by the strip's rule (cronRunGlyph, its tone): done → ok · run → running ·
// wait → waiting · fail → failed · no tone → unknown (a queue entry, a card with no record, a DM or a thread
// reply), the glyph's words as its label. A card with no record yet is not one of the
// job's kept records (recorded: false), so it never counts toward historyCap.
var CRON_AQ_STATUS = { done: 'ok', run: 'running', wait: 'waiting', fail: 'failed' };
function cronRunAsAq(r) {
  var gl = cronRunGlyph(r);
  var out = { at: r.executedAt, status: CRON_AQ_STATUS[gl.tone] || 'unknown', label: gl.label };
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
  // A kit row (.ui-row): the state's glyph in its tone, the title, the facts, an error as a fail status line,
  // the actions at the end. The state's word rides along for screen readers when the title is not it.
  return '<li class="ui-row"' + (gl.tone ? ' data-tone="' + gl.tone + '"' : '') + '>'
    + CRON_RUN_GLYPHS[gl.glyph]
    + '<div><strong>' + esc(title) + '</strong>'
    + (title === gl.label ? '' : '<span class="ui-sr-only">' + esc(gl.label) + '</span>')
    + '<small>' + bits.join('<span aria-hidden="true"> · </span>') + '</small>'
    + (run.error ? '<span class="ui-status-line" data-tone="fail">' + esc(run.error) + '</span>' : '')
    + '</div>'
    + (actions.length ? '<div class="is-end">' + actions.join('') + '</div>' : '')
    + '</li>';
}
function renderCronDrawerMeta(g, nowMs) {
  var j = g.job;
  if (!j) return '<p class="ui-notice">이 인스턴스에 없는 잡입니다 — 삭제됐거나 다른 인스턴스의 잡이라 스케줄·실행 기록이 없습니다. 보드에 있는 실행만 보입니다.</p>';
  // The kit's fact list (.ui-dl). Values are markup (escaped here): 다음 실행 counts down live like the tile (#444 review R1).
  var rows = [
    ['스케줄', esc(cronScheduleLabel(j.expression, j.nextRunAt) + ' · ' + j.expression + ' (UTC)')],
    ['다음 실행', j.nextRunAt ? esc(capClockLabel(j.nextRunAt / 1000, nowMs)) + ' (' + aqTime(j.nextRunAt, nowMs, ' 후') + ')' : '8일 안에 없음'],
    ['실행 방식', esc((j.mode === 'fastlane' ? '항상 새 스레드' : '세션이 쉬면 주입, 없으면 새 스레드') + ' · 출력 ' + j.target + ' · 모델 ' + j.model)],
    ['실행 기록', esc('잡마다 최근 ' + (j.historyCap || 20) + '회까지 보관')],
  ];
  return '<dl class="ui-dl">' + rows.map(function(r) { return '<div><dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd></div>'; }).join('') + '</dl>';
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
  document.getElementById('cron-drawer-badge').innerHTML = CLOCK_SVG + 'CRON';
  document.getElementById('cron-drawer-meta').innerHTML = renderCronDrawerMeta(g, now);
  document.getElementById('cron-drawer-body').innerHTML = runs.length
    ? '<ol>' + runs.map(function(r) { return renderCronRunRow(r, g, now); }).join('') + '</ol>'
    : '<p class="ui-empty">아직 실행 기록이 없습니다</p>';
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
// The sheet is a modal <dialog>: the page stays inert until its exit ends, so focus can land only after that.
function cronDrawerShut(d) {
  var dlg = d && d.shadowRoot ? d.shadowRoot.querySelector('dialog') : null;
  return !dlg || !dlg.open;
}
// after() runs once focus is back (opening the run's panel records the lane control as its return target).
function closeCronDrawer(after) {
  _cronDrawerKey = null;
  var d = document.getElementById('cron-drawer');
  if (!d) { if (after) after(); return; }
  if (typeof d.hide === 'function') d.hide();
  var back = _cronDrawerReturnFocus;
  _cronDrawerReturnFocus = null;
  var since = Date.now();
  (function land() {
    if (!cronDrawerShut(d) && Date.now() - since < 1000) { requestAnimationFrame(land); return; }
    // Back to the control that opened it, or its twin a lane render put in its place meanwhile.
    var to = back && back.el;
    if (to && !to.isConnected && back.host && back.key && back.host.shadowRoot) {
      var same = back.host.shadowRoot.querySelectorAll('[data-key]');
      to = null;
      for (var i = 0; i < same.length && !to; i++) if (same[i].getAttribute('data-key') === back.key) to = same[i];
    }
    if (to && to.isConnected && typeof to.focus === 'function') to.focus();
    if (after) after();
  })();
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
  if (open) { var k = open.getAttribute('data-cron-open'); closeCronDrawer(function() { openPanel(k); }); }
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
// view; the element draws the folded chips, the bars, the disclosure line, the account marks
// and their card, the 7-day timeline, ticks every countdown, and speaks a pool's change.
var CAP_TIERS = { 'claude-max-5x': { short: 'x5', label: 'Max x5' }, 'claude-max-20x': { short: 'x20', label: 'Max x20' }, 'chatgpt-pro-200': { short: '$200', label: 'Pro ($200)' }, 'chatgpt-pro-500': { short: '$500', label: 'Pro ($500)' } };
var _capacityView = null;

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
// a peek in <ui-hovercard #art-peek>; click → <ui-artifact-viewer #art-viewer>.
// Every render function here is pure; the DOM work sits in the functions after
// artPeekItem and in initArtifactInteractions.
var ART_KIND_LABEL = { image: '이미지', audio: '오디오', video: '비디오', html: 'HTML', markdown: '답변', pdf: 'PDF', text: '텍스트', file: '파일' };
var _artCache = Object.create(null); // conversationId → { state: 'loading'|'ok'|'error', list, promise }
var _artDocCache = Object.create(null); // 'cid|id' → text of a markdown / text artifact; 'cid|id|head' → its first 64 KB (the peek)
var _artDocPending = Object.create(null); // the same keys → the one fetch under way (two askers, one request)
var _artViewer = { cid: null, scope: 'conversation', list: [] }; // what the open viewer pages through

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

// A non-image attachment: a <ui-file-card> (a row; a name chip in the compact row) that plays a voice note in place.
function umTile(cid, a, compact) {
  return '<div class="um-file art-k-' + escAttr(a.kind || 'file') + (a.stored ? '' : ' is-remote') + (compact ? ' um-file-compact' : '') + '">'
    + artCard(cid, a, compact ? 'chip' : 'row', true) + '</div>';
}
// The pictures of one instruction: @2lab.ai/ui <ui-media-grid> (D7 I-09 / I-11), keyed by the conversation and the
// stored image ids (data-um); it gets its items once it is in the document (mgHydrate — the markup is static per
// render, so equal data still renders equal strings). Four tiles, "+N" on the last; one picture alone in a wide
// box; size="compact" in the open card's 지시 row and the pinned row.
function umGridHtml(cid, imgs, compact) {
  return '<ui-media-grid class="um-grid" lang="ko"' + (compact ? ' size="compact"' : '') + ' max="' + UM_GRID_MAX + '" data-art-cid="' + escAttr(cid) + '" data-um="' + escAttr(imgs.map(function(a) { return a.id; }).join(',')) + '"></ui-media-grid>';
}
// The grid's items: the pictures it names, as the element reads them (id, name, url — the media route; alt when
// the file carries one), in the viewer's shape so the same list opens it.
function umGridItems(cid, ids) {
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var a = umGet(cid, ids[i]);
    if (!a) continue;
    var item = { id: String(a.id), name: String(a.name || ''), url: umUrl(cid, a.id) };
    if (a.alt) item.alt = String(a.alt);
    out.push(item);
  }
  return out;
}
function mgHydrate(el) {
  if (!el || !el.getAttribute) return;
  var cid = el.getAttribute('data-art-cid') || '';
  var ids = String(el.getAttribute('data-um') || '').split(',').filter(Boolean);
  var items = umGridItems(cid, ids);
  var sig = JSON.stringify(items);
  if (el._mgSig === sig) return;
  el._mgSig = sig;
  el.data = { items: items };
}

// The files of one instruction: images first as the grid (one image on its own in a wide box), then the other
// files as cards. opts.compact: the open card's 지시 row and the pinned row — small tiles, name-only chips.
function renderUserMedia(cid, list, opts) {
  var items = (list || []).filter(function(a) { return a && a.id; });
  if (!cid || !items.length) return '';
  var compact = !!(opts && opts.compact);
  var imgs = [];
  var files = [];
  items.forEach(function(a) { (a.kind === 'image' && a.stored ? imgs : files).push(a); });
  var html = '';
  if (imgs.length) html += umGridHtml(cid, imgs, compact);
  if (files.length) {
    html += '<div class="um-files">' + files.map(function(a) { return umTile(cid, a, compact); }).join('') + '</div>';
  }
  return '<div class="um-media' + (compact ? ' um-compact' : '') + '">' + html + '</div>';
}

// Why a user's file has no copy here, in the viewer.
function umMissingReason(a) {
  if (a.unavailable === 'too_large') return '50 MB를 넘어 봇이 받지 못한 파일입니다. Slack에서 열 수 있습니다.';
  if (a.unavailable === 'download_failed') return '봇이 이 파일을 내려받지 못했습니다. Slack에서 열 수 있습니다.';
  return '이 파일은 대시보드에 사본이 없습니다. Slack에서 열 수 있습니다.';
}

// Pinned row of the panel: "지시 첨부 N" — a <ui-disclosure> (D4 K-06) collapsed by default so it costs one
// line; opened, the session's files in a compact strip in its region (painted while open — keep: through
// the fold). Nothing when none.
function renderPanelUserMedia(list, cid, open, keep) {
  if (!cid || !list || !list.length) return '';
  var head = '<ui-disclosure class="panel-um-dc" flush' + (open ? ' open' : '') + '>'
    + '<span slot="summary" class="panel-um-head"><i data-ui-icon="attach" class="art-glyph"></i>'
    + '<span>지시 첨부</span><span class="art-count">' + list.length + '</span>'
    + '<span class="panel-arts-hint">유저가 지시와 함께 보낸 파일</span></span>';
  return head + (open || keep ? '<div class="panel-um-body" id="panel-um-body">' + renderUserMedia(cid, list, { compact: true }) + '</div>' : '') + '</ui-disclosure>';
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

// A file as @2lab.ai/ui <ui-file-card> (D2 I-01..I-03): the page renders the element keyed by data-art-cid /
// data-art-id, with data-art-v (what it shows) so a re-render that changes the file re-hands it; initFileCards
// gives it artFileItem. Its ui-open opens the viewer; the hovercard's for= reaches it for the peek; playable: a
// play / pause toggle on audio (and video tiles), one clip at a time.
function artFileItem(cid, a) {
  var item = { id: String(a.id), name: String(a.name || ''), kind: a.kind || 'file' };
  if (toNum(a.size) > 0) item.size = toNum(a.size);
  if (toNum(a.createdAt) > 0) item.time = toNum(a.createdAt);
  if (a.stored) item.url = artUrl(cid, a.id);
  else item.meta = 'Slack에만 있음';
  return item;
}
function artCard(cid, a, variant, playable) {
  var v = [a.name, a.kind, toNum(a.size), toNum(a.createdAt), a.stored ? 1 : 0].join('|');
  return '<ui-file-card class="art-card" variant="' + variant + '"' + (playable ? ' playable' : '') + ' lang="ko" data-art-cid="' + escAttr(cid) + '" data-art-id="' + escAttr(a.id)
    + '" data-art-v="' + escAttr(v) + '"></ui-file-card>';
}
// One chip (an answer turn's files).
function artChip(cid, a) {
  return artCard(cid, a, 'chip');
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

// A strip tile: the file card (thumbnail, name, meta; a play / pause toggle on audio — T8 — and video tiles, one
// clip at a time across the page: playable); variant 'chip' in the panel's minimal row.
function artTile(cid, a, variant) {
  return '<div class="art-tile' + (a.stored ? '' : ' is-remote') + '">' + artCard(cid, a, variant || 'tile', true) + '</div>';
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
function renderPanelArtifacts(list, cid, variant) {
  var sorted = artSortForDisplay(list);
  if (!sorted.length || !cid) return '';
  return '<div class="panel-arts-head"><span>산출물</span><span class="art-count">' + sorted.length + '</span>'
    + '<span class="panel-arts-hint">올리면 미리보기 · 누르면 크게</span></div>'
    + '<div class="art-strip art-strip-panel">' + sorted.map(function(a) { return artTile(cid, a, variant); }).join('') + '</div>';
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

// A markdown / text answer with a copy here: the viewer draws the document, the peek its head.
function artIsDoc(a) {
  return !!(a && a.stored && (a.kind === 'markdown' || a.kind === 'text'));
}

// Hover peek (T2): the card @2lab.ai/ui <ui-hovercard id="art-peek"> shows for one file is the library's own
// (peekHtml, 0.12.0): the file as the viewer pages it (artViewItem — the model's HTML runs its scripts in the peek's
// frame too, a user's upload never; media never autoplays) plus a document's head (items[].head: the whole text once
// the viewer fetched it, else the first 64 KB artDocHead brought in) under the kind's tint ([data-kind]).
function artPeekItem(cid, a) {
  var item = artViewItem(cid, a);
  if (item.text == null && artIsDoc(a)) {
    var head = _artDocCache[cid + '|' + a.id + '|head'];
    if (head != null) item.head = head;
  }
  return item;
}
function artPeekHtml(item, peek) {
  return '<div class="art-peek" data-kind="' + escAttr(peek.kind(item)) + '">' + peek.html(item, 'ko') + '</div>';
}

// ── Artifact DOM: fetch, settle, the peek and the viewer ──

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
  // The open viewer pages through the conversation's files: the new list is handed over (the element keeps showing
  // the same file wherever it moved). An instruction's attachments (umSiblings) are not this list.
  if (_artViewer.cid === cid && _artViewer.scope === 'conversation' && artViewerIsOpen()) {
    _artViewer.list = artSortForDisplay((_artCache[cid] && _artCache[cid].list) || []);
    artViewerEl().data = { items: artViewerItems(cid, _artViewer.list) };
  }
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
  var umHtml = cid ? renderPanelUserMedia(_umList[cid] || [], cid, _umPanelOpen === true, _umPanelOpen === 'folding') : '';
  var html = cid ? (umHtml ? '<div class="panel-user-media" id="panel-user-media">' + umHtml + '</div>' : '') + renderPanelArtifacts(list, cid, artPanelVariant()) : '';
  // Morphed (D4 K-06): the 지시 첨부 disclosure keeps its node across a repaint, so its open grows in place.
  writePanelPart(el, html);
  el.style.display = html ? '' : 'none';
  // The files each answer produced go under it (convTurnsOf: an artifact goes to
  // the first answer whose turn window holds its turn start).
  convPaint();
}

// The panel's strip is a row of name chips in the minimal view (자세히 off) or on a short panel body (≤ 560px:
// landscape phones, a docked drawer under a tall top bar), else thumbnails — the file card's variant.
var ART_PANEL_SHORT_PX = 560;
function artPanelVariant() {
  var body = document.querySelector('#slide-panel .panel-body');
  var h = body ? body.clientHeight : 0;
  return !_panelDetail || (h > 0 && h <= ART_PANEL_SHORT_PX) ? 'chip' : 'tile';
}
function syncPanelArtVariant() {
  var v = artPanelVariant();
  var cards = document.querySelectorAll('#panel-artifacts .art-strip-panel ui-file-card');
  for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('variant') !== v) cards[i].setAttribute('variant', v);
}

// ── The peek (I-05) is @2lab.ai/ui <ui-hovercard id="art-peek">: one card for every tile — the board's face chips
// (inside <ui-agent-inbox>), the open card's and the panel's <ui-file-card>s, an answer's chips, a user's
// attachments. The element owns the hover intent, the grace, the quick swap, keyboard focus, Esc, a press, the
// scroll-away and the placement; the page fills it on ui-open and empties it on ui-closed.

// The file a peek trigger stands for: a keyed card (data-art-cid + data-art-id), a tile in a <ui-media-grid>
// (.mg-tile[data-mk] in the grid's shadow root — the grid carries the conversation, the tile its file id), or a
// face chip (data-key="art:<session key>:<file id>" in the inbox's shadow root — the conversation is that session's).
function artPeekTarget(t) {
  if (!t || !t.getAttribute) return null;
  var cid = t.getAttribute('data-art-cid');
  var id = t.getAttribute('data-art-id');
  if (!cid && t.hasAttribute('data-mk') && t.classList.contains('mg-tile')) {
    var root = t.getRootNode && t.getRootNode();
    var grid = root && root.host;
    cid = grid && grid.getAttribute ? grid.getAttribute('data-art-cid') : null;
    id = String(t.getAttribute('data-mk') || '');
  }
  if (!cid && t.hasAttribute('data-art')) {
    id = String(t.getAttribute('data-art') || '');
    var key = String(t.getAttribute('data-key') || '');
    var tail = ':' + id;
    var sk = id && key.indexOf('art:') === 0 && key.slice(-tail.length) === tail ? key.slice(4, key.length - tail.length) : '';
    var s = sk ? _sessionCache[sk] : null;
    cid = s ? s.conversationId : null;
  }
  if (!cid || !id) return null;
  var a = artFind(cid, id);
  return a ? { cid: cid, a: a } : null;
}

// ui-open: the card is filled for this trigger (or refused: a file the page does not know, or the library's peek
// not yet reached); a document without its head in hand gets it fetched and the card refilled — while it still
// shows that file (the element's trigger).
function onArtPeekOpen(e) {
  var hit = artPeekTarget(e.detail && e.detail.trigger);
  var peek = window.uiPeek;
  if (!hit || !peek) { e.preventDefault(); return; }
  var card = e.target;
  var item = artPeekItem(hit.cid, hit.a);
  card.innerHTML = artPeekHtml(item, peek);
  if (!artIsDoc(hit.a) || item.text != null || item.head != null) return;
  artDocHead(hit.cid, hit.a.id)
    .then(function() {
      var now = artPeekTarget(card.trigger);
      if (now && now.cid === hit.cid && now.a.id === hit.a.id) card.innerHTML = artPeekHtml(artPeekItem(hit.cid, hit.a), peek);
    })
    .catch(function() {});
}

// ui-closed: the preview goes (a playing clip, the iframe) once the exit has played.
function onArtPeekClosed(e) {
  e.target.innerHTML = '';
}

// A document's text under one key, fetched once however many ask (the fetch under way is handed to the next
// asker — a step back onto the same file, the peek and the viewer at once), kept once it lands (cap chars).
function artDocFetch(key, url, headers, cap) {
  if (_artDocCache[key] != null) return Promise.resolve(_artDocCache[key]);
  if (_artDocPending[key]) return _artDocPending[key];
  var p = fetch(url, headers ? { headers: headers } : undefined)
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function(t) {
      _artDocCache[key] = t.length > cap ? t.slice(0, cap) : t;
      return _artDocCache[key];
    });
  _artDocPending[key] = p;
  var settle = function() { if (_artDocPending[key] === p) delete _artDocPending[key]; };
  p.then(settle, settle);
  return p;
}
// The whole text of a markdown / text artifact for the viewer (2 MB at most).
function artDocText(cid, id) {
  return artDocFetch(cid + '|' + id, artUrl(cid, id), null, 2000000);
}
// Its first 64 KB for the peek (the route serves ranges) — the whole text when that is already here.
function artDocHead(cid, id) {
  var key = cid + '|' + id;
  if (_artDocCache[key] != null) return Promise.resolve(_artDocCache[key]);
  return artDocFetch(key + '|head', artUrl(cid, id), { Range: 'bytes=0-65535' }, 65536);
}

// ── The viewer (I-06, I-07) is @2lab.ai/ui <ui-artifact-viewer id="art-viewer" tiles="none" lang="ko">: no tiles
// of its own — open(items, index, opener) over the page's cards, chips and tiles, paging through the whole
// conversation (files newest first, then answers) or an instruction's attachments. The element draws the kind
// badge, the name and meta, ‹ n / m ›, ← / → / Home / End, the image (zoom), the markdown document, text, audio,
// video and the calm card of a file only Slack has; 새 탭 / 다운로드 from the url, Slack from items[].actions;
// Esc / the scrim / ✕ close it and focus goes back to the opener.
function artViewerEl() {
  return document.getElementById('art-viewer');
}

function artViewerIsOpen() {
  var v = artViewerEl();
  return !!(v && typeof v.index === 'number' && v.index >= 0);
}

// The file as the viewer pages it: the card's item (artFileItem) plus the page's kind word for a final answer, the
// title of a user's attachment, why a file has no copy, the Slack permalink as an action, and a document's text
// once fetched (the element never fetches). The model's HTML runs its scripts in the element's frame (items[].scripts
// — sandboxed, never same-origin; a user's upload never runs); a stored PDF — the page's own route, same origin —
// opens in the browser's viewer (items[].frame). The element escapes every string.
function artViewItem(cid, a) {
  var item = artFileItem(cid, a);
  if (a.source === 'final_answer') item.kindLabel = ART_KIND_LABEL.markdown;
  if (a.stored && a.kind === 'html' && a.source !== 'user_upload') item.scripts = true;
  if (a.stored && a.kind === 'pdf') item.frame = true;
  var notes = [];
  if (a.title && a.title !== a.name) notes.push(String(a.title));
  if (!a.stored) notes.push(a.source === 'user_upload' ? umMissingReason(a) : '이 파일은 대시보드에 사본이 없습니다 (100 MB 초과이거나 업로드 전에 지워졌습니다).');
  if (notes.length) item.meta = notes.join(' · ');
  if (/^https:\\/\\//i.test(String(a.permalink || ''))) item.actions = [{ id: 'slack', label: 'Slack에서 열기', href: String(a.permalink) }];
  var text = _artDocCache[cid + '|' + a.id];
  if ((a.kind === 'markdown' || a.kind === 'text') && a.stored && text != null) item.text = text;
  return item;
}

function artViewerItems(cid, list) {
  return list.map(function(a) { return artViewItem(cid, a); });
}

// Open the viewer at a file, over the conversation's files — or, for a user's attachment, over the files of its
// own instruction (from the pinned 지시 첨부 row: every attachment of the session). A tile's clip stops first; the
// opener (a card, a chip, a tile) takes focus back when the viewer closes.
function openArtifactViewer(cid, id, opener) {
  var v = artViewerEl();
  if (!v || !cid || !id || typeof v.open !== 'function') return;
  var c = _artCache[cid];
  var list = artSortForDisplay((c && c.list) || []);
  var scope = 'conversation';
  if (umGet(cid, id)) {
    scope = 'attachments';
    list = umSiblings(cid, id, !!(opener && opener.closest && opener.closest('#panel-user-media')));
  } else if (!list.some(function(a) { return a.id === id; })) {
    var one = artFind(cid, id);
    if (!one) return;
    list = artSortForDisplay(list.concat([one]));
  }
  pauseArtCards();
  _artViewer = { cid: cid, scope: scope, list: list };
  var at = Math.max(0, list.findIndex(function(a) { return a.id === id; }));
  v.open(artViewerItems(cid, list), at, opener && typeof opener.focus === 'function' ? opener : null);
  if (scope === 'conversation' && (!c || c.state !== 'ok')) ensureArtifacts(cid);
}

// ui-view: the shown file — every body is the element's (items[].scripts / frame); a markdown / text document
// shown before its text is here is fetched (once: artDocFetch keeps the request under way) and the list handed
// back with it.
function syncArtViewer(detail) {
  var v = artViewerEl();
  var cid = _artViewer.cid;
  var a = detail && cid ? _artViewer.list.find(function(x) { return x.id === detail.id; }) : null;
  if (!v || !artIsDoc(a) || _artDocCache[cid + '|' + a.id] != null) return;
  artDocText(cid, a.id)
    .then(function() { if (_artViewer.cid === cid && artViewerIsOpen()) v.data = { items: artViewerItems(cid, _artViewer.list) }; })
    .catch(function() {});
}

// Every <ui-file-card playable> stops: the viewer opens over the page.
function pauseArtCards() {
  var cards = document.querySelectorAll('ui-file-card[playable]');
  for (var i = 0; i < cards.length; i++) if (cards[i].playing && typeof cards[i].pause === 'function') cards[i].pause();
}

// Every <ui-file-card data-art-id> a render puts in the document — the open card (morphed on every push), the
// panel strip, an answer's row — gets its file once it is in, and again when its data-art-v changes; every
// <ui-media-grid data-um> its pictures the same way (again when its ids change).
function fcHydrate(el) {
  if (el && el.localName === 'ui-media-grid') return mgHydrate(el);
  if (!el || !el.getAttribute) return;
  var cid = el.getAttribute('data-art-cid') || '';
  var a = artFind(cid, el.getAttribute('data-art-id') || '');
  if (!a) return;
  var d = artFileItem(cid, a);
  var sig = JSON.stringify(d);
  if (el._fcSig === sig) return;
  el._fcSig = sig;
  el.data = d;
}
var FC_HYDRATE_SEL = 'ui-file-card[data-art-id], ui-media-grid[data-um]';
function fcHydrateIn(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.matches(FC_HYDRATE_SEL)) fcHydrate(node);
  var inner = node.querySelectorAll(FC_HYDRATE_SEL);
  for (var i = 0; i < inner.length; i++) fcHydrate(inner[i]);
}
(function initFileCards() {
  if (typeof MutationObserver !== 'function') return;
  new MutationObserver(function(list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === 'attributes') fcHydrate(m.target);
      else for (var j = 0; j < m.addedNodes.length; j++) fcHydrateIn(m.addedNodes[j]);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-art-v', 'data-um'] });
  fcHydrateIn(document.body);
})();

(function initArtifactInteractions() {
  // <ui-file-card> asks to open its file, <ui-media-grid> one of its pictures (ui-open): the viewer, at it, over the
  // conversation's files; the viewer returns focus to the card / the grid's tile. (The hovercard's ui-open — its
  // detail a trigger — is answered on the card below.)
  document.addEventListener('ui-open', function(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.localName === 'ui-file-card' && t.hasAttribute('data-art-id')) {
      openArtifactViewer(t.getAttribute('data-art-cid'), t.getAttribute('data-art-id'), t);
    } else if (t.localName === 'ui-media-grid' && t.hasAttribute('data-art-cid') && e.detail && e.detail.id) {
      openArtifactViewer(t.getAttribute('data-art-cid'), String(e.detail.id), t);
    }
  });
  // The peek itself (its audio controls excepted): the same viewer.
  document.addEventListener('click', function(e) {
    if (!e.target.closest) return;
    var peek = document.getElementById('art-peek');
    if (peek && e.target.closest('#art-peek .av-pk-media') && !e.target.closest('audio')) {
      var anchor = peek.trigger;
      var hit = artPeekTarget(anchor);
      peek.hide();
      if (hit) openArtifactViewer(hit.cid, hit.a.id, anchor);
    }
  });
  var peek = document.getElementById('art-peek');
  if (peek) {
    peek.addEventListener('ui-open', onArtPeekOpen);
    peek.addEventListener('ui-closed', onArtPeekClosed);
  }
  var viewer = artViewerEl();
  if (viewer) {
    // The shown file (open, a step): a document's text is brought in on ui-view alone — the page slots nothing
    // before a body renders, so the element's earlier notice has nothing for it (and one listener is one fetch).
    viewer.addEventListener('ui-view', function(e) { syncArtViewer(e.detail); });
    // Gone — the person's Esc / scrim / ✕, or the list emptied under it, or the element removed: once the exit has
    // played (ui-closed, every close) the page lets go of what it paged. A list reopened within the exit cancels
    // the close, so the guard only keeps a late notice from an open viewer's list.
    viewer.addEventListener('ui-closed', function() {
      if (!artViewerIsOpen()) _artViewer = { cid: null, scope: 'conversation', list: [] };
    });
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
// <ui-segmented id="view-seg"> (D-02 Board | List): a reader's choice arrives as ui-change — the element has
// already moved its chip; the page follows through.
(function initSegmented() {
  var viewSeg = document.getElementById('view-seg');
  if (viewSeg) viewSeg.addEventListener('ui-change', function(e) { setBoardView(e.detail.value, e); });
})();
// <ui-stat-strip id="stats-strip">: 자세히 starts as the reader left it; a period choice loads that period
// (not cancelled — the strip has already moved its chip); 자세히 is remembered.
(function initStatsStrip() {
  var saved = null;
  try { saved = localStorage.getItem(STATS_DETAIL_KEY); } catch (_e) {}
  _statsDetailOpen = saved === 'open';
  paintStatsStrip();
  paintStatCards();
  var el = document.getElementById('stats-strip');
  if (!el) return;
  el.addEventListener('ui-period', function(e) {
    if (e.detail && e.detail.value) setPeriod(String(e.detail.value));
  });
  el.addEventListener('ui-more', function(e) {
    _statsDetailOpen = !!(e.detail && e.detail.open);
    try { localStorage.setItem(STATS_DETAIL_KEY, _statsDetailOpen ? 'open' : 'closed'); } catch (_e) {}
  });
})();
// <ui-disclosure> (K-06): Raw, a system turn and a card's system instruction (D1), and — D4 — 세션 정보, Tasks,
// 지시 첨부 open and close by themselves (the row, Enter / Space, the grow and the fold, inert while closed; a
// click on the slotted summary's words counts since 0.8.0). The page keeps each choice (_ioOpen, _panelInfoOpen,
// _panelTasksOpen, _umPanelOpen) from the element's cancelable ui-toggle; a region it paints only while open is painted on the way open (so the element grows
// around it) and, as 'folding', kept through the fold until the element's ui-toggled says the region has settled —
// then its nodes go.
(function initDisclosures() {
  document.addEventListener('ui-toggle', function(e) {
    var t = e.target;
    if (!t || !t.classList || t.tagName !== 'UI-DISCLOSURE') return;
    var open = !!(e.detail && e.detail.open);
    if (t.classList.contains('io-sys')) ioSysToggle(t.getAttribute('data-cid') || '', open);
    else if (t.classList.contains('pi-dc')) { _panelInfoOpen = open || 'folding'; if (open) renderPanelInfo(); }
    else if (t.classList.contains('panel-tasks-dc')) { _panelTasksOpen = open || 'folding'; if (open) repaintPanelTasks(); }
    else if (t.classList.contains('panel-um-dc')) { _umPanelOpen = open || 'folding'; if (open) renderPanelArtifactsSection(); }
  });
  document.addEventListener('ui-toggled', function(e) {
    var t = e.target;
    if (!t || !t.classList || t.tagName !== 'UI-DISCLOSURE' || (e.detail && e.detail.open)) return;
    if (t.classList.contains('pi-dc') && _panelInfoOpen === 'folding') { _panelInfoOpen = false; renderPanelInfo(); }
    else if (t.classList.contains('panel-tasks-dc') && _panelTasksOpen === 'folding') { _panelTasksOpen = false; repaintPanelTasks(); }
    else if (t.classList.contains('panel-um-dc') && _umPanelOpen === 'folding') { _umPanelOpen = false; renderPanelArtifactsSection(); }
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
var _ntCtx = null;
var _ntState = null;
var _ntBusy = false;
var _ntRequestId = null;
// The text handed to <ui-composer> (a saved draft at first, '' after a launch): it applies a value only when it
// differs from the last one, so a repaint while someone types never resets the field.
var _ntValue = null;
// The files a dashboard task's dialog refuses (#600 ⑥): no type matches.
var NT_NO_FILES = 'application/x-soma-no-attachments';

// The battery's reading for <ui-meter> (value 0..1, null = unknown — the element draws "?" with no fill) and the words
// of the usage line (the button's title too).
function ntBatteryView(b) {
  if (!b || typeof b.level !== 'number') {
    return { value: null, label: '잔여량 미확인 · 공유 풀 추정' };
  }
  var pct = Math.round(b.level * 100);
  var parts = ['공유 풀 추정 ' + pct + '%'];
  (b.windows || []).forEach(function (w) {
    if (typeof w.remaining === 'number') parts.push(w.label + ' ' + Math.round(w.remaining * 100) + '%');
  });
  if (b.accounts) parts.push('가용 ' + b.accounts.available + '/' + b.accounts.total);
  if (typeof b.best === 'number') parts.push('최대 ' + Math.round(b.best * 100) + '%');
  return { value: b.level, label: parts.join(' · ') };
}

function ntDefaultState(ctx, draft) {
  return {
    model: ctx.defaultModel,
    effort: ctx.defaultEffort,
    channelId: ctx.defaultChannelId || null,
    autogoal: !!ctx.autogoalDefault,
    autoz: false,
    prompt: draft && typeof draft.prompt === 'string' ? draft.prompt : '',
    // #600 ⑥: a Slack channel (the default) or a dashboard task, and its folder by name ('' = a new folder).
    destination: 'slack',
    folder: '',
  };
}

function ntBuildPayload(state, attachments, requestId) {
  if (state.destination === 'task') {
    // A dashboard task (#600 ⑥): no channel, no autogoal / autoz, no attachments (D8);
    // the chosen model's nickname (the server resolves it against the models it
    // offers, #640 R1), and the folder by name ('' = a new folder).
    var body = { requestId: requestId, destination: 'task', prompt: state.prompt };
    if (state.model) body.model = state.model;
    if (state.folder) body.folder = state.folder;
    return body;
  }
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
  if (state && state.destination === 'task') {
    // A task takes no attachments yet (D8): files attached before switching are not dropped silently (#640 R1).
    return String(state.prompt || '').trim().length > 0 && (attachments || []).length === 0;
  }
  if (!state || !state.channelId) return false;
  return String(state.prompt || '').trim().length > 0 || (attachments || []).length > 0;
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
  // A dialog on top (the page's, a <ui-dialog>, the artifact viewer's) keeps the key.
  if (document.querySelector('dialog[open], ui-dialog[open]') || artViewerIsOpen()) return true;
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

function ntSaveDraft(text) {
  try {
    if (text) localStorage.setItem(NT_DRAFT_KEY, JSON.stringify({ prompt: text }));
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
  if (!dlg || dlg.open || typeof dlg.show !== 'function') return;
  document.body.classList.add('nt-open');
  ntSetError('');
  // <ui-dialog> (H-01): show() opens it modal at once — the scrim, the rise, the focus trap, the phone sheet that
  // follows the visual viewport (above the soft keyboard) and the focus return to the opener are the element's.
  dlg.show();
  if (!_ntRequestId) _ntRequestId = ntNewRequestId();
  if (_ntState) ntRender();
  else paintNtComposer();
  if (!ntIsTouch()) {
    setTimeout(function () {
      var c = ntEl('nt-composer');
      if (c && dlg.open) c.focus();
    }, 60);
  }
  ntSetStatus(_ntCtx ? '' : '불러오는 중…');
  await ntLoadContext();
}

// The page closes it (a launched task, the FAB's second press): hide() runs the element's exit (settle out, 180ms;
// a fade under reduced motion) and gives focus back; its ui-closed then lets the page go of what it owns (ntOnClosed).
function closeNewTask() {
  var dlg = ntEl('nt-dialog');
  if (!dlg || !dlg.open || typeof dlg.hide !== 'function') return;
  ntShowFab();
  dlg.hide();
}

// The FAB comes back as the close begins, not after the exit: the element gives focus back just before ui-closed,
// and a FAB still display:none then cannot take it (focus would drop on the body).
function ntShowFab() {
  document.body.classList.remove('nt-open');
}

// The sheet has gone — the person's Esc / scrim / ✕ or the page's closeNewTask, after the exit (the element's
// ui-closed, 0.12.0 — D4 G6-2; a sheet reopened within its exit never sends it): a recording in progress is
// dropped and a preview stops (the FAB is already back: ntShowFab at the close's start).
function ntOnClosed() {
  ntShowFab();
  ntQuietComposer();
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
  ntReconcile(_ntState, _ntCtx);
}

function ntReconcile(state, ctx) {
  // A choice that is no longer offered falls back to the default.
  var hasModel = ctx.models.some(function (m) {
    return m.nickname === state.model;
  });
  if (!hasModel) state.model = ctx.defaultModel;
  if (ctx.efforts.indexOf(state.effort) < 0) state.effort = ctx.defaultEffort;
  var hasChannel = ctx.channels.some(function (c) {
    return c.id === state.channelId;
  });
  if (!hasChannel) state.channelId = ctx.defaultChannelId || null;
  // A dashboard task, or a folder, that is no longer offered (#640 R1).
  if (!ctx.taskFolders) state.destination = 'slack';
  var hasFolder = (ctx.taskFolders || []).some(function (f) {
    return f.name === state.folder;
  });
  if (!hasFolder) state.folder = '';
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
  // #600 ⑥ — where the task goes: offered when the context lists task folders.
  var isTask = _ntState.destination === 'task';
  var dest = ntEl('nt-dest');
  if (dest) dest.hidden = !_ntCtx.taskFolders;
  var dSlack = ntEl('nt-dest-slack');
  var dTask = ntEl('nt-dest-task');
  if (dSlack) dSlack.setAttribute('aria-pressed', isTask ? 'false' : 'true');
  if (dTask) dTask.setAttribute('aria-pressed', isTask ? 'true' : 'false');
  var folderChip = ntEl('nt-folder-chip');
  if (folderChip) folderChip.hidden = !isTask;
  var folderSel = ntEl('nt-folder');
  if (folderSel && isTask) {
    folderSel.innerHTML =
      '<option value="">새 폴더</option>' +
      (_ntCtx.taskFolders || [])
        .map(function (f) {
          return '<option value="' + escAttr(f.name) + '"' + (f.name === _ntState.folder ? ' selected' : '') + '>' + esc(f.name) + '</option>';
        })
        .join('');
  }
  // A dashboard task has no channel, effort or autogoal / autoz (D8). The destination
  // row is an .nt-toggles too: hide the autogoal / autoz row, not it.
  ['.nt-chip-channel', '.nt-chip-effort', '.nt-toggles:not(.nt-dest)'].forEach(function (sel) {
    var el = document.querySelector(sel);
    if (el) el.hidden = isTask;
  });
  var channel = ntEl('nt-channel');
  if (isTask) {
    // A dashboard task has no channel: no channel list, no channel error.
  } else if (_ntCtx.channels.length) {
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
  ntEl('nt-autogoal').checked = !!_ntState.autogoal;
  ntEl('nt-autoz').checked = !!_ntState.autoz;
  ntRenderBattery();
  paintNtComposer();
}

// <ui-composer id="nt-composer">: the instruction field, attachments, voice and 작업 시작. The limits come from the
// context (before it: the element's defaults) — maxTotalBytes is the server's cap on all files together (the
// element rejects the file that crosses it and says so). A plain Enter is a new line, ⌘/Ctrl+Enter starts the task
// (enter: 'newline', with its key hint on desktop); 카메라 is the element's own tool on touch screens (the back
// camera; PC has drop and paste).
function ntComposerData() {
  if (_ntValue === null) {
    var draft = ntReadDraft();
    _ntValue = draft && typeof draft.prompt === 'string' ? draft.prompt : '';
  }
  var d = {
    label: '작업 지시',
    placeholder: '무엇을 할까요? 예) soma-work 대시보드 개선해줘',
    value: _ntValue,
    image: false,
    submitLabel: '작업 시작',
    busy: _ntBusy,
    minRows: 6,
    maxRows: 14,
    enter: 'newline',
    hint: true,
    camera: 'environment',
  };
  // A dashboard task takes no attachments yet (D8, #600 ⑥): no attach / voice /
  // camera tools, and a pasted or dropped file is refused by its type (#640 R2).
  if (_ntState && _ntState.destination === 'task') {
    d.attach = false;
    d.voice = false;
    d.camera = false;
    d.accept = NT_NO_FILES;
  }
  var lim = _ntCtx && _ntCtx.limits;
  if (lim) {
    d.maxLength = lim.maxPromptChars;
    d.maxFiles = lim.maxFiles;
    d.maxFileSize = lim.maxFileBytes;
    d.maxTotalBytes = lim.maxTotalBytes;
  }
  return d;
}
function paintNtComposer() {
  var el = ntEl('nt-composer');
  if (el) el.data = ntComposerData();
}
// Closing the sheet discards a recording in progress and stops a voice note's preview (the text and files stay).
function ntQuietComposer() {
  var el = ntEl('nt-composer');
  if (!el || typeof el.cancelRecording !== 'function') return;
  el.cancelRecording();
  el.pause();
}

function ntRenderBattery() {
  var m = _ntCtx.models.find(function (x) {
    return x.nickname === _ntState.model;
  });
  var v = ntBatteryView(m ? m.battery : null);
  ntEl('nt-battery-btn').title = v.label;
  // The meter: the fill slides to the level and the tone follows the thresholds (good from a half, fair from a fifth).
  ntEl('nt-battery').data = { value: v.value, low: 0.2, high: 0.5, label: '모델 잔여량' };
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
}

// #600 ⑥ — the destination: a Slack channel or a dashboard task (only when offered).
function ntSetDestination(dest) {
  if (!_ntState || !_ntCtx) return;
  _ntState.destination = dest === 'task' && _ntCtx.taskFolders ? 'task' : 'slack';
  ntSetError(ntBlockedHint(_ntState, ntComposerFiles()));
  ntRender();
}

function ntOnFolderChange() {
  _ntState.folder = ntEl('nt-folder').value || '';
}

// The files the dialog's composer holds now.
function ntComposerFiles() {
  var el = ntEl('nt-composer');
  return (el && el.files) || [];
}

// <ui-composer> refused a file: on a dashboard task its accept matches no type, so
// a type refusal is the attachment rule — said as such (merge review P3).
function ntOnReject(e) {
  if (!_ntState || _ntState.destination !== 'task' || !e.detail || e.detail.reason !== 'type') return;
  ntSetError(ntBlockedHint(_ntState, [e.detail.file]));
}

// Why the dialog cannot start what it holds, said before a submit: on the switch,
// and whenever its files change (#640 R2).
function ntBlockedHint(state, attachments) {
  if (state && state.destination === 'task' && (attachments || []).length > 0) {
    return '대시보드 작업은 아직 첨부를 받지 않아요 — 첨부를 빼거나 Slack 채널로 보내 주세요';
  }
  return '';
}

// The kit switch flipped itself; the draft follows it.
function ntToggle(which) {
  if (!_ntState) return;
  var sw = ntEl('nt-' + which);
  _ntState[which] = !!(sw && sw.checked);
  if (navigator.vibrate) {
    try {
      navigator.vibrate(8);
    } catch (e) {}
  }
}

// The composer's files as the request's attachments (base64, as the server takes them).
function ntReadFile(f) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var s = String(reader.result || '');
      var comma = s.indexOf(',');
      resolve({ name: f.name || 'file', mimetype: f.type || 'application/octet-stream', data: comma >= 0 ? s.slice(comma + 1) : '' });
    };
    reader.onerror = function () {
      reject(new Error('read:' + (f.name || 'file')));
    };
    reader.readAsDataURL(f);
  });
}

// ui-submit (cancelled: the page sends, and the composer keeps the text and files until the task is launched).
async function submitNewTask(detail) {
  var el = ntEl('nt-composer');
  if (_ntBusy || !_ntCtx || !_ntState || !el) return;
  var files = (detail && detail.files) || el.files || [];
  _ntState.prompt = detail ? String(detail.text || '') : el.value;
  if (!ntCanSubmit(_ntState, files)) {
    ntSetError(
      _ntState.destination === 'task'
        ? ntBlockedHint(_ntState, files) || '작업 지시를 써 주세요'
        : _ntState.channelId
          ? '작업 지시를 쓰거나 파일을 첨부해 주세요'
          : '작업을 올릴 채널을 골라 주세요',
    );
    return;
  }
  // What was submitted is what is sent: a switch of the destination while the
  // files are read does not change this launch (#640 R2).
  var submitted = Object.assign({}, _ntState);
  _ntBusy = true;
  ntSetError('');
  paintNtComposer();
  try {
    if (files.length) ntSetStatus('첨부 준비 중…');
    var attachments;
    try {
      attachments = submitted.destination === 'task' ? [] : await Promise.all(files.map(ntReadFile));
    } catch (readErr) {
      ntSetStatus('');
      ntSetError(String(readErr.message || '').slice(5) + ' — 파일을 읽지 못했습니다');
      return;
    }
    var body = JSON.stringify(ntBuildPayload(submitted, attachments, _ntRequestId));
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
    ntOnLaunched(data, submitted);
  } catch (e) {
    ntSetStatus('');
    ntSetError('작업을 시작하지 못했습니다 — 네트워크를 확인하고 다시 눌러 주세요 (같은 요청은 두 번 실행되지 않습니다)');
  } finally {
    _ntBusy = false;
    paintNtComposer();
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
      ntSetStatus(_ntState && _ntState.destination === 'task' ? '작업을 만드는 중…' : 'Slack에 작업을 올리는 중…');
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

function ntOnLaunched(data, submitted) {
  // The next task starts clean: a new idempotency key, no text, no files; the
  // channel just used stays selected, a dashboard task stays a dashboard task.
  // A task created but not started keeps its instruction (#640 R1): the text,
  // the folder, the model and the draft.
  _ntRequestId = ntNewRequestId();
  var keep = data.status === 'not-started';
  _ntState = ntStateAfterLaunch(submitted || _ntState, data, _ntCtx);
  if (!keep) {
    var composer = ntEl('nt-composer');
    if (composer && typeof composer.clear === 'function') composer.clear();
    _ntValue = '';
    try {
      localStorage.removeItem(NT_DRAFT_KEY);
    } catch (e) {}
  }
  ntSetStatus('');
  ntRender();
  closeNewTask();
  var channel = data.channel
    ? _ntCtx.channels.find(function (c) {
        return c.id === data.channel;
      })
    : null;
  // A toast on the page's <ui-toaster>: 카드 열기 opens this launch's card
  // (not a later launch's), Slack에서 보기 its thread.
  dashToast(ntLaunchToast(data, channel ? channel.name : null), function () { ntOpenLaunched(data); });
  if (typeof loadSessions === 'function') setTimeout(loadSessions, 800);
}

// What the dialog holds after a launch: a started task starts the next one clean
// (the channel just used stays selected, a dashboard task stays a dashboard task);
// a task created but not started keeps its instruction, folder and model (#640 R1).
function ntStateAfterLaunch(prev, data, ctx) {
  var next = ntDefaultState(ctx, null);
  next.channelId = data.channel || next.channelId;
  if (prev && prev.destination === 'task' && ctx.taskFolders) next.destination = 'task';
  if (prev && data.status === 'not-started') {
    next.prompt = prev.prompt;
    next.folder = prev.folder;
    next.model = prev.model;
  }
  return next;
}

// The launch toast: a Slack launch names its channel and links its thread; a
// dashboard task (#600 ⑥, no channel) opens its card, and one that was created
// but not started says why.
function ntLaunchToast(data, channelName) {
  if (!data.channel) {
    if (data.status === 'not-started') {
      return {
        title: '작업을 만들었지만 아직 시작하지 못했어요',
        description: String(data.reason || '') + ' — 지시는 새 작업 창에 남겨 두었어요',
        tone: 'warning',
        action: { id: 'open', label: '카드 열기' },
        duration: 12000,
      };
    }
    return {
      title: '대시보드 작업을 시작했어요',
      description: '카드에서 진행을 볼 수 있어요',
      tone: 'success',
      action: { id: 'open', label: '카드 열기' },
      duration: 12000,
    };
  }
  var toast = {
    title: data.status === 'running' ? '작업을 시작했어요' : '작업을 접수했어요',
    description: '#' + (channelName || data.channel),
    tone: 'success',
    action: { id: 'open', label: '카드 열기' },
    duration: 12000,
  };
  if (data.permalink) toast.link = { label: 'Slack에서 보기', href: String(data.permalink) };
  return toast;
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

function ntInit() {
  var dlg = ntEl('nt-dialog');
  if (!dlg) return;
  // <ui-dialog>: Esc, the scrim and ✕ ask to close (ui-close) — the element settles out and gives focus back, then
  // says so (ui-closed, after every exit, the page's hide() too): the page lets go of what it owns.
  dlg.addEventListener('ui-close', function (e) {
    // The person's close, once no listener turned it down (emit dispatches synchronously; read it after).
    queueMicrotask(function () {
      if (!e.defaultPrevented) ntShowFab();
    });
  });
  dlg.addEventListener('ui-closed', function () {
    ntOnClosed();
  });
  // <ui-composer id="nt-composer"> (D2 H-05..H-09): it takes drops and pasted screenshots itself (named
  // screenshot-…), records the voice note, opens the phone camera, caps the files (each and together) and sends
  // on ⌘/Ctrl+Enter (enter: 'newline').
  var composer = ntEl('nt-composer');
  composer.addEventListener('ui-input', function (e) {
    var v = e.detail ? String(e.detail.value || '') : '';
    if (_ntState) _ntState.prompt = v;
    ntSaveDraft(v);
  });
  composer.addEventListener('ui-submit', function (e) {
    e.preventDefault();
    submitNewTask(e.detail);
  });
  // A file the task composer refused (no type matches): why, not only "unsupported type".
  composer.addEventListener('ui-reject', ntOnReject);
  // A file added or removed while a dashboard task is chosen: the reason it cannot start, or none (#640 R2).
  composer.addEventListener('ui-files', function (e) {
    if (!_ntState || _ntState.destination !== 'task') return;
    ntSetError(ntBlockedHint(_ntState, (e.detail && e.detail.files) || ntComposerFiles()));
  });
  paintNtComposer();
  // N opens the composer from anywhere outside a text field.
  document.addEventListener('keydown', function (e) {
    var key = String(e.key || '').toLowerCase();
    if (key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && !ntIsTypingTarget(e.target)) {
      e.preventDefault();
      openNewTask();
    }
  });
  // Phones: the floating button folds to the round button (the kit's .is-folded) while scrolling down.
  var fab = ntEl('new-task-fab');
  var lastY = window.scrollY;
  window.addEventListener(
    'scroll',
    function () {
      var y = window.scrollY;
      if (Math.abs(y - lastY) < 8) return;
      fab.classList.toggle('is-folded', y > lastY && y > 80);
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
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  var hint = ntEl('nt-submit-hint');
  if (hint) hint.textContent = isMac ? '⌘↵' : 'Ctrl+↵';
  var nkbd = document.querySelector('#new-task-btn .nt-kbd');
  if (nkbd && ntIsTouch()) nkbd.hidden = true;
}

// ── Drawer geometry (SSOT 2026-10-24) ──
// The drawer follows the visual viewport by itself (<ui-drawer>, D4 E-01: its box ends above the
// on-screen keyboard in both modes — the New task <ui-dialog> does the same). The page only says
// where the sticky top bar ends, so the docked drawer sits under it (--topbar-b → --ui-drawer-top;
// SSOT 2026-10-29 T3 — the bar is always on screen).
function syncTopbarBottom() {
  var bar = document.querySelector('.topbar');
  if (!bar) return;
  var b = Math.max(0, Math.round(bar.getBoundingClientRect().bottom));
  document.documentElement.style.setProperty('--topbar-b', b + 'px');
}
(function initPanelViewport() {
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
// ── Steering composer (task view T1.5; dashboard batch 2; E-30 0.10.0) ──
// The panel's composer is <ui-agent-steering> with a <ui-composer slot="composer">
// as its field: a multiline instruction to the session above its follow-up queue.
// The steering owns the queue, the modes (Enter queues, ⌘/Ctrl+Enter steers) and
// the composer's words and state; the composer owns the field — an IME composition
// (한글) that never sends, a phone's Enter as a line break, its growth — and the
// files: images (pasted, dropped or picked), files and voice notes, their chips,
// the new-task limits and its error line. A note leaves as the steering's ui-submit
// with the composer's File objects; the page reads them as base64 into the command
// body (pcCommandBody), and the server puts them in the session's Slack thread like
// files the user attached there.
var PC_LIMITS = { maxFiles: 10, maxFileBytes: 20971520, maxTotalBytes: 31457280 };
var _pcSending = false; // one send at a time, while its files are read
var _pcInFlight = 0; // notes whose POST has not been answered yet (build skew: they hold a reload)
var _pcFailed = Object.create(null); // refs of notes whose send failed — their row (Retry) holds the only copy
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
// The composer's own data: the limits (the steering sets its placeholder, name and
// off state, and turns its hint off — the steering's key hints stay below it).
// The files a dashboard task's composer refuses (#600 ⑥, #640 R2): no type matches.
var PC_NO_FILES = 'application/x-soma-no-attachments';
function pcComposerData(takesFiles) {
  var d = { maxFiles: PC_LIMITS.maxFiles, maxFileSize: PC_LIMITS.maxFileBytes, maxTotalBytes: PC_LIMITS.maxTotalBytes, minRows: 1, maxRows: 8 };
  // A dashboard task takes no attachments yet (D8): no attach / image / voice
  // tools, and a pasted or dropped file is refused by its type.
  if (takesFiles === false) {
    d.attach = false;
    d.image = false;
    d.voice = false;
    d.accept = PC_NO_FILES;
  }
  return d;
}
// The composer's data with the page's part (re)applied: a session that takes
// files gets the element's defaults back (the task keys are dropped, not kept).
function pcComposerSetup(c, takesFiles) {
  if (!c) return;
  var d = Object.assign({}, c.data || {});
  delete d.attach;
  delete d.image;
  delete d.voice;
  delete d.accept;
  c.data = Object.assign(d, pcComposerData(takesFiles));
}
// A fresh element for another session: what the old one showed — the text being
// typed, its files, notes in flight, a failed send's Retry — was the other
// session's. The listeners sit on #panel-command.
function pcFreshSteer() {
  var old = document.getElementById('cmd-steer');
  if (!old) return;
  var el = document.createElement('ui-agent-steering');
  el.id = 'cmd-steer';
  el.setAttribute('lang', 'ko');
  var c = document.createElement('ui-composer');
  c.id = 'pc-composer';
  c.slot = 'composer';
  c.setAttribute('lang', 'ko');
  pcComposerSetup(c);
  el.appendChild(c);
  old.replaceWith(el);
  _pcFailed = Object.create(null);
  _pcNoteFiles = Object.create(null);
}
// The panel closed, or its session is no longer open to this viewer: no recording
// (discarded) and no files go on; the text stays in the field.
function pcReset() {
  var c = document.getElementById('pc-composer');
  if (!c || typeof c.cancelRecording !== 'function') return;
  c.cancelRecording();
  if (typeof c.pause === 'function') c.pause();
  for (var i = (c.files || []).length - 1; i >= 0; i--) c.removeFile(i);
}
// The element's events reach #panel-command (they bubble and are composed), so they
// keep working when pcFreshSteer swaps the element. The composer takes paste and
// drop itself.
function pcInit() {
  var host = document.getElementById('panel-command');
  if (!host) return;
  pcComposerSetup(document.getElementById('pc-composer'));
  host.addEventListener('ui-reject', pcOnReject);
  host.addEventListener('ui-submit', pcOnSubmit);
  host.addEventListener('ui-promote', function(e) { if (e.detail) steerAct('promote', String(e.detail.id)); });
  host.addEventListener('ui-cancel', function(e) {
    if (!e.detail) return;
    delete _pcNoteFiles[String(e.detail.id)];
    delete _pcFailed[String(e.detail.id)];
    steerAct('cancel', String(e.detail.id));
  });
  host.addEventListener('ui-edit', function(e) { if (e.detail) steerAct('edit', String(e.detail.id), String(e.detail.text || '')); });
}
// The composer refused a file: on a dashboard task's card every type is refused
// (pcComposerData), so say why — the element's own line reads "unsupported type".
function pcOnReject(e) {
  var host = document.getElementById('panel-command');
  if (!host || host._takesFiles !== false || !e.detail || e.detail.reason !== 'type') return;
  dashToast({ title: '\uB300\uC2DC\uBCF4\uB4DC \uC791\uC5C5\uC740 \uC544\uC9C1 \uCCA8\uBD80\uB97C \uBC1B\uC9C0 \uC54A\uC544\uC694', tone: 'error' });
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
  sendCommand(d.text || '', d.ref || '', d.files || []);
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

/**
 * ClaudeHandler - Manages Claude SDK queries
 * Refactored to use SessionRegistry, PromptBuilder, and McpConfigBuilder (Phase 5)
 */

import {
  type HookInput,
  type HookJSONOutput,
  type Options,
  type Query,
  query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { type AgentRunOptions, type AgentStreamEvent, runAgentStream, runOneShotText } from './agent-runtime';
import { buildStreamOptions } from './agent-runtime/claude-code/build-stream-options';
import type { SafetyClassifier } from './agent-runtime/policy/safety-classifier';
import { buildSafetyClassifier } from './agent-runtime/policy/safety-classifier-factory';
import { readUuidList, STEER_SETTLEMENT_SUBTYPE } from './agent-runtime/steer-settlement';
import {
  buildInitialUserMessage,
  buildSteerUserMessage,
  type SteerInput,
  type SteerInterruptReceipt,
  TurnInputChannel,
  type TurnSteeringPort,
} from './agent-runtime/turn-input-channel';
import { ensureTenantKey } from './auth/llmux-tenant-keys';
import { buildQueryEnv } from './auth/query-env-builder';
import { Logger } from './logger';
import type { McpManager } from './mcp-manager';
import { mcpToolGrantStore } from './mcp-tool-grant-store';
import {
  getRequiredLevel,
  levelSatisfies,
  type loadMcpToolPermissions,
  resolveGatedTool,
} from './mcp-tool-permission-config';
import {
  calculateTokenCost,
  hasOneMSuffix,
  isOneMContextUnavailableSignal,
  ONE_M_CONTEXT_UNAVAILABLE_CODE,
} from './metrics/model-registry';
import { BUNDLED_PLUGINS_DIR } from './plugin/bundled';
import type { SdkPluginPath } from './plugin/types';
import type {
  ActivityState,
  ConversationSession,
  SessionLink,
  SessionLinks,
  SessionResourceSnapshot,
  SessionResourceUpdateRequest,
  SessionResourceUpdateResult,
  WorkflowType,
} from './types';

// Bundled local plugins directory (the first-party `zworkflow` plugin = src/local).
// Used as a fallback when no PluginManager is configured, and as the canonical
// path the bundled `zworkflow@soma-work` default resolves to (see plugin/bundled.ts).
const LOCAL_PLUGINS_DIR = BUNDLED_PLUGINS_DIR;

import {
  boundRateLimitDelayMs,
  parseRetryAfterMs,
  textIndicatesRetryableRateLimit,
  textIndicatesUsageLimit,
} from '@soma/common/rate-limit';
import type { ModelCommandContext } from 'somalib/model-commands/types';
import { sendCredentialAlert } from './credential-alert';
import {
  ensureActiveSlotAuth,
  getCredentialStatus,
  NoHealthySlotError,
  type SlotAuthLease,
} from './credentials-manager';
import {
  DISPATCH_OVERLOADED_MAX_RETRIES,
  DISPATCH_RATE_LIMIT_MAX_RETRIES,
  type DispatchRetryDecision,
  decideDispatchRetry,
  sleepWithAbort,
  textIndicatesPromptTooLongContent,
} from './dispatch-recovery';
import { McpConfigBuilder, type SlackContext } from './mcp-config-builder';
import { getAvailablePersonas, PromptBuilder } from './prompt-builder';
import { type CrashRecoveredSession, SessionExpiryCallbacks, SessionRegistry } from './session-registry';
import { getTokenManager } from './token-manager';
import { DEFAULT_SHOW_THINKING, type EffortLevel, userSettingsStore } from './user-settings-store';

/** Heartbeat interval for long-running Claude CLI calls. */
const CLAUDE_LEASE_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Max one-shot dispatch attempts when the active slot returns a usage cap
 * AS CONTENT (the cap notice arrives as a successful assistant message, not
 * a thrown error). Attempt 1 on the original slot, attempt 2 after rotating
 * to a healthy slot.
 */
const DISPATCH_USAGE_LIMIT_MAX_ATTEMPTS = 2;

/**
 * Thrown when a one-shot dispatch (e.g. the goal-completion eval) keeps
 * hitting a usage cap even after rotation. Callers (goal-loop-controller)
 * treat any thrown dispatcher error as a dispatch failure and clear the
 * pending eval — which is the correct outcome here: it stops the cap notice
 * ("You've hit your limit · resets 9pm") from being parsed as the eval's
 * JSON verdict (the original `Unexpected token 'Y', "You've hit"` failure).
 */
class UsageLimitDispatchError extends Error {
  constructor(public readonly capNotice: string) {
    super(`Claude usage limit hit during one-shot dispatch: ${capNotice.slice(0, 200)}`);
    this.name = 'UsageLimitDispatchError';
  }
}

/**
 * Naming/contact hints for a user's llmux client key, so the key is legible in
 * llmux's own admin surfaces. Both fields are optional — an unknown user still
 * gets a key (named by Slack id alone).
 */
function tenantKeyProfile(userId: string): { name?: string; email?: string } {
  const settings = userSettingsStore.getUserSettings(userId);
  return { name: settings?.slackName, email: settings?.email };
}

// Re-export for backward compatibility
export { getAvailablePersonas, SessionExpiryCallbacks };

/**
 * Build the `thinking` option value for a query.
 *
 * Opus 4.7 API default is `display: 'omitted'` — we must explicitly opt in to
 * `'summarized'` to preserve Slack thinking-summary UX (stream-processor.ts:414
 * filters out empty thinking blocks).
 */
export function buildThinkingOption(
  thinkingEnabled: boolean,
  showSummary: boolean = false,
): NonNullable<Options['thinking']> {
  if (!thinkingEnabled) {
    return { type: 'disabled' };
  }
  return { type: 'adaptive', display: showSummary ? 'summarized' : 'omitted' };
}

/**
 * Resolve the effective `showSummary` value for a turn.
 *
 * Precedence matches the rest of the stack (see stream-executor.ts):
 *   session override → per-user default → DEFAULT_SHOW_THINKING.
 *
 * Extracted so that the session-level `%thinking_summary on|off` override is
 * honored when building the `thinking` option for the SDK.
 */
export function resolveShowSummary(
  sessionShowThinking: boolean | undefined,
  userShowThinking: boolean | undefined,
): boolean {
  return sessionShowThinking ?? userShowThinking ?? DEFAULT_SHOW_THINKING;
}

/**
 * Issue #661 — Convert SDK "1M context unavailable" error MESSAGES into a throw.
 *
 * The Claude Agent SDK (≥ 0.2.111) does NOT throw when the account lacks 1M
 * entitlement; it emits a regular `assistant` message with
 * `isApiErrorMessage: true` and a text block carrying one of three stable
 * signals (see `isOneMContextUnavailableSignal`). Downstream
 * `stream-executor.handleError` already knows how to auto-fallback in its
 * error path, so the simplest flow is: detect the message in the
 * `for-await` loop, convert it to a thrown Error with
 * `code = 'ONE_M_CONTEXT_UNAVAILABLE'` + `attemptedModel`, and let the
 * existing catch block re-throw it upward.
 *
 * Gate conditions (all must hold to throw):
 *   - `model` is defined AND has the `[1m]` suffix
 *   - message is an assistant message with `isApiErrorMessage: true`
 *   - extracted text matches `isOneMContextUnavailableSignal`
 *
 * Without the `[1m]` suffix gate, a bare-model API error containing the same
 * text (extremely rare, but possible if the user manually passes a 1m header)
 * would be misrouted into the fallback branch — see test case 2 below.
 *
 * Exported for direct unit testing (streamQuery's credential/MCP setup makes
 * end-to-end mocking impractical). streamQuery's hot path is:
 *   ```
 *   for await (const message of query(...)) {
 *     maybeThrowOneMUnavailable(message, options.model);
 *     // ... normal handling ...
 *     yield message;
 *   }
 *   ```
 */
export function maybeThrowOneMUnavailable(message: SDKMessage, model: string | undefined): void {
  if (!model || !hasOneMSuffix(model)) return;
  if (message.type !== 'assistant') return;
  // `isApiErrorMessage` is an optional runtime flag on the SDK assistant
  // message — not in the SDKMessage TS type. Cast once.
  const msg = message as unknown as { isApiErrorMessage?: boolean; message?: { content?: unknown[] } };
  if (msg.isApiErrorMessage !== true) return;

  const content = Array.isArray(msg.message?.content) ? msg.message!.content : [];
  const text = content
    .filter((c): c is { type: string; text?: unknown } => !!c && typeof c === 'object' && (c as any).type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n');
  if (!isOneMContextUnavailableSignal(text)) return;

  const err = new Error(text || 'Claude 1M context unavailable for this account.');
  (err as any).code = ONE_M_CONTEXT_UNAVAILABLE_CODE;
  (err as any).attemptedModel = model;
  throw err;
}

/**
 * Classification result for an incoming chunk of Claude Code CLI stderr.
 *
 * `'silent'` means the wiring must skip the logger entirely — used for the
 * post-abort hook_callback Stream-closed cosmetic frame (see
 * `classifyClaudeStderr`). `reason` is set only when `level !== 'warn'`.
 */
export type ClaudeStderrClassification = {
  level: 'warn' | 'silent';
  reason?: string;
};

/**
 * Cosmetic stderr frame the CLI emits when the SDK ↔ CLI IPC transport
 * tears down while a `hook_callback` control_request (PreCompact /
 * PostCompact / SessionStart / PreToolUse) is still in flight:
 * inputClosed=true → `sendRequest` throws "Stream closed". The `[\s\S]*?`
 * is permissive about bun-formatted source-context lines that wedge
 * between the header and the tail.
 *
 * Fired identically on both explicit user-abort AND healthy turn-end (the
 * SDK closes its half of the IPC as part of `query()` cleanup). PR #928's
 * original "gate on aborted" missed the turn-end case — see PR #999.
 */
const HOOK_CALLBACK_STREAM_CLOSED_PATTERN = /Error in hook callback hook_\d+:[\s\S]*?Stream closed/;

/**
 * Classify a Claude Code CLI stderr chunk for logging.
 *
 * Match the hook_callback Stream-closed signature → `'silent'` (wiring drops
 * the chunk entirely; `stderrBuffer` still sees it for rate-limit extraction
 * on error paths). Everything else → `'warn'`. Real mid-turn transport
 * failures still surface via the query error path
 * (`Error in Claude query` ERROR log) — this stderr frame is purely cosmetic.
 *
 * Exported only for unit testing.
 *
 * History: PR #928 (introduced, info-level when aborted), follow-up flip to
 * silent-when-aborted, PR #999 dropped the aborted gate entirely after
 * healthy-turn-end was found to produce the same frame.
 */
export function classifyClaudeStderr(data: string): ClaudeStderrClassification {
  if (HOOK_CALLBACK_STREAM_CLOSED_PATTERN.test(data)) {
    return {
      level: 'silent',
      reason: 'hook_callback stream-closed (cosmetic SDK transport teardown frame)',
    };
  }
  return { level: 'warn' };
}

/**
 * Minimal logger surface the stderr wiring needs. Lets the chunk handler stay
 * testable without pulling in the full `Logger` class. `streamQuery` passes
 * `this.logger` (which satisfies this shape).
 */
export interface StderrLogger {
  warn(message: string, meta?: unknown): void;
}

/**
 * Wiring used by `streamQuery`'s `options.stderr` callback: apply
 * `classifyClaudeStderr` and dispatch. `'warn'` logs, `'silent'` is dropped
 * (disk-write elimination point — keep it tight).
 *
 * `stderrBuffer` accumulation lives at the caller because it's part of the
 * Claude query's error-recovery pathway, not part of logging policy.
 *
 * Exported so tests can spy on the dispatch directly without rebuilding the
 * full `streamQuery` harness.
 */
export function handleClaudeStderrChunk(logger: StderrLogger, data: string): void {
  if (classifyClaudeStderr(data).level === 'silent') {
    return;
  }
  logger.warn('Claude stderr', { data: data.trimEnd() });
}

/**
 * Compaction Tracking (#617): late-bound factory that returns the 3-hook
 * set for the current query. ClaudeHandler calls this when building the
 * Options.hooks payload — decoupled from concrete `EventRouter` /
 * `SlackApiHelper` types so this module keeps a minimal surface area.
 *
 * Registered by `SlackHandler` after both ClaudeHandler AND EventRouter
 * have been constructed (there is a cyclic dependency otherwise).
 */
export type CompactHookBuilder = (args: { session: ConversationSession; channel: string; threadTs: string }) => {
  PreCompact: (input: HookInput) => Promise<HookJSONOutput>;
  PostCompact: (input: HookInput) => Promise<HookJSONOutput>;
  SessionStart: (input: HookInput) => Promise<HookJSONOutput>;
};

/**
 * Upper bound on the whole steer settlement (interrupt + withdrawals).
 *
 * The settlement runs on the teardown path of every steered turn: the channel
 * is not closed and the generator does not advance until it answers. A control
 * request to a wedged CLI can never answer, so the awaits are raced against
 * this bound and time out into the safe verdict (everything discarded = the
 * host requeues). 2s is ~2 orders of magnitude above a healthy local control
 * round-trip while staying inside a user's patience for the turn to end.
 */
export const STEER_SETTLEMENT_BOUND_MS = 2000;

/**
 * `system`/`init` capability announcing that `interrupt` honours
 * `cancel_queued:true` (sdk.d.ts:5000).
 *
 * The CLI then sweeps every uuid-stamped survivor synchronously with the abort
 * and lists them under `cancelled` (`still_queued` is left empty), which makes
 * the per-uuid `cancelAsyncMessage` loop unnecessary — and closes the race in
 * which a send is dequeued between the receipt and its withdrawal.
 */
const INTERRUPT_CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1';

/**
 * The only `terminal_reason` compatible with "this turn ended normally".
 *
 * `queued_turn_count: 0` means the backlog is empty OR the session is ending
 * and discarded it (sdk.d.ts:4793/4847). The two are indistinguishable from the
 * count alone, so consumption is claimed only on an otherwise-clean result: any
 * other reason (and any error subtype) discards instead, costing a re-run
 * rather than a lost user message.
 */
const HEALTHY_TERMINAL_REASON = 'completed';

/**
 * Did this turn end well enough for "no backlog" to mean "the backlog ran"?
 *
 * Duck-typed on the raw frame: `terminal_reason` is declared on the success
 * result (sdk.d.ts:4850) but absent on older producers, and the settlement must
 * read whatever actually arrived rather than trust a declared shape.
 */
function isHealthyTurnResult(raw: Record<string, unknown>): boolean {
  if (raw.subtype !== 'success' || raw.is_error === true) return false;
  const terminalReason = raw.terminal_reason;
  return terminalReason === undefined || terminalReason === HEALTHY_TERMINAL_REASON;
}

export class ClaudeHandler implements TurnSteeringPort {
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  /**
   * Steering handles of the turns currently in flight, keyed by session.
   *
   * One entry per running `query()`: the `Query` handle carries the control
   * requests (interrupt / cancel_async_message), the channel carries mid-turn
   * user input. Entries are created when the turn's `query()` is built and
   * removed when its generator settles — so a `false`/`undefined` answer from
   * the steering methods means exactly "no turn is running for this session",
   * which is the distinction the host needs to decide queue vs. inject.
   */
  private activeQueries = new Map<string, { query: Query; channel: TurnInputChannel }>();

  // Extracted components
  private sessionRegistry: SessionRegistry;
  private promptBuilder: PromptBuilder;
  private mcpConfigBuilder: McpConfigBuilder;

  // Compaction Tracking (#617): optional hook factory. Set by SlackHandler
  // during bootstrap. Undefined in unit tests / non-Slack callers — SDK
  // compaction then falls back to the stream-executor `compacting` signal
  // path with no thread-side post.
  private compactHookBuilder?: CompactHookBuilder;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.sessionRegistry = new SessionRegistry();
    this.promptBuilder = new PromptBuilder();
    this.mcpConfigBuilder = new McpConfigBuilder(mcpManager);
  }

  /**
   * Register the compact-hook factory. Called once during bootstrap.
   * See `CompactHookBuilder` JSDoc.
   */
  setCompactHookBuilder(builder: CompactHookBuilder): void {
    this.compactHookBuilder = builder;
  }

  /**
   * Resolve effective plugin paths dynamically from PluginManager.
   * Called each time a new session is created so that forceRefresh/rollback
   * changes are immediately reflected without service restart.
   */
  private getEffectivePluginPaths(): SdkPluginPath[] {
    const pm = this.mcpManager.getPluginManager();
    const paths = pm?.getPluginPaths() ?? [];
    // Guarantee the bundled local plugin (zworkflow) is present. When the
    // PluginManager already resolved it (its bundled path == LOCAL_PLUGINS_DIR),
    // the de-dup below keeps it single; otherwise we prepend it.
    const hasLocal = paths.some((p) => p.path === LOCAL_PLUGINS_DIR);
    const merged = hasLocal ? [...paths] : [{ type: 'local' as const, path: LOCAL_PLUGINS_DIR }, ...paths];
    // De-dup by path so the same plugin directory never loads twice (which would
    // register duplicate skill names and break the session).
    const seen = new Set<string>();
    return merged.filter((p) => {
      if (seen.has(p.path)) return false;
      seen.add(p.path);
      return true;
    });
  }

  /**
   * Set agent configurations for the MCP config builder.
   * Trace: docs/current/plans/multi-agent/trace.md, Scenario 4
   */
  setAgentConfigs(configs: Record<string, any>): void {
    this.mcpConfigBuilder.setAgentConfigs(configs);
    this.logger.info('Agent configs set', { agents: Object.keys(configs) });
  }

  // ===== Session Registry Delegation =====

  /** Expose SessionRegistry for CronScheduler integration */
  getSessionRegistry(): SessionRegistry {
    return this.sessionRegistry;
  }

  /**
   * Broadcast-only dashboard refresh — no disk write.
   *
   * Use this instead of `getSessionRegistry().persistAndBroadcast(...)` when
   * mutating runtime-only session fields (`pendingSkillUpload`,
   * `pendingRetryTimer`, etc.) — those are intentionally NOT serialized to
   * disk (see `types.ts` for the runtime-only convention), so the
   * `saveSessions` half of `persistAndBroadcast` is wasted IO.
   */
  broadcastSessionUpdate(): void {
    this.sessionRegistry.broadcastSessionUpdate();
  }

  setExpiryCallbacks(callbacks: SessionExpiryCallbacks): void {
    this.sessionRegistry.setExpiryCallbacks(callbacks);
  }

  getSessionKey(channelId: string, threadTs?: string): string {
    return this.sessionRegistry.getSessionKey(channelId, threadTs);
  }

  getSessionKeyWithUser(userId: string, channelId: string, threadTs?: string): string {
    return this.sessionRegistry.getSessionKeyWithUser(userId, channelId, threadTs);
  }

  getSession(channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessionRegistry.getSession(channelId, threadTs);
  }

  getSessionWithUser(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessionRegistry.getSessionWithUser(userId, channelId, threadTs);
  }

  getSessionByKey(sessionKey: string): ConversationSession | undefined {
    return this.sessionRegistry.getSessionByKey(sessionKey);
  }

  findSessionBySourceThread(channel: string, threadTs: string): ConversationSession | undefined {
    return this.sessionRegistry.findSessionBySourceThread(channel, threadTs);
  }

  getAllSessions(): Map<string, ConversationSession> {
    return this.sessionRegistry.getAllSessions();
  }

  createSession(
    ownerId: string,
    ownerName: string,
    channelId: string,
    threadTs?: string,
    model?: string,
  ): ConversationSession {
    return this.sessionRegistry.createSession(ownerId, ownerName, channelId, threadTs, model);
  }

  setSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    this.sessionRegistry.setSessionTitle(channelId, threadTs, title);
  }

  updateSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    this.sessionRegistry.updateSessionTitle(channelId, threadTs, title);
  }

  /**
   * Record merge code change stats for a PR in this session.
   */
  addMergeStats(
    channelId: string,
    threadTs: string | undefined,
    prNumber: number,
    linesAdded: number,
    linesDeleted: number,
  ): void {
    this.sessionRegistry.addMergeStats(channelId, threadTs, prNumber, linesAdded, linesDeleted);
  }

  /**
   * Mark a session as bot-initiated with its root message ts
   */
  setBotThread(channelId: string, threadTs: string | undefined, rootTs: string): void {
    const session = this.sessionRegistry.getSession(channelId, threadTs);
    if (session) {
      session.threadModel = 'bot-initiated';
      session.threadRootTs = rootTs;
    }
  }

  updateInitiator(channelId: string, threadTs: string | undefined, initiatorId: string, initiatorName: string): void {
    this.sessionRegistry.updateInitiator(channelId, threadTs, initiatorId, initiatorName);
  }

  canInterrupt(channelId: string, threadTs: string | undefined, userId: string): boolean {
    return this.sessionRegistry.canInterrupt(channelId, threadTs, userId);
  }

  terminateSession(sessionKey: string): boolean {
    return this.sessionRegistry.terminateSession(sessionKey);
  }

  clearSessionId(channelId: string, threadTs: string | undefined): void {
    this.sessionRegistry.clearSessionId(channelId, threadTs);
  }

  resetSessionContext(channelId: string, threadTs: string | undefined): boolean {
    return this.sessionRegistry.resetSessionContext(channelId, threadTs);
  }

  // ===== Session Links =====

  setSessionLink(channelId: string, threadTs: string | undefined, link: SessionLink): void {
    this.sessionRegistry.setSessionLink(channelId, threadTs, link);
  }

  setSessionLinks(channelId: string, threadTs: string | undefined, links: SessionLinks): void {
    this.sessionRegistry.setSessionLinks(channelId, threadTs, links);
  }

  getSessionLinks(channelId: string, threadTs?: string): SessionLinks | undefined {
    return this.sessionRegistry.getSessionLinks(channelId, threadTs);
  }

  addSourceWorkingDir(channelId: string, threadTs: string | undefined, dirPath: string): boolean {
    return this.sessionRegistry.addSourceWorkingDir(channelId, threadTs, dirPath);
  }

  getSessionResourceSnapshot(channelId: string, threadTs?: string): SessionResourceSnapshot {
    return this.sessionRegistry.getSessionResourceSnapshot(channelId, threadTs);
  }

  updateSessionResources(
    channelId: string,
    threadTs: string | undefined,
    request: SessionResourceUpdateRequest,
  ): SessionResourceUpdateResult {
    return this.sessionRegistry.updateSessionResources(channelId, threadTs, request);
  }

  refreshSessionActivityByKey(sessionKey: string): boolean {
    return this.sessionRegistry.refreshSessionActivityByKey(sessionKey);
  }

  // ===== Session State Machine =====

  /**
   * @returns `true` if the session was transitioned to MAIN state; `false` if
   *   the session was not found or had already transitioned (e.g., race loss).
   *   Issue #698: forceWorkflow callers check this to detect race-loss and
   *   raise `DispatchAbortError` rather than silently continuing with undefined
   *   workflow state. Pre-#698 callers that ignore the return value still work.
   */
  transitionToMain(channelId: string, threadTs: string | undefined, workflow: WorkflowType, title?: string): boolean {
    return this.sessionRegistry.transitionToMain(channelId, threadTs, workflow, title);
  }

  needsDispatch(channelId: string, threadTs?: string): boolean {
    return this.sessionRegistry.needsDispatch(channelId, threadTs);
  }

  isSleeping(channelId: string, threadTs?: string): boolean {
    return this.sessionRegistry.isSleeping(channelId, threadTs);
  }

  wakeFromSleep(channelId: string, threadTs?: string): boolean {
    return this.sessionRegistry.wakeFromSleep(channelId, threadTs);
  }

  transitionToSleep(channelId: string, threadTs?: string): boolean {
    return this.sessionRegistry.transitionToSleep(channelId, threadTs);
  }

  getSessionWorkflow(channelId: string, threadTs?: string): WorkflowType | undefined {
    return this.sessionRegistry.getSessionWorkflow(channelId, threadTs);
  }

  setActivityState(channelId: string, threadTs: string | undefined, state: ActivityState): void {
    this.sessionRegistry.setActivityState(channelId, threadTs, state);
  }

  setActivityStateByKey(sessionKey: string, state: ActivityState): void {
    this.sessionRegistry.setActivityStateByKey(sessionKey, state);
  }

  getActivityState(channelId: string, threadTs?: string): ActivityState | undefined {
    return this.sessionRegistry.getActivityState(channelId, threadTs);
  }

  async cleanupInactiveSessions(maxAge?: number): Promise<void> {
    return this.sessionRegistry.cleanupInactiveSessions(maxAge);
  }

  saveSessions(): void {
    this.sessionRegistry.saveSessions();
  }

  loadSessions(): number {
    return this.sessionRegistry.loadSessions();
  }

  getCrashRecoveredSessions(): CrashRecoveredSession[] {
    return this.sessionRegistry.getCrashRecoveredSessions();
  }

  clearCrashRecoveredSessions(): void {
    this.sessionRegistry.clearCrashRecoveredSessions();
  }

  // ===== Dispatch One-Shot Query =====

  /** Lazily-built auto-mode safety classifier (guardian). */
  private safetyClassifierCache?: SafetyClassifier;

  /**
   * Build (once) the auto-mode safety classifier, backed by the SAME one-shot
   * dispatch flow used by workflow-dispatch / executive-summary
   * (`dispatchOneShot`). No bespoke API route.
   */
  private getSafetyClassifier(): SafetyClassifier {
    if (!this.safetyClassifierCache) {
      this.safetyClassifierCache = buildSafetyClassifier({
        dispatch: (userMessage, systemPrompt, opts) =>
          this.dispatchOneShot(userMessage, systemPrompt, opts.model, opts.abortController),
      });
    }
    return this.safetyClassifierCache;
  }

  /**
   * One-shot dispatch classification query.
   * Uses Agent SDK with no tools, no session persistence, and maxTurns=1.
   * Reuses the same credential validation as streamQuery.
   */
  async dispatchOneShot(
    userMessage: string,
    dispatchPrompt: string,
    model?: string,
    abortController?: AbortController,
    resumeSessionId?: string,
    cwd?: string,
    effort?: EffortLevel,
  ): Promise<string> {
    // A one-shot dispatch (notably the goal-completion eval) can hit the
    // usage cap exactly like a streaming turn. Claude Code surfaces that cap
    // as a *successful* assistant message ("You've hit your limit · resets
    // 9pm"), NOT a thrown error — so `dispatchOneShotInner` happily returns
    // the cap notice as its result string. The goal evaluator then tried to
    // `JSON.parse` that notice and failed (`Unexpected token 'Y', "You've
    // hit"`). Detect that here, rotate to a healthy slot, and retry on a
    // fresh lease so the eval runs on a working credential.
    //
    // Two further transient classes get the streaming path's recovery ported
    // over (see dispatch-recovery.ts): overloaded/529 → 30s wait + retry
    // (≤ DISPATCH_OVERLOADED_MAX_RETRIES), and prompt-too-long → one retry on
    // the 1M fallback-compact model. Each budget is independent; when all are
    // exhausted the error propagates as before.
    let usageLimitAttempts = 0;
    let overloadedRetries = 0;
    let rateLimitRetries = 0;
    let overflowFallbackUsed = false;
    let effectiveModel = model;
    while (true) {
      // Acquire a lease on the active CCT slot. Held for the lifetime of one
      // Claude CLI dispatch attempt, released in the per-attempt finally.
      let lease: SlotAuthLease | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let pendingRetry: DispatchRetryDecision | null = null;
      try {
        try {
          lease = await ensureActiveSlotAuth(getTokenManager(), 'claude-handler:dispatchOneShot');
        } catch (credErr) {
          if (credErr instanceof NoHealthySlotError) {
            this.logger.error('Claude credentials invalid for dispatch', {
              error: credErr.message,
              status: getCredentialStatus(),
            });
            await sendCredentialAlert(credErr.message);
            throw new Error(
              `Claude credentials missing: ${credErr.message}\n` +
                'Please log in to Claude manually or enable automatic credential restore.',
            );
          }
          throw credErr;
        }

        heartbeatTimer = setInterval(() => {
          lease?.heartbeat().catch((err) => this.logger.debug('lease heartbeat failed', err));
        }, CLAUDE_LEASE_HEARTBEAT_MS);
        if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

        // Build a per-call env map (containing the lease's fresh token) and
        // thread it through to `query()` via `options.env`. This never mutates
        // `process.env`, so concurrent dispatches on different slots are
        // isolated by construction. No llmux tenant key: a one-shot dispatch
        // (classification / goal eval) carries no user identity, so these
        // system dispatches stay on the shared key = legacy tenant.
        const { env } = buildQueryEnv(lease);
        let result: string;
        try {
          result = await this.dispatchOneShotInner(
            userMessage,
            dispatchPrompt,
            env,
            effectiveModel,
            abortController,
            resumeSessionId,
            cwd,
            effort,
          );
          // Prompt-too-long-as-content guard (same field bug class as #1200:
          // the overflow arrives as a successful assistant text turn, nothing
          // throws). Convert the content shape into a thrown error so the
          // recovery classifier below sees it.
          if (textIndicatesPromptTooLongContent(result)) {
            throw new Error(`Prompt is too long (surfaced as dispatch content): ${result.slice(0, 200)}`);
          }
          // Pool-rate-limit-as-content guard. The account-pool gateway rejects
          // with "Request rejected (429) · All N eligible accounts are
          // rate-limited; retry in Ns" as a SUCCESSFUL assistant turn (nothing
          // throws), so `dispatchOneShotInner` returns it verbatim — which the
          // goal-completion eval then tried to `JSON.parse` (the original
          // `Unexpected token 'A', "API Error:"` crash). Convert the content
          // shape into a thrown error so the recovery classifier below waits
          // the advertised window and retries instead of leaking the notice.
          if (textIndicatesRetryableRateLimit(result)) {
            // Parse the "retry in Ns" window from the FULL content and stash it
            // on the thrown error so `decideDispatchRetry` honors it even if
            // the hint sits past the 200-char message preview below.
            const rlErr = new Error(`Claude pool rate-limited (surfaced as dispatch content): ${result.slice(0, 200)}`);
            (rlErr as { poolRateLimitRetryMs?: number }).poolRateLimitRetryMs = boundRateLimitDelayMs(
              parseRetryAfterMs(result),
            );
            throw rlErr;
          }
        } catch (attemptErr) {
          const decision = decideDispatchRetry(attemptErr, {
            overloadedRetries,
            rateLimitRetries,
            overflowFallbackUsed,
            model: effectiveModel,
            aborted: abortController?.signal.aborted ?? false,
          });
          if (decision.kind === 'rethrow') throw attemptErr;
          const errPreview = String((attemptErr as Error)?.message ?? attemptErr).slice(0, 200);
          if (decision.kind === 'overloaded-wait') {
            overloadedRetries++;
            this.logger.warn('DISPATCH: overloaded/529 — retrying after delay', {
              attempt: overloadedRetries,
              maxRetries: DISPATCH_OVERLOADED_MAX_RETRIES,
              delayMs: decision.delayMs,
              error: errPreview,
            });
          } else if (decision.kind === 'rate-limit-wait') {
            rateLimitRetries++;
            this.logger.warn('DISPATCH: pool rate-limited — waiting advertised window before retry', {
              attempt: rateLimitRetries,
              maxRetries: DISPATCH_RATE_LIMIT_MAX_RETRIES,
              delayMs: decision.delayMs,
              error: errPreview,
            });
          } else {
            overflowFallbackUsed = true;
            this.logger.warn('DISPATCH: prompt too long — retrying on 1M fallback model', {
              from: effectiveModel || '(sdk default)',
              fallbackModel: decision.fallbackModel,
              error: errPreview,
            });
            effectiveModel = decision.fallbackModel;
          }
          pendingRetry = decision;
          // Fall through → finally releases the lease, then the loop bottom
          // sleeps (overloaded) and re-enters on a fresh lease.
          result = '';
        }
        if (pendingRetry === null) {
          // Cap-as-content guard. Default (content-safe) detector — never
          // includeTransient here, since the eval/work output could legitimately
          // mention "rate limit" or "429" in prose.
          if (!textIndicatesUsageLimit(result)) {
            return result;
          }

          usageLimitAttempts++;
          const cappedKeyId = lease.keyId;
          this.logger.warn('DISPATCH: usage limit surfaced as content', {
            attempt: usageLimitAttempts,
            maxAttempts: DISPATCH_USAGE_LIMIT_MAX_ATTEMPTS,
            cappedKeyId,
            preview: result.slice(0, 120),
          });

          if (usageLimitAttempts >= DISPATCH_USAGE_LIMIT_MAX_ATTEMPTS) {
            // Out of attempts — surface a typed error so the caller treats this
            // as a dispatch failure rather than parsing the cap notice as a
            // verdict.
            throw new UsageLimitDispatchError(result);
          }

          // Rotate to a healthy slot before the next attempt. CAS-guard on the
          // capped slot so concurrent dispatches collapse to a single rotation.
          const rotation = await getTokenManager().rotateOnRateLimit(
            'claude-handler:dispatchOneShot usage-limit (content)',
            { source: 'error_string', cooldownMinutes: 60, expectedFromKeyId: cappedKeyId },
          );
          if (!rotation.rotated && rotation.skipReason !== 'cas-skipped') {
            // No eligible replacement slot — retrying would just hit the same
            // cap, so fail fast with the typed error.
            this.logger.warn('DISPATCH: no eligible slot to rotate to on usage limit', {
              skipReason: rotation.skipReason,
            });
            throw new UsageLimitDispatchError(result);
          }
          this.logger.info('DISPATCH: rotated slot on usage limit, retrying', {
            newSlot: rotation.rotated?.name,
            newKeyId: rotation.rotated?.keyId,
          });
          // Loop continues → fresh lease on the now-active slot.
        }
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (lease) await lease.release();
      }

      // Overloaded/529 AND pool-rate-limit backoff happen AFTER the lease is
      // released so a slot is never pinned for the wait. The sleep resolves
      // early on abort; surface the abort as an error instead of burning
      // another attempt.
      if (pendingRetry?.kind === 'overloaded-wait') {
        await sleepWithAbort(pendingRetry.delayMs, abortController?.signal);
        if (abortController?.signal.aborted) {
          throw new Error('one-shot dispatch aborted during overloaded/529 retry wait');
        }
      } else if (pendingRetry?.kind === 'rate-limit-wait') {
        await sleepWithAbort(pendingRetry.delayMs, abortController?.signal);
        if (abortController?.signal.aborted) {
          // Carry the advertised window on the abort error so callers with a
          // shorter patience than the window (goal-eval aborts at 120s, the
          // gateway can say "retry in 3283s") can schedule their OWN retry
          // after the real wait instead of failing terminally.
          const abortErr = new Error('one-shot dispatch aborted during pool rate-limit retry wait');
          (abortErr as { poolRateLimitRetryMs?: number }).poolRateLimitRetryMs = pendingRetry.delayMs;
          throw abortErr;
        }
      }
      // while(true) re-enters: every path that reaches here has either a
      // finite retry budget (overloaded ≤ DISPATCH_OVERLOADED_MAX_RETRIES,
      // rate-limit ≤ DISPATCH_RATE_LIMIT_MAX_RETRIES, overflow-fallback once,
      // usage-limit ≤ DISPATCH_USAGE_LIMIT_MAX_ATTEMPTS) or returned/thrown
      // above, so the loop always terminates.
    }
  }

  private async dispatchOneShotInner(
    userMessage: string,
    dispatchPrompt: string,
    env: Record<string, string>,
    model?: string,
    abortController?: AbortController,
    resumeSessionId?: string,
    cwd?: string,
    effort?: EffortLevel,
  ): Promise<string> {
    // Ensure cwd exists before spawn to avoid ENOENT (the SDK child fails to
    // boot in a missing dir). Resolved here, then handed to the port.
    let resolvedCwd: string | undefined;
    if (cwd) {
      if (!fs.existsSync(cwd)) {
        this.logger.warn('Dispatch CWD does not exist, recreating', { cwd });
        try {
          fs.mkdirSync(cwd, { recursive: true });
        } catch (mkdirErr) {
          this.logger.error('Failed to recreate dispatch CWD', { cwd, error: mkdirErr });
        }
      }
      if (fs.existsSync(cwd)) resolvedCwd = cwd;
    }

    // Route through the agent-runtime port (ADR 0002) — the SAME one-shot seam
    // the summarizer / title / instructions / memory-improve helpers use — so
    // EVERY one-shot model call funnels through `claude-code-runner`'s single
    // `query()` loop. Claude-Code-specific knobs (env/effort/cwd/abort/resume/
    // forkSession) ride in the named `claudeCode` extension bag; `env` carries
    // the lease's fresh OAuth token without ever touching `process.env`.
    const runOptions: AgentRunOptions = {
      maxTurns: 1,
      systemPrompt: dispatchPrompt,
      tools: [],
      // `model: ''` → omitted below so the SDK default applies (mirrors the old
      // `if (model) options.model = model`).
      model: model ?? '',
      extensions: {
        claudeCode: {
          env,
          settingSources: [],
          plugins: [],
          stderr: (data: string) => this.logger.warn('DISPATCH stderr', { data: data.trimEnd() }),
          // Match the work model's reasoning effort so the goal-completion eval
          // is never weaker than the worker (spec §Completion / S6).
          ...(effort ? { effort } : {}),
          ...(abortController ? { abortController } : {}),
          ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
          // Fork the resumed session for context-aware summaries without
          // mutating the original.
          ...(resumeSessionId ? { resume: resumeSessionId, forkSession: true } : {}),
        },
      },
    };
    if (!model) {
      delete (runOptions as { model?: string }).model;
    }

    const startTime = Date.now();
    this.logger.info('\uD83D\uDE80 DISPATCH: Starting one-shot query (agent-runtime port)', {
      model,
      resumeSession: !!resumeSessionId,
      messageLength: userMessage.length,
      messagePreview: userMessage.substring(0, 100),
    });

    try {
      const assistantText = await runOneShotText(userMessage, runOptions);
      const totalTime = Date.now() - startTime;
      this.logger.info(`\uD83D\uDCCD DISPATCH: Response complete (${totalTime}ms)`, {
        responseLength: assistantText.length,
        preview: assistantText.substring(0, 200),
      });
      return assistantText;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.logger.error(`\u274C DISPATCH: Error after ${elapsed}ms`, { error: (error as Error).message });
      throw error;
    }
  }

  // ===== Core Query Logic =====

  /**
   * Run one turn in STREAMING INPUT mode.
   *
   * The prompt is a {@link TurnInputChannel}, not a string: that is what makes
   * the turn steerable (a user message pushed mid-turn is delivered by the CLI
   * at the next tool-call boundary, inside this same turn) and what makes the
   * SDK's control requests available at all — `interrupt()` and
   * `cancel_async_message` are "only supported when streaming input/output is
   * used" (sdk.d.ts:2522-2536).
   *
   * "One turn per `query()`" is unchanged: the channel is closed on the turn's
   * `result` frame, which ends the input stream and lets the CLI child exit.
   * `options.abortController` stays the hard-kill fallback — `interruptTurn`
   * deliberately does not touch it.
   *
   * @param sessionKey Registry key for the steering controls — the host's own
   *   session key (`work:<channel>:<thread>`, `src/session-identity.ts`), the
   *   same key it queued the follow-ups under. There is no derived fallback: a
   *   key the host cannot name is a key nobody can steer by, so a turn without
   *   one runs exactly as before, just not steerable.
   */
  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: SlackContext,
    sessionKey?: string,
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // Acquire a lease on the active CCT slot. Held for the lifetime of the
    // Claude CLI streaming call, released in the outer finally below.
    let lease: SlotAuthLease | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    try {
      try {
        lease = await ensureActiveSlotAuth(getTokenManager(), 'claude-handler:streamQuery');
      } catch (credErr) {
        if (credErr instanceof NoHealthySlotError) {
          this.logger.error('Claude credentials invalid', {
            error: credErr.message,
            status: getCredentialStatus(),
          });
          await sendCredentialAlert(credErr.message);
          throw new Error(
            `Claude credentials missing: ${credErr.message}\n` +
              'Please log in to Claude manually or enable automatic credential restore.',
          );
        }
        throw credErr;
      }

      heartbeatTimer = setInterval(() => {
        lease?.heartbeat().catch((err) => this.logger.debug('lease heartbeat failed', err));
      }, CLAUDE_LEASE_HEARTBEAT_MS);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

      // Build query options. The per-call env map (from `buildQueryEnv`)
      // carries the lease's fresh access token via `options.env`, so it
      // never crosses the shared `process.env.CLAUDE_CODE_OAUTH_TOKEN`
      // variable — concurrent streams holding leases on different slots
      // therefore cannot clobber each other's auth.
      //
      // Per-user llmux tenant credential (multi-tenant metering): attribute
      // this stream's tokens to the triggering Slack user. Null (issuance
      // unavailable / ccp mode) falls back to the shared key = legacy tenant.
      // The lease carries the daemon it belongs to, so an llmux switch during
      // issuance cannot pair this key with a different daemon's URL.
      const tenantUserId = session?.currentInitiatorId || session?.userId || slackContext?.user;
      const llmuxTenant = tenantUserId ? await ensureTenantKey(tenantUserId, tenantKeyProfile(tenantUserId)) : null;
      const { env: queryEnv } = buildQueryEnv(lease, { llmuxTenant });
      const { options, getStderrBuffer } = await buildStreamOptions(
        { queryEnv, session, abortController, workingDirectory, slackContext },
        {
          logger: this.logger,
          getEffectivePluginPaths: () => this.getEffectivePluginPaths(),
          buildModelCommandContext: (s, sc) => this.buildModelCommandContext(s, sc),
          mcpConfigBuilder: this.mcpConfigBuilder,
          compactHookBuilder: this.compactHookBuilder,
          promptBuilder: this.promptBuilder,
          sessionRegistry: this.sessionRegistry,
          checkMcpToolPermission: (a, b, c, d) => this.checkMcpToolPermission(a, b, c, d),
          safetyClassifier: this.getSafetyClassifier(),
        },
      );

      this.logger.debug('Claude query options', options);

      const channel = new TurnInputChannel(buildInitialUserMessage(prompt));
      const activeQuery = query({ prompt: channel, options });
      const steerKey = sessionKey;
      if (steerKey) {
        this.activeQueries.set(steerKey, { query: activeQuery, channel });
      }

      // Set once the turn's steered sends have been settled (the settlement
      // frame was emitted). Guards the abandonment warning in the finally AND
      // re-settlement: a streaming-input session can emit more than one
      // `result`, and settling twice would interrupt an already-settled turn
      // and re-publish a verdict for uuids the host has resolved.
      let steerSettled = false;
      // Protocol capabilities this CLI advertised on `system`/`init`
      // (sdk.d.ts:5000). Read once, consumed by the settlement below.
      let capabilities: string[] = [];
      try {
        for await (const message of activeQuery) {
          // Issue #661 — convert SDK's "1M context unavailable" assistant
          // message into a throw so the existing error path can auto-fallback.
          // No-op unless options.model ends with `[1m]` AND the message
          // carries one of the stable 1M-unavailable signals.
          maybeThrowOneMUnavailable(message, options.model);

          // Update session ID on init
          if (message.type === 'system' && message.subtype === 'init') {
            capabilities = readUuidList((message as unknown as Record<string, unknown>).capabilities);
            if (session) {
              session.sessionId = message.session_id;
              this.logger.info('Session initialized', {
                sessionId: message.session_id,
                model: message.model,
                tools: message.tools?.length || 0,
              });
            }
          }

          // The turn is over: settle whatever was steered into it, then close
          // the input stream so the CLI child exits. Closed BEFORE the yield so
          // a consumer that stops iterating here (the processor's bounded
          // iterator-return after `result`) still leaves no process waiting on
          // stdin.
          if (message.type === 'result') {
            let settlement: SDKMessage | undefined;
            if (!steerSettled) {
              settlement = await this.settleSteeredSends(activeQuery, message, channel, capabilities);
              if (settlement) steerSettled = true;
            }
            channel.close();
            // Emitted BEFORE the result so a consumer that stops on `result`
            // (the bounded iterator-return above) has already seen the verdict.
            if (settlement) yield settlement;
          }
          yield message;
        }
      } catch (error) {
        // Attach stderr content to error so downstream handlers can inspect it
        // (e.g., rate limit messages appear in stderr, not in error.message)
        const stderrContent = getStderrBuffer();
        if (stderrContent) {
          (error as any).stderrContent = stderrContent;
        }
        this.logger.error('Error in Claude query', error);
        throw error;
      } finally {
        // Covers the normal end, the throw above, and consumer abandonment
        // (generator `return()` runs this). Steering must answer "no" the
        // instant the turn stops, and an unclosed channel would strand the
        // child on an error/abort path.
        //
        // A turn that dies before its `result` (error / abort / abandoned
        // generator) cannot yield a settlement frame — nothing is iterating
        // this generator any more. The host's queue keeps those items in
        // `steered` until it reconciles them, so log the orphan count loudly
        // rather than pretending they settled.
        if (!steerSettled) {
          const unsettled = channel.pushedUuids();
          if (unsettled.length > 0) {
            this.logger.warn('Steered sends left unsettled (turn ended without a result frame)', {
              count: unsettled.length,
              sessionKey: steerKey,
            });
          }
        }
        channel.close();
        if (steerKey && this.activeQueries.get(steerKey)?.query === activeQuery) {
          this.activeQueries.delete(steerKey);
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (lease) await lease.release();
    }
  }

  /**
   * Decide which of the turn's steered sends the CLI actually folded in, and
   * pack the verdict into one synthetic frame (spec §6 item 6).
   *
   * WHY A HOST-COMPUTED VERDICT: SDK 0.3.251 emits no per-frame consumption
   * signal — no `user_message_uuids`, no `command_lifecycle`, and the singular
   * `user_message_uuid` only marks the send that STARTED the turn. The one
   * measurable fact is `queued_turn_count` on the `result` (sdk.d.ts:4795/4849)
   * = pushed sends the CLI has NOT folded into this turn. So:
   *   • `0` / absent, on a HEALTHY result → nothing is left over: every pushed
   *     send was consumed. "Healthy" is load-bearing: 0 also means "the session
   *     is ending and discarded the backlog" and absent also means "fatal
   *     startup result" (sdk.d.ts:4793/4847), so consumption is claimed only on
   *     `subtype:'success'` + `is_error !== true` + no non-`completed`
   *     `terminal_reason`. Anything else discards.
   *   • `> 0` → interrupt and read the receipt (see
   *     {@link resolveUnconsumedSends}).
   *   • no receipt (throw, or a CLI predating `interrupt_receipt_v1`) → there
   *     is no proof any of them ran, so ALL are discarded. The host requeues a
   *     discarded item; claiming a false `completed` would silently drop a
   *     user's message, which is the one failure this feature may not have.
   *
   * The verdict does NOT depend on whether a withdrawal succeeded: a survivor
   * stays `discarded` even if its cancel failed. Same bias — never lose a user
   * message. The cost of a failed cancel is a bounded double-run window (the
   * CLI child is torn down right after this `result`), which R1 measures.
   *
   * BOUNDED: the whole settlement races {@link STEER_SETTLEMENT_BOUND_MS}. It
   * runs on the turn's teardown path, so a control request that never answers
   * would strand the generator, the channel and the Slack turn behind it; the
   * timeout takes the safe verdict and lets teardown proceed.
   *
   * The frame is SDK-shaped (`session_id`/`uuid` copied off the result) so
   * downstream shape checks on the raw stream keep passing. Resolves
   * `undefined` when nothing was steered into this turn — there is then no
   * verdict to publish.
   */
  private async settleSteeredSends(
    activeQuery: Query,
    result: SDKMessage,
    channel: TurnInputChannel,
    capabilities: string[],
  ): Promise<SDKMessage | undefined> {
    // Sealed BEFORE the snapshot: the settlement awaits a control round-trip,
    // and a push accepted during that await would be missing from this snapshot
    // and therefore settled by nobody. A sealed push answers `false`, which the
    // host already handles as "not delivered — keep it queued". Sealing does not
    // end the input stream; the caller's `close()` does that.
    channel.seal();
    const pushedUuids = channel.pushedUuids();
    if (pushedUuids.length === 0) return undefined;

    const raw = result as unknown as Record<string, unknown>;
    const queuedTurnCount = typeof raw.queued_turn_count === 'number' ? raw.queued_turn_count : undefined;

    let discarded: string[];
    if (queuedTurnCount !== undefined && queuedTurnCount > 0) {
      discarded = await this.boundSettlement(
        () => this.resolveUnconsumedSends(activeQuery, pushedUuids, queuedTurnCount, capabilities),
        pushedUuids,
      );
    } else if (isHealthyTurnResult(raw)) {
      discarded = [];
    } else {
      this.logger.warn('Steer settlement: result is not healthy, discarding every pushed send', {
        subtype: raw.subtype,
        isError: raw.is_error,
        terminalReason: raw.terminal_reason,
        pushed: pushedUuids.length,
      });
      discarded = [...pushedUuids];
    }

    // Backstop for a uuid recorded after the snapshot. The seal above makes
    // that impossible today, but a lost send is unrecoverable while an extra
    // `discarded` only re-runs it — so any late uuid is settled, never dropped.
    const late = channel.pushedUuids().filter((uuid) => !pushedUuids.includes(uuid));
    if (late.length > 0) {
      this.logger.warn('Steer settlement: sends recorded after the settlement snapshot', { late });
      discarded = [...discarded, ...late];
    }

    const discardedSet = new Set(discarded);
    const consumed = [...pushedUuids, ...late].filter((uuid) => !discardedSet.has(uuid));
    return {
      type: 'system',
      subtype: STEER_SETTLEMENT_SUBTYPE,
      consumed,
      discarded,
      session_id: raw.session_id,
      uuid: raw.uuid,
    } as unknown as SDKMessage;
  }

  /**
   * Run the settlement work under {@link STEER_SETTLEMENT_BOUND_MS}, falling
   * back to "everything discarded" when it does not answer in time.
   */
  private async boundSettlement(work: () => Promise<string[]>, pushedUuids: string[]): Promise<string[]> {
    const bailed = Symbol('steer-settlement-bailed');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(bailed), STEER_SETTLEMENT_BOUND_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      // A settlement that loses the race is abandoned on purpose: nothing on
      // the teardown path may keep waiting on a wedged CLI.
      const outcome = await Promise.race<string[] | symbol>([
        work().catch((error) => {
          // Same safe verdict as a timeout, but reported for what it is.
          this.logger.warn('Steer settlement: settlement failed, discarding every pushed send', {
            error: (error as Error).message,
            pushed: pushedUuids.length,
          });
          return [...pushedUuids];
        }),
        bound,
      ]);
      if (Array.isArray(outcome)) return outcome;
      this.logger.warn('Steer settlement: timed out, discarding every pushed send', {
        boundMs: STEER_SETTLEMENT_BOUND_MS,
        pushed: pushedUuids.length,
      });
      return [...pushedUuids];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Interrupt the finished turn and decide which pushed sends did NOT run.
   *
   * Two paths, chosen by what the CLI advertised on `system`/`init`:
   *   • `interrupt_cancel_queued_v1` → one round-trip with
   *     `{cancelQueued:true}`. The type of `interrupt` omits the argument in
   *     0.3.251, but the runtime forwards it (`sdk.mjs`:
   *     `...e?.cancelQueued===!0&&{cancel_queued:!0}`), and the CLI then sweeps
   *     every uuid-stamped survivor synchronously with the abort and lists it
   *     under `cancelled` (sdk.d.ts:3932/3946). No per-uuid loop — and no
   *     window in which a survivor is dequeued between receipt and withdrawal.
   *   • otherwise → plain `interrupt()`, then withdraw each `still_queued`
   *     survivor individually with `cancelAsyncMessage` (best effort).
   *
   * `queued_turn_count` is the AUTHORITY on how many sends were left over. A
   * plain interrupt issued after the result loses the drain race — a send
   * already promoted to the imminent turn is not listed under `still_queued`
   * (sdk.d.ts:3942) — so when the receipt accounts for fewer survivors than the
   * count, the remainder is unaccounted, not proven consumed, and everything
   * pushed is discarded.
   */
  private async resolveUnconsumedSends(
    activeQuery: Query,
    pushedUuids: string[],
    queuedTurnCount: number,
    capabilities: string[],
  ): Promise<string[]> {
    const canCancelQueued = capabilities.includes(INTERRUPT_CANCEL_QUEUED_CAPABILITY);
    let receipt: { still_queued?: unknown; cancelled?: unknown } | undefined;
    let interruptFailed = false;
    try {
      if (canCancelQueued) {
        const interrupt = activeQuery.interrupt as unknown as (opts?: {
          cancelQueued?: boolean;
        }) => Promise<{ still_queued?: unknown; cancelled?: unknown } | undefined>;
        receipt = await interrupt.call(activeQuery, { cancelQueued: true });
      } else {
        receipt = await activeQuery.interrupt();
      }
    } catch (error) {
      interruptFailed = true;
      this.logger.warn('Steer settlement: interrupt failed after result', {
        error: (error as Error).message,
        queuedTurnCount,
        cancelQueued: canCancelQueued,
        pushed: pushedUuids.length,
      });
    }

    if (!receipt) {
      if (!interruptFailed) {
        this.logger.warn('Steer settlement: interrupt returned no receipt', {
          queuedTurnCount,
          pushed: pushedUuids.length,
        });
      }
      return [...pushedUuids];
    }

    const alreadyCancelled = new Set(readUuidList(receipt.cancelled));
    const survivors = new Set<string>([...readUuidList(receipt.still_queued), ...alreadyCancelled]);
    const discarded = pushedUuids.filter((uuid) => survivors.has(uuid));
    if (!canCancelQueued) {
      // Withdraw what the interrupt left runnable, one uuid at a time.
      for (const uuid of discarded) {
        if (alreadyCancelled.has(uuid)) continue;
        await this.withdrawSurvivingSend(activeQuery, uuid);
      }
    }

    if (discarded.length < queuedTurnCount) {
      this.logger.warn('Steer settlement: receipt accounts for fewer survivors than queued_turn_count', {
        queuedTurnCount,
        accounted: discarded.length,
        pushed: pushedUuids.length,
      });
      return [...pushedUuids];
    }
    return discarded;
  }

  /**
   * Best-effort withdrawal of one send that survived the turn's interrupt.
   *
   * Same structural reach as {@link cancelSteeredMessage} (`cancelAsyncMessage`
   * ships in `sdk.mjs` but is absent from the 0.3.251 `Query` type). A `false`
   * answer is normal — the send may already have left the queue — and a throw
   * is not fatal here, so both are logged and swallowed: the caller has already
   * decided this uuid is `discarded`.
   */
  private async withdrawSurvivingSend(activeQuery: Query, uuid: string): Promise<void> {
    const cancel = (activeQuery as unknown as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> })
      .cancelAsyncMessage;
    if (typeof cancel !== 'function') {
      this.logger.info('Steer settlement: cancelAsyncMessage unavailable on this runtime', { uuid });
      return;
    }
    try {
      const cancelled = (await cancel.call(activeQuery, uuid)) === true;
      this.logger.info('Steer settlement: withdrew surviving steered send', { uuid, cancelled });
    } catch (error) {
      this.logger.info('Steer settlement: withdrawing a surviving steered send failed', {
        uuid,
        cancelled: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Streaming agent entry consumed by the Slack pipeline (epic #1023 P4).
   *
   * Wraps {@link streamQuery}'s SDK message stream through the agent-runtime
   * mapper (`runAgentStream`) so `packages/slack` consumes neutral
   * `AgentStreamEvent`s and never imports the Claude SDK (§3.9 contract 1). The
   * lease / auth / `query()` lifecycle stays inside `streamQuery`; this method
   * only relocates the SDK→event mapping behind the seam.
   */
  streamAgentEvents(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: SlackContext,
    sessionKey?: string,
  ): AsyncIterable<AgentStreamEvent> {
    return runAgentStream(
      this.streamQuery(prompt, session, abortController, workingDirectory, slackContext, sessionKey),
      { calculateTokenCost },
    );
  }

  /**
   * Inject a user message into the turn currently running for `sessionKey`.
   *
   * Returns `false` when no turn is in flight — the caller must then queue the
   * message for the next dispatch instead of assuming it landed. Delivery is
   * at the CLI's next tool-call boundary, still inside the running turn; the
   * `uuid` comes back stamped on that turn's reply and result frames (see the
   * `steer_lifecycle` events), which is how the host closes the loop.
   */
  steerTurn(sessionKey: string, input: SteerInput): boolean {
    const entry = this.activeQueries.get(sessionKey);
    if (!entry) return false;
    return entry.channel.push(buildSteerUserMessage(input));
  }

  /**
   * Interrupt the running turn and return the SDK's interrupt receipt.
   *
   * Deliberately does NOT abort the turn's `AbortController`: abort kills the
   * child process, losing the receipt and the session, whereas an interrupt
   * stops the current work and leaves the session able to report which queued
   * sends survived. The AbortController stays the hard-kill fallback for the
   * stop/cancel paths that own it.
   *
   * Resolves `undefined` when no turn is running, or when the CLI predates the
   * `interrupt_receipt_v1` capability (it then answers with no receipt —
   * sdk.d.ts:2528-2536). `undefined` therefore means "no receipt", never
   * "nothing queued".
   */
  async interruptTurn(sessionKey: string): Promise<SteerInterruptReceipt | undefined> {
    const entry = this.activeQueries.get(sessionKey);
    if (!entry) return undefined;
    const receipt = await entry.query.interrupt();
    if (!receipt) return undefined;
    return {
      stillQueued: Array.isArray(receipt.still_queued) ? receipt.still_queued : [],
      cancelled: Array.isArray(receipt.cancelled) ? receipt.cancelled : [],
    };
  }

  /**
   * Withdraw a steered message that has not run yet.
   *
   * Three outcomes, because a single `false` collapsed three different facts and
   * the caller has a different obligation for each:
   *
   *  - `withdrawn` — the SDK took the message back; it will never run.
   *  - `already-dequeued` — the SDK's own answer once the message left its
   *    queue: the model has it, so the honest record is consumption, not a
   *    cancel that did not happen.
   *  - `unreachable` — the request never reached an SDK queue at all (no turn
   *    is running for this key, or this runtime predates `cancelAsyncMessage`).
   *    Nothing is known about the message, so nothing may be claimed about it.
   *
   * `cancelAsyncMessage` ships in `sdk.mjs` but is absent from the 0.3.251
   * `Query` type, so it is reached structurally rather than by import.
   */
  async cancelSteeredMessage(
    sessionKey: string,
    uuid: string,
  ): Promise<'withdrawn' | 'already-dequeued' | 'unreachable'> {
    const entry = this.activeQueries.get(sessionKey);
    if (!entry) return 'unreachable';
    const cancel = (entry.query as unknown as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> })
      .cancelAsyncMessage;
    if (typeof cancel !== 'function') return 'unreachable';
    return (await cancel.call(entry.query, uuid)) === true ? 'withdrawn' : 'already-dequeued';
  }

  /**
   * Check if a MCP tool call should be denied based on permission config and active grants.
   * Returns a denial reason string, or null if the tool is allowed.
   * Used by PreToolUse hook for runtime enforcement (catches mid-session grant expiry).
   *
   * Uses known gated server names to resolve the `__` delimiter ambiguity:
   * matches `mcp__{knownServer}__` prefix instead of naive split.
   * SYNC: This logic is duplicated in mcp-tool-permission-integration.test.ts for direct testing.
   */
  private checkMcpToolPermission(
    toolName: string,
    userId: string,
    permConfig: ReturnType<typeof loadMcpToolPermissions>,
    gatedServerNames: string[],
  ): string | null {
    const resolved = resolveGatedTool(toolName, gatedServerNames);
    if (!resolved) return null;

    const { serverName, toolFunction } = resolved;
    const requiredLevel = getRequiredLevel(permConfig, serverName, toolFunction);

    // Tool not in permission config but on a gated server \u2192 deny-by-default (defense-in-depth)
    if (!requiredLevel) {
      return `Tool ${toolFunction} on gated server ${serverName} is not listed in permission config. Access denied by default.`;
    }

    // Check active grants (reload from disk for cross-process safety)
    mcpToolGrantStore.reload();
    const hasWriteGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'write');
    const hasReadGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'read');
    const userLevel = hasWriteGrant ? 'write' : hasReadGrant ? 'read' : null;

    if (!userLevel) {
      return `No active grant for ${serverName}. Required: ${requiredLevel}. Use mcp__mcp-tool-permission__request_permission to request access.`;
    }

    if (!levelSatisfies(userLevel, requiredLevel)) {
      return `Insufficient grant level for ${serverName}/${toolFunction}. Have: ${userLevel}, required: ${requiredLevel}.`;
    }

    return null;
  }

  private buildModelCommandContext(
    session: ConversationSession | undefined,
    slackContext: SlackContext | undefined,
  ): ModelCommandContext | undefined {
    if (!slackContext) {
      return undefined;
    }

    return {
      channel: slackContext.channel,
      threadTs: slackContext.threadTs,
      user: slackContext.user,
      workflow: session?.workflow,
      renewState: session?.renewState ?? null,
      session: this.sessionRegistry.getSessionResourceSnapshot(slackContext.channel, slackContext.threadTs),
      sessionTitle: session?.title,
    };
  }
}

/**
 * Build a structured repository context block for system prompt injection.
 * Exported for unit testing.
 */
export function buildRepoContextBlock(repos: string[], confluenceUrl?: string): string {
  const parts: string[] = [];
  if (repos.length > 0) {
    const repoLines = repos
      .map((r) => {
        // Guard against pre-prefixed URLs or malformed entries
        const url = r.startsWith('http') ? r : `https://github.com/${r}`;
        return `- ${url}`;
      })
      .join('\n');
    parts.push(`This channel is mapped to the following repository(ies):\n${repoLines}`);
  }
  if (confluenceUrl) {
    parts.push(`Project wiki: ${confluenceUrl}`);
  }
  return `<channel-repository>\n${parts.join('\n')}\n</channel-repository>`;
}

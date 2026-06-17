/**
 * ClaudeHandler - Manages Claude SDK queries
 * Refactored to use SessionRegistry, PromptBuilder, and McpConfigBuilder (Phase 5)
 */

import {
  type HookInput,
  type HookJSONOutput,
  type Options,
  query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { type AgentStreamEvent, runAgentStream } from './agent-runtime';
import { buildStreamOptions } from './agent-runtime/claude-code/build-stream-options';
import type { SafetyClassifier } from './agent-runtime/policy/safety-classifier';
import { buildSafetyClassifier } from './agent-runtime/policy/safety-classifier-factory';
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

import { textIndicatesUsageLimit } from '@soma/common/rate-limit';
import type { ModelCommandContext } from 'somalib/model-commands/types';
import { sendCredentialAlert } from './credential-alert';
import {
  ensureActiveSlotAuth,
  getCredentialStatus,
  NoHealthySlotError,
  type SlotAuthLease,
} from './credentials-manager';
import { McpConfigBuilder, type SlackContext } from './mcp-config-builder';
import { getAvailablePersonas, PromptBuilder } from './prompt-builder';
import { type CrashRecoveredSession, SessionExpiryCallbacks, SessionRegistry } from './session-registry';
import { getTokenManager } from './token-manager';
import { DEFAULT_SHOW_THINKING, type EffortLevel } from './user-settings-store';

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
export class UsageLimitDispatchError extends Error {
  constructor(public readonly capNotice: string) {
    super(`Claude usage limit hit during one-shot dispatch: ${capNotice.slice(0, 200)}`);
    this.name = 'UsageLimitDispatchError';
  }
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

export class ClaudeHandler {
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

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
    let lastCapNotice = '';
    for (let attempt = 1; attempt <= DISPATCH_USAGE_LIMIT_MAX_ATTEMPTS; attempt++) {
      // Acquire a lease on the active CCT slot. Held for the lifetime of one
      // Claude CLI dispatch attempt, released in the per-attempt finally.
      let lease: SlotAuthLease | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;
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
        // isolated by construction.
        const { env } = buildQueryEnv(lease);
        const result = await this.dispatchOneShotInner(
          userMessage,
          dispatchPrompt,
          env,
          model,
          abortController,
          resumeSessionId,
          cwd,
          effort,
        );

        // Cap-as-content guard. Default (content-safe) detector — never
        // includeTransient here, since the eval/work output could legitimately
        // mention "rate limit" or "429" in prose.
        if (!textIndicatesUsageLimit(result)) {
          return result;
        }

        lastCapNotice = result;
        const cappedKeyId = lease.keyId;
        this.logger.warn('DISPATCH: usage limit surfaced as content', {
          attempt,
          maxAttempts: DISPATCH_USAGE_LIMIT_MAX_ATTEMPTS,
          cappedKeyId,
          preview: result.slice(0, 120),
        });

        if (attempt >= DISPATCH_USAGE_LIMIT_MAX_ATTEMPTS) {
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
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (lease) await lease.release();
      }
    }

    // Unreachable in practice (the loop either returns, throws, or exhausts
    // attempts via the in-loop throw), but keeps the function total.
    throw new UsageLimitDispatchError(lastCapNotice);
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
    // Build query options for one-shot dispatch. `env` is the per-call map
    // from `buildQueryEnv(lease)` — it carries the lease's fresh access
    // token without ever touching `process.env`, so concurrent dispatches
    // cannot clobber each other's auth.
    const options: Options = {
      settingSources: [],
      plugins: [],
      systemPrompt: dispatchPrompt,
      env,
      tools: [], // No tool use for dispatch
      maxTurns: 1, // Single turn only
      stderr: (data: string) => {
        this.logger.warn('DISPATCH stderr', { data: data.trimEnd() });
      },
    };

    if (model) {
      options.model = model;
    }

    // Match the work model's reasoning effort so the goal completion eval
    // is never weaker than the worker (spec §Completion / S6). Only set when
    // explicitly provided — otherwise the SDK default applies.
    if (effort) {
      options.effort = effort;
    }

    if (abortController) {
      options.abortController = abortController;
    }

    // Fork existing session to access conversation history for context-aware summaries.
    // resume + forkSession: copies history into a new session without mutating the original.
    // Without this, the fork has no knowledge of what happened in the session.
    if (resumeSessionId) {
      options.resume = resumeSessionId;
      options.forkSession = true;
    }

    if (cwd) {
      if (!fs.existsSync(cwd)) {
        this.logger.warn('Dispatch CWD does not exist, recreating', { cwd });
        try {
          fs.mkdirSync(cwd, { recursive: true });
        } catch (mkdirErr) {
          this.logger.error('Failed to recreate dispatch CWD', { cwd, error: mkdirErr });
        }
      }
      if (fs.existsSync(cwd)) {
        options.cwd = cwd;
      }
    }

    const startTime = Date.now();
    this.logger.info('\uD83D\uDE80 DISPATCH: Starting one-shot query', {
      model: options.model,
      resumeSession: !!resumeSessionId,
      messageLength: userMessage.length,
      messagePreview: userMessage.substring(0, 100),
    });

    let assistantText = '';
    let messageCount = 0;

    try {
      for await (const message of query({ prompt: userMessage, options })) {
        messageCount++;
        const elapsed = Date.now() - startTime;

        // Log all message types for debugging
        this.logger.debug(`\uD83D\uDCE8 DISPATCH: Message #${messageCount} (${elapsed}ms)`, {
          type: message.type,
          subtype: 'subtype' in message ? message.subtype : undefined,
        });

        // Handle system init message
        if (message.type === 'system' && message.subtype === 'init') {
          this.logger.info(`\u2705 DISPATCH: SDK initialized (${elapsed}ms)`, {
            model: message.model,
            sessionId: message.session_id,
          });
        }

        // Collect assistant text from the response
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              assistantText += block.text;
              this.logger.debug(`\uD83D\uDCDD DISPATCH: Text received (${elapsed}ms)`, {
                textLength: block.text.length,
                textPreview: block.text.substring(0, 50),
              });
            }
          }
        }

        // Handle result message
        if (message.type === 'result') {
          this.logger.info(`\uD83C\uDFC1 DISPATCH: Query completed (${elapsed}ms)`, {
            totalMessages: messageCount,
            responseLength: assistantText.length,
            stopReason: message.subtype === 'success' ? message.stop_reason : undefined,
          });
        }
      }
    } catch (error) {
      const elapsed = Date.now() - startTime;

      // If we already collected assistant text, the response is likely complete
      // even though the process didn't exit cleanly (e.g., SIGTERM / exit code 143)
      if (assistantText.trim()) {
        this.logger.warn(`\u26A0\uFE0F DISPATCH: Process error after ${elapsed}ms but response available, using it`, {
          error: (error as Error).message,
          messagesReceived: messageCount,
          responseLength: assistantText.length,
          preview: assistantText.substring(0, 100),
        });
        // Fall through to return the collected text
      } else {
        this.logger.error(`\u274C DISPATCH: Error after ${elapsed}ms`, {
          error: (error as Error).message,
          messagesReceived: messageCount,
        });
        throw error;
      }
    }

    const totalTime = Date.now() - startTime;
    this.logger.info(`\uD83D\uDCCD DISPATCH: Response complete (${totalTime}ms)`, {
      responseLength: assistantText.length,
      preview: assistantText.substring(0, 200),
    });

    return assistantText;
  }

  // ===== Core Query Logic =====

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: SlackContext,
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
      const { env: queryEnv } = buildQueryEnv(lease);
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

      try {
        for await (const message of query({ prompt, options })) {
          // Issue #661 — convert SDK's "1M context unavailable" assistant
          // message into a throw so the existing error path can auto-fallback.
          // No-op unless options.model ends with `[1m]` AND the message
          // carries one of the stable 1M-unavailable signals.
          maybeThrowOneMUnavailable(message, options.model);

          // Update session ID on init
          if (message.type === 'system' && message.subtype === 'init') {
            if (session) {
              session.sessionId = message.session_id;
              this.logger.info('Session initialized', {
                sessionId: message.session_id,
                model: message.model,
                tools: message.tools?.length || 0,
              });
            }
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
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (lease) await lease.release();
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
  ): AsyncIterable<AgentStreamEvent> {
    return runAgentStream(this.streamQuery(prompt, session, abortController, workingDirectory, slackContext), {
      calculateTokenCost,
    });
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

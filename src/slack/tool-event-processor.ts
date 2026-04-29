/**
 * ToolEventProcessor - Handles tool_use and tool_result events
 * Extracted from slack-handler.ts tool processing logic (Phase 4.2)
 */

import { config } from '../config';
import { Logger } from '../logger';
import { type McpCallTracker, mcpCallTracker } from '../mcp-call-tracker';
import type { AssistantStatusManager } from './assistant-status-manager';
import type { McpHealthMonitor } from './mcp-health-monitor';
import type { McpStatusDisplay } from './mcp-status-tracker';
import { getToolResultRenderMode, LOG_DETAIL, OutputFlag, shouldOutput } from './output-flags';
import { shouldRunLegacyB4Path } from './pipeline/effective-phase';
import type { ReactionManager } from './reaction-manager';
import { extractTaskIdFromResult } from './stream-processor';
import { ToolFormatter, type ToolResult } from './tool-formatter';
import type { ToolTracker } from './tool-tracker';

/**
 * Issue #688 — entry stored in BackgroundBashRegistry per live
 * `Bash({run_in_background:true})` invocation. The registry is keyed by
 * `(sessionKey, toolUseId)` so that:
 *  - `handleToolResult` can remove the exact entry by `toolUseId` on the
 *    stream's own tool_result (normal completion).
 *  - `cleanup()` (turn end) can `drain(sessionKey)` to sweep any bg bash
 *    that never produced a tool_result.
 * Both paths call `unregister()` to decrement the AssistantStatusManager
 * bg-bash counter so the native spinner text resolves correctly.
 */
interface BgBashEntry {
  callId: string;
  toolUseId: string;
  unregister: () => void;
}

class BackgroundBashRegistry {
  private map = new Map<string /*sessionKey*/, Map<string /*toolUseId*/, BgBashEntry>>();

  add(sessionKey: string, toolUseId: string, entry: BgBashEntry): void {
    let bucket = this.map.get(sessionKey);
    if (!bucket) {
      bucket = new Map();
      this.map.set(sessionKey, bucket);
    }
    bucket.set(toolUseId, entry);
  }

  remove(sessionKey: string, toolUseId: string): BgBashEntry | undefined {
    const bucket = this.map.get(sessionKey);
    if (!bucket) return undefined;
    const entry = bucket.get(toolUseId);
    if (!entry) return undefined;
    bucket.delete(toolUseId);
    if (bucket.size === 0) this.map.delete(sessionKey);
    return entry;
  }

  drain(sessionKey: string): BgBashEntry[] {
    const bucket = this.map.get(sessionKey);
    if (!bucket) return [];
    const entries = Array.from(bucket.values());
    this.map.delete(sessionKey);
    return entries;
  }
}

/**
 * Issue #794 — entry stored in BackgroundTaskRegistry per live
 * `Task({run_in_background:true})` invocation. Unlike BashBG (#688), Task
 * does NOT carry an AssistantStatusManager bg-counter — Subagent runs in
 * the background but is invisible to the native "waiting on background
 * shell" spinner — so there is no `unregister` callback. The registry's
 * sole job is to gate `endMcpTracking` on the spawn-ack tool_result so
 * the McpStatusDisplay progress UI stays alive until the turn ends.
 *
 * Keyed by `(turnId, toolUseId)` to defend against same-session turn
 * replacement (`session-initializer.ts:1138/1157`): if turn1's cleanup
 * drained a session-keyed registry it would clobber turn2's just-spawned
 * bg Task entries. `toolUseId` alone is unique across turns, but the
 * `turnId` outer bucket lets `cleanup(sessionKey, turnId)` drain only
 * its own turn's entries.
 *
 * Falls back to a `hasAnyByToolUseId`/`removeAnyByToolUseId` scan when
 * the caller doesn't have a `turnId` (older code paths in tests, or the
 * `handleToolResult` spawn-ack detector that runs before context.turnId
 * is reliably populated).
 */
interface BgTaskEntry {
  callId: string;
  toolUseId: string;
  subagentLabel: string;
  turnId: string;
}

class BackgroundTaskRegistry {
  private map = new Map<string /*turnId*/, Map<string /*toolUseId*/, BgTaskEntry>>();

  add(turnId: string, toolUseId: string, entry: BgTaskEntry): void {
    let bucket = this.map.get(turnId);
    if (!bucket) {
      bucket = new Map();
      this.map.set(turnId, bucket);
    }
    bucket.set(toolUseId, entry);
  }

  has(turnId: string, toolUseId: string): boolean {
    return this.map.get(turnId)?.has(toolUseId) ?? false;
  }

  remove(turnId: string, toolUseId: string): BgTaskEntry | undefined {
    const bucket = this.map.get(turnId);
    if (!bucket) return undefined;
    const entry = bucket.get(toolUseId);
    if (!entry) return undefined;
    bucket.delete(toolUseId);
    if (bucket.size === 0) this.map.delete(turnId);
    return entry;
  }

  drain(turnId: string): BgTaskEntry[] {
    const bucket = this.map.get(turnId);
    if (!bucket) return [];
    const entries = Array.from(bucket.values());
    this.map.delete(turnId);
    return entries;
  }

  /**
   * Spawn-ack detection runs before `context.turnId` is guaranteed; scan
   * every turn bucket for `toolUseId`. `toolUseId` is unique per stream
   * so a single bucket can match.
   */
  hasAnyByToolUseId(toolUseId: string): boolean {
    for (const bucket of this.map.values()) {
      if (bucket.has(toolUseId)) return true;
    }
    return false;
  }

  removeAnyByToolUseId(toolUseId: string): BgTaskEntry | undefined {
    for (const [turnId, bucket] of this.map) {
      const entry = bucket.get(toolUseId);
      if (!entry) continue;
      bucket.delete(toolUseId);
      if (bucket.size === 0) this.map.delete(turnId);
      return entry;
    }
    return undefined;
  }
}

/**
 * Context for tool event processing
 */
export interface ToolEventContext {
  channel: string;
  threadTs: string;
  sessionKey: string;
  say: SayFunction;
  /** Verbosity bitmask — controls result display behavior */
  logVerbosity?: number;
  /**
   * Turn id minted by StreamExecutor for this request. Optional for
   * backward compatibility — if absent the PHASE>=2 B1 absorb path
   * falls through to legacy `say`. See stream-executor.ts:355 for the
   * format (`${sessionKey}:${ms}:${uuid}`).
   */
  turnId?: string;
}

/**
 * Slack say function type
 */
export type SayFunction = (message: { text: string; thread_ts: string }) => Promise<{ ts?: string }>;

/**
 * Callback used to absorb a formatted tool result into the B1 stream at
 * PHASE>=2. Installed by `slack-handler.ts` as a closure over
 * `threadPanel.appendText`. Returns `true` when Slack accepted the chunk;
 * any `false` (closing turn, closed stream, Slack error) signals the
 * caller to fall back to legacy `context.say` so tool output is never
 * silently dropped.
 *
 * Caller-side (not TurnSurface) owns the presentation separator
 * (currently `\n\n`), so this sink stays a generic B1 write primitive
 * and keeps TurnSurface unaware of "tool result" semantics.
 */
export type ToolResultSink = (turnId: string, markdown: string) => Promise<boolean>;

/**
 * Tool use event from stream
 */
export interface ToolUseEvent {
  id: string;
  name: string;
  input: any;
}

/**
 * Tool result event from stream
 */
export interface ToolResultEvent {
  toolUseId: string;
  toolName?: string;
  result: any;
  isError?: boolean;
}

/**
 * ToolEventProcessor handles tool_use and tool_result event processing
 * - Tracks tool use ID to name mappings
 * - Manages MCP call tracking and status display
 * - Formats and sends tool results
 */
export class ToolEventProcessor {
  private logger = new Logger('ToolEventProcessor');
  private toolTracker: ToolTracker;
  private mcpStatusDisplay: McpStatusDisplay;
  private mcpCallTracker: McpCallTracker;
  private reactionManager: ReactionManager | null = null;
  private assistantStatusManager: AssistantStatusManager | null;
  private mcpHealthMonitor: McpHealthMonitor | null = null;
  private subagentCallIds: Set<string> = new Set();
  /**
   * Issue #688 — registry of live `Bash({run_in_background:true})` calls.
   * Populated by `startBackgroundBashTracking`, drained by
   * `handleToolResult` (normal completion) or `cleanup()` (turn end).
   */
  private backgroundBashRegistry = new BackgroundBashRegistry();
  /**
   * Issue #794 — registry of live `Task({run_in_background:true})` calls.
   * Turn-scoped; populated by `startSubagentTracking` when the turnId is
   * known, drained by `cleanup(sessionKey, turnId)` at turn end. Used by
   * `isBackgroundTaskSpawnAck` to suppress `endMcpTracking` on the
   * spawn-ack tool_result so the McpStatusDisplay progress UI survives
   * until turn end.
   */
  private backgroundTaskRegistry = new BackgroundTaskRegistry();
  /**
   * Issue #794 — turn-scoped index of live McpCallTracker callIds.
   *
   * Replaces the previous `toolTracker.getActiveMcpCallIds()` global
   * sweep in `cleanup()`. Same-session turn replacement
   * (`session-initializer.ts:1138/1157`) used to leak: turn1's cleanup
   * would `completeCall(callId, null)` for callIds that turn2 had just
   * registered, false-completing live calls. Bucketing by turnId at
   * registration site means cleanup only sweeps its own turn's calls.
   *
   * Populated at every `startCall` site (MCP / Subagent / BashBG) and
   * cleared at every `endCall` site (`endMcpTracking`).
   */
  private callIdsByTurn: Map<string, Set<string>> = new Map();
  /** Callback for updating compact tool call messages with duration */
  private onCompactDurationUpdate?: (toolUseId: string, duration: number | null, channel: string) => Promise<void>;
  /**
   * PHASE>=2 sink — absorbs formatted tool results into the B1 stream.
   * Null by default; installed by slack-handler after construction. See
   * `ToolResultSink` for the fallback contract.
   */
  private toolResultSink: ToolResultSink | null = null;

  constructor(
    toolTracker: ToolTracker,
    mcpStatusDisplay: McpStatusDisplay,
    mcpCallTrackerInstance: McpCallTracker = mcpCallTracker,
    assistantStatusManager?: AssistantStatusManager,
    mcpHealthMonitor?: McpHealthMonitor,
  ) {
    this.toolTracker = toolTracker;
    this.mcpStatusDisplay = mcpStatusDisplay;
    this.mcpCallTracker = mcpCallTrackerInstance;
    this.assistantStatusManager = assistantStatusManager || null;
    this.mcpHealthMonitor = mcpHealthMonitor || null;
  }

  /**
   * Set reaction manager for MCP pending tracking
   */
  setReactionManager(reactionManager: ReactionManager): void {
    this.reactionManager = reactionManager;
  }

  /**
   * Set callback for compact mode duration updates (in-place tool call message update)
   */
  setCompactDurationCallback(cb: (toolUseId: string, duration: number | null, channel: string) => Promise<void>): void {
    this.onCompactDurationUpdate = cb;
  }

  /**
   * Install the PHASE>=2 tool-result sink. See `ToolResultSink` for the
   * contract. Passing no callback (or `null`) clears the sink — the
   * processor will then always use the legacy `context.say` path.
   */
  setToolResultSink(sink: ToolResultSink | null): void {
    this.toolResultSink = sink;
  }

  /**
   * Handle tool use events from assistant message
   * - Track tool use IDs
   * - Start MCP call tracking for MCP tools
   * - Session tick handles consolidation automatically
   */
  async handleToolUse(toolUses: ToolUseEvent[], context: ToolEventContext): Promise<void> {
    for (const toolUse of toolUses) {
      this.logger.debug(
        'Handling tool_use',
        ToolFormatter.buildToolUseLogSummary(toolUse.id, toolUse.name, toolUse.input),
      );

      // Track tool use ID to name mapping
      this.toolTracker.trackToolUse(toolUse.id, toolUse.name);

      // Start MCP call tracking for MCP tools
      if (toolUse.name.startsWith('mcp__')) {
        await this.startMcpTracking(toolUse, context);
      }

      // Start subagent tracking for Task tools
      if (toolUse.name === 'Task') {
        await this.startSubagentTracking(toolUse, context);
      }

      // Issue #688 — Bash with run_in_background=true gets its own
      // progress track via the shared MCP pipeline (virtual `_bash_bg`
      // server), plus a bg-counter increment on AssistantStatusManager so
      // the native spinner flips to "waiting on background shell…".
      if (toolUse.name === 'Bash' && ToolFormatter.isBackgroundBash(toolUse.input)) {
        await this.startBackgroundBashTracking(toolUse, context);
      }
    }
  }

  /**
   * Start MCP call tracking and status display
   */
  private async startMcpTracking(toolUse: ToolUseEvent, context: ToolEventContext): Promise<void> {
    const nameParts = toolUse.name.split('__');
    const serverName = nameParts[1] || 'unknown';
    const actualToolName = nameParts.slice(2).join('__') || toolUse.name;

    // Start call tracking
    const callId = this.mcpCallTracker.startCall(serverName, actualToolName);
    this.toolTracker.trackMcpCall(toolUse.id, callId);
    if (context.turnId) this.addTurnCallId(context.turnId, callId);

    // Set hourglass reaction for MCP pending
    if (this.reactionManager && context.sessionKey) {
      await this.reactionManager.setMcpPending(context.sessionKey, callId);
    }

    // Native spinner with MCP server name — legacy-only; TurnSurface owns
    // the single B4 writer at PHASE>=4. Lifting getToolStatusText into
    // TurnSurface is a follow-up — see docs/slack-ui-phase4.md.
    // Skip when the descriptor is undefined/empty — `setStatus('')` reroutes
    // to `clearStatus` internally, which would silently wipe the spinner
    // mid-tool instead of leaving the previous status visible.
    if (shouldRunLegacyB4Path(this.assistantStatusManager)) {
      const statusText = this.assistantStatusManager?.getToolStatusText(toolUse.name, serverName);
      if (statusText) {
        await this.assistantStatusManager?.setStatus(context.channel, context.threadTs, statusText);
      }
    }

    const config = {
      displayType: 'MCP',
      displayLabel: `${serverName} → ${actualToolName}`,
      initialDelay: serverName === 'codex' ? 0 : 10000,
      predictKey: { serverName, toolName: actualToolName },
      paramsSummary: ToolFormatter.formatCompactParams(toolUse.input),
    };

    if (shouldOutput(OutputFlag.MCP_PROGRESS, context.logVerbosity ?? LOG_DETAIL)) {
      this.mcpStatusDisplay.registerCall(context.sessionKey, callId, config, context.channel, context.threadTs);
    }
  }

  /**
   * Start subagent tracking and status display for Task tools.
   *
   * Issue #794 — `Task({run_in_background:true})` carries its own
   * concerns:
   *   - The user must see a progress line as soon as the tool_use lands
   *     (handled by McpStatusDisplay's immediate first tick).
   *   - The bg spawn-ack tool_result (`task_id: …`) must NOT close the
   *     McpStatusDisplay entry; the registry add-call below installs the
   *     gate that `isBackgroundTaskSpawnAck` consults from
   *     `handleToolResult`. The entry is cleared either by `cleanup()`
   *     drain at turn end, or — for non-ack results (error / missing
   *     `task_id`) — by `removeAnyByToolUseId` in the
   *     fall-through branch of `handleToolResult`.
   *
   * `subagentCallIds.add(callId)` is unconditional (fg + bg) so the
   * existing `endMcpTracking` reaction-cleanup branch keeps treating
   * Subagent calls separately from MCP — bg Task entries still flow
   * through `endMcpTracking` at turn-end via the `cleanup` drain path.
   */
  private async startSubagentTracking(toolUse: ToolUseEvent, context: ToolEventContext): Promise<void> {
    const summary = ToolFormatter.getTaskToolSummary(toolUse.input);
    const subagentName = summary.subagentLabel || 'Task';
    const isBackground = summary.runInBackground;

    // Start call tracking with virtual server name
    const callId = this.mcpCallTracker.startCall('_subagent', subagentName);
    this.toolTracker.trackMcpCall(toolUse.id, callId);
    this.subagentCallIds.add(callId);
    if (context.turnId) this.addTurnCallId(context.turnId, callId);

    if (isBackground && context.turnId) {
      this.backgroundTaskRegistry.add(context.turnId, toolUse.id, {
        callId,
        toolUseId: toolUse.id,
        subagentLabel: subagentName,
        turnId: context.turnId,
      });
    }

    const config = {
      displayType: isBackground ? 'Subagent (bg)' : 'Subagent',
      displayLabel: subagentName,
      initialDelay: 0,
      predictKey: { serverName: '_subagent', toolName: subagentName },
      paramsSummary: summary.promptPreview ? `(${ToolFormatter.truncateString(summary.promptPreview, 50)})` : '',
    };

    if (shouldOutput(OutputFlag.MCP_PROGRESS, context.logVerbosity ?? LOG_DETAIL)) {
      this.mcpStatusDisplay.registerCall(context.sessionKey, callId, config, context.channel, context.threadTs);
    }
  }

  /**
   * Issue #688 — start progress tracking for a background Bash. Mirrors
   * `startSubagentTracking` so the `_bash_bg` virtual server rides the
   * same McpStatusDisplay / McpCallTracker pipeline. The
   * AssistantStatusManager bg-counter increment returns an idempotent
   * unregister function, which is stored on the registry entry and
   * invoked either by `handleToolResult` (normal close) or by
   * `cleanup()` (turn-end sweep for calls that never produced a result).
   */
  private async startBackgroundBashTracking(toolUse: ToolUseEvent, context: ToolEventContext): Promise<void> {
    const rawCommand = String((toolUse.input as { command?: unknown } | null | undefined)?.command ?? '');
    const cmdPrefix = ToolFormatter.truncateString(rawCommand, 80);

    const callId = this.mcpCallTracker.startCall('_bash_bg', 'bash');
    this.toolTracker.trackMcpCall(toolUse.id, callId);
    if (context.turnId) this.addTurnCallId(context.turnId, callId);

    const unregister =
      this.assistantStatusManager?.registerBackgroundBashActive(context.channel, context.threadTs) ?? (() => {});

    this.backgroundBashRegistry.add(context.sessionKey, toolUse.id, {
      callId,
      toolUseId: toolUse.id,
      unregister,
    });

    const config = {
      displayType: 'BashBG',
      displayLabel: `\`${cmdPrefix}\``,
      initialDelay: 0,
      predictKey: { serverName: '_bash_bg', toolName: 'bash' },
      paramsSummary: '',
    };

    if (shouldOutput(OutputFlag.MCP_PROGRESS, context.logVerbosity ?? LOG_DETAIL)) {
      this.mcpStatusDisplay.registerCall(context.sessionKey, callId, config, context.channel, context.threadTs);
    }
  }

  /**
   * Handle tool result events from user message
   * - End MCP call tracking
   * - Format and send results
   */
  async handleToolResult(toolResults: ToolResultEvent[], context: ToolEventContext): Promise<void> {
    for (const toolResult of toolResults) {
      // Lookup tool name from tracking if not set
      if (!toolResult.toolName && toolResult.toolUseId) {
        toolResult.toolName = this.toolTracker.getToolName(toolResult.toolUseId);
      }

      // Issue #688 — background Bash registry: drop the entry and
      // decrement the bg-bash counter. endMcpTracking still owns the
      // McpCallTracker/McpStatusDisplay closure (callId-based), so we
      // must NOT call completeCall from here to avoid double-closing.
      const bgEntry = this.backgroundBashRegistry.remove(context.sessionKey, toolResult.toolUseId);
      if (bgEntry) {
        try {
          bgEntry.unregister();
        } catch (err) {
          // unregister is idempotent (released flag). A throw here means
          // two code paths are fighting over the same entry — surface as
          // warn so a real concurrency bug doesn't hide at debug level.
          this.logger.warn('bg bash unregister threw', {
            toolUseId: toolResult.toolUseId,
            error: (err as Error)?.message ?? String(err),
          });
        }
      }

      // Issue #794 — bg Task spawn-ack: the SDK posts a `task_id: …`
      // tool_result within ~1s of the tool_use to acknowledge the
      // background spawn. The actual subagent then continues running
      // for minutes. We must NOT close the progress entry on this
      // ack — `cleanup(sessionKey, turnId)` at turn end is the single
      // source of completion. Two-branch decision tree:
      //
      //   (1) spawn-ack (`!isError && hasMatchingEntry && task_id`):
      //       skip endMcpTracking + skip sendToolResult, but still
      //       close the compact one-liner via onCompactDurationUpdate
      //       so the inline `⏳` flips to `🟢 (Ns)`.
      //   (2) non-ack result on a tracked bg Task (`isError` or no
      //       `task_id`): drop the registry entry now (so cleanup's
      //       drain doesn't see a stale entry), then fall through to
      //       the normal endMcpTracking + sendToolResult path.
      //
      // Foreground Task and non-Task tools never match (1) and only
      // match (2)'s `removed === undefined` case, which is a no-op.
      if (this.isBackgroundTaskSpawnAck(toolResult)) {
        const callId = this.toolTracker.getMcpCallId(toolResult.toolUseId);
        const elapsed = callId ? (this.mcpCallTracker.getElapsedTime(callId) ?? 0) : 0;
        if (this.onCompactDurationUpdate) {
          await this.onCompactDurationUpdate(toolResult.toolUseId, elapsed, context.channel);
        }
        this.logger.debug('bg Task spawn-ack — keeping progress alive', {
          toolUseId: toolResult.toolUseId,
          elapsed,
        });
        continue;
      }

      // (2) bg Task non-spawn-ack (error or `task_id`-less result) —
      // remove the registry entry so the turn-end drain sees a clean
      // slate, then fall through to the normal endMcpTracking path.
      const removedBgTask = this.backgroundTaskRegistry.removeAnyByToolUseId(toolResult.toolUseId);
      if (removedBgTask) {
        this.logger.debug('bg Task non-ack result — closing normally', {
          toolUseId: toolResult.toolUseId,
          isError: toolResult.isError,
          turnId: removedBgTask.turnId,
        });
      }

      // End MCP call tracking and get duration
      const duration = await this.endMcpTracking(toolResult.toolUseId, context.sessionKey);

      // Update compact tool call message with duration (in-place)
      if (duration !== null && this.onCompactDurationUpdate) {
        await this.onCompactDurationUpdate(toolResult.toolUseId, duration, context.channel);
      }

      if (this.mcpHealthMonitor && toolResult.toolName?.startsWith('mcp__')) {
        await this.mcpHealthMonitor.recordResult({
          toolName: toolResult.toolName,
          isError: toolResult.isError,
          channel: context.channel,
          threadTs: context.threadTs,
        });
      }

      this.logger.debug('Processing tool result', {
        toolName: toolResult.toolName,
        toolUseId: toolResult.toolUseId,
        hasResult: !!toolResult.result,
        isError: toolResult.isError,
        duration,
      });

      // Format and send result
      await this.sendToolResult(toolResult, duration, context);
    }
  }

  /**
   * End MCP or subagent tracking for a tool and return duration
   */
  private async endMcpTracking(toolUseId: string, sessionKey?: string): Promise<number | null> {
    const callId = this.toolTracker.getMcpCallId(toolUseId);
    if (!callId) return null;

    const duration = this.mcpCallTracker.endCall(callId);
    this.toolTracker.removeMcpCallId(toolUseId);
    // Issue #794 — drop the callId from its turn bucket so the
    // turn-scoped sweep in `cleanup()` does not double-complete it.
    this.removeTurnCallId(callId);

    // MCP-specific cleanup (reactions)
    if (!this.subagentCallIds.has(callId)) {
      if (this.reactionManager && sessionKey) {
        await this.reactionManager.clearMcpPending(sessionKey, callId);
      }
    } else {
      this.subagentCallIds.delete(callId);
    }

    // Mark call as completed in session tick
    this.mcpStatusDisplay.completeCall(callId, duration);

    return duration;
  }

  /**
   * Issue #794 — index a McpCallTracker callId under its owning turnId
   * so `cleanup(sessionKey, turnId)` can sweep only its own turn's
   * calls. See `callIdsByTurn` field doc for the same-session
   * turn-replacement race this guards against.
   */
  private addTurnCallId(turnId: string, callId: string): void {
    let bucket = this.callIdsByTurn.get(turnId);
    if (!bucket) {
      bucket = new Set();
      this.callIdsByTurn.set(turnId, bucket);
    }
    bucket.add(callId);
  }

  /**
   * Issue #794 — remove a callId from whichever turn bucket holds it.
   * The caller (`endMcpTracking`) does not know which turn registered
   * the callId, so we scan all buckets. Bucket count is bounded by live
   * turn count (≤ tens), so the linear scan is negligible.
   */
  private removeTurnCallId(callId: string): void {
    for (const [turnId, bucket] of this.callIdsByTurn) {
      if (bucket.delete(callId)) {
        if (bucket.size === 0) this.callIdsByTurn.delete(turnId);
        return;
      }
    }
  }

  /**
   * Issue #794 — bg Task spawn-ack detection. Three-part contract:
   *   1. `isError === true`  → not a spawn-ack (real failure → close
   *      the progress UI normally via the fall-through path).
   *   2. The toolUseId must already be registered in
   *      `backgroundTaskRegistry`. A foreground Task or any non-Task
   *      tool always returns false here.
   *   3. The result text must contain a `task_id` marker, parsed by
   *      the shared `extractTaskIdFromResult` helper. We deliberately
   *      reuse that helper instead of a local regex so a spec change
   *      to the marker format propagates everywhere at once.
   *
   * Returning true tells `handleToolResult` to keep the McpStatusDisplay
   * entry open (no `endMcpTracking` call). The compact one-line tool
   * call is closed separately via `onCompactDurationUpdate` so the user
   * still gets a `🟢 (Ns)` close on the inline tool bubble.
   */
  private isBackgroundTaskSpawnAck(toolResult: ToolResultEvent): boolean {
    if (toolResult.isError === true) return false;
    if (!this.backgroundTaskRegistry.hasAnyByToolUseId(toolResult.toolUseId)) return false;
    return extractTaskIdFromResult(toolResult.result) !== undefined;
  }

  /**
   * Format and send tool result message (skipped in compact mode).
   *
   * PHASE>=2 contract (Issue #664): when a `toolResultSink` is installed
   * and the context carries a `turnId`, the formatted result is absorbed
   * into the B1 stream instead of posted as a separate message. If the
   * sink returns `false` (turn closing, stream closed, Slack error, etc.)
   * we fall through to the legacy `context.say` path — tool output is
   * never silently dropped. PHASE<2 always uses the legacy path, so
   * pre-rollout behavior is unchanged.
   */
  private async sendToolResult(
    toolResult: ToolResultEvent,
    duration: number | null,
    context: ToolEventContext,
  ): Promise<void> {
    // In compact mode, results are handled via in-place updates — skip separate messages
    const resultMode = getToolResultRenderMode(context.logVerbosity ?? LOG_DETAIL);
    if (resultMode === 'compact' || resultMode === 'hidden') return;

    const result: ToolResult = {
      toolName: toolResult.toolName,
      toolUseId: toolResult.toolUseId,
      result: toolResult.result,
      isError: toolResult.isError,
    };

    const formatted = ToolFormatter.formatToolResult(result, duration, this.mcpCallTracker);
    if (!formatted) return;

    // PHASE>=2: try to absorb verbose output into the B1 stream so the
    // turn shows a single consolidated body instead of separate tool
    // bubbles. Read the phase per-call so a mid-test env flip takes
    // effect on the next event, matching TurnSurface.phase()'s behavior.
    if (config.ui.fiveBlockPhase >= 2 && this.toolResultSink && context.turnId) {
      const absorbed = await this.toolResultSink(context.turnId, formatted);
      if (absorbed) return;
      // Fallthrough: sink refused (no open stream, closing, Slack error).
      // Prefer a legacy bubble over a silent drop.
      this.logger.debug('tool-result sink returned false — falling back to legacy say', {
        turnId: context.turnId,
        toolUseId: toolResult.toolUseId,
      });
    }

    await context.say({
      text: formatted,
      thread_ts: context.threadTs,
    });
  }

  /**
   * Cleanup resources on abort or completion.
   *
   * Issue #794 — async + turn-scoped:
   *   - Async because `flushSession` waits on the McpStatusDisplay
   *     render chain to drain so the final "completed" line lands
   *     before we tear down. Sync-fire-and-forget would leave a stale
   *     "in flight" message on screen.
   *   - `turnId` is required to safely sweep callIds and bg Task
   *     entries belonging to this turn only. Same-session turn
   *     replacement (`session-initializer.ts:1138/1157`) reuses the
   *     `sessionKey`, so a session-wide sweep would false-complete
   *     calls owned by a newer turn that started before the old turn's
   *     cleanup ran. When `turnId` is absent (legacy callers), we fall
   *     back to the old `getActiveMcpCallIds()` global sweep — same
   *     race exposure as before, but no functional regression.
   *
   * Drain order matters:
   *   1. Background Bash entries (#688) — release their bg-bash
   *      counters BEFORE we close the display, otherwise the spinner
   *      text leaks past the turn.
   *   2. Background Task entries (#794) — `await endMcpTracking` so
   *      the McpStatusDisplay entries flip to `completed` with real
   *      duration before flushSession renders them.
   *   3. Outstanding callId sweep (turn-scoped or legacy global).
   *   4. `flushSession(sessionKey)` to await the final render and tear
   *      the session tick down.
   */
  async cleanup(sessionKey?: string, turnId?: string): Promise<void> {
    // Issue #688 — sweep any background bashes that never produced a
    // tool_result. Decrement their bg-bash counters BEFORE the general
    // activeMcpCallIds sweep below — otherwise the native spinner text
    // could continue to resolve to "waiting on background shell" after
    // the turn is gone. `endMcpTracking` also runs below for the same
    // callId via activeMcpCallIds, so we only touch the counter here and
    // let the existing `completeCall(callId, null)` close the display.
    if (sessionKey) {
      const bgEntries = this.backgroundBashRegistry.drain(sessionKey);
      for (const entry of bgEntries) {
        try {
          entry.unregister();
        } catch (err) {
          // Same warn-level rationale as handleToolResult's unregister catch.
          this.logger.warn('bg bash unregister threw during sweep', {
            sessionKey,
            toolUseId: entry.toolUseId,
            error: (err as Error)?.message ?? String(err),
          });
        }
      }
    }

    // Issue #794 — sweep any background Tasks that never produced a
    // non-ack tool_result before turn end. Each entry routes through
    // `endMcpTracking` so the McpCallTracker / McpStatusDisplay state
    // closes consistently with the foreground Task path.
    if (turnId) {
      const bgTaskEntries = this.backgroundTaskRegistry.drain(turnId);
      for (const entry of bgTaskEntries) {
        try {
          await this.endMcpTracking(entry.toolUseId, sessionKey);
        } catch (err) {
          this.logger.warn('bg Task endMcpTracking threw during cleanup sweep', {
            sessionKey,
            turnId,
            toolUseId: entry.toolUseId,
            error: (err as Error)?.message ?? String(err),
          });
        }
      }
    }

    // Complete any outstanding MCP calls. Turn-scoped sweep (preferred)
    // when the caller threaded `turnId` through; legacy global sweep
    // otherwise. The turn-scoped path closes only this turn's callIds —
    // critical for same-session turn replacement (cf. callIdsByTurn
    // field doc).
    if (turnId) {
      const turnCallIds = this.callIdsByTurn.get(turnId);
      if (turnCallIds) {
        for (const callId of turnCallIds) {
          this.mcpStatusDisplay.completeCall(callId, null);
        }
        this.callIdsByTurn.delete(turnId);
      }
    } else {
      // Legacy fallback — caller did not provide turnId. Same race
      // exposure as before this fix (same-session turn replacement may
      // false-complete the new turn's calls), but no functional
      // regression for callers that never had turnId.
      const activeMcpCallIds = this.toolTracker.getActiveMcpCallIds();
      for (const callId of activeMcpCallIds) {
        this.mcpStatusDisplay.completeCall(callId, null);
      }
    }

    // Cleanup session tick. `flushSession` (async) waits on the render
    // chain so the user sees the final "completed" line before the
    // tick stops; falls back to `cleanupSession` semantics when no
    // running calls remain. Older McpStatusDisplay implementations
    // (test mocks) may not expose `flushSession`, so we feature-detect
    // and fall back to the synchronous `cleanupSession`.
    if (sessionKey) {
      const display = this.mcpStatusDisplay as McpStatusDisplay & {
        flushSession?: (sessionKey: string) => Promise<void>;
      };
      if (typeof display.flushSession === 'function') {
        try {
          await display.flushSession(sessionKey);
        } catch (err) {
          this.logger.warn('mcpStatusDisplay.flushSession threw — falling back to cleanupSession', {
            sessionKey,
            error: (err as Error)?.message ?? String(err),
          });
          this.mcpStatusDisplay.cleanupSession(sessionKey);
        }
      } else {
        this.mcpStatusDisplay.cleanupSession(sessionKey);
      }
    }
  }
}

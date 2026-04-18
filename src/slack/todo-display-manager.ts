import { config } from '../config';
import { Logger } from '../logger';
import { parseTodos, type Todo, type TodoManager } from '../todo-manager';
import type { ConversationSession } from '../types';
import { LOG_DETAIL, OutputFlag, shouldOutput } from './output-flags';
import type { ReactionManager } from './reaction-manager';
import type { SlackApiHelper } from './slack-api-helper';
import type { TurnAddress } from './turn-surface';

export interface TodoUpdateInput {
  todos?: Todo[];
}

export type SayFunction = (message: { text: string; thread_ts: string }) => Promise<{ ts?: string }>;

/**
 * Callback to trigger a thread header re-render after todo changes.
 * Wired by stream-executor to ThreadPanel.updatePanel().
 */
export type RenderRequestCallback = (session: ConversationSession, sessionKey: string) => Promise<void>;

/**
 * Callback to render the TodoWrite snapshot as a dedicated B2 plan-block
 * Slack message (Issue #577, P2). Wired by slack-handler to
 * `ThreadPanel.renderTasks`. Only invoked under `SOMA_UI_5BLOCK_PHASE>=2`
 * AND when the caller supplies a `turnId` + `turnCtx` (i.e. inside a
 * stream-executor turn). The callback returns `false` when it decided not
 * to render — callers treat that as "stay with the legacy path only".
 */
export type PlanRenderCallback = (turnId: string, todos: Todo[], ctx: TurnAddress) => Promise<boolean>;

/**
 * Manages todo list display and updates in Slack.
 *
 * Task list rendering has been moved to the thread header message
 * via TaskListBlockBuilder + ThreadSurface. This manager:
 * 1. Stores todo state in TodoManager
 * 2. Sets task-list timestamps on the session for ETA display
 * 3. Triggers a header re-render via onRenderRequest callback
 * 4. Updates task-progress reactions
 */
export class TodoDisplayManager {
  private logger = new Logger('TodoDisplayManager');
  /** @deprecated Kept for backward compat; new path renders in thread header */
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs

  private onRenderRequest?: RenderRequestCallback;
  private onPlanRender?: PlanRenderCallback;

  constructor(
    private slackApi: SlackApiHelper,
    private todoManager: TodoManager,
    private reactionManager: ReactionManager,
  ) {}

  /**
   * Set the callback for re-rendering the thread header.
   * Must be called after construction (circular dep break).
   */
  setRenderRequestCallback(cb: RenderRequestCallback): void {
    this.onRenderRequest = cb;
  }

  /**
   * Set the callback for rendering the per-turn B2 plan-block message
   * (Issue #577). Must be called after construction (circular dep break).
   * If unset, `handleTodoUpdate` falls back to the legacy single-writer
   * path (`onRenderRequest` only) regardless of PHASE.
   */
  setPlanRenderCallback(cb: PlanRenderCallback): void {
    this.onPlanRender = cb;
  }

  /**
   * Handle a todo update event from the stream.
   * Updates todo state and triggers thread header re-render.
   *
   * Under `SOMA_UI_5BLOCK_PHASE>=2` with a live `turnId` + `turnCtx`, the
   * TodoWrite snapshot ALSO fans out to `onPlanRender` (→ TurnSurface's
   * `planTs` message). The legacy `onRenderRequest` still fires for the
   * combined header surface — `thread-surface.ts` has its own PHASE>=2
   * guard that skips the task-list embed, so both callbacks are safe to
   * invoke without double-rendering the todos.
   */
  async handleTodoUpdate(
    input: TodoUpdateInput,
    sessionKey: string,
    sessionId: string | undefined,
    channel: string,
    threadTs: string,
    say: SayFunction,
    logVerbosity?: number,
    session?: ConversationSession,
    turnId?: string,
    turnCtx?: TurnAddress,
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos = parseTodos(input.todos);
    if (newTodos === null) {
      this.logger.warn('handleTodoUpdate: input.todos is not an array, skipping', {
        sessionKey,
        receivedType: typeof input.todos,
      });
      return;
    }
    const oldTodos = this.todoManager.getTodos(sessionId);

    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);

      // Manage task-list timing on session
      if (session) {
        if (newTodos.length === 0) {
          // Tasks cleared — reset all timing so a new plan starts fresh
          session.taskListStartedAt = undefined;
          session.taskListCompletedAt = undefined;
        } else if (!session.taskListStartedAt) {
          // First todo registration — record start time
          session.taskListStartedAt = Date.now();
        }

        // Freeze completion timestamp when all tasks done (prevents drift on re-render)
        const allDone = newTodos.length > 0 && newTodos.every((t) => t.status === 'completed');
        if (allDone && !session.taskListCompletedAt) {
          session.taskListCompletedAt = Date.now();
        } else if (!allDone) {
          // Reset if tasks become active again (e.g. new tasks added after completion)
          session.taskListCompletedAt = undefined;
        }
      }

      // Fan out to TurnSurface.renderTasks BEFORE the legacy render request.
      // The two surfaces are independent Slack messages (planTs vs combined
      // header), so a failure on one must not block the other — hence no
      // gating on onRenderRequest's success.
      if (config.ui.fiveBlockPhase >= 2 && this.onPlanRender && turnId && turnCtx && newTodos.length > 0) {
        try {
          await this.onPlanRender(turnId, newTodos, turnCtx);
        } catch (error) {
          // Swallow — plan block is best-effort. The legacy path below
          // still covers the todos via combined-header fallback.
          this.logger.debug('Plan render callback failed', {
            sessionKey,
            turnId,
            error: (error as Error).message,
          });
        }
      }

      // Trigger thread header re-render (new path: task list in header)
      if (this.onRenderRequest && session) {
        try {
          await this.onRenderRequest(session, sessionKey);
          // Clean up legacy standalone message if header render succeeds
          this.todoMessages.delete(sessionKey);
        } catch (error) {
          this.logger.debug('Failed to trigger header re-render for todo update', {
            sessionKey,
            error: (error as Error).message,
          });
          // Fallback: post/update separate message (legacy behavior)
          await this.legacyUpdateMessage(newTodos, channel, threadTs, sessionKey, say);
        }
      } else {
        // No render callback: use legacy separate-message approach
        await this.legacyUpdateMessage(newTodos, channel, threadTs, sessionKey, say);
      }

      // Update reaction based on overall progress
      if (shouldOutput(OutputFlag.TODO_REACTION, logVerbosity ?? LOG_DETAIL)) {
        await this.reactionManager.updateTaskProgressReaction(sessionKey, newTodos);
      }
    }
  }

  /**
   * Legacy: post/update a separate message for the todo list.
   * Used as fallback when thread-header rendering is unavailable.
   */
  private async legacyUpdateMessage(
    newTodos: Todo[],
    channel: string,
    threadTs: string,
    sessionKey: string,
    say: SayFunction,
  ): Promise<void> {
    const todoList = this.todoManager.formatTodoList(newTodos);
    const existingTodoMessageTs = this.todoMessages.get(sessionKey);

    if (existingTodoMessageTs) {
      try {
        await this.slackApi.updateMessage(channel, existingTodoMessageTs, todoList);
        this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
      } catch (error) {
        this.logger.warn('Failed to update todo message, creating new one', error);
        await this.createNewMessage(todoList, channel, threadTs, sessionKey, say);
      }
    } else {
      await this.createNewMessage(todoList, channel, threadTs, sessionKey, say);
    }
  }

  private async createNewMessage(
    todoList: string,
    _channel: string,
    threadTs: string,
    sessionKey: string,
    say: SayFunction,
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });

    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  /**
   * Get the todo message timestamp for a session
   */
  getTodoMessageTs(sessionKey: string): string | undefined {
    return this.todoMessages.get(sessionKey);
  }

  /**
   * Clean up todo message tracking for a session
   */
  cleanup(sessionKey: string): void {
    this.todoMessages.delete(sessionKey);
    this.logger.debug('Cleaned up todo message tracking', { sessionKey });
  }

  /**
   * Clean up session data in TodoManager
   */
  cleanupSession(sessionId: string): void {
    this.todoManager.cleanupSession(sessionId);
  }
}

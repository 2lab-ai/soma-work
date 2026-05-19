import { Logger } from '@soma/common/logger';

import { LOG_DETAIL, OutputFlag, shouldOutput } from './output-flags';
import type { Todo } from './task-list-block-builder';

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);

let getFiveBlockPhase = (): number => Number(process.env.SOMA_UI_5BLOCK_PHASE ?? 0);

export function setTodoDisplayFiveBlockPhaseProvider(provider: () => number): void {
  getFiveBlockPhase = provider;
}

export interface TodoUpdateInput {
  todos?: Todo[];
}

export interface TodoConversationSession {
  taskListStartedAt?: number;
  taskListCompletedAt?: number;
}

export interface TodoManagerReader {
  getTodos(sessionId: string): Todo[];
  hasSignificantChange(oldTodos: Todo[], newTodos: Todo[]): boolean;
  updateTodos(sessionId: string, todos: Todo[]): void;
  formatTodoList(todos: Todo[]): string;
  cleanupSession(sessionId: string): void;
}

export interface TodoReactionManager {
  updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void>;
}

export interface TodoSlackApi {
  updateMessage(channel: string, ts: string, text: string): Promise<unknown>;
}

export interface TurnAddress {
  readonly channelId: string;
  readonly threadTs?: string;
  readonly sessionKey: string;
  readonly recipientUserId?: string;
  readonly recipientTeamId?: string;
  readonly statusEpoch?: number;
}

export type SayFunction = (message: { text: string; thread_ts: string }) => Promise<{ ts?: string }>;
export type RenderRequestCallback = (session: TodoConversationSession, sessionKey: string) => Promise<void>;
export type PlanRenderCallback = (turnId: string, todos: Todo[], ctx: TurnAddress) => Promise<boolean>;

function parseTodos(raw: unknown): Todo[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((item) => {
      if (item == null || typeof item !== 'object') return null;
      const src = item as Record<string, unknown>;
      if (typeof src.content !== 'string' || !VALID_STATUSES.has(src.status as string)) return null;
      const todo = { ...src };
      if (typeof todo.id !== 'string') todo.id = `todo-${simpleHash(src.content)}`;
      if (!VALID_PRIORITIES.has(todo.priority as string)) todo.priority = 'medium';
      return todo as unknown as Todo;
    })
    .filter((item): item is Todo => item !== null);
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class TodoDisplayManager {
  private logger = new Logger('TodoDisplayManager');
  private todoMessages: Map<string, string> = new Map();

  private onRenderRequest?: RenderRequestCallback;
  private onPlanRender?: PlanRenderCallback;

  constructor(
    private slackApi: TodoSlackApi,
    private todoManager: TodoManagerReader,
    private reactionManager: TodoReactionManager,
  ) {}

  setRenderRequestCallback(cb: RenderRequestCallback): void {
    this.onRenderRequest = cb;
  }

  setPlanRenderCallback(cb: PlanRenderCallback): void {
    this.onPlanRender = cb;
  }

  async handleTodoUpdate(
    input: TodoUpdateInput,
    sessionKey: string,
    sessionId: string | undefined,
    channel: string,
    threadTs: string,
    say: SayFunction,
    logVerbosity?: number,
    session?: TodoConversationSession,
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

    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      this.todoManager.updateTodos(sessionId, newTodos);

      if (session) {
        if (newTodos.length === 0) {
          session.taskListStartedAt = undefined;
          session.taskListCompletedAt = undefined;
        } else if (!session.taskListStartedAt) {
          session.taskListStartedAt = Date.now();
        }

        const allDone = newTodos.length > 0 && newTodos.every((todo) => todo.status === 'completed');
        if (allDone && !session.taskListCompletedAt) {
          session.taskListCompletedAt = Date.now();
        } else if (!allDone) {
          session.taskListCompletedAt = undefined;
        }
      }

      if (getFiveBlockPhase() >= 2 && this.onPlanRender && turnId && turnCtx && newTodos.length > 0) {
        try {
          await this.onPlanRender(turnId, newTodos, turnCtx);
        } catch (error) {
          this.logger.debug('Plan render callback failed', {
            sessionKey,
            turnId,
            error: readErrorMessage(error),
          });
        }
      }

      if (this.onRenderRequest && session) {
        try {
          await this.onRenderRequest(session, sessionKey);
          this.todoMessages.delete(sessionKey);
        } catch (error) {
          this.logger.debug('Failed to trigger header re-render for todo update', {
            sessionKey,
            error: readErrorMessage(error),
          });
          await this.legacyUpdateMessage(newTodos, channel, threadTs, sessionKey, say);
        }
      } else {
        await this.legacyUpdateMessage(newTodos, channel, threadTs, sessionKey, say);
      }

      if (shouldOutput(OutputFlag.TODO_REACTION, logVerbosity ?? LOG_DETAIL)) {
        await this.reactionManager.updateTaskProgressReaction(sessionKey, newTodos);
      }
    }
  }

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

  getTodoMessageTs(sessionKey: string): string | undefined {
    return this.todoMessages.get(sessionKey);
  }

  cleanup(sessionKey: string): void {
    this.todoMessages.delete(sessionKey);
    this.logger.debug('Cleaned up todo message tracking', { sessionKey });
  }

  cleanupSession(sessionId: string): void {
    this.todoManager.cleanupSession(sessionId);
  }
}

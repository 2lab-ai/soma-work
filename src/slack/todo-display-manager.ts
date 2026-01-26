import { WebClient } from '@slack/web-api';
import { TodoManager, Todo } from '../todo-manager';
import { ReactionManager } from './reaction-manager';
import { Logger } from '../logger';

export interface TodoUpdateInput {
  todos?: Todo[];
}

export interface SayFunction {
  (message: { text: string; thread_ts: string }): Promise<{ ts?: string }>;
}

/**
 * Manages todo list display and updates in Slack
 * Handles creating, updating, and tracking todo messages
 */
export class TodoDisplayManager {
  private logger = new Logger('TodoDisplayManager');
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs

  constructor(
    private client: WebClient,
    private todoManager: TodoManager,
    private reactionManager: ReactionManager
  ) {}

  /**
   * Handle a todo update event from the stream
   * Updates or creates todo message as needed
   */
  async handleTodoUpdate(
    input: TodoUpdateInput,
    sessionKey: string,
    sessionId: string | undefined,
    channel: string,
    threadTs: string,
    say: SayFunction
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);

    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);

      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);

      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);

      if (existingTodoMessageTs) {
        await this.updateExistingMessage(
          channel,
          existingTodoMessageTs,
          todoList,
          sessionKey,
          threadTs,
          say
        );
      } else {
        await this.createNewMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.reactionManager.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  /**
   * Update existing todo message
   */
  private async updateExistingMessage(
    channel: string,
    messageTs: string,
    todoList: string,
    sessionKey: string,
    threadTs: string,
    say: SayFunction
  ): Promise<void> {
    try {
      await this.client.chat.update({
        channel,
        ts: messageTs,
        text: todoList,
      });
      this.logger.debug('Updated existing todo message', { sessionKey, messageTs });
    } catch (error) {
      this.logger.warn('Failed to update todo message, creating new one', error);
      // If update fails, create a new message
      await this.createNewMessage(todoList, channel, threadTs, sessionKey, say);
    }
  }

  /**
   * Create new todo message
   */
  private async createNewMessage(
    todoList: string,
    channel: string,
    threadTs: string,
    sessionKey: string,
    say: SayFunction
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

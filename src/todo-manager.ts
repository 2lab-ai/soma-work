import { Logger } from './logger';

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
  /** IDs of tasks that must complete before this one can start */
  dependencies?: string[];
  /** Present-continuous form shown during execution (e.g. "Running tests") */
  activeForm?: string;
  /** Epoch ms when task transitioned to in_progress */
  startedAt?: number;
  /** Epoch ms when task transitioned to completed */
  completedAt?: number;
}

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);

/**
 * Validate and sanitize raw input into a Todo array.
 * Returns null if the input is not a valid array (caller should reject).
 * Individual malformed items are filtered out, not the whole batch.
 */
export function parseTodos(raw: unknown): Todo[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((item): item is Todo => {
    if (item == null || typeof item !== 'object') return false;
    const t = item as Record<string, unknown>;
    return (
      typeof t.id === 'string' &&
      typeof t.content === 'string' &&
      VALID_STATUSES.has(t.status as string) &&
      VALID_PRIORITIES.has(t.priority as string)
    );
  });
}

export class TodoManager {
  private logger = new Logger('TodoManager');
  private todos: Map<string, Todo[]> = new Map(); // sessionId -> todos
  private _onUpdate: ((sessionId: string, todos: Todo[]) => void) | null = null;

  setOnUpdateCallback(fn: (sessionId: string, todos: Todo[]) => void): void {
    this._onUpdate = fn;
  }

  updateTodos(sessionId: string, todos: Todo[]): void {
    const validated = parseTodos(todos);
    if (validated === null) {
      // Non-array payload — reject and preserve last-known-good state
      this.logger.warn('updateTodos rejected non-array payload, keeping previous state', {
        sessionId,
        receivedType: typeof todos,
        receivedValue: String(todos).slice(0, 200),
      });
      return;
    }

    // ── Timing: carry over / stamp startedAt & completedAt ──
    const previous = this.todos.get(sessionId) || [];
    const now = Date.now();
    for (const task of validated) {
      const prev = previous.find((p) => p.id === task.id);
      if (prev) {
        // Carry forward existing timestamps
        if (prev.startedAt && !task.startedAt) task.startedAt = prev.startedAt;
        if (prev.completedAt && !task.completedAt) task.completedAt = prev.completedAt;
      }
      // Stamp on status transitions (handle regressions too)
      if (task.status === 'pending') {
        // Regressed to pending — clear all timing
        task.startedAt = undefined;
        task.completedAt = undefined;
      } else if (task.status === 'in_progress') {
        if (!task.startedAt) task.startedAt = now;
        task.completedAt = undefined; // clear stale completion on rework
      } else if (task.status === 'completed') {
        if (!task.startedAt) task.startedAt = now; // edge case: jumped straight to completed
        if (!task.completedAt) task.completedAt = now;
      }
    }

    this.todos.set(sessionId, validated);
    if (this._onUpdate) this._onUpdate(sessionId, validated);
    this.logger.debug('Updated todos for session', {
      sessionId,
      todoCount: validated.length,
      pending: validated.filter((t) => t.status === 'pending').length,
      inProgress: validated.filter((t) => t.status === 'in_progress').length,
      completed: validated.filter((t) => t.status === 'completed').length,
    });
  }

  getTodos(sessionId: string): Todo[] {
    return this.todos.get(sessionId) || [];
  }

  formatTodoList(todos: Todo[]): string {
    if (todos.length === 0) {
      return '📋 *Task List*\n\nNo tasks defined yet.';
    }

    let message = '📋 *Task List*\n\n';

    // Group by status
    const pending = todos.filter((t) => t.status === 'pending');
    const inProgress = todos.filter((t) => t.status === 'in_progress');
    const completed = todos.filter((t) => t.status === 'completed');

    // Show in-progress tasks first
    if (inProgress.length > 0) {
      message += '*🔄 In Progress:*\n';
      for (const todo of inProgress) {
        const priority = this.getPriorityIcon(todo.priority);
        message += `${priority} ${todo.content}\n`;
      }
      message += '\n';
    }

    // Then pending tasks
    if (pending.length > 0) {
      message += '*⏳ Pending:*\n';
      for (const todo of pending) {
        const priority = this.getPriorityIcon(todo.priority);
        message += `${priority} ${todo.content}\n`;
      }
      message += '\n';
    }

    // Finally completed tasks
    if (completed.length > 0) {
      message += '*✅ Completed:*\n';
      for (const todo of completed) {
        const priority = this.getPriorityIcon(todo.priority);
        message += `${priority} ~${todo.content}~\n`;
      }
    }

    // Add progress summary
    const total = todos.length;
    const completedCount = completed.length;
    const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0;

    message += `\n*Progress:* ${completedCount}/${total} tasks completed (${progress}%)`;

    return message;
  }

  private getPriorityIcon(priority: string): string {
    switch (priority) {
      case 'high':
        return '🔴';
      case 'medium':
        return '🟡';
      case 'low':
        return '🟢';
      default:
        return '⚪';
    }
  }

  hasSignificantChange(oldTodos: Todo[], newTodos: Todo[]): boolean {
    // Check if task count changed
    if (oldTodos.length !== newTodos.length) {
      return true;
    }

    // Check if any task status, activeForm, content, or dependencies changed
    for (const newTodo of newTodos) {
      const oldTodo = oldTodos.find((t) => t.id === newTodo.id);
      if (
        !oldTodo ||
        oldTodo.status !== newTodo.status ||
        oldTodo.activeForm !== newTodo.activeForm ||
        oldTodo.content !== newTodo.content ||
        JSON.stringify(oldTodo.dependencies) !== JSON.stringify(newTodo.dependencies)
      ) {
        return true;
      }
    }

    return false;
  }

  getStatusChange(oldTodos: Todo[], newTodos: Todo[]): string | null {
    // Find status changes
    const changes: string[] = [];

    for (const newTodo of newTodos) {
      const oldTodo = oldTodos.find((t) => t.id === newTodo.id);

      if (!oldTodo) {
        // New task added
        changes.push(`➕ Added: ${newTodo.content}`);
      } else if (oldTodo.status !== newTodo.status) {
        // Status changed
        const statusEmoji = {
          pending: '⏳',
          in_progress: '🔄',
          completed: '✅',
        };

        changes.push(`${statusEmoji[newTodo.status]} ${newTodo.content}`);
      }
    }

    // Check for removed tasks
    for (const oldTodo of oldTodos) {
      if (!newTodos.find((t) => t.id === oldTodo.id)) {
        changes.push(`➖ Removed: ${oldTodo.content}`);
      }
    }

    return changes.length > 0 ? changes.join('\n') : null;
  }

  /**
   * Check if a task is blocked by incomplete dependencies.
   * A missing dependency (dangling ref) is treated as blocking (safe default).
   */
  isBlocked(todo: Todo, allTodos: Todo[]): boolean {
    if (!todo.dependencies || todo.dependencies.length === 0) return false;
    return todo.dependencies.some((depId) => {
      const dep = allTodos.find((t) => t.id === depId);
      // Missing dep → treat as blocking (dangling ref should not unblock)
      if (!dep) return true;
      return dep.status !== 'completed';
    });
  }

  /**
   * Get the effective display status of a task (accounts for dependencies).
   * Returns 'blocked' if task is pending but has incomplete dependencies.
   */
  getEffectiveStatus(todo: Todo, allTodos: Todo[]): 'completed' | 'in_progress' | 'pending' | 'blocked' {
    if (todo.status === 'completed') return 'completed';
    if (todo.status === 'in_progress') return 'in_progress';
    if (this.isBlocked(todo, allTodos)) return 'blocked';
    return 'pending';
  }

  cleanupSession(sessionId: string): void {
    this.todos.delete(sessionId);
    this.logger.debug('Cleaned up todos for session', { sessionId });
  }
}

import { Todo, TodoManager } from '../todo-manager';

/** Slack section text limit is 3000 chars; leave margin for mrkdwn overhead */
const MAX_SECTION_TEXT_LENGTH = 2800;
/** Max content length per task before truncation */
const MAX_TASK_CONTENT_LENGTH = 80;
/** Slack messages can have at most 50 blocks */
const MAX_TASK_LIST_BLOCKS = 5;

/**
 * Theme modes for the task list display.
 *
 * Each mode answers a different user question:
 * - checklist: "What are all tasks and their statuses?" (full audit)
 * - queue: "What is open and what's next?" (workflow state groups)
 * - pulse: "Moving, blocked, or done?" (2-second status signal)
 */
export type TaskListTheme = 'checklist' | 'queue' | 'pulse';

/**
 * Escape user-supplied text for safe embedding in Slack mrkdwn.
 * Neutralizes formatting chars, mentions, links, and newlines.
 */
function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*/g, '\u2217')   // asterisk operator
    .replace(/~/g, '\u223C')    // tilde operator
    .replace(/_/g, '\u02CD')    // modifier letter low macron
    .replace(/`/g, '\u02BC')    // modifier letter apostrophe
    .replace(/\n/g, ' ');       // flatten newlines
}

export interface TaskListBuildOptions {
  startedAt?: number;
  completedAt?: number;
  theme?: TaskListTheme;
}

/**
 * Renders a task list as Slack Block Kit blocks for embedding in the thread header.
 *
 * Three theme modes:
 *   checklist — full audit with individual task rows (default)
 *   queue     — grouped by workflow state (Now / Up Next / Blocked)
 *   pulse     — single status signal for 2-second read
 */
export class TaskListBlockBuilder {
  constructor(private todoManager: TodoManager) {}

  /**
   * Build Block Kit blocks for the task list.
   * Returns empty array if no todos exist.
   */
  buildBlocks(todos: Todo[], options?: TaskListBuildOptions): any[] {
    if (!todos || todos.length === 0) return [];

    const theme = options?.theme ?? 'checklist';

    switch (theme) {
      case 'queue':
        return this.buildQueueBlocks(todos, options);
      case 'pulse':
        return this.buildPulseBlocks(todos, options);
      case 'checklist':
      default:
        return this.buildChecklistBlocks(todos, options);
    }
  }

  // ===========================================================================
  // CHECKLIST MODE — "What are all tasks and their statuses?"
  // ===========================================================================

  private buildChecklistBlocks(todos: Todo[], options?: TaskListBuildOptions): any[] {
    const blocks: any[] = [];
    const { completed, total, pct } = this.getProgress(todos);

    // ── Divider ──
    blocks.push({ type: 'divider' });

    // ── Title (section anchor) ──
    const checkmark = pct === 100 ? ' :white_check_mark:' : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *Task List* \u00B7 *${completed}/${total} done* (${pct}%)${checkmark}`,
      },
    });

    // ── Task items ──
    const taskLines = this.buildChecklistLines(todos);
    const truncatedLines = taskLines.length > MAX_SECTION_TEXT_LENGTH
      ? taskLines.slice(0, MAX_SECTION_TEXT_LENGTH - 20) + '\n_\u2026truncated_'
      : taskLines;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncatedLines },
    });

    // ── Footer context ──
    const footerParts: string[] = [];
    if (pct === 100) {
      const elapsed = this.getElapsedText(options);
      footerParts.push(`:white_check_mark: *All ${total} tasks completed*${elapsed ? ` in ${elapsed}` : ''}`);
      const timeRange = this.getTimeRange(options);
      if (timeRange) footerParts.push(timeRange);
    } else {
      const activeTask = todos.find(t => t.status === 'in_progress');
      if (activeTask?.activeForm) {
        footerParts.push(`\u25B8 _${this.truncateContent(activeTask.activeForm)}_`);
      }
      if (options?.startedAt) {
        footerParts.push(`Started ${this.formatTime(options.startedAt)}`);
      }
    }

    if (footerParts.length > 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: footerParts.join('  \uFF5C  ') }],
      });
    }

    return blocks;
  }

  private buildChecklistLines(todos: Todo[]): string {
    const lines: string[] = [];

    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const effectiveStatus = this.todoManager.getEffectiveStatus(todo, todos);
      const num = i + 1;
      const content = this.truncateContent(todo.content);

      switch (effectiveStatus) {
        case 'completed':
          lines.push(`\u2713  ~#${num} ${content}~`);
          break;
        case 'in_progress':
          lines.push(`\uD83D\uDFE2  *#${num} ${content}*`);
          break;
        case 'blocked':
          lines.push(this.buildBlockedLine(todo, num, todos, content));
          break;
        case 'pending':
        default:
          lines.push(`\u25CB  #${num} ${content}`);
          break;
      }
    }

    return lines.join('\n');
  }

  // ===========================================================================
  // QUEUE MODE — "What is open and what's next?"
  // ===========================================================================

  private buildQueueBlocks(todos: Todo[], options?: TaskListBuildOptions): any[] {
    const blocks: any[] = [];
    const { completed, total, pct } = this.getProgress(todos);

    blocks.push({ type: 'divider' });

    // ── Title ──
    const checkmark = pct === 100 ? ' :white_check_mark:' : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *Queue* \u00B7 ${completed}/${total} done (${pct}%)${checkmark}`,
      },
    });

    if (pct === 100) {
      // Completed: just footer
      const footerParts: string[] = [];
      const elapsed = this.getElapsedText(options);
      footerParts.push(`:white_check_mark: *All tasks completed*${elapsed ? ` in ${elapsed}` : ''}`);
      const timeRange = this.getTimeRange(options);
      if (timeRange) footerParts.push(timeRange);
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: footerParts.join('  \uFF5C  ') }],
      });
      return blocks;
    }

    // ── State-grouped task section ──
    const groups = this.groupByState(todos);
    const groupLines: string[] = [];

    if (groups.inProgress.length > 0) {
      groupLines.push(`\uD83D\uDFE2 *Now*`);
      for (const { index, todo } of groups.inProgress) {
        groupLines.push(`\u2219 #${index} ${this.truncateContent(todo.content)}`);
      }
    }

    if (groups.pending.length > 0) {
      if (groupLines.length > 0) groupLines.push('');
      groupLines.push(`\u25B8 *Up Next*`);
      for (const { index, todo } of groups.pending) {
        groupLines.push(`\u2219 #${index} ${this.truncateContent(todo.content)}`);
      }
    }

    if (groups.blocked.length > 0) {
      if (groupLines.length > 0) groupLines.push('');
      groupLines.push(`:lock: *Blocked*`);
      for (const { index, todo } of groups.blocked) {
        const depLabel = this.getDepLabel(todo, todos);
        groupLines.push(`\u2219 #${index} ${this.truncateContent(todo.content)}${depLabel ? ` \u00B7 _waiting for ${depLabel}_` : ''}`);
      }
    }

    const groupText = groupLines.join('\n');
    const truncatedGroup = groupText.length > MAX_SECTION_TEXT_LENGTH
      ? groupText.slice(0, MAX_SECTION_TEXT_LENGTH - 20) + '\n_\u2026truncated_'
      : groupText;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncatedGroup },
    });

    // ── Footer context ──
    const footerParts: string[] = [];
    const activeTask = todos.find(t => t.status === 'in_progress');
    if (activeTask?.activeForm) {
      footerParts.push(`_${this.truncateContent(activeTask.activeForm)}_`);
    }
    footerParts.push(`\u2713 ${completed} done`);
    if (options?.startedAt) {
      footerParts.push(`Started ${this.formatTime(options.startedAt)}`);
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: footerParts.join('  \uFF5C  ') }],
    });

    return blocks;
  }

  // ===========================================================================
  // PULSE MODE — "Moving, blocked, or done?"
  // ===========================================================================

  private buildPulseBlocks(todos: Todo[], options?: TaskListBuildOptions): any[] {
    const blocks: any[] = [];
    const { completed, total, pct } = this.getProgress(todos);

    blocks.push({ type: 'divider' });

    if (pct === 100) {
      // Completed: single context line
      const elapsed = this.getElapsedText(options);
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `:clipboard: *Done* \u00B7 ${total}/${total} :white_check_mark:${elapsed ? ` ${elapsed}` : ''}`,
        }],
      });
      return blocks;
    }

    // In progress: section for visibility
    const parts: string[] = [];
    parts.push(`:clipboard: *${completed}/${total}*`);

    const activeTask = todos.find(t => t.status === 'in_progress');
    if (activeTask) {
      const name = this.truncateContent(activeTask.content);
      const sub = activeTask.activeForm ? ` _${this.truncateContent(activeTask.activeForm)}_` : '';
      parts.push(`\uD83D\uDFE2 *${name}*${sub}`);
    }

    const blockedCount = todos.filter(t => {
      const eff = this.todoManager.getEffectiveStatus(t, todos);
      return eff === 'blocked';
    }).length;
    if (blockedCount > 0) {
      parts.push(`:lock: ${blockedCount} blocked`);
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: parts.join('  \uFF5C  ') },
    });

    return blocks;
  }

  // ===========================================================================
  // Shared helpers
  // ===========================================================================

  private getProgress(todos: Todo[]): { completed: number; total: number; pct: number } {
    const completed = todos.filter(t => t.status === 'completed').length;
    const total = todos.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, total, pct };
  }

  private groupByState(todos: Todo[]): {
    inProgress: Array<{ index: number; todo: Todo }>;
    pending: Array<{ index: number; todo: Todo }>;
    blocked: Array<{ index: number; todo: Todo }>;
  } {
    const inProgress: Array<{ index: number; todo: Todo }> = [];
    const pending: Array<{ index: number; todo: Todo }> = [];
    const blocked: Array<{ index: number; todo: Todo }> = [];

    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const eff = this.todoManager.getEffectiveStatus(todo, todos);
      const entry = { index: i + 1, todo };

      switch (eff) {
        case 'in_progress':
          inProgress.push(entry);
          break;
        case 'blocked':
          blocked.push(entry);
          break;
        case 'pending':
          pending.push(entry);
          break;
        // completed tasks are hidden in queue mode
      }
    }

    return { inProgress, pending, blocked };
  }

  private buildBlockedLine(todo: Todo, num: number, allTodos: Todo[], content: string): string {
    const depLabel = this.getDepLabel(todo, allTodos);
    return `:lock:  #${num} ${content}${depLabel ? ` \u00B7 _blocked by ${depLabel}_` : ''}`;
  }

  private getDepLabel(todo: Todo, allTodos: Todo[]): string {
    if (!todo.dependencies || todo.dependencies.length === 0) return '';
    return todo.dependencies
      .map(depId => {
        const idx = allTodos.findIndex(t => t.id === depId);
        return idx >= 0 ? `#${idx + 1}` : `#${depId}`;
      })
      .join(',');
  }

  /**
   * Check if an in-progress task flows from completed dependencies.
   * Shows arrow when the task has explicit deps and all are completed,
   * OR when the previous task in the list is completed (sequential flow).
   */
  private flowsFromDeps(todo: Todo, allTodos: Todo[]): boolean {
    if (todo.status !== 'in_progress') return false;
    if (todo.dependencies && todo.dependencies.length > 0) {
      return todo.dependencies.every(depId => {
        const dep = allTodos.find(t => t.id === depId);
        return dep?.status === 'completed';
      });
    }
    const idx = allTodos.indexOf(todo);
    if (idx > 0) {
      return allTodos[idx - 1].status === 'completed';
    }
    return false;
  }

  /** Truncate and escape task content for safe mrkdwn embedding */
  private truncateContent(text: string): string {
    const escaped = escapeMrkdwn(text);
    if (escaped.length <= MAX_TASK_CONTENT_LENGTH) return escaped;
    return escaped.slice(0, MAX_TASK_CONTENT_LENGTH - 1) + '\u2026';
  }

  private getElapsedText(options?: TaskListBuildOptions): string {
    if (!options?.startedAt || !options?.completedAt) return '';
    return this.formatDuration(options.completedAt - options.startedAt);
  }

  private getTimeRange(options?: TaskListBuildOptions): string {
    if (!options?.startedAt) return '';
    const start = this.formatTime(options.startedAt);
    if (options?.completedAt) {
      return `${start} \u2192 ${this.formatTime(options.completedAt)}`;
    }
    return start;
  }

  /**
   * Format timestamp as Slack date token so each viewer sees their local time.
   * Falls back to UTC HH:MM if timestamp is invalid.
   */
  private formatTime(ts: number): string {
    const epoch = Math.floor(ts / 1000);
    if (!Number.isFinite(epoch) || epoch <= 0) {
      const d = new Date(ts);
      return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
    }
    return `<!date^${epoch}^{time}|${new Date(ts).toISOString().slice(11, 16)}>`;
  }

  private formatDuration(ms: number): string {
    const totalMinutes = Math.round(ms / 60_000);
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
}

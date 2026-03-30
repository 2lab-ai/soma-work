import { Todo, TodoManager } from '../todo-manager';

/** Slack section text limit is 3000 chars; leave margin for mrkdwn overhead */
const MAX_SECTION_TEXT_LENGTH = 2800;
/** Max content length per task before truncation */
const MAX_TASK_CONTENT_LENGTH = 80;

/**
 * Renders a task list as Slack Block Kit blocks for embedding in the thread header.
 *
 * Layout (as blocks):
 *   divider
 *   context  — 🕐 Start: HH:MM — Estimated: HH:MM
 *   section  — 📋 *Task List*  +  progress bar
 *   section  — task items with status icons + deps
 *   context  — *Progress:* X/Y completed (Z%)
 */
export class TaskListBlockBuilder {
  constructor(private todoManager: TodoManager) {}

  /**
   * Build Block Kit blocks for the task list.
   * Returns empty array if no todos exist.
   */
  buildBlocks(
    todos: Todo[],
    options?: {
      startedAt?: number;
      completedAt?: number;
    },
  ): any[] {
    if (!todos || todos.length === 0) return [];

    const blocks: any[] = [];

    // ── Divider ──
    blocks.push({ type: 'divider' });

    // ── Time context ──
    const timeText = this.buildTimeText(options?.startedAt, options?.completedAt, todos);
    if (timeText) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: timeText }],
      });
    }

    // ── Title + progress bar ──
    const completed = todos.filter(t => t.status === 'completed').length;
    const total = todos.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const progressBar = this.renderProgressBar(pct);
    const checkmark = pct === 100 ? '  :white_check_mark:' : '';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *Task List*\n*\`${progressBar} ${pct}%  ${completed}/${total}\`*${checkmark}`,
      },
    });

    // ── Task items ──
    const taskLines = this.buildTaskLines(todos);
    // Guard against Slack's 3000-char section text limit
    const truncatedLines = taskLines.length > MAX_SECTION_TEXT_LENGTH
      ? taskLines.slice(0, MAX_SECTION_TEXT_LENGTH - 20) + '\n_…truncated_'
      : taskLines;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncatedLines },
    });

    // ── Progress footer ──
    const footerText = this.buildFooterText(todos, completed, total, pct, options);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: footerText }],
    });

    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Task line rendering
  // ---------------------------------------------------------------------------

  private buildTaskLines(todos: Todo[]): string {
    const lines: string[] = [];

    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const effectiveStatus = this.todoManager.getEffectiveStatus(todo, todos);
      const num = i + 1;
      const content = this.truncateContent(todo.content);

      let line = '';

      // Arrow prefix: show when an in-progress task has all dependencies completed
      const arrow = this.flowsFromDeps(todo, todos) ? '→ ' : '';

      switch (effectiveStatus) {
        case 'completed':
          line = `⚫  ${num}  ~${content}~`;
          break;
        case 'in_progress':
          line = `${arrow}🟢  *${num}*  ${content}`;
          break;
        case 'blocked':
          line = this.buildBlockedLine(todo, num, todos, content);
          break;
        case 'pending':
        default:
          line = `⚪  ${num}  ${content}`;
          break;
      }

      lines.push(line);

      // Sub-status line for in-progress tasks
      if (effectiveStatus === 'in_progress' && todo.activeForm) {
        const activeContent = this.truncateContent(todo.activeForm);
        lines.push(`      • _${activeContent}_`);
      }
    }

    return lines.join('\n');
  }

  private buildBlockedLine(todo: Todo, num: number, allTodos: Todo[], content: string): string {
    const depLabels = (todo.dependencies || [])
      .map(depId => {
        const idx = allTodos.findIndex(t => t.id === depId);
        return idx >= 0 ? `#${idx + 1}` : `#${depId}`;
      })
      .join(',');
    return `🔒  ${num}  ${content}  \`deps:${depLabels}\``;
  }

  /**
   * Check if an in-progress task flows from completed dependencies.
   * Shows arrow (→) when the task has explicit deps and all are completed,
   * OR when the previous task in the list is completed (sequential flow).
   */
  private flowsFromDeps(todo: Todo, allTodos: Todo[]): boolean {
    if (todo.status !== 'in_progress') return false;
    // Explicit dependencies: all completed → show arrow
    if (todo.dependencies && todo.dependencies.length > 0) {
      return todo.dependencies.every(depId => {
        const dep = allTodos.find(t => t.id === depId);
        return dep?.status === 'completed';
      });
    }
    // Implicit: previous task in list is completed (sequential fallback)
    const idx = allTodos.indexOf(todo);
    if (idx > 0) {
      return allTodos[idx - 1].status === 'completed';
    }
    return false;
  }

  /** Truncate task content to prevent overflow */
  private truncateContent(text: string): string {
    if (text.length <= MAX_TASK_CONTENT_LENGTH) return text;
    return text.slice(0, MAX_TASK_CONTENT_LENGTH - 1) + '…';
  }

  // ---------------------------------------------------------------------------
  // Progress bar
  // ---------------------------------------------------------------------------

  private renderProgressBar(pct: number): string {
    const totalSegments = 10;
    const filled = Math.round((pct / 100) * totalSegments);
    const empty = totalSegments - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }

  // ---------------------------------------------------------------------------
  // Time & footer text
  // ---------------------------------------------------------------------------

  private buildTimeText(
    startedAt?: number,
    completedAt?: number,
    todos?: Todo[],
  ): string | null {
    if (!startedAt) return null;

    const startStr = this.formatTime(startedAt);
    const allDone = todos?.every(t => t.status === 'completed');

    if (allDone && completedAt) {
      return `:clock1: Start: ${startStr} — Finished: ${this.formatTime(completedAt)}`;
    }

    return `:clock1: Start: ${startStr}`;
  }

  private buildFooterText(
    todos: Todo[],
    completed: number,
    total: number,
    pct: number,
    options?: { startedAt?: number; completedAt?: number },
  ): string {
    if (pct === 100) {
      const elapsed = (options?.startedAt && options?.completedAt)
        ? this.formatDuration(options.completedAt - options.startedAt)
        : '';
      return `:white_check_mark: *All ${total} tasks completed*${elapsed ? ` in ${elapsed}` : ''}`;
    }

    return `*Progress:* ${completed}/${total} tasks completed (${pct}%)`;
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  private formatTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }

  private formatDuration(ms: number): string {
    const totalMinutes = Math.round(ms / 60_000);
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
}

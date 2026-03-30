import { Todo, TodoManager } from '../todo-manager';

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
      estimatedEndAt?: number;
    },
  ): any[] {
    if (!todos || todos.length === 0) return [];

    const blocks: any[] = [];

    // ── Divider ──
    blocks.push({ type: 'divider' });

    // ── Time context ──
    const timeText = this.buildTimeText(options?.startedAt, options?.estimatedEndAt, todos);
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
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: taskLines },
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
      const flowsFromPrev = this.todoManager.flowsFromCompleted(todo, i, todos);
      const num = i + 1;

      let line = '';

      // Arrow prefix for tasks flowing from completed predecessor
      const arrow = flowsFromPrev ? '→ ' : '';

      switch (effectiveStatus) {
        case 'completed':
          line = `⚫  ${num}  ~${todo.content}~`;
          break;
        case 'in_progress':
          line = `${arrow}🟢  *${num}*  ${todo.content}`;
          break;
        case 'blocked':
          line = this.buildBlockedLine(todo, num, todos);
          break;
        case 'pending':
        default:
          line = `⚪  ${num}  ${todo.content}`;
          break;
      }

      lines.push(line);

      // Sub-status line for in-progress tasks
      if (effectiveStatus === 'in_progress' && todo.activeForm) {
        lines.push(`      • _${todo.activeForm}_`);
      }
    }

    return lines.join('\n');
  }

  private buildBlockedLine(todo: Todo, num: number, allTodos: Todo[]): string {
    const depLabels = (todo.dependencies || [])
      .map(depId => {
        const idx = allTodos.findIndex(t => t.id === depId);
        return idx >= 0 ? `#${idx + 1}` : `#${depId}`;
      })
      .join(',');
    return `🔒  ${num}  ${todo.content}  \`deps:${depLabels}\``;
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
    estimatedEndAt?: number,
    todos?: Todo[],
  ): string | null {
    if (!startedAt) return null;

    const startStr = this.formatTime(startedAt);

    if (estimatedEndAt) {
      const allDone = todos?.every(t => t.status === 'completed');
      if (allDone) {
        return `:clock1: Start: ${startStr} — Finished: ${this.formatTime(Date.now())}`;
      }
      return `:clock1: Start: ${startStr} — Estimated: ${this.formatTime(estimatedEndAt)}`;
    }

    return `:clock1: Start: ${startStr}`;
  }

  private buildFooterText(
    todos: Todo[],
    completed: number,
    total: number,
    pct: number,
    options?: { startedAt?: number; estimatedEndAt?: number },
  ): string {
    if (pct === 100) {
      const elapsed = options?.startedAt
        ? this.formatDuration(Date.now() - options.startedAt)
        : '';
      return `:white_check_mark: *All ${total} tasks completed*${elapsed ? ` in ${elapsed}` : ''}`;
    }

    let footer = `*Progress:* ${completed}/${total} tasks completed (${pct}%)`;

    // Add remaining time estimate
    if (options?.estimatedEndAt) {
      const remaining = options.estimatedEndAt - Date.now();
      if (remaining > 0) {
        footer += `  |  :hourglass_flowing_sand: ~${this.formatDuration(remaining)} 남음`;
      }
    }

    return footer;
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
    if (totalMinutes < 60) return `${totalMinutes}분`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
}

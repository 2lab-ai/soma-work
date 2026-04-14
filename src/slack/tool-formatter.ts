/**
 * Tool formatting utilities for Slack bot
 */
import { McpCallTracker } from '../mcp-call-tracker';
import type { RenderMode } from './output-flags';

// Bot display name for tool notifications (set once at startup via setBotDisplayName)
let _botDisplayName = 'Soma';

/** Set the bot's display name for tool notifications (call once at startup). */
export function setBotDisplayName(name: string): void {
  _botDisplayName = name;
}

export interface ToolResult {
  toolName?: string;
  toolUseId: string;
  result: any;
  isError?: boolean;
}

export interface TaskToolSummary {
  subagentType?: string;
  subagentLabel?: string;
  model?: string;
  runInBackground?: boolean;
  promptLength?: number;
  promptPreview?: string;
}

export interface ToolUseLogSummary {
  toolUseId: string;
  toolName: string;
  inputKeys: string[];
  inputKeyCount: number;
  task?: TaskToolSummary;
}

export class ToolFormatter {
  private static readonly TASK_PROMPT_PREVIEW_LENGTH = 180;
  private static readonly SUBAGENT_DISPLAY_MAP: Record<string, { label: string; model?: string }> = {
    'oh-my-claude:explore': { label: 'Explorer', model: 'opus' },
    'oh-my-claude:librarian': { label: 'Librarian', model: 'opus' },
    'oh-my-claude:oracle': { label: 'Oracle', model: 'opus' },
    'oh-my-claude:reviewer': { label: 'Reviewer', model: 'opus' },
  };

  private static sanitizeInlineValue(value: string): string {
    return value.replace(/`/g, "'");
  }

  private static titleCaseSubagent(raw: string): string {
    return raw
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  /**
   * Truncate a string to max length, adding ellipsis if truncated
   */
  static truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  /**
   * Format Edit or MultiEdit tool usage
   */
  static formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits =
      toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];

    let result = `📝 *Editing \`${filePath}\`*\n`;

    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${ToolFormatter.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${ToolFormatter.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }

    return result;
  }

  /**
   * Format Write tool usage
   */
  static formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = ToolFormatter.truncateString(input.content, 300);

    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  /**
   * Format Read tool usage
   */
  static formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  /**
   * Format Bash tool usage
   */
  static formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  /**
   * Format MCP input parameters
   */
  static formatMcpInput(input: any): string {
    if (!input || typeof input !== 'object') {
      return '';
    }

    const lines: string[] = [];

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;

      if (typeof value === 'string') {
        const displayValue = value.length > 500 ? value.substring(0, 500) + '...' : value;

        if (displayValue.includes('\n')) {
          lines.push(`*${key}:*\n\`\`\`\n${displayValue}\n\`\`\``);
        } else {
          lines.push(`*${key}:* \`${displayValue}\``);
        }
      } else if (typeof value === 'object') {
        try {
          const jsonStr = JSON.stringify(value, null, 2);
          const truncated = jsonStr.length > 300 ? jsonStr.substring(0, 300) + '...' : jsonStr;
          lines.push(`*${key}:*\n\`\`\`json\n${truncated}\n\`\`\``);
        } catch {
          lines.push(`*${key}:* [complex object]`);
        }
      } else {
        lines.push(`*${key}:* \`${String(value)}\``);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format MCP tool usage
   */
  static formatMcpTool(toolName: string, input: any): string {
    // Parse MCP tool name: mcp__serverName__toolName
    const parts = toolName.split('__');
    const serverName = parts[1] || 'unknown';
    const actualToolName = parts.slice(2).join('__') || toolName;

    let result = `🔌 *MCP: ${serverName} → ${actualToolName}*\n`;

    if (input && typeof input === 'object') {
      const inputStr = ToolFormatter.formatMcpInput(input);
      if (inputStr) {
        result += inputStr;
      }
    }

    return result;
  }

  /**
   * Build Task tool summary from tool input
   */
  static getTaskToolSummary(input: unknown): TaskToolSummary {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {};
    }

    const taskInput = input as {
      subagent_type?: unknown;
      model?: unknown;
      run_in_background?: unknown;
      prompt?: unknown;
    };

    const summary: TaskToolSummary = {};

    if (typeof taskInput.subagent_type === 'string' && taskInput.subagent_type.trim()) {
      summary.subagentType = taskInput.subagent_type.trim();
      const mapped = ToolFormatter.SUBAGENT_DISPLAY_MAP[summary.subagentType];
      if (mapped) {
        summary.subagentLabel = mapped.label;
        if (!summary.model && mapped.model) {
          summary.model = mapped.model;
        }
      } else {
        const rawLabel = summary.subagentType.includes(':')
          ? summary.subagentType.split(':').pop() || summary.subagentType
          : summary.subagentType;
        summary.subagentLabel = ToolFormatter.titleCaseSubagent(rawLabel);
      }
    }

    if (typeof taskInput.model === 'string' && taskInput.model.trim()) {
      summary.model = taskInput.model.trim();
    }

    if (typeof taskInput.run_in_background === 'boolean') {
      summary.runInBackground = taskInput.run_in_background;
    }

    if (typeof taskInput.prompt === 'string') {
      const normalizedPrompt = taskInput.prompt.replace(/\s+/g, ' ').trim();
      summary.promptLength = taskInput.prompt.length;
      if (normalizedPrompt) {
        summary.promptPreview = ToolFormatter.truncateString(
          normalizedPrompt,
          ToolFormatter.TASK_PROMPT_PREVIEW_LENGTH,
        );
      }
    }

    return summary;
  }

  /**
   * Format Task tool usage with key inputs for visibility
   */
  static formatTaskTool(input: unknown): string {
    const summary = ToolFormatter.getTaskToolSummary(input);
    const subagentName = summary.subagentLabel || 'Task';
    const lines = [`🤖 Using Subagent: *${ToolFormatter.sanitizeInlineValue(subagentName)}*`];

    if (summary.model) {
      lines.push(`model: *${ToolFormatter.sanitizeInlineValue(summary.model)}*`);
    }

    if (summary.promptPreview) {
      lines.push(`prompt: ${ToolFormatter.sanitizeInlineValue(summary.promptPreview)}`);
    }

    if (summary.promptLength !== undefined) {
      lines.push(`prompt_length: ${summary.promptLength}`);
    }

    return lines.join('\n');
  }

  /**
   * Build concise tool_use input summary for debug logging
   */
  static buildToolUseLogSummary(toolUseId: string, toolName: string, input: unknown): ToolUseLogSummary {
    const inputKeys =
      input && typeof input === 'object' && !Array.isArray(input)
        ? Object.keys(input as Record<string, unknown>).sort()
        : [];

    const summary: ToolUseLogSummary = {
      toolUseId,
      toolName,
      inputKeys,
      inputKeyCount: inputKeys.length,
    };

    if (toolName === 'Task') {
      summary.task = ToolFormatter.getTaskToolSummary(input);
    }

    return summary;
  }

  /**
   * Format generic tool usage
   */
  static formatGenericTool(toolName: string, input: any): string {
    if (toolName.startsWith('mcp__')) {
      return ToolFormatter.formatMcpTool(toolName, input);
    }
    if (toolName === 'Task') {
      return ToolFormatter.formatTaskTool(input);
    }
    return `🔧 *Using ${toolName}*`;
  }

  /**
   * Format tool_use content from assistant message (default = detail mode)
   */
  static formatToolUse(content: any[], mode: RenderMode = 'detail'): string {
    if (mode === 'hidden') return '';
    if (mode === 'compact') return ToolFormatter.formatToolUseCompact(content);
    if (mode === 'verbose') return ToolFormatter.formatToolUseVerbose(content);

    // detail mode — current behavior
    const parts: string[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;

        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(ToolFormatter.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(ToolFormatter.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(ToolFormatter.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(ToolFormatter.formatBashTool(input));
            break;
          case 'TodoWrite':
            return '';
          case 'mcp__permission-prompt__permission_prompt':
            return '';
          default:
            parts.push(ToolFormatter.formatGenericTool(toolName, input));
        }
      }
    }

    return parts.join('\n\n');
  }

  // ── Compact mode: single-line per tool ─────────────────────────────

  static formatToolUseCompact(content: any[]): string {
    const parts: string[] = [];

    for (const part of content) {
      if (part.type !== 'tool_use') continue;
      const { name, input } = part;

      if (name === 'TodoWrite' || name === 'mcp__permission-prompt__permission_prompt') continue;

      // Async tools (MCP, Task/Subagent) get ⏳; sync tools get ⚪
      const isAsync = name.startsWith('mcp__') || name === 'Task';
      const icon = isAsync ? '⏳' : '⚪';
      parts.push(`${icon} ${ToolFormatter.formatOneLineToolUse(name, input)}`);
    }

    return parts.join('\n');
  }

  /** Format a single tool use as one line: `emoji ToolName — context` */
  static formatOneLineToolUse(toolName: string, input: any): string {
    const emoji = ToolFormatter.getToolEmoji(toolName);

    switch (toolName) {
      case 'Edit':
      case 'MultiEdit':
        return `${emoji} Edit \`${ToolFormatter.compactPath(input.file_path)}\``;
      case 'Write':
        return `${emoji} Write \`${ToolFormatter.compactPath(input.file_path)}\``;
      case 'Read':
        return `${emoji} Read \`${ToolFormatter.compactPath(input.file_path)}\``;
      case 'Bash':
        return `${emoji} Bash \`${ToolFormatter.truncateString(String(input.command || ''), 40)}\``;
      case 'Glob':
        return `${emoji} Glob \`${ToolFormatter.truncateString(String(input.pattern || ''), 30)}\``;
      case 'Grep':
        return `${emoji} Grep \`${ToolFormatter.truncateString(String(input.pattern || ''), 30)}\``;
      case 'Task': {
        const summary = ToolFormatter.getTaskToolSummary(input);
        return `${emoji} Task: *${summary.subagentLabel || 'Agent'}*${summary.promptPreview ? ' — ' + ToolFormatter.truncateString(summary.promptPreview, 30) : ''}`;
      }
      case 'Skill': {
        const skillName = input?.skill || input?.name || '';
        return skillName ? `${emoji} Skill: *${skillName}*` : `${emoji} Skill`;
      }
      case 'TaskOutput': {
        const meta = input?._taskMeta;
        if (meta?.subagentLabel || meta?.name) {
          const label = meta.subagentLabel || meta.name;
          return meta.promptPreview
            ? `${emoji} TaskOutput: *${label}* — ${ToolFormatter.truncateString(meta.promptPreview, 30)}`
            : `${emoji} TaskOutput: *${label}*`;
        }
        const taskId = input?.task_id || '';
        return taskId ? `${emoji} TaskOutput: \`${ToolFormatter.truncateString(taskId, 20)}\`` : `${emoji} TaskOutput`;
      }
      default:
        if (toolName.startsWith('mcp__')) {
          // SAVE_MEMORY meme: "X will remember that" (Telltale Games style)
          if (toolName === 'mcp__model-command__run' && input?.commandId === 'SAVE_MEMORY') {
            return `🧠 *'${_botDisplayName}'은(는) 이것을 기억할 것입니다.*`;
          }
          const parts = toolName.split('__');
          const base = `${emoji} MCP: ${parts[1]} → ${parts.slice(2).join('__')}`;
          const params = ToolFormatter.formatCompactParams(input);
          return params ? `${base} ${params}` : base;
        }
        {
          const params = ToolFormatter.formatCompactParams(input);
          return params ? `${emoji} ${toolName} ${params}` : `${emoji} ${toolName}`;
        }
    }
  }

  /** Format a completed tool line with status icon and optional duration */
  static formatOneLineToolComplete(toolName: string, input: any, isError: boolean, duration?: number | null): string {
    const icon = isError ? '🔴' : '🟢';
    const line = ToolFormatter.formatOneLineToolUse(toolName, input);
    if (duration !== null && duration !== undefined) {
      return `${icon} ${line} — ${McpCallTracker.formatDuration(duration)}`;
    }
    return `${icon} ${line}`;
  }

  private static getToolEmoji(toolName: string): string {
    if (toolName === 'Edit' || toolName === 'MultiEdit') return '📝';
    if (toolName === 'Write') return '📄';
    if (toolName === 'Read') return '👁️';
    if (toolName === 'Bash') return '🖥️';
    if (toolName === 'Glob' || toolName === 'Grep') return '🔍';
    if (toolName === 'Task') return '🤖';
    if (toolName.startsWith('mcp__')) return '🔌';
    return '🔧';
  }

  private static compactPath(filePath: string): string {
    if (!filePath) return '?';
    const parts = filePath.split('/');
    return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : filePath;
  }

  /**
   * Format up to 2 compact parameters from tool input for one-line display.
   * Returns `(key: val, key2: val2)` or empty string if no suitable params.
   * Budget controls the total max length of the parenthesized string.
   */
  static formatCompactParams(input: unknown, budget = 60): string {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return '';

    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return '';

    // Filter to short, displayable values (string/number/boolean, skip internal keys)
    const candidates = entries
      .filter(([key, val]) => {
        if (key.startsWith('_')) return false;
        if (val === null || val === undefined) return false;
        if (typeof val === 'object') return false;
        return true;
      })
      .map(([key, val]) => {
        const strVal = String(val);
        return { key, val: strVal, len: key.length + strVal.length + 2 }; // +2 for ": "
      })
      // Prioritize shorter values first for better fit
      .sort((a, b) => a.len - b.len);

    if (candidates.length === 0) return '';

    // Budget includes parentheses `()` = 2 chars
    const innerBudget = budget - 2;
    const parts: string[] = [];
    let used = 0;

    for (const c of candidates) {
      if (parts.length >= 2) break;

      // Separator ", " = 2 chars between params
      const separator = parts.length > 0 ? 2 : 0;
      const available = innerBudget - used - separator;
      if (available < 8) break; // minimum "k: v..." = ~8 chars

      let display: string;
      const maxValLen = available - c.key.length - 2; // -2 for ": "
      if (maxValLen <= 0) break;

      const truncVal = c.val.length > maxValLen ? c.val.substring(0, maxValLen - 1) + '…' : c.val;
      display = `${c.key}: ${truncVal}`;

      parts.push(display);
      used += display.length + separator;
    }

    return parts.length > 0 ? `(${parts.join(', ')})` : '';
  }

  // ── Verbose mode: extended output ──────────────────────────────────

  private static readonly VERBOSE_TEXT_LIMIT = 2000;

  static formatToolUseVerbose(content: any[]): string {
    const parts: string[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const { name, input } = part;
        if (name === 'TodoWrite' || name === 'mcp__permission-prompt__permission_prompt') continue;

        switch (name) {
          case 'Edit':
          case 'MultiEdit': {
            const edits =
              name === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
            let result = `📝 *Editing \`${input.file_path}\`*\n`;
            for (const edit of edits) {
              result += '\n```diff\n';
              result += `- ${ToolFormatter.truncateString(edit.old_string, ToolFormatter.VERBOSE_TEXT_LIMIT)}\n`;
              result += `+ ${ToolFormatter.truncateString(edit.new_string, ToolFormatter.VERBOSE_TEXT_LIMIT)}\n`;
              result += '```';
            }
            parts.push(result);
            break;
          }
          case 'Write':
            parts.push(
              `📄 *Creating \`${input.file_path}\`*\n\`\`\`\n${ToolFormatter.truncateString(input.content, ToolFormatter.VERBOSE_TEXT_LIMIT)}\n\`\`\``,
            );
            break;
          case 'Bash':
            parts.push(
              `🖥️ *Running command:*\n\`\`\`bash\n${ToolFormatter.truncateString(input.command, ToolFormatter.VERBOSE_TEXT_LIMIT)}\n\`\`\``,
            );
            break;
          default:
            if (name.startsWith('mcp__')) {
              parts.push(ToolFormatter.formatMcpTool(name, input));
            } else if (name === 'Task') {
              parts.push(ToolFormatter.formatTaskTool(input));
            } else {
              parts.push(
                `🔧 *Using ${name}*\n\`\`\`json\n${ToolFormatter.truncateString(JSON.stringify(input, null, 2), ToolFormatter.VERBOSE_TEXT_LIMIT)}\n\`\`\``,
              );
            }
        }
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Format Skill invocation as RPG-style announcement.
   * ~20% critical hit chance with bold damage number.
   */
  static formatSkillInvocationRPG(skillName: string, casterName: string): string {
    const isCritical = Math.random() < 0.2;
    const damage = isCritical ? Math.floor(Math.random() * 150) + 100 : Math.floor(Math.random() * 100) + 30;
    const dmgText = isCritical ? `*${damage}*` : `${damage}`;
    const suffix = isCritical ? ' 크리티컬!' : '!';
    return `> '@${casterName}'가 '${skillName}'을 발동했습니다. 데미지 ${dmgText}${suffix}`;
  }

  /** Format a compact completion line for in-place tool message update */
  static formatCompactToolDone(toolName: string, input: any, isError: boolean): string {
    const icon = isError ? '🔴' : '🟢';
    return `${icon} ${ToolFormatter.formatOneLineToolUse(toolName, input)}`;
  }

  /**
   * Extract tool results from user message content
   */
  static extractToolResults(content: any[]): ToolResult[] {
    const results: ToolResult[] = [];

    if (!Array.isArray(content)) {
      return results;
    }

    for (const part of content) {
      if (part.type === 'tool_result') {
        results.push({
          toolUseId: part.tool_use_id,
          result: part.content,
          isError: part.is_error,
          toolName: (part as any).tool_name,
        });
      }
    }

    return results;
  }

  /**
   * Format built-in tool results (Read, Bash, Edit, etc.)
   */
  static formatBuiltInToolResult(toolResult: ToolResult): string | null {
    const { toolName, result, isError } = toolResult;

    if (!toolName) {
      return null;
    }

    // Skip certain tools that don't need result output
    const skipTools = ['TodoWrite', 'Glob', 'Grep'];
    if (skipTools.includes(toolName)) {
      return null;
    }

    const statusIcon = isError ? '🔴' : '🟢';
    let formatted = `${statusIcon} *${toolName} 결과*\n`;

    if (result) {
      if (typeof result === 'string') {
        const maxLen = toolName === 'Read' ? 500 : 1000;
        const truncated =
          result.length > maxLen
            ? result.substring(0, maxLen) + `\n... (${result.length - maxLen} more chars)`
            : result;

        if (truncated.includes('\n')) {
          formatted += `\`\`\`\n${truncated}\n\`\`\``;
        } else {
          formatted += `\`${truncated}\``;
        }
      } else if (Array.isArray(result)) {
        for (const item of result) {
          if (item.type === 'text' && item.text) {
            const maxLen = toolName === 'Read' ? 500 : 1000;
            const truncated =
              item.text.length > maxLen
                ? item.text.substring(0, maxLen) + `\n... (${item.text.length - maxLen} more chars)`
                : item.text;
            formatted += `\`\`\`\n${truncated}\n\`\`\``;
          }
        }
      } else if (typeof result === 'object') {
        try {
          const jsonStr = JSON.stringify(result, null, 2);
          const truncated = jsonStr.length > 500 ? jsonStr.substring(0, 500) + '...' : jsonStr;
          formatted += `\`\`\`json\n${truncated}\n\`\`\``;
        } catch {
          formatted += `_[Complex result]_`;
        }
      }
    } else {
      return null;
    }

    return formatted;
  }

  /**
   * Format MCP tool results
   */
  static formatMcpToolResult(
    toolResult: ToolResult,
    duration?: number | null,
    mcpCallTracker?: McpCallTracker,
  ): string | null {
    const { toolName, result, isError } = toolResult;

    let serverName = 'unknown';
    let actualToolName = 'unknown';

    if (toolName?.startsWith('mcp__')) {
      const parts = toolName.split('__');
      serverName = parts[1] || 'unknown';
      actualToolName = parts.slice(2).join('__') || toolName;
    }

    const statusIcon = isError ? '🔴' : '🟢';
    let formatted = `${statusIcon} *MCP Result: ${serverName} → ${actualToolName}*`;

    if (duration !== null && duration !== undefined) {
      formatted += ` (${McpCallTracker.formatDuration(duration)})`;

      if (mcpCallTracker) {
        const stats = mcpCallTracker.getToolStats(serverName, actualToolName);
        if (stats && stats.callCount > 1) {
          formatted += ` | 평균: ${McpCallTracker.formatDuration(stats.avgDuration)}`;
        }
      }
    }
    formatted += '\n';

    if (result) {
      if (typeof result === 'string') {
        const truncated = result.length > 1000 ? result.substring(0, 1000) + '...' : result;

        if (truncated.includes('\n')) {
          formatted += `\`\`\`\n${truncated}\n\`\`\``;
        } else {
          formatted += `\`${truncated}\``;
        }
      } else if (Array.isArray(result)) {
        for (const item of result) {
          if (item.type === 'text' && item.text) {
            const truncated = item.text.length > 1000 ? item.text.substring(0, 1000) + '...' : item.text;
            formatted += `\`\`\`\n${truncated}\n\`\`\``;
          } else if (item.type === 'image') {
            formatted += `_[Image data]_`;
          } else if (typeof item === 'object') {
            try {
              const jsonStr = JSON.stringify(item, null, 2);
              const truncated = jsonStr.length > 500 ? jsonStr.substring(0, 500) + '...' : jsonStr;
              formatted += `\`\`\`json\n${truncated}\n\`\`\``;
            } catch {
              formatted += `_[Complex result]_`;
            }
          }
        }
      } else if (typeof result === 'object') {
        try {
          const jsonStr = JSON.stringify(result, null, 2);
          const truncated = jsonStr.length > 500 ? jsonStr.substring(0, 500) + '...' : jsonStr;
          formatted += `\`\`\`json\n${truncated}\n\`\`\``;
        } catch {
          formatted += `_[Complex result]_`;
        }
      }
    } else {
      formatted += `_[No result content]_`;
    }

    return formatted;
  }

  /**
   * Format any tool result (MCP or built-in)
   */
  static formatToolResult(
    toolResult: ToolResult,
    duration?: number | null,
    mcpCallTracker?: McpCallTracker,
  ): string | null {
    const { toolName } = toolResult;

    // Skip permission prompt results
    if (toolName === 'mcp__permission-prompt__permission_prompt') {
      return null;
    }

    // MCP tools get detailed formatting
    if (toolName?.startsWith('mcp__')) {
      return ToolFormatter.formatMcpToolResult(toolResult, duration, mcpCallTracker);
    }

    // Built-in tools get simpler formatting
    return ToolFormatter.formatBuiltInToolResult(toolResult);
  }
}

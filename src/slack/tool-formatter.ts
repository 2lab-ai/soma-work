/**
 * Tool formatting utilities for Slack bot
 */
import { McpCallTracker } from '../mcp-call-tracker';

export interface ToolResult {
  toolName?: string;
  toolUseId: string;
  result: any;
  isError?: boolean;
}

export class ToolFormatter {
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
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];

    let result = `📝 *Editing \`${filePath}\`*\n`;

    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }

    return result;
  }

  /**
   * Format Write tool usage
   */
  static formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);

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
        const displayValue = value.length > 500
          ? value.substring(0, 500) + '...'
          : value;

        if (displayValue.includes('\n')) {
          lines.push(`*${key}:*\n\`\`\`\n${displayValue}\n\`\`\``);
        } else {
          lines.push(`*${key}:* \`${displayValue}\``);
        }
      } else if (typeof value === 'object') {
        try {
          const jsonStr = JSON.stringify(value, null, 2);
          const truncated = jsonStr.length > 300
            ? jsonStr.substring(0, 300) + '...'
            : jsonStr;
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
      const inputStr = this.formatMcpInput(input);
      if (inputStr) {
        result += inputStr;
      }
    }

    return result;
  }

  /**
   * Format generic tool usage
   */
  static formatGenericTool(toolName: string, input: any): string {
    if (toolName.startsWith('mcp__')) {
      return this.formatMcpTool(toolName, input);
    }
    return `🔧 *Using ${toolName}*`;
  }

  /**
   * Format tool_use content from assistant message
   */
  static formatToolUse(content: any[]): string {
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
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            // TodoWrite is handled separately
            return '';
          case 'mcp__permission-prompt__permission_prompt':
            // Permission prompt is handled internally
            return '';
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }

    return parts.join('\n\n');
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

    const statusIcon = isError ? '❌' : '✅';
    let formatted = `${statusIcon} *${toolName} 결과*\n`;

    if (result) {
      if (typeof result === 'string') {
        const maxLen = toolName === 'Read' ? 500 : 1000;
        const truncated = result.length > maxLen
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
            const truncated = item.text.length > maxLen
              ? item.text.substring(0, maxLen) + `\n... (${item.text.length - maxLen} more chars)`
              : item.text;
            formatted += `\`\`\`\n${truncated}\n\`\`\``;
          }
        }
      } else if (typeof result === 'object') {
        try {
          const jsonStr = JSON.stringify(result, null, 2);
          const truncated = jsonStr.length > 500
            ? jsonStr.substring(0, 500) + '...'
            : jsonStr;
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
    mcpCallTracker?: McpCallTracker
  ): string | null {
    const { toolName, result, isError } = toolResult;

    let serverName = 'unknown';
    let actualToolName = 'unknown';

    if (toolName?.startsWith('mcp__')) {
      const parts = toolName.split('__');
      serverName = parts[1] || 'unknown';
      actualToolName = parts.slice(2).join('__') || toolName;
    }

    const statusIcon = isError ? '❌' : '✅';
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
        const truncated = result.length > 1000
          ? result.substring(0, 1000) + '...'
          : result;

        if (truncated.includes('\n')) {
          formatted += `\`\`\`\n${truncated}\n\`\`\``;
        } else {
          formatted += `\`${truncated}\``;
        }
      } else if (Array.isArray(result)) {
        for (const item of result) {
          if (item.type === 'text' && item.text) {
            const truncated = item.text.length > 1000
              ? item.text.substring(0, 1000) + '...'
              : item.text;
            formatted += `\`\`\`\n${truncated}\n\`\`\``;
          } else if (item.type === 'image') {
            formatted += `_[Image data]_`;
          } else if (typeof item === 'object') {
            try {
              const jsonStr = JSON.stringify(item, null, 2);
              const truncated = jsonStr.length > 500
                ? jsonStr.substring(0, 500) + '...'
                : jsonStr;
              formatted += `\`\`\`json\n${truncated}\n\`\`\``;
            } catch {
              formatted += `_[Complex result]_`;
            }
          }
        }
      } else if (typeof result === 'object') {
        try {
          const jsonStr = JSON.stringify(result, null, 2);
          const truncated = jsonStr.length > 500
            ? jsonStr.substring(0, 500) + '...'
            : jsonStr;
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
    mcpCallTracker?: McpCallTracker
  ): string | null {
    const { toolName } = toolResult;

    // Skip permission prompt results
    if (toolName === 'mcp__permission-prompt__permission_prompt') {
      return null;
    }

    // MCP tools get detailed formatting
    if (toolName?.startsWith('mcp__')) {
      return this.formatMcpToolResult(toolResult, duration, mcpCallTracker);
    }

    // Built-in tools get simpler formatting
    return this.formatBuiltInToolResult(toolResult);
  }
}

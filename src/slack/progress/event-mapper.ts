/**
 * EventMapper — maps SDK tool_use/tool_result events to generic ToolProgressEvents.
 *
 * Pure functions, no side effects. Reuses TOOL_STATUS_MAP categories
 * and ToolFormatter patterns from existing codebase.
 */

import type { ToolUseEvent, ToolResultEvent } from '../tool-event-processor';
import type { ToolStartEvent, ToolCompleteEvent, ToolCategory } from './types';
import { ToolFormatter } from '../tool-formatter';

// ── Tool Category Resolution ────────────────────────────────────────

const CATEGORY_MAP: Record<string, ToolCategory> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Bash: 'execute',
  WebSearch: 'search',
  WebFetch: 'search',
  Task: 'subagent',
};

function resolveCategory(toolName: string): ToolCategory {
  if (toolName.startsWith('mcp__')) return 'mcp';
  return CATEGORY_MAP[toolName] ?? 'other';
}

// ── Display Label ───────────────────────────────────────────────────

function buildDisplayLabel(toolName: string, input?: Record<string, unknown>): string {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const serverName = parts[1] || 'unknown';
    const actualToolName = parts.slice(2).join('__') || toolName;
    return `${serverName} → ${actualToolName}`;
  }

  if (toolName === 'Task') {
    const summary = ToolFormatter.getTaskToolSummary(input);
    return summary.subagentLabel || 'Task';
  }

  return toolName;
}

// ── MCP Name Parsing ────────────────────────────────────────────────

function parseMcpName(toolName: string): { serverName: string; serverToolName: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  return {
    serverName: parts[1] || 'unknown',
    serverToolName: parts.slice(2).join('__') || toolName,
  };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Map SDK tool_use events to generic ToolStartEvents.
 *
 * When multiple trackable tools (MCP/subagent) arrive in a single message,
 * they share a groupId for consolidated progress display.
 */
export function mapToolUses(toolUses: ToolUseEvent[]): ToolStartEvent[] {
  const trackable = toolUses.filter(
    t => t.name.startsWith('mcp__') || t.name === 'Task'
  );
  const groupId = trackable.length > 1
    ? `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    : undefined;

  return toolUses.map((tu): ToolStartEvent => {
    const category = resolveCategory(tu.name);
    const displayLabel = buildDisplayLabel(tu.name, tu.input);
    const mcpInfo = parseMcpName(tu.name);

    const event: ToolStartEvent = {
      type: 'tool_start',
      toolUseId: tu.id,
      toolName: tu.name,
      category,
      displayLabel,
      input: tu.input,
    };

    // MCP-specific fields
    if (mcpInfo) {
      event.serverName = mcpInfo.serverName;
      event.serverToolName = mcpInfo.serverToolName;
    }

    // Subagent-specific fields
    if (tu.name === 'Task') {
      const summary = ToolFormatter.getTaskToolSummary(tu.input);
      event.subagentType = summary.subagentType;
      event.subagentLabel = summary.subagentLabel;
    }

    // Assign groupId to trackable tools
    if (groupId && (tu.name.startsWith('mcp__') || tu.name === 'Task')) {
      event.groupId = groupId;
    }

    return event;
  });
}

/**
 * Map SDK tool_result events to generic ToolCompleteEvents.
 *
 * Truncates result text for display and preserves error status.
 */
export function mapToolResults(
  toolResults: ToolResultEvent[],
  toolNameLookup?: (toolUseId: string) => string | undefined
): ToolCompleteEvent[] {
  return toolResults.map((tr): ToolCompleteEvent => {
    const toolName = tr.toolName ?? toolNameLookup?.(tr.toolUseId) ?? 'unknown';
    const category = resolveCategory(toolName);
    const displayLabel = buildDisplayLabel(toolName);

    return {
      type: 'tool_complete',
      toolUseId: tr.toolUseId,
      toolName,
      category,
      displayLabel,
      isError: tr.isError ?? false,
      resultPreview: formatResultPreview(tr.result),
    };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

const RESULT_PREVIEW_MAX = 200;

function formatResultPreview(result: unknown): string | undefined {
  if (result == null) return undefined;

  const text = typeof result === 'string'
    ? result
    : JSON.stringify(result);

  return ToolFormatter.truncateString(text, RESULT_PREVIEW_MAX) || undefined;
}

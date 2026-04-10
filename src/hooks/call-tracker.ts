import { shouldTrackTool } from './hook-policy';
import { hookState } from './hook-state';

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: { description?: string };
  tool_response?: string;
}

/**
 * Pre/Post correlation: FIFO matching by (sessionId, toolName).
 * Limitation: concurrent calls to the same tool within a session
 * may be matched out-of-order. This is a known constraint of the
 * Claude Code hook payload (no unique call ID provided).
 */

function getDescription(toolName: string, toolInput?: { description?: string }): string {
  if (toolName === 'Task') return toolInput?.description || 'agent call';
  return toolName.replace(/^mcp__plugin_oh-my-claude_/, '').replace(/__/g, ':');
}

export function trackPreCall(input: HookInput): void {
  const { session_id, tool_name } = input;
  if (!session_id || !tool_name || !shouldTrackTool(tool_name)) return;

  hookState.recordCallStart(session_id, {
    toolName: tool_name,
    callId: `${tool_name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    startTime: new Date().toISOString(),
    epoch: Math.floor(Date.now() / 1000),
    description: getDescription(tool_name, input.tool_input),
  });
}

export function trackPostCall(input: HookInput): void {
  const { session_id, tool_name, tool_response } = input;
  if (!session_id || !tool_name || !shouldTrackTool(tool_name)) return;

  const status = tool_response && /error|fail|timeout/i.test(tool_response) ? 'error' : 'ok';
  hookState.recordCallEnd(session_id, tool_name, status);
}

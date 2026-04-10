/**
 * Hook exemption policy — single source of truth.
 * Tools listed here are never blocked and never counted.
 */
const EXEMPT_TOOLS = new Set(['ToolSearch', 'TodoWrite']);

export function isExemptTool(toolName: string): boolean {
  return EXEMPT_TOOLS.has(toolName);
}

export function shouldTrackTool(toolName: string): boolean {
  return toolName === 'Task' || toolName.startsWith('mcp__');
}

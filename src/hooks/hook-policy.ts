/**
 * Hook tracking policy — single source of truth.
 *
 * Only agent (`Task`) and MCP calls are worth timing in the call log; every
 * other tool is ignored. There is no exemption list any more — the hook routes
 * observe, they never block, so nothing needs exempting.
 */
export function shouldTrackTool(toolName: string): boolean {
  return toolName === 'Task' || toolName.startsWith('mcp__');
}

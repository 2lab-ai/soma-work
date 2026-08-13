/**
 * Hook tracking policy — single source of truth.
 *
 * Only agent (`Task`) and MCP calls are worth timing in the call log; every
 * other tool is ignored. There is no exemption list any more — the hook routes
 * observe, they never block, so nothing needs exempting.
 *
 * This predicate is mirrored in shell, twice, because the plugin hooks run
 * before any of this code does. Widen it here and you must widen both, or the
 * shell filter silently swallows the new tool:
 *   - src/local/hooks/hook-proxy.sh  (skips the HTTP roundtrip)
 *   - src/local/hooks/call-tracker.sh (`should_track`, standalone mode)
 * Both copies are covered by src/__tests__/hook-proxy-forwarding.test.ts.
 */
export function shouldTrackTool(toolName: string): boolean {
  return toolName === 'Task' || toolName.startsWith('mcp__');
}

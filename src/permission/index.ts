/**
 * Permission handling modules
 *
 * SlackPermissionMessenger / PermissionMessageContext / PermissionMessageResult
 * were previously re-exported here but no consumer imported them from src/.
 * The canonical copy now lives in somalib/permission/slack-messenger.ts and is
 * consumed directly by mcp-servers/permission/permission-mcp-server.ts.
 * See dedup-744 mini-epic for context.
 */

export { PermissionCheckResult, PermissionService } from './service';

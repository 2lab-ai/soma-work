import { isGitHubAppConfigured } from '../github-auth.js';
import type { McpServerConfig, McpStdioServerConfig, McpSSEServerConfig, McpHttpServerConfig } from './config-loader';

/**
 * Formats MCP server information for display
 */
export class McpInfoFormatter {
  /**
   * Format complete MCP server information
   */
  formatMcpInfo(servers: Record<string, McpServerConfig> | undefined): string {
    if (!servers || Object.keys(servers).length === 0) {
      return 'No MCP servers configured.';
    }

    let info = '🔧 **MCP Servers Configured:**\n\n';

    for (const [serverName, serverConfig] of Object.entries(servers)) {
      info += this.formatServerEntry(serverName, serverConfig);
    }

    info += 'Available tools follow the pattern: `mcp__serverName__toolName`\n';
    info += 'All MCP tools are allowed by default.';

    return info;
  }

  /**
   * Format a single server entry
   */
  formatServerEntry(serverName: string, serverConfig: McpServerConfig): string {
    const type = serverConfig.type || 'stdio';
    const authInfo = this.getAuthInfo(serverName);

    let entry = `• **${serverName}** (${type}${authInfo})\n`;

    if (type === 'stdio') {
      const stdioConfig = serverConfig as McpStdioServerConfig;
      entry += `  Command: \`${stdioConfig.command}\`\n`;
      if (stdioConfig.args && stdioConfig.args.length > 0) {
        entry += `  Args: \`${stdioConfig.args.join(' ')}\`\n`;
      }
    } else {
      const urlConfig = serverConfig as McpSSEServerConfig | McpHttpServerConfig;
      entry += `  URL: \`${urlConfig.url}\`\n`;
    }
    entry += '\n';

    return entry;
  }

  /**
   * Get authentication info string for a server
   */
  private getAuthInfo(serverName: string): string {
    if (serverName === 'github' || serverName === 'git') {
      if (isGitHubAppConfigured()) {
        return ' (GitHub App)';
      } else if (process.env.GITHUB_TOKEN) {
        return ' (Token)';
      }
    }
    return '';
  }

  /**
   * Format server status for monitoring
   */
  formatServerStatus(serverName: string, serverConfig: McpServerConfig, isActive: boolean): string {
    const type = serverConfig.type || 'stdio';
    const status = isActive ? '✅' : '❌';
    return `${status} **${serverName}** (${type})`;
  }
}

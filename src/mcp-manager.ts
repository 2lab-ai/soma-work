import { McpConfigLoader, McpServerFactory, McpInfoFormatter } from './mcp/index';
import type { McpServerConfig, McpConfiguration } from './mcp/index';

// Re-export types for backward compatibility
export type { McpServerConfig, McpConfiguration };
export type {
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
} from './mcp/index';

/**
 * McpManager - Facade for MCP server configuration management
 *
 * Delegates to:
 * - McpConfigLoader: Loading and validating configuration files
 * - McpServerFactory: Creating and provisioning server configurations
 * - McpInfoFormatter: Formatting server information for display
 */
export class McpManager {
  private configLoader: McpConfigLoader;
  private serverFactory: McpServerFactory;
  private infoFormatter: McpInfoFormatter;

  constructor(configPath: string = './mcp-servers.json') {
    this.configLoader = new McpConfigLoader(configPath);
    this.serverFactory = new McpServerFactory();
    this.infoFormatter = new McpInfoFormatter();
  }

  /**
   * Load configuration from file
   */
  loadConfiguration(): McpConfiguration | null {
    return this.configLoader.loadConfiguration();
  }

  /**
   * Get complete server configuration with authentication and default servers
   */
  async getServerConfiguration(): Promise<Record<string, McpServerConfig> | undefined> {
    // Load and inject auth into configured servers
    const rawServers = this.configLoader.getRawServers();
    const authedServers = await this.serverFactory.injectGitHubAuth(rawServers);

    // Provision default servers
    const allServers = await this.serverFactory.provisionDefaultServers(authedServers);

    return Object.keys(allServers).length > 0 ? allServers : undefined;
  }

  /**
   * Get default allowed tools for all configured servers
   */
  getDefaultAllowedTools(): string[] {
    const configuredNames = this.configLoader.getConfiguredServerNames();
    const expectedNames = this.serverFactory.getExpectedServerNames(configuredNames);
    return this.serverFactory.getDefaultAllowedTools(expectedNames);
  }

  /**
   * Format MCP server information for display
   */
  async formatMcpInfo(): Promise<string> {
    const servers = await this.getServerConfiguration();
    return this.infoFormatter.formatMcpInfo(servers);
  }

  /**
   * Reload configuration from file
   */
  reloadConfiguration(): McpConfiguration | null {
    return this.configLoader.reloadConfiguration();
  }
}

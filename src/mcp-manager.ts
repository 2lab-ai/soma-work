import type { McpConfiguration, McpServerConfig } from './mcp/index';
import { McpConfigLoader, McpInfoFormatter, McpServerFactory } from './mcp/index';
import type { PluginManager } from './plugin/plugin-manager';

export type {
  McpHttpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from './mcp/index';
// Re-export types for backward compatibility
export type { McpConfiguration, McpServerConfig };

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
  private pluginManager?: PluginManager;

  constructor(configPath: string) {
    this.configLoader = new McpConfigLoader(configPath);
    this.serverFactory = new McpServerFactory();
    this.infoFormatter = new McpInfoFormatter();
  }

  /**
   * Create McpManager from a pre-parsed server config record.
   * Used by config-loader integration — `mcpServers` is already loaded
   * inside `config.json`, so the manager is constructed without a file
   * path (the empty path signals "no file to reload from").
   */
  static fromParsedServers(servers: Record<string, McpServerConfig>): McpManager {
    const manager = new McpManager('');
    manager.configLoader = McpConfigLoader.fromParsedConfig(servers);
    return manager;
  }

  setPluginManager(pm: PluginManager): void {
    this.pluginManager = pm;
  }

  getPluginManager(): PluginManager | undefined {
    return this.pluginManager;
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

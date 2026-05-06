import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';
import { formatMcpScanReport, scanMcpServerConfig } from '../plugin/security-scanner';

export type McpStdioServerConfig = {
  type?: 'stdio'; // Optional for backwards compatibility
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpSSEServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

export interface McpConfiguration {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Loads and validates MCP server configuration from file
 */
export class McpConfigLoader {
  private logger = new Logger('McpConfigLoader');
  private config: McpConfiguration | null = null;
  private configPath: string;
  private inMemory = false;

  constructor(configPath: string) {
    this.configPath = path.resolve(configPath);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  loadConfiguration(): McpConfiguration | null {
    if (this.config) {
      return this.config;
    }

    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.debug('No MCP configuration file found', { path: this.configPath });
        return null;
      }

      const configContent = fs.readFileSync(this.configPath, 'utf-8');
      const parsedConfig = JSON.parse(configContent);

      if (!parsedConfig.mcpServers || typeof parsedConfig.mcpServers !== 'object') {
        this.logger.warn('Invalid MCP configuration: missing or invalid mcpServers', { path: this.configPath });
        return null;
      }

      // Validate server configurations
      for (const [serverName, serverConfig] of Object.entries(parsedConfig.mcpServers)) {
        if (!this.validateServerConfig(serverName, serverConfig as McpServerConfig)) {
          this.logger.warn('Invalid server configuration, skipping', { serverName });
          delete parsedConfig.mcpServers[serverName];
          continue;
        }

        // Security scan MCP server config
        const scanResult = scanMcpServerConfig(serverName, serverConfig as McpServerConfig);
        if (scanResult.blocked) {
          this.logger.error('MCP server BLOCKED by security scan', { serverName, riskLevel: scanResult.riskLevel });
          this.logger.warn(formatMcpScanReport(scanResult));
          delete parsedConfig.mcpServers[serverName];
        } else if (scanResult.findings.length > 0) {
          this.logger.warn(formatMcpScanReport(scanResult));
        }
      }

      this.config = parsedConfig as McpConfiguration;

      this.logger.info('Loaded MCP configuration', {
        path: this.configPath,
        serverCount: Object.keys(this.config.mcpServers).length,
        servers: Object.keys(this.config.mcpServers),
      });

      return this.config;
    } catch (error) {
      this.logger.error('Failed to load MCP configuration', error);
      return null;
    }
  }

  validateServerConfig(serverName: string, config: McpServerConfig): boolean {
    if (!config || typeof config !== 'object') {
      return false;
    }

    // Validate based on type
    if (!config.type || config.type === 'stdio') {
      // Stdio server
      const stdioConfig = config as McpStdioServerConfig;
      if (!stdioConfig.command || typeof stdioConfig.command !== 'string') {
        this.logger.warn('Stdio server missing command', { serverName });
        return false;
      }
    } else if (config.type === 'sse' || config.type === 'http') {
      // SSE or HTTP server
      const urlConfig = config as McpSSEServerConfig | McpHttpServerConfig;
      if (!urlConfig.url || typeof urlConfig.url !== 'string') {
        this.logger.warn('SSE/HTTP server missing URL', { serverName, type: config.type });
        return false;
      }
    } else {
      this.logger.warn('Unknown server type', { serverName, type: config.type });
      return false;
    }

    return true;
  }

  /**
   * Create a McpConfigLoader from a pre-parsed mcpServers record.
   * Used by config-loader when config.json provides the MCP section.
   * Note: reloadConfiguration() on such instances re-returns the parsed config
   * (no file to reload from).
   */
  static fromParsedConfig(servers: Record<string, McpServerConfig>): McpConfigLoader {
    const loader = new McpConfigLoader('');
    const validationLogger = new Logger('McpConfigLoader');

    // Validate each server
    const validated: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(servers)) {
      if (!loader.validateServerConfig(name, config)) {
        validationLogger.warn('Invalid server configuration from unified config, skipping', { serverName: name });
        continue;
      }

      // Security scan MCP server config
      const scanResult = scanMcpServerConfig(name, config);
      if (scanResult.blocked) {
        validationLogger.error('MCP server BLOCKED by security scan', {
          serverName: name,
          riskLevel: scanResult.riskLevel,
        });
        validationLogger.warn(formatMcpScanReport(scanResult));
        continue;
      }
      if (scanResult.findings.length > 0) {
        validationLogger.warn(formatMcpScanReport(scanResult));
      }

      validated[name] = config;
    }

    loader.config = { mcpServers: validated };
    loader.inMemory = true;
    return loader;
  }

  reloadConfiguration(): McpConfiguration | null {
    if (this.inMemory) {
      // In-memory config: return existing config (no file to reload from)
      this.logger.debug('In-memory config — reload is a no-op');
      return this.config;
    }
    this.config = null;
    return this.loadConfiguration();
  }

  /**
   * Get server names from configuration file
   */
  getConfiguredServerNames(): string[] {
    const config = this.loadConfiguration();
    return config ? Object.keys(config.mcpServers) : [];
  }

  /**
   * Get raw configuration (for processing by factory)
   */
  getRawServers(): Record<string, McpServerConfig> {
    const config = this.loadConfiguration();
    return config ? { ...config.mcpServers } : {};
  }
}

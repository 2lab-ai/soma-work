import { Logger } from '../logger';
import { getGitHubAppAuth, isGitHubAppConfigured } from '../github-auth.js';
import type { McpServerConfig, McpStdioServerConfig } from './config-loader';

/**
 * Creates and provisions MCP server configurations with authentication
 */
export class McpServerFactory {
  private logger = new Logger('McpServerFactory');

  /**
   * Inject GitHub App authentication into server configurations
   */
  async injectGitHubAuth(
    servers: Record<string, McpServerConfig>
  ): Promise<Record<string, McpServerConfig>> {
    const processedServers: Record<string, McpServerConfig> = {};

    for (const [serverName, serverConfig] of Object.entries(servers)) {
      if (serverName === 'github' && isGitHubAppConfigured()) {
        const githubAuth = getGitHubAppAuth();
        if (githubAuth) {
          try {
            const token = await githubAuth.getInstallationToken();
            const updatedConfig = { ...serverConfig };

            if (updatedConfig.type === 'stdio' || !updatedConfig.type) {
              const stdioConfig = updatedConfig as McpStdioServerConfig;
              stdioConfig.env = {
                ...stdioConfig.env,
                GITHUB_PERSONAL_ACCESS_TOKEN: token,
              };
            }

            processedServers[serverName] = updatedConfig;
            this.logger.info('Updated GitHub MCP server to use GitHub App authentication');
            continue;
          } catch (error) {
            this.logger.error('Failed to get GitHub App token for MCP server:', error);
          }
        }
      }
      processedServers[serverName] = serverConfig;
    }

    return processedServers;
  }

  /**
   * Provision default servers based on available authentication
   */
  async provisionDefaultServers(
    existingServers: Record<string, McpServerConfig> = {}
  ): Promise<Record<string, McpServerConfig>> {
    const baseDirectory = process.env.BASE_DIRECTORY || '/usercontent';
    const servers = { ...existingServers };

    if (isGitHubAppConfigured()) {
      await this.provisionGitHubAppServers(servers, baseDirectory);
    } else if (process.env.GITHUB_TOKEN) {
      this.provisionGitHubTokenServers(servers, baseDirectory);
    } else {
      this.provisionMinimalServers(servers, baseDirectory);
    }

    return servers;
  }

  private async provisionGitHubAppServers(
    servers: Record<string, McpServerConfig>,
    baseDirectory: string
  ): Promise<void> {
    const githubAuth = getGitHubAppAuth();
    if (!githubAuth) return;

    try {
      const token = await githubAuth.getInstallationToken();

      // Add filesystem server if not already configured
      if (!servers.filesystem) {
        servers.filesystem = {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', baseDirectory],
        };
      }

      // Add GitHub server if not already configured
      if (!servers.github) {
        servers.github = {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: token,
          },
        };
      }

      this.logger.info('Added GitHub App-authenticated MCP servers', {
        servers: Object.keys(servers),
        baseDirectory,
      });
    } catch (error) {
      this.logger.error('Failed to configure GitHub App MCP servers:', error);
    }
  }

  private provisionGitHubTokenServers(
    servers: Record<string, McpServerConfig>,
    baseDirectory: string
  ): void {
    const githubToken = process.env.GITHUB_TOKEN;

    // Add filesystem server if not already configured
    if (!servers.filesystem) {
      servers.filesystem = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', baseDirectory],
      };
    }

    // Add GitHub server if not already configured
    if (!servers.github) {
      servers.github = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: githubToken!,
        },
      };
    }

    this.logger.info('Added GitHub token-authenticated MCP servers', {
      servers: Object.keys(servers),
      baseDirectory,
    });
  }

  private provisionMinimalServers(
    servers: Record<string, McpServerConfig>,
    baseDirectory: string
  ): void {
    // Add minimal filesystem server if no GitHub authentication is available
    if (!servers.filesystem) {
      servers.filesystem = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', baseDirectory],
      };
      this.logger.info('Added filesystem MCP server (no GitHub authentication available)');
    }
  }

  /**
   * Get default allowed tools based on server configuration
   */
  getDefaultAllowedTools(serverNames: string[]): string[] {
    return serverNames.map((serverName) => `mcp__${serverName}`);
  }

  /**
   * Determine which servers will be provisioned based on current environment
   */
  getExpectedServerNames(existingServerNames: string[]): string[] {
    const serverNames = new Set<string>(existingServerNames);

    if (isGitHubAppConfigured() || process.env.GITHUB_TOKEN) {
      serverNames.add('filesystem');
      serverNames.add('github');
    } else {
      serverNames.add('filesystem');
    }

    return Array.from(serverNames);
  }
}

import { config } from './config.js';
import { Logger } from './logger.js';
import {
  GitHubApiClient,
  GitHubAppConfig,
  TokenRefreshScheduler,
  GitCredentialsManager,
  Installation,
} from './github/index.js';

const logger = new Logger('GitHubAuth');

// Re-export types for backward compatibility
export type { GitHubAppConfig };

/**
 * GitHubAppAuth - Facade that coordinates GitHub authentication components
 * Maintains backward compatibility while delegating to specialized classes
 */
export class GitHubAppAuth {
  private apiClient: GitHubApiClient;
  private credentialsManager: GitCredentialsManager;
  private tokenScheduler: TokenRefreshScheduler | null = null;
  private installationId?: number;

  constructor(private appConfig: GitHubAppConfig) {
    this.apiClient = new GitHubApiClient(appConfig);
    this.credentialsManager = new GitCredentialsManager();

    if (appConfig.installationId) {
      this.installationId = parseInt(appConfig.installationId, 10);
      this.tokenScheduler = new TokenRefreshScheduler(
        this.apiClient,
        this.credentialsManager,
        this.installationId
      );
    }
  }

  /**
   * Get installation token (delegates to TokenRefreshScheduler or ApiClient)
   */
  async getInstallationToken(installationId?: number): Promise<string> {
    const targetInstallationId = installationId || this.installationId;

    if (!targetInstallationId) {
      throw new Error(
        'Installation ID is required. Either provide it as parameter or configure it in environment variables.'
      );
    }

    // If we have a scheduler for this installation, use it (handles caching)
    if (this.tokenScheduler && targetInstallationId === this.installationId) {
      return this.tokenScheduler.getToken();
    }

    // Otherwise, get token directly from API
    const tokenInfo = await this.apiClient.getInstallationToken(targetInstallationId);
    await this.credentialsManager.updateCredentials(tokenInfo.token);
    return tokenInfo.token;
  }

  /**
   * Get JWT for GitHub App authentication
   */
  async getAppJWT(): Promise<string> {
    return this.apiClient.getAppJWT();
  }

  /**
   * List all installations for the GitHub App
   */
  async listInstallations(): Promise<Installation[]> {
    return this.apiClient.listInstallations();
  }

  /**
   * Invalidate token cache
   */
  invalidateTokenCache(): void {
    if (this.tokenScheduler) {
      this.tokenScheduler.invalidateCache();
    }
  }

  /**
   * Start automatic token refresh
   */
  async startAutoRefresh(): Promise<void> {
    if (!this.tokenScheduler) {
      logger.warn('Cannot start auto-refresh: no installation ID configured');
      return;
    }

    await this.tokenScheduler.startAutoRefresh();
  }

  /**
   * Stop automatic token refresh
   */
  stopAutoRefresh(): void {
    if (this.tokenScheduler) {
      this.tokenScheduler.stopAutoRefresh();
    }
  }
}

// Singleton instance
let githubAppAuth: GitHubAppAuth | null = null;

export function getGitHubAppAuth(): GitHubAppAuth | null {
  if (!config.github.appId || !config.github.privateKey) {
    return null;
  }

  if (!githubAppAuth) {
    githubAppAuth = new GitHubAppAuth({
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      installationId: config.github.installationId,
    });
  }

  return githubAppAuth;
}

export function isGitHubAppConfigured(): boolean {
  return !!(config.github.appId && config.github.privateKey);
}

export async function discoverInstallations(): Promise<void> {
  const githubAuth = getGitHubAppAuth();
  if (!githubAuth) {
    logger.error(
      'GitHub App not configured. Please set GITHUB_APP_ID and GITHUB_PRIVATE_KEY environment variables.'
    );
    return;
  }

  try {
    const installations = await githubAuth.listInstallations();

    if (installations.length === 0) {
      logger.info(
        'No GitHub App installations found. Please install the app on at least one organization or repository.'
      );
      return;
    }

    logger.info('GitHub App installations found:');
    installations.forEach((installation, index) => {
      logger.info(
        `  ${index + 1}. ${installation.account.login} (${installation.account.type}) - ID: ${installation.id}`
      );
    });

    if (!config.github.installationId) {
      logger.info('To use GitHub integration, set GITHUB_INSTALLATION_ID to one of the IDs above.');
    } else {
      const currentInstallation = installations.find(
        (inst) => inst.id.toString() === config.github.installationId
      );
      if (currentInstallation) {
        logger.info(
          `Currently configured for: ${currentInstallation.account.login} (${currentInstallation.account.type})`
        );
      } else {
        logger.warn(
          `Configured installation ID ${config.github.installationId} not found in available installations.`
        );
      }
    }
  } catch (error) {
    logger.error('Failed to discover GitHub App installations:', error);
  }
}

export async function getGitHubTokenForCLI(): Promise<string | null> {
  // First try to get the token from environment variable
  if (config.github.token) {
    logger.info('Using GITHUB_TOKEN from environment variables for Git CLI operations');
    return config.github.token;
  }

  // If no environment token, try to get one from GitHub App
  const githubAuth = getGitHubAppAuth();
  if (githubAuth) {
    try {
      logger.info('Obtaining GitHub App installation token for Git CLI operations');
      const token = await githubAuth.getInstallationToken();
      return token;
    } catch (error) {
      logger.error('Failed to obtain GitHub App installation token:', error);
      return null;
    }
  }

  logger.warn(
    'No GitHub authentication configured. Set GITHUB_TOKEN or configure GitHub App (GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID)'
  );
  return null;
}

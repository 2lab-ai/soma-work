import { Logger } from '../logger';
import { GitHubApiClient, TokenInfo } from './api-client';
import { GitCredentialsManager } from './git-credentials-manager';

const logger = new Logger('TokenRefreshScheduler');

export interface TokenCache {
  token: string;
  expiresAt: Date;
}

/**
 * Manages automatic token refresh scheduling
 * Handles background refresh and retry logic
 */
export class TokenRefreshScheduler {
  private refreshTimer?: NodeJS.Timeout;
  private tokenCache: TokenCache | null = null;

  constructor(
    private apiClient: GitHubApiClient,
    private credentialsManager: GitCredentialsManager,
    private installationId: number
  ) {}

  /**
   * Get cached token or fetch new one
   */
  async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > new Date()) {
      logger.info('Using cached GitHub App installation token');
      return this.tokenCache.token;
    }

    const tokenInfo = await this.apiClient.getInstallationToken(this.installationId);
    this.tokenCache = {
      token: tokenInfo.token,
      expiresAt: tokenInfo.expiresAt,
    };

    // Schedule automatic refresh before expiry
    this.scheduleRefresh();

    // Update git credentials with new token
    await this.credentialsManager.updateCredentials(tokenInfo.token);

    return tokenInfo.token;
  }

  /**
   * Schedule token refresh before expiry
   */
  private scheduleRefresh(): void {
    this.clearRefreshTimer();

    if (!this.tokenCache) {
      return;
    }

    // Calculate when to refresh (5 minutes before expiry, or 50% of lifetime, whichever is shorter)
    const now = new Date();
    const expiresAt = this.tokenCache.expiresAt;
    const totalLifetime = expiresAt.getTime() - now.getTime();
    const refreshBuffer = Math.min(5 * 60 * 1000, totalLifetime * 0.5);
    const refreshAt = new Date(expiresAt.getTime() - refreshBuffer);
    const timeUntilRefresh = refreshAt.getTime() - now.getTime();

    if (timeUntilRefresh <= 0) {
      // Token expires very soon, refresh immediately
      logger.warn('GitHub App token expires very soon, refreshing immediately');
      this.refreshInBackground();
      return;
    }

    logger.info(
      `GitHub App token refresh scheduled for ${refreshAt.toISOString()} (in ${Math.round(timeUntilRefresh / 1000 / 60)} minutes)`
    );

    this.refreshTimer = setTimeout(() => {
      this.refreshInBackground();
    }, timeUntilRefresh);
  }

  /**
   * Refresh token in background
   */
  private async refreshInBackground(): Promise<void> {
    try {
      logger.debug('Background refresh of GitHub App installation token starting');

      // Clear the cache to force a fresh token
      this.tokenCache = null;

      // Get a new token
      const newToken = await this.getToken();

      logger.debug('GitHub App installation token refreshed successfully in background');

      // Update environment variable for child processes
      process.env.GITHUB_TOKEN = newToken;
    } catch (error) {
      logger.error('Failed to refresh GitHub App installation token in background:', error);

      // If refresh fails but we still have some time on the old token, schedule a retry
      if (this.tokenCache && this.tokenCache.expiresAt > new Date()) {
        const retryIn = 2 * 60 * 1000; // Retry in 2 minutes
        logger.debug(`Retrying token refresh in ${retryIn / 1000} seconds`);
        this.refreshTimer = setTimeout(() => {
          this.refreshInBackground();
        }, retryIn);
      }
    }
  }

  /**
   * Clear refresh timer
   */
  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
      logger.debug('GitHub App token refresh timer cleared');
    }
  }

  /**
   * Invalidate token cache
   */
  invalidateCache(): void {
    logger.debug('Invalidating GitHub App installation token cache');
    this.tokenCache = null;
    this.clearRefreshTimer();
  }

  /**
   * Start auto-refresh by getting initial token
   */
  async startAutoRefresh(): Promise<void> {
    try {
      await this.getToken();
      logger.debug('GitHub App auto-refresh started successfully');
    } catch (error) {
      logger.error('Failed to start GitHub App auto-refresh:', error);
      throw error;
    }
  }

  /**
   * Stop auto-refresh
   */
  stopAutoRefresh(): void {
    this.clearRefreshTimer();
    logger.debug('GitHub App auto-refresh stopped');
  }
}

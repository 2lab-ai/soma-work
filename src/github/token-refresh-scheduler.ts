import { Logger } from '../logger';
import type { GitHubApiClient } from './api-client';
import type { GitCredentialsManager } from './git-credentials-manager';

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
  /** Consecutive failed background refreshes — the retry delay doubles from 2 to at most 10 minutes. */
  private failedRefreshes = 0;
  /** Set by stopAutoRefresh: a refresh still in flight does not re-arm. */
  private stopped = false;
  /** Re-writes the current token after a failed credentials write. */
  private writeRetryTimer?: NodeJS.Timeout;

  constructor(
    private apiClient: GitHubApiClient,
    private credentialsManager: GitCredentialsManager,
    private installationId: number,
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

    // Write it to git, the env and the agents' gh hosts.yml. A failed write is retried; the token is valid either way.
    await this.writeCredentials(tokenInfo.token);

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
      `GitHub App token refresh scheduled for ${refreshAt.toISOString()} (in ${Math.round(timeUntilRefresh / 1000 / 60)} minutes)`,
    );

    this.refreshTimer = setTimeout(() => {
      this.refreshInBackground();
    }, timeUntilRefresh);
  }

  /**
   * Refresh token in background. The cached token stays served until a new one arrives (it is still valid while this
   * retries), and a failed refresh retries — 2, 4, 8, then every 10 minutes — until one succeeds, also after the old
   * token expired:
   * otherwise the daemon env, git config and the agents' gh hosts.yml would sit on a dead token (#834).
   */
  private async refreshInBackground(): Promise<void> {
    if (this.stopped) return;
    let tokenInfo: { token: string; expiresAt: Date };
    try {
      logger.debug('Background refresh of GitHub App installation token starting');
      tokenInfo = await this.apiClient.getInstallationToken(this.installationId);
    } catch (error) {
      logger.error('Failed to refresh GitHub App installation token in background:', error);
      if (this.stopped) return;
      const retryIn = Math.min(2 * 60 * 1000 * 2 ** this.failedRefreshes, 10 * 60 * 1000);
      this.failedRefreshes++;
      logger.debug(`Retrying token refresh in ${retryIn / 1000} seconds`);
      this.clearRefreshTimer();
      this.refreshTimer = setTimeout(() => {
        void this.refreshInBackground();
      }, retryIn);
      // A retry alone must not keep the process alive at shutdown.
      this.refreshTimer.unref?.();
      return;
    }
    if (this.stopped) return;
    this.tokenCache = { token: tokenInfo.token, expiresAt: tokenInfo.expiresAt };
    this.failedRefreshes = 0;
    this.scheduleRefresh();
    await this.writeCredentials(tokenInfo.token);
  }

  /**
   * Write the token to git, the env and the agents' gh hosts.yml — on the first mint and on every refresh. A failed
   * write (a git config lock, a refused hosts.yml) does not re-mint: it retries the write of the same token in 2
   * minutes, so agent shells do not read a stale token until the next refresh (#834 review).
   */
  private async writeCredentials(token: string): Promise<void> {
    this.clearWriteRetryTimer();
    try {
      await this.credentialsManager.updateCredentials(token);
      logger.debug('GitHub App installation token written to git, the env and the agent gh hosts.yml');
    } catch (error) {
      logger.error('GitHub App token minted, but writing the credentials failed; retrying in 2 minutes:', error);
      if (this.stopped) return;
      this.writeRetryTimer = setTimeout(
        () => {
          if (!this.stopped && this.tokenCache?.token === token) void this.writeCredentials(token);
        },
        2 * 60 * 1000,
      );
      this.writeRetryTimer.unref?.();
    }
  }

  private clearWriteRetryTimer(): void {
    if (this.writeRetryTimer) {
      clearTimeout(this.writeRetryTimer);
      this.writeRetryTimer = undefined;
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
    this.stopped = true;
    this.clearRefreshTimer();
    this.clearWriteRetryTimer();
    logger.debug('GitHub App auto-refresh stopped');
  }
}

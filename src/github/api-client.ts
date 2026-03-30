import jwt from 'jsonwebtoken';
import { Logger } from '../logger';

const logger = new Logger('GitHubApiClient');

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId?: string;
}

export interface TokenInfo {
  token: string;
  expiresAt: Date;
}

export interface Installation {
  id: number;
  account: {
    login: string;
    type: string;
  };
}

/**
 * GitHub API client for App authentication
 * Handles JWT generation and API calls
 */
export class GitHubApiClient {
  private appId: string;
  private privateKey: string;

  constructor(config: GitHubAppConfig) {
    this.appId = config.appId;
    this.privateKey = config.privateKey;
  }

  /**
   * Generate JWT for GitHub App authentication
   */
  getAppJWT(): string {
    try {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iat: now - 60,
        exp: now + 10 * 60,
        iss: this.appId,
      };

      return jwt.sign(payload, this.privateKey, { algorithm: 'RS256' });
    } catch (error) {
      logger.error('Failed to generate GitHub App JWT:', error);
      throw new Error(
        `Failed to generate GitHub App JWT: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get installation access token from GitHub API
   */
  async getInstallationToken(installationId: number): Promise<TokenInfo> {
    try {
      logger.debug(`Generating GitHub App installation token for installation ${installationId}`);

      const appJWT = this.getAppJWT();
      const response = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${appJWT}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const tokenData = (await response.json()) as { token: string; expires_at: string };
      const expiresAt = new Date(tokenData.expires_at);

      logger.debug(`GitHub App installation token generated, expires at ${expiresAt.toISOString()}`);

      return {
        token: tokenData.token,
        expiresAt,
      };
    } catch (error) {
      logger.error('Failed to generate GitHub App installation token:', error);
      throw new Error(
        `Failed to authenticate with GitHub App: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * List all installations for the GitHub App
   */
  async listInstallations(): Promise<Installation[]> {
    try {
      logger.debug('Fetching GitHub App installations');

      const appJWT = this.getAppJWT();
      const response = await fetch('https://api.github.com/app/installations', {
        headers: {
          Authorization: `Bearer ${appJWT}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const installations = (await response.json()) as Array<{
        id: number;
        account: { login: string; type: string };
      }>;
      logger.debug(`Found ${installations.length} GitHub App installations`);

      return installations.map((installation) => ({
        id: installation.id,
        account: {
          login: installation.account.login,
          type: installation.account.type,
        },
      }));
    } catch (error) {
      logger.error('Failed to list GitHub App installations:', error);
      throw new Error(
        `Failed to list installations: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}

import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Logger } from '../logger';
import { clearAgentGhConfigDir, writeAgentGhHosts } from './agent-gh-config';

const logger = new Logger('GitCredentialsManager');

/**
 * git's credentials were written, the agents' gh `hosts.yml` was not: agent shells read the env token until a retry
 * writes it (#834 review).
 */
export class GhHostsWriteError extends Error {
  constructor(readonly reason: unknown) {
    super(`Failed to write the agent gh hosts.yml: ${(reason as Error)?.message ?? String(reason)}`);
    this.name = 'GhHostsWriteError';
  }
}

/**
 * Manages local git credentials and configuration
 * Handles .git-credentials file and git config updates
 */
export class GitCredentialsManager {
  /**
   * @param ghConfigDir a bot-owned gh config dir: every refresh writes the token's `hosts.yml` there and agent shells
   *   get it as `GH_CONFIG_DIR` (#834). Unset (a PAT setup), gh keeps reading the env.
   */
  constructor(private readonly ghConfigDir?: string) {}

  /**
   * Update .git-credentials file and git config with new token
   */
  async updateCredentials(token: string): Promise<void> {
    try {
      const homeDir = os.homedir();
      const credentialsPath = path.join(homeDir, '.git-credentials');
      const cleanToken = token.trim();

      // Update .git-credentials file with new token (GitHub App format)
      const credentialEntry = `https://x-access-token:${cleanToken}@github.com`;
      await fs.writeFile(credentialsPath, credentialEntry + '\n', { mode: 0o600 });

      // Remove any existing GitHub URL rewrites to prevent duplicates
      await this.removeExistingGitHubUrlRewrites();

      // Update global Git configuration with new token
      await this.executeGitCommand([
        'config',
        '--global',
        `url.https://x-access-token:${cleanToken}@github.com/.insteadOf`,
        'https://github.com/',
      ]);
      await this.executeGitCommand(['config', '--global', 'credential.https://github.com.username', cleanToken]);

      // Update environment variable for immediate use
      process.env.GITHUB_TOKEN = cleanToken;

      await this.updateGhHosts(cleanToken);

      logger.debug('Git credentials updated successfully with refreshed GitHub App token');
    } catch (error) {
      logger.error('Failed to update Git credentials:', error);
      throw error;
    }
  }

  /**
   * gh's credential for agent shells (#834): re-read by gh on every call, so it outlives the turn's env copy. A failed
   * write stops serving the dir — gh must not keep reading a token that will expire; new turns fall back to the token
   * just put in the env — and is thrown as {@link GhHostsWriteError}, so the refresh scheduler retries the write.
   */
  private async updateGhHosts(token: string): Promise<void> {
    if (!this.ghConfigDir) return;
    try {
      await writeAgentGhHosts(this.ghConfigDir, token);
    } catch (error) {
      clearAgentGhConfigDir();
      throw new GhHostsWriteError(error);
    }
  }

  /**
   * Remove existing GitHub URL rewrites from git config
   */
  async removeExistingGitHubUrlRewrites(): Promise<void> {
    try {
      // Get all url.*.insteadOf config entries
      const result = await this.executeGitCommandWithOutput([
        'config',
        '--global',
        '--get-regexp',
        '^url\\..*\\.insteadOf$',
        'https://github.com/',
      ]);

      if (result.stdout.trim()) {
        const lines = result.stdout.trim().split('\n');
        for (const line of lines) {
          // Extract the config key (everything before the space)
          const configKey = line.split(' ')[0];
          if (configKey && configKey.includes('github.com')) {
            logger.debug(`Removing existing git config entry: ${configKey}`);
            try {
              await this.executeGitCommand(['config', '--global', '--unset', configKey]);
            } catch (error) {
              // Ignore errors when unsetting (entry might not exist)
              logger.debug(`Failed to unset ${configKey}, continuing:`, error);
            }
          }
        }
      }
    } catch (error) {
      // If getting existing config fails, just continue - this is not critical
      logger.debug('Failed to get existing git config entries, continuing:', error);
    }
  }

  /**
   * Execute git command with output capture
   */
  private async executeGitCommandWithOutput(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const git = spawn('git', args);
      let stdout = '';
      let stderr = '';

      git.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      git.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      git.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Git command failed with code ${code}: ${stderr}`));
        }
      });

      git.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Execute git command
   */
  private async executeGitCommand(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const git = spawn('git', args);
      let stderr = '';

      git.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      git.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Git command failed with code ${code}: ${stderr}`));
        }
      });

      git.on('error', (error) => {
        reject(error);
      });
    });
  }
}

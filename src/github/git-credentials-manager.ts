import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Logger } from '../logger';

const logger = new Logger('GitCredentialsManager');

/**
 * Manages local git credentials and configuration
 * Handles .git-credentials file and git config updates
 */
export class GitCredentialsManager {
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
      await this.executeGitCommand([
        'config',
        '--global',
        'credential.https://github.com.username',
        cleanToken,
      ]);

      // Update environment variable for immediate use
      process.env.GITHUB_TOKEN = cleanToken;

      logger.debug('Git credentials updated successfully with refreshed GitHub App token');
    } catch (error) {
      logger.error('Failed to update Git credentials:', error);
      throw error;
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
  private async executeGitCommandWithOutput(
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
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

import { Logger } from './logger';
import { config } from './config';
import { DirectoryFormatter } from './slack/formatters';
import { normalizeTmpPath } from './path-utils';
import * as path from 'path';
import * as fs from 'fs';

/**
 * WorkingDirectoryManager - Simplified version with fixed user directories
 *
 * Each user has a fixed working directory: {BASE_DIRECTORY}/{userId}/
 * - Users cannot set custom working directories
 * - Directories are automatically created on first access
 * - Users are isolated to their own directory
 */
export class WorkingDirectoryManager {
  private logger = new Logger('WorkingDirectoryManager');
  private sessionDirCounter = 0;

  /**
   * Get the working directory for a user.
   * Returns fixed path: {BASE_DIRECTORY}/{userId}/
   * Creates the directory if it doesn't exist.
   */
  getWorkingDirectory(_channelId: string, _threadTs?: string, userId?: string): string | undefined {
    if (!userId) {
      this.logger.warn('No userId provided for getWorkingDirectory');
      return undefined;
    }

    if (!config.baseDirectory) {
      this.logger.error('BASE_DIRECTORY is not configured');
      return undefined;
    }

    // Fixed path: BASE_DIRECTORY/{userId}/
    const userDir = path.join(config.baseDirectory, userId);

    // Auto-create directory if it doesn't exist
    if (!fs.existsSync(userDir)) {
      try {
        fs.mkdirSync(userDir, { recursive: true });
        this.logger.info('Created user working directory', {
          userId,
          directory: userDir,
        });
      } catch (error) {
        this.logger.error('Failed to create user working directory', {
          userId,
          directory: userDir,
          error,
        });
        return undefined;
      }
    }

    this.logger.debug('Using user working directory', {
      userId,
      directory: userDir,
    });

    return userDir;
  }

  /**
   * Check if text is a set command (for showing informational message)
   * Returns the attempted path if it's a set command, null otherwise
   */
  parseSetCommand(text: string): string | null {
    // Support both with and without slash prefix: cwd path, /cwd path
    const cwdMatch = text.match(/^\/?cwd\s+(.+)$/i);
    if (cwdMatch) {
      return cwdMatch[1].trim();
    }

    const setMatch = text.match(/^\/?set\s+(?:cwd|dir|directory|working[- ]?directory)\s+(.+)$/i);
    if (setMatch) {
      return setMatch[1].trim();
    }

    return null;
  }

  isGetCommand(text: string): boolean {
    // Support both with and without slash prefix: cwd, /cwd
    return /^\/?(?:get\s+)?(?:cwd|dir|directory|working[- ]?directory)(?:\?)?$/i.test(text.trim());
  }

  formatDirectoryMessage(directory: string | undefined, _context: string): string {
    if (!directory) {
      return '❌ Working directory not configured. Please ensure BASE_DIRECTORY is set.';
    }
    return `📁 Working directory: \`${directory}\`\n_Your working directory is fixed and cannot be changed._`;
  }

  /**
   * @deprecated - Working directories are now fixed per user
   * This method is kept for backward compatibility but does nothing
   */
  setWorkingDirectory(_channelId: string, _directory: string, _threadTs?: string, _userId?: string): { success: boolean; resolvedPath?: string; error?: string } {
    return {
      success: false,
      error: 'Working directory setting is disabled. Each user has a fixed directory.',
    };
  }

  /**
   * @deprecated - Working directories are now fixed per user
   */
  removeWorkingDirectory(_channelId: string, _threadTs?: string, _userId?: string): boolean {
    return false;
  }

  /**
   * @deprecated - No longer used with fixed directories
   */
  listConfigurations(): never[] {
    return [];
  }

  /**
   * @deprecated - Use getWorkingDirectory instead
   */
  getChannelWorkingDirectory(_channelId: string): string | undefined {
    return undefined;
  }

  /**
   * @deprecated - No longer used with fixed directories
   */
  hasChannelWorkingDirectory(_channelId: string): boolean {
    return false;
  }

  formatChannelSetupMessage(_channelId: string, _channelName: string): string {
    return DirectoryFormatter.formatChannelSetupMessage(_channelId, _channelName);
  }

  /**
   * Create a session-unique base working directory under /tmp/{slackId}/.
   *
   * Pattern: /tmp/{slackId}/session_{epochMs}_{counter}
   *
   * Used as the cwd for Claude's Bash tool. Each session gets its own
   * directory so concurrent sessions never share a working directory.
   */
  createSessionBaseDir(slackId: string): string | undefined {
    if (!slackId) {
      this.logger.warn('slackId is required for createSessionBaseDir');
      return undefined;
    }

    const timestamp = Date.now().toString();
    const counter = this.sessionDirCounter++;
    const dirName = `session_${timestamp}_${counter}`;
    const fullPath = normalizeTmpPath(path.join('/tmp', slackId, dirName));

    try {
      fs.mkdirSync(fullPath, { recursive: true });
      this.logger.info('Created session base directory', {
        slackId,
        directory: fullPath,
      });
      return fullPath;
    } catch (error) {
      this.logger.error('Failed to create session base directory', {
        slackId,
        directory: fullPath,
        error,
      });
      return undefined;
    }
  }

  /**
   * Create a unique session-scoped working directory under /tmp/{slackId}/.
   *
   * Pattern: /tmp/{slackId}/{repoName}_{epochMs}_{sanitizedPrName}
   *
   * Each invocation produces a unique directory (epoch ms timestamp),
   * so concurrent sessions for the same user/repo never collide.
   */
  createSessionWorkingDir(slackId: string, repoUrl: string, prName: string): string | undefined {
    if (!slackId) {
      this.logger.warn('slackId is required for createSessionWorkingDir');
      return undefined;
    }

    // Extract repo name from URL
    let repoName: string;
    try {
      const url = new URL(repoUrl);
      const lastSegment = url.pathname.split('/').pop();
      repoName = lastSegment?.replace(/\.git$/, '') || '';
      if (!repoName) {
        this.logger.error('Could not extract repo name from URL', { repoUrl });
        return undefined;
      }
    } catch (error) {
      this.logger.error('Invalid repoUrl', { repoUrl, error });
      return undefined;
    }

    // Sanitize prName for filesystem safety
    const safePrName = prName
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 50);

    // Build unique directory name with epoch ms timestamp + monotonic counter
    const timestamp = Date.now().toString();
    const counter = this.sessionDirCounter++;
    const dirName = `${repoName}_${timestamp}_${counter}_${safePrName}`;
    const fullPath = normalizeTmpPath(path.join('/tmp', slackId, dirName));

    try {
      fs.mkdirSync(fullPath, { recursive: true });
      this.logger.info('Created session working directory', {
        slackId,
        repoName,
        prName: safePrName,
        directory: fullPath,
      });
      return fullPath;
    } catch (error) {
      this.logger.error('Failed to create session working directory', {
        slackId,
        directory: fullPath,
        error,
      });
      return undefined;
    }
  }
}
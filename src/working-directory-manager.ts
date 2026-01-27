import { Logger } from './logger';
import { config } from './config';
import { DirectoryFormatter } from './slack/formatters';
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
}
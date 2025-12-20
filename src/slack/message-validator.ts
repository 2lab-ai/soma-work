import { WorkingDirectoryManager } from '../working-directory-manager';
import { ClaudeHandler } from '../claude-handler';
import { config } from '../config';
import { Logger } from '../logger';

export interface ValidationResult {
  valid: boolean;
  workingDirectory?: string;
  errorMessage?: string;
}

export interface InterruptCheckResult {
  canInterrupt: boolean;
  reason?: string;
}

export class MessageValidator {
  private logger = new Logger('MessageValidator');

  constructor(
    private workingDirManager: WorkingDirectoryManager,
    private claudeHandler: ClaudeHandler
  ) {}

  /**
   * Validate that a working directory is set for the given context
   * Returns validation result with error message if not valid
   */
  validateWorkingDirectory(
    userId: string,
    channelId: string,
    threadTs?: string
  ): ValidationResult {
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channelId,
      threadTs,
      userId
    );

    if (workingDirectory) {
      return { valid: true, workingDirectory };
    }

    const isDM = channelId.startsWith('D');
    const errorMessage = this.buildCwdErrorMessage(channelId, threadTs, isDM);

    return {
      valid: false,
      errorMessage,
    };
  }

  /**
   * Build appropriate error message based on context
   */
  private buildCwdErrorMessage(
    channelId: string,
    threadTs?: string,
    isDM?: boolean
  ): string {
    let errorMessage = `⚠️ No working directory set. `;

    if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channelId)) {
      // No channel default set
      errorMessage += `Please set a default working directory for this channel first using:\n`;
      if (config.baseDirectory) {
        errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
        errorMessage += `Base directory: \`${config.baseDirectory}\``;
      } else {
        errorMessage += `\`cwd /path/to/directory\``;
      }
    } else if (threadTs) {
      // In thread but no thread-specific directory
      errorMessage += `You can set a thread-specific working directory using:\n`;
      if (config.baseDirectory) {
        errorMessage += `\`@claudebot cwd project-name\` or \`@claudebot cwd /absolute/path\``;
      } else {
        errorMessage += `\`@claudebot cwd /path/to/directory\``;
      }
    } else {
      errorMessage += `Please set one first using:\n\`cwd /path/to/directory\``;
    }

    return errorMessage;
  }

  /**
   * Check if a user can interrupt the current session
   */
  checkInterruptPermission(
    userId: string,
    channelId: string,
    threadTs: string
  ): InterruptCheckResult {
    const canInterrupt = this.claudeHandler.canInterrupt(channelId, threadTs, userId);

    if (canInterrupt) {
      return { canInterrupt: true };
    }

    const session = this.claudeHandler.getSession(channelId, threadTs);
    if (!session) {
      return { canInterrupt: true };
    }

    return {
      canInterrupt: false,
      reason: `Session owned by ${session.ownerName}, current initiator: ${session.currentInitiatorName}`,
    };
  }

  /**
   * Get working directory without validation (for contexts where it's optional)
   */
  getWorkingDirectory(
    userId: string,
    channelId: string,
    threadTs?: string
  ): string | undefined {
    return this.workingDirManager.getWorkingDirectory(channelId, threadTs, userId);
  }
}

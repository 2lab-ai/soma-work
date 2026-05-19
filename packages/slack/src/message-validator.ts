import { Logger } from '@soma/common/logger';

export interface ValidationResult {
  valid: boolean;
  workingDirectory?: string;
  errorMessage?: string;
}

export interface InterruptCheckResult {
  canInterrupt: boolean;
  reason?: string;
}

export interface WorkingDirectoryReader {
  getWorkingDirectory(channelId: string, threadTs: string | undefined, userId: string): string | undefined;
  hasChannelWorkingDirectory(channelId: string): boolean;
}

export interface InterruptSession {
  ownerName?: string;
  currentInitiatorName?: string;
}

export interface InterruptSessionReader {
  canInterrupt(channelId: string, threadTs: string, userId: string): boolean;
  getSession(channelId: string, threadTs: string): InterruptSession | undefined;
}

let getBaseDirectory: () => string | undefined = () => process.env.SOMA_BASE_DIRECTORY || process.env.BASE_DIRECTORY;

export function setMessageValidatorBaseDirectoryProvider(provider: () => string | undefined): void {
  getBaseDirectory = provider;
}

export class MessageValidator {
  private logger = new Logger('MessageValidator');

  constructor(
    private workingDirManager: WorkingDirectoryReader,
    private claudeHandler: InterruptSessionReader,
  ) {}

  /**
   * Validate that a working directory is set for the given context.
   */
  validateWorkingDirectory(userId: string, channelId: string, threadTs?: string): ValidationResult {
    const workingDirectory = this.workingDirManager.getWorkingDirectory(channelId, threadTs, userId);

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

  private buildCwdErrorMessage(channelId: string, threadTs?: string, isDM?: boolean): string {
    let errorMessage = `⚠️ No working directory set. `;
    const baseDirectory = getBaseDirectory();

    if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channelId)) {
      errorMessage += `Please set a default working directory for this channel first using:\n`;
      if (baseDirectory) {
        errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
        errorMessage += `Base directory: \`${baseDirectory}\``;
      } else {
        errorMessage += `\`cwd /path/to/directory\``;
      }
    } else if (threadTs) {
      errorMessage += `You can set a thread-specific working directory using:\n`;
      if (baseDirectory) {
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
   * Check if a user can interrupt the current session.
   */
  checkInterruptPermission(userId: string, channelId: string, threadTs: string): InterruptCheckResult {
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
   * Get working directory without validation for contexts where it is optional.
   */
  getWorkingDirectory(userId: string, channelId: string, threadTs?: string): string | undefined {
    return this.workingDirManager.getWorkingDirectory(channelId, threadTs, userId);
  }
}

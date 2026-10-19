export interface ValidationResult {
  valid: boolean;
  workingDirectory?: string;
  errorMessage?: string;
}

export interface WorkingDirectoryReader {
  getWorkingDirectory(channelId: string, threadTs: string | undefined, userId: string): string | undefined;
  hasChannelWorkingDirectory(channelId: string): boolean;
}

let getBaseDirectory: () => string | undefined = () => process.env.SOMA_BASE_DIRECTORY || process.env.BASE_DIRECTORY;

export function setMessageValidatorBaseDirectoryProvider(provider: () => string | undefined): void {
  getBaseDirectory = provider;
}

export class MessageValidator {
  constructor(private workingDirManager: WorkingDirectoryReader) {}

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
   * Get working directory without validation for contexts where it is optional.
   */
  getWorkingDirectory(userId: string, channelId: string, threadTs?: string): string | undefined {
    return this.workingDirManager.getWorkingDirectory(channelId, threadTs, userId);
  }
}

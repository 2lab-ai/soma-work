import { config } from '../../config';

/**
 * Formats directory-related messages for Slack
 */
export class DirectoryFormatter {
  /**
   * Format message showing current working directory status
   */
  static formatDirectoryMessage(directory: string | undefined, context: string): string {
    if (directory) {
      let message = `Current working directory for ${context}: \`${directory}\``;
      if (config.baseDirectory) {
        message += `\n\nBase directory: \`${config.baseDirectory}\``;
        message += `\nYou can use relative paths like \`cwd project-name\` or absolute paths.`;
      }
      return message;
    }

    let message = `No working directory set for ${context}. Please set one using:`;
    if (config.baseDirectory) {
      message += `\n\`cwd project-name\` (relative to base directory)`;
      message += `\n\`cwd /absolute/path/to/directory\` (absolute path)`;
      message += `\n\nBase directory: \`${config.baseDirectory}\``;
    } else {
      message += `\n\`cwd /path/to/directory\` or \`set directory /path/to/directory\``;
    }
    return message;
  }

  /**
   * Format channel setup message for first-time directory configuration
   */
  static formatChannelSetupMessage(channelId: string, channelName: string): string {
    const hasBaseDir = !!config.baseDirectory;

    let message = `🏠 **Channel Working Directory Setup**\n\n`;
    message += `Please set the default working directory for #${channelName}:\n\n`;

    if (hasBaseDir) {
      message += `**Options:**\n`;
      message += `• \`cwd project-name\` (relative to: \`${config.baseDirectory}\`)\n`;
      message += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
    } else {
      message += `**Usage:**\n`;
      message += `• \`cwd /path/to/project\`\n`;
      message += `• \`set directory /path/to/project\`\n\n`;
    }

    message += `This becomes the default for all conversations in this channel.\n`;
    message += `Individual threads can override this by mentioning me with a different \`cwd\` command.`;

    return message;
  }

  /**
   * Format success message after setting working directory
   */
  static formatSetSuccessMessage(resolvedPath: string): string {
    let message = `✅ Working directory set to: \`${resolvedPath}\``;
    if (config.baseDirectory) {
      message += `\n\nBase directory: \`${config.baseDirectory}\``;
    }
    return message;
  }

  /**
   * Format error message for directory not found
   */
  static formatNotFoundError(directory: string): string {
    let message = `Directory not found: "${directory}"`;
    if (config.baseDirectory) {
      message += ` (checked in base directory: ${config.baseDirectory})`;
    }
    return message;
  }
}

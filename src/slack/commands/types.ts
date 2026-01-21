import { WorkingDirectoryManager } from '../../working-directory-manager';
import { McpManager } from '../../mcp-manager';
import { ClaudeHandler } from '../../claude-handler';
import { SessionUiManager } from '../session-manager';
import { RequestCoordinator } from '../request-coordinator';

/**
 * Context passed to command handlers
 */
export interface CommandContext {
  user: string;
  channel: string;
  threadTs: string;
  text: string;
  say: SayFn;
}

/**
 * Dependencies injected into command handlers
 */
export interface CommandDependencies {
  workingDirManager: WorkingDirectoryManager;
  mcpManager: McpManager;
  claudeHandler: ClaudeHandler;
  sessionUiManager: SessionUiManager;
  requestCoordinator: RequestCoordinator;
}

/**
 * Result of command execution
 */
export interface CommandResult {
  handled: boolean;
  error?: string;
  /** If set, continue processing with this prompt after command completes (e.g., /new <prompt>) */
  continueWithPrompt?: string;
}

/**
 * Slack say function type
 */
export type SayFn = (message: {
  text: string;
  thread_ts?: string;
  blocks?: any[];
}) => Promise<{ ts?: string; channel?: string }>;

/**
 * Command handler interface
 */
export interface CommandHandler {
  /**
   * Check if this handler can process the given text
   */
  canHandle(text: string): boolean;

  /**
   * Execute the command
   */
  execute(ctx: CommandContext): Promise<CommandResult>;
}

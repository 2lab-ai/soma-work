import type { ClaudeHandler } from '../../claude-handler';
import type { McpManager } from '../../mcp-manager';
import type { WorkflowType } from '../../types';
import type { WorkingDirectoryManager } from '../../working-directory-manager';
import type { ContextWindowManager } from '../context-window-manager';
import type { ReactionManager } from '../reaction-manager';
import type { RequestCoordinator } from '../request-coordinator';
import type { SessionUiManager } from '../session-manager';
import type { SlackApiHelper } from '../slack-api-helper';

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
  slackApi: SlackApiHelper;
  reactionManager: ReactionManager;
  contextWindowManager: ContextWindowManager;
}

/**
 * Result of command execution
 */
export interface CommandResult {
  handled: boolean;
  error?: string;
  /** If set, continue processing with this prompt after command completes (e.g., /new <prompt>) */
  continueWithPrompt?: string;
  /** If set, skip dispatch and force this workflow for the next stream execution */
  forceWorkflow?: WorkflowType;
}

/**
 * Slack say function type
 */
export type SayFn = (message: {
  text: string;
  thread_ts?: string;
  blocks?: any[];
  attachments?: any[];
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

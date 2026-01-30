import { Logger } from '../../logger';
import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CwdHandler } from './cwd-handler';
import { McpHandler } from './mcp-handler';
import { BypassHandler } from './bypass-handler';
import { PersonaHandler } from './persona-handler';
import { ModelHandler } from './model-handler';
import { HelpHandler } from './help-handler';
import { SessionHandler } from './session-handler';
import { RestoreHandler } from './restore-handler';
import { NewHandler } from './new-handler';
import { ContextHandler } from './context-handler';
import { RenewHandler } from './renew-handler';
import { LinkHandler } from './link-handler';
import { CloseHandler } from './close-handler';
import { CommandParser } from '../command-parser';

/**
 * Routes commands to appropriate handlers
 */
export class CommandRouter {
  private logger = new Logger('CommandRouter');
  private handlers: CommandHandler[] = [];

  constructor(deps: CommandDependencies) {
    // Register all command handlers in priority order
    // Order matters - more specific handlers should come first
    this.handlers = [
      new CwdHandler(deps),
      new McpHandler(deps),
      new BypassHandler(),
      new PersonaHandler(),
      new ModelHandler(),
      new RestoreHandler(),
      new NewHandler(deps),
      new ContextHandler(deps),
      new RenewHandler(deps),
      new LinkHandler(deps),
      new CloseHandler(deps),
      new HelpHandler(),
      new SessionHandler(deps),
    ];
  }

  /**
   * Try to route the message to a command handler
   * @returns CommandResult with handled=true if a command was executed
   */
  async route(ctx: CommandContext): Promise<CommandResult> {
    const { text, say, threadTs } = ctx;

    if (!text) {
      return { handled: false };
    }

    for (const handler of this.handlers) {
      if (handler.canHandle(text)) {
        this.logger.debug('Routing to handler', {
          handler: handler.constructor.name,
          text: text.substring(0, 50),
        });

        try {
          const result = await handler.execute(ctx);
          if (result.handled) {
            return result;
          }
        } catch (error: any) {
          this.logger.error('Error executing command handler', {
            handler: handler.constructor.name,
            error: error.message,
          });
          return { handled: false, error: error.message };
        }
      }
    }

    // Check if it looks like a command but wasn't handled
    const { isPotential, keyword } = CommandParser.isPotentialCommand(text);
    if (isPotential) {
      this.logger.debug('Unrecognized potential command', { keyword, text: text.substring(0, 50) });
      await say({
        text: `❓ \`${keyword}\` 명령어를 인식할 수 없습니다. \`help\`를 입력하여 사용 가능한 명령어를 확인하세요.`,
        thread_ts: threadTs,
      });
      return { handled: true }; // Mark as handled to prevent Claude processing
    }

    return { handled: false };
  }

  /**
   * Check if the text matches any command
   */
  isCommand(text: string): boolean {
    if (!text) return false;
    return this.handlers.some(handler => handler.canHandle(text));
  }
}

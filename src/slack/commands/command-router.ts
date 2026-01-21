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
      new HelpHandler(),
      new SessionHandler(deps),
    ];
  }

  /**
   * Try to route the message to a command handler
   * @returns CommandResult with handled=true if a command was executed
   */
  async route(ctx: CommandContext): Promise<CommandResult> {
    const { text } = ctx;

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

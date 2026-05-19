import { Logger } from '@soma/common/logger';
import { CommandParser } from '../command-parser';
import { isSlashForbidden, SLASH_FORBIDDEN_MESSAGE } from '../z/capability';
import { stripZPrefix } from '../z/normalize';
import { parseTopic, translateToLegacy } from '../z/router';

export interface CommandContext {
  user: string;
  channel: string;
  threadTs: string;
  text: string;
  say: SayFn;
  triggerId?: string;
  postEphemeral?: PostEphemeralFn;
}

export interface CommandDependencies {
  [key: string]: any;
}

export interface CommandResult {
  handled: boolean;
  error?: string;
  continueWithPrompt?: string;
  forceWorkflow?: any;
}

export type SayFn = (message: {
  text: string;
  thread_ts?: string;
  blocks?: any[];
  attachments?: any[];
}) => Promise<{ ts?: string; channel?: string }>;

export type PostEphemeralFn = (message: { text: string; blocks?: any[] }) => Promise<void>;

export interface CommandHandler {
  canHandle(text: string, userId?: string): boolean;
  execute(ctx: CommandContext): Promise<CommandResult>;
}

export interface CommandRouterHandlers {
  handlers: CommandHandler[];
  newHandler: CommandHandler;
  skillForceHandler: CommandHandler;
  goalHandler?: CommandHandler;
}

export interface CommandRouterProviders {
  createHandlers?: (deps: CommandDependencies) => CommandRouterHandlers;
}

const providers: Required<CommandRouterProviders> = {
  createHandlers: () => {
    throw new Error('CommandRouter handler provider is not configured.');
  },
};

export function setCommandRouterProviders(next: CommandRouterProviders): void {
  if (next.createHandlers) providers.createHandlers = next.createHandlers;
}

/**
 * Routes command text to concrete handlers supplied by the app composition root.
 */
export class CommandRouter {
  private logger = new Logger('CommandRouter');
  private handlers: CommandHandler[];
  private newHandler: CommandHandler;
  private skillForceHandler: CommandHandler;
  private goalHandler?: CommandHandler;

  constructor(deps: CommandDependencies) {
    const wired = providers.createHandlers(deps);
    this.handlers = wired.handlers;
    this.newHandler = wired.newHandler;
    this.skillForceHandler = wired.skillForceHandler;
    this.goalHandler = wired.goalHandler;
  }

  async route(ctx: CommandContext): Promise<CommandResult> {
    const { say, threadTs } = ctx;
    const originalText = ctx.text;

    if (!originalText) {
      return { handled: false };
    }

    const zPrefixRemainder = stripZPrefix(originalText.trim());
    if (zPrefixRemainder !== null) {
      if (!zPrefixRemainder) {
        await say({ text: CommandParser.getHelpMessage(), thread_ts: threadTs });
        return { handled: true };
      }
      if (ctx.threadTs === ctx.channel) {
        const { topic, verb, arg } = parseTopic(zPrefixRemainder);
        if (topic && isSlashForbidden(topic, verb, arg)) {
          await say({ text: SLASH_FORBIDDEN_MESSAGE, thread_ts: threadTs });
          return { handled: true };
        }
      }
      ctx.text = translateToLegacy(zPrefixRemainder);
    }

    const routedText = ctx.text ?? originalText;

    if (CommandParser.isNewCommand(routedText)) {
      const newResult = await this.newHandler.execute(ctx);
      if (newResult.continueWithPrompt === undefined) {
        return newResult;
      }
      const remainder = newResult.continueWithPrompt;
      if (this.skillForceHandler.canHandle(remainder, ctx.user)) {
        const skillResult = await this.skillForceHandler.execute({ ...ctx, text: remainder });
        if (skillResult.handled) {
          return skillResult;
        }
      }
      return newResult;
    }

    // Goal + skill split (e.g. `goal set X $z foo`). If a resolvable `$skill`
    // token appears in a goal command, set the goal first, then re-dispatch
    // the skill suffix through SkillForceHandler so this turn already carries
    // the `<invoked_skills>` block. Falls through to the normal handler loop
    // when no `$skill` token is resolvable.
    if (this.goalHandler && CommandParser.isGoalCommand(routedText)) {
      const skillRefPattern = /\$[\w-]+(?::[\w-]+)?/g;
      let split: { goalText: string; skillText: string } | null = null;
      let skillMatch = skillRefPattern.exec(routedText);
      while (skillMatch !== null) {
        if (this.skillForceHandler.canHandle(skillMatch[0], ctx.user)) {
          split = {
            goalText: routedText.slice(0, skillMatch.index).trim(),
            skillText: routedText.slice(skillMatch.index).trim(),
          };
          break;
        }
        skillMatch = skillRefPattern.exec(routedText);
      }

      if (split) {
        const goalResult = await this.goalHandler.execute({ ...ctx, text: split.goalText });
        if (goalResult.continueWithPrompt === undefined) {
          return goalResult;
        }
        if (this.skillForceHandler.canHandle(split.skillText, ctx.user)) {
          const skillResult = await this.skillForceHandler.execute({ ...ctx, text: split.skillText });
          if (skillResult.handled) {
            return skillResult;
          }
        }
        return goalResult;
      }
    }

    for (const handler of this.handlers) {
      if (handler.canHandle(routedText, ctx.user)) {
        this.logger.debug('Routing to handler', {
          handler: handler.constructor.name,
          text: routedText.substring(0, 50),
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

    const { isPotential, keyword } = CommandParser.isPotentialCommand(routedText);
    if (isPotential) {
      this.logger.debug('Unrecognized potential command', { keyword, text: routedText.substring(0, 50) });
      await say({
        text: `❓ \`${keyword}\` 명령어를 인식할 수 없습니다. \`help\`를 입력하여 사용 가능한 명령어를 확인하세요.`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    return { handled: false };
  }

  isCommand(text: string): boolean {
    if (!text) return false;
    return this.handlers.some((handler) => handler.canHandle(text));
  }
}

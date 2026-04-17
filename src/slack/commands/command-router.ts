import { Logger } from '../../logger';
import { getReportDeps } from '../../metrics';
import { CommandParser } from '../command-parser';
import { isSlashForbidden, SLASH_FORBIDDEN_MESSAGE } from '../z/capability';
import { stripZPrefix } from '../z/normalize';
import { parseTopic, translateToLegacy } from '../z/router';
import { AdminHandler } from './admin-handler';
import { BypassHandler } from './bypass-handler';
import { CctHandler } from './cct-handler';
import { CloseHandler } from './close-handler';
import { CompactHandler } from './compact-handler';
import { ContextHandler } from './context-handler';
import { CwdHandler } from './cwd-handler';
import { EffortHandler } from './effort-handler';
import { EmailHandler } from './email-handler';
import { HelpHandler } from './help-handler';
import { InstructionsHandler } from './instructions-handler';
import { LinkHandler } from './link-handler';
import { LlmChatHandler } from './llm-chat-handler';
import { MarketplaceHandler } from './marketplace-handler';
import { McpHandler } from './mcp-handler';
import { MemoryHandler } from './memory-handler';
import { ModelHandler } from './model-handler';
import { NewHandler } from './new-handler';
import { NotifyHandler } from './notify-handler';
import { OnboardingHandler } from './onboarding-handler';
import { PersonaHandler } from './persona-handler';
import { PluginsHandler } from './plugins-handler';
import { PromptHandler } from './prompt-handler';
import { RateHandler } from './rate-handler';
import { RenewHandler } from './renew-handler';
import { ReportHandler } from './report-handler';
import { RestoreHandler } from './restore-handler';
import { SandboxHandler } from './sandbox-handler';
import { SessionCommandHandler } from './session-command-handler';
import { SessionHandler } from './session-handler';
import { SkillForceHandler } from './skill-force-handler';
import { SkillsHandler } from './skills-handler';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';
import { UsageHandler } from './usage-handler';
import { VerbosityHandler } from './verbosity-handler';
import { WebhookHandler } from './webhook-handler';

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
      new LlmChatHandler(),
      new AdminHandler(),
      new PromptHandler(deps),
      new InstructionsHandler(deps),
      new CctHandler(),
      new CwdHandler(deps),
      new McpHandler(deps),
      new MarketplaceHandler(deps),
      new PluginsHandler(deps),
      new SkillForceHandler(), // $local:skillname — must come before SessionCommandHandler
      new SessionCommandHandler(deps), // $ prefix — must come before Model/Verbosity
      new BypassHandler(),
      new SandboxHandler(),
      new EmailHandler(),
      new RateHandler(),
      new PersonaHandler(),
      new SkillsHandler(), // skills list/download — before MemoryHandler
      new MemoryHandler(),
      new ModelHandler(deps),
      new VerbosityHandler(deps),
      new EffortHandler(deps),
      new NotifyHandler(),
      new WebhookHandler(),
      new RestoreHandler(),
      new NewHandler(deps),
      new OnboardingHandler(deps),
      new ContextHandler(deps),
      new RenewHandler(deps),
      new CompactHandler(deps),
      new LinkHandler(deps),
      new CloseHandler(deps),
      new ReportHandler(getReportDeps()),
      new UsageHandler(deps),
      new HelpHandler(),
      new SessionHandler(deps),
    ];
  }

  /**
   * Try to route the message to a command handler
   * @returns CommandResult with handled=true if a command was executed
   */
  async route(ctx: CommandContext): Promise<CommandResult> {
    const { say, threadTs } = ctx;
    const originalText = ctx.text;

    if (!originalText) {
      return { handled: false };
    }

    // `/z` prefix support for thread/app_mention text (Phase 1 of #506).
    // NOTE: bare `[cmd] [args]` is NOT gated here — handlers below match it
    // directly. The Phase 1 tombstone gate was removed (#530) to restore
    // pre-#509 behavior. `SOMA_ENABLE_LEGACY_SLASH` now scopes only to the
    // slash deprecation rollback in event-router.ts.
    const zPrefixRemainder = stripZPrefix(originalText.trim());
    if (zPrefixRemainder !== null) {
      // Empty `/z` → help
      if (!zPrefixRemainder) {
        await say({ text: CommandParser.getHelpMessage(), thread_ts: threadTs });
        return { handled: true };
      }
      // Slash-forbidden check is applied at the SlashZRespond entry point.
      // Here we only reach /z via channel_mention / DM which DO have thread
      // context, so no further gating is needed.
      // Still surface the standardised denial for accidental slash-like
      // contexts (empty/placeholder threadTs == channelId).
      if (ctx.threadTs === ctx.channel) {
        const { topic, verb, arg } = parseTopic(zPrefixRemainder);
        if (topic && isSlashForbidden(topic, verb, arg)) {
          await say({ text: SLASH_FORBIDDEN_MESSAGE, thread_ts: threadTs });
          return { handled: true };
        }
      }
      ctx.text = translateToLegacy(zPrefixRemainder);
      // Fall through to handler dispatch below. NOTE: downstream must read
      // `ctx.text` (not a destructured copy) so the translated form reaches
      // canHandle() / execute() — thread `/z persona`, `/z model`, etc.
      // regressed when the old path used the stale local `text`.
    }

    const routedText = ctx.text ?? originalText;
    for (const handler of this.handlers) {
      if (handler.canHandle(routedText)) {
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

    // Check if it looks like a command but wasn't handled
    const { isPotential, keyword } = CommandParser.isPotentialCommand(routedText);
    if (isPotential) {
      this.logger.debug('Unrecognized potential command', { keyword, text: routedText.substring(0, 50) });
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
    return this.handlers.some((handler) => handler.canHandle(text));
  }
}

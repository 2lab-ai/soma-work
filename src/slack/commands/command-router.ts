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
import { CompactThresholdHandler } from './compact-threshold-handler';
import { ContextHandler } from './context-handler';
import { CwdHandler } from './cwd-handler';
import { DashboardHandler } from './dashboard-handler';
import { EffortHandler } from './effort-handler';
import { EmailHandler } from './email-handler';
import { HelpHandler } from './help-handler';
import { InstructionsHandler } from './instructions-handler';
import { LinkHandler } from './link-handler';
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
import { UITestHandler } from './ui-test-handler';
import { UsageHandler } from './usage-handler';
import { UserSkillsListHandler } from './user-skills-list-handler';
import { VerbosityHandler } from './verbosity-handler';
import { WebhookHandler } from './webhook-handler';

/**
 * Routes commands to appropriate handlers
 */
export class CommandRouter {
  private logger = new Logger('CommandRouter');
  private handlers: CommandHandler[] = [];
  /**
   * Cached references used by the `new`/`/new` preprocessor (see route()).
   * These are ALSO registered in `this.handlers` below so existing behaviors
   * — bare `/new` routed via the main loop for callers that bypass the
   * preprocessor (e.g. `isCommand(text)` probe at the bottom of this file)
   * — remain unchanged.
   */
  private newHandler: NewHandler;
  private skillForceHandler: SkillForceHandler;

  constructor(deps: CommandDependencies) {
    // Register all command handlers in priority order
    // Order matters - more specific handlers should come first
    this.newHandler = new NewHandler(deps);
    this.skillForceHandler = new SkillForceHandler();
    this.handlers = [
      new AdminHandler(),
      new PromptHandler(deps),
      new InstructionsHandler(deps),
      new CctHandler(),
      new CwdHandler(deps),
      new McpHandler(deps),
      new DashboardHandler(),
      new MarketplaceHandler(deps),
      new PluginsHandler(deps),
      // $user (bare) → list personal skills as buttons. Registered BEFORE
      // skillForceHandler so a hypothetical local skill named `user` cannot
      // shadow the menu shortcut. Qualified `$user:foo` falls through to
      // skillForceHandler unchanged (different canHandle pattern).
      new UserSkillsListHandler(),
      this.skillForceHandler, // $local:skillname — must come before SessionCommandHandler
      new SessionCommandHandler(deps), // $ prefix — must come before Model/Verbosity
      new BypassHandler(),
      new SandboxHandler(),
      new UITestHandler(deps),
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
      this.newHandler,
      new OnboardingHandler(deps),
      new ContextHandler(deps),
      new RenewHandler(deps),
      // #617: CompactThresholdHandler MUST come before CompactHandler so
      // `/compact-threshold` / `/compact-threshold 80` match the threshold
      // handler instead of being swallowed by the bare-`/compact` matcher.
      new CompactThresholdHandler(deps),
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

    // `new`/`/new` preprocessor — mirrors the `/z` prefix pattern above.
    //
    // Bug (pre-fix): when a message contained both `new` at the start AND a
    // `$skill` force trigger (e.g. `new <URL>\n$z proceed`), the
    // first-match-wins handler loop let `SkillForceHandler` match the bare
    // `$z` anywhere in the text and return `handled:true`, so `NewHandler`
    // never ran and the session was silently NOT reset. Reordering the
    // handlers would not help either: `continueWithPrompt` is NOT
    // re-dispatched by the router — it is delivered to Claude verbatim (see
    // slack-handler.ts: `effectiveText`), so `$z` in the remainder would
    // never get resolved into an `<invoked_skills>` block.
    //
    // Fix: run `NewHandler` FIRST for session reset side effects, then —
    // and only then — if the `new` remainder contains a `$skill` force
    // trigger, hand the remainder to `SkillForceHandler` so the final
    // `continueWithPrompt` carries the `<invoked_skills>` block.
    //
    // Narrow scope: ONLY `SkillForceHandler` is consulted on the remainder.
    // All other command-shaped remainders (`new help`, `new sessions`,
    // `new compact`, …) keep their existing semantic — delivered to Claude
    // as plain prompts. A general re-dispatch loop here would silently
    // change behavior for every `new <cmd>` combination; do NOT add one.
    if (CommandParser.isNewCommand(routedText)) {
      const newResult = await this.newHandler.execute(ctx);
      if (newResult.continueWithPrompt === undefined) {
        // Pure `new` OR race-guard rejection (see NewHandler.execute). Done.
        return newResult;
      }
      const remainder = newResult.continueWithPrompt;
      if (this.skillForceHandler.canHandle(remainder, ctx.user)) {
        // IMPORTANT: skillResult INTENTIONALLY supersedes newResult.
        // NewHandler's session-reset side effects (postSystemMessage, emoji
        // cleanup, state reset) already ran above. We now replace the
        // plain-prompt continuation with the SkillForce-enriched prompt
        // that contains the `<invoked_skills>` block. Do NOT re-dispatch
        // the whole router here — that would change semantics of
        // `new help`, `new sessions`, etc.
        const skillResult = await this.skillForceHandler.execute({ ...ctx, text: remainder });
        if (skillResult.handled) {
          return skillResult;
        }
      }
      return newResult;
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

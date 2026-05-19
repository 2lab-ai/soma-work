import { setCommandRouterProviders } from '@soma/slack/commands/command-router';
import { getReportDeps } from '../../metrics';
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
import { GoalHandler } from './goal-handler';
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
import { UITestHandler } from './ui-test-handler';
import { UsageHandler } from './usage-handler';
import { UserSkillsListHandler } from './user-skills-list-handler';
import { VerbosityHandler } from './verbosity-handler';
import { WebhookHandler } from './webhook-handler';

setCommandRouterProviders({
  createHandlers: (deps) => {
    const newHandler = new NewHandler(deps as any);
    const skillForceHandler = new SkillForceHandler();
    const goalHandler = new GoalHandler(deps as any);

    return {
      newHandler,
      skillForceHandler,
      goalHandler,
      handlers: [
        new AdminHandler(),
        new PromptHandler(deps as any),
        new InstructionsHandler(deps as any),
        new CctHandler(),
        new CwdHandler(deps as any),
        new McpHandler(deps as any),
        new DashboardHandler(),
        new MarketplaceHandler(deps as any),
        new PluginsHandler(deps as any),
        new UserSkillsListHandler(),
        skillForceHandler,
        new SessionCommandHandler(deps as any),
        new BypassHandler(),
        new SandboxHandler(),
        new UITestHandler(deps as any),
        new EmailHandler(),
        new RateHandler(),
        new PersonaHandler(),
        new SkillsHandler(),
        new MemoryHandler(),
        new ModelHandler(deps as any),
        new VerbosityHandler(deps as any),
        new EffortHandler(deps as any),
        new NotifyHandler(),
        new WebhookHandler(),
        new RestoreHandler(),
        newHandler,
        new OnboardingHandler(deps as any),
        new ContextHandler(deps as any),
        new RenewHandler(deps as any),
        new CompactThresholdHandler(deps as any),
        new CompactHandler(deps as any),
        goalHandler,
        new LinkHandler(deps as any),
        new CloseHandler(deps as any),
        new ReportHandler(getReportDeps()),
        new UsageHandler(deps as any),
        new HelpHandler(),
        new SessionHandler(deps as any),
      ],
    };
  },
});

export * from '@soma/slack/commands/command-router';

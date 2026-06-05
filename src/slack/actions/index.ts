import { setActionHandlersProviders } from '@soma/slack/actions';
import { isAdminUser } from '../../admin-utils';
import { getTokenManager } from '../../token-manager';
import { registerCctActions } from '../cct/actions';
import { defaultTabCache } from '../commands/usage-carousel-cache';
import { buildDefaultTopicRegistry } from '../z/topics';
import { ActionPanelActionHandler } from './action-panel-action-handler';
import { ChannelRouteActionHandler } from './channel-route-action-handler';
import { ChoiceActionHandler } from './choice-action-handler';
import { CompactActionHandler } from './compact-action-handler';
import { FormActionHandler } from './form-action-handler';
import { InstructionConfirmActionHandler } from './instruction-confirm-action-handler';
import { JiraActionHandler } from './jira-action-handler';
import { McpToolPermissionActionHandler } from './mcp-tool-permission-action-handler';
import { PermissionActionHandler } from './permission-action-handler';
import { PluginUpdateActionHandler } from './plugin-update-action-handler';
import { PRActionHandler } from './pr-action-handler';
import { SessionActionHandler } from './session-action-handler';
import { TurnFeedbackActionHandler } from './turn-feedback-action-handler';
import { UsageCardActionHandler } from './usage-card-action-handler';
import { UserAcceptanceActionHandler } from './user-acceptance-action-handler';
import { UserSkillDeleteConfirmViewSubmissionHandler } from './user-skill-delete-confirm-view-submission-handler';
import { UserSkillEditViewSubmissionHandler } from './user-skill-edit-view-submission-handler';
import { UserSkillMenuActionHandler } from './user-skill-menu-action-handler';
import { UserSkillRenameViewSubmissionHandler } from './user-skill-rename-view-submission-handler';
import { ZSettingsActionHandler } from './z-settings-actions';

setActionHandlersProviders({
  isAdminUser,
  createDelegates: (ctx, stores) => {
    const permissionHandler = new PermissionActionHandler(ctx.claudeHandler.getSessionRegistry?.());

    const sessionHandler = new SessionActionHandler({
      slackApi: ctx.slackApi as any,
      claudeHandler: ctx.claudeHandler,
      sessionManager: ctx.sessionManager,
      reactionManager: ctx.reactionManager,
      requestCoordinator: ctx.requestCoordinator,
      threadPanel: ctx.threadPanel,
    });

    const compactHandler = new CompactActionHandler({
      slackApi: ctx.slackApi as any,
      claudeHandler: ctx.claudeHandler,
      messageHandler: ctx.messageHandler as any,
    });

    const choiceHandler = new ChoiceActionHandler(
      {
        slackApi: ctx.slackApi as any,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler as any,
        threadPanel: ctx.threadPanel,
        completionMessageTracker: ctx.completionMessageTracker,
      },
      stores.formStore as any,
    );

    const formHandler = new FormActionHandler(
      {
        slackApi: ctx.slackApi as any,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler as any,
        threadPanel: ctx.threadPanel,
      },
      stores.formStore as any,
      choiceHandler,
    );

    const zTopicRegistry = buildDefaultTopicRegistry();

    return {
      permissionHandler,
      sessionHandler,
      compactHandler,
      choiceHandler,
      formHandler,
      jiraHandler: new JiraActionHandler({
        slackApi: ctx.slackApi as any,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler as any,
      }),
      prHandler: new PRActionHandler({
        slackApi: ctx.slackApi as any,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler as any,
      }),
      actionPanelHandler: new ActionPanelActionHandler({
        slackApi: ctx.slackApi as any,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler as any,
        requestCoordinator: ctx.requestCoordinator,
        threadPanel: ctx.threadPanel,
      }),
      channelRouteHandler: new ChannelRouteActionHandler({
        slackApi: ctx.slackApi as any,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler as any,
      }),
      userAcceptanceHandler: new UserAcceptanceActionHandler({
        slackApi: ctx.slackApi as any,
      }),
      userSkillMenuHandler: new UserSkillMenuActionHandler({
        slackApi: ctx.slackApi as any,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler as any,
      }),
      userSkillEditSubmitHandler: new UserSkillEditViewSubmissionHandler({
        slackApi: ctx.slackApi as any,
      }),
      userSkillRenameSubmitHandler: new UserSkillRenameViewSubmissionHandler({
        slackApi: ctx.slackApi as any,
      }),
      userSkillDeleteSubmitHandler: new UserSkillDeleteConfirmViewSubmissionHandler({
        slackApi: ctx.slackApi as any,
      }),
      usageCardHandler: new UsageCardActionHandler({
        tabCache: defaultTabCache,
      }),
      mcpToolPermissionHandler: new McpToolPermissionActionHandler(),
      pluginUpdateHandler: new PluginUpdateActionHandler({
        mcpManager: ctx.mcpManager,
      }),
      instructionConfirmHandler: new InstructionConfirmActionHandler({
        slackApi: ctx.slackApi as any,
        claudeHandler: ctx.claudeHandler,
        store: stores.pendingInstructionConfirmStore as any,
      }),
      feedbackHandler: new TurnFeedbackActionHandler({
        slackApi: ctx.slackApi as any,
        store: stores.turnFeedbackStore,
      }),
      zSettingsHandler: new ZSettingsActionHandler({
        registry: zTopicRegistry,
      }),
      zTopicRegistry,
      registerCctActions: (app) => registerCctActions(app as any, getTokenManager()),
    };
  },
});

export * from '@soma/slack/actions';

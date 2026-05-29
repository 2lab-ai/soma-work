import { setSessionInitializerProviders } from '@soma/slack/pipeline/session-initializer';
import {
  expectedHandoffKind,
  HandoffAbortError,
  isZHandoffWorkflow,
  parseHandoff,
} from 'somalib/model-commands/handoff-parser';
import { getAdminUsers } from '../../admin-utils';
import * as channelRegistry from '../../channel-registry';
import * as conversation from '../../conversation';
import { scheduleLinkDerivedTitleRefresh } from '../../conversation/link-derived-title';
import { getDispatchService } from '../../dispatch-service';
import { userSettingsStore } from '../../user-settings-store';
import { buildChannelRouteBlocks } from '../actions/channel-route-action-handler';
import { DispatchAbortError } from '../dispatch-abort';

setSessionInitializerProviders({
  expectedHandoffKind: (workflow) => expectedHandoffKind(workflow as any),
  isZHandoffWorkflow,
  parseHandoff,
  createHandoffAbortError: (reason, detail, workflow) => new HandoffAbortError(reason as any, detail, workflow as any),
  createDispatchAbortError: (reason, detail, workflow, elapsedMs, handoffContext) =>
    new DispatchAbortError(reason, detail, workflow, elapsedMs, handoffContext),
  getAdminUsers: () => new Set(getAdminUsers()),
  checkRepoChannelMatch: (prUrl, channel) =>
    (channelRegistry as any).checkRepoChannelMatch?.(prUrl, channel) ?? {
      correct: true,
      suggestedChannels: [],
      reason: 'unknown',
    },
  getAllChannels: () => (channelRegistry as any).getAllChannels?.() ?? [],
  getChannel: (channel) => (channelRegistry as any).getChannel?.(channel),
  registerChannel: async (client, channel) => (channelRegistry as any).registerChannel?.(client, channel),
  createConversation: (channel, threadTs, user, userName) =>
    (conversation as any).createConversation?.(channel, threadTs, user, userName) ?? '',
  getConversationUrl: (conversationId) => (conversation as any).getConversationUrl?.(conversationId) ?? '',
  scheduleLinkDerivedTitleRefresh,
  getDispatchService,
  getUserSettings: (userId) => userSettingsStore.getUserSettings(userId),
  createPendingUser: (userId, userName) => userSettingsStore.createPendingUser(userId, userName),
  getUserSessionTheme: (userId) => userSettingsStore.getUserSessionTheme(userId),
  buildChannelRouteBlocks,
  getDefaultUpdateChannel: () => process.env.DEFAULT_UPDATE_CHANNEL,
});

export * from '@soma/slack/pipeline/session-initializer';

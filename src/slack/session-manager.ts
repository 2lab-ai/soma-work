import { setSessionUiManagerProviders } from '@soma/slack/session-manager';

import * as conversation from '../conversation';
import * as linkMetadataFetcher from '../link-metadata-fetcher';
import { userSettingsStore } from '../user-settings-store';

setSessionUiManagerProviders({
  getConversationUrl: (conversationId) => {
    const getConversationUrl = (conversation as any).getConversationUrl;
    return typeof getConversationUrl === 'function' ? getConversationUrl(conversationId) : null;
  },
  extractJiraKey: (url) => {
    const extractJiraKey = (linkMetadataFetcher as any).extractJiraKey;
    return typeof extractJiraKey === 'function' ? (extractJiraKey(url) ?? null) : null;
  },
  fetchGitHubPRDetails: (link) => {
    const fetchGitHubPRDetails = (linkMetadataFetcher as any).fetchGitHubPRDetails;
    return typeof fetchGitHubPRDetails === 'function' ? fetchGitHubPRDetails(link) : undefined;
  },
  fetchGitHubPRReviewStatus: (link) => {
    const fetchGitHubPRReviewStatus = (linkMetadataFetcher as any).fetchGitHubPRReviewStatus;
    return typeof fetchGitHubPRReviewStatus === 'function' ? fetchGitHubPRReviewStatus(link) : undefined;
  },
  fetchJiraTransitions: (issueKey) => {
    const fetchJiraTransitions = (linkMetadataFetcher as any).fetchJiraTransitions;
    return typeof fetchJiraTransitions === 'function' ? fetchJiraTransitions(issueKey) : [];
  },
  fetchLinkMetadata: (link) => {
    const fetchLinkMetadata = (linkMetadataFetcher as any).fetchLinkMetadata;
    return typeof fetchLinkMetadata === 'function' ? fetchLinkMetadata(link) : undefined;
  },
  getStatusEmoji: (status, type) => {
    const getStatusEmoji = (linkMetadataFetcher as any).getStatusEmoji;
    return typeof getStatusEmoji === 'function' ? getStatusEmoji(status, type) : '';
  },
  isPRMergeable: (details) => {
    const isPRMergeable = (linkMetadataFetcher as any).isPRMergeable;
    return typeof isPRMergeable === 'function' ? isPRMergeable(details) : false;
  },
  getUserSessionTheme: (userId) => userSettingsStore.getUserSessionTheme(userId),
  getModelDisplayName: (model) => userSettingsStore.getModelDisplayName(model as any),
});

export * from '@soma/slack/session-manager';

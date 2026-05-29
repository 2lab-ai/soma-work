import { setThreadSurfaceProviders } from '@soma/slack/thread-surface';

import { fetchGitHubPRDetails, fetchGitHubPRReviewStatus, isPRMergeable } from '../link-metadata-fetcher';
import { userSettingsStore } from '../user-settings-store';

setThreadSurfaceProviders({
  getSessionTheme: (userId) => userSettingsStore.getUserSessionTheme(userId ?? ''),
  fetchGitHubPRDetails,
  fetchGitHubPRReviewStatus,
  isPRMergeable,
});

export * from '@soma/slack/thread-surface';

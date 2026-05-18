import { setThreadSurfaceProviders } from '@soma/slack/thread-surface';

import { config } from '../config';
import { fetchGitHubPRDetails, fetchGitHubPRReviewStatus, isPRMergeable } from '../link-metadata-fetcher';
import { userSettingsStore } from '../user-settings-store';
import './pipeline/effective-phase';

setThreadSurfaceProviders({
  getFiveBlockPhase: () => config.ui.fiveBlockPhase,
  getSessionTheme: (userId) => userSettingsStore.getUserSessionTheme(userId ?? ''),
  fetchGitHubPRDetails,
  fetchGitHubPRReviewStatus,
  isPRMergeable,
});

export * from '@soma/slack/thread-surface';

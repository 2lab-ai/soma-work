import { setInputProcessorProviders } from '@soma/slack/pipeline/input-processor';

import { userSettingsStore } from '../../user-settings-store';

setInputProcessorProviders({
  updateUserJiraInfo: (userId) => userSettingsStore.updateUserJiraInfo(userId),
});

export * from '@soma/slack/pipeline/input-processor';

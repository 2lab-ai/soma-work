import { setAssistantStatusB4NativeStatusEnabledProvider } from '@soma/slack/assistant-status-manager';

import { config } from '../config';

setAssistantStatusB4NativeStatusEnabledProvider(() => config.ui.b4NativeStatusEnabled);

export * from '@soma/slack/assistant-status-manager';

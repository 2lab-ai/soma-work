import { setThreadPanelFiveBlockPhaseProvider } from '@soma/slack/thread-panel';

import { config } from '../config';
import './thread-surface';
import './turn-surface';

setThreadPanelFiveBlockPhaseProvider(() => config.ui.fiveBlockPhase);

export * from '@soma/slack/thread-panel';

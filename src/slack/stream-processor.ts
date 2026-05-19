import { setStreamProcessorProviders } from '@soma/slack/stream-processor';

import { config } from '../config';
import { calculateTokenCost } from '../metrics/model-registry';

setStreamProcessorProviders({
  getFiveBlockPhase: () => config.ui.fiveBlockPhase,
  calculateTokenCost,
});

export * from '@soma/slack/stream-processor';

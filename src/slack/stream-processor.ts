import { setStreamProcessorProviders } from '@soma/slack/stream-processor';

import { calculateTokenCost } from '../metrics/model-registry';

setStreamProcessorProviders({
  calculateTokenCost,
});

export * from '@soma/slack/stream-processor';

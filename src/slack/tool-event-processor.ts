import { setToolEventProcessorProviders } from '@soma/slack/tool-event-processor';

import { mcpCallTracker } from '../mcp-call-tracker';

setToolEventProcessorProviders({
  getDefaultMcpCallTracker: () => mcpCallTracker,
});

export * from '@soma/slack/tool-event-processor';

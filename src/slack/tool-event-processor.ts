import { setToolEventProcessorProviders } from '@soma/slack/tool-event-processor';

import { config } from '../config';
import { mcpCallTracker } from '../mcp-call-tracker';
import './pipeline/effective-phase';

setToolEventProcessorProviders({
  getFiveBlockPhase: () => config.ui.fiveBlockPhase,
  getDefaultMcpCallTracker: () => mcpCallTracker,
});

export * from '@soma/slack/tool-event-processor';

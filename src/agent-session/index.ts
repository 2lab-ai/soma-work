// Agent Session — Issue #42 + #84
// AgentSession 기반 명시적 endTurn 호출 구조

export type {
  AgentPhase,
  AgentTurnResult,
  EndTurnInfo,
  ModelCommandResult,
  StopReason,
  ToolCallSummary,
  UsageData,
  UserChoiceQuestion,
} from './agent-session-types.js';

export type { TurnObserver } from './turn-observer.js';
export { NULL_OBSERVER } from './turn-observer.js';

export { TurnResultCollector } from './turn-result-collector.js';
export { mapToExecuteResult } from './map-to-execute-result.js';

// Issue #84: Phase 3b — IAgentSession + V1QueryAdapter + TurnRunner
export type { IAgentSession } from './agent-session.js';
export { V1QueryAdapter } from './v1-query-adapter.js';
export type { StreamExecutorLike, V1QueryAdapterConfig } from './v1-query-adapter.js';
export { TurnRunner } from './turn-runner.js';
export type { TurnRunnerSurface, TurnRunnerDeps } from './turn-runner.js';
export { deriveStatus } from './derive-status.js';

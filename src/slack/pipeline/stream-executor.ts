import './effective-phase';
import { setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';
import { parseModelCommandRunResponse } from 'somalib/model-commands/result-parser';
import { TurnResultCollector } from '../../agent-session/turn-result-collector.js';
import { getChannelDescription } from '../../channel-description-cache';
import { getChannel } from '../../channel-registry';
import {
  fetchClaudeStatus,
  formatStatusForSlack,
  isApiLikeError as rootIsApiLikeError,
  shouldShowStatusBlock,
} from '../../claude-status-fetcher';
import { config } from '../../config';
import { createConversation, recordAssistantTurn, recordUserTurn } from '../../conversation';
import { scheduleLinkDerivedTitleRefresh } from '../../conversation/link-derived-title';
import { isMidThreadMention } from '../../mcp-config-builder';
import { getMetricsEmitter } from '../../metrics/event-emitter';
import {
  classifyOneMUnavailable,
  hasOneMSuffix,
  isOneMContextUnavailableSignal,
  resolveContextWindow,
  stripOneMSuffix,
} from '../../metrics/model-registry';
import { interceptToolResults } from '../../metrics/tool-result-interceptor';
import { checkAndSchedulePendingCompact } from '../../session/compact-threshold-checker';
import { buildCompactionContext, snapshotFromSession } from '../../session/compaction-context-builder';
import { getTokenManager, parseCooldownTime } from '../../token-manager';
import { coerceToAvailableModel, userSettingsStore } from '../../user-settings-store';
import { postCompactCompleteIfNeeded, postCompactStartingIfNeeded } from '../hooks/compact-hooks';
import { getEffectiveFiveBlockPhase } from './effective-phase';

setStreamExecutorProviders({
  parseModelCommandRunResponse,
  createTurnResultCollector: () => new TurnResultCollector(),
  getChannelDescription,
  getChannel,
  fetchClaudeStatus,
  formatStatusForSlack,
  isApiLikeError: (error) => rootIsApiLikeError(error as any),
  shouldShowStatusBlock,
  getFiveBlockPhase: () => config.ui.fiveBlockPhase,
  createConversation,
  recordAssistantTurn,
  recordUserTurn,
  scheduleLinkDerivedTitleRefresh,
  isMidThreadMention,
  getMetricsEmitter: () => getMetricsEmitter() as any,
  classifyOneMUnavailable,
  hasOneMSuffix,
  isOneMContextUnavailableSignal,
  resolveContextWindow,
  stripOneMSuffix,
  interceptToolResults,
  checkAndSchedulePendingCompact,
  buildCompactionContext,
  snapshotFromSession: (session) => snapshotFromSession(session as any),
  getTokenManager,
  parseCooldownTime,
  coerceToAvailableModel,
  userSettingsStore,
  postCompactCompleteIfNeeded,
  postCompactStartingIfNeeded,
  shouldRunLegacyB4Path: (statusManager) => !!statusManager && getEffectiveFiveBlockPhase(statusManager) < 4,
});

export * from '@soma/slack/pipeline/stream-executor';

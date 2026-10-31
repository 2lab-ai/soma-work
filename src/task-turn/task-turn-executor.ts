/**
 * The executor of Slack-less task turns (#598 ④b, design 598b v5 §1).
 *
 * Built once per host. A second `StreamExecutor` whose whole output graph is
 * owned here: the dashboard panel, a Slack API that refuses and records every
 * call (and never hands out a client), a notifier with no channels, and its own
 * tool-event processor, todo display and tool tracker — so no callback closed
 * over the Slack host's panel can reach Slack. Shared with the host: the
 * registry, the claude handler, the request coordinator. Work-log appends go
 * through the host's pipeline with their promises kept as the turn's receipts.
 *
 * `runTaskTurn` (the runner) is the only entry point; ④c wires it. Until then
 * production does not call this.
 */

import { createDashboardTurnPanel } from '@soma/slack/task-turn/dashboard-turn-panel';
import { createFailClosedSlackApi, type RecordedSlackCall } from '@soma/slack/task-turn/fail-closed-slack-api';
import type { TaskTurnBinding } from '@soma/slack/task-turn/task-say';
import type { WorkLogInput } from '@soma/slack/work-log';
import type { SessionWorkLogAppender } from '../conversation/session-work-log';
import { FileHandler } from '../file-handler';
import { Logger } from '../logger';
import type { McpCallTracker } from '../mcp-call-tracker';
import {
  AssistantStatusManager,
  ContextWindowManager,
  type McpHealthMonitor,
  type McpStatusDisplay,
  ReactionManager,
  type RequestCoordinator,
  StatusReporter,
  TodoDisplayManager,
  ToolEventProcessor,
  ToolTracker,
} from '../slack';
import { StreamExecutor } from '../slack/pipeline';
import type { TodoManager } from '../todo-manager';
import type { ConversationSession } from '../types';
import { createTaskTurnReceipts } from './task-turn-receipts';
import { createTaskTurnRunner, type RunTaskTurnInput, type RunTaskTurnResult } from './task-turn-runner';

export interface TaskTurnExecutorHost {
  /** The host's ClaudeHandler (registry, by-key writes, the agent stream). */
  claudeHandler: any;
  requestCoordinator: RequestCoordinator;
  mcpCallTracker: McpCallTracker;
  todoManager: TodoManager;
  appendSessionWorkLog: SessionWorkLogAppender;
  createConversation(session: ConversationSession): Promise<string>;
  receiptDrainTimeoutMs?: number;
}

export interface TaskTurnExecutor {
  runTaskTurn(input: RunTaskTurnInput): Promise<RunTaskTurnResult>;
  /** End a pending non-terminal turn that will not be resumed (#634 R1). */
  abandonTurn: ReturnType<typeof createTaskTurnRunner>['abandonTurn'];
  /** Every Slack call a task turn attempted — must stay empty (T9). */
  slackCalls: RecordedSlackCall[];
}

const logger = new Logger('TaskTurnExecutor');

export function createTaskTurnExecutor(host: TaskTurnExecutorHost): TaskTurnExecutor {
  const failClosed = createFailClosedSlackApi({
    onFirstCall: (method) => logger.error('A Slack-less task turn tried to call Slack — a missed seam', { method }),
  });
  const slackApi = failClosed.api;
  const registry = host.claudeHandler.getSessionRegistry();
  const receipts = createTaskTurnReceipts({ drainTimeoutMs: host.receiptDrainTimeoutMs });

  const workLog = (binding: TaskTurnBinding, entry: WorkLogInput): Promise<void> => {
    const append = host.appendSessionWorkLog(binding.conversationId, entry as never);
    receipts.track(binding, append);
    return append.then(() => undefined);
  };

  // Mid-turn status writes only broadcast; the turn's end is saved once, by the
  // runner's strict commit (design §14.1).
  const panel = createDashboardTurnPanel({ persistAndBroadcast: () => registry.broadcastSessionUpdate() });

  const toolTracker = new ToolTracker();
  const reactionManager = new ReactionManager(slackApi);
  const assistantStatusManager = new AssistantStatusManager(slackApi);
  // MCP progress and health alerts are Slack posts (a status message in the
  // thread, an ops alert to the channel). A task's tool calls already reach the
  // dashboard as `tool` / `tool_result` work-log entries, so neither is built
  // for a task (#598 ④b2) — at the most verbose setting the status display
  // would otherwise post.
  const mcpStatusDisplay = {
    registerCall: () => {},
    completeCall: () => {},
    flushSession: async () => {},
    cleanupSession: () => {},
  } as unknown as McpStatusDisplay;
  const mcpHealthMonitor = { recordResult: async () => {} } as unknown as McpHealthMonitor;
  const todoDisplayManager = new TodoDisplayManager(slackApi, host.todoManager, reactionManager);
  // The todo ledger reaches the dashboard through the manager itself; the plan
  // render has no Slack surface on a task.
  todoDisplayManager.setRenderRequestCallback?.(async () => {});
  todoDisplayManager.setPlanRenderCallback?.(async () => true);
  const toolEventProcessor = new ToolEventProcessor(
    toolTracker,
    mcpStatusDisplay,
    host.mcpCallTracker as never,
    assistantStatusManager,
    mcpHealthMonitor,
  );
  toolEventProcessor.setReactionManager(reactionManager);
  // Tool results are already in the work log (`tool_result`); accept them.
  toolEventProcessor.setToolResultSink(async () => true);

  const executor = new StreamExecutor({
    claudeHandler: host.claudeHandler,
    fileHandler: new FileHandler(),
    toolEventProcessor,
    statusReporter: new StatusReporter(),
    reactionManager,
    contextWindowManager: new ContextWindowManager(slackApi),
    toolTracker,
    todoDisplayManager,
    // The task question path replaces the form store (design §6); nothing
    // here may reach Slack.
    actionHandlers: {
      setPendingForm: () => {},
      getPendingForm: () => undefined,
      deletePendingForm: () => {},
      invalidateOldForms: async () => {},
    } as never,
    requestCoordinator: host.requestCoordinator,
    slackApi,
    assistantStatusManager,
    threadPanel: panel,
    turnNotifier: { notify: async () => {} } as never,
    workLog,
  });

  const runner = createTaskTurnRunner({
    registry,
    execute: (params) => executor.execute(params as never),
    createConversation: host.createConversation,
    receipts,
    logger,
  });

  return { runTaskTurn: runner.runTaskTurn, abandonTurn: runner.abandonTurn, slackCalls: failClosed.calls };
}

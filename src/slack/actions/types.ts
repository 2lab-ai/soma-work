import type { ClaudeHandler } from '../../claude-handler';
import type { McpManager } from '../../mcp-manager';
import type { UserChoiceQuestion } from '../../types';
import type { CompletionMessageTracker } from '../completion-message-tracker';
import type { ReactionManager } from '../reaction-manager';
import type { RequestCoordinator } from '../request-coordinator';
import type { SessionUiManager } from '../session-manager';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ThreadPanel } from '../thread-panel';

export interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
}

export type MessageHandler = (event: MessageEvent, say: SayFn) => Promise<void>;
export type SayFn = (args: any) => Promise<any>;
export type RespondFn = (args: any) => Promise<any>;

export interface PendingChoiceFormData {
  formId: string;
  sessionKey: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  questions: UserChoiceQuestion[];
  selections: Record<string, { choiceId: string; label: string }>;
  createdAt: number;
}

export interface ActionHandlerContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  sessionManager: SessionUiManager;
  messageHandler: MessageHandler;
  reactionManager?: ReactionManager;
  threadPanel?: ThreadPanel;
  requestCoordinator?: RequestCoordinator;
  completionMessageTracker?: CompletionMessageTracker;
  mcpManager?: McpManager;
}

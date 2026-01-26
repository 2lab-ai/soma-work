import { SlackApiHelper } from '../slack-api-helper';
import { SessionUiManager } from '../session-manager';
import { ClaudeHandler } from '../../claude-handler';
import { UserChoiceQuestion } from '../../types';

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
}

import { ProcessedFile } from '../../file-handler';
import { ConversationSession } from '../../types';

export interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  routeContext?: {
    skipAutoBotThread?: boolean;
    sourceChannel?: string;
    sourceThreadTs?: string;
  };
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export interface SayFn {
  (args: { text: string; thread_ts?: string; blocks?: any[]; attachments?: any[] }): Promise<{ ts?: string }>;
}

export interface InputProcessResult {
  processedFiles: ProcessedFile[];
  text: string | undefined;
  shouldContinue: boolean;
}

export interface SessionInitResult {
  session: ConversationSession;
  sessionKey: string;
  isNewSession: boolean;
  userName: string;
  workingDirectory: string;
  abortController: AbortController;
  /** Set to true when channel routing advisory was shown. Caller should halt. */
  halted?: boolean;
}

export interface StreamExecuteResult {
  success: boolean;
  aborted: boolean;
  messageCount: number;
}

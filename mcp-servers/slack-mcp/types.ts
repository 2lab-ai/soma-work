/**
 * Slack MCP Server — shared types
 */

export interface SlackMcpContext {
  channel: string;
  threadTs: string;
  mentionTs: string;
}

export interface ThreadMessage {
  ts: string;
  user: string;
  user_name: string;
  text: string;
  timestamp: string;
  files: ThreadFile[];
  reactions: { name: string; count: number }[];
  is_bot: boolean;
  subtype: string | null;
}

export interface ThreadFile {
  id: string;
  name: string;
  mimetype: string;
  url_private_download?: string;
  size: number;
  thumb_360?: string;
  is_image?: boolean;
  image_note?: string;
}

export interface GetThreadMessagesResult {
  thread_ts: string;
  channel: string;
  total_count: number;
  offset: number;
  returned: number;
  messages: ThreadMessage[];
  has_more: boolean;
}

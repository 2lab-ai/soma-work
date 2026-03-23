#!/usr/bin/env node

/**
 * Slack Thread MCP Server
 *
 * Provides thread context tools for Claude when the bot is mentioned
 * mid-thread. Allows the model to explore thread history on-demand
 * rather than injecting everything into the prompt upfront.
 *
 * Tools:
 *   - get_thread_messages: Fetch messages around an anchor point in the thread
 *   - download_thread_file: Download a file attachment from the thread
 *
 * Environment variables (set by McpConfigBuilder):
 *   - SLACK_BOT_TOKEN: Bot token for Slack API calls
 *   - SLACK_THREAD_CONTEXT: JSON { channel, threadTs, mentionTs }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';
import { StderrLogger } from './stderr-logger.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const logger = new StderrLogger('SlackThreadMCP');

// ── Types ────────────────────────────────────────────────

interface SlackThreadContext {
  channel: string;
  threadTs: string;
  mentionTs: string;
}

interface ThreadMessage {
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

interface ThreadFile {
  id: string;
  name: string;
  mimetype: string;
  url_private_download: string;
  size: number;
  thumb_360?: string;
}

interface GetThreadMessagesResult {
  thread_ts: string;
  channel: string;
  total_replies: number;
  returned: number;
  messages: ThreadMessage[];
  has_more_before: boolean;
  has_more_after: boolean;
}

// ── Server ───────────────────────────────────────────────

class SlackThreadMcpServer {
  private server: Server;
  private slack: WebClient;
  private context: SlackThreadContext;
  private cachedMessages: any[] | null = null;

  constructor() {
    this.server = new Server(
      { name: 'slack-thread', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error('SLACK_BOT_TOKEN environment variable is required');
    }

    const contextStr = process.env.SLACK_THREAD_CONTEXT;
    if (!contextStr) {
      throw new Error('SLACK_THREAD_CONTEXT environment variable is required');
    }

    this.slack = new WebClient(token);
    this.context = JSON.parse(contextStr);

    if (!this.context.channel || !this.context.threadTs) {
      throw new Error('SLACK_THREAD_CONTEXT must contain channel and threadTs');
    }
    // Default mentionTs to threadTs if not provided
    if (!this.context.mentionTs) {
      this.context.mentionTs = this.context.threadTs;
    }

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_thread_messages',
          description: [
            'Fetch messages from the current Slack thread.',
            'Returns structured messages with author, text, timestamps, file attachments, and reactions.',
            'Use this to understand the conversation context before acting on user requests.',
            '',
            `Thread: channel=${this.context.channel}, thread_ts=${this.context.threadTs}`,
            `The mention that triggered this session: ts=${this.context.mentionTs}`,
            '',
            'Examples:',
            '- get_thread_messages({ before: 20, after: 0 }) -> 20 messages before the mention',
            '- get_thread_messages({ before: 5, after: 5 }) -> 5 messages before and after the mention',
            '- get_thread_messages({ anchor_ts: "...", before: 0, after: 10 }) -> 10 messages after a specific point',
          ].join('\n'),
          inputSchema: {
            type: 'object' as const,
            properties: {
              anchor_ts: {
                type: 'string',
                description:
                  'Reference message timestamp. Defaults to the mention message ts. Use a specific ts to paginate from a different point.',
              },
              before: {
                type: 'number',
                description: 'Number of messages to fetch BEFORE anchor_ts (default: 10, max: 50)',
              },
              after: {
                type: 'number',
                description: 'Number of messages to fetch AFTER anchor_ts (default: 0, max: 50)',
              },
            },
          },
        },
        {
          name: 'download_thread_file',
          description:
            'Download a file attached to a thread message. Returns the local temp path so you can use the Read tool to examine it. Supports images, PDFs, text files, etc.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file_url: {
                type: 'string',
                description: 'The url_private_download from a message file attachment',
              },
              file_name: {
                type: 'string',
                description: 'Original file name (used for temp file naming)',
              },
            },
            required: ['file_url', 'file_name'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      logger.debug(`Tool call: ${name}`, args);

      try {
        switch (name) {
          case 'get_thread_messages':
            return await this.handleGetThreadMessages(args as any);
          case 'download_thread_file':
            return await this.handleDownloadFile(args as any);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error: any) {
        logger.error(`Tool ${name} failed`, error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }],
          isError: true,
        };
      }
    });
  }

  // ── get_thread_messages ──────────────────────────────

  private async handleGetThreadMessages(args: {
    anchor_ts?: string;
    before?: number;
    after?: number;
  }) {
    const anchorTs = args.anchor_ts || this.context.mentionTs;
    const before = Math.min(Math.max(args.before ?? 10, 0), 50);
    const after = Math.min(Math.max(args.after ?? 0, 0), 50);

    const allMessages = await this.fetchAllMessages();

    // Find anchor index
    const anchorIndex = allMessages.findIndex((m: any) => m.ts === anchorTs);

    let startIdx: number;
    let endIdx: number;

    if (anchorIndex === -1) {
      // Anchor not found — return the last `before` messages
      logger.warn('Anchor ts not found, returning tail', { anchorTs, total: allMessages.length });
      startIdx = Math.max(0, allMessages.length - before);
      endIdx = allMessages.length;
    } else {
      startIdx = Math.max(0, anchorIndex - before);
      endIdx = Math.min(allMessages.length, anchorIndex + after + 1);
    }

    const slice = allMessages.slice(startIdx, endIdx);

    return this.formatMessages(
      slice,
      allMessages.length,
      startIdx > 0,
      endIdx < allMessages.length
    );
  }

  /**
   * Fetch all thread messages with pagination. Caches the result
   * for the lifetime of this MCP server process (= one session).
   */
  private async fetchAllMessages(): Promise<any[]> {
    if (this.cachedMessages) {
      logger.debug('Returning cached messages', { count: this.cachedMessages.length });
      return this.cachedMessages;
    }

    const allMessages: any[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.slack.conversations.replies({
        channel: this.context.channel,
        ts: this.context.threadTs,
        limit: 200,
        cursor,
      });

      const messages = response.messages || [];
      allMessages.push(...messages);

      const nextCursor = response.response_metadata?.next_cursor;
      cursor = nextCursor && nextCursor.length > 0 ? nextCursor : undefined;
    } while (cursor);

    this.cachedMessages = allMessages;
    logger.info('Fetched and cached thread messages', {
      channel: this.context.channel,
      threadTs: this.context.threadTs,
      count: allMessages.length,
    });

    return allMessages;
  }

  private formatMessages(
    messages: any[],
    totalCount: number,
    hasMoreBefore: boolean,
    hasMoreAfter: boolean
  ) {
    const formatted: ThreadMessage[] = messages.map((m: any) => ({
      ts: m.ts,
      user: m.user || m.bot_id || 'unknown',
      user_name:
        m.user_profile?.display_name ||
        m.user_profile?.real_name ||
        m.username ||
        m.user ||
        'unknown',
      text: m.text || '',
      timestamp: m.ts
        ? new Date(parseFloat(m.ts) * 1000).toISOString()
        : new Date().toISOString(),
      files: (m.files || []).map((f: any) => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        url_private_download: f.url_private_download,
        size: f.size,
        ...(f.thumb_360 ? { thumb_360: f.thumb_360 } : {}),
      })),
      reactions: (m.reactions || []).map((r: any) => ({
        name: r.name,
        count: r.count,
      })),
      is_bot: !!m.bot_id,
      subtype: m.subtype || null,
    }));

    const result: GetThreadMessagesResult = {
      thread_ts: this.context.threadTs,
      channel: this.context.channel,
      total_replies: totalCount,
      returned: formatted.length,
      messages: formatted,
      has_more_before: hasMoreBefore,
      has_more_after: hasMoreAfter,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }

  // ── download_thread_file ─────────────────────────────

  private async handleDownloadFile(args: { file_url: string; file_name: string }) {
    const { file_url, file_name } = args;

    if (!file_url) {
      throw new Error('file_url is required');
    }
    if (!file_name) {
      throw new Error('file_name is required');
    }

    // Download file using bot token
    const response = await fetch(file_url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });

    if (!response.ok) {
      throw new Error(`File download failed: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Write to temp directory
    const tempDir = path.join(os.tmpdir(), 'slack-thread-files');
    await fs.mkdir(tempDir, { recursive: true });

    // Sanitize filename to prevent path traversal
    const safeName = path.basename(file_name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempPath = path.join(tempDir, `${Date.now()}_${safeName}`);
    await fs.writeFile(tempPath, buffer);

    logger.info('Downloaded file', {
      name: file_name,
      path: tempPath,
      size: buffer.length,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            path: tempPath,
            name: file_name,
            size: buffer.length,
            hint: 'Use the Read tool to examine this file.',
          }),
        },
      ],
    };
  }

  // ── Entry point ──────────────────────────────────────

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('SlackThread MCP server started', {
      channel: this.context.channel,
      threadTs: this.context.threadTs,
      mentionTs: this.context.mentionTs,
    });
  }
}

// ── Main ─────────────────────────────────────────────────

const server = new SlackThreadMcpServer();
server.run().catch((err) => {
  logger.error('Failed to start SlackThread MCP server', err);
  process.exit(1);
});

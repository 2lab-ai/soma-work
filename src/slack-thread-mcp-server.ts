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

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';

import { StderrLogger } from './stderr-logger.js';

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
  url_private_download?: string;
  size: number;
  thumb_360?: string;
  is_image?: boolean;
  image_note?: string;
}

interface GetThreadMessagesResult {
  thread_ts: string;
  channel: string;
  thread_root: ThreadMessage | null;
  returned: number;
  messages: ThreadMessage[];
  has_more_before: boolean;
  has_more_after: boolean;
}

// ── Helpers ──────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);

/** Check if a mimetype or filename indicates an image file. */
function isImageFile(mimetype?: string, filename?: string): boolean {
  if (mimetype && mimetype.startsWith('image/')) return true;
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    if (IMAGE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

/** Extract pagination cursor from Slack API response, returning undefined when exhausted. */
function extractCursor(response: { response_metadata?: { next_cursor?: string } }): string | undefined {
  const c = response.response_metadata?.next_cursor;
  return c && c.length > 0 ? c : undefined;
}

// ── Server ───────────────────────────────────────────────

/** Allowed Slack file URL hosts — prevents token exfiltration to attacker-controlled domains */
const ALLOWED_FILE_HOSTS = new Set([
  'files.slack.com',
  'files-pri.slack.com',
  'files-tmb.slack.com',
]);

class SlackThreadMcpServer {
  private server: Server;
  private slack: WebClient;
  private token: string;
  private context: SlackThreadContext;
  private capturedRoot: any | null = null;

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
    this.token = token;
    try {
      this.context = JSON.parse(contextStr);
    } catch (err) {
      throw new Error(
        `Failed to parse SLACK_THREAD_CONTEXT: ${(err as Error).message}. Raw: ${contextStr.substring(0, 200)}`
      );
    }

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
            'Download a non-image file attached to a thread message. Returns the local temp path so you can use the Read tool to examine it. Supports PDFs, text files, code files, etc. WARNING: Do NOT use this for image files (jpg, png, gif, webp, svg) — the API cannot process images and will return a 400 error. For images, just reference their name and metadata from get_thread_messages.',
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

        // Classify error for model retry decisions
        const slackErrorCode = error?.data?.error as string | undefined;
        const isRateLimited = error?.status === 429 || slackErrorCode === 'ratelimited';
        const isAuthError = slackErrorCode === 'invalid_auth' || slackErrorCode === 'not_authed';

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: error.message,
              ...(slackErrorCode ? { slack_error: slackErrorCode } : {}),
              retryable: isRateLimited,
              ...(isAuthError ? { hint: 'Bot token may be invalid or expired' } : {}),
            }),
          }],
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

    // Reset captured root for each call
    this.capturedRoot = null;

    // Fetch messages before anchor (inclusive) — direct API, no caching
    const beforeMessages = await this.fetchMessagesBefore(anchorTs, before);

    // Fetch messages after anchor (exclusive)
    const afterMessages = after > 0
      ? await this.fetchMessagesAfter(anchorTs, after)
      : [];

    // Fallback: if root wasn't captured (e.g., before=0), fetch it directly
    if (!this.capturedRoot) {
      await this.fetchThreadRoot();
    }

    const messages = [...beforeMessages, ...afterMessages];
    // If we asked for N messages before and got exactly N, there are likely more
    const hasMoreBefore = before > 0 && beforeMessages.length === before;
    const hasMoreAfter = after > 0 && afterMessages.length === after;

    return this.formatMessages(messages, hasMoreBefore, hasMoreAfter, this.capturedRoot);
  }

  /**
   * Fetch up to `count` replies ending at (and including) anchorTs.
   * conversations.replies does not support `latest`, so we paginate
   * forward from thread start, skip the root message, and collect
   * until we pass the anchor.
   */
  private async fetchMessagesBefore(anchorTs: string, count: number): Promise<any[]> {
    if (count === 0) return [];

    const collected: any[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.slack.conversations.replies({
        channel: this.context.channel,
        ts: this.context.threadTs,
        limit: 200,
        cursor,
      });

      const msgs = response.messages || [];
      for (const m of msgs) {
        // Capture thread root — always appears as messages[0] on first page
        if (m.ts === this.context.threadTs) {
          this.capturedRoot = m;
          continue;
        }
        // Stop collecting once we pass the anchor
        if (m.ts! > anchorTs) break;
        collected.push(m);
      }

      cursor = extractCursor(response);

      // If the last message on this page is past the anchor, stop
      if (msgs.length > 0 && msgs[msgs.length - 1].ts! > anchorTs) break;
    } while (cursor);

    // Return the last `count` messages (anchor included if it exists)
    return collected.slice(-count);
  }

  /**
   * Fetch up to `count` replies starting after anchorTs (exclusive).
   * Filters out the thread root which conversations.replies always includes.
   */
  private async fetchMessagesAfter(anchorTs: string, count: number): Promise<any[]> {
    const collected: any[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.slack.conversations.replies({
        channel: this.context.channel,
        ts: this.context.threadTs,
        oldest: anchorTs,
        inclusive: false,
        limit: Math.min(count + 1, 200), // +1 to account for possible root inclusion
        cursor,
      });

      const msgs = response.messages || [];
      for (const m of msgs) {
        if (m.ts === this.context.threadTs) continue; // Skip root
        collected.push(m);
        if (collected.length >= count) break;
      }

      cursor = extractCursor(response);

      if (collected.length >= count) break;
    } while (cursor);

    return collected.slice(0, count);
  }

  /**
   * Fetch thread root message directly. Used as fallback when
   * fetchMessagesBefore was skipped (before=0).
   */
  private async fetchThreadRoot(): Promise<void> {
    try {
      const response = await this.slack.conversations.replies({
        channel: this.context.channel,
        ts: this.context.threadTs,
        limit: 1,
      });
      const msgs = response.messages || [];
      if (msgs.length > 0 && msgs[0].ts === this.context.threadTs) {
        this.capturedRoot = msgs[0];
        logger.debug('Thread root captured via fallback', { ts: msgs[0].ts });
      } else {
        logger.debug('Thread root not found (possibly deleted)');
      }
    } catch (error) {
      logger.warn('Failed to fetch thread root', error);
    }
  }

  private formatSingleMessage(m: any): ThreadMessage {
    return {
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
      files: (m.files || []).map((f: any) => {
        const fileIsImage = isImageFile(f.mimetype, f.name);
        return {
          id: f.id,
          name: f.name,
          mimetype: f.mimetype,
          size: f.size,
          // Omit download URL for images to prevent Claude from downloading and Reading them
          ...(!fileIsImage && f.url_private_download ? { url_private_download: f.url_private_download } : {}),
          ...(f.thumb_360 ? { thumb_360: f.thumb_360 } : {}),
          ...(fileIsImage ? {
            is_image: true,
            image_note: 'Image file — do NOT download or Read. Reference by name only. Ask the user to describe contents if needed.',
          } : {}),
        };
      }),
      reactions: (m.reactions || []).map((r: any) => ({
        name: r.name,
        count: r.count,
      })),
      is_bot: !!m.bot_id,
      subtype: m.subtype || null,
    };
  }

  private formatMessages(
    messages: any[],
    hasMoreBefore: boolean,
    hasMoreAfter: boolean,
    threadRoot: any | null = null
  ) {
    const formatted: ThreadMessage[] = messages.map((m: any) => this.formatSingleMessage(m));

    const result: GetThreadMessagesResult = {
      thread_ts: this.context.threadTs,
      channel: this.context.channel,
      thread_root: threadRoot ? this.formatSingleMessage(threadRoot) : null,
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

    // Block image file downloads — Reading images causes API 400 "Could not process image"
    if (isImageFile(undefined, file_name)) {
      logger.warn('Blocked image file download to prevent API error', { name: file_name });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            blocked: true,
            name: file_name,
            reason: 'Image files cannot be downloaded and read — the API will reject them with "Could not process image". Reference the image by name and ask the user to describe its contents if needed.',
          }),
        }],
      };
    }

    // Validate URL host to prevent token exfiltration to attacker-controlled domains
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(file_url);
    } catch {
      throw new Error(`Invalid file URL: ${file_url}`);
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(
        `Refused to download over insecure protocol: ${parsedUrl.protocol}`
      );
    }
    if (!ALLOWED_FILE_HOSTS.has(parsedUrl.hostname)) {
      throw new Error(
        `Refused to send auth token to untrusted host: ${parsedUrl.hostname}. ` +
        `Allowed: ${[...ALLOWED_FILE_HOSTS].join(', ')}`
      );
    }

    // Download file using bot token
    const response = await fetch(file_url, {
      headers: { Authorization: `Bearer ${this.token}` },
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

    // Double-check: if the response content-type indicates an image, warn instead of suggesting Read
    const contentType = response.headers.get('content-type') || '';
    const isImage = isImageFile(contentType, file_name);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            path: tempPath,
            name: file_name,
            size: buffer.length,
            hint: isImage
              ? 'This is an image file. Do NOT use the Read tool on it — the API will reject it with "Could not process image". Reference it by name and ask the user to describe its contents.'
              : 'Use the Read tool to examine this file.',
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

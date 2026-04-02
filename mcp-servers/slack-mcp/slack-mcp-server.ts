#!/usr/bin/env node

/**
 * Slack MCP Server
 *
 * Provides Slack thread tools for Claude: read messages, download files,
 * and upload files/media to the current thread.
 *
 * Tools:
 *   - get_thread_messages: Fetch messages from the thread (array mode or legacy mode)
 *   - download_thread_file: Download a file attachment from the thread
 *   - send_file: Upload a file to the current Slack thread
 *   - send_media: Upload media (image/audio/video) to the current Slack thread
 *
 * Environment variables (set by McpConfigBuilder):
 *   - SLACK_BOT_TOKEN: Bot token for Slack API calls
 *   - SLACK_MCP_CONTEXT: JSON { channel, threadTs, mentionTs }
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WebClient } from '@slack/web-api';

import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';
import type { SlackMcpContext, GetThreadMessagesResult } from './types.js';
import { validateFilePath, isImageFile, isMediaFile, isNonVisualMedia, getMediaType, ALLOWED_MEDIA_EXTENSIONS } from './helpers/file-validator.js';
import { formatSingleMessage } from './helpers/message-formatter.js';
import { getTotalCount, fetchThreadSlice, fetchMessagesBefore, fetchMessagesAfter } from './helpers/thread-fetcher.js';

// ── Constants ────────────────────────────────────────────

/** Allowed Slack file URL hosts — prevents token exfiltration to attacker-controlled domains */
const ALLOWED_FILE_HOSTS = new Set([
  'files.slack.com',
  'files-pri.slack.com',
  'files-tmb.slack.com',
]);

// ── Server ───────────────────────────────────────────────

class SlackMcpServer extends BaseMcpServer {
  private slack: WebClient;
  private token: string;
  private context: SlackMcpContext;

  constructor() {
    super('slack-mcp', '4.0.0');

    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error('SLACK_BOT_TOKEN environment variable is required');
    }

    const contextStr = process.env.SLACK_MCP_CONTEXT;
    if (!contextStr) {
      throw new Error('SLACK_MCP_CONTEXT environment variable is required');
    }

    this.slack = new WebClient(token);
    this.token = token;
    try {
      this.context = JSON.parse(contextStr);
    } catch (err) {
      throw new Error(
        `Failed to parse SLACK_MCP_CONTEXT: ${(err as Error).message}. Raw: ${contextStr.substring(0, 200)}`
      );
    }

    if (!this.context.channel || !this.context.threadTs) {
      throw new Error('SLACK_MCP_CONTEXT must contain channel and threadTs');
    }
    if (!this.context.mentionTs) {
      this.context.mentionTs = this.context.threadTs;
    }
  }

  defineTools(): ToolDefinition[] {
    return [
      {
        name: 'get_thread_messages',
        description: [
          'Fetch messages from a Slack thread as an ordered array.',
          'Thread is 0-indexed: index 0 = root message, index 1 = first reply, etc.',
          'Returns total_count so you can compute offsets (e.g., last 5: offset=total_count-5).',
          '',
          `Work thread: channel=${this.context.channel}, thread_ts=${this.context.threadTs}`,
          ...(this.context.sourceThreadTs
            ? [`Source thread: channel=${this.context.sourceChannel || this.context.channel}, thread_ts=${this.context.sourceThreadTs}`]
            : []),
          `The mention that triggered this session: ts=${this.context.mentionTs}`,
          '',
          'Thread selection (thread param):',
          '- "work" (default): current work thread where this session runs',
          '- "source": original thread where the mention occurred (before thread migration)',
          '',
          'Array mode (default):',
          '- get_thread_messages({ offset: 0, limit: 1 })  -> root message only',
          '- get_thread_messages({ thread: "source", offset: 0, limit: 20 }) -> source thread messages',
          '',
          'Legacy mode (backward compat):',
          '- get_thread_messages({ before: 20, after: 0 }) -> 20 messages before the mention',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            thread: { type: 'string', description: 'Which thread to read: "work" (default) or "source" (original thread before migration)' },
            offset: { type: 'number', description: 'Array mode: 0-based index to start from (0=root, 1=first reply). Default: 0' },
            limit: { type: 'number', description: 'Array mode: max messages to return (default: 10, max: 50)' },
            anchor_ts: { type: 'string', description: 'Legacy mode: reference message timestamp. Presence of anchor_ts/before/after triggers legacy mode.' },
            before: { type: 'number', description: 'Legacy mode: messages before anchor_ts (default: 10, max: 50)' },
            after: { type: 'number', description: 'Legacy mode: messages after anchor_ts (default: 0, max: 50)' },
          },
        },
      },
      {
        name: 'download_thread_file',
        description: 'Download a file attached to a thread message. Returns the local temp path so you can use the Read tool to examine it. Supports PDFs, text files, code files, archives, AND images (png, jpg, gif, webp, etc — Claude can read images natively). WARNING: Do NOT use this for audio/video files — they cannot be read by the Read tool.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            file_url: { type: 'string', description: 'The url_private_download from a message file attachment' },
            file_name: { type: 'string', description: 'Original file name (used for temp file naming)' },
          },
          required: ['file_url', 'file_name'],
        },
      },
      {
        name: 'send_thread_message',
        description: [
          'Post a text message to a Slack thread.',
          'Use thread param to target the work thread (default) or original source thread.',
          'This allows posting status updates or summaries back to the original conversation.',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', description: 'Message text to post' },
            thread: { type: 'string', description: 'Which thread to post to: "work" (default) or "source" (original thread before migration)' },
          },
          required: ['text'],
        },
      },
      {
        name: 'send_file',
        description: [
          'Upload a file from the local filesystem to a Slack thread.',
          'Supports any file type up to 1GB. The file is shared as a thread reply.',
          'Use this for code outputs, reports, logs, archives, or any generated artifact.',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file on local filesystem' },
            filename: { type: 'string', description: 'Display name in Slack (defaults to basename of file_path)' },
            title: { type: 'string', description: 'File title shown in Slack' },
            initial_comment: { type: 'string', description: 'Message posted alongside the file' },
            thread: { type: 'string', description: 'Which thread to upload to: "work" (default) or "source"' },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'send_media',
        description: [
          'Upload a media file (image, audio, or video) to a Slack thread.',
          'Validates that the file is a supported media type before uploading.',
          '',
          'Supported formats:',
          '- Images: jpg, jpeg, png, gif, webp, svg, bmp, ico, tiff, heic, heif, avif',
          '- Audio: mp3, wav, ogg, flac, m4a, aac, wma',
          '- Video: mp4, mov, avi, mkv, webm, wmv, m4v, mpg, mpeg, 3gp',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the media file' },
            filename: { type: 'string', description: 'Display name in Slack (defaults to basename of file_path)' },
            title: { type: 'string', description: 'Media title shown in Slack' },
            alt_text: { type: 'string', description: 'Alt text for images (accessibility)' },
            initial_comment: { type: 'string', description: 'Message posted alongside the media' },
            thread: { type: 'string', description: 'Which thread to upload to: "work" (default) or "source"' },
          },
          required: ['file_path'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'get_thread_messages':
        return await this.handleGetThreadMessages(args as any);
      case 'download_thread_file':
        return await this.handleDownloadFile(args as any);
      case 'send_thread_message':
        return await this.handleSendThreadMessage(args as any);
      case 'send_file':
        return await this.handleSendFile(args as any);
      case 'send_media':
        return await this.handleSendMedia(args as any);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Override formatError for enriched Slack error responses.
   */
  protected override formatError(toolName: string, error: unknown): ToolResult {
    this.logger.error(`Tool ${toolName} failed`, error);

    const slackErrorCode = (error as any)?.data?.error as string | undefined;
    const isRateLimited = (error as any)?.status === 429 || slackErrorCode === 'ratelimited';
    const isAuthError = slackErrorCode === 'invalid_auth' || slackErrorCode === 'not_authed';
    const message = error instanceof Error ? error.message : String(error);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: message,
          ...(slackErrorCode ? { slack_error: slackErrorCode } : {}),
          retryable: isRateLimited,
          ...(isAuthError ? { hint: 'Bot token may be invalid or expired' } : {}),
        }),
      }],
      isError: true,
    };
  }

  // ── Thread resolution ────────────────────────────────

  /**
   * Resolve which thread to target based on "source" | "work" selector.
   * Default is "work" (current session thread). "source" returns original thread before migration.
   */
  private resolveThread(thread?: string): { channel: string; threadTs: string } {
    if (thread && thread !== 'work' && thread !== 'source') {
      throw new Error(`Invalid thread selector: "${thread}". Must be "work" or "source".`);
    }
    if (thread === 'source') {
      if (!this.context.sourceThreadTs) {
        throw new Error('No source thread available — this session was not created from a mid-thread mention with thread migration');
      }
      return {
        channel: this.context.sourceChannel || this.context.channel,
        threadTs: this.context.sourceThreadTs,
      };
    }
    // default: work thread
    return { channel: this.context.channel, threadTs: this.context.threadTs };
  }

  // ── get_thread_messages ──────────────────────────────

  private async handleGetThreadMessages(args: {
    thread?: string;
    offset?: number; limit?: number;
    anchor_ts?: string; before?: number; after?: number;
  }): Promise<ToolResult> {
    const resolved = this.resolveThread(args.thread);

    const isLegacyMode = args.anchor_ts !== undefined
      || args.before !== undefined
      || args.after !== undefined;

    if (isLegacyMode) {
      return this.handleLegacyMode(args, resolved);
    }
    return this.handleArrayMode(args, resolved);
  }

  private async handleArrayMode(
    args: { offset?: number; limit?: number },
    resolved: { channel: string; threadTs: string },
  ): Promise<ToolResult> {
    const offset = Math.max(args.offset ?? 0, 0);
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);

    const totalCount = await getTotalCount(this.slack, resolved.channel, resolved.threadTs, this.logger);
    const clampedOffset = Math.min(offset, Math.max(totalCount - 1, 0));

    const messages = await fetchThreadSlice(this.slack, resolved.channel, resolved.threadTs, clampedOffset, limit, totalCount);
    const formatted = messages.map(m => formatSingleMessage(m));
    const hasMore = clampedOffset + formatted.length < totalCount;

    const result: GetThreadMessagesResult = {
      thread_ts: resolved.threadTs,
      channel: resolved.channel,
      total_count: totalCount,
      offset: clampedOffset,
      returned: formatted.length,
      messages: formatted,
      has_more: hasMore,
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  }

  private async handleLegacyMode(
    args: { anchor_ts?: string; before?: number; after?: number },
    resolved: { channel: string; threadTs: string },
  ): Promise<ToolResult> {
    const anchorTs = args.anchor_ts || this.context.mentionTs;
    const before = Math.min(Math.max(args.before ?? 10, 0), 50);
    const after = Math.min(Math.max(args.after ?? 0, 0), 50);

    const { messages: beforeMessages, rootWasInjected } = await fetchMessagesBefore(this.slack, resolved.channel, resolved.threadTs, anchorTs, before);
    const afterMessages = after > 0
      ? await fetchMessagesAfter(this.slack, resolved.channel, resolved.threadTs, anchorTs, after)
      : [];

    const allMessages = [...beforeMessages, ...afterMessages];
    const formatted = allMessages.map(m => formatSingleMessage(m));
    const totalCount = await getTotalCount(this.slack, resolved.channel, resolved.threadTs, this.logger);

    const approxOffset = formatted.length > 0 ? Math.max(totalCount - before - after, 0) : 0;
    // Subtract injected root from length comparison to avoid false positive:
    // when root is prepended beyond count, length > before even if no unseen messages exist.
    const effectiveBeforeLen = rootWasInjected ? beforeMessages.length - 1 : beforeMessages.length;
    const hasMore = before > 0
      ? effectiveBeforeLen >= before
      : after > 0 ? afterMessages.length === after : false;

    const result: GetThreadMessagesResult = {
      thread_ts: resolved.threadTs,
      channel: resolved.channel,
      total_count: totalCount,
      offset: approxOffset,
      returned: formatted.length,
      messages: formatted,
      has_more: hasMore,
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  }

  // ── send_thread_message ────────────────────────────────

  private async handleSendThreadMessage(args: {
    text: string; thread?: string;
  }): Promise<ToolResult> {
    if (!args.text) throw new Error('text is required');

    const resolved = this.resolveThread(args.thread);
    this.logger.info('Sending message', { thread: args.thread || 'work', channel: resolved.channel });

    const result = await this.slack.chat.postMessage({
      channel: resolved.channel,
      thread_ts: resolved.threadTs,
      text: args.text,
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          sent: true,
          channel: resolved.channel,
          thread_ts: resolved.threadTs,
          message_ts: result.ts || '',
        }),
      }],
    };
  }

  // ── download_thread_file ─────────────────────────────

  private async handleDownloadFile(args: { file_url: string; file_name: string }): Promise<ToolResult> {
    const { file_url, file_name } = args;

    if (!file_url) throw new Error('file_url is required');
    if (!file_name) throw new Error('file_name is required');

    // Block audio/video downloads (can't be read), but ALLOW images (Claude reads them natively)
    if (isNonVisualMedia(undefined, file_name)) {
      this.logger.warn('Blocked non-visual media file download', { name: file_name });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            blocked: true, name: file_name,
            reason: 'Audio/video files cannot be read. Reference by name and metadata only. (Images ARE allowed — use download_thread_file for those.)',
          }),
        }],
      };
    }

    let parsedUrl: URL;
    try { parsedUrl = new URL(file_url); } catch { throw new Error(`Invalid file URL: ${file_url}`); }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`Refused to download over insecure protocol: ${parsedUrl.protocol}`);
    }
    if (!ALLOWED_FILE_HOSTS.has(parsedUrl.hostname)) {
      throw new Error(`Refused to send auth token to untrusted host: ${parsedUrl.hostname}. Allowed: ${[...ALLOWED_FILE_HOSTS].join(', ')}`);
    }

    const response = await fetch(file_url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`File download failed: ${response.status} ${response.statusText}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const tempDir = path.join(os.tmpdir(), 'slack-mcp-files');
    await fs.mkdir(tempDir, { recursive: true });
    const safeName = path.basename(file_name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempPath = path.join(tempDir, `${Date.now()}_${safeName}`);
    await fs.writeFile(tempPath, buffer);

    this.logger.info('Downloaded file', { name: file_name, path: tempPath, size: buffer.length });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          path: tempPath, name: file_name, size: buffer.length,
          hint: 'Use the Read tool to examine this file. Claude can read both text files and images natively.',
        }),
      }],
    };
  }

  // ── send_file ──────────────────────────────────────────

  private async handleSendFile(args: {
    file_path: string; filename?: string; title?: string; initial_comment?: string; thread?: string;
  }): Promise<ToolResult> {
    const { resolvedPath, size } = await validateFilePath(args.file_path);
    const displayName = args.filename || path.basename(resolvedPath);
    const resolved = this.resolveThread(args.thread);

    this.logger.info('Uploading file', { name: displayName, size, path: resolvedPath, thread: args.thread || 'work' });

    const uploadArgs: any = {
      file: resolvedPath, filename: displayName,
      channel_id: resolved.channel, thread_ts: resolved.threadTs,
    };
    if (args.title) uploadArgs.title = args.title;
    if (args.initial_comment) uploadArgs.initial_comment = args.initial_comment;

    const result = await this.slack.filesUploadV2(uploadArgs);
    const uploadedFile = (result as any).files?.[0]?.files?.[0] || (result as any).files?.[0] || null;

    if (!uploadedFile?.id) {
      this.logger.error('Slack filesUploadV2 returned unexpected response shape', { name: displayName, resultKeys: Object.keys(result || {}) });
      throw new Error(`File upload succeeded but Slack returned no file metadata. Response keys: ${Object.keys(result || {}).join(', ')}`);
    }

    this.logger.info('File uploaded', { name: displayName, size, file_id: uploadedFile.id });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          uploaded: true, file_id: uploadedFile.id, filename: displayName, size,
          permalink: uploadedFile.permalink || '',
          channel: resolved.channel, thread_ts: resolved.threadTs,
        }),
      }],
    };
  }

  // ── send_media ─────────────────────────────────────────

  private async handleSendMedia(args: {
    file_path: string; filename?: string; title?: string; alt_text?: string; initial_comment?: string; thread?: string;
  }): Promise<ToolResult> {
    const { resolvedPath, size } = await validateFilePath(args.file_path);
    const displayName = args.filename || path.basename(resolvedPath);
    const resolved = this.resolveThread(args.thread);

    const ext = path.extname(resolvedPath).toLowerCase().slice(1);
    if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported media type: .${ext}. Allowed: ${[...ALLOWED_MEDIA_EXTENSIONS].join(', ')}`);
    }

    const media_type = getMediaType(ext);
    this.logger.info('Uploading media', { name: displayName, size, media_type, path: resolvedPath, thread: args.thread || 'work' });

    const uploadArgs: any = {
      file: resolvedPath, filename: displayName,
      channel_id: resolved.channel, thread_ts: resolved.threadTs,
    };
    if (args.title) uploadArgs.title = args.title;
    if (args.alt_text) uploadArgs.alt_text = args.alt_text;
    if (args.initial_comment) uploadArgs.initial_comment = args.initial_comment;

    const result = await this.slack.filesUploadV2(uploadArgs);
    const uploadedFile = (result as any).files?.[0]?.files?.[0] || (result as any).files?.[0] || null;

    if (!uploadedFile?.id) {
      this.logger.error('Slack filesUploadV2 returned unexpected response shape', { name: displayName, media_type, resultKeys: Object.keys(result || {}) });
      throw new Error(`Media upload succeeded but Slack returned no file metadata. Response keys: ${Object.keys(result || {}).join(', ')}`);
    }

    this.logger.info('Media uploaded', { name: displayName, size, file_id: uploadedFile.id, media_type });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          uploaded: true, file_id: uploadedFile.id, filename: displayName, size, media_type,
          permalink: uploadedFile.permalink || '',
          channel: resolved.channel, thread_ts: resolved.threadTs,
        }),
      }],
    };
  }
}

// ── Main ─────────────────────────────────────────────────

const server = new SlackMcpServer();
server.run().catch((err) => {
  console.error('Failed to start SlackMCP server', err);
  process.exit(1);
});

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

import { markdownToBlocks as libMarkdownToBlocks } from 'markdown-to-slack-blocks';
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
        description: 'Reply to the current conversation thread. Supports markdown formatting (bold, italic, code, links, headings).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', description: 'Message text (markdown supported — converted to Slack mrkdwn automatically)' },
            thread: { type: 'string', description: '"work" (default) or "source" (original thread before migration)' },
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

  // ── Markdown → Slack mrkdwn ─────────────────────────────

  /**
   * Convert standard markdown to Slack mrkdwn format.
   * Preserves code blocks/inline code, converts bold/italic/links/headings.
   *
   * Mapping:  markdown **bold** / __bold__  →  Slack *bold*
   *           markdown _italic_             →  Slack _italic_ (no-op)
   *           markdown *italic*             →  left as-is (Slack renders as bold — known limitation)
   */
  private formatToMrkdwn(text: string): string {
    const preserved: string[] = [];

    // Extract code blocks and inline code to protect from formatting
    let processed = text
      .replace(/```[\s\S]*?```/g, (match) => {
        const idx = preserved.length;
        // Strip language tag from fenced code blocks
        const cleaned = match.replace(/^```\w*\n/, '```\n');
        preserved.push(cleaned);
        return `\x00P${idx}\x00`;
      })
      .replace(/`[^`]+`/g, (match) => {
        const idx = preserved.length;
        preserved.push(match);
        return `\x00P${idx}\x00`;
      });

    // Markdown → Slack mrkdwn conversions
    processed = processed
      .replace(/\*\*(.+?)\*\*/g, '*$1*')              // **bold** → *bold*
      .replace(/__(.+?)__/g, '*$1*')                    // __bold__ → *bold* (md bold, not italic)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')   // [text](url) → <url|text>
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*');            // # heading → *heading*

    // Restore preserved code
    for (let i = 0; i < preserved.length; i++) {
      processed = processed.replace(`\x00P${i}\x00`, preserved[i]);
    }

    return processed;
  }

  /**
   * Build Slack section blocks from mrkdwn text.
   * Splits on paragraph boundaries when text exceeds 3000-char section limit.
   * Protects fenced code blocks from being split across sections.
   */
  private buildMrkdwnBlocks(mrkdwn: string): Array<Record<string, unknown>> {
    const MAX_SECTION_LEN = 3000;
    const MAX_BLOCKS = 50;

    if (mrkdwn.length <= MAX_SECTION_LEN) {
      return [{ type: 'section', text: { type: 'mrkdwn', text: mrkdwn } }];
    }

    // Protect code blocks from paragraph splitting by replacing with placeholders
    const codeBlocks: string[] = [];
    const withPlaceholders = mrkdwn.replace(/```[\s\S]*?```/g, (match) => {
      const idx = codeBlocks.length;
      codeBlocks.push(match);
      return `\x01CB${idx}\x01`;
    });

    // Split on paragraph boundaries
    const paragraphs = withPlaceholders.split(/\n\n+/);
    const blocks: Array<Record<string, unknown>> = [];
    let current = '';

    for (const para of paragraphs) {
      // Restore code blocks in this paragraph for length calculation
      const restored = this.restoreCodeBlocks(para, codeBlocks);
      const currentRestored = this.restoreCodeBlocks(current, codeBlocks);

      if (currentRestored.length + restored.length + 2 > MAX_SECTION_LEN && currentRestored) {
        // Flush via pushHardSplit so oversized non-final paragraphs are split correctly
        this.pushHardSplit(currentRestored.trim(), blocks, MAX_SECTION_LEN, MAX_BLOCKS);
        current = para;
        if (blocks.length >= MAX_BLOCKS) break;
      } else {
        current += (current ? '\n\n' : '') + para;
      }
    }

    // Flush remaining content — hard-split if it exceeds section limit
    if (current && blocks.length < MAX_BLOCKS) {
      const finalText = this.restoreCodeBlocks(current, codeBlocks).trim();
      this.pushHardSplit(finalText, blocks, MAX_SECTION_LEN, MAX_BLOCKS);
    }

    return blocks;
  }

  /** Restore code-block placeholders. */
  private restoreCodeBlocks(text: string, codeBlocks: string[]): string {
    let result = text;
    for (let i = 0; i < codeBlocks.length; i++) {
      result = result.replace(`\x01CB${i}\x01`, codeBlocks[i]);
    }
    return result;
  }

  /** Hard-split text that exceeds maxLen on newline boundaries, never truncating. */
  private pushHardSplit(
    text: string,
    blocks: Array<Record<string, unknown>>,
    maxLen: number,
    maxBlocks: number,
  ): void {
    let remaining = text;
    while (remaining.length > 0 && blocks.length < maxBlocks) {
      if (remaining.length <= maxLen) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remaining } });
        break;
      }
      // Find last newline within limit for clean break
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = maxLen; // no newline found — hard break at limit
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remaining.slice(0, splitAt) } });
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
  }

  // ── send_thread_message ────────────────────────────────

  private async handleSendThreadMessage(args: {
    text: string; thread?: string;
  }): Promise<ToolResult> {
    if (!args.text) throw new Error('text is required');

    const resolved = this.resolveThread(args.thread);
    this.logger.info('Sending message', { thread: args.thread || 'work', channel: resolved.channel });

    // Convert markdown to rich Block Kit blocks (native tables, headers, rich_text)
    let blocks: Array<Record<string, unknown>>;
    let fallbackText: string;
    let overflow: Array<Array<Record<string, unknown>>> = [];

    try {
      const converted = this.convertMarkdownToBlocks(args.text);
      blocks = converted.blocks;
      fallbackText = converted.fallbackText;
      overflow = converted.overflow;
    } catch (err) {
      // Fallback: use mrkdwn pipeline if Block Kit conversion fails
      this.logger.warn('markdownToBlocks failed, using mrkdwn fallback', { error: String(err) });
      fallbackText = this.formatToMrkdwn(args.text);
      blocks = this.buildMrkdwnBlocks(fallbackText);
    }

    // Primary send with rich blocks
    let result;
    try {
      result = await this.slack.chat.postMessage({
        channel: resolved.channel,
        thread_ts: resolved.threadTs,
        text: fallbackText,
        blocks,
      });
    } catch (sendErr: any) {
      // Retry with mrkdwn fallback only on Slack block-validation errors
      const slackError = sendErr?.data?.error || sendErr?.message || '';
      const isBlockError = /invalid_blocks|invalid_attachments/i.test(slackError);

      if (isBlockError) {
        this.logger.warn('Slack rejected blocks, retrying with mrkdwn fallback', { error: slackError });
        const mrkdwn = this.formatToMrkdwn(args.text);
        const fallbackBlocks = this.buildMrkdwnBlocks(mrkdwn);
        result = await this.slack.chat.postMessage({
          channel: resolved.channel,
          thread_ts: resolved.threadTs,
          text: mrkdwn,
          blocks: fallbackBlocks,
        });
        overflow = []; // No overflow on fallback path
      } else {
        throw sendErr;
      }
    }

    // Send overflow messages (extra tables/content beyond single-message limits)
    const overflowTs: string[] = [];
    for (const overflowBlocks of overflow) {
      try {
        const ovResult = await this.slack.chat.postMessage({
          channel: resolved.channel,
          thread_ts: resolved.threadTs,
          text: '(continued)',
          blocks: overflowBlocks,
        });
        overflowTs.push(ovResult.ts || '');
      } catch (err) {
        this.logger.warn('Overflow message send failed', { error: String(err) });
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          sent: true,
          channel: resolved.channel,
          thread_ts: resolved.threadTs,
          message_ts: result.ts || '',
          ...(overflowTs.length > 0 ? { overflow_ts: overflowTs } : {}),
        }),
      }],
    };
  }

  /**
   * Convert markdown to Slack Block Kit blocks using the markdown-to-slack-blocks library.
   * Same pipeline as sayWithBlockKit() in stream-processor — produces native table, header,
   * and rich_text blocks instead of section+mrkdwn.
   *
   * Handles: tables → native table blocks, headings → header blocks,
   * code → rich_text preformatted, lists/quotes → rich_text elements.
   */
  private convertMarkdownToBlocks(markdown: string): {
    blocks: Array<Record<string, unknown>>;
    fallbackText: string;
    overflow: Array<Array<Record<string, unknown>>>;
  } {
    const MAX_BLOCKS = 45;
    const MAX_TABLE_ROWS = 100;
    const MAX_TABLE_COLS = 20;
    const MAX_HEADER_LEN = 150;
    const fallbackText = this.formatToMrkdwn(markdown);

    const rawBlocks = libMarkdownToBlocks(markdown) as Array<Record<string, unknown>>;
    if (!rawBlocks || rawBlocks.length === 0) {
      // No rich blocks produced — fall back to mrkdwn section blocks
      return { blocks: this.buildMrkdwnBlocks(fallbackText), fallbackText, overflow: [] };
    }

    // Sanitize blocks (table row/col limits, header truncation)
    const sanitized = rawBlocks.map((block) => {
      if (block.type === 'table') {
        const rows = block.rows as any[][];
        if (!rows || rows.length === 0) return block;
        const truncRows = rows.slice(0, MAX_TABLE_ROWS).map((r) => (r as any[]).slice(0, MAX_TABLE_COLS));
        return { ...block, rows: truncRows };
      }
      if (block.type === 'header') {
        const text = (block.text as any)?.text || '';
        if (text.length > MAX_HEADER_LEN) {
          return { ...block, text: { ...(block.text as any), text: text.slice(0, MAX_HEADER_LEN - 3) + '...' } };
        }
      }
      return block;
    });

    // Split: max 1 table per message, max MAX_BLOCKS blocks per message
    const tableCount = sanitized.filter((b) => b.type === 'table').length;
    if (sanitized.length <= MAX_BLOCKS && tableCount <= 1) {
      return { blocks: sanitized, fallbackText, overflow: [] };
    }

    const messages: Array<Array<Record<string, unknown>>> = [];
    let current: Array<Record<string, unknown>> = [];
    let curTables = 0;

    for (const block of sanitized) {
      const isTable = block.type === 'table';
      if ((current.length >= MAX_BLOCKS) || (isTable && curTables >= 1)) {
        if (current.length > 0) messages.push(current);
        current = [];
        curTables = 0;
      }
      current.push(block);
      if (isTable) curTables++;
    }
    if (current.length > 0) messages.push(current);

    const [primary, ...overflow] = messages;
    return { blocks: primary || [], fallbackText, overflow };
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

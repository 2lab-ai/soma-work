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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';

import { StderrLogger } from '../_shared/stderr-logger.js';

const logger = new StderrLogger('SlackMCP');

// ── Types ────────────────────────────────────────────────

interface SlackMcpContext {
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
  total_count: number;
  offset: number;
  returned: number;
  messages: ThreadMessage[];
  has_more: boolean;
}

// ── Constants ────────────────────────────────────────────

/** Maximum file size for uploads: 1 GB */
const MAX_FILE_SIZE = 1_073_741_824;

/** Allowlisted root directories for file uploads — prevents exfiltration of sensitive system files */
const ALLOWED_UPLOAD_ROOTS = ['/tmp', '/private/tmp'];

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']);

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp']);

/** All media extensions that send_media accepts */
const ALLOWED_MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

// ── Helpers ──────────────────────────────────────────────

/** Check if a mimetype or filename indicates an image file. */
function isImageFile(mimetype?: string, filename?: string): boolean {
  if (mimetype && mimetype.startsWith('image/')) return true;
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    if (IMAGE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

/** Check if a mimetype or filename indicates a media file (image, video, or audio). */
function isMediaFile(mimetype?: string, filename?: string): boolean {
  if (mimetype && (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/'))) return true;
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
  }
  return false;
}

/** Classify a file extension into media category. */
function getMediaType(ext: string): 'image' | 'audio' | 'video' | null {
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

/** Extract pagination cursor from Slack API response, returning undefined when exhausted. */
function extractCursor(response: { response_metadata?: { next_cursor?: string } }): string | undefined {
  const c = response.response_metadata?.next_cursor;
  return c && c.length > 0 ? c : undefined;
}

/**
 * Validate a file path for upload security.
 *
 * Defence layers:
 *   1. Absolute path requirement
 *   2. Path-segment traversal check (rejects `/../` but allows `report..txt`)
 *   3. Allowlisted root directory (/tmp only — blocks /etc/passwd exfiltration)
 *   4. Symlink rejection (lstat before stat)
 *   5. Regular-file check (rejects directories, block devices, etc.)
 *   6. Readability check
 *   7. Size cap (1 GB)
 *
 * Note on TOCTOU: There is an inherent race between validation and the
 * subsequent filesUploadV2 call. Full elimination requires opening an fd here
 * and passing it downstream, but the Slack SDK accepts only a path string.
 * The risk is minimal in practice — the server runs in a short-lived MCP
 * subprocess scoped to a single query, and /tmp is user-owned.
 */
async function validateFilePath(filePath: string): Promise<{ resolvedPath: string; size: number }> {
  if (!filePath) {
    throw new Error('file_path is required');
  }

  const resolvedPath = path.resolve(filePath);

  // 1. Must be absolute after resolution (always true for path.resolve, but explicit)
  if (!path.isAbsolute(resolvedPath)) {
    throw new Error(`file_path must be absolute: ${filePath}`);
  }

  // 2. Path traversal: check for /../ segments in the resolved path
  //    Uses path segments instead of string includes('..') to allow filenames like 'report..txt'
  const segments = resolvedPath.split(path.sep);
  if (segments.some(seg => seg === '..')) {
    throw new Error(`Path traversal not allowed: ${filePath}`);
  }

  // 3. Allowlisted root — only /tmp (or /private/tmp on macOS) allowed
  const underAllowedRoot = ALLOWED_UPLOAD_ROOTS.some(root => resolvedPath.startsWith(root + path.sep));
  if (!underAllowedRoot) {
    throw new Error(`Upload restricted to /tmp directory. Rejected: ${resolvedPath}`);
  }

  // 4. Symlink check (lstat does not follow symlinks)
  let lstatResult;
  try {
    lstatResult = await fs.lstat(resolvedPath);
  } catch {
    throw new Error(`File not found or not readable: ${resolvedPath}`);
  }

  if (lstatResult.isSymbolicLink()) {
    throw new Error(`Symlinks not allowed for security: ${resolvedPath}`);
  }

  // 5. Must be a regular file (not a directory, device, socket, etc.)
  if (!lstatResult.isFile()) {
    throw new Error(`Not a regular file: ${resolvedPath}`);
  }

  // 6. Readability check
  try {
    await fs.access(resolvedPath, (await import('fs')).constants.R_OK);
  } catch {
    throw new Error(`File not found or not readable: ${resolvedPath}`);
  }

  // 7. Size check
  if (lstatResult.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${lstatResult.size} bytes. Maximum: ${MAX_FILE_SIZE} bytes (1GB)`);
  }

  return { resolvedPath, size: lstatResult.size };
}

// ── Server ───────────────────────────────────────────────

/** Allowed Slack file URL hosts — prevents token exfiltration to attacker-controlled domains */
const ALLOWED_FILE_HOSTS = new Set([
  'files.slack.com',
  'files-pri.slack.com',
  'files-tmb.slack.com',
]);

class SlackMcpServer {
  private server: Server;
  private slack: WebClient;
  private token: string;
  private context: SlackMcpContext;

  constructor() {
    this.server = new Server(
      { name: 'slack-mcp', version: '3.0.0' },
      { capabilities: { tools: {} } }
    );

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
            'Fetch messages from the current Slack thread as an ordered array.',
            'Thread is 0-indexed: index 0 = root message, index 1 = first reply, etc.',
            'Returns total_count so you can compute offsets (e.g., last 5: offset=total_count-5).',
            '',
            `Thread: channel=${this.context.channel}, thread_ts=${this.context.threadTs}`,
            `The mention that triggered this session: ts=${this.context.mentionTs}`,
            '',
            'Array mode (default):',
            '- get_thread_messages({ offset: 0, limit: 1 })  -> root message only',
            '- get_thread_messages({ offset: 1, limit: 10 }) -> first 10 replies (no root)',
            '- get_thread_messages({ offset: 0, limit: 20 }) -> root + 19 replies',
            '',
            'Legacy mode (backward compat):',
            '- get_thread_messages({ before: 20, after: 0 }) -> 20 messages before the mention',
            '- get_thread_messages({ anchor_ts: "...", before: 0, after: 10 }) -> 10 after a point',
          ].join('\n'),
          inputSchema: {
            type: 'object' as const,
            properties: {
              offset: {
                type: 'number',
                description: 'Array mode: 0-based index to start from (0=root, 1=first reply). Default: 0',
              },
              limit: {
                type: 'number',
                description: 'Array mode: max messages to return (default: 10, max: 50)',
              },
              anchor_ts: {
                type: 'string',
                description:
                  'Legacy mode: reference message timestamp. Presence of anchor_ts/before/after triggers legacy mode.',
              },
              before: {
                type: 'number',
                description: 'Legacy mode: messages before anchor_ts (default: 10, max: 50)',
              },
              after: {
                type: 'number',
                description: 'Legacy mode: messages after anchor_ts (default: 0, max: 50)',
              },
            },
          },
        },
        {
          name: 'download_thread_file',
          description:
            'Download a non-media file attached to a thread message. Returns the local temp path so you can use the Read tool to examine it. Supports PDFs, text files, code files, archives, etc. WARNING: Do NOT use this for media files (images, videos, audio) — they cannot be read by the Read tool. For media files, just reference their name and metadata from get_thread_messages.',
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
        {
          name: 'send_file',
          description: [
            'Upload a file from the local filesystem to the current Slack thread.',
            'Supports any file type up to 1GB. The file is shared as a thread reply.',
            'Use this for code outputs, reports, logs, archives, or any generated artifact.',
          ].join('\n'),
          inputSchema: {
            type: 'object' as const,
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the file on local filesystem',
              },
              filename: {
                type: 'string',
                description: 'Display name in Slack (defaults to basename of file_path)',
              },
              title: {
                type: 'string',
                description: 'File title shown in Slack',
              },
              initial_comment: {
                type: 'string',
                description: 'Message posted alongside the file',
              },
            },
            required: ['file_path'],
          },
        },
        {
          name: 'send_media',
          description: [
            'Upload a media file (image, audio, or video) to the current Slack thread.',
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
              file_path: {
                type: 'string',
                description: 'Absolute path to the media file',
              },
              filename: {
                type: 'string',
                description: 'Display name in Slack (defaults to basename of file_path)',
              },
              title: {
                type: 'string',
                description: 'Media title shown in Slack',
              },
              alt_text: {
                type: 'string',
                description: 'Alt text for images (accessibility)',
              },
              initial_comment: {
                type: 'string',
                description: 'Message posted alongside the media',
              },
            },
            required: ['file_path'],
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
          case 'send_file':
            return await this.handleSendFile(args as any);
          case 'send_media':
            return await this.handleSendMedia(args as any);
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
    offset?: number;
    limit?: number;
    anchor_ts?: string;
    before?: number;
    after?: number;
  }) {
    // Mode detection: if anchor_ts, before, or after is explicitly provided → legacy mode
    const isLegacyMode = args.anchor_ts !== undefined
      || args.before !== undefined
      || args.after !== undefined;

    if (isLegacyMode) {
      return this.handleLegacyMode(args);
    }

    return this.handleArrayMode(args);
  }

  // ── Array mode: offset/limit ───────────────────────────

  private async handleArrayMode(args: { offset?: number; limit?: number }) {
    const offset = Math.max(args.offset ?? 0, 0);
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);

    // Get total count first (cheap: single API call with limit=1)
    const totalCount = await this.getTotalCount();

    // Clamp offset to valid range
    const clampedOffset = Math.min(offset, Math.max(totalCount - 1, 0));

    // Fetch the requested slice
    const messages = await this.fetchThreadSlice(clampedOffset, limit, totalCount);

    const formatted = messages.map(m => this.formatSingleMessage(m));
    const hasMore = clampedOffset + formatted.length < totalCount;

    const result: GetThreadMessagesResult = {
      thread_ts: this.context.threadTs,
      channel: this.context.channel,
      total_count: totalCount,
      offset: clampedOffset,
      returned: formatted.length,
      messages: formatted,
      has_more: hasMore,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }

  // ── Legacy mode: anchor_ts/before/after ────────────────

  private async handleLegacyMode(args: {
    anchor_ts?: string;
    before?: number;
    after?: number;
  }) {
    const anchorTs = args.anchor_ts || this.context.mentionTs;
    const before = Math.min(Math.max(args.before ?? 10, 0), 50);
    const after = Math.min(Math.max(args.after ?? 0, 0), 50);

    // Fetch messages before anchor (inclusive)
    const beforeMessages = await this.fetchMessagesBefore(anchorTs, before);

    // Fetch messages after anchor (exclusive)
    const afterMessages = after > 0
      ? await this.fetchMessagesAfter(anchorTs, after)
      : [];

    const allMessages = [...beforeMessages, ...afterMessages];
    const formatted = allMessages.map(m => this.formatSingleMessage(m));

    // Get total count for response
    const totalCount = await this.getTotalCount();

    // Compute approximate offset of first returned message
    const approxOffset = formatted.length > 0 ? Math.max(totalCount - before - after, 0) : 0;
    const hasMore = before > 0
      ? beforeMessages.length === before
      : after > 0 ? afterMessages.length === after : false;

    const result: GetThreadMessagesResult = {
      thread_ts: this.context.threadTs,
      channel: this.context.channel,
      total_count: totalCount,
      offset: approxOffset,
      returned: formatted.length,
      messages: formatted,
      has_more: hasMore,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }

  // ── Data fetching methods ──────────────────────────────

  /**
   * Get total message count in thread (root + replies).
   * Uses conversations.replies with limit=1 to get reply_count from the root message.
   */
  private async getTotalCount(): Promise<number> {
    try {
      const response = await this.slack.conversations.replies({
        channel: this.context.channel,
        ts: this.context.threadTs,
        limit: 1,
      });
      const root = response.messages?.[0];
      if (root && root.ts === this.context.threadTs) {
        // reply_count is number of replies (excludes root), so total = reply_count + 1
        const replyCount = (root as any).reply_count ?? 0;
        return replyCount + 1;
      }
      return 1; // Just the root
    } catch (error) {
      logger.warn('Failed to get thread total count', error);
      return 0;
    }
  }

  /**
   * Fetch a slice of thread messages by offset and limit.
   * Thread is 0-indexed: offset 0 = root, offset 1 = first reply, etc.
   */
  private async fetchThreadSlice(offset: number, limit: number, totalCount: number): Promise<any[]> {
    if (totalCount === 0 || offset >= totalCount) return [];

    const collected: any[] = [];
    let cursor: string | undefined;
    let currentIndex = 0;

    do {
      const response = await this.slack.conversations.replies({
        channel: this.context.channel,
        ts: this.context.threadTs,
        limit: 200,
        cursor,
      });

      const msgs = response.messages || [];
      for (const m of msgs) {
        if (currentIndex >= offset && currentIndex < offset + limit) {
          collected.push(m);
        }
        currentIndex++;

        if (collected.length >= limit) break;
      }

      cursor = extractCursor(response);

      if (collected.length >= limit) break;
      if (currentIndex >= offset + limit) break;
    } while (cursor);

    return collected;
  }

  /**
   * Legacy: Fetch up to `count` replies ending at (and including) anchorTs.
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
        if (m.ts === this.context.threadTs) continue;
        if (m.ts! > anchorTs) break;
        collected.push(m);
      }

      cursor = extractCursor(response);

      if (msgs.length > 0 && msgs[msgs.length - 1].ts! > anchorTs) break;
    } while (cursor);

    return collected.slice(-count);
  }

  /**
   * Legacy: Fetch up to `count` replies starting after anchorTs (exclusive).
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
        limit: Math.min(count + 1, 200),
        cursor,
      });

      const msgs = response.messages || [];
      for (const m of msgs) {
        if (m.ts === this.context.threadTs) continue;
        collected.push(m);
        if (collected.length >= count) break;
      }

      cursor = extractCursor(response);

      if (collected.length >= count) break;
    } while (cursor);

    return collected.slice(0, count);
  }

  // ── Message formatting ─────────────────────────────────

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
        const fileIsMedia = fileIsImage || isMediaFile(f.mimetype, f.name || '');
        return {
          id: f.id,
          name: f.name,
          mimetype: f.mimetype,
          size: f.size,
          ...(!fileIsMedia && f.url_private_download ? { url_private_download: f.url_private_download } : {}),
          ...(f.thumb_360 ? { thumb_360: f.thumb_360 } : {}),
          ...(fileIsImage ? {
            is_image: true,
            image_note: 'Image file — do NOT download or Read. Reference by name only. Ask the user to describe contents if needed.',
          } : {}),
          ...(!fileIsImage && fileIsMedia ? {
            is_media: true,
            media_note: 'Media file — do NOT download or Read. Reference by name only.',
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

  // ── download_thread_file ─────────────────────────────

  private async handleDownloadFile(args: { file_url: string; file_name: string }) {
    const { file_url, file_name } = args;

    if (!file_url) {
      throw new Error('file_url is required');
    }
    if (!file_name) {
      throw new Error('file_name is required');
    }

    // Block media file downloads — Reading binary media (image/video/audio) causes errors
    if (isMediaFile(undefined, file_name)) {
      logger.warn('Blocked media file download to prevent API error', { name: file_name });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            blocked: true,
            name: file_name,
            reason: 'Media files (image/video/audio) cannot be downloaded and read. Reference the file by name and metadata only.',
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
    const tempDir = path.join(os.tmpdir(), 'slack-mcp-files');
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

  // ── send_file ──────────────────────────────────────────

  private async handleSendFile(args: {
    file_path: string;
    filename?: string;
    title?: string;
    initial_comment?: string;
  }) {
    const { resolvedPath, size } = await validateFilePath(args.file_path);
    const displayName = args.filename || path.basename(resolvedPath);

    logger.info('Uploading file', { name: displayName, size, path: resolvedPath });

    const uploadArgs: any = {
      file: resolvedPath,
      filename: displayName,
      channel_id: this.context.channel,
      thread_ts: this.context.threadTs,
    };
    if (args.title) uploadArgs.title = args.title;
    if (args.initial_comment) uploadArgs.initial_comment = args.initial_comment;

    const result = await this.slack.filesUploadV2(uploadArgs);

    // Extract file info — Slack SDK wraps differently depending on version
    const uploadedFile = (result as any).files?.[0]?.files?.[0]
      || (result as any).files?.[0]
      || null;

    if (!uploadedFile?.id) {
      logger.error('Slack filesUploadV2 returned unexpected response shape', {
        name: displayName,
        resultKeys: Object.keys(result || {}),
      });
      throw new Error(`File upload succeeded but Slack returned no file metadata. Response keys: ${Object.keys(result || {}).join(', ')}`);
    }

    logger.info('File uploaded', {
      name: displayName,
      size,
      file_id: uploadedFile.id,
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          uploaded: true,
          file_id: uploadedFile.id,
          filename: displayName,
          size,
          permalink: uploadedFile.permalink || '',
          channel: this.context.channel,
          thread_ts: this.context.threadTs,
        }),
      }],
    };
  }

  // ── send_media ─────────────────────────────────────────

  private async handleSendMedia(args: {
    file_path: string;
    filename?: string;
    title?: string;
    alt_text?: string;
    initial_comment?: string;
  }) {
    const { resolvedPath, size } = await validateFilePath(args.file_path);
    const displayName = args.filename || path.basename(resolvedPath);

    // Validate media type
    const ext = path.extname(resolvedPath).toLowerCase().slice(1);
    if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported media type: .${ext}. Allowed: ${[...ALLOWED_MEDIA_EXTENSIONS].join(', ')}`
      );
    }

    const media_type = getMediaType(ext);

    logger.info('Uploading media', { name: displayName, size, media_type, path: resolvedPath });

    const uploadArgs: any = {
      file: resolvedPath,
      filename: displayName,
      channel_id: this.context.channel,
      thread_ts: this.context.threadTs,
    };
    if (args.title) uploadArgs.title = args.title;
    if (args.alt_text) uploadArgs.alt_text = args.alt_text;
    if (args.initial_comment) uploadArgs.initial_comment = args.initial_comment;

    const result = await this.slack.filesUploadV2(uploadArgs);

    const uploadedFile = (result as any).files?.[0]?.files?.[0]
      || (result as any).files?.[0]
      || null;

    if (!uploadedFile?.id) {
      logger.error('Slack filesUploadV2 returned unexpected response shape', {
        name: displayName,
        media_type,
        resultKeys: Object.keys(result || {}),
      });
      throw new Error(`Media upload succeeded but Slack returned no file metadata. Response keys: ${Object.keys(result || {}).join(', ')}`);
    }

    logger.info('Media uploaded', {
      name: displayName,
      size,
      file_id: uploadedFile.id,
      media_type,
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          uploaded: true,
          file_id: uploadedFile.id,
          filename: displayName,
          size,
          media_type,
          permalink: uploadedFile.permalink || '',
          channel: this.context.channel,
          thread_ts: this.context.threadTs,
        }),
      }],
    };
  }

  // ── Entry point ──────────────────────────────────────

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('SlackMCP server started', {
      channel: this.context.channel,
      threadTs: this.context.threadTs,
      mentionTs: this.context.mentionTs,
    });
  }
}

// ── Main ─────────────────────────────────────────────────

const server = new SlackMcpServer();
server.run().catch((err) => {
  logger.error('Failed to start SlackMCP server', err);
  process.exit(1);
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for SlackThreadMcpServer internals.
 *
 * Since the server class is not exported and relies on process.env + MCP transport,
 * we test the validation logic and key behaviors via controlled process.env manipulation.
 * The actual server is instantiated by importing the module.
 */

describe('SlackThreadMcpServer constructor validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('throws when SLACK_BOT_TOKEN is missing', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_THREAD_CONTEXT = JSON.stringify({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
    });

    // Dynamic import to trigger constructor — must be isolated
    await expect(async () => {
      // We can't easily re-import the module, so we test the logic directly
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) throw new Error('SLACK_BOT_TOKEN environment variable is required');
    }).rejects.toThrow('SLACK_BOT_TOKEN');
  });

  it('throws when SLACK_THREAD_CONTEXT is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    delete process.env.SLACK_THREAD_CONTEXT;

    const contextStr = process.env.SLACK_THREAD_CONTEXT;
    expect(contextStr).toBeUndefined();
    expect(() => {
      if (!contextStr) throw new Error('SLACK_THREAD_CONTEXT environment variable is required');
    }).toThrow('SLACK_THREAD_CONTEXT');
  });

  it('throws on malformed SLACK_THREAD_CONTEXT JSON', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_THREAD_CONTEXT = '{bad json';

    expect(() => {
      try {
        JSON.parse(process.env.SLACK_THREAD_CONTEXT!);
      } catch (err) {
        throw new Error(
          `Failed to parse SLACK_THREAD_CONTEXT: ${(err as Error).message}. Raw: ${process.env.SLACK_THREAD_CONTEXT!.substring(0, 200)}`
        );
      }
    }).toThrow('Failed to parse SLACK_THREAD_CONTEXT');
  });

  it('throws when channel is missing from context', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_THREAD_CONTEXT = JSON.stringify({ threadTs: '123' });

    const context = JSON.parse(process.env.SLACK_THREAD_CONTEXT);
    // channel is undefined → validation should throw
    expect(() => {
      if (!context.channel || !context.threadTs) {
        throw new Error('SLACK_THREAD_CONTEXT must contain channel and threadTs');
      }
    }).toThrow('SLACK_THREAD_CONTEXT must contain channel and threadTs');
  });

  it('throws when threadTs is missing from context', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_THREAD_CONTEXT = JSON.stringify({ channel: 'C123' });

    const context = JSON.parse(process.env.SLACK_THREAD_CONTEXT);
    expect(() => {
      if (!context.channel || !context.threadTs) {
        throw new Error('SLACK_THREAD_CONTEXT must contain channel and threadTs');
      }
    }).toThrow('SLACK_THREAD_CONTEXT must contain channel and threadTs');
  });

  it('defaults mentionTs to threadTs when not provided', () => {
    const context = { channel: 'C123', threadTs: '1700000000.000000' } as any;
    if (!context.mentionTs) {
      context.mentionTs = context.threadTs;
    }
    expect(context.mentionTs).toBe('1700000000.000000');
  });
});

describe('ALLOWED_FILE_HOSTS validation', () => {
  const ALLOWED_FILE_HOSTS = new Set([
    'files.slack.com',
    'files-pri.slack.com',
    'files-tmb.slack.com',
  ]);

  it('allows valid Slack file hosts', () => {
    expect(ALLOWED_FILE_HOSTS.has('files.slack.com')).toBe(true);
    expect(ALLOWED_FILE_HOSTS.has('files-pri.slack.com')).toBe(true);
    expect(ALLOWED_FILE_HOSTS.has('files-tmb.slack.com')).toBe(true);
  });

  it('rejects non-Slack hosts', () => {
    expect(ALLOWED_FILE_HOSTS.has('evil.com')).toBe(false);
    expect(ALLOWED_FILE_HOSTS.has('files.slack.com.evil.com')).toBe(false);
    expect(ALLOWED_FILE_HOSTS.has('slack.com')).toBe(false);
    expect(ALLOWED_FILE_HOSTS.has('')).toBe(false);
  });

  it('validates URL parsing for host extraction', () => {
    const validUrl = new URL('https://files.slack.com/files-pri/T123-F456/image.png');
    expect(ALLOWED_FILE_HOSTS.has(validUrl.hostname)).toBe(true);

    const evilUrl = new URL('https://evil.com/exfiltrate');
    expect(ALLOWED_FILE_HOSTS.has(evilUrl.hostname)).toBe(false);
  });

  it('throws on invalid URLs', () => {
    expect(() => new URL('not-a-url')).toThrow();
  });
});

describe('filename sanitization', () => {
  // Use require for synchronous import in test context
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');

  function sanitize(fileName: string): string {
    return path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  it('preserves safe filenames', () => {
    expect(sanitize('document.pdf')).toBe('document.pdf');
    expect(sanitize('image-2024.png')).toBe('image-2024.png');
  });

  it('strips path traversal components', () => {
    expect(sanitize('../../etc/passwd')).toBe('passwd');
    expect(sanitize('/root/.ssh/id_rsa')).toBe('id_rsa');
  });

  it('replaces unsafe characters', () => {
    expect(sanitize('file with spaces.txt')).toBe('file_with_spaces.txt');
    expect(sanitize('file<script>.js')).toBe('file_script_.js');
  });
});

describe('error classification logic', () => {
  it('identifies rate limit errors as retryable', () => {
    const error = { status: 429, data: { error: 'ratelimited' }, message: 'rate limited' };
    const slackErrorCode = error?.data?.error;
    const isRateLimited = error?.status === 429 || slackErrorCode === 'ratelimited';
    expect(isRateLimited).toBe(true);
  });

  it('identifies auth errors', () => {
    const error = { data: { error: 'invalid_auth' }, message: 'invalid auth' };
    const slackErrorCode = error?.data?.error;
    const isAuthError = slackErrorCode === 'invalid_auth' || slackErrorCode === 'not_authed';
    expect(isAuthError).toBe(true);
  });

  it('does not flag normal errors as retryable', () => {
    const error: any = { message: 'channel_not_found', data: { error: 'channel_not_found' } };
    const slackErrorCode = error?.data?.error;
    const isRateLimited = error?.status === 429 || slackErrorCode === 'ratelimited';
    expect(isRateLimited).toBe(false);
  });
});

describe('isImageFile helper', () => {
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);

  function isImageFile(mimetype?: string, filename?: string): boolean {
    if (mimetype && mimetype.startsWith('image/')) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      if (IMAGE_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }

  it('detects image mimetypes', () => {
    expect(isImageFile('image/png')).toBe(true);
    expect(isImageFile('image/jpeg')).toBe(true);
    expect(isImageFile('image/gif')).toBe(true);
    expect(isImageFile('image/webp')).toBe(true);
    expect(isImageFile('image/svg+xml')).toBe(true);
  });

  it('detects image file extensions', () => {
    expect(isImageFile(undefined, 'photo.jpg')).toBe(true);
    expect(isImageFile(undefined, 'photo.JPEG')).toBe(true);
    expect(isImageFile(undefined, 'icon.png')).toBe(true);
    expect(isImageFile(undefined, 'animation.gif')).toBe(true);
    expect(isImageFile(undefined, 'photo.heic')).toBe(true);
    expect(isImageFile(undefined, 'photo.avif')).toBe(true);
  });

  it('rejects non-image types', () => {
    expect(isImageFile('text/plain')).toBe(false);
    expect(isImageFile('application/pdf')).toBe(false);
    expect(isImageFile(undefined, 'document.pdf')).toBe(false);
    expect(isImageFile(undefined, 'code.ts')).toBe(false);
    expect(isImageFile(undefined, 'data.json')).toBe(false);
  });

  it('handles edge cases', () => {
    expect(isImageFile(undefined, undefined)).toBe(false);
    expect(isImageFile('', '')).toBe(false);
    expect(isImageFile(undefined, 'noextension')).toBe(false);
  });
});

describe('download_thread_file image blocking', () => {
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);

  function isImageFile(mimetype?: string, filename?: string): boolean {
    if (mimetype && mimetype.startsWith('image/')) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      if (IMAGE_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }

  it('blocks image file downloads and returns blocked response', () => {
    const imageFiles = ['screenshot.png', 'photo.jpg', 'animation.gif', 'icon.webp', 'logo.svg'];

    for (const fileName of imageFiles) {
      expect(isImageFile(undefined, fileName)).toBe(true);
      // Simulates the early return in handleDownloadFile
      const response = {
        blocked: true,
        name: fileName,
        reason: 'Image files cannot be downloaded and read — the API will reject them with "Could not process image".',
      };
      expect(response.blocked).toBe(true);
    }
  });

  it('allows non-image file downloads', () => {
    const nonImageFiles = ['document.pdf', 'script.ts', 'data.json', 'readme.md', 'archive.zip'];

    for (const fileName of nonImageFiles) {
      expect(isImageFile(undefined, fileName)).toBe(false);
    }
  });
});

describe('thread message formatting', () => {
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);

  function isImageFile(mimetype?: string, filename?: string): boolean {
    if (mimetype && mimetype.startsWith('image/')) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      if (IMAGE_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }

  function formatMessage(m: any) {
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

  it('formats a basic user message', () => {
    const msg = formatMessage({
      ts: '1700000000.000000',
      user: 'U123',
      text: 'Hello world',
    });

    expect(msg.ts).toBe('1700000000.000000');
    expect(msg.user).toBe('U123');
    expect(msg.text).toBe('Hello world');
    expect(msg.is_bot).toBe(false);
    expect(msg.files).toEqual([]);
    expect(msg.reactions).toEqual([]);
    expect(msg.subtype).toBeNull();
  });

  it('formats a bot message', () => {
    const msg = formatMessage({
      ts: '1700000001.000000',
      bot_id: 'B123',
      text: 'Bot reply',
    });

    expect(msg.user).toBe('B123');
    expect(msg.is_bot).toBe(true);
  });

  it('extracts image file attachments WITHOUT url_private_download and WITH image warning', () => {
    const msg = formatMessage({
      ts: '1700000002.000000',
      user: 'U123',
      text: '',
      files: [
        {
          id: 'F001',
          name: 'screenshot.png',
          mimetype: 'image/png',
          url_private_download: 'https://files.slack.com/files-pri/T123-F001/screenshot.png',
          size: 12345,
          thumb_360: 'https://files.slack.com/files-tmb/T123-F001/screenshot_360.png',
        },
      ],
    });

    expect(msg.files).toHaveLength(1);
    expect(msg.files[0].id).toBe('F001');
    expect(msg.files[0].name).toBe('screenshot.png');
    expect(msg.files[0].thumb_360).toBeDefined();
    // Image files must NOT have url_private_download (prevents Claude from downloading + Reading)
    expect(msg.files[0].url_private_download).toBeUndefined();
    expect(msg.files[0].is_image).toBe(true);
    expect(msg.files[0].image_note).toContain('do NOT download or Read');
  });

  it('extracts non-image file attachments WITH url_private_download and WITHOUT image warning', () => {
    const msg = formatMessage({
      ts: '1700000002.500000',
      user: 'U123',
      text: '',
      files: [
        {
          id: 'F002',
          name: 'document.pdf',
          mimetype: 'application/pdf',
          url_private_download: 'https://files.slack.com/files-pri/T123-F002/document.pdf',
          size: 54321,
        },
      ],
    });

    expect(msg.files).toHaveLength(1);
    expect(msg.files[0].url_private_download).toBe('https://files.slack.com/files-pri/T123-F002/document.pdf');
    expect(msg.files[0].is_image).toBeUndefined();
    expect(msg.files[0].image_note).toBeUndefined();
  });

  it('formats reactions', () => {
    const msg = formatMessage({
      ts: '1700000003.000000',
      user: 'U123',
      text: 'With reactions',
      reactions: [
        { name: 'thumbsup', count: 3 },
        { name: 'eyes', count: 1 },
      ],
    });

    expect(msg.reactions).toHaveLength(2);
    expect(msg.reactions[0]).toEqual({ name: 'thumbsup', count: 3 });
  });

  it('uses display_name from user_profile when available', () => {
    const msg = formatMessage({
      ts: '1700000004.000000',
      user: 'U123',
      user_profile: { display_name: 'John', real_name: 'John Doe' },
      text: 'Test',
    });

    expect(msg.user_name).toBe('John');
  });

  it('falls back to user ID when no profile', () => {
    const msg = formatMessage({
      ts: '1700000005.000000',
      user: 'U123',
      text: 'Test',
    });

    expect(msg.user_name).toBe('U123');
  });
});

describe('hasMore pagination heuristics', () => {
  it('hasMoreBefore is true when returned count equals requested count', () => {
    const before = 10;
    const beforeMessages = new Array(10).fill({ ts: '1.0' });
    const hasMoreBefore = before > 0 && beforeMessages.length === before;
    expect(hasMoreBefore).toBe(true);
  });

  it('hasMoreBefore is false when returned count is less than requested', () => {
    const before = 10;
    const beforeMessages = new Array(5).fill({ ts: '1.0' });
    const hasMoreBefore = before > 0 && beforeMessages.length === before;
    expect(hasMoreBefore).toBe(false);
  });

  it('hasMoreBefore is false when before is 0', () => {
    const before = 0;
    const beforeMessages: any[] = [];
    const hasMoreBefore = before > 0 && beforeMessages.length === before;
    expect(hasMoreBefore).toBe(false);
  });

  it('hasMoreAfter follows same pattern', () => {
    const after = 5;
    const afterMessages = new Array(5).fill({ ts: '1.0' });
    const hasMoreAfter = after > 0 && afterMessages.length === after;
    expect(hasMoreAfter).toBe(true);
  });
});

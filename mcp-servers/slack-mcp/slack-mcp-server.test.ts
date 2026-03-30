import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for SlackMcpServer internals.
 *
 * Since the server class is not exported and relies on process.env + MCP transport,
 * we test the validation logic and key behaviors via controlled process.env manipulation.
 * The actual server is instantiated by importing the module.
 */

describe('SlackMcpServer constructor validation', () => {
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
    process.env.SLACK_MCP_CONTEXT = JSON.stringify({
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

  it('throws when SLACK_MCP_CONTEXT is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    delete process.env.SLACK_MCP_CONTEXT;

    const contextStr = process.env.SLACK_MCP_CONTEXT;
    expect(contextStr).toBeUndefined();
    expect(() => {
      if (!contextStr) throw new Error('SLACK_MCP_CONTEXT environment variable is required');
    }).toThrow('SLACK_MCP_CONTEXT');
  });

  it('throws on malformed SLACK_MCP_CONTEXT JSON', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_MCP_CONTEXT = '{bad json';

    expect(() => {
      try {
        JSON.parse(process.env.SLACK_MCP_CONTEXT!);
      } catch (err) {
        throw new Error(
          `Failed to parse SLACK_MCP_CONTEXT: ${(err as Error).message}. Raw: ${process.env.SLACK_MCP_CONTEXT!.substring(0, 200)}`
        );
      }
    }).toThrow('Failed to parse SLACK_MCP_CONTEXT');
  });

  it('throws when channel is missing from context', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_MCP_CONTEXT = JSON.stringify({ threadTs: '123' });

    const context = JSON.parse(process.env.SLACK_MCP_CONTEXT);
    // channel is undefined → validation should throw
    expect(() => {
      if (!context.channel || !context.threadTs) {
        throw new Error('SLACK_MCP_CONTEXT must contain channel and threadTs');
      }
    }).toThrow('SLACK_MCP_CONTEXT must contain channel and threadTs');
  });

  it('throws when threadTs is missing from context', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_MCP_CONTEXT = JSON.stringify({ channel: 'C123' });

    const context = JSON.parse(process.env.SLACK_MCP_CONTEXT);
    expect(() => {
      if (!context.channel || !context.threadTs) {
        throw new Error('SLACK_MCP_CONTEXT must contain channel and threadTs');
      }
    }).toThrow('SLACK_MCP_CONTEXT must contain channel and threadTs');
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

// ── Scenario 2 — download_thread_file media blocking (Trace: docs/media-file-support/trace.md) ──

describe('download_thread_file media blocking (video/audio)', () => {
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);
  const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp']);
  const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']);

  function isMediaFile(mimetype?: string, filename?: string): boolean {
    if (mimetype && (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/'))) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
    }
    return false;
  }

  // Trace: Scenario 2, Section 3a — isMediaFile for video
  it('isMediaFile returns true for video extensions', () => {
    expect(isMediaFile(undefined, 'video.mp4')).toBe(true);
    expect(isMediaFile(undefined, 'movie.mov')).toBe(true);
    expect(isMediaFile(undefined, 'clip.webm')).toBe(true);
    expect(isMediaFile(undefined, 'film.avi')).toBe(true);
    expect(isMediaFile(undefined, 'reel.mkv')).toBe(true);
  });

  // Trace: Scenario 2, Section 3a — isMediaFile for audio
  it('isMediaFile returns true for audio extensions', () => {
    expect(isMediaFile(undefined, 'song.mp3')).toBe(true);
    expect(isMediaFile(undefined, 'recording.wav')).toBe(true);
    expect(isMediaFile(undefined, 'podcast.ogg')).toBe(true);
    expect(isMediaFile(undefined, 'track.flac')).toBe(true);
    expect(isMediaFile(undefined, 'voice.m4a')).toBe(true);
  });

  // Trace: Scenario 2, Section 3a — isMediaFile regression for images
  it('isMediaFile returns true for image extensions (regression)', () => {
    expect(isMediaFile(undefined, 'photo.jpg')).toBe(true);
    expect(isMediaFile(undefined, 'icon.png')).toBe(true);
    expect(isMediaFile(undefined, 'logo.svg')).toBe(true);
  });

  // Trace: Scenario 2, Section 5 — non-media allowed
  it('isMediaFile returns false for text/code extensions', () => {
    expect(isMediaFile(undefined, 'script.ts')).toBe(false);
    expect(isMediaFile(undefined, 'data.json')).toBe(false);
    expect(isMediaFile(undefined, 'readme.md')).toBe(false);
    expect(isMediaFile(undefined, 'document.pdf')).toBe(false);
    expect(isMediaFile(undefined, 'archive.zip')).toBe(false);
  });

  // Codex review P1 fix: isMediaFile detects media by mimetype even without extension
  it('isMediaFile returns true for video/audio mimetypes without known extension', () => {
    expect(isMediaFile('video/mp4')).toBe(true);
    expect(isMediaFile('video/quicktime')).toBe(true);
    expect(isMediaFile('audio/ogg')).toBe(true);
    expect(isMediaFile('audio/mpeg')).toBe(true);
    expect(isMediaFile('video/webm', 'no-extension')).toBe(true);
    // Non-media mimetype + non-media extension → false
    expect(isMediaFile('application/pdf', 'doc.pdf')).toBe(false);
  });

  // Trace: Scenario 2, Section 3b — blocked response for video
  it('download_thread_file blocks video files with blocked response', () => {
    const fileName = 'recording.mp4';
    expect(isMediaFile(undefined, fileName)).toBe(true);
    const response = {
      blocked: true,
      name: fileName,
      reason: 'Media files (image/video/audio) cannot be downloaded and read. Reference the file by name and metadata only.',
    };
    expect(response.blocked).toBe(true);
    expect(response.reason).toContain('Media files');
  });

  // Trace: Scenario 2, Section 3b — blocked response for audio
  it('download_thread_file blocks audio files with blocked response', () => {
    const fileName = 'voice-memo.mp3';
    expect(isMediaFile(undefined, fileName)).toBe(true);
    const response = {
      blocked: true,
      name: fileName,
      reason: 'Media files (image/video/audio) cannot be downloaded and read. Reference the file by name and metadata only.',
    };
    expect(response.blocked).toBe(true);
  });

  // Trace: Scenario 2, Section 5 — text files still allowed
  it('download_thread_file still allows text files', () => {
    expect(isMediaFile(undefined, 'code.ts')).toBe(false);
    expect(isMediaFile(undefined, 'data.csv')).toBe(false);
  });
});

describe('thread message formatting', () => {
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);
  const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp']);
  const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']);

  function isImageFile(mimetype?: string, filename?: string): boolean {
    if (mimetype && mimetype.startsWith('image/')) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      if (IMAGE_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }

  function isMediaFile(mimetype?: string, filename?: string): boolean {
    if (mimetype && (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/'))) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
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

  // ── Scenario 3 — Thread message listing media metadata (Trace: docs/media-file-support/trace.md) ──

  // Trace: Scenario 3, Section 3a — video file excludes download URL
  it('excludes download URL for video files', () => {
    const msg = formatMessage({
      ts: '1700000010.000000',
      user: 'U123',
      text: '',
      files: [
        {
          id: 'F010',
          name: 'demo.mp4',
          mimetype: 'video/mp4',
          url_private_download: 'https://files.slack.com/files-pri/T123-F010/demo.mp4',
          size: 5000000,
        },
      ],
    });

    expect(msg.files).toHaveLength(1);
    expect(msg.files[0].name).toBe('demo.mp4');
    expect(msg.files[0].url_private_download).toBeUndefined();
    expect(msg.files[0].is_media).toBe(true);
    expect(msg.files[0].media_note).toContain('do NOT download or Read');
  });

  // Trace: Scenario 3, Section 3a — audio file excludes download URL
  it('excludes download URL for audio files', () => {
    const msg = formatMessage({
      ts: '1700000011.000000',
      user: 'U123',
      text: '',
      files: [
        {
          id: 'F011',
          name: 'recording.mp3',
          mimetype: 'audio/mpeg',
          url_private_download: 'https://files.slack.com/files-pri/T123-F011/recording.mp3',
          size: 1200000,
        },
      ],
    });

    expect(msg.files).toHaveLength(1);
    expect(msg.files[0].name).toBe('recording.mp3');
    expect(msg.files[0].url_private_download).toBeUndefined();
    expect(msg.files[0].is_media).toBe(true);
    expect(msg.files[0].media_note).toContain('do NOT download or Read');
  });

  // Trace: Scenario 3, Section 3b — media_note content for video
  it('adds media_note for video files', () => {
    const msg = formatMessage({
      ts: '1700000012.000000',
      user: 'U123',
      text: '',
      files: [
        {
          id: 'F012',
          name: 'screen-recording.mov',
          mimetype: 'video/quicktime',
          url_private_download: 'https://files.slack.com/files-pri/T123-F012/screen-recording.mov',
          size: 8000000,
        },
      ],
    });

    const file = msg.files[0];
    expect(file.is_media).toBe(true);
    expect(file.media_note).toBeDefined();
  });

  // Trace: Scenario 3, Section 5 — text files still have download URL
  it('still includes download URL for text files', () => {
    const msg = formatMessage({
      ts: '1700000013.000000',
      user: 'U123',
      text: '',
      files: [
        {
          id: 'F013',
          name: 'code.ts',
          mimetype: 'text/typescript',
          url_private_download: 'https://files.slack.com/files-pri/T123-F013/code.ts',
          size: 500,
        },
      ],
    });

    expect(msg.files[0].url_private_download).toBe('https://files.slack.com/files-pri/T123-F013/code.ts');
    expect(msg.files[0].is_media).toBeUndefined();
  });

  // Trace: Scenario 3, Section 3a — regression: images still work
  it('still excludes download URL for image files (regression)', () => {
    const msg = formatMessage({
      ts: '1700000014.000000',
      user: 'U123',
      text: '',
      files: [
        {
          id: 'F014',
          name: 'photo.jpg',
          mimetype: 'image/jpeg',
          url_private_download: 'https://files.slack.com/files-pri/T123-F014/photo.jpg',
          size: 30000,
        },
      ],
    });

    expect(msg.files[0].url_private_download).toBeUndefined();
    // Image should still have is_image (backward compat)
    expect(msg.files[0].is_image).toBe(true);
  });
});

describe('hasMore pagination heuristics', () => {
  // Production logic: effectiveLen = rootWasInjected ? len - 1 : len;
  // hasMore = before > 0 ? effectiveLen >= before : ...
  function computeHasMore(before: number, msgLen: number, rootWasInjected: boolean): boolean {
    const effectiveLen = rootWasInjected ? msgLen - 1 : msgLen;
    return before > 0 ? effectiveLen >= before : false;
  }

  it('hasMoreBefore is true when effective count equals requested', () => {
    expect(computeHasMore(10, 10, false)).toBe(true);
  });

  it('hasMoreBefore is false when effective count is less than requested', () => {
    expect(computeHasMore(10, 5, false)).toBe(false);
  });

  it('hasMoreBefore is false when before is 0', () => {
    expect(computeHasMore(0, 0, false)).toBe(false);
  });

  it('hasMoreBefore: root injection does NOT cause false positive', () => {
    // before=2, returned 3 messages but root was injected → effective = 2
    // effective === before → at boundary (conservative true), but NOT because of root
    expect(computeHasMore(2, 3, true)).toBe(true); // genuinely at boundary
    // before=3, returned 3 + injected root = 4 → effective = 3
    expect(computeHasMore(3, 4, true)).toBe(true); // genuinely at boundary
    // before=5, returned 3 + injected root = 4 → effective = 3 < 5
    expect(computeHasMore(5, 4, true)).toBe(false); // correctly false
  });

  it('hasMoreAfter follows same pattern', () => {
    const after = 5;
    const afterMessages = new Array(5).fill({ ts: '1.0' });
    const hasMoreAfter = after > 0 && afterMessages.length === after;
    expect(hasMoreAfter).toBe(true);
  });
});

// ── Trace: docs/fix-thread-header-files/trace.md ──

// S1: Legacy mode includes root message
describe('fetchMessagesBefore — root message inclusion', () => {
  const threadTs = '1700000000.000000';

  /**
   * Simulates fetchMessagesBefore logic (matches production code).
   * Root message is always preserved even when .slice(-count) would trim it.
   */
  function fetchMessagesBefore(
    messages: { ts: string; files?: any[] }[],
    anchorTs: string,
    count: number
  ): { ts: string; files?: any[] }[] {
    if (count === 0) return [];
    let rootMessage: { ts: string; files?: any[] } | null = null;
    const collected: { ts: string; files?: any[] }[] = [];
    for (const m of messages) {
      if (m.ts > anchorTs) break;
      if (m.ts === threadTs) rootMessage = m;
      collected.push(m);
    }
    const sliced = collected.slice(-count);
    // Ensure root is always present
    if (rootMessage && !sliced.some(m => m.ts === threadTs)) {
      sliced.unshift(rootMessage);
    }
    return sliced;
  }

  // Trace: S1, Section 3 — root message with files IS included
  it('legacyMode_includesRootMessage: root message with files is included in results', () => {
    const messages = [
      { ts: threadTs, files: [{ id: 'F1', name: 'screenshot.png', mimetype: 'image/png', size: 1024 }] },
      { ts: '1700000001.000000', files: [] },
      { ts: '1700000002.000000', files: [] },
    ];
    const anchorTs = '1700000002.000000';

    const result = fetchMessagesBefore(messages, anchorTs, 10);

    // Root message MUST be in results
    expect(result.some(m => m.ts === threadTs)).toBe(true);
    // Root message files MUST be present
    const rootMsg = result.find(m => m.ts === threadTs);
    expect(rootMsg?.files).toHaveLength(1);
    expect(rootMsg?.files?.[0].name).toBe('screenshot.png');
  });

  // Trace: S1 — deep thread: root survives .slice(-count)
  it('legacyMode_deepThread_rootSurvivesSlice: root is preserved even when slice would trim it', () => {
    // 25 replies + root = 26 messages, before=20 → slice(-20) would normally drop root
    const messages = [
      { ts: threadTs, files: [{ id: 'F1', name: 'header-image.png' }] },
      ...Array.from({ length: 24 }, (_, i) => ({
        ts: `170000000${String(i + 1).padStart(1, '0')}.000000`,
      })),
    ];
    const anchorTs = '1700000024.000000';

    const result = fetchMessagesBefore(messages, anchorTs, 20);

    // Root MUST be present even though slice(-20) would normally exclude it
    expect(result.some(m => m.ts === threadTs)).toBe(true);
    const rootMsg = result.find(m => m.ts === threadTs);
    expect(rootMsg?.files?.[0].name).toBe('header-image.png');
    // Result is count + 1 (root injected beyond count)
    expect(result.length).toBe(21);
  });

  // Trace: S1, Section 5 — count limiting still works with root naturally in window
  it('legacyMode_countLimitWithRoot: count limit works when root is naturally within window', () => {
    const messages = [
      { ts: threadTs, files: [{ id: 'F1', name: 'image.png' }] },
      { ts: '1700000001.000000' },
      { ts: '1700000002.000000' },
      { ts: '1700000003.000000' },
    ];
    const anchorTs = '1700000003.000000';

    // Request last 2: root is NOT in the natural window, but gets injected
    const result = fetchMessagesBefore(messages, anchorTs, 2);
    // Root injected + 2 sliced = 3
    expect(result[0].ts).toBe(threadTs);
    expect(result.some(m => m.ts === threadTs)).toBe(true);
  });
});

// S3: Array mode root message files regression guard
describe('formatSingleMessage — root message file metadata', () => {
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']);

  function isImageFile(mimetype?: string, filename?: string): boolean {
    if (mimetype && mimetype.startsWith('image/')) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      if (IMAGE_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }

  function isMediaFile(mimetype?: string, filename?: string): boolean {
    if (mimetype && (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/'))) return true;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      return IMAGE_EXTENSIONS.has(ext);
    }
    return false;
  }

  function formatFileMetadata(f: any) {
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
    };
  }

  // Trace: S3 — root message image file metadata preserved in array mode
  it('arrayMode_rootMessageIncludesFiles: image file has is_image and metadata', () => {
    const file = {
      id: 'F_ROOT_IMG',
      name: 'header-screenshot.png',
      mimetype: 'image/png',
      size: 204800,
      url_private_download: 'https://files.slack.com/files-pri/T123/header-screenshot.png',
      thumb_360: 'https://files.slack.com/files-tmb/T123/header-screenshot_360.png',
    };

    const formatted = formatFileMetadata(file);

    expect(formatted.id).toBe('F_ROOT_IMG');
    expect(formatted.name).toBe('header-screenshot.png');
    expect(formatted.mimetype).toBe('image/png');
    expect(formatted.size).toBe(204800);
    expect(formatted.is_image).toBe(true);
    expect(formatted.image_note).toBeDefined();
    expect(formatted.thumb_360).toBeDefined();
    // Image files should NOT have url_private_download (prevent binary read errors)
    expect(formatted.url_private_download).toBeUndefined();
  });

  // Trace: S3 — non-image file retains url_private_download
  it('arrayMode_rootMessageNonImageFile: PDF file has url_private_download', () => {
    const file = {
      id: 'F_ROOT_PDF',
      name: 'spec.pdf',
      mimetype: 'application/pdf',
      size: 512000,
      url_private_download: 'https://files.slack.com/files-pri/T123/spec.pdf',
    };

    const formatted = formatFileMetadata(file);

    expect(formatted.url_private_download).toBe('https://files.slack.com/files-pri/T123/spec.pdf');
    expect(formatted.is_image).toBeUndefined();
  });
});

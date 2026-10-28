import { describe, expect, it } from 'vitest';
import { isImageFile, isMediaFile, isNonVisualMedia } from './helpers/file-validator.js';

/**
 * Unit tests for slack-mcp-server.ts logic.
 *
 * The media predicates are the real exports of helpers/file-validator.ts. The server class
 * itself is not exported and starts on import, so the remaining blocks below still check
 * local restatements of its inline logic (host allow-list, filename sanitisation, error
 * classification, has_more heuristic).
 */

describe('ALLOWED_FILE_HOSTS validation', () => {
  const ALLOWED_FILE_HOSTS = new Set(['files.slack.com', 'files-pri.slack.com', 'files-tmb.slack.com']);

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

describe('isNonVisualMedia helper', () => {
  it('returns true for audio mimetypes', () => {
    expect(isNonVisualMedia('audio/mp3')).toBe(true);
    expect(isNonVisualMedia('audio/wav')).toBe(true);
  });

  it('returns true for video mimetypes', () => {
    expect(isNonVisualMedia('video/mp4')).toBe(true);
    expect(isNonVisualMedia('video/quicktime')).toBe(true);
  });

  it('returns false for image mimetypes', () => {
    expect(isNonVisualMedia('image/png')).toBe(false);
    expect(isNonVisualMedia('image/jpeg')).toBe(false);
  });

  it('returns true for audio extensions', () => {
    expect(isNonVisualMedia(undefined, 'song.mp3')).toBe(true);
    expect(isNonVisualMedia(undefined, 'recording.wav')).toBe(true);
    expect(isNonVisualMedia(undefined, 'track.flac')).toBe(true);
  });

  it('returns true for video extensions', () => {
    expect(isNonVisualMedia(undefined, 'video.mp4')).toBe(true);
    expect(isNonVisualMedia(undefined, 'movie.mov')).toBe(true);
    expect(isNonVisualMedia(undefined, 'clip.webm')).toBe(true);
  });

  it('returns false for image extensions', () => {
    expect(isNonVisualMedia(undefined, 'photo.jpg')).toBe(false);
    expect(isNonVisualMedia(undefined, 'icon.png')).toBe(false);
  });

  it('returns false for non-media files', () => {
    expect(isNonVisualMedia(undefined, 'document.pdf')).toBe(false);
    expect(isNonVisualMedia(undefined, 'code.ts')).toBe(false);
  });

  it('handles edge cases', () => {
    expect(isNonVisualMedia(undefined, undefined)).toBe(false);
    expect(isNonVisualMedia('', '')).toBe(false);
  });
});

describe('download_thread_file allows images, blocks non-visual media', () => {
  it('allows image file downloads (images are no longer blocked)', () => {
    const imageFiles = ['screenshot.png', 'photo.jpg', 'animation.gif', 'icon.webp', 'logo.svg'];

    for (const fileName of imageFiles) {
      expect(isImageFile(undefined, fileName)).toBe(true);
      // Images are now ALLOWED for download — isNonVisualMedia returns false for images
      expect(isNonVisualMedia(undefined, fileName)).toBe(false);
    }
  });

  it('blocks audio file downloads via isNonVisualMedia', () => {
    const audioFiles = ['song.mp3', 'recording.wav', 'podcast.ogg'];

    for (const fileName of audioFiles) {
      expect(isNonVisualMedia(undefined, fileName)).toBe(true);
    }
  });

  it('blocks video file downloads via isNonVisualMedia', () => {
    const videoFiles = ['demo.mp4', 'clip.mov', 'screen.webm'];

    for (const fileName of videoFiles) {
      expect(isNonVisualMedia(undefined, fileName)).toBe(true);
    }
  });

  it('allows non-media file downloads', () => {
    const nonMediaFiles = ['document.pdf', 'script.ts', 'data.json', 'readme.md', 'archive.zip'];

    for (const fileName of nonMediaFiles) {
      expect(isImageFile(undefined, fileName)).toBe(false);
      expect(isNonVisualMedia(undefined, fileName)).toBe(false);
    }
  });
});

// ── Scenario 2 — download_thread_file media blocking (Trace: docs/media-file-support/trace.md) ──

describe('download_thread_file media blocking (video/audio)', () => {
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

  // Trace: Scenario 2, Section 5 — text files still allowed
  it('download_thread_file still allows text files', () => {
    expect(isMediaFile(undefined, 'code.ts')).toBe(false);
    expect(isMediaFile(undefined, 'data.csv')).toBe(false);
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

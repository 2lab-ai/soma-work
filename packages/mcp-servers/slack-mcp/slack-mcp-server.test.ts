import { describe, expect, it } from 'vitest';
import { isImageFile, isMediaFile, isNonVisualMedia } from './helpers/file-validator.js';

/**
 * The media predicates of helpers/file-validator.ts that download_thread_file and the message
 * formatter decide by. The server's own behaviour (host allow-list, file names, error shapes,
 * paging) is driven through its MCP handlers in slack-mcp-contract.test.ts.
 */

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
});

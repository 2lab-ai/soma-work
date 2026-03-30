import { describe, expect, it } from 'vitest';
import { FileHandler, ProcessedFile } from './file-handler';

describe('FileHandler.formatFilePrompt — image path included for viewing', () => {
  const handler = new FileHandler();

  function makeImageFile(name = 'screenshot.png'): ProcessedFile {
    return {
      path: '/tmp/slack-file-12345-screenshot.png',
      name,
      mimetype: 'image/png',
      isImage: true,
      isText: false,
      isVideo: false,
      isAudio: false,
      size: 54321,
      tempPath: '/tmp/slack-file-12345-screenshot.png',
    };
  }

  function makeTextFile(): ProcessedFile {
    return {
      path: '/tmp/slack-file-12345-code.ts',
      name: 'code.ts',
      mimetype: 'text/typescript',
      isImage: false,
      isText: true,
      isVideo: false,
      isAudio: false,
      size: 200,
      tempPath: '/tmp/slack-file-12345-code.ts',
    };
  }

  function makePdfFile(): ProcessedFile {
    return {
      path: '/tmp/slack-file-12345-doc.pdf',
      name: 'doc.pdf',
      mimetype: 'application/pdf',
      isImage: false,
      isText: false,
      isVideo: false,
      isAudio: false,
      size: 100000,
      tempPath: '/tmp/slack-file-12345-doc.pdf',
    };
  }

  it('includes Path for image files so agent can view them', async () => {
    const result = await handler.formatFilePrompt([makeImageFile()], '');

    // Path must be present so agent can use Read tool to view the image
    expect(result).toContain('/tmp/slack-file-12345-screenshot.png');
    expect(result).toMatch(/Path:/i);
    // Must still contain image metadata
    expect(result).toContain('screenshot.png');
    expect(result).toContain('image/png');
    expect(result).toContain('54321');
  });

  it('contains "Read tool" instruction for image files', async () => {
    const result = await handler.formatFilePrompt([makeImageFile()], '');

    expect(result).toContain('Read tool');
  });

  it('includes Path for PDF files', async () => {
    const result = await handler.formatFilePrompt([makePdfFile()], 'check this');

    expect(result).toContain('/tmp/slack-file-12345-doc.pdf');
    expect(result).toContain('Path:');
  });

  it('uses default prompt when no text provided with image-only upload', async () => {
    const result = await handler.formatFilePrompt([makeImageFile()], '');

    expect(result).toContain('Please analyze the uploaded files');
    // Image metadata should be present
    expect(result).toContain('screenshot.png');
  });

  it('handles mixed image + non-image files correctly', async () => {
    const result = await handler.formatFilePrompt(
      [makeImageFile(), makePdfFile()],
      'analyze these'
    );

    // Image path should now be present
    expect(result).toContain('/tmp/slack-file-12345-screenshot.png');
    // PDF path should be present
    expect(result).toContain('/tmp/slack-file-12345-doc.pdf');
    // Both file names should be present
    expect(result).toContain('screenshot.png');
    expect(result).toContain('doc.pdf');
  });
});

// ── Scenario 1 — Media file support (Trace: docs/media-file-support/trace.md) ──

describe('FileHandler.formatFilePrompt — video/audio media support', () => {
  const handler = new FileHandler();

  function makeVideoFile(name = 'clip.mp4'): ProcessedFile {
    return {
      path: '/tmp/slack-file-12345-clip.mp4',
      name,
      mimetype: 'video/mp4',
      isImage: false,
      isText: false,
      isVideo: true,
      isAudio: false,
      size: 5000000,
      tempPath: '/tmp/slack-file-12345-clip.mp4',
    };
  }

  function makeAudioFile(name = 'voice.mp3'): ProcessedFile {
    return {
      path: '/tmp/slack-file-12345-voice.mp3',
      name,
      mimetype: 'audio/mpeg',
      isImage: false,
      isText: false,
      isVideo: false,
      isAudio: true,
      size: 1200000,
      tempPath: '/tmp/slack-file-12345-voice.mp3',
    };
  }

  // Trace: Scenario 1, Section 3c — formatFilePrompt omits path for video
  it('does NOT include Path for video files', async () => {
    const result = await handler.formatFilePrompt([makeVideoFile()], '');

    expect(result).not.toContain('/tmp/slack-file-12345-clip.mp4');
    expect(result).not.toMatch(/Path:/i);
    expect(result).toContain('clip.mp4');
    expect(result).toContain('video/mp4');
    expect(result).toContain('5000000');
  });

  // Trace: Scenario 1, Section 3c — formatFilePrompt omits path for audio
  it('does NOT include Path for audio files', async () => {
    const result = await handler.formatFilePrompt([makeAudioFile()], '');

    expect(result).not.toContain('/tmp/slack-file-12345-voice.mp3');
    expect(result).not.toMatch(/Path:/i);
    expect(result).toContain('voice.mp3');
    expect(result).toContain('audio/mpeg');
  });

  // Trace: Scenario 1, Section 3c — ProcessedFile.isVideo → "Media:" header
  it('includes Media header for video files', async () => {
    const result = await handler.formatFilePrompt([makeVideoFile()], '');

    expect(result).toContain('## Media:');
    expect(result).not.toContain('Read tool');
  });

  // Trace: Scenario 1, Section 3c — ProcessedFile.isAudio → "Media:" header
  it('includes Media header for audio files', async () => {
    const result = await handler.formatFilePrompt([makeAudioFile()], '');

    expect(result).toContain('## Media:');
  });

  // Image path is now included so agent can view it
  it('includes path for image files', async () => {
    const imageFile: ProcessedFile = {
      path: '/tmp/slack-file-12345-screenshot.png',
      name: 'screenshot.png',
      mimetype: 'image/png',
      isImage: true,
      isText: false,
      isVideo: false,
      isAudio: false,
      size: 54321,
      tempPath: '/tmp/slack-file-12345-screenshot.png',
    };
    const result = await handler.formatFilePrompt([imageFile], '');

    expect(result).toContain('/tmp/slack-file-12345-screenshot.png');
    expect(result).toContain('screenshot.png');
  });

  // Trace: Scenario 1, Section 3b — isVideoFile identifies video mimetypes
  it('isVideoFile returns true for video mimetypes', () => {
    const fh = handler as any;
    expect(fh.isVideoFile('video/mp4')).toBe(true);
    expect(fh.isVideoFile('video/quicktime')).toBe(true);
    expect(fh.isVideoFile('video/webm')).toBe(true);
    expect(fh.isVideoFile('audio/mpeg')).toBe(false);
    expect(fh.isVideoFile('image/png')).toBe(false);
  });

  // Trace: Scenario 1, Section 3b — isAudioFile identifies audio mimetypes
  it('isAudioFile returns true for audio mimetypes', () => {
    const fh = handler as any;
    expect(fh.isAudioFile('audio/mpeg')).toBe(true);
    expect(fh.isAudioFile('audio/wav')).toBe(true);
    expect(fh.isAudioFile('audio/ogg')).toBe(true);
    expect(fh.isAudioFile('video/mp4')).toBe(false);
    expect(fh.isAudioFile('text/plain')).toBe(false);
  });

  // Codex review P1 fix: detect media by extension when MIME is generic
  it('isVideoFile detects video by extension when mimetype is generic', () => {
    const fh = handler as any;
    expect(fh.isVideoFile('application/octet-stream', 'clip.mp4')).toBe(true);
    expect(fh.isVideoFile('application/octet-stream', 'movie.mov')).toBe(true);
    expect(fh.isVideoFile('application/octet-stream', 'notes.txt')).toBe(false);
  });

  it('isAudioFile detects audio by extension when mimetype is generic', () => {
    const fh = handler as any;
    expect(fh.isAudioFile('application/octet-stream', 'song.mp3')).toBe(true);
    expect(fh.isAudioFile('application/octet-stream', 'voice.m4a')).toBe(true);
    expect(fh.isAudioFile('application/octet-stream', 'data.json')).toBe(false);
  });

  it('downloadFile detects media by extension when mimetype is application/octet-stream', async () => {
    const fh = handler as any;
    const file = { name: 'recording.mp4', mimetype: 'application/octet-stream', size: 5_000_000, url_private_download: 'https://example.com/video' };
    const result = await fh.downloadFile(file);

    expect(result).not.toBeNull();
    expect(result.isVideo).toBe(true);
    expect(result.path).toBe('');
    expect(result.tempPath).toBeUndefined();
  });

  // Gemini review: isImageFile extension fallback consistency
  it('isImageFile detects image by extension when mimetype is generic', () => {
    const fh = handler as any;
    expect(fh.isImageFile('application/octet-stream', 'photo.png')).toBe(true);
    expect(fh.isImageFile('application/octet-stream', 'pic.jpg')).toBe(true);
    expect(fh.isImageFile('application/octet-stream', 'icon.heic')).toBe(true);
    expect(fh.isImageFile('application/octet-stream', 'photo.avif')).toBe(true);
    expect(fh.isImageFile('application/octet-stream', 'data.json')).toBe(false);
    expect(fh.isImageFile('application/octet-stream', 'clip.mp4')).toBe(false);
  });

  // Gemini review P2 fix: media files skip download, return metadata-only ProcessedFile
  it('downloadFile returns metadata-only ProcessedFile for video without downloading', async () => {
    const fh = handler as any;
    const file = { name: 'big-video.mp4', mimetype: 'video/mp4', size: 200_000_000, url_private_download: 'https://example.com/video' };
    const result = await fh.downloadFile(file);

    expect(result).not.toBeNull();
    expect(result.isVideo).toBe(true);
    expect(result.name).toBe('big-video.mp4');
    expect(result.size).toBe(200_000_000);
    expect(result.path).toBe('');
    expect(result.tempPath).toBeUndefined();
  });

  it('downloadFile returns metadata-only ProcessedFile for audio without downloading', async () => {
    const fh = handler as any;
    const file = { name: 'podcast.mp3', mimetype: 'audio/mpeg', size: 80_000_000, url_private_download: 'https://example.com/audio' };
    const result = await fh.downloadFile(file);

    expect(result).not.toBeNull();
    expect(result.isAudio).toBe(true);
    expect(result.name).toBe('podcast.mp3');
    expect(result.size).toBe(80_000_000);
    expect(result.path).toBe('');
  });
});

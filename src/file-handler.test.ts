import { describe, expect, it } from 'vitest';
import { FileHandler, ProcessedFile } from './file-handler';

describe('FileHandler.formatFilePrompt — image path suppression', () => {
  const handler = new FileHandler();

  function makeImageFile(name = 'screenshot.png'): ProcessedFile {
    return {
      path: '/tmp/slack-file-12345-screenshot.png',
      name,
      mimetype: 'image/png',
      isImage: true,
      isText: false,
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
      size: 100000,
      tempPath: '/tmp/slack-file-12345-doc.pdf',
    };
  }

  it('does NOT include Path for image files', async () => {
    const result = await handler.formatFilePrompt([makeImageFile()], '');

    // Must NOT contain the temp path — this is the structural prevention
    expect(result).not.toContain('/tmp/slack-file-12345-screenshot.png');
    expect(result).not.toMatch(/Path:/i);
    // Must still contain image metadata
    expect(result).toContain('screenshot.png');
    expect(result).toContain('image/png');
    expect(result).toContain('54321');
  });

  it('does NOT contain "Read tool" instruction for image files', async () => {
    const result = await handler.formatFilePrompt([makeImageFile()], '');

    expect(result).not.toContain('Read tool');
    expect(result).not.toContain('Read 도구');
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

    // Image path should be suppressed
    expect(result).not.toContain('/tmp/slack-file-12345-screenshot.png');
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

  // Trace: Scenario 1, Section 3c — regression: image still works
  it('still suppresses path for image files (regression)', async () => {
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

    expect(result).not.toContain('/tmp/slack-file-12345-screenshot.png');
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
});

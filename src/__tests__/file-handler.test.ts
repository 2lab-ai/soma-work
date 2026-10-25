import { describe, expect, it } from 'vitest';
import { FileHandler, type ProcessedFile } from '../file-handler';

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
    const result = await handler.formatFilePrompt([makeImageFile(), makePdfFile()], 'analyze these');

    // Image path should now be present
    expect(result).toContain('/tmp/slack-file-12345-screenshot.png');
    // PDF path should be present
    expect(result).toContain('/tmp/slack-file-12345-doc.pdf');
    // Both file names should be present
    expect(result).toContain('screenshot.png');
    expect(result).toContain('doc.pdf');
  });
});

// ── Scenario 1 — Media file support (Trace: docs/archive/features/media-file-support/trace.md) ──

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

  // Trace: Scenario 1, Section 3c — ProcessedFile.isVideo → "Video:" header
  it('includes Video header for video files', async () => {
    const result = await handler.formatFilePrompt([makeVideoFile()], '');

    expect(result).toContain('## Video:');
    expect(result).not.toContain('Read tool');
  });

  // Trace: Scenario 1, Section 3c — ProcessedFile.isAudio → "Audio:" header
  it('includes Audio header for audio files', async () => {
    const result = await handler.formatFilePrompt([makeAudioFile()], '');

    expect(result).toContain('## Audio:');
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

  // Dashboard voice notes (SSOT 2026-10-23 T11): a browser recording in a .webm
  // container with an explicit audio/* type is audio — it must reach
  // transcription instead of being skipped as a video.
  it('an explicit audio/* mimetype wins over a video-looking extension', () => {
    const fh = handler as any;
    expect(fh.isVideoFile('audio/webm', 'voice-20261023-101500.webm')).toBe(false);
    expect(fh.isAudioFile('audio/webm', 'voice-20261023-101500.webm')).toBe(true);
    // Unchanged: a generic type with a video extension is still a video.
    expect(fh.isVideoFile('application/octet-stream', 'clip.webm')).toBe(true);
  });

  it('isAudioFile detects audio by extension when mimetype is generic', () => {
    const fh = handler as any;
    expect(fh.isAudioFile('application/octet-stream', 'song.mp3')).toBe(true);
    expect(fh.isAudioFile('application/octet-stream', 'voice.m4a')).toBe(true);
    expect(fh.isAudioFile('application/octet-stream', 'data.json')).toBe(false);
  });

  it('downloadFile detects media by extension when mimetype is application/octet-stream', async () => {
    const fh = handler as any;
    const srv = await serveBytes(Buffer.from('mp4-bytes'), 'application/octet-stream');
    try {
      const result = await fh.downloadFile({
        name: 'recording.mp4',
        mimetype: 'application/octet-stream',
        size: 9,
        url_private_download: srv.url,
      });
      expect(result.isVideo).toBe(true);
      expect(result.path).not.toBe('');
      await handler.cleanupTempFiles([result]);
    } finally {
      srv.close();
    }
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

  // Over the 50 MB cap, a video is metadata only (never fetched), with the reason.
  it('downloadFile returns metadata-only ProcessedFile for a video over the cap', async () => {
    const fh = handler as any;
    const file = {
      name: 'big-video.mp4',
      mimetype: 'video/mp4',
      size: 200_000_000,
      url_private_download: 'https://example.com/video',
    };
    const result = await fh.downloadFile(file);

    expect(result).not.toBeNull();
    expect(result.isVideo).toBe(true);
    expect(result.name).toBe('big-video.mp4');
    expect(result.size).toBe(200_000_000);
    expect(result.path).toBe('');
    expect(result.tempPath).toBeUndefined();
    expect(result.unavailable).toBe('too_large');
  });

  it('downloadFile returns metadata-only ProcessedFile for audio over the cap', async () => {
    const fh = handler as any;
    const file = {
      name: 'podcast.mp3',
      mimetype: 'audio/mpeg',
      size: 80_000_000,
      url_private_download: 'https://example.com/audio',
    };
    const result = await fh.downloadFile(file);

    expect(result).not.toBeNull();
    expect(result.isAudio).toBe(true);
    expect(result.name).toBe('podcast.mp3');
    expect(result.size).toBe(80_000_000);
    expect(result.path).toBe('');
    expect(result.unavailable).toBe('too_large');
  });
});

/** A one-shot local HTTP server returning `body` — downloads in tests never leave the machine. */
async function serveBytes(body: Buffer, contentType: string): Promise<{ url: string; close(): void }> {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': contentType });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/f`, close: () => server.close() };
}

/**
 * User media (SSOT 2026-10-25, goal gap): a video or a voice note the bot does
 * not transcribe is downloaded too (same 50 MB cap), so the dashboard keeps a
 * copy it can play. The model's prompt still never carries their path.
 */
describe('FileHandler — video and untranscribed audio are downloaded for the dashboard', () => {
  const handler = new FileHandler();

  it('downloads a video under the cap; the prompt names it without a path', async () => {
    const srv = await serveBytes(Buffer.from('ftypisom-video'), 'video/mp4');
    try {
      const result = await (handler as any).downloadFile({
        id: 'FV',
        name: 'repro.mp4',
        mimetype: 'video/mp4',
        size: 14,
        url_private_download: srv.url,
      });
      expect(result).toMatchObject({ name: 'repro.mp4', isVideo: true, slackFileId: 'FV' });
      expect(result.path).not.toBe('');
      expect(result.tempPath).toBe(result.path);
      const prompt = await handler.formatFilePrompt([result], '봐줘');
      expect(prompt).toContain('## Video: repro.mp4');
      expect(prompt).not.toContain(result.path);
      await handler.cleanupTempFiles([result]);
    } finally {
      srv.close();
    }
  });

  it('downloads a voice note even when it cannot be transcribed; the prompt carries no path', async () => {
    const srv = await serveBytes(Buffer.from('OggS-voice'), 'audio/ogg');
    try {
      const result = await (handler as any).downloadFile({
        id: 'FA',
        name: 'memo.ogg',
        mimetype: 'audio/ogg',
        size: 10,
        url_private_download: srv.url,
      });
      expect(result).toMatchObject({ name: 'memo.ogg', isAudio: true });
      expect(result.path).not.toBe('');
      const prompt = await handler.formatFilePrompt([result], '');
      expect(prompt).toContain('## Audio: memo.ogg');
      expect(prompt).not.toContain(result.path);
      await handler.cleanupTempFiles([result]);
    } finally {
      srv.close();
    }
  });
});

/**
 * User media (SSOT 2026-10-25) — every file the user attached stays in the
 * list, so the dashboard can show it with the instruction even when the bot
 * could not fetch it; the prompt says so instead of handing the model a path.
 */
describe('FileHandler — attachments the bot could not fetch are kept as metadata', () => {
  const handler = new FileHandler();

  it('a file over the download cap is kept, without a path, with the reason and its Slack ids', async () => {
    const result = await (handler as any).downloadFile({
      id: 'FBIG',
      name: 'huge.png',
      mimetype: 'image/png',
      size: 60 * 1024 * 1024,
      permalink: 'https://x.slack.com/files/U/FBIG/huge.png',
      url_private_download: 'https://example.com/huge',
    });
    expect(result).toMatchObject({
      name: 'huge.png',
      path: '',
      isImage: true,
      size: 60 * 1024 * 1024,
      unavailable: 'too_large',
      slackFileId: 'FBIG',
      permalink: 'https://x.slack.com/files/U/FBIG/huge.png',
    });
    expect(result.tempPath).toBeUndefined();
  });

  it('a failed download is kept as metadata with the reason', async () => {
    const result = await (handler as any).downloadFile({
      id: 'FERR',
      name: 'shot.png',
      mimetype: 'image/png',
      size: 10,
      url_private_download: 'http://127.0.0.1:9/never',
    });
    expect(result).toMatchObject({ name: 'shot.png', path: '', unavailable: 'download_failed', slackFileId: 'FERR' });
  });

  it('the prompt names an unavailable file without a path or a Read instruction', async () => {
    const out = await handler.formatFilePrompt(
      [
        {
          path: '',
          name: 'huge.png',
          mimetype: 'image/png',
          isImage: true,
          isText: false,
          isVideo: false,
          isAudio: false,
          size: 60 * 1024 * 1024,
          unavailable: 'too_large',
        },
      ],
      '봐줘',
    );
    expect(out).toContain('huge.png');
    expect(out).not.toMatch(/Path:/);
    expect(out).not.toContain('Use the Read tool');
    expect(out).toMatch(/could not be downloaded/i);
  });

  it('a Slack file name cannot steer the temp path out of the temp dir', async () => {
    const fh = handler as any;
    const original = globalThis.fetch;
    // node-fetch is the client; serve one PNG from a local server instead.
    const http = await import('node:http');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    try {
      const result = await fh.downloadFile({
        id: 'FX',
        name: '../../escape.png',
        mimetype: 'image/png',
        size: png.length,
        url_private_download: `http://127.0.0.1:${port}/f`,
      });
      const os = await import('node:os');
      const path = await import('node:path');
      expect(path.dirname(result.path)).toBe(os.tmpdir());
      expect(path.basename(result.path)).toMatch(/^slack-file-\d+-escape\.png$/);
      await handler.cleanupTempFiles([result]);
    } finally {
      globalThis.fetch = original;
      server.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { formatSingleMessage } from './message-formatter.js';

describe('formatSingleMessage', () => {
  describe('file handling', () => {
    it('exposes url_private_download and is_image for image files', () => {
      const msg = {
        ts: '1234567890.123456',
        user: 'U123',
        text: 'check this image',
        files: [{
          id: 'F001',
          name: 'screenshot.png',
          mimetype: 'image/png',
          size: 50000,
          url_private_download: 'https://files.slack.com/files-pri/T123/download/screenshot.png',
          thumb_360: 'https://files.slack.com/files-tmb/T123/screenshot_360.png',
        }],
      };

      const result = formatSingleMessage(msg);
      const file = result.files[0];

      expect(file.url_private_download).toBe(
        'https://files.slack.com/files-pri/T123/download/screenshot.png',
      );
      expect(file.is_image).toBe(true);
      expect(file.image_note).toBeDefined();
      expect(file.image_note).toContain('download');
      expect(file.image_note).toContain('Read tool');
      expect(file.thumb_360).toBe('https://files.slack.com/files-tmb/T123/screenshot_360.png');
    });

    it('does NOT expose url_private_download for audio files', () => {
      const msg = {
        ts: '1234567890.123456',
        user: 'U123',
        text: 'listen to this',
        files: [{
          id: 'F002',
          name: 'recording.mp3',
          mimetype: 'audio/mp3',
          size: 3000000,
          url_private_download: 'https://files.slack.com/files-pri/T123/download/recording.mp3',
        }],
      };

      const result = formatSingleMessage(msg);
      const file = result.files[0];

      expect(file.url_private_download).toBeUndefined();
      expect(file.is_media).toBe(true);
      expect(file.media_note).toBeDefined();
      expect(file.is_image).toBeUndefined();
    });

    it('does NOT expose url_private_download for video files', () => {
      const msg = {
        ts: '1234567890.123456',
        user: 'U123',
        text: 'watch this clip',
        files: [{
          id: 'F003',
          name: 'clip.mp4',
          mimetype: 'video/mp4',
          size: 10000000,
          url_private_download: 'https://files.slack.com/files-pri/T123/download/clip.mp4',
        }],
      };

      const result = formatSingleMessage(msg);
      const file = result.files[0];

      expect(file.url_private_download).toBeUndefined();
      expect(file.is_media).toBe(true);
      expect(file.is_image).toBeUndefined();
    });

    it('exposes url_private_download for regular files (PDF)', () => {
      const msg = {
        ts: '1234567890.123456',
        user: 'U123',
        text: 'here is the report',
        files: [{
          id: 'F004',
          name: 'report.pdf',
          mimetype: 'application/pdf',
          size: 200000,
          url_private_download: 'https://files.slack.com/files-pri/T123/download/report.pdf',
        }],
      };

      const result = formatSingleMessage(msg);
      const file = result.files[0];

      expect(file.url_private_download).toBe(
        'https://files.slack.com/files-pri/T123/download/report.pdf',
      );
      expect(file.is_image).toBeUndefined();
      expect(file.is_media).toBeUndefined();
    });

    it('does not expose url_private_download when image file lacks it', () => {
      const msg = {
        ts: '1234567890.123456',
        user: 'U123',
        text: 'external image',
        files: [{
          id: 'F005',
          name: 'photo.png',
          mimetype: 'image/png',
          size: 40000,
          // url_private_download is intentionally absent
        }],
      };

      const result = formatSingleMessage(msg);
      const file = result.files[0];

      expect(file.url_private_download).toBeUndefined();
      expect(file.is_image).toBe(true);
    });
  });
});

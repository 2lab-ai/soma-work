import { describe, expect, it } from 'vitest';
import { formatSingleMessage } from './message-formatter.js';

describe('formatSingleMessage', () => {
  describe('message fields', () => {
    it('formats a basic user message', () => {
      const msg = formatSingleMessage({
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
      const msg = formatSingleMessage({
        ts: '1700000001.000000',
        bot_id: 'B123',
        text: 'Bot reply',
      });

      expect(msg.user).toBe('B123');
      expect(msg.is_bot).toBe(true);
    });

    it('formats reactions', () => {
      const msg = formatSingleMessage({
        ts: '1700000003.000000',
        user: 'U123',
        text: 'With reactions',
        reactions: [
          { name: 'thumbsup', count: 3, users: ['U1', 'U2', 'U3'] },
          { name: 'eyes', count: 1, users: ['U4'] },
        ],
      });

      expect(msg.reactions).toEqual([
        { name: 'thumbsup', count: 3 },
        { name: 'eyes', count: 1 },
      ]);
    });

    it('uses display_name from user_profile when available', () => {
      const msg = formatSingleMessage({
        ts: '1700000004.000000',
        user: 'U123',
        user_profile: { display_name: 'John', real_name: 'John Doe' },
        text: 'Test',
      });

      expect(msg.user_name).toBe('John');
    });

    it('falls back to user ID for user_name when there is no profile', () => {
      const msg = formatSingleMessage({
        ts: '1700000005.000000',
        user: 'U123',
        text: 'Test',
      });

      expect(msg.user_name).toBe('U123');
    });
  });

  describe('file handling', () => {
    it('passes through id, name, mimetype and size', () => {
      const result = formatSingleMessage({
        ts: '1700000000.000000',
        user: 'U123',
        files: [
          {
            id: 'F_ROOT_IMG',
            name: 'header-screenshot.png',
            mimetype: 'image/png',
            size: 204800,
            url_private_download: 'https://files.slack.com/files-pri/T123/header-screenshot.png',
          },
        ],
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({
        id: 'F_ROOT_IMG',
        name: 'header-screenshot.png',
        mimetype: 'image/png',
        size: 204800,
      });
    });

    it('exposes url_private_download and is_image for image files', () => {
      const msg = {
        ts: '1234567890.123456',
        user: 'U123',
        text: 'check this image',
        files: [
          {
            id: 'F001',
            name: 'screenshot.png',
            mimetype: 'image/png',
            size: 50000,
            url_private_download: 'https://files.slack.com/files-pri/T123/download/screenshot.png',
            thumb_360: 'https://files.slack.com/files-tmb/T123/screenshot_360.png',
          },
        ],
      };

      const result = formatSingleMessage(msg);
      const file = result.files[0];

      expect(file.url_private_download).toBe('https://files.slack.com/files-pri/T123/download/screenshot.png');
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
        files: [
          {
            id: 'F002',
            name: 'recording.mp3',
            mimetype: 'audio/mp3',
            size: 3000000,
            url_private_download: 'https://files.slack.com/files-pri/T123/download/recording.mp3',
          },
        ],
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
        files: [
          {
            id: 'F003',
            name: 'clip.mp4',
            mimetype: 'video/mp4',
            size: 10000000,
            url_private_download: 'https://files.slack.com/files-pri/T123/download/clip.mp4',
          },
        ],
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
        files: [
          {
            id: 'F004',
            name: 'report.pdf',
            mimetype: 'application/pdf',
            size: 200000,
            url_private_download: 'https://files.slack.com/files-pri/T123/download/report.pdf',
          },
        ],
      };

      const result = formatSingleMessage(msg);
      const file = result.files[0];

      expect(file.url_private_download).toBe('https://files.slack.com/files-pri/T123/download/report.pdf');
      expect(file.is_image).toBeUndefined();
      expect(file.image_note).toBeUndefined();
      expect(file.is_media).toBeUndefined();
    });

    it('does NOT expose url_private_download for audio/mpeg and adds a media_note', () => {
      const result = formatSingleMessage({
        ts: '1700000011.000000',
        user: 'U123',
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

      const file = result.files[0];
      expect(file.url_private_download).toBeUndefined();
      expect(file.is_media).toBe(true);
      expect(file.media_note).toContain('do NOT download or Read');
    });

    it('adds a media_note for video/quicktime files', () => {
      const result = formatSingleMessage({
        ts: '1700000012.000000',
        user: 'U123',
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

      const file = result.files[0];
      expect(file.url_private_download).toBeUndefined();
      expect(file.is_media).toBe(true);
      expect(file.media_note).toContain('do NOT download or Read');
    });

    it('exposes url_private_download for text files', () => {
      const result = formatSingleMessage({
        ts: '1700000013.000000',
        user: 'U123',
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

      const file = result.files[0];
      expect(file.url_private_download).toBe('https://files.slack.com/files-pri/T123-F013/code.ts');
      expect(file.is_media).toBeUndefined();
      expect(file.is_image).toBeUndefined();
    });

    it('does not expose url_private_download when image file lacks it', () => {
      const msg = {
        ts: '1234567890.123456',
        user: 'U123',
        text: 'external image',
        files: [
          {
            id: 'F005',
            name: 'photo.png',
            mimetype: 'image/png',
            size: 40000,
            // url_private_download is intentionally absent
          },
        ],
      };

      const result = formatSingleMessage(msg);
      const file = result.files[0];

      expect(file.url_private_download).toBeUndefined();
      expect(file.is_image).toBe(true);
    });
  });
});

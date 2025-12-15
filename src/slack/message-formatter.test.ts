import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFormatter } from './message-formatter';

describe('MessageFormatter', () => {
  describe('formatMessage', () => {
    it('should preserve code blocks', () => {
      const input = '```javascript\nconst x = 1;\n```';
      const result = MessageFormatter.formatMessage(input, false);
      expect(result).toContain('```');
      expect(result).toContain('const x = 1');
    });

    it('should preserve inline code', () => {
      const input = 'Use `npm install` to install';
      const result = MessageFormatter.formatMessage(input, false);
      expect(result).toContain('`npm install`');
    });

    it('should convert **bold** to *bold*', () => {
      const input = 'This is **bold** text';
      const result = MessageFormatter.formatMessage(input, false);
      expect(result).toBe('This is *bold* text');
    });

    it('should convert __underline__ to _underline_', () => {
      const input = 'This is __italic__ text';
      const result = MessageFormatter.formatMessage(input, false);
      expect(result).toBe('This is _italic_ text');
    });
  });

  describe('formatTimeAgo', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should format "방금 전" for < 1 minute', () => {
      const date = new Date('2025-01-15T11:59:30Z');
      expect(MessageFormatter.formatTimeAgo(date)).toBe('방금 전');
    });

    it('should format minutes ago', () => {
      const date = new Date('2025-01-15T11:45:00Z');
      expect(MessageFormatter.formatTimeAgo(date)).toBe('15분 전');
    });

    it('should format hours and minutes ago', () => {
      const date = new Date('2025-01-15T09:30:00Z');
      expect(MessageFormatter.formatTimeAgo(date)).toBe('2시간 30분 전');
    });

    it('should format days and hours ago', () => {
      const date = new Date('2025-01-13T10:00:00Z');
      expect(MessageFormatter.formatTimeAgo(date)).toBe('2일 2시간 전');
    });
  });

  describe('formatExpiresIn', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return "만료됨" for expired sessions', () => {
      const date = new Date('2025-01-13T12:00:00Z'); // 2 days ago
      expect(MessageFormatter.formatExpiresIn(date)).toBe('만료됨');
    });

    it('should format hours and minutes remaining', () => {
      const date = new Date('2025-01-15T10:00:00Z'); // 2 hours ago, 22 hours left
      expect(MessageFormatter.formatExpiresIn(date)).toBe('22시간 0분 남음');
    });

    it('should format just minutes when < 1 hour remaining', () => {
      const date = new Date('2025-01-14T12:30:00Z'); // 23.5 hours ago, 30 min left
      expect(MessageFormatter.formatExpiresIn(date)).toBe('30분 남음');
    });

    it('should use custom timeout', () => {
      const date = new Date('2025-01-15T11:00:00Z');
      const oneHourTimeout = 60 * 60 * 1000;
      expect(MessageFormatter.formatExpiresIn(date, oneHourTimeout)).toBe('만료됨');
    });
  });

  describe('formatTimeRemaining', () => {
    it('should format hours and minutes', () => {
      const ms = 2 * 60 * 60 * 1000 + 30 * 60 * 1000; // 2h 30m
      expect(MessageFormatter.formatTimeRemaining(ms)).toBe('2시간 30분');
    });

    it('should format just minutes when < 1 hour', () => {
      const ms = 45 * 60 * 1000; // 45m
      expect(MessageFormatter.formatTimeRemaining(ms)).toBe('45분');
    });

    it('should handle zero hours', () => {
      const ms = 5 * 60 * 1000; // 5m
      expect(MessageFormatter.formatTimeRemaining(ms)).toBe('5분');
    });
  });

  describe('generateSessionTitle', () => {
    it('should clean up mentions', () => {
      const text = '<@U123ABC> Can you help me with this?';
      expect(MessageFormatter.generateSessionTitle(text)).toBe('Can you help me with this?');
    });

    it('should replace URLs with [link]', () => {
      const text = 'Check this <https://example.com|link> please';
      expect(MessageFormatter.generateSessionTitle(text)).toBe('Check this [link] please');
    });

    it('should replace raw URLs with [link]', () => {
      const text = 'Visit https://example.com/path for more';
      expect(MessageFormatter.generateSessionTitle(text)).toBe('Visit [link] for more');
    });

    it('should replace code blocks with [code]', () => {
      const text = 'Fix this ```const x = 1;``` error';
      expect(MessageFormatter.generateSessionTitle(text)).toBe('Fix this [code] error');
    });

    it('should replace inline code with [code]', () => {
      const text = 'The `useState` hook is broken';
      expect(MessageFormatter.generateSessionTitle(text)).toBe('The [code] hook is broken');
    });

    it('should clean up whitespace', () => {
      const text = 'Hello   world\n\ntest';
      expect(MessageFormatter.generateSessionTitle(text)).toBe('Hello world test');
    });

    it('should truncate long titles', () => {
      const text = 'A'.repeat(100);
      const result = MessageFormatter.generateSessionTitle(text);
      expect(result.length).toBeLessThanOrEqual(50);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should return default for empty/short text', () => {
      expect(MessageFormatter.generateSessionTitle('')).toBe('새 대화');
      expect(MessageFormatter.generateSessionTitle('a')).toBe('새 대화');
      expect(MessageFormatter.generateSessionTitle('ab')).toBe('새 대화');
    });

    it('should return default for special chars only', () => {
      expect(MessageFormatter.generateSessionTitle('[...]')).toBe('새 대화');
      expect(MessageFormatter.generateSessionTitle('....')).toBe('새 대화');
    });
  });
});

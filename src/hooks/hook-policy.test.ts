import { describe, expect, it } from 'vitest';
import { isExemptTool, shouldTrackTool } from './hook-policy';

describe('hook-policy', () => {
  describe('isExemptTool', () => {
    it('should exempt ToolSearch', () => {
      expect(isExemptTool('ToolSearch')).toBe(true);
    });

    it('should exempt TodoWrite', () => {
      expect(isExemptTool('TodoWrite')).toBe(true);
    });

    it('should not exempt Read', () => {
      expect(isExemptTool('Read')).toBe(false);
    });

    it('should not exempt Edit', () => {
      expect(isExemptTool('Edit')).toBe(false);
    });

    it('should not exempt Bash', () => {
      expect(isExemptTool('Bash')).toBe(false);
    });

    it('should not exempt Task', () => {
      expect(isExemptTool('Task')).toBe(false);
    });

    it('should not exempt empty string', () => {
      expect(isExemptTool('')).toBe(false);
    });
  });

  describe('shouldTrackTool', () => {
    it('should track Task', () => {
      expect(shouldTrackTool('Task')).toBe(true);
    });

    it('should track mcp__ prefixed tools', () => {
      expect(shouldTrackTool('mcp__anything')).toBe(true);
      expect(shouldTrackTool('mcp__plugin_oh-my-claude__some_tool')).toBe(true);
      expect(shouldTrackTool('mcp__slack-mcp__send_thread_message')).toBe(true);
    });

    it('should not track Read', () => {
      expect(shouldTrackTool('Read')).toBe(false);
    });

    it('should not track Edit', () => {
      expect(shouldTrackTool('Edit')).toBe(false);
    });

    it('should not track Bash', () => {
      expect(shouldTrackTool('Bash')).toBe(false);
    });

    it('should not track ToolSearch', () => {
      expect(shouldTrackTool('ToolSearch')).toBe(false);
    });

    it('should not track TodoWrite', () => {
      expect(shouldTrackTool('TodoWrite')).toBe(false);
    });

    it('should not track empty string', () => {
      expect(shouldTrackTool('')).toBe(false);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { ToolFormatter } from './tool-formatter';

describe('ToolFormatter', () => {
  describe('truncateString', () => {
    it('should return empty string for null or undefined', () => {
      expect(ToolFormatter.truncateString('', 10)).toBe('');
    });

    it('should not truncate strings shorter than maxLength', () => {
      expect(ToolFormatter.truncateString('hello', 10)).toBe('hello');
    });

    it('should truncate strings longer than maxLength and add ellipsis', () => {
      expect(ToolFormatter.truncateString('hello world', 5)).toBe('hello...');
    });

    it('should handle exact maxLength', () => {
      expect(ToolFormatter.truncateString('hello', 5)).toBe('hello');
    });
  });

  describe('formatEditTool', () => {
    it('should format Edit tool', () => {
      const input = {
        file_path: '/path/to/file.ts',
        old_string: 'old code',
        new_string: 'new code',
      };
      const result = ToolFormatter.formatEditTool('Edit', input);
      expect(result).toContain('Editing');
      expect(result).toContain('/path/to/file.ts');
      expect(result).toContain('- old code');
      expect(result).toContain('+ new code');
    });

    it('should format MultiEdit tool with multiple edits', () => {
      const input = {
        file_path: '/path/to/file.ts',
        edits: [
          { old_string: 'old1', new_string: 'new1' },
          { old_string: 'old2', new_string: 'new2' },
        ],
      };
      const result = ToolFormatter.formatEditTool('MultiEdit', input);
      expect(result).toContain('- old1');
      expect(result).toContain('+ new1');
      expect(result).toContain('- old2');
      expect(result).toContain('+ new2');
    });
  });

  describe('formatWriteTool', () => {
    it('should format Write tool', () => {
      const input = {
        file_path: '/path/to/new-file.ts',
        content: 'console.log("hello");',
      };
      const result = ToolFormatter.formatWriteTool(input);
      expect(result).toContain('Creating');
      expect(result).toContain('/path/to/new-file.ts');
      expect(result).toContain('console.log');
    });

    it('should truncate long content', () => {
      const input = {
        file_path: '/path/to/file.ts',
        content: 'x'.repeat(500),
      };
      const result = ToolFormatter.formatWriteTool(input);
      expect(result).toContain('...');
    });
  });

  describe('formatReadTool', () => {
    it('should format Read tool', () => {
      const input = { file_path: '/path/to/file.ts' };
      const result = ToolFormatter.formatReadTool(input);
      expect(result).toContain('Reading');
      expect(result).toContain('/path/to/file.ts');
    });
  });

  describe('formatBashTool', () => {
    it('should format Bash tool', () => {
      const input = { command: 'npm install' };
      const result = ToolFormatter.formatBashTool(input);
      expect(result).toContain('Running command');
      expect(result).toContain('npm install');
      expect(result).toContain('```bash');
    });
  });

  describe('formatMcpInput', () => {
    it('should return empty string for null input', () => {
      expect(ToolFormatter.formatMcpInput(null)).toBe('');
    });

    it('should return empty string for non-object input', () => {
      expect(ToolFormatter.formatMcpInput('string')).toBe('');
    });

    it('should format simple string values', () => {
      const input = { query: 'test query' };
      const result = ToolFormatter.formatMcpInput(input);
      expect(result).toContain('*query:*');
      expect(result).toContain('test query');
    });

    it('should format multiline strings with code block', () => {
      const input = { content: 'line1\nline2\nline3' };
      const result = ToolFormatter.formatMcpInput(input);
      expect(result).toContain('```');
    });

    it('should format object values as JSON', () => {
      const input = { config: { key: 'value' } };
      const result = ToolFormatter.formatMcpInput(input);
      expect(result).toContain('```json');
    });

    it('should skip null and undefined values', () => {
      const input = { key: 'value', nullKey: null, undefinedKey: undefined };
      const result = ToolFormatter.formatMcpInput(input);
      expect(result).not.toContain('nullKey');
      expect(result).not.toContain('undefinedKey');
    });
  });

  describe('formatMcpTool', () => {
    it('should parse MCP tool name correctly', () => {
      const result = ToolFormatter.formatMcpTool('mcp__jira__searchJiraIssuesUsingJql', {});
      expect(result).toContain('jira');
      expect(result).toContain('searchJiraIssuesUsingJql');
    });

    it('should handle nested tool names', () => {
      const result = ToolFormatter.formatMcpTool('mcp__server__tool__subtool', {});
      expect(result).toContain('server');
      expect(result).toContain('tool__subtool');
    });

    it('should include formatted input parameters', () => {
      const result = ToolFormatter.formatMcpTool('mcp__test__search', { query: 'test' });
      expect(result).toContain('query');
      expect(result).toContain('test');
    });
  });

  describe('formatGenericTool', () => {
    it('should format MCP tools specially', () => {
      const result = ToolFormatter.formatGenericTool('mcp__server__tool', {});
      expect(result).toContain('MCP');
      expect(result).toContain('server');
    });

    it('should format regular tools generically', () => {
      const result = ToolFormatter.formatGenericTool('CustomTool', {});
      expect(result).toContain('Using CustomTool');
    });
  });

  describe('formatToolUse', () => {
    it('should format text parts', () => {
      const content = [{ type: 'text', text: 'Hello world' }];
      const result = ToolFormatter.formatToolUse(content);
      expect(result).toBe('Hello world');
    });

    it('should format Edit tool_use', () => {
      const content = [{
        type: 'tool_use',
        name: 'Edit',
        input: { file_path: '/test.ts', old_string: 'old', new_string: 'new' },
      }];
      const result = ToolFormatter.formatToolUse(content);
      expect(result).toContain('Editing');
      expect(result).toContain('/test.ts');
    });

    it('should return empty string for TodoWrite', () => {
      const content = [{
        type: 'tool_use',
        name: 'TodoWrite',
        input: { todos: [] },
      }];
      const result = ToolFormatter.formatToolUse(content);
      expect(result).toBe('');
    });

    it('should return empty string for permission-prompt', () => {
      const content = [{
        type: 'tool_use',
        name: 'mcp__permission-prompt__permission_prompt',
        input: {},
      }];
      const result = ToolFormatter.formatToolUse(content);
      expect(result).toBe('');
    });
  });

  describe('extractToolResults', () => {
    it('should return empty array for non-array input', () => {
      expect(ToolFormatter.extractToolResults('not an array' as any)).toEqual([]);
    });

    it('should extract tool_result parts', () => {
      const content = [
        { type: 'tool_result', tool_use_id: 'id1', content: 'result1' },
        { type: 'text', text: 'some text' },
        { type: 'tool_result', tool_use_id: 'id2', content: 'result2', is_error: true },
      ];
      const results = ToolFormatter.extractToolResults(content);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ toolUseId: 'id1', result: 'result1', isError: undefined, toolName: undefined });
      expect(results[1]).toEqual({ toolUseId: 'id2', result: 'result2', isError: true, toolName: undefined });
    });
  });

  describe('formatBuiltInToolResult', () => {
    it('should return null for no toolName', () => {
      expect(ToolFormatter.formatBuiltInToolResult({ toolUseId: 'id', result: 'test' })).toBe(null);
    });

    it('should return null for TodoWrite', () => {
      expect(ToolFormatter.formatBuiltInToolResult({ toolName: 'TodoWrite', toolUseId: 'id', result: 'test' })).toBe(null);
    });

    it('should return null for Glob', () => {
      expect(ToolFormatter.formatBuiltInToolResult({ toolName: 'Glob', toolUseId: 'id', result: 'test' })).toBe(null);
    });

    it('should return null for Grep', () => {
      expect(ToolFormatter.formatBuiltInToolResult({ toolName: 'Grep', toolUseId: 'id', result: 'test' })).toBe(null);
    });

    it('should format successful result', () => {
      const result = ToolFormatter.formatBuiltInToolResult({
        toolName: 'Bash',
        toolUseId: 'id',
        result: 'command output',
      });
      expect(result).toContain('✅');
      expect(result).toContain('Bash');
      expect(result).toContain('command output');
    });

    it('should format error result', () => {
      const result = ToolFormatter.formatBuiltInToolResult({
        toolName: 'Bash',
        toolUseId: 'id',
        result: 'error message',
        isError: true,
      });
      expect(result).toContain('❌');
    });

    it('should return null for empty result', () => {
      expect(ToolFormatter.formatBuiltInToolResult({
        toolName: 'Bash',
        toolUseId: 'id',
        result: null,
      })).toBe(null);
    });

    it('should truncate Read results more aggressively', () => {
      const longResult = 'x'.repeat(1000);
      const bashResult = ToolFormatter.formatBuiltInToolResult({
        toolName: 'Bash',
        toolUseId: 'id',
        result: longResult,
      });
      const readResult = ToolFormatter.formatBuiltInToolResult({
        toolName: 'Read',
        toolUseId: 'id',
        result: longResult,
      });
      // Both should truncate, but Read should truncate more
      expect(bashResult).not.toContain('...');
      expect(readResult).toContain('...');
    });
  });

  describe('formatMcpToolResult', () => {
    it('should parse MCP tool name and format result', () => {
      const result = ToolFormatter.formatMcpToolResult({
        toolName: 'mcp__jira__search',
        toolUseId: 'id',
        result: 'search results',
      });
      expect(result).toContain('jira');
      expect(result).toContain('search');
      expect(result).toContain('search results');
    });

    it('should include duration when provided', () => {
      const result = ToolFormatter.formatMcpToolResult({
        toolName: 'mcp__server__tool',
        toolUseId: 'id',
        result: 'result',
      }, 5000);
      expect(result).toContain('5.0');
    });

    it('should format array results', () => {
      const result = ToolFormatter.formatMcpToolResult({
        toolName: 'mcp__server__tool',
        toolUseId: 'id',
        result: [{ type: 'text', text: 'text content' }],
      });
      expect(result).toContain('text content');
    });

    it('should handle image type in results', () => {
      const result = ToolFormatter.formatMcpToolResult({
        toolName: 'mcp__server__tool',
        toolUseId: 'id',
        result: [{ type: 'image', data: 'base64...' }],
      });
      expect(result).toContain('Image data');
    });
  });

  describe('formatToolResult', () => {
    it('should return null for permission-prompt tool', () => {
      expect(ToolFormatter.formatToolResult({
        toolName: 'mcp__permission-prompt__permission_prompt',
        toolUseId: 'id',
        result: 'result',
      })).toBe(null);
    });

    it('should format MCP tools with formatMcpToolResult', () => {
      const result = ToolFormatter.formatToolResult({
        toolName: 'mcp__server__tool',
        toolUseId: 'id',
        result: 'result',
      });
      expect(result).toContain('MCP Result');
    });

    it('should format built-in tools with formatBuiltInToolResult', () => {
      const result = ToolFormatter.formatToolResult({
        toolName: 'Bash',
        toolUseId: 'id',
        result: 'output',
      });
      expect(result).toContain('Bash');
      expect(result).not.toContain('MCP Result');
    });
  });
});

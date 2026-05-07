import { describe, expect, it } from 'vitest';
import { ToolFormatter } from '../tool-formatter';

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

    it('should format Task with task-specific details', () => {
      const result = ToolFormatter.formatGenericTool('Task', {
        subagent_type: 'oh-my-claude:explore',
        run_in_background: true,
        prompt: 'Find code related to routing panel update',
      });

      expect(result).toContain('Using Subagent');
      expect(result).toContain('Explorer');
      expect(result).toContain('model: *opus*');
      expect(result).toContain('prompt:');
      expect(result).toContain('prompt_length:');
    });

    it('should keep Task fallback when input details are missing', () => {
      const result = ToolFormatter.formatGenericTool('Task', {});
      expect(result).toContain('Using Subagent');
      expect(result).toContain('*Task*');
    });

    it('should format regular tools generically', () => {
      const result = ToolFormatter.formatGenericTool('CustomTool', {});
      expect(result).toContain('Using CustomTool');
    });
  });

  describe('buildToolUseLogSummary', () => {
    it('should summarize generic tool input keys', () => {
      const result = ToolFormatter.buildToolUseLogSummary('tool_1', 'Read', {
        file_path: '/tmp/test.ts',
        encoding: 'utf-8',
      });

      expect(result).toEqual({
        toolUseId: 'tool_1',
        toolName: 'Read',
        inputKeys: ['encoding', 'file_path'],
        inputKeyCount: 2,
      });
    });

    it('should include task metadata for Task tool', () => {
      const result = ToolFormatter.buildToolUseLogSummary('tool_2', 'Task', {
        subagent_type: 'oh-my-claude:oracle',
        run_in_background: false,
        prompt: 'Review architecture and identify risks',
      });

      expect(result.toolUseId).toBe('tool_2');
      expect(result.toolName).toBe('Task');
      expect(result.inputKeys).toEqual(['prompt', 'run_in_background', 'subagent_type']);
      expect(result.task).toEqual({
        subagentType: 'oh-my-claude:oracle',
        subagentLabel: 'Oracle',
        model: 'opus',
        runInBackground: false,
        promptLength: 38,
        promptPreview: 'Review architecture and identify risks',
      });
    });

    it('should truncate long Task prompt preview in log summary', () => {
      const longPrompt = `analyze ${'x'.repeat(300)}`;
      const result = ToolFormatter.buildToolUseLogSummary('tool_3', 'Task', {
        prompt: longPrompt,
      });

      expect(result.task?.promptLength).toBe(longPrompt.length);
      expect(result.task?.promptPreview).toContain('...');
      expect(result.task?.promptPreview?.length).toBeLessThanOrEqual(183);
    });

    it('should prefer explicit input model over default subagent model', () => {
      const result = ToolFormatter.buildToolUseLogSummary('tool_4', 'Task', {
        subagent_type: 'oh-my-claude:explore',
        model: 'haiku',
      });

      expect(result.task?.model).toBe('haiku');
      expect(result.task?.subagentLabel).toBe('Explorer');
    });
  });

  describe('formatToolUse', () => {
    it('should format text parts', () => {
      const content = [{ type: 'text', text: 'Hello world' }];
      const result = ToolFormatter.formatToolUse(content);
      expect(result).toBe('Hello world');
    });

    it('should format Edit tool_use', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: '/test.ts', old_string: 'old', new_string: 'new' },
        },
      ];
      const result = ToolFormatter.formatToolUse(content);
      expect(result).toContain('Editing');
      expect(result).toContain('/test.ts');
    });

    it('should return empty string for TodoWrite', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'TodoWrite',
          input: { todos: [] },
        },
      ];
      const result = ToolFormatter.formatToolUse(content);
      expect(result).toBe('');
    });

    it('should return empty string for permission-prompt', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'mcp__permission-prompt__permission_prompt',
          input: {},
        },
      ];
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
      expect(ToolFormatter.formatBuiltInToolResult({ toolName: 'TodoWrite', toolUseId: 'id', result: 'test' })).toBe(
        null,
      );
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
      expect(result).toContain('🟢');
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
      expect(result).toContain('🔴');
    });

    it('should return null for empty result', () => {
      expect(
        ToolFormatter.formatBuiltInToolResult({
          toolName: 'Bash',
          toolUseId: 'id',
          result: null,
        }),
      ).toBe(null);
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
      const result = ToolFormatter.formatMcpToolResult(
        {
          toolName: 'mcp__server__tool',
          toolUseId: 'id',
          result: 'result',
        },
        5000,
      );
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
      expect(
        ToolFormatter.formatToolResult({
          toolName: 'mcp__permission-prompt__permission_prompt',
          toolUseId: 'id',
          result: 'result',
        }),
      ).toBe(null);
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

  describe('formatCompactParams', () => {
    it('should return empty string for null/undefined/non-object', () => {
      expect(ToolFormatter.formatCompactParams(null)).toBe('');
      expect(ToolFormatter.formatCompactParams(undefined)).toBe('');
      expect(ToolFormatter.formatCompactParams('string')).toBe('');
      expect(ToolFormatter.formatCompactParams([])).toBe('');
    });

    it('should return empty string for empty object', () => {
      expect(ToolFormatter.formatCompactParams({})).toBe('');
    });

    it('should format single short param', () => {
      const result = ToolFormatter.formatCompactParams({ model: 'opus' });
      expect(result).toBe('(model: opus)');
    });

    it('should format up to 2 params', () => {
      const result = ToolFormatter.formatCompactParams({ model: 'opus', query: 'test' });
      expect(result).toContain('model: opus');
      expect(result).toContain('query: test');
      expect(result).toMatch(/^\(.*\)$/);
    });

    it('should not exceed 3 params', () => {
      const result = ToolFormatter.formatCompactParams({ a: '1', b: '2', c: '3' });
      const commas = (result.match(/,/g) || []).length;
      expect(commas).toBeLessThanOrEqual(1); // max 2 params = 1 comma
    });

    it('should skip object/array values', () => {
      const result = ToolFormatter.formatCompactParams({ config: { nested: true }, name: 'test' });
      expect(result).toBe('(name: test)');
    });

    it('should skip keys starting with _', () => {
      const result = ToolFormatter.formatCompactParams({ _internal: 'hidden', visible: 'yes' });
      expect(result).toBe('(visible: yes)');
    });

    it('should truncate long values within budget', () => {
      const result = ToolFormatter.formatCompactParams(
        { prompt: 'This is a very long prompt that should be truncated to fit within the budget' },
        40,
      );
      expect(result.length).toBeLessThanOrEqual(40);
      expect(result).toContain('prompt:');
      expect(result).toContain('…');
    });

    it('should handle number and boolean values', () => {
      const result = ToolFormatter.formatCompactParams({ count: 42, verbose: true });
      expect(result).toContain('count: 42');
      expect(result).toContain('verbose: true');
    });
  });

  describe('formatToolUseCompact', () => {
    it('should use ⏳ for MCP tools', () => {
      const content = [
        {
          type: 'tool_use',
          id: 'id1',
          name: 'mcp__llm__chat',
          input: { model: 'opus' },
        },
      ];
      const result = ToolFormatter.formatToolUseCompact(content);
      expect(result).toContain('⏳');
      expect(result).toContain('MCP: llm → chat');
      expect(result).toContain('model: opus');
    });

    it('should use ⏳ for Task tools', () => {
      const content = [
        {
          type: 'tool_use',
          id: 'id1',
          name: 'Task',
          input: { subagent_type: 'Explore', prompt: 'find code' },
        },
      ];
      const result = ToolFormatter.formatToolUseCompact(content);
      expect(result).toContain('⏳');
    });

    it('should use ⚪ for sync tools', () => {
      const content = [
        {
          type: 'tool_use',
          id: 'id1',
          name: 'Read',
          input: { file_path: '/tmp/test.ts' },
        },
      ];
      const result = ToolFormatter.formatToolUseCompact(content);
      expect(result).toContain('⚪');
    });

    it('should skip TodoWrite and permission-prompt', () => {
      const content = [
        { type: 'tool_use', id: 'id1', name: 'TodoWrite', input: {} },
        { type: 'tool_use', id: 'id2', name: 'mcp__permission-prompt__permission_prompt', input: {} },
        { type: 'tool_use', id: 'id3', name: 'Read', input: { file_path: '/test.ts' } },
      ];
      const result = ToolFormatter.formatToolUseCompact(content);
      expect(result).not.toContain('TodoWrite');
      expect(result).not.toContain('permission_prompt');
      expect(result).toContain('Read');
    });
  });

  describe('formatOneLineToolUse — MCP params', () => {
    it('should include params for MCP tools', () => {
      const result = ToolFormatter.formatOneLineToolUse('mcp__llm__chat', { model: 'opus', prompt: 'hello world' });
      expect(result).toContain('MCP: llm → chat');
      expect(result).toContain('model: opus');
    });

    it('should include params for generic tools', () => {
      const result = ToolFormatter.formatOneLineToolUse('WebSearch', { query: 'React hooks' });
      expect(result).toContain('WebSearch');
      expect(result).toContain('query: React hooks');
    });

    it('should not double-show params for tools with explicit formatting', () => {
      const result = ToolFormatter.formatOneLineToolUse('Bash', { command: 'npm test' });
      // Bash shows command directly, no formatCompactParams
      expect(result).toContain('npm test');
      expect(result).not.toContain('command:');
    });
  });

  describe('formatOneLineToolComplete', () => {
    it('should show 🟢 for success without duration', () => {
      const result = ToolFormatter.formatOneLineToolComplete('Read', { file_path: '/test.ts' }, false);
      expect(result).toContain('🟢');
      expect(result).toContain('Read');
      expect(result).not.toContain('—');
    });

    it('should show 🔴 for error', () => {
      const result = ToolFormatter.formatOneLineToolComplete('Bash', { command: 'exit 1' }, true);
      expect(result).toContain('🔴');
    });

    it('should include duration when provided', () => {
      const result = ToolFormatter.formatOneLineToolComplete('mcp__llm__chat', { model: 'opus' }, false, 5000);
      expect(result).toContain('🟢');
      expect(result).toContain('MCP: llm → chat');
      expect(result).toContain('— 5.0s');
    });

    it('should skip duration when null', () => {
      const result = ToolFormatter.formatOneLineToolComplete('Read', { file_path: '/test.ts' }, false, null);
      expect(result).not.toContain('—');
    });
  });

  /**
   * Issue #688 — background Bash labels across detail/compact/verbose
   * render paths. Foreground Bash output MUST remain unchanged so the
   * regression set in this file still holds.
   */
  describe('Background Bash labels (issue #688)', () => {
    describe('isBackgroundBash', () => {
      it('returns true only for run_in_background=true plus string command', () => {
        expect(ToolFormatter.isBackgroundBash({ command: 'sleep 5', run_in_background: true })).toBe(true);
      });
      it('returns false for foreground Bash', () => {
        expect(ToolFormatter.isBackgroundBash({ command: 'ls' })).toBe(false);
        expect(ToolFormatter.isBackgroundBash({ command: 'ls', run_in_background: false })).toBe(false);
      });
      it('returns false for non-object / missing command', () => {
        expect(ToolFormatter.isBackgroundBash(null)).toBe(false);
        expect(ToolFormatter.isBackgroundBash(undefined)).toBe(false);
        expect(ToolFormatter.isBackgroundBash({ run_in_background: true })).toBe(false);
        expect(ToolFormatter.isBackgroundBash('sleep 5')).toBe(false);
      });
    });

    describe('detail path: formatBashTool', () => {
      it('foreground: unchanged "Running command" label (regression)', () => {
        const result = ToolFormatter.formatBashTool({ command: 'ls' });
        expect(result).toContain('Running command');
        expect(result).not.toContain('Running in background');
      });
      it('background: "Running in background" label + bash code block', () => {
        const result = ToolFormatter.formatBashTool({ command: 'sleep 10', run_in_background: true });
        expect(result).toContain('Running in background');
        expect(result).toContain('sleep 10');
        expect(result).toContain('```bash');
      });
      it('background with shell_id: renders shell_id metadata', () => {
        const result = ToolFormatter.formatBashTool({
          command: 'sleep 10',
          run_in_background: true,
          shell_id: 'sh_42',
        });
        expect(result).toContain('Running in background');
        expect(result).toContain('sh_42');
      });
    });

    describe('compact path: formatOneLineToolUse', () => {
      it('foreground: unchanged "Bash `cmd`" label (regression)', () => {
        const result = ToolFormatter.formatOneLineToolUse('Bash', { command: 'npm test' });
        expect(result).toContain('Bash');
        expect(result).toContain('npm test');
        expect(result).not.toContain('Running in background');
      });
      it('background: "Running in background: `cmd`" label', () => {
        const result = ToolFormatter.formatOneLineToolUse('Bash', {
          command: 'sleep 60',
          run_in_background: true,
        });
        expect(result).toContain('Running in background');
        expect(result).toContain('sleep 60');
      });
    });

    describe('verbose path: formatToolUseVerbose', () => {
      it('foreground: unchanged "Running command" label (regression)', () => {
        const result = ToolFormatter.formatToolUseVerbose([
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ]);
        expect(result).toContain('Running command');
        expect(result).not.toContain('Running in background');
      });
      it('background: "Running in background" + run_in_background flag dump', () => {
        const result = ToolFormatter.formatToolUseVerbose([
          { type: 'tool_use', name: 'Bash', input: { command: 'sleep 5', run_in_background: true } },
        ]);
        expect(result).toContain('Running in background');
        expect(result).toContain('run_in_background');
        expect(result).toContain('sleep 5');
      });
    });
  });

  /**
   * Issue #794 — `TaskToolSummary.runInBackground` is now a required
   * boolean field (default false on every return path). Consumers
   * (`startSubagentTracking`, `buildToolUseLogSummary`, formatter)
   * branch on `summary.runInBackground` directly without an
   * `=== true` guard, so an undefined return would regress every
   * caller silently.
   */
  describe('getTaskToolSummary.runInBackground (issue #794)', () => {
    it('returns runInBackground:true when input flags it explicitly', () => {
      const summary = ToolFormatter.getTaskToolSummary({
        subagent_type: 'general-purpose',
        prompt: 'long task',
        run_in_background: true,
      });
      expect(summary.runInBackground).toBe(true);
    });

    it('returns runInBackground:false by default when flag is omitted', () => {
      const summary = ToolFormatter.getTaskToolSummary({
        subagent_type: 'general-purpose',
        prompt: 'fast task',
      });
      expect(summary.runInBackground).toBe(false);
    });

    it('returns runInBackground:false when flag is explicitly false', () => {
      const summary = ToolFormatter.getTaskToolSummary({
        subagent_type: 'general-purpose',
        prompt: 'fast task',
        run_in_background: false,
      });
      expect(summary.runInBackground).toBe(false);
    });

    it('returns runInBackground:false (not undefined) for invalid/empty input', () => {
      // Field must be present even when input is unparseable, so callers
      // can read it without an undefined check.
      expect(ToolFormatter.getTaskToolSummary(null).runInBackground).toBe(false);
      expect(ToolFormatter.getTaskToolSummary(undefined).runInBackground).toBe(false);
      expect(ToolFormatter.getTaskToolSummary({}).runInBackground).toBe(false);
      expect(ToolFormatter.getTaskToolSummary([] as unknown).runInBackground).toBe(false);
    });

    it('treats non-boolean run_in_background as false (string/number ignored)', () => {
      // Defense: SDK shouldn't send these but we don't want to coerce
      // truthy strings to true and silently change tracking behavior.
      expect(
        ToolFormatter.getTaskToolSummary({
          subagent_type: 'general-purpose',
          prompt: 'x',
          run_in_background: 'true' as unknown as boolean,
        }).runInBackground,
      ).toBe(false);
      expect(
        ToolFormatter.getTaskToolSummary({
          subagent_type: 'general-purpose',
          prompt: 'x',
          run_in_background: 1 as unknown as boolean,
        }).runInBackground,
      ).toBe(false);
    });
  });
});

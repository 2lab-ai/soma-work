import { describe, it, expect } from 'vitest';
import { mapToolUses, mapToolResults } from './event-mapper';

describe('mapToolUses', () => {
  it('maps a simple Read tool', () => {
    const events = mapToolUses([
      { id: 'tu1', name: 'Read', input: { file_path: '/foo/bar.ts' } },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_start',
      toolUseId: 'tu1',
      toolName: 'Read',
      category: 'read',
      displayLabel: 'Read',
    });
    expect(events[0].groupId).toBeUndefined();
  });

  it('maps Edit to write category', () => {
    const events = mapToolUses([
      { id: 'tu2', name: 'Edit', input: { file_path: '/x.ts' } },
    ]);

    expect(events[0].category).toBe('write');
  });

  it('maps Bash to execute category', () => {
    const events = mapToolUses([
      { id: 'tu3', name: 'Bash', input: { command: 'ls' } },
    ]);

    expect(events[0].category).toBe('execute');
  });

  it('parses MCP tool name into server/tool parts', () => {
    const events = mapToolUses([
      { id: 'tu4', name: 'mcp__github__search_repos', input: { query: 'test' } },
    ]);

    expect(events[0]).toMatchObject({
      category: 'mcp',
      displayLabel: 'github → search_repos',
      serverName: 'github',
      serverToolName: 'search_repos',
    });
  });

  it('handles MCP tool with double underscores in tool name', () => {
    const events = mapToolUses([
      { id: 'tu5', name: 'mcp__server__ns__method', input: {} },
    ]);

    expect(events[0]).toMatchObject({
      serverName: 'server',
      serverToolName: 'ns__method',
      displayLabel: 'server → ns__method',
    });
  });

  it('detects subagent Task tool', () => {
    const events = mapToolUses([
      {
        id: 'tu6',
        name: 'Task',
        input: { subagent_type: 'oh-my-claude:explore', prompt: 'find X' },
      },
    ]);

    expect(events[0]).toMatchObject({
      category: 'subagent',
      subagentType: 'oh-my-claude:explore',
      subagentLabel: 'Explorer',
    });
  });

  it('assigns groupId when multiple trackable tools in batch', () => {
    const events = mapToolUses([
      { id: 'tu7a', name: 'mcp__gh__list', input: {} },
      { id: 'tu7b', name: 'Task', input: { subagent_type: 'general-purpose', prompt: 'do stuff' } },
      { id: 'tu7c', name: 'Read', input: { file_path: '/a.ts' } },
    ]);

    // MCP and Task should share a groupId
    expect(events[0].groupId).toBeDefined();
    expect(events[1].groupId).toBe(events[0].groupId);
    // Read (non-trackable) should NOT have groupId
    expect(events[2].groupId).toBeUndefined();
  });

  it('does not assign groupId for single trackable tool', () => {
    const events = mapToolUses([
      { id: 'tu8', name: 'mcp__jira__get_issue', input: {} },
      { id: 'tu9', name: 'Read', input: { file_path: '/b.ts' } },
    ]);

    expect(events[0].groupId).toBeUndefined();
    expect(events[1].groupId).toBeUndefined();
  });

  it('maps unknown tool to "other" category', () => {
    const events = mapToolUses([
      { id: 'tu10', name: 'SomeNewTool', input: {} },
    ]);

    expect(events[0].category).toBe('other');
    expect(events[0].displayLabel).toBe('SomeNewTool');
  });

  it('maps WebSearch to search category', () => {
    const events = mapToolUses([
      { id: 'tu11', name: 'WebSearch', input: { query: 'test' } },
    ]);

    expect(events[0].category).toBe('search');
  });
});

describe('mapToolResults', () => {
  it('maps a successful tool result', () => {
    const events = mapToolResults([
      { toolUseId: 'tu1', toolName: 'Read', result: 'file contents here' },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_complete',
      toolUseId: 'tu1',
      toolName: 'Read',
      category: 'read',
      isError: false,
    });
    expect(events[0].resultPreview).toBe('file contents here');
  });

  it('maps an error result', () => {
    const events = mapToolResults([
      { toolUseId: 'tu2', toolName: 'Bash', result: 'command not found', isError: true },
    ]);

    expect(events[0]).toMatchObject({
      isError: true,
      category: 'execute',
      resultPreview: 'command not found',
    });
  });

  it('truncates long result previews', () => {
    const longResult = 'x'.repeat(500);
    const events = mapToolResults([
      { toolUseId: 'tu3', toolName: 'Read', result: longResult },
    ]);

    expect(events[0].resultPreview!.length).toBeLessThanOrEqual(203); // 200 + '...'
  });

  it('uses toolNameLookup when toolName is missing', () => {
    const events = mapToolResults(
      [{ toolUseId: 'tu4', result: 'ok' }],
      (id) => id === 'tu4' ? 'Edit' : undefined
    );

    expect(events[0]).toMatchObject({
      toolName: 'Edit',
      category: 'write',
    });
  });

  it('defaults to unknown when toolName not found', () => {
    const events = mapToolResults([
      { toolUseId: 'tu5', result: 'data' },
    ]);

    expect(events[0]).toMatchObject({
      toolName: 'unknown',
      category: 'other',
    });
  });

  it('handles null/undefined result', () => {
    const events = mapToolResults([
      { toolUseId: 'tu6', toolName: 'Bash', result: null },
    ]);

    expect(events[0].resultPreview).toBeUndefined();
  });

  it('serializes object results as JSON preview', () => {
    const events = mapToolResults([
      { toolUseId: 'tu7', toolName: 'mcp__api__query', result: { count: 42, items: ['a', 'b'] } },
    ]);

    expect(events[0].resultPreview).toContain('"count":42');
  });
});

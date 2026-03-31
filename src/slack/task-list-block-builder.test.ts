import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Todo, TodoManager } from '../todo-manager';
import { TaskListBlockBuilder } from './task-list-block-builder';

describe('TaskListBlockBuilder', () => {
  let todoManager: TodoManager;
  let builder: TaskListBlockBuilder;

  beforeEach(() => {
    todoManager = new TodoManager();
    builder = new TaskListBlockBuilder(todoManager);
  });

  it('returns empty array for no todos', () => {
    expect(builder.buildBlocks([])).toEqual([]);
    expect(builder.buildBlocks(undefined as any)).toEqual([]);
  });

  it('builds blocks with correct structure for mixed status todos', () => {
    const todos: Todo[] = [
      { id: '1', content: 'GitHub issue 생성', status: 'completed', priority: 'high' },
      {
        id: '2',
        content: 'types.ts 수정',
        status: 'in_progress',
        priority: 'medium',
        activeForm: 'llm_chat(codex) 진행중',
      },
      { id: '3', content: '테스트 추가', status: 'pending', priority: 'low' },
    ];

    const blocks = builder.buildBlocks(todos);

    // Should have: divider, title+progress, task items, footer
    expect(blocks.length).toBeGreaterThanOrEqual(3);

    // First block is divider
    expect(blocks[0].type).toBe('divider');

    // Find the section with task items
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('⚫'));
    expect(taskSection).toBeDefined();
    const text = taskSection.text.text;

    // Completed task: ⚫ + strikethrough
    expect(text).toContain('⚫');
    expect(text).toContain('~GitHub issue 생성~');

    // In-progress task: 🟢 + bold number + arrow (flows from completed)
    expect(text).toContain('🟢');
    expect(text).toContain('types.ts 수정');

    // Active form shown as sub-status (underscores escaped to ˍ)
    expect(text).toContain('llmˍchat(codex) 진행중');

    // Pending task: ⚪
    expect(text).toContain('⚪');
    expect(text).toContain('테스트 추가');
  });

  it('shows blocked status with dependency labels', () => {
    const todos: Todo[] = [
      { id: '1', content: 'PR 리뷰', status: 'pending', priority: 'medium' },
      { id: '2', content: 'codex 병렬 리뷰', status: 'pending', priority: 'low', dependencies: ['1'] },
    ];

    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('🔒'));
    expect(taskSection).toBeDefined();
    expect(taskSection.text.text).toContain('deps:#1');
  });

  it('renders progress bar correctly', () => {
    const todos: Todo[] = [
      { id: '1', content: 'task1', status: 'completed', priority: 'medium' },
      { id: '2', content: 'task2', status: 'completed', priority: 'medium' },
      { id: '3', content: 'task3', status: 'pending', priority: 'medium' },
      { id: '4', content: 'task4', status: 'pending', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos);
    // 2/4 = 50%
    const titleSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('Task List'));
    expect(titleSection).toBeDefined();
    expect(titleSection.text.text).toContain('50%');
    expect(titleSection.text.text).toContain('2/4');
  });

  it('shows 100% completion with checkmark', () => {
    const todos: Todo[] = [
      { id: '1', content: 'done1', status: 'completed', priority: 'medium' },
      { id: '2', content: 'done2', status: 'completed', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos);
    const titleSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('Task List'));
    expect(titleSection.text.text).toContain('100%');
    expect(titleSection.text.text).toContain(':white_check_mark:');

    // Footer should show "All X tasks completed"
    const footer = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('All'));
    expect(footer).toBeDefined();
    expect(footer.elements[0].text).toContain('All 2 tasks completed');
  });

  it('includes time context when startedAt is provided', () => {
    const todos: Todo[] = [{ id: '1', content: 'task1', status: 'in_progress', priority: 'medium' }];

    const blocks = builder.buildBlocks(todos, {
      startedAt: new Date('2025-01-01T12:01:00').getTime(),
    });

    const timeCtx = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Start:'));
    expect(timeCtx).toBeDefined();
    // Now uses Slack date tokens
    expect(timeCtx.elements[0].text).toContain('<!date^');
  });

  it('does not show time context when startedAt is not provided', () => {
    const todos: Todo[] = [{ id: '1', content: 'task1', status: 'pending', priority: 'medium' }];

    const blocks = builder.buildBlocks(todos);
    const timeCtx = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Start:'));
    expect(timeCtx).toBeUndefined();
  });
});

describe('TodoManager dependency methods', () => {
  let manager: TodoManager;

  beforeEach(() => {
    manager = new TodoManager();
  });

  it('isBlocked returns true when deps are incomplete', () => {
    const todos: Todo[] = [
      { id: '1', content: 'first', status: 'pending', priority: 'medium' },
      { id: '2', content: 'second', status: 'pending', priority: 'medium', dependencies: ['1'] },
    ];
    expect(manager.isBlocked(todos[1], todos)).toBe(true);
  });

  it('isBlocked returns false when all deps are completed', () => {
    const todos: Todo[] = [
      { id: '1', content: 'first', status: 'completed', priority: 'medium' },
      { id: '2', content: 'second', status: 'pending', priority: 'medium', dependencies: ['1'] },
    ];
    expect(manager.isBlocked(todos[1], todos)).toBe(false);
  });

  it('isBlocked returns false when no deps', () => {
    const todos: Todo[] = [{ id: '1', content: 'first', status: 'pending', priority: 'medium' }];
    expect(manager.isBlocked(todos[0], todos)).toBe(false);
  });

  it('isBlocked returns true for dangling/missing dependency ref', () => {
    const todos: Todo[] = [
      { id: '1', content: 'task', status: 'pending', priority: 'medium', dependencies: ['nonexistent'] },
    ];
    expect(manager.isBlocked(todos[0], todos)).toBe(true);
  });

  it('getEffectiveStatus returns blocked for pending with incomplete deps', () => {
    const todos: Todo[] = [
      { id: '1', content: 'first', status: 'in_progress', priority: 'medium' },
      { id: '2', content: 'second', status: 'pending', priority: 'medium', dependencies: ['1'] },
    ];
    expect(manager.getEffectiveStatus(todos[1], todos)).toBe('blocked');
  });

  it('getEffectiveStatus returns pending for pending without deps', () => {
    const todos: Todo[] = [{ id: '1', content: 'first', status: 'pending', priority: 'medium' }];
    expect(manager.getEffectiveStatus(todos[0], todos)).toBe('pending');
  });
});

describe('TaskListBlockBuilder.flowsFromDeps (arrow logic)', () => {
  let todoManager: TodoManager;
  let builder: TaskListBlockBuilder;

  beforeEach(() => {
    todoManager = new TodoManager();
    builder = new TaskListBlockBuilder(todoManager);
  });

  it('shows arrow for in_progress task when explicit deps are all completed', () => {
    const todos: Todo[] = [
      { id: '1', content: 'setup', status: 'completed', priority: 'medium' },
      { id: '2', content: 'build', status: 'in_progress', priority: 'medium', dependencies: ['1'] },
    ];
    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('🟢'));
    expect(taskSection).toBeDefined();
    // Arrow prefix '→' should appear before the in-progress task
    expect(taskSection.text.text).toContain('→');
  });

  it('shows arrow for in_progress task when previous task is completed (implicit sequential)', () => {
    const todos: Todo[] = [
      { id: '1', content: 'first', status: 'completed', priority: 'medium' },
      { id: '2', content: 'second', status: 'in_progress', priority: 'medium' },
    ];
    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('🟢'));
    expect(taskSection.text.text).toContain('→');
  });

  it('does not show arrow for first in_progress task with no deps', () => {
    const todos: Todo[] = [{ id: '1', content: 'only task', status: 'in_progress', priority: 'medium' }];
    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('🟢'));
    expect(taskSection.text.text).not.toContain('→');
  });

  it('does not show arrow when explicit deps are not all completed', () => {
    const todos: Todo[] = [
      { id: '1', content: 'dep1', status: 'completed', priority: 'medium' },
      { id: '2', content: 'dep2', status: 'in_progress', priority: 'medium' },
      { id: '3', content: 'blocked', status: 'in_progress', priority: 'medium', dependencies: ['1', '2'] },
    ];
    const blocks = builder.buildBlocks(todos);
    const taskText =
      blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('blocked'))?.text?.text || '';
    // Task 3 line should NOT have arrow since dep '2' is not completed
    const task3Line = taskText.split('\n').find((l: string) => l.includes('blocked'));
    expect(task3Line).not.toContain('→');
  });
});

describe('TodoManager.hasSignificantChange', () => {
  let manager: TodoManager;

  beforeEach(() => {
    manager = new TodoManager();
  });

  it('detects activeForm change', () => {
    const old: Todo[] = [
      { id: '1', content: 'task', status: 'in_progress', priority: 'medium', activeForm: 'Running tests' },
    ];
    const updated: Todo[] = [
      { id: '1', content: 'task', status: 'in_progress', priority: 'medium', activeForm: 'Deploying' },
    ];
    expect(manager.hasSignificantChange(old, updated)).toBe(true);
  });

  it('detects content change', () => {
    const old: Todo[] = [{ id: '1', content: 'old content', status: 'pending', priority: 'medium' }];
    const updated: Todo[] = [{ id: '1', content: 'new content', status: 'pending', priority: 'medium' }];
    expect(manager.hasSignificantChange(old, updated)).toBe(true);
  });

  it('returns false when nothing changed', () => {
    const old: Todo[] = [
      { id: '1', content: 'task', status: 'in_progress', priority: 'medium', activeForm: 'Running' },
    ];
    const same: Todo[] = [
      { id: '1', content: 'task', status: 'in_progress', priority: 'medium', activeForm: 'Running' },
    ];
    expect(manager.hasSignificantChange(old, same)).toBe(false);
  });

  it('detects dependency change', () => {
    const old: Todo[] = [{ id: '1', content: 'task', status: 'pending', priority: 'medium', dependencies: ['a'] }];
    const updated: Todo[] = [
      { id: '1', content: 'task', status: 'pending', priority: 'medium', dependencies: ['a', 'b'] },
    ];
    expect(manager.hasSignificantChange(old, updated)).toBe(true);
  });

  it('detects dependency removal', () => {
    const old: Todo[] = [{ id: '1', content: 'task', status: 'pending', priority: 'medium', dependencies: ['a'] }];
    const updated: Todo[] = [{ id: '1', content: 'task', status: 'pending', priority: 'medium' }];
    expect(manager.hasSignificantChange(old, updated)).toBe(true);
  });
});

describe('mrkdwn escaping in task content', () => {
  let todoManager: TodoManager;
  let builder: TaskListBlockBuilder;

  beforeEach(() => {
    todoManager = new TodoManager();
    builder = new TaskListBlockBuilder(todoManager);
  });

  it('escapes mrkdwn formatting characters in content', () => {
    const todos: Todo[] = [
      { id: '1', content: 'Fix *bold* and _italic_ and ~strike~', status: 'in_progress', priority: 'medium' },
    ];
    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('🟢'));
    const text = taskSection.text.text;
    // Should NOT contain raw mrkdwn chars
    expect(text).not.toContain('*bold*');
    expect(text).not.toContain('_italic_');
    expect(text).not.toContain('~strike~');
  });

  it('escapes angle brackets and ampersands to prevent mention/link injection', () => {
    const todos: Todo[] = [
      {
        id: '1',
        content: 'Check <!channel> and <@U123> and <http://evil.com|click>',
        status: 'pending',
        priority: 'medium',
      },
    ];
    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('⚪'));
    const text = taskSection.text.text;
    // Angle brackets should be escaped
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U123>');
    expect(text).not.toContain('<http://');
    expect(text).toContain('&lt;');
  });

  it('flattens newlines in content to prevent layout break', () => {
    const todos: Todo[] = [{ id: '1', content: 'line1\nline2\nline3', status: 'pending', priority: 'medium' }];
    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('⚪'));
    // The task content line should not contain raw newlines from content
    const taskLine = taskSection.text.text.split('\n').find((l: string) => l.includes('line1'));
    expect(taskLine).toContain('line1 line2 line3');
  });
});

describe('Slack date token in time display', () => {
  let todoManager: TodoManager;
  let builder: TaskListBlockBuilder;

  beforeEach(() => {
    todoManager = new TodoManager();
    builder = new TaskListBlockBuilder(todoManager);
  });

  it('uses Slack date token format for startedAt', () => {
    const todos: Todo[] = [{ id: '1', content: 'task', status: 'in_progress', priority: 'medium' }];
    const ts = new Date('2025-06-15T14:30:00Z').getTime();
    const blocks = builder.buildBlocks(todos, { startedAt: ts });
    const timeCtx = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Start:'));
    expect(timeCtx).toBeDefined();
    // Should contain Slack date token format <!date^epoch^{time}|fallback>
    expect(timeCtx.elements[0].text).toContain('<!date^');
    expect(timeCtx.elements[0].text).toContain('^{time}|');
  });
});

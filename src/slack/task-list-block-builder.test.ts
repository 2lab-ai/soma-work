import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskListBlockBuilder } from './task-list-block-builder';
import { TodoManager, Todo } from '../todo-manager';

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
      { id: '2', content: 'types.ts 수정', status: 'in_progress', priority: 'medium', activeForm: 'llm_chat(codex) 진행중' },
      { id: '3', content: '테스트 추가', status: 'pending', priority: 'low' },
    ];

    const blocks = builder.buildBlocks(todos);

    // Should have: divider, title+progress, task items, footer
    expect(blocks.length).toBeGreaterThanOrEqual(3);

    // First block is divider
    expect(blocks[0].type).toBe('divider');

    // Find the section with task items
    const taskSection = blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('⚫')
    );
    expect(taskSection).toBeDefined();
    const text = taskSection.text.text;

    // Completed task: ⚫ + strikethrough
    expect(text).toContain('⚫');
    expect(text).toContain('~GitHub issue 생성~');

    // In-progress task: 🟢 + bold number + arrow (flows from completed)
    expect(text).toContain('🟢');
    expect(text).toContain('types.ts 수정');

    // Active form shown as sub-status
    expect(text).toContain('llm_chat(codex) 진행중');

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
    const taskSection = blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('🔒')
    );
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
    const titleSection = blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('Task List')
    );
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
    const titleSection = blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('Task List')
    );
    expect(titleSection.text.text).toContain('100%');
    expect(titleSection.text.text).toContain(':white_check_mark:');

    // Footer should show "All X tasks completed"
    const footer = blocks.find(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('All')
    );
    expect(footer).toBeDefined();
    expect(footer.elements[0].text).toContain('All 2 tasks completed');
  });

  it('includes time context when startedAt is provided', () => {
    const todos: Todo[] = [
      { id: '1', content: 'task1', status: 'in_progress', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos, {
      startedAt: new Date('2025-01-01T12:01:00').getTime(),
      estimatedEndAt: new Date('2025-01-01T13:17:00').getTime(),
    });

    const timeCtx = blocks.find(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Start:')
    );
    expect(timeCtx).toBeDefined();
    expect(timeCtx.elements[0].text).toContain('12:01');
    expect(timeCtx.elements[0].text).toContain('13:17');
  });

  it('does not show time context when startedAt is not provided', () => {
    const todos: Todo[] = [
      { id: '1', content: 'task1', status: 'pending', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos);
    const timeCtx = blocks.find(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Start:')
    );
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
    const todos: Todo[] = [
      { id: '1', content: 'first', status: 'pending', priority: 'medium' },
    ];
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
    const todos: Todo[] = [
      { id: '1', content: 'first', status: 'pending', priority: 'medium' },
    ];
    expect(manager.getEffectiveStatus(todos[0], todos)).toBe('pending');
  });

  it('flowsFromCompleted returns true for in_progress after completed', () => {
    const todos: Todo[] = [
      { id: '1', content: 'done', status: 'completed', priority: 'medium' },
      { id: '2', content: 'active', status: 'in_progress', priority: 'medium' },
    ];
    expect(manager.flowsFromCompleted(todos[1], 1, todos)).toBe(true);
  });

  it('flowsFromCompleted returns false for first item', () => {
    const todos: Todo[] = [
      { id: '1', content: 'first', status: 'in_progress', priority: 'medium' },
    ];
    expect(manager.flowsFromCompleted(todos[0], 0, todos)).toBe(false);
  });
});

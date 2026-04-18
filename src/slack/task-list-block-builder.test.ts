import { beforeEach, describe, expect, it } from 'vitest';
import { type Todo, TodoManager } from '../todo-manager';
import { TaskListBlockBuilder } from './task-list-block-builder';

// ═══════════════════════════════════════════════════════════
// CHECKLIST MODE (default theme)
// ═══════════════════════════════════════════════════════════

describe('TaskListBlockBuilder — Checklist mode (default)', () => {
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

    // First block is divider
    expect(blocks[0].type).toBe('divider');

    // Title section with "Task List" and "done"
    const titleSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('Task List'));
    expect(titleSection).toBeDefined();
    expect(titleSection.text.text).toContain('1/3 done');
    expect(titleSection.text.text).toContain('33%');

    // Task section with new icons
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('\u2713'));
    expect(taskSection).toBeDefined();
    const text = taskSection.text.text;

    // Completed: ✓ + strikethrough
    expect(text).toContain('\u2713');
    expect(text).toContain('~#1 GitHub issue 생성~');

    // In-progress: 🟢 + bold
    expect(text).toContain('🟢');
    expect(text).toContain('types.ts 수정');

    // Pending: ○
    expect(text).toContain('\u25CB');
    expect(text).toContain('테스트 추가');
  });

  it('shows blocked status with "blocked by" label', () => {
    const todos: Todo[] = [
      { id: '1', content: 'PR 리뷰', status: 'pending', priority: 'medium' },
      { id: '2', content: 'codex 병렬 리뷰', status: 'pending', priority: 'low', dependencies: ['1'] },
    ];

    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes(':lock:'));
    expect(taskSection).toBeDefined();
    expect(taskSection.text.text).toContain('blocked by #1');
  });

  it('shows text progress (not CLI bar)', () => {
    const todos: Todo[] = [
      { id: '1', content: 'task1', status: 'completed', priority: 'medium' },
      { id: '2', content: 'task2', status: 'completed', priority: 'medium' },
      { id: '3', content: 'task3', status: 'pending', priority: 'medium' },
      { id: '4', content: 'task4', status: 'pending', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos);
    const titleSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('Task List'));
    expect(titleSection).toBeDefined();
    expect(titleSection.text.text).toContain('2/4 done');
    expect(titleSection.text.text).toContain('50%');
    // Should NOT contain CLI progress bar
    expect(titleSection.text.text).not.toContain('█');
    expect(titleSection.text.text).not.toContain('░');
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

    const footer = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('All'));
    expect(footer).toBeDefined();
    expect(footer.elements[0].text).toContain('All 2 tasks completed');
  });

  it('detects completion by count, not rounded percent (P2 fix)', () => {
    // 199/200 → Math.round(99.5%) = 100% but NOT all done
    const todos: Todo[] = Array.from({ length: 200 }, (_, i) => ({
      id: String(i + 1),
      content: `task${i + 1}`,
      status: i < 199 ? 'completed' : 'pending',
      priority: 'medium',
    })) as Todo[];

    const blocks = builder.buildBlocks(todos);
    // Should NOT show "All tasks completed" because 1 task is still pending
    const footer = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('All'));
    expect(footer).toBeUndefined();
  });

  it('footer shows sub-status and start time (not clock emoji)', () => {
    const todos: Todo[] = [
      { id: '1', content: 'task1', status: 'in_progress', priority: 'medium', activeForm: 'Running tests' },
    ];

    const blocks = builder.buildBlocks(todos, {
      startedAt: new Date('2025-01-01T12:01:00').getTime(),
    });

    const footer = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Started'));
    expect(footer).toBeDefined();
    expect(footer.elements[0].text).toContain('▸');
    expect(footer.elements[0].text).toContain('Running tests');
    expect(footer.elements[0].text).toContain('Started');
    // Should NOT use clock emoji
    expect(footer.elements[0].text).not.toContain(':clock1:');
  });

  it('uses #N numbering for task references', () => {
    const todos: Todo[] = [
      { id: '1', content: 'first', status: 'completed', priority: 'medium' },
      { id: '2', content: 'second', status: 'pending', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('#1'));
    expect(taskSection).toBeDefined();
    expect(taskSection.text.text).toContain('#1');
    expect(taskSection.text.text).toContain('#2');
  });
});

// ═══════════════════════════════════════════════════════════
// QUEUE MODE (compact theme)
// ═══════════════════════════════════════════════════════════

describe('TaskListBlockBuilder — Queue mode (compact)', () => {
  let todoManager: TodoManager;
  let builder: TaskListBlockBuilder;

  beforeEach(() => {
    todoManager = new TodoManager();
    builder = new TaskListBlockBuilder(todoManager);
  });

  it('groups tasks by state: Now / Up Next / Blocked', () => {
    const todos: Todo[] = [
      { id: '1', content: 'GitHub issue 생성', status: 'completed', priority: 'high' },
      { id: '2', content: 'RED 테스트 추가', status: 'completed', priority: 'medium' },
      { id: '3', content: '구현 (TaskListBlockBuilder)', status: 'in_progress', priority: 'medium' },
      { id: '4', content: 'PR 올리기 + CI 통과', status: 'pending', priority: 'medium' },
      { id: '5', content: 'Codex/Gemini 리뷰 반영', status: 'pending', priority: 'low', dependencies: ['4'] },
    ];

    const blocks = builder.buildBlocks(todos, { theme: 'compact' });

    // Title says "Queue"
    const titleSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('Queue'));
    expect(titleSection).toBeDefined();
    expect(titleSection.text.text).toContain('2/5 done');

    // Group section
    const groupSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('Now'));
    expect(groupSection).toBeDefined();
    const groupText = groupSection.text.text;

    // Now group
    expect(groupText).toContain('🟢 *Now*');
    expect(groupText).toContain('구현');

    // Up Next group
    expect(groupText).toContain('▸ *Up Next*');
    expect(groupText).toContain('PR 올리기');

    // Blocked group
    expect(groupText).toContain(':lock: *Blocked*');
    expect(groupText).toContain('리뷰 반영');
    expect(groupText).toContain('waiting for #4');

    // Uses ∙ prefix markers
    expect(groupText).toContain('∙');

    // Completed tasks should NOT appear in queue
    expect(groupText).not.toContain('issue 생성');
    expect(groupText).not.toContain('테스트 추가');
  });

  it('completed state shows minimal footer', () => {
    const todos: Todo[] = [
      { id: '1', content: 'done1', status: 'completed', priority: 'medium' },
      { id: '2', content: 'done2', status: 'completed', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos, {
      theme: 'compact',
      startedAt: Date.now() - 42 * 60_000,
      completedAt: Date.now(),
    });

    const footer = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('completed'));
    expect(footer).toBeDefined();
    expect(footer.elements[0].text).toContain('All tasks completed');
  });

  it('footer shows done count and active sub-status', () => {
    const todos: Todo[] = [
      { id: '1', content: 'done', status: 'completed', priority: 'medium' },
      { id: '2', content: 'working', status: 'in_progress', priority: 'medium', activeForm: 'llm_chat(codex)' },
      { id: '3', content: 'next', status: 'pending', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos, { theme: 'compact', startedAt: Date.now() });

    const footer = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('done'));
    expect(footer).toBeDefined();
    const footerText = footer.elements[0].text;
    expect(footerText).toContain('✓ 1 done');
    expect(footerText).toContain('llmˍchat(codex)');
  });
});

// ═══════════════════════════════════════════════════════════
// PULSE MODE (minimal theme)
// ═══════════════════════════════════════════════════════════

describe('TaskListBlockBuilder — Pulse mode (minimal)', () => {
  let todoManager: TodoManager;
  let builder: TaskListBlockBuilder;

  beforeEach(() => {
    todoManager = new TodoManager();
    builder = new TaskListBlockBuilder(todoManager);
  });

  it('in-progress shows single section with progress/task/blocked', () => {
    const todos: Todo[] = [
      { id: '1', content: 'done1', status: 'completed', priority: 'medium' },
      { id: '2', content: 'done2', status: 'completed', priority: 'medium' },
      { id: '3', content: '구현', status: 'in_progress', priority: 'medium', activeForm: 'llm_chat(codex)' },
      { id: '4', content: 'PR 올리기', status: 'pending', priority: 'medium' },
      { id: '5', content: '리뷰', status: 'pending', priority: 'low', dependencies: ['4'] },
    ];

    const blocks = builder.buildBlocks(todos, { theme: 'minimal' });

    // Should be divider + section only (2 blocks)
    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe('divider');
    expect(blocks[1].type).toBe('section');

    const text = blocks[1].text.text;
    // Progress count
    expect(text).toContain('2/5');
    // Active task name
    expect(text).toContain('구현');
    // Sub-status
    expect(text).toContain('llmˍchat(codex)');
    // Blocked count
    expect(text).toContain(':lock: 1 blocked');
  });

  it('completed shows single context line', () => {
    const todos: Todo[] = [
      { id: '1', content: 'done1', status: 'completed', priority: 'medium' },
      { id: '2', content: 'done2', status: 'completed', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos, {
      theme: 'minimal',
      startedAt: Date.now() - 42 * 60_000,
      completedAt: Date.now(),
    });

    // Should be divider + context only (2 blocks)
    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe('divider');
    expect(blocks[1].type).toBe('context');

    const text = blocks[1].elements[0].text;
    expect(text).toContain('Done');
    expect(text).toContain('2/2');
    expect(text).toContain(':white_check_mark:');
    expect(text).toContain('42m');
  });

  it('no blocked count shown when none blocked', () => {
    const todos: Todo[] = [
      { id: '1', content: 'working', status: 'in_progress', priority: 'medium' },
      { id: '2', content: 'next', status: 'pending', priority: 'medium' },
    ];

    const blocks = builder.buildBlocks(todos, { theme: 'minimal' });
    const text = blocks[1].text.text;
    expect(text).not.toContain('blocked');
  });
});

// ═══════════════════════════════════════════════════════════
// CROSS-MODE TESTS
// ═══════════════════════════════════════════════════════════

describe('TaskListBlockBuilder — Cross-mode', () => {
  let todoManager: TodoManager;
  let builder: TaskListBlockBuilder;

  beforeEach(() => {
    todoManager = new TodoManager();
    builder = new TaskListBlockBuilder(todoManager);
  });

  it('defaults to checklist when no theme specified', () => {
    const todos: Todo[] = [{ id: '1', content: 'task', status: 'pending', priority: 'medium' }];
    const blocks = builder.buildBlocks(todos);
    const title = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('Task List'));
    expect(title).toBeDefined();
  });

  it('maps SessionTheme to rendering mode', () => {
    const todos: Todo[] = [{ id: '1', content: 'task', status: 'pending', priority: 'medium' }];
    // default → checklist
    const defaultBlocks = builder.buildBlocks(todos, { theme: 'default' });
    expect(defaultBlocks.find((b: any) => b.text?.text?.includes('Task List'))).toBeDefined();

    // compact → queue
    const compactBlocks = builder.buildBlocks(todos, { theme: 'compact' });
    expect(compactBlocks.find((b: any) => b.text?.text?.includes('Queue'))).toBeDefined();

    // minimal → pulse
    const minimalBlocks = builder.buildBlocks(todos, { theme: 'minimal' });
    expect(minimalBlocks.find((b: any) => b.text?.text?.includes(':clipboard:'))).toBeDefined();
  });

  it('all modes return empty for empty todos', () => {
    for (const theme of ['default', 'compact', 'minimal'] as const) {
      expect(builder.buildBlocks([], { theme })).toEqual([]);
    }
  });

  it('all modes start with divider', () => {
    const todos: Todo[] = [{ id: '1', content: 'task', status: 'pending', priority: 'medium' }];
    for (const theme of ['default', 'compact', 'minimal'] as const) {
      const blocks = builder.buildBlocks(todos, { theme });
      expect(blocks[0].type).toBe('divider');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// SHARED BEHAVIOR TESTS
// ═══════════════════════════════════════════════════════════

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
    expect(text).not.toContain('*bold*');
    expect(text).not.toContain('_italic_');
    expect(text).not.toContain('~strike~');
  });

  it('escapes angle brackets and ampersands', () => {
    const todos: Todo[] = [{ id: '1', content: 'Check <!channel> and <@U123>', status: 'pending', priority: 'medium' }];
    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('\u25CB'));
    const text = taskSection.text.text;
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U123>');
    expect(text).toContain('&lt;');
  });

  it('escapes unresolved dependency IDs (P2 fix)', () => {
    const todos: Todo[] = [
      { id: '1', content: 'task', status: 'pending', priority: 'medium', dependencies: ['<@U123>'] },
    ];
    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes(':lock:'));
    const text = taskSection.text.text;
    expect(text).not.toContain('<@U123>');
    expect(text).toContain('&lt;');
  });

  it('flattens newlines in content', () => {
    const todos: Todo[] = [{ id: '1', content: 'line1\nline2\nline3', status: 'pending', priority: 'medium' }];
    const blocks = builder.buildBlocks(todos);
    const taskSection = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('\u25CB'));
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

  it('uses Slack date token format for startedAt in checklist footer', () => {
    const todos: Todo[] = [
      { id: '1', content: 'task', status: 'in_progress', priority: 'medium', activeForm: 'working' },
    ];
    const ts = new Date('2025-06-15T14:30:00Z').getTime();
    const blocks = builder.buildBlocks(todos, { startedAt: ts });
    const footer = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Started'));
    expect(footer).toBeDefined();
    expect(footer.elements[0].text).toContain('<!date^');
    expect(footer.elements[0].text).toContain('^{time}|');
  });
});

// ═══════════════════════════════════════════════════════════
// PHASE 2 — buildPlanTasks (plan/task_card blocks + fallback)
// ═══════════════════════════════════════════════════════════

describe('TaskListBlockBuilder.buildPlanTasks (P2 plan/task_card)', () => {
  it('returns empty blocks and text for empty todo list', () => {
    const result = TaskListBlockBuilder.buildPlanTasks([]);
    expect(result.blocks).toEqual([]);
    expect(result.text).toBe('');
  });

  it('returns empty blocks and text for undefined todos', () => {
    const result = TaskListBlockBuilder.buildPlanTasks(undefined as any);
    expect(result.blocks).toEqual([]);
    expect(result.text).toBe('');
  });

  it('maps status 4-way: completed→✅, in_progress→⏳, pending→⬜, blocked→🚧 in top-level text', () => {
    const todos: Todo[] = [
      { id: '1', content: 'done', status: 'completed', priority: 'high' },
      { id: '2', content: 'running', status: 'in_progress', priority: 'high' },
      { id: '3', content: 'waiting', status: 'pending', priority: 'medium' },
      // blocked is derived: pending with an incomplete dep
      { id: '4', content: 'waiting on 2', status: 'pending', priority: 'low', dependencies: ['2'] },
    ];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);

    expect(result.text).toContain('✅ done');
    expect(result.text).toContain('⏳ running');
    expect(result.text).toContain('⬜ waiting');
    expect(result.text).toContain('🚧 waiting on 2');
  });

  it('renders a plan block with task_card entries using Slack schema statuses', () => {
    const todos: Todo[] = [
      { id: '1', content: 'done', status: 'completed', priority: 'high' },
      { id: '2', content: 'running', status: 'in_progress', priority: 'high', activeForm: 'Running now' },
      { id: '3', content: 'waiting', status: 'pending', priority: 'medium' },
    ];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);

    const planBlock = result.blocks.find((b: any) => b.type === 'plan');
    expect(planBlock).toBeDefined();
    expect(Array.isArray(planBlock.tasks)).toBe(true);
    expect(planBlock.tasks.length).toBe(3);

    // Slack task_card schema uses 'complete' (not 'completed')
    const statuses = planBlock.tasks.map((tc: any) => tc.status);
    expect(statuses).toEqual(['complete', 'in_progress', 'pending']);

    // Every task_card has type, task_id, title
    for (const tc of planBlock.tasks) {
      expect(tc.type).toBe('task_card');
      expect(typeof tc.task_id).toBe('string');
      expect(typeof tc.title).toBe('string');
    }
  });

  it('maps blocked (pending + incomplete deps) to task_card pending (Slack has no blocked state)', () => {
    const todos: Todo[] = [
      { id: '1', content: 'dep', status: 'in_progress', priority: 'high' },
      { id: '2', content: 'blocked task', status: 'pending', priority: 'low', dependencies: ['1'] },
    ];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);
    const planBlock = result.blocks.find((b: any) => b.type === 'plan');
    const blockedCard = planBlock.tasks.find((tc: any) => tc.title.includes('blocked task'));
    // Slack task_card schema has no 'blocked' — P2 falls back to 'pending'.
    expect(blockedCard.status).toBe('pending');
    // Top-level text still shows the 🚧 prefix so operators can tell at a glance.
    expect(result.text).toContain('🚧 blocked task');
  });

  it('includes a classic mrkdwn section fallback block for old clients', () => {
    const todos: Todo[] = [
      { id: '1', content: 'done', status: 'completed', priority: 'high' },
      { id: '2', content: 'running', status: 'in_progress', priority: 'high' },
    ];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);

    const sectionFallback = result.blocks.find((b: any) => b.type === 'section' && b.text?.type === 'mrkdwn');
    expect(sectionFallback).toBeDefined();
    // Fallback contains both tasks in plain mrkdwn
    expect(sectionFallback.text.text).toContain('done');
    expect(sectionFallback.text.text).toContain('running');
  });

  it('plan block precedes section fallback (old clients still render section even if plan is skipped)', () => {
    const todos: Todo[] = [{ id: '1', content: 't', status: 'completed', priority: 'high' }];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);
    const planIdx = result.blocks.findIndex((b: any) => b.type === 'plan');
    const sectionIdx = result.blocks.findIndex((b: any) => b.type === 'section' && b.text?.type === 'mrkdwn');
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(sectionIdx).toBeGreaterThan(planIdx);
  });

  it('escapes user-supplied mrkdwn control characters in fallback text to prevent injection', () => {
    const todos: Todo[] = [
      { id: '1', content: 'evil *bold* _italic_ `code` <@U123>', status: 'pending', priority: 'high' },
    ];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);
    const sectionFallback = result.blocks.find((b: any) => b.type === 'section' && b.text?.type === 'mrkdwn');
    expect(sectionFallback.text.text).not.toContain('*bold*');
    expect(sectionFallback.text.text).not.toContain('_italic_');
    expect(sectionFallback.text.text).not.toContain('<@U123>');
    // Top-level text is plain — raw user text is allowed there (Slack shows it verbatim).
    expect(result.text).toContain('evil');
  });

  it('top-level text uses newline per todo (one line per task)', () => {
    const todos: Todo[] = [
      { id: '1', content: 'a', status: 'completed', priority: 'high' },
      { id: '2', content: 'b', status: 'pending', priority: 'high' },
    ];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);
    expect(result.text.split('\n').length).toBe(2);
  });

  it('assigns a unique task_id per task_card in the plan block (prevents Slack rejection on duplicates)', () => {
    const todos: Todo[] = [
      { id: '1', content: 'a', status: 'pending', priority: 'high' },
      { id: '2', content: 'b', status: 'pending', priority: 'high' },
      { id: '3', content: 'c', status: 'pending', priority: 'high' },
    ];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);
    const planBlock = result.blocks.find((b: any) => b.type === 'plan');
    const ids = planBlock.tasks.map((tc: any) => tc.task_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

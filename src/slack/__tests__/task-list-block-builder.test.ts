import { beforeEach, describe, expect, it } from 'vitest';
import { type Todo, TodoManager } from '../../todo-manager';
import { TaskListBlockBuilder } from '../task-list-block-builder';

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

  it('neutralises mentions, entities, strike-through and newlines in the fallback text', () => {
    const todos: Todo[] = [
      { id: '1', content: 'Check <!channel> & ~strike~\nline2', status: 'pending', priority: 'medium' },
    ];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);
    const fallback = result.blocks.find((b: any) => b.type === 'section' && b.text?.type === 'mrkdwn').text.text;
    expect(fallback).not.toContain('<!channel>');
    expect(fallback).toContain('&lt;!channel&gt; &amp;');
    expect(fallback).not.toContain('~strike~');
    // One task = one fallback line: the content's newline is flattened.
    expect(fallback.split('\n')).toHaveLength(1);
    expect(fallback).toContain('line2');
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

  // #1005 — The plan block requires a top-level `title`, and Slack demands it
  // be a BARE STRING: `must provide a string [json-pointer:/blocks/0/title]`.
  //
  // History (corrected): the title was first OMITTED (`missing required field:
  // title [json-pointer:/blocks/0]`); a 2026-04-23 "fix" added it as a
  // plain_text COMPOSITION OBJECT, which merely swapped one rejection for
  // another — Slack kept dropping every B2 plan post (~525 chat.postMessage
  // failures/rotation, 44 "must provide a string" stderr lines) for the entire
  // P2 lifetime. The correct contract is a present, bare-string title.
  it('plan block has a required top-level title as a bare string', () => {
    const todos: Todo[] = [
      { id: '1', content: 'a', status: 'pending', priority: 'high' },
      { id: '2', content: 'b', status: 'in_progress', priority: 'high' },
    ];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);
    const planBlock = result.blocks.find((b: any) => b.type === 'plan');
    expect(planBlock.title).toBeDefined();
    expect(typeof planBlock.title).toBe('string');
    expect(planBlock.title).toBe('Tasks (2)');
  });

  it('plan title task count tracks the todo length', () => {
    const todos: Todo[] = [{ id: '1', content: 'only one', status: 'pending', priority: 'high' }];
    const result = TaskListBlockBuilder.buildPlanTasks(todos);
    const planBlock = result.blocks.find((b: any) => b.type === 'plan');
    expect(typeof planBlock.title).toBe('string');
    expect(planBlock.title).toBe('Tasks (1)');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // `final: true` — terminal-state render for end-of-turn finalization.
  //
  // Bug context: the B2 plan message is persistent Slack history (see
  // TurnSurface state.planTs commentary). If the LLM ends a turn without
  // marking its in-progress todo as completed, the rendered task_card stays
  // in `status: 'in_progress'` forever — Slack natively renders that state
  // with a loading/spinner indicator, making the message look like the bot
  // is still working long after the turn has ended ("hang state").
  //
  // The fix: `TurnSurface.end()` / `fail()` does one last render with
  // `{ final: true }` so any lingering in-progress task_cards drop back to
  // `pending`, killing the misleading native spinner. Honesty over UX
  // theatre — we don't promote unfinished work to `complete`.
  // ─────────────────────────────────────────────────────────────────────────

  describe('final: true (end-of-turn finalize)', () => {
    it('maps in_progress task_cards to pending in the plan block', () => {
      const todos: Todo[] = [
        { id: '1', content: 'done', status: 'completed', priority: 'high' },
        { id: '2', content: 'still running', status: 'in_progress', priority: 'high' },
        { id: '3', content: 'waiting', status: 'pending', priority: 'medium' },
      ];
      const result = TaskListBlockBuilder.buildPlanTasks(todos, { final: true });

      const planBlock = result.blocks.find((b: any) => b.type === 'plan');
      expect(planBlock).toBeDefined();
      const statuses = planBlock.tasks.map((tc: any) => tc.status);
      // 'complete' stays; 'in_progress' demoted to 'pending'; 'pending' stays.
      expect(statuses).toEqual(['complete', 'pending', 'pending']);
      // Title text on the demoted card is preserved so the user can still
      // see WHAT was left unfinished.
      const demoted = planBlock.tasks.find((tc: any) => tc.title === 'still running');
      expect(demoted).toBeDefined();
      expect(demoted.status).toBe('pending');
    });

    it('top-level text replaces ⏳ (in_progress) with ⬜ (pending) icons on final', () => {
      const todos: Todo[] = [
        { id: '1', content: 'running A', status: 'in_progress', priority: 'high' },
        { id: '2', content: 'running B', status: 'in_progress', priority: 'high' },
      ];
      const result = TaskListBlockBuilder.buildPlanTasks(todos, { final: true });
      // No ⏳ markers in final-rendered text — every line falls back to ⬜.
      expect(result.text).not.toContain('⏳');
      expect(result.text).toContain('⬜ running A');
      expect(result.text).toContain('⬜ running B');
    });

    it('fallback section mrkdwn drops ⏳ icon for in_progress on final', () => {
      const todos: Todo[] = [{ id: '1', content: 'running solo', status: 'in_progress', priority: 'high' }];
      const result = TaskListBlockBuilder.buildPlanTasks(todos, { final: true });
      const sectionFallback = result.blocks.find((b: any) => b.type === 'section' && b.text?.type === 'mrkdwn');
      expect(sectionFallback).toBeDefined();
      expect(sectionFallback.text.text).not.toContain('⏳');
      expect(sectionFallback.text.text).toContain('⬜');
      // Title still present so users see WHICH task was abandoned.
      expect(sectionFallback.text.text).toContain('running solo');
    });

    it('without `final` option (default), in_progress task_cards keep their in_progress status', () => {
      // Regression guard — final-flag must not leak into the default code path.
      const todos: Todo[] = [{ id: '1', content: 'running', status: 'in_progress', priority: 'high' }];
      const result = TaskListBlockBuilder.buildPlanTasks(todos);
      const planBlock = result.blocks.find((b: any) => b.type === 'plan');
      expect(planBlock.tasks[0].status).toBe('in_progress');
      expect(result.text).toContain('⏳ running');
    });

    it('final: true is a no-op when no in_progress todos exist (idempotent)', () => {
      const todos: Todo[] = [
        { id: '1', content: 'done', status: 'completed', priority: 'high' },
        { id: '2', content: 'waiting', status: 'pending', priority: 'medium' },
      ];
      const final = TaskListBlockBuilder.buildPlanTasks(todos, { final: true });
      const live = TaskListBlockBuilder.buildPlanTasks(todos);
      // Same statuses, same icons — nothing to demote.
      const finalStatuses = final.blocks.find((b: any) => b.type === 'plan').tasks.map((tc: any) => tc.status);
      const liveStatuses = live.blocks.find((b: any) => b.type === 'plan').tasks.map((tc: any) => tc.status);
      expect(finalStatuses).toEqual(liveStatuses);
      expect(final.text).toBe(live.text);
    });
  });
});

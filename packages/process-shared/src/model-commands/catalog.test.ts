import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInstruction, SessionInstructionOperation } from './session-types';
import {
  applyInstructionOperations,
  getDefaultSessionSnapshot,
  registerSkillStore,
  runModelCommand,
  type SkillStore,
} from './catalog';
import {
  SHARE_CONTENT_CHAR_LIMIT,
  invalidSkillNameMessage,
  shareOverLimitMessage,
} from './skill-share-errors';
import type { ModelCommandContext, ModelCommandRunRequest } from './types';

function makeContext(overrides?: Partial<ModelCommandContext>): ModelCommandContext {
  return {
    channel: 'C123',
    threadTs: '111.222',
    user: 'U123',
    session: getDefaultSessionSnapshot(),
    ...overrides,
  };
}

describe('UPDATE_SESSION with title', () => {
  it('succeeds with title only (no operations)', () => {
    const ctx = makeContext();
    const result = runModelCommand(
      {
        commandId: 'UPDATE_SESSION',
        params: { title: 'My Session Title' },
      } as ModelCommandRunRequest,
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toHaveProperty('title', 'My Session Title');
    expect(result.payload).toHaveProperty('appliedOperations', 0);
  });

  it('applies both title and operations', () => {
    const ctx = makeContext();
    const result = runModelCommand(
      {
        commandId: 'UPDATE_SESSION',
        params: {
          title: 'Linked Issue',
          operations: [
            {
              action: 'add',
              resourceType: 'issue',
              link: {
                url: 'https://jira.example/PTN-1',
                type: 'issue',
                provider: 'jira',
              },
            },
          ],
        },
      } as ModelCommandRunRequest,
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as any;
    expect(payload.title).toBe('Linked Issue');
    expect(payload.appliedOperations).toBe(1);
    expect(payload.session.issues).toHaveLength(1);
  });
});

describe('applyInstructionOperations', () => {
  function makeInstructions(...texts: string[]): SessionInstruction[] {
    return texts.map((text, i) => ({
      id: `instr_test_${i}`,
      text,
      addedAt: Date.now(),
      source: 'user',
    }));
  }

  it('adds an instruction', () => {
    const instructions: SessionInstruction[] = [];
    const ops: SessionInstructionOperation[] = [{ action: 'add', text: 'Always use TypeScript' }];
    const changed = applyInstructionOperations(instructions, ops);

    expect(changed).toBe(true);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].text).toBe('Always use TypeScript');
    expect(instructions[0].source).toBe('user');
    expect(instructions[0].id).toMatch(/^instr_\d+_\d+$/);
  });

  it('trims whitespace from instruction text', () => {
    const instructions: SessionInstruction[] = [];
    applyInstructionOperations(instructions, [{ action: 'add', text: '  trim me  ' }]);
    expect(instructions[0].text).toBe('trim me');
  });

  it('skips add with empty or whitespace-only text', () => {
    const instructions: SessionInstruction[] = [];
    const changed = applyInstructionOperations(instructions, [
      { action: 'add', text: '' },
      { action: 'add', text: '   ' },
    ]);
    expect(changed).toBe(false);
    expect(instructions).toHaveLength(0);
  });

  it('removes an instruction by ID', () => {
    const instructions = makeInstructions('first', 'second', 'third');
    const changed = applyInstructionOperations(instructions, [{ action: 'remove', id: 'instr_test_1' }]);

    expect(changed).toBe(true);
    expect(instructions).toHaveLength(2);
    expect(instructions.map((i) => i.text)).toEqual(['first', 'third']);
  });

  it('remove with non-existent ID is a no-op', () => {
    const instructions = makeInstructions('only');
    const changed = applyInstructionOperations(instructions, [{ action: 'remove', id: 'nonexistent' }]);

    expect(changed).toBe(false);
    expect(instructions).toHaveLength(1);
  });

  it('clears all instructions', () => {
    const instructions = makeInstructions('a', 'b', 'c');
    const changed = applyInstructionOperations(instructions, [{ action: 'clear' }]);

    expect(changed).toBe(true);
    expect(instructions).toHaveLength(0);
  });

  it('clear on empty array is a no-op', () => {
    const instructions: SessionInstruction[] = [];
    const changed = applyInstructionOperations(instructions, [{ action: 'clear' }]);
    expect(changed).toBe(false);
  });

  it('returns false for undefined ops', () => {
    const instructions: SessionInstruction[] = [];
    expect(applyInstructionOperations(instructions, undefined)).toBe(false);
  });

  it('returns false for empty ops array', () => {
    const instructions: SessionInstruction[] = [];
    expect(applyInstructionOperations(instructions, [])).toBe(false);
  });

  it('respects MAX_INSTRUCTIONS cap (50)', () => {
    const instructions: SessionInstruction[] = [];
    const ops: SessionInstructionOperation[] = Array.from({ length: 55 }, (_, i) => ({
      action: 'add' as const,
      text: `instruction ${i}`,
    }));
    applyInstructionOperations(instructions, ops);
    expect(instructions).toHaveLength(50);
  });

  it('handles mixed operations in order', () => {
    const instructions: SessionInstruction[] = [];
    // Add two, then remove first, then add another
    applyInstructionOperations(instructions, [{ action: 'add', text: 'first' }]);
    const firstId = instructions[0].id;
    applyInstructionOperations(instructions, [
      { action: 'add', text: 'second' },
      { action: 'remove', id: firstId },
      { action: 'add', text: 'third' },
    ]);
    expect(instructions).toHaveLength(2);
    expect(instructions.map((i) => i.text)).toEqual(['second', 'third']);
  });

  it('uses custom source when provided', () => {
    const instructions: SessionInstruction[] = [];
    applyInstructionOperations(instructions, [{ action: 'add', text: 'model says', source: 'model' }]);
    expect(instructions[0].source).toBe('model');
  });
});

describe('UPDATE_SESSION instructionOperations are gated for user y/n', () => {
  it('reports appliedInstructionOperations=0 and confirmationRequired=true when instr ops are present', () => {
    const ctx = makeContext();
    const result = runModelCommand(
      {
        commandId: 'UPDATE_SESSION',
        params: {
          instructionOperations: [
            { action: 'add', text: 'new rule' },
            { action: 'remove', id: 'does-not-matter' },
          ],
        },
      } as ModelCommandRunRequest,
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    expect(payload.appliedInstructionOperations).toBe(0);
    expect(payload.pendingInstructionOperations).toBe(2);
    expect(payload.confirmationRequired).toBe(true);
  });

  it('reports confirmationRequired=false when only resource ops are present', () => {
    const ctx = makeContext();
    const result = runModelCommand(
      {
        commandId: 'UPDATE_SESSION',
        params: {
          operations: [
            {
              action: 'add',
              resourceType: 'issue',
              link: { url: 'https://jira.example/PTN-1', type: 'issue', provider: 'jira' },
            },
          ],
        },
      } as ModelCommandRunRequest,
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    expect(payload.appliedInstructionOperations).toBe(0);
    expect(payload.pendingInstructionOperations).toBe(0);
    expect(payload.confirmationRequired).toBe(false);
  });
});

describe('GET_SESSION includes title', () => {
  it('returns title from context', () => {
    const ctx = makeContext({ sessionTitle: 'Existing Title' });
    const result = runModelCommand({ commandId: 'GET_SESSION', params: undefined } as ModelCommandRunRequest, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toHaveProperty('title', 'Existing Title');
  });

  it('returns null title when context has no title', () => {
    const ctx = makeContext();
    const result = runModelCommand({ commandId: 'GET_SESSION', params: undefined } as ModelCommandRunRequest, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toHaveProperty('title', null);
  });
});

// ---------------------------------------------------------------------------
// MANAGE_SKILL share dispatcher (added in this PR)
// ---------------------------------------------------------------------------
//
// The dispatcher owns the wire-format invariants that storage shouldn't know
// about — specifically the 2500-char cap. Storage outcomes (happy / invalid
// name / not found) are exercised in `skill-file-store.test.ts`; here we
// verify the dispatcher composes the right payload from each storage answer
// and rejects oversized content even when storage said ok.

describe('MANAGE_SKILL share dispatcher', () => {
  // A do-nothing baseline so we can override exactly the method under test.
  function makeStubStore(overrides: Partial<SkillStore>): SkillStore {
    return {
      listSkills: () => [],
      createSkill: () => ({ ok: true, message: 'stub' }),
      updateSkill: () => ({ ok: true, message: 'stub' }),
      deleteSkill: () => ({ ok: true, message: 'stub' }),
      shareSkill: () => ({ ok: false, message: 'stub default' }),
      renameSkill: () => ({ ok: true, message: 'stub rename' }),
      ...overrides,
    };
  }

  function shareCtx(): ModelCommandContext {
    return {
      channel: 'C123',
      threadTs: '111.222',
      user: 'U123',
      session: getDefaultSessionSnapshot(),
    };
  }

  let originalStore: SkillStore | null = null;

  beforeEach(() => {
    // Snapshot whatever store was registered (likely none in this test process)
    // so we don't leak between cases. We can't `getSkillStore` from outside,
    // so we just re-register the stub each test and clear at end with a
    // throw-on-call sentinel.
    originalStore = null;
  });

  afterEach(() => {
    // Replace with a throw-on-call sentinel so a leak from a later unrelated
    // test would fail loudly rather than silently use stale data.
    registerSkillStore({
      listSkills: () => {
        throw new Error('skill store leak');
      },
      createSkill: () => {
        throw new Error('skill store leak');
      },
      updateSkill: () => {
        throw new Error('skill store leak');
      },
      deleteSkill: () => {
        throw new Error('skill store leak');
      },
      shareSkill: () => {
        throw new Error('skill store leak');
      },
      renameSkill: () => {
        throw new Error('skill store leak');
      },
    });
    void originalStore; // explicit ignore — kept for symmetry with beforeEach
  });

  it('happy path — under cap returns ok=true with name + content in payload', () => {
    const skillContent = 'Body well under 2500 chars.';
    registerSkillStore(
      makeStubStore({
        shareSkill: (_user, name) => ({
          ok: true,
          message: `Skill "${name}" read for share.`,
          content: skillContent,
        }),
      }),
    );

    const result = runModelCommand(
      {
        commandId: 'MANAGE_SKILL',
        params: { action: 'share', name: 'my-deploy' },
      } as ModelCommandRunRequest,
      shareCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.name).toBe('my-deploy');
    expect(payload.content).toBe(skillContent);
    // Success message should at minimum echo the skill name and tell the
    // recipient to call create with the same name+content. We don't assert the
    // exact wording (that's a UX-ish concern owned by `skill-share-errors.ts`)
    // but we DO assert the action keyword shows up so the contract surface is
    // visible from this test layer.
    expect(typeof payload.message).toBe('string');
    expect(payload.message as string).toContain('create');
  });

  it('over-cap — content exceeding SHARE_CONTENT_CHAR_LIMIT is refused with structured error', () => {
    const oversized = 'x'.repeat(SHARE_CONTENT_CHAR_LIMIT + 1);
    registerSkillStore(
      makeStubStore({
        shareSkill: () => ({
          ok: true,
          message: 'Skill ok at storage layer.',
          content: oversized,
        }),
      }),
    );

    const result = runModelCommand(
      {
        commandId: 'MANAGE_SKILL',
        params: { action: 'share', name: 'big-skill' },
      } as ModelCommandRunRequest,
      shareCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    // Content must NOT leak through when the cap rejects the payload —
    // otherwise a Slack viewer could still receive a giant message.
    expect(payload.content).toBeUndefined();
    expect(payload.name).toBeUndefined();
    expect(payload.message).toBe(shareOverLimitMessage('big-skill', oversized.length));
  });

  it('boundary — content exactly at SHARE_CONTENT_CHAR_LIMIT is accepted', () => {
    const exact = 'y'.repeat(SHARE_CONTENT_CHAR_LIMIT);
    registerSkillStore(
      makeStubStore({
        shareSkill: () => ({ ok: true, message: 'ok', content: exact }),
      }),
    );

    const result = runModelCommand(
      {
        commandId: 'MANAGE_SKILL',
        params: { action: 'share', name: 'edge-case' },
      } as ModelCommandRunRequest,
      shareCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.content).toBe(exact);
  });

  it('invalid-name passthrough — storage failure surfaces with no content + ok:false', () => {
    const badName = 'Bad_Name';
    registerSkillStore(
      makeStubStore({
        shareSkill: (_user, name) => ({
          ok: false,
          message: invalidSkillNameMessage(name),
        }),
      }),
    );

    const result = runModelCommand(
      {
        commandId: 'MANAGE_SKILL',
        params: { action: 'share', name: badName },
      } as ModelCommandRunRequest,
      shareCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.content).toBeUndefined();
    expect(payload.message).toBe(invalidSkillNameMessage(badName));
  });

  it('rejects share when name is missing at the dispatcher layer', () => {
    // The validator catches this first, but the dispatcher has its own guard
    // for callers that bypass validation (e.g. internal direct invocation).
    registerSkillStore(
      makeStubStore({
        shareSkill: () => {
          throw new Error('storage should not be called when name is missing');
        },
      }),
    );

    const result = runModelCommand(
      {
        commandId: 'MANAGE_SKILL',
        params: { action: 'share' },
      } as ModelCommandRunRequest,
      shareCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('name');
    expect(result.error.message).toContain('share');
  });
});

// ---------------------------------------------------------------------------
// MANAGE_SKILL rename + mutation signal (issue #774)
// ---------------------------------------------------------------------------
//
// The dispatcher attaches `mutated: { kind: 'skill', user, action }` to the
// MANAGE_SKILL payload only on the happy path of a mutating action. The host
// stream-executor uses that signal to drop cached system prompts for the
// affected user. This test class verifies BOTH halves of the contract:
//   1. mutated is present on rename/create/update/delete success.
//   2. mutated is absent on rename failure / share / list (read-only or no-op).

describe('MANAGE_SKILL rename dispatcher + mutation signal', () => {
  function makeStubStore(overrides: Partial<SkillStore>): SkillStore {
    return {
      listSkills: () => [],
      createSkill: () => ({ ok: true, message: 'stub create' }),
      updateSkill: () => ({ ok: true, message: 'stub update' }),
      deleteSkill: () => ({ ok: true, message: 'stub delete' }),
      shareSkill: () => ({ ok: false, message: 'stub share default' }),
      renameSkill: () => ({ ok: true, message: 'stub rename' }),
      ...overrides,
    };
  }

  function ctx(): ModelCommandContext {
    return {
      channel: 'C123',
      threadTs: '111.222',
      user: 'U-rename',
      session: getDefaultSessionSnapshot(),
    };
  }

  it('rename happy path returns ok=true and stamps mutated.kind=skill', () => {
    let called = false;
    registerSkillStore(
      makeStubStore({
        renameSkill: (user, name, newName) => {
          called = true;
          expect(user).toBe('U-rename');
          expect(name).toBe('old');
          expect(newName).toBe('new');
          return { ok: true, message: 'renamed' };
        },
      }),
    );

    const result = runModelCommand(
      {
        commandId: 'MANAGE_SKILL',
        params: { action: 'rename', name: 'old', newName: 'new' },
      } as ModelCommandRunRequest,
      ctx(),
    );

    expect(called).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.mutated).toMatchObject({ kind: 'skill', user: 'U-rename', action: 'rename' });
  });

  it('rename failure (storage returns ok=false) does NOT stamp mutated', () => {
    registerSkillStore(
      makeStubStore({
        renameSkill: () => ({ ok: false, message: 'target taken', error: 'EEXIST' }),
      }),
    );

    const result = runModelCommand(
      {
        commandId: 'MANAGE_SKILL',
        params: { action: 'rename', name: 'old', newName: 'new' },
      } as ModelCommandRunRequest,
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.mutated).toBeUndefined();
  });

  it('create/update/delete success all stamp mutated.action correctly', () => {
    registerSkillStore(makeStubStore({}));

    const cActions: Array<{ params: Record<string, unknown>; expected: string }> = [
      { params: { action: 'create', name: 'a', content: 'body' }, expected: 'create' },
      { params: { action: 'update', name: 'a', content: 'body' }, expected: 'update' },
      { params: { action: 'delete', name: 'a' }, expected: 'delete' },
    ];
    for (const tc of cActions) {
      const result = runModelCommand(
        { commandId: 'MANAGE_SKILL', params: tc.params } as ModelCommandRunRequest,
        ctx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const payload = result.payload as Record<string, unknown>;
      expect(payload.ok).toBe(true);
      expect(payload.mutated).toMatchObject({ kind: 'skill', user: 'U-rename', action: tc.expected });
    }
  });

  it('share + list NEVER stamp mutated (read-only invariant)', () => {
    registerSkillStore(
      makeStubStore({
        shareSkill: () => ({ ok: true, message: 'shared', content: 'body' }),
        listSkills: () => [{ name: 'a', description: '' }],
      }),
    );

    const shareResult = runModelCommand(
      {
        commandId: 'MANAGE_SKILL',
        params: { action: 'share', name: 'a' },
      } as ModelCommandRunRequest,
      ctx(),
    );
    expect(shareResult.ok).toBe(true);
    if (shareResult.ok) {
      const sharePayload = shareResult.payload as Record<string, unknown>;
      expect(sharePayload.ok).toBe(true);
      expect(sharePayload.mutated).toBeUndefined();
    }

    const listResult = runModelCommand(
      { commandId: 'MANAGE_SKILL', params: { action: 'list' } } as ModelCommandRunRequest,
      ctx(),
    );
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      const listPayload = listResult.payload as Record<string, unknown>;
      expect(listPayload.ok).toBe(true);
      expect(listPayload.mutated).toBeUndefined();
    }
  });

  it('rejects rename when newName is missing at the dispatcher layer', () => {
    registerSkillStore(
      makeStubStore({
        renameSkill: () => {
          throw new Error('storage should not be called when newName is missing');
        },
      }),
    );

    const result = runModelCommand(
      {
        commandId: 'MANAGE_SKILL',
        params: { action: 'rename', name: 'old' },
      } as ModelCommandRunRequest,
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain('newName');
  });
});

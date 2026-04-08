import { describe, expect, it } from 'vitest';
import type { SessionInstruction, SessionInstructionOperation } from '../types';
import { applyInstructionOperations, getDefaultSessionSnapshot, runModelCommand } from './catalog';
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

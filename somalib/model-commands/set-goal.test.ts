/**
 * Issue #1082 T2 — SET_GOAL model command (set-only).
 *
 * Layer pins for the somalib copy (packages/process-shared mirrors this file):
 *   - validator: objective 1..4000 code points (trimmed), userRequestEvidence
 *     non-empty (trimmed); INVALID_ARGS carries self-correcting help.
 *   - catalog: descriptor is user-gated and spells out the metacognitive
 *     contract + the explicit-user-request-only constraint; runModelCommand
 *     echoes params (host applies the side effect, mirror of ASK_USER_QUESTION).
 *   - command-help: SET_GOAL registered with copy-pasteable example.
 */
import { describe, expect, it } from 'vitest';
import { getDefaultSessionSnapshot, listModelCommands, runModelCommand } from './catalog';
import { getCommandHelp } from './command-help';
import type { ModelCommandContext, ModelCommandRunRequest } from './types';
import { validateModelCommandRunArgs } from './validator';

function makeContext(overrides?: Partial<ModelCommandContext>): ModelCommandContext {
  return {
    channel: 'C123',
    threadTs: '111.222',
    user: 'U123',
    session: getDefaultSessionSnapshot(),
    ...overrides,
  };
}

const VALID_ARGS = {
  commandId: 'SET_GOAL',
  params: {
    objective: 'ship the goal feature end to end',
    userRequestEvidence: 'goal을 설정하고 끝까지 완수해줘',
  },
};

describe('SET_GOAL — validator', () => {
  it('accepts a well-formed request and preserves params', () => {
    const result = validateModelCommandRunArgs(VALID_ARGS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.commandId).toBe('SET_GOAL');
    expect(result.request.params).toEqual({
      objective: 'ship the goal feature end to end',
      userRequestEvidence: 'goal을 설정하고 끝까지 완수해줘',
    });
  });

  it('trims surrounding whitespace on objective and evidence', () => {
    const result = validateModelCommandRunArgs({
      commandId: 'SET_GOAL',
      params: { objective: '  ship it  ', userRequestEvidence: '  goal: ship it  ' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.request.params as { objective: string }).objective).toBe('ship it');
    expect((result.request.params as { userRequestEvidence: string }).userRequestEvidence).toBe('goal: ship it');
  });

  it('rejects missing params object with INVALID_ARGS + help', () => {
    const result = validateModelCommandRunArgs({ commandId: 'SET_GOAL' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    expect((result.error.details as { help?: { commandId?: string } } | undefined)?.help?.commandId).toBe('SET_GOAL');
  });

  it('rejects empty / whitespace-only objective', () => {
    for (const objective of ['', '   ', '\n\t']) {
      const result = validateModelCommandRunArgs({
        commandId: 'SET_GOAL',
        params: { objective, userRequestEvidence: 'goal: do it' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('INVALID_ARGS');
    }
  });

  it('rejects non-string objective / evidence', () => {
    for (const params of [
      { objective: 42, userRequestEvidence: 'goal: do it' },
      { objective: 'ship', userRequestEvidence: ['goal'] },
      { objective: null, userRequestEvidence: 'goal' },
    ]) {
      const result = validateModelCommandRunArgs({ commandId: 'SET_GOAL', params });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects missing or empty userRequestEvidence', () => {
    for (const params of [{ objective: 'ship it' }, { objective: 'ship it', userRequestEvidence: '   ' }]) {
      const result = validateModelCommandRunArgs({ commandId: 'SET_GOAL', params });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('INVALID_ARGS');
      expect(result.error.message).toContain('userRequestEvidence');
    }
  });

  it('enforces the 4000-code-point cap on objective (code points, not UTF-16 units)', () => {
    // 4000 astral code points = 8000 UTF-16 units — must PASS (Array.from count).
    const astral = '😀'.repeat(4000);
    const okResult = validateModelCommandRunArgs({
      commandId: 'SET_GOAL',
      params: { objective: astral, userRequestEvidence: 'goal: emoji' },
    });
    expect(okResult.ok).toBe(true);

    const over = 'x'.repeat(4001);
    const failResult = validateModelCommandRunArgs({
      commandId: 'SET_GOAL',
      params: { objective: over, userRequestEvidence: 'goal: too long' },
    });
    expect(failResult.ok).toBe(false);
    if (failResult.ok) return;
    expect(failResult.error.code).toBe('INVALID_ARGS');
    expect(failResult.error.message).toContain('4000');
  });
});

describe('SET_GOAL — catalog descriptor', () => {
  it('is listed only when a user context exists (user-gated like SAVE_MEMORY)', () => {
    const withUser = listModelCommands(makeContext());
    const withoutUser = listModelCommands(makeContext({ user: undefined }));

    expect(withUser.map((c) => c.id)).toContain('SET_GOAL');
    expect(withoutUser.map((c) => c.id)).not.toContain('SET_GOAL');
  });

  it('descriptor spells out the metacognitive contract and the explicit-request-only constraint', () => {
    const descriptor = listModelCommands(makeContext()).find((c) => c.id === 'SET_GOAL');
    expect(descriptor).toBeDefined();
    const description = descriptor?.description ?? '';
    // Explicit-user-request-only constraint.
    expect(description).toContain('explicitly');
    // Metacognitive contract, pinned piece by piece:
    // 1. goal is re-injected every turn.
    expect(description).toMatch(/every turn|per[- ]turn/i);
    // 2. completion is judged HOST-side (evaluation outside the model).
    expect(description).toMatch(/host/i);
    expect(description).toMatch(/evaluat/i);
    // 3. auto-continuation exists AND is capped (bounded ralph loop).
    expect(description).toMatch(/auto-continu|continuation/i);
    expect(description).toMatch(/cap|capped|limit|max/i);
    // 4. the model cannot mark the goal complete itself.
    expect(description).toMatch(/cannot.*complete|complete.*user/i);
    // 5. the user keeps lifecycle override (pause / clear / complete via `goal`).
    expect(description).toMatch(/user.*(pause|clear|complete|override)|`goal`/i);
    // Schema requires both params.
    const schema = descriptor?.paramsSchema as { required?: string[] };
    expect(schema?.required).toEqual(expect.arrayContaining(['objective', 'userRequestEvidence']));
  });
});

describe('SET_GOAL — runModelCommand (MCP-side echo)', () => {
  it('refuses without user context (CONTEXT_ERROR)', () => {
    const result = runModelCommand(VALID_ARGS as unknown as ModelCommandRunRequest, makeContext({ user: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTEXT_ERROR');
  });

  it('echoes objective + evidence on success (host applies the side effect)', () => {
    const result = runModelCommand(VALID_ARGS as unknown as ModelCommandRunRequest, makeContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandId).toBe('SET_GOAL');
    expect(result.payload).toMatchObject({
      objective: 'ship the goal feature end to end',
      userRequestEvidence: 'goal을 설정하고 끝까지 완수해줘',
    });
  });
});

describe('SET_GOAL — command help', () => {
  it('registers self-correcting help with a copy-pasteable example', () => {
    const help = getCommandHelp('SET_GOAL');
    expect(help).toBeDefined();
    expect(help?.commandId).toBe('SET_GOAL');
    expect(help?.examples.length).toBeGreaterThan(0);
    const example = help?.examples[0];
    expect(example?.params).toHaveProperty('objective');
    expect(example?.params).toHaveProperty('userRequestEvidence');
  });
});

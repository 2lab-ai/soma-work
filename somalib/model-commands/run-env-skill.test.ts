/**
 * #1304 — RUN_ENV_SKILL: a model hands a task to an environment user's skill (`$<env>:<skill>`), exactly as if the
 * turn's user had typed that line in the thread.
 *
 * The MCP layer only checks the shape and echoes it (`status: 'submitted'`), like SET_GOAL: the host routes the
 * message through `SkillForceHandler` after the call returns (resolution, grants, the admin card, the run).
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

function helpOf(error: { details?: unknown }): { commandId?: string } | undefined {
  return (error.details as { help?: { commandId?: string } } | undefined)?.help;
}

describe('RUN_ENV_SKILL — validator', () => {
  it('accepts `$<env>:<skill>` with instructions and keeps them', () => {
    const result = validateModelCommandRunArgs({
      commandId: 'RUN_ENV_SKILL',
      params: { skill: '$acme-dev2:qa-dev2', text: '  QA the range 1.4.0..1.4.2  ' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({
      commandId: 'RUN_ENV_SKILL',
      params: { skill: '$acme-dev2:qa-dev2', text: 'QA the range 1.4.0..1.4.2' },
    });
  });

  it('text is optional — the skill alone is a request', () => {
    const result = validateModelCommandRunArgs({ commandId: 'RUN_ENV_SKILL', params: { skill: '$acme-dev2:qa-dev2' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.params).toEqual({ skill: '$acme-dev2:qa-dev2', text: '' });
  });

  it('normalizes a ref written without `$` or with the `env:` id to the typed form', () => {
    for (const skill of [
      'acme-dev2:qa-dev2',
      ' $acme-dev2:qa-dev2 ',
      '$env:acme-dev2:qa-dev2',
      'env:acme-dev2:qa-dev2',
    ]) {
      const result = validateModelCommandRunArgs({ commandId: 'RUN_ENV_SKILL', params: { skill } });
      expect(result.ok, skill).toBe(true);
      if (!result.ok) continue;
      expect((result.request.params as { skill: string }).skill).toBe('$acme-dev2:qa-dev2');
    }
  });

  it('rejects a malformed ref with INVALID_ARGS + help', () => {
    for (const skill of ['', '$qa-dev2', '$acme dev2:qa', '$<@U1>:deploy', '$a:b c', 'acme-dev2:qa-dev2 extra', 42]) {
      const result = validateModelCommandRunArgs({ commandId: 'RUN_ENV_SKILL', params: { skill } });
      expect(result.ok, String(skill)).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('INVALID_ARGS');
      expect(helpOf(result.error)?.commandId).toBe('RUN_ENV_SKILL');
    }
  });

  it('rejects missing params, a non-string text and unknown keys', () => {
    for (const params of [
      undefined,
      { text: 'no skill' },
      { skill: '$acme-dev2:qa-dev2', text: 7 },
      { skill: '$acme-dev2:qa-dev2', args: 'x' },
    ]) {
      const result = validateModelCommandRunArgs({ commandId: 'RUN_ENV_SKILL', params });
      expect(result.ok, JSON.stringify(params)).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('INVALID_ARGS');
      expect(helpOf(result.error)?.commandId).toBe('RUN_ENV_SKILL');
    }
  });
});

describe('RUN_ENV_SKILL — catalog descriptor', () => {
  it('is listed only when the turn has a user and a thread (the host acts as that user, in that thread)', () => {
    expect(listModelCommands(makeContext()).map((c) => c.id)).toContain('RUN_ENV_SKILL');
    expect(listModelCommands(makeContext({ user: undefined })).map((c) => c.id)).not.toContain('RUN_ENV_SKILL');
    expect(listModelCommands(makeContext({ channel: undefined })).map((c) => c.id)).not.toContain('RUN_ENV_SKILL');
  });

  it('says what it does, who it runs as, the admin gate, and how the outcome comes back', () => {
    const descriptor = listModelCommands(makeContext()).find((c) => c.id === 'RUN_ENV_SKILL');
    const description = descriptor?.description ?? '';
    expect(description).toMatch(/environment user/i);
    expect(description).toContain('$acme-dev2:qa-dev2');
    expect(description).toMatch(/typed/i);
    expect(description).toMatch(/admin/i);
    expect(description).toMatch(/host turn/i);
    const schema = descriptor?.paramsSchema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toEqual(['skill']);
    expect(Object.keys(schema.properties ?? {})).toEqual(['skill', 'text']);
  });
});

describe('RUN_ENV_SKILL — runModelCommand (MCP-side echo)', () => {
  const request = {
    commandId: 'RUN_ENV_SKILL',
    params: { skill: '$acme-dev2:qa-dev2', text: 'QA 1.4.0..1.4.2' },
  } as unknown as ModelCommandRunRequest;

  it('refuses without a user context (CONTEXT_ERROR)', () => {
    const result = runModelCommand(request, makeContext({ user: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTEXT_ERROR');
  });

  it('echoes the request as submitted — the host decides and runs it after this call', () => {
    const result = runModelCommand(request, makeContext());
    expect(result.ok).toBe(true);
    if (!result.ok || result.commandId !== 'RUN_ENV_SKILL') return;
    expect(result.payload).toMatchObject({
      status: 'submitted',
      skill: '$acme-dev2:qa-dev2',
      text: 'QA 1.4.0..1.4.2',
      request: '$acme-dev2:qa-dev2 QA 1.4.0..1.4.2',
    });
    expect(result.payload.next).toMatch(/host turn/i);
  });

  it('a request without text is the skill ref alone', () => {
    const result = runModelCommand(
      { commandId: 'RUN_ENV_SKILL', params: { skill: '$acme-dev2:qa-dev2', text: '' } } as ModelCommandRunRequest,
      makeContext(),
    );
    if (!result.ok || result.commandId !== 'RUN_ENV_SKILL') throw new Error('expected ok');
    expect(result.payload.request).toBe('$acme-dev2:qa-dev2');
  });
});

describe('RUN_ENV_SKILL — command help', () => {
  it('registers self-correcting help with a copy-pasteable example', () => {
    const help = getCommandHelp('RUN_ENV_SKILL');
    expect(help?.commandId).toBe('RUN_ENV_SKILL');
    expect(help?.examples[0]?.params).toMatchObject({ skill: '$acme-dev2:qa-dev2' });
    // Every example must itself pass validation.
    for (const example of help?.examples ?? []) {
      expect(validateModelCommandRunArgs({ commandId: 'RUN_ENV_SKILL', params: example.params }).ok).toBe(true);
    }
  });
});

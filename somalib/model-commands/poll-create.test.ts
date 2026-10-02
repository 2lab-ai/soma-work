/**
 * POLL_CREATE model command — native button poll.
 *
 * Layer pins:
 *   - validator: title 1..150, options 1..20 (each 1..60 chars, no newline,
 *     unique case-insensitively), closesAt = ISO-8601 WITH an explicit offset
 *     (Z or ±HH:MM) so the host never guesses a timezone. Values are trimmed.
 *   - catalog: listed when a user context exists; runModelCommand echoes the
 *     params (the HOST posts the card and persists the poll).
 *   - command-help: registered so INVALID_ARGS is self-correcting.
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

const VALID = {
  commandId: 'POLL_CREATE',
  params: {
    title: '점심 팀 편성',
    options: ['김치찌개', '된장찌개', '제육볶음'],
    closesAt: '2026-10-02T12:50:00+09:00',
  },
};

function expectInvalid(params: unknown) {
  const result = validateModelCommandRunArgs({ commandId: 'POLL_CREATE', params });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('INVALID_ARGS');
  const help = (result.error.details as { help?: { commandId?: string } } | undefined)?.help;
  expect(help?.commandId).toBe('POLL_CREATE');
}

describe('POLL_CREATE — validator', () => {
  it('accepts a well-formed request and trims values', () => {
    const result = validateModelCommandRunArgs({
      commandId: 'POLL_CREATE',
      params: { title: '  점심 팀 편성 ', options: [' 김치찌개', '된장찌개 '], closesAt: ' 2026-10-02T03:50:00Z ' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.params).toEqual({
      title: '점심 팀 편성',
      options: ['김치찌개', '된장찌개'],
      closesAt: '2026-10-02T03:50:00Z',
    });
  });

  it('rejects bad titles', () => {
    expectInvalid(undefined);
    expectInvalid({ ...VALID.params, title: '   ' });
    expectInvalid({ ...VALID.params, title: 'x'.repeat(151) });
    expectInvalid({ ...VALID.params, title: 7 });
  });

  it('rejects bad option lists (count, length, newline, duplicates)', () => {
    expectInvalid({ ...VALID.params, options: [] });
    expectInvalid({ ...VALID.params, options: 'a,b' });
    expectInvalid({ ...VALID.params, options: Array.from({ length: 21 }, (_, i) => `m${i}`) });
    expectInvalid({ ...VALID.params, options: ['ok', ''] });
    expectInvalid({ ...VALID.params, options: ['ok', 'x'.repeat(61)] });
    expectInvalid({ ...VALID.params, options: ['ok', 'two\nlines'] });
    expectInvalid({ ...VALID.params, options: ['김치찌개', ' 김치찌개 '] });
    expectInvalid({ ...VALID.params, options: ['Pho', 'pho'] });
  });

  it('requires an ISO-8601 closesAt with an explicit offset (no host-timezone guessing)', () => {
    expectInvalid({ ...VALID.params, closesAt: '2026-10-02T12:50:00' });
    expectInvalid({ ...VALID.params, closesAt: '12:50' });
    expectInvalid({ ...VALID.params, closesAt: 1790000000 });
    expectInvalid({ ...VALID.params, closesAt: '2026-13-40T12:50:00+09:00' });
    expect(validateModelCommandRunArgs({ ...VALID, params: { ...VALID.params, closesAt: '2026-10-02T12:50+09:00' } }).ok).toBe(
      true,
    );
  });
});

describe('POLL_CREATE — catalog + help', () => {
  it('is listed when a user context exists, hidden otherwise', () => {
    expect(listModelCommands(makeContext()).map((c) => c.id)).toContain('POLL_CREATE');
    expect(listModelCommands(makeContext({ user: undefined })).map((c) => c.id)).not.toContain('POLL_CREATE');
  });

  it('runModelCommand echoes the params for the host to apply', () => {
    const validated = validateModelCommandRunArgs(VALID);
    if (!validated.ok) throw new Error('expected valid');
    const result = runModelCommand(validated.request as ModelCommandRunRequest, makeContext());
    expect(result.ok).toBe(true);
    if (!result.ok || result.commandId !== 'POLL_CREATE') return;
    expect(result.payload).toEqual(VALID.params);
  });

  it('fails closed without a channel/thread/user context', () => {
    const validated = validateModelCommandRunArgs(VALID);
    if (!validated.ok) throw new Error('expected valid');
    const result = runModelCommand(validated.request as ModelCommandRunRequest, makeContext({ threadTs: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTEXT_ERROR');
  });

  it('has self-correcting help', () => {
    expect(getCommandHelp('POLL_CREATE')?.commandId).toBe('POLL_CREATE');
  });
});

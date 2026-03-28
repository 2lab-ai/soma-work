import { describe, expect, it } from 'vitest';
import { runModelCommand, getDefaultSessionSnapshot } from './catalog';
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

describe('GET_SESSION includes title', () => {
  it('returns title from context', () => {
    const ctx = makeContext({ sessionTitle: 'Existing Title' });
    const result = runModelCommand(
      { commandId: 'GET_SESSION', params: undefined } as ModelCommandRunRequest,
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toHaveProperty('title', 'Existing Title');
  });

  it('returns null title when context has no title', () => {
    const ctx = makeContext();
    const result = runModelCommand(
      { commandId: 'GET_SESSION', params: undefined } as ModelCommandRunRequest,
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toHaveProperty('title', null);
  });
});

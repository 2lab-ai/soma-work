import { describe, expect, it } from 'vitest';
import { runModelCommand } from './catalog';
import { getCommandHelp } from './command-help';
import type { ModelCommandError } from './types';
import { validateModelCommandRunArgs } from './validator';

// ---------------------------------------------------------------------------
// Command help on failure
//
// When a `run` request fails validation (or a runtime precondition) the error
// MUST carry, in `error.details.help`, a self-contained description of the
// command: every action it accepts and at least one copy-pasteable example per
// action. The model that just failed should be able to self-correct on the
// FIRST failure without another round-trip. The existing `error.message` and
// `error.code` must be preserved (no regression).
// ---------------------------------------------------------------------------

function help(error: ModelCommandError): {
  commandId: string;
  summary: string;
  actions?: string[];
  examples: Array<{ action?: string; title: string; params: Record<string, unknown> }>;
} {
  const details = error.details as { help?: unknown } | undefined;
  return details?.help as ReturnType<typeof help>;
}

describe('getCommandHelp — static catalog', () => {
  const actionDispatch: Array<[string, string[]]> = [
    ['SAVE_MEMORY', ['add', 'replace', 'remove']],
    ['MANAGE_SKILL', ['create', 'update', 'delete', 'list', 'share', 'rename', 'get']],
  ];

  for (const [commandId, actions] of actionDispatch) {
    it(`${commandId} help lists every action with at least one example each`, () => {
      const h = getCommandHelp(commandId as never);
      expect(h).toBeDefined();
      if (!h) return;
      expect(h.commandId).toBe(commandId);
      expect(h.summary.length).toBeGreaterThan(0);
      expect(h.actions).toEqual(expect.arrayContaining(actions));
      // every advertised action has at least one example
      for (const a of actions) {
        expect(h.examples.some((e) => e.action === a)).toBe(true);
      }
      // every example carries a non-empty params object
      for (const e of h.examples) {
        expect(e.title.length).toBeGreaterThan(0);
        expect(Object.keys(e.params).length).toBeGreaterThan(0);
      }
    });
  }

  const paramBearing = ['UPDATE_SESSION', 'CONTINUE_SESSION', 'SAVE_CONTEXT_RESULT', 'ASK_USER_QUESTION'];
  for (const commandId of paramBearing) {
    it(`${commandId} help exists with at least one example`, () => {
      const h = getCommandHelp(commandId as never);
      expect(h).toBeDefined();
      if (!h) return;
      expect(h.commandId).toBe(commandId);
      expect(h.examples.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('no-arg commands have no help (nothing to guide)', () => {
    expect(getCommandHelp('GET_SESSION' as never)).toBeUndefined();
    expect(getCommandHelp('GET_MEMORY' as never)).toBeUndefined();
    expect(getCommandHelp('RATE' as never)).toBeUndefined();
  });
});

describe('validation failures carry command help (the SAVE_MEMORY bug)', () => {
  it('SAVE_MEMORY missing action → help with all actions + example each, message preserved', () => {
    const r = validateModelCommandRunArgs({ commandId: 'SAVE_MEMORY', params: { target: 'memory' } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_ARGS');
    // message preserved (no regression)
    expect(r.error.message).toContain("action must be 'add'");
    const h = help(r.error);
    expect(h).toBeDefined();
    expect(h.commandId).toBe('SAVE_MEMORY');
    for (const a of ['add', 'replace', 'remove']) {
      expect(h.examples.some((e) => e.action === a)).toBe(true);
    }
  });

  it('SAVE_MEMORY missing target → help present', () => {
    const r = validateModelCommandRunArgs({ commandId: 'SAVE_MEMORY', params: { action: 'add' } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("target must be 'memory'");
    expect(help(r.error)).toBeDefined();
  });

  it('SAVE_MEMORY non-object params → help present', () => {
    const r = validateModelCommandRunArgs({ commandId: 'SAVE_MEMORY', params: 'oops' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(help(r.error)?.commandId).toBe('SAVE_MEMORY');
  });

  it('MANAGE_SKILL unknown action → help with all actions', () => {
    const r = validateModelCommandRunArgs({ commandId: 'MANAGE_SKILL', params: { action: 'haxx0r' } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const h = help(r.error);
    expect(h?.commandId).toBe('MANAGE_SKILL');
    expect(h?.actions).toEqual(
      expect.arrayContaining(['create', 'update', 'delete', 'list', 'share', 'rename', 'get']),
    );
  });

  it('UPDATE_SESSION empty op set → help present, message preserved', () => {
    const r = validateModelCommandRunArgs({ commandId: 'UPDATE_SESSION', params: { operations: [] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('operations or title');
    expect(help(r.error)?.commandId).toBe('UPDATE_SESSION');
  });

  it('CONTINUE_SESSION missing prompt → help present', () => {
    const r = validateModelCommandRunArgs({ commandId: 'CONTINUE_SESSION', params: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(help(r.error)?.commandId).toBe('CONTINUE_SESSION');
  });

  it('ASK_USER_QUESTION bad payload → help present AND legacy details preserved', () => {
    const r = validateModelCommandRunArgs({ commandId: 'ASK_USER_QUESTION', params: { question: 'hi' } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // legacy details preserved (mcp-server.test relies on these)
    expect((r.error.details as { allowedPayloadTypes?: unknown }).allowedPayloadTypes).toEqual([
      'user_choice',
      'user_choice_group',
    ]);
    expect(help(r.error)?.commandId).toBe('ASK_USER_QUESTION');
  });

  it('INVALID_COMMAND (unknown commandId) does not attach help', () => {
    const r = validateModelCommandRunArgs({ commandId: 'NOPE', params: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_COMMAND');
    expect(help(r.error)).toBeUndefined();
  });
});

describe('runtime (post-validation) failures also carry command help', () => {
  it('SAVE_MEMORY add without content → runtime error carries help', () => {
    const r = runModelCommand(
      { commandId: 'SAVE_MEMORY', params: { action: 'add', target: 'memory' } },
      { user: 'U1' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_ARGS');
    expect(r.error.message).toContain('content is required for add');
    expect(help(r.error)?.commandId).toBe('SAVE_MEMORY');
  });

  it('SAVE_MEMORY remove without old_text → runtime error carries help', () => {
    const r = runModelCommand(
      { commandId: 'SAVE_MEMORY', params: { action: 'remove', target: 'memory' } },
      { user: 'U1' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('old_text is required for remove');
    expect(help(r.error)?.commandId).toBe('SAVE_MEMORY');
  });

  it('CONTEXT_ERROR (no user) does NOT attach help — not a schema problem', () => {
    const r = runModelCommand(
      { commandId: 'SAVE_MEMORY', params: { action: 'add', target: 'memory', content: 'x' } },
      {},
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONTEXT_ERROR');
    expect(help(r.error)).toBeUndefined();
  });
});

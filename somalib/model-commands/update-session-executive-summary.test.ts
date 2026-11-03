import { describe, expect, it } from 'vitest';
import { getDefaultSessionSnapshot, listModelCommands, runModelCommand } from './catalog';
import type { ModelCommandRunRequest } from './types';
import { validateModelCommandRunArgs } from './validator';

/**
 * #829 T1/T5 — UPDATE_SESSION carries the Executive Summary's TL;DR to the session's task card.
 *
 * The es skill (model-run) has tools; the host-run summary does not. Both put the same 3 TL;DR lines on the
 * card, and a line that starts with ⚠️ keeps the card waiting for the user. The model writes them with
 * `UPDATE_SESSION { executiveSummary: { tldr } }` — alone or next to link operations and a title.
 */

const ctx = () => ({ channel: 'C1', threadTs: '1.1', user: 'U1', session: getDefaultSessionSnapshot() });
const TLDR = ['PR #12 opened.', '⚠️ **PR #12 not merged — needs a maintainer approval.**', 'Next: merge #12.'];

describe('validator', () => {
  it('accepts executiveSummary alone (no operations, no title)', () => {
    const r = validateModelCommandRunArgs({
      commandId: 'UPDATE_SESSION',
      params: { executiveSummary: { tldr: TLDR } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.request.params as any).executiveSummary).toEqual({ tldr: TLDR });
  });

  it('keeps it next to operations and a title', () => {
    const r = validateModelCommandRunArgs({
      commandId: 'UPDATE_SESSION',
      params: {
        title: 'Login fix',
        operations: [{ action: 'add', resourceType: 'pr', url: 'https://github.com/a/b/pull/12' }],
        executiveSummary: { tldr: TLDR },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.request.params as any;
    expect(p.executiveSummary).toEqual({ tldr: TLDR });
    expect(p.title).toBe('Login fix');
    expect(p.operations).toHaveLength(1);
  });

  it('trims the lines and drops blank ones', () => {
    const r = validateModelCommandRunArgs({
      commandId: 'UPDATE_SESSION',
      params: { executiveSummary: { tldr: ['  a  ', '', '   ', 'b'] } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.request.params as any).executiveSummary).toEqual({ tldr: ['a', 'b'] });
  });

  it.each([
    ['not an object', 'x'],
    ['no tldr', {}],
    ['tldr not an array', { tldr: 'a' }],
    ['no line left', { tldr: ['', ' '] }],
    ['a line that is not text', { tldr: ['a', 3] }],
    ['more than 5 lines', { tldr: ['1', '2', '3', '4', '5', '6'] }],
  ])('rejects %s', (_label, executiveSummary) => {
    const r = validateModelCommandRunArgs({ commandId: 'UPDATE_SESSION', params: { executiveSummary } });
    expect(r.ok).toBe(false);
  });
});

describe('catalog', () => {
  it('the advertised UPDATE_SESSION schema has executiveSummary.tldr', () => {
    const cmd = listModelCommands({ channel: 'C1', threadTs: '1.1', user: 'U1' } as any).find(
      (c: any) => c.id === 'UPDATE_SESSION',
    ) as any;
    const prop = cmd.paramsSchema.properties.executiveSummary;
    expect(prop).toBeDefined();
    expect(prop.properties.tldr.type).toBe('array');
    expect(String(prop.description)).toMatch(/⚠️/);
  });

  it('runModelCommand passes it to the host in the payload', () => {
    const r = runModelCommand(
      { commandId: 'UPDATE_SESSION', params: { executiveSummary: { tldr: TLDR } } } as ModelCommandRunRequest,
      ctx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload as any).executiveSummary).toEqual({ tldr: TLDR });
  });
});

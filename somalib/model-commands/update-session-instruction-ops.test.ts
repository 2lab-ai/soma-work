import { describe, expect, it } from 'vitest';
import { getDefaultSessionSnapshot, runModelCommand } from './catalog';
import type { ModelCommandRunRequest } from './types';
import { validateModelCommandRunArgs } from './validator';

/**
 * #846 item 1 — `UPDATE_SESSION { instructionOperations }` reaches the host's y/n gate.
 *
 * The catalog schema and the command help advertise instruction writes, and the host gates them for the user's
 * y/n. The MCP validator used to drop them (and refuse an instruction-only call), so they never arrived.
 */

const ctx = () => ({ channel: 'C1', threadTs: '1.1', user: 'U1', session: getDefaultSessionSnapshot() });

const validate = (params: Record<string, unknown>) =>
  validateModelCommandRunArgs({ commandId: 'UPDATE_SESSION', params });

describe('validator keeps instructionOperations', () => {
  it('accepts an instruction-only call and passes the operations through', () => {
    const ops = [
      { action: 'add', text: '  ship #846  ', source: 'model' },
      { action: 'complete', id: 'instr_1', evidence: 'PR #900 merged' },
      { action: 'setStatus', id: 'instr_2', status: 'todo' },
      { action: 'remove', id: 'instr_3' },
      { action: 'clear' },
    ];
    const r = validate({ instructionOperations: ops });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.request.params as any).instructionOperations).toEqual([
      { action: 'add', text: 'ship #846', source: 'model' },
      { action: 'complete', id: 'instr_1', evidence: 'PR #900 merged' },
      { action: 'setStatus', id: 'instr_2', status: 'todo' },
      { action: 'remove', id: 'instr_3' },
      { action: 'clear' },
    ]);
  });

  it('keeps them next to resource operations, a title and the TL;DR', () => {
    const r = validate({
      operations: [{ action: 'add', resourceType: 'issue', link: { url: 'https://github.com/o/r/issues/1' } }],
      title: 'T',
      executiveSummary: { tldr: ['done'] },
      instructionOperations: [{ action: 'add', text: 'x' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.request.params as any;
    expect(p.operations).toHaveLength(1);
    expect(p.title).toBe('T');
    expect(p.executiveSummary).toEqual({ tldr: ['done'] });
    expect(p.instructionOperations).toEqual([{ action: 'add', text: 'x' }]);
  });

  it.each([
    ['not an array', { instructionOperations: { action: 'add', text: 'x' } }],
    ['an unknown action', { instructionOperations: [{ action: 'rename', id: 'i' }] }],
    ['add without text', { instructionOperations: [{ action: 'add', text: '   ' }] }],
    ['remove without id', { instructionOperations: [{ action: 'remove' }] }],
    ['complete without evidence', { instructionOperations: [{ action: 'complete', id: 'i', evidence: '' }] }],
    ['setStatus with an unknown status', { instructionOperations: [{ action: 'setStatus', id: 'i', status: 'done' }] }],
    ['an empty list and nothing else', { instructionOperations: [] }],
  ])('rejects %s', (_label, params) => {
    const r = validate(params);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_ARGS');
  });
});

describe('validated instruction writes reach the y/n gate', () => {
  it('the catalog reports them pending, confirmation required', () => {
    const r = validate({ instructionOperations: [{ action: 'add', text: 'rule A' }, { action: 'clear' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = runModelCommand(r.request as ModelCommandRunRequest, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, any>;
    expect(payload.pendingInstructionOperations).toBe(2);
    expect(payload.confirmationRequired).toBe(true);
    expect(payload.request.instructionOperations).toEqual([{ action: 'add', text: 'rule A' }, { action: 'clear' }]);
  });
});

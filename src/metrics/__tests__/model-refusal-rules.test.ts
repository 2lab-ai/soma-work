/**
 * The shared model refusal rules (`model-refusal-rules.ts`).
 *
 * One table serves both the runtime store (`model-profile.ts`) and the
 * import-lean deploy bootstrap (`deploy/main-env-bootstrap.ts`), so the file
 * must stay free of imports — that is what lets the bootstrap load it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CatalogResolver, findModelRefusal } from '../model-refusal-rules';

const GEMINI_REASON = 'is a Gemini model';

/** A catalog that knows exactly the given keys. */
function catalog(rows: Record<string, { id: string; group: string | null }>): CatalogResolver {
  return (key) => rows[key] ?? null;
}

describe('model-refusal-rules — the file itself', () => {
  it('imports nothing, so the deploy bootstrap can load it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'model-refusal-rules.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s[^;]*\sfrom\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

describe('findModelRefusal — gemini, by llmux routing (no catalog)', () => {
  it.each([
    'gemini',
    'gemini3-pro',
    'gemini-3.8-flash-high',
    'gemini-4-neon[1m]',
    '  GEMINI-4-ARGON[1M]  ',
    'argon',
    'neon',
    'carbon',
    'hydrogen',
    'Hydrogen[1m]',
  ])('refuses %j and offers the opus default', (input) => {
    const refusal = findModelRefusal(input);
    expect(refusal?.rejectedReason).toContain(GEMINI_REASON);
    expect(refusal?.rejectedReason).toContain(`\`${input.trim()}\``);
    expect(refusal?.suggestedModel).toBe('claude-opus-5-5[1m]');
  });

  it.each([
    'neonx',
    'argonaut',
    'my-gemini',
    'grok-4.7',
    'claude-opus-5-5[1m]',
    'gpt-6.2-sol[1m]',
    '',
  ])('does not refuse %j', (input) => {
    expect(findModelRefusal(input)).toBeNull();
  });
});

describe('findModelRefusal — gemini, by the catalog the caller passes', () => {
  it('refuses an alias whose row is in group gemini, whatever the id looks like', () => {
    const resolve = catalog({ hx: { id: 'hydrogen-preview', group: 'gemini' } });
    expect(findModelRefusal('hx', resolve)?.rejectedReason).toContain(GEMINI_REASON);
    expect(findModelRefusal('hx[1m]', resolve)?.rejectedReason).toContain(GEMINI_REASON);
    expect(findModelRefusal('hx')).toBeNull();
  });

  it('refuses a row whose id routes to gemini even when the row has no group', () => {
    const resolve = catalog({ flash: { id: 'gemini-3.8-flash-high[1m]', group: null } });
    expect(findModelRefusal('flash', resolve)?.rejectedReason).toContain(GEMINI_REASON);
  });

  it('compares the group case-insensitively', () => {
    const resolve = catalog({ x: { id: 'x', group: ' Gemini ' } });
    expect(findModelRefusal('x', resolve)?.rejectedReason).toContain(GEMINI_REASON);
  });

  it('leaves a non-gemini catalog alias alone (grok → grok-4.7)', () => {
    const resolve = catalog({ grok: { id: 'grok-4.7', group: 'grok' } });
    expect(findModelRefusal('grok', resolve)).toBeNull();
  });
});

describe('findModelRefusal — the older rules moved here unchanged', () => {
  it('refuses the retired gpt-5.5 spellings with gpt-5.6-sol', () => {
    for (const input of ['gpt-5.5', 'GPT5.5', 'gpt-5.5[1m]']) {
      const refusal = findModelRefusal(input);
      expect(refusal?.rejectedReason).toContain('retired on 2026-11-19');
      expect(refusal?.suggestedModel).toBe('gpt-5.6-sol');
    }
  });

  it('refuses a grok `[1m]` id and offers the bare id', () => {
    const refusal = findModelRefusal('grok-4.6[1m]');
    expect(refusal?.rejectedReason).toContain('grok has no 1M variant');
    expect(refusal?.suggestedModel).toBe('grok-4.6');
    expect(findModelRefusal('grok-4.6')).toBeNull();
  });
});

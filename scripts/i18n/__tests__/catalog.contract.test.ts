/**
 * #771 — the English display catalogs stay usable and keep up with the code.
 *
 * - Every entry is well formed: the same `{n}` placeholders as its Korean key,
 *   no Korean left in the English, edge spaces kept.
 * - Nearly every Korean string the server can show has English: a new Korean
 *   message or page label without an entry is reported here. Fix it with
 *   `npm run i18n:extract` (writes scripts/i18n/out/missing-*.json) and add
 *   the English to packages/common/src/i18n-catalog/en-{text,page}.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPageKeys, extractTextKeys } from '../extract';

const CATALOG = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog');
const read = (name: string): Record<string, string> => JSON.parse(readFileSync(join(CATALOG, name), 'utf8'));
const HANGUL = /[ㄱ-ㆎ가-힣]/;
const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort();
/** Share of the code's Korean strings allowed without English before this fails (new strings land first, English soon after). */
const MAX_MISSING = 0.02;

describe('English display catalogs', () => {
  for (const name of ['en-text.json', 'en-page.json']) {
    it(`${name} is well formed`, () => {
      const catalog = read(name);
      const bad: string[] = [];
      for (const [key, text] of Object.entries(catalog)) {
        if (typeof text !== 'string') bad.push(`${key}: not a string`);
        else if (HANGUL.test(text)) bad.push(`${key}: Korean left in "${text}"`);
        else if (placeholders(key.split('@@')[0]).join() !== placeholders(text).join())
          bad.push(`${key}: placeholders differ from "${text}"`);
        else if (text === '' && name === 'en-text.json') bad.push(`${key}: empty`);
        // A punctuation-only English fragment ('/' after a date's month, '' for a counter suffix) may drop edge spaces.
        else if (!/^[\p{P}\p{S}\s]*$/u.test(text)) {
          const lead = key.length - key.trimStart().length;
          const trail = key.length - key.trimEnd().length;
          if (lead && !text.startsWith(key.slice(0, lead))) bad.push(`${key}: leading space lost`);
          if (trail && !text.endsWith(key.slice(key.length - trail))) bad.push(`${key}: trailing space lost`);
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it('covers the Slack and server text', () => {
    const keys = extractTextKeys();
    const catalog = read('en-text.json');
    const missing = [...keys.values()].filter((f) => !(f.key in catalog));
    expect(keys.size).toBeGreaterThan(1000);
    expect(
      missing.length / keys.size,
      `run npm run i18n:extract — missing: ${missing
        .slice(0, 20)
        .map((f) => `${f.where[0]} ${JSON.stringify(f.key)}`)
        .join('; ')}`,
    ).toBeLessThanOrEqual(MAX_MISSING);
  });

  it('covers the pages', async () => {
    const keys = await extractPageKeys();
    const catalog = read('en-page.json');
    const missing = [...keys.values()].filter((f) => !(f.key in catalog));
    expect(keys.size).toBeGreaterThan(800);
    expect(
      missing.length / keys.size,
      `run npm run i18n:extract — missing: ${missing
        .slice(0, 20)
        .map((f) => `${f.where[0]} ${JSON.stringify(f.key)}`)
        .join('; ')}`,
    ).toBeLessThanOrEqual(MAX_MISSING);
  });
});

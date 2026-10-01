/**
 * Checks on the T2 claims of `scripts/verification/ledger.cjs`.
 *
 * The ledger marks a file T2 from a hand map of file to `verification/lean/SomaVerify/<Module>`,
 * and refuses to write while an entry is not backed by the Lean tree: the module must have a
 * `Model.lean`, and that `Model.lean` must carry a `-- models: <file>:` line for the file. The
 * real map is checked against this repository; fixture trees show each way an entry goes unbacked.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const ledgerPath = path.join(repoRoot, 'scripts/verification/ledger.cjs');

const ledger = createRequire(__filename)(ledgerPath) as {
  MODELED: Map<string, string>;
  unbackedEntries(root: string, modeled: Map<string, string>): string[];
};

describe('ledger T2 entries', () => {
  const fixtureDirs: string[] = [];

  afterAll(() => {
    for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A repository root whose Lean tree holds `Model.lean` files with the given text. */
  function fixtureRoot(models: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    fixtureDirs.push(root);
    for (const [module, text] of Object.entries(models)) {
      const dir = path.join(root, 'verification/lean/SomaVerify', module);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Model.lean'), text);
    }
    return root;
  }

  it('backs every entry of the real map with a Model.lean naming its file', () => {
    expect(ledger.MODELED.size).toBeGreaterThan(0);
    expect(ledger.unbackedEntries(repoRoot, ledger.MODELED)).toEqual([]);
  });

  it('rejects an entry whose module has no Model.lean', () => {
    const root = fixtureRoot({ Present: '-- models: src/present.ts:1-2 (present)\n' });
    const modeled = new Map([
      ['src/present.ts', 'Present'],
      ['src/absent.ts', 'Absent'],
    ]);
    expect(ledger.unbackedEntries(root, modeled)).toEqual([
      'src/absent.ts -> verification/lean/SomaVerify/Absent/Model.lean does not exist',
    ]);
  });

  it('rejects an entry whose Model.lean does not name its file', () => {
    const root = fixtureRoot({
      Partial: [
        '-- models: src/other.ts:1-2 (other)',
        '-- models: src/foo.tsx:3-4 (a file sharing the prefix)',
        '--         src/foo.ts:5-6 (a continuation line, not a models line)',
        '',
      ].join('\n'),
    });
    expect(ledger.unbackedEntries(root, new Map([['src/foo.ts', 'Partial']]))).toEqual([
      'src/foo.ts -> verification/lean/SomaVerify/Partial/Model.lean has no `-- models: src/foo.ts:` line',
    ]);
  });
});

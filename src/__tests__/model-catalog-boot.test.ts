/**
 * bootModelCatalog — llmux model-catalog boot step gated on the RUNTIME auth
 * mode (auth-runtime), not the static `config.auth.mode`.
 *
 * Regression: work-m64-class hosts boot with static mode `ccp` (no AUTH_MODE
 * env) and only FLIP to llmux at runtime via `initAuthRuntimeDefault`'s
 * reachability probe. The catalog fetch used to live inside the static
 * `config.auth.mode === 'llmux'` block in index.ts, so those hosts never
 * fetched the catalog → no grok-4.5 in the model list, no snapshot file.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modelCatalog } from '../model-catalog';
import { bootModelCatalog } from '../model-catalog-boot';

const GROK = {
  id: 'grok-4.5',
  aliases: ['grok'],
  name: 'Grok 4.5',
  efforts: ['low', 'medium', 'high'],
  max_context: 500_000,
  group: 'grok',
};

let tmpDir: string;

beforeEach(() => {
  modelCatalog.__testReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-boot-'));
  modelCatalog.setSnapshotPathForTests(path.join(tmpDir, 'model-catalog.json'));
});

afterEach(() => {
  modelCatalog.setSnapshotPathForTests(null);
  modelCatalog.__testReset();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bootModelCatalog — runtime auth-mode gate', () => {
  it('runtime mode llmux → fetches the catalog (grok-4.5 becomes resolvable)', async () => {
    let calls = 0;
    const result = await bootModelCatalog('llmux', async () => {
      calls += 1;
      return [GROK];
    });
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(calls).toBe(1);
    expect(modelCatalog.resolveInput('grok')).toBe('grok-4.5');
  });

  it('runtime mode ccp → does NOT fetch at boot, but wires the fetcher for later refreshes', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [GROK];
    };
    const result = await bootModelCatalog('ccp', fetcher);
    expect(result.attempted).toBe(false);
    expect(calls).toBe(0);
    expect(modelCatalog.getModels()).toHaveLength(0);

    // The fetcher is wired: a later runtime switch to llmux (auth card /
    // model-card TTL refresh) can populate the catalog without a restart.
    const later = await modelCatalog.refresh();
    expect(later.ok).toBe(true);
    expect(calls).toBe(1);
    expect(modelCatalog.resolveInput('grok-4.5')).toBe('grok-4.5');
  });

  it('fetch failure is fail-soft: attempted but not ok, existing entries preserved', async () => {
    modelCatalog.__testSeed([GROK]);
    const result = await bootModelCatalog('llmux', async () => {
      throw new Error('llmux down');
    });
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('llmux down');
    expect(modelCatalog.resolveInput('grok-4.5')).toBe('grok-4.5');
  });
});

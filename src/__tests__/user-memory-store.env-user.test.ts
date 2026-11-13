import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return tempDir;
  },
  IS_DEV: true,
}));

vi.mock('../logger', () => ({
  Logger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

// An environment user's session loads its memory before the model is called. On a dev host the first run as
// `env:<name>` stopped right there: "Invalid userId for memory storage: env:<name>".
describe('user-memory-store — an environment user', () => {
  const ENV_USER = 'env:acme-dev2';
  let store: typeof import('../user-memory-store');

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-mem-env-'));
    vi.resetModules();
    store = await import('../user-memory-store');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads an empty memory, then keeps what is added, under the environment user folder', () => {
    expect(store.loadMemory(ENV_USER, 'memory').entries).toEqual([]);
    expect(store.addMemory(ENV_USER, 'memory', 'dev2 lane lock is /lane/lock').ok).toBe(true);
    expect(store.loadMemory(ENV_USER, 'memory').entries).toEqual(['dev2 lane lock is /lane/lock']);
    expect(fs.existsSync(path.join(tempDir, ENV_USER, 'memory', 'MEMORY.md'))).toBe(true);
  });

  it('moves a legacy root-level file of an environment user into memory/', () => {
    fs.mkdirSync(path.join(tempDir, ENV_USER), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ENV_USER, 'USER.md'), 'legacy profile line');
    expect(store.loadMemory(ENV_USER, 'user').entries).toEqual(['legacy profile line']);
    expect(fs.existsSync(path.join(tempDir, ENV_USER, 'USER.md'))).toBe(false);
  });
});

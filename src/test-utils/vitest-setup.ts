/**
 * vitest `setupFiles` entry — runs in each worker before the test file is
 * imported, so module-load-time readers (`env-paths`, `config`) only ever see
 * the isolated environment. Each test file gets its own scratch config dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateTestEnv, SCRATCH_ROOT_ENV } from './hermetic-test-env';

const root = process.env[SCRATCH_ROOT_ENV] || os.tmpdir();
isolateTestEnv(process.env, fs.mkdtempSync(path.join(root, 'soma-work-test-')));

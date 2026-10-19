/**
 * vitest `globalSetup` — one scratch root per run, removed at teardown, so the
 * per-file scratch dirs created by `vitest-setup.ts` do not pile up in tmpdir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SCRATCH_ROOT_ENV } from './hermetic-test-env';

export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-work-test-run-'));
  process.env[SCRATCH_ROOT_ENV] = root;
  return () => {
    fs.rmSync(root, { recursive: true, force: true });
  };
}

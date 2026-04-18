#!/usr/bin/env node
/**
 * llm-mcp-cleanup-legacy — idempotent one-shot cleaner for pre-refactor artifacts.
 *
 * Actions:
 *   1. Remove ~/.soma-work/llm-jobs.json (obsolete — job system removed).
 *   2. Remove ~/.soma-work/jobs/ (obsolete job log directory).
 *   3. Leave ~/.soma-work/llm-sessions.json alone — it migrates lazily.
 *
 * Safe to run repeatedly.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = path.join(os.homedir(), '.soma-work');
const jobsFile = path.join(dir, 'llm-jobs.json');
const jobsLogDir = path.join(dir, 'jobs');

function unlinkIfExists(p: string): void {
  try {
    fs.unlinkSync(p);
    console.log(`removed ${p}`);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    console.warn(`failed to remove ${p}: ${err?.message ?? err}`);
  }
}

function rmDirIfExists(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`removed ${p}`);
  } catch (err: any) {
    console.warn(`failed to remove ${p}: ${err?.message ?? err}`);
  }
}

unlinkIfExists(jobsFile);
rmDirIfExists(jobsLogDir);
console.log('llm-mcp-cleanup-legacy: done');

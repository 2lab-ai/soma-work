/**
 * #857 — what soma-work's own code reads from the harness plugin (`local`, src/local-harness).
 *
 * The turn-end Executive Summary runs `local:auto-es` without tools: the host appends the skill's turn-end contract
 * to the summary fork's prompt. The file is the single source — read once at startup.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../logger';
import { BUNDLED_HARNESS_PLUGIN_DIR } from './bundled';

const logger = new Logger('HarnessSkills');

/** `local:auto-es`'s turn-end contract (Path B). */
export const AUTO_ES_TURN_END_FILE = path.join(
  BUNDLED_HARNESS_PLUGIN_DIR,
  'skills',
  'auto-es',
  'reference',
  'turn-end.md',
);

/**
 * The turn-end contract text, or undefined when the file cannot be read — the summary then runs the generic es
 * contract, and the error is logged so a broken bundle is visible.
 */
export function loadAutoEsTurnEndContract(file: string = AUTO_ES_TURN_END_FILE): string | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text) return text;
    logger.error('local:auto-es turn-end contract is empty — the turn-end summary runs without it', { file });
  } catch (err) {
    logger.error('local:auto-es turn-end contract could not be read — the turn-end summary runs without it', {
      file,
      error: (err as Error).message,
    });
  }
  return undefined;
}

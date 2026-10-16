/**
 * Spec 10 §3.2-2 — `minimal` is task list + final answer + the always-on
 * interactions, nothing else. The flags minimal drops (MCP/subagent progress,
 * skill banners, narration) stay on from `compact` up, so those levels are
 * unchanged.
 */

import { describe, expect, it } from 'vitest';
import { getVerbosityFlags, getVerbosityName, LOG_MINIMAL, OutputFlag, shouldOutput } from '../output-flags';

const ALWAYS = OutputFlag.USER_CHOICE | OutputFlag.PERMISSION | OutputFlag.ERROR;

describe('LOG_MINIMAL', () => {
  it('is exactly ALWAYS | FINAL_RESULT | TODO_UPDATE | TODO_REACTION', () => {
    expect(LOG_MINIMAL).toBe(ALWAYS | OutputFlag.FINAL_RESULT | OutputFlag.TODO_UPDATE | OutputFlag.TODO_REACTION);
    expect(getVerbosityFlags('minimal')).toBe(LOG_MINIMAL);
    expect(getVerbosityName(LOG_MINIMAL)).toBe('minimal');
  });

  it.each([
    ['MCP_PROGRESS', OutputFlag.MCP_PROGRESS],
    ['SKILL_INVOCATION', OutputFlag.SKILL_INVOCATION],
    ['NARRATION', OutputFlag.NARRATION],
    ['STATUS_MESSAGE', OutputFlag.STATUS_MESSAGE],
  ])('minimal drops %s; compact, detail and verbose keep it', (_name, flag) => {
    expect(shouldOutput(flag, getVerbosityFlags('minimal'))).toBe(false);
    for (const level of ['compact', 'detail', 'verbose'] as const) {
      expect(shouldOutput(flag, getVerbosityFlags(level)), level).toBe(true);
    }
  });

  it('every level is a superset of the one below it', () => {
    const masks = (['minimal', 'compact', 'detail', 'verbose'] as const).map(getVerbosityFlags);
    masks.slice(1).forEach((mask, i) => {
      const below = masks[i] ?? 0;
      expect(mask & below).toBe(below);
    });
  });
});

/**
 * Spec 10 §3.2-2 — `minimal` is task list + final answer + the always-on
 * interactions, nothing else. The flags minimal drops (MCP/subagent progress,
 * skill banners, narration) stay on from `compact` up, so those levels are
 * unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  getVerbosityFlags,
  getVerbosityName,
  LOG_MINIMAL,
  OutputFlag,
  shouldOutput,
  upgradeLegacyVerbosityMask,
} from '../output-flags';

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

/**
 * Masks stored before NARRATION existed (values of the presets as of main
 * e992de7c). A thread restored with one of them would otherwise lose its
 * narration and show a `custom` chip.
 */
describe('upgradeLegacyVerbosityMask', () => {
  const LEGACY = {
    minimal:
      ALWAYS |
      OutputFlag.FINAL_RESULT |
      OutputFlag.MCP_PROGRESS |
      OutputFlag.TODO_UPDATE |
      OutputFlag.TODO_REACTION |
      OutputFlag.SKILL_INVOCATION,
    compact: getVerbosityFlags('compact') & ~OutputFlag.NARRATION,
    detail: getVerbosityFlags('detail') & ~OutputFlag.NARRATION,
    verbose: getVerbosityFlags('verbose') & ~OutputFlag.NARRATION,
  } as const;

  it('pins the legacy numbers (so a later flag change cannot silently move them)', () => {
    // Evaluated from packages/slack/src/output-flags.ts at e992de7c.
    expect(LEGACY).toEqual({ minimal: 1279521, compact: 1310695, detail: 1572863, verbose: 2097151 });
  });

  it.each(Object.entries(LEGACY))('maps the legacy %s mask to the current preset', (level, mask) => {
    const upgraded = upgradeLegacyVerbosityMask(mask);
    expect(upgraded).toBe(getVerbosityFlags(level as keyof typeof LEGACY));
    expect(getVerbosityName(upgraded as number)).toBe(level);
    // Without the upgrade the chip says `custom`.
    expect(getVerbosityName(mask)).toBe('custom');
  });

  it('leaves current presets, custom masks and a missing mask alone', () => {
    for (const level of ['minimal', 'compact', 'detail', 'verbose'] as const) {
      expect(upgradeLegacyVerbosityMask(getVerbosityFlags(level))).toBe(getVerbosityFlags(level));
    }
    expect(upgradeLegacyVerbosityMask(0b1111)).toBe(0b1111);
    expect(upgradeLegacyVerbosityMask(undefined)).toBeUndefined();
  });
});

/**
 * Work-queue keys (.prd/36 D10): a Jira key or a GitHub `owner/repo#n` — nothing else enters a queue.
 */
import { describe, expect, it } from 'vitest';
import { normalizeWorkKey, parseWorkKeys, WORK_KEYS_MAX } from '../keys';

describe('normalizeWorkKey', () => {
  it('takes a Jira key and upper-cases it', () => {
    expect(normalizeWorkKey('ABC-1234')).toBe('ABC-1234');
    expect(normalizeWorkKey(' abc-7 ')).toBe('ABC-7');
    expect(normalizeWorkKey('AB_2C-10')).toBe('AB_2C-10');
  });

  it('takes a GitHub key and lower-cases owner and repo', () => {
    expect(normalizeWorkKey('2lab-ai/soma-work#1234')).toBe('2lab-ai/soma-work#1234');
    expect(normalizeWorkKey('2lab-ai/Soma-Work#12')).toBe('2lab-ai/soma-work#12');
    expect(normalizeWorkKey('Org.Name/repo_x.js#3')).toBe('org.name/repo_x.js#3');
  });

  it('reads a GitHub issue or pull URL as its key (issues and PRs share the number space)', () => {
    expect(normalizeWorkKey('https://github.com/2lab-ai/soma-work/pull/1380')).toBe('2lab-ai/soma-work#1380');
    expect(normalizeWorkKey('https://github.com/2lab-ai/Soma-Work/issues/1379#issuecomment-1')).toBe(
      '2lab-ai/soma-work#1379',
    );
  });

  it('refuses anything else', () => {
    for (const bad of [
      'abc',
      '1234',
      'ABC-0',
      'PTN-',
      '-12',
      'soma-work#12',
      '2lab-ai/soma-work#0',
      '#12',
      'a/b/c#1',
      '',
    ]) {
      expect(normalizeWorkKey(bad)).toBeUndefined();
    }
  });
});

describe('parseWorkKeys', () => {
  it('normalizes, keeps the first spelling once, and lists what it refused', () => {
    expect(parseWorkKeys(['abc-1', 'ABC-1', '2lab-ai/Soma-Work#2', 'nope', 7])).toEqual({
      keys: ['ABC-1', '2lab-ai/soma-work#2'],
      invalid: ['nope', '7'],
    });
  });

  it('accepts one comma- or space-separated string', () => {
    expect(parseWorkKeys('ABC-1, ABC-2  2lab-ai/soma-work#3')).toEqual({
      keys: ['ABC-1', 'ABC-2', '2lab-ai/soma-work#3'],
      invalid: [],
    });
  });

  it('a missing list is an empty one', () => {
    expect(parseWorkKeys(undefined)).toEqual({ keys: [], invalid: [] });
  });

  it('caps the list', () => {
    expect(WORK_KEYS_MAX).toBe(50);
  });
});

/**
 * Work-queue keys (.prd/36 D10): a Jira key or a GitHub `owner/repo#n` — nothing else enters a queue.
 */
import { describe, expect, it } from 'vitest';
import { keysInText, normalizeWorkKey, parseWorkKeys, WORK_KEYS_MAX } from './keys';

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

describe('keysInText — the work a person names in a request (.prd/36 v2 D12)', () => {
  it('reads GitHub links (Slack <url|label> form too), refs, Jira links and bare upper-case Jira keys, in order', () => {
    expect(
      keysInText(
        'ABC-12: 이거 봐줘 <https://github.com/Acme/Shop/pull/841|github.com/Acme/Shop/pull/841> ' +
          'and 2lab-ai/soma-work#9, https://example.atlassian.net/browse/ops-7',
      ),
    ).toEqual(['ABC-12', 'acme/shop#841', '2lab-ai/soma-work#9', 'OPS-7']);
  });

  it('each key once', () => {
    expect(keysInText('[ABC-1] fix ABC-1 https://github.com/a/b/issues/3 a/b#3')).toEqual(['ABC-1', 'a/b#3']);
  });

  it('is not fooled by tokens that only look like a Jira key, or by lower case prose', () => {
    expect(keysInText('UTF-8 SHA-256 CVE-2024-1234 GPT-5 ISO-8601 my-1 step-2')).toEqual([]);
    // Review (2026-11-26): quarters, halves, fiscal years, weeks, phases, versions — not work keys.
    expect(keysInText('Q4-2026 H2-2026 FY-2026 WEEK-48 PHASE-2 R2-3 K8S-1 SPRINT-12 STEP-3 PART-2 V-2')).toEqual([]);
  });

  it('a Jira link keeps a project with a digit (the link says it is a key)', () => {
    expect(keysInText('https://example.atlassian.net/browse/K8S-12')).toEqual(['K8S-12']);
  });

  it('no text, no keys', () => {
    expect(keysInText(undefined)).toEqual([]);
    expect(keysInText('오늘 리포트 써줘')).toEqual([]);
  });

  it('at most WORK_KEYS_MAX', () => {
    const many = Array.from({ length: 60 }, (_, i) => `ABC-${i + 1}`).join(' ');
    expect(keysInText(many)).toHaveLength(WORK_KEYS_MAX);
  });
});

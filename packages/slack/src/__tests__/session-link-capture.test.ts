/**
 * 세션 링크 자동 기록 (SSOT 2026-11-02) — finding the links a conversation names.
 *
 *   A1  every issue, PR and wiki URL in a text, in order, each once (canonical: /pull/12/files is /pull/12)
 *   A2  Slack mrkdwn (<url|label>), Markdown ([label](url)) and trailing punctuation are not part of a URL
 *   A3  other URLs (a repo, a commit, a blob, a search) are not links; at most MAX_LINKS_PER_TEXT per text
 *   A4  a `gh pr|issue create` call whose output ends with a GitHub PR or issue URL created it; `gh pr view` / `edit`
 *       print one too and did not; a listing or an error did not
 *   A5  code (fenced, inline) and quotes are not what a text says; the canonical URL; a pathological URL is linear
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalLinkUrl,
  classifyLinkUrl,
  isCreateCommand,
  linksCreatedByTools,
  linksInText,
  MAX_LINKS_PER_TEXT,
} from '../session-link-capture';

describe('linksInText', () => {
  it('A1 — every issue, PR and wiki URL, in order, each once', () => {
    const text = [
      'PR 올렸습니다: https://github.com/2lab-ai/soma-work/pull/776',
      '관련 이슈 https://github.com/2lab-ai/soma-work/issues/41 와 https://2lab.atlassian.net/browse/PAY-12',
      '설계: https://2lab.atlassian.net/wiki/spaces/PAY/pages/123456/Payment+Form+Design',
      '파일 보기 https://github.com/2lab-ai/soma-work/pull/776/files',
      'Linear https://linear.app/acme/issue/eng-42/fix, Notion https://www.notion.so/acme/Plan-abc123',
      'MR https://gitlab.com/acme/group/app/-/merge_requests/9',
    ].join('\n');
    expect(linksInText(text).map((l) => [l.type, l.provider, l.label, l.url])).toEqual([
      ['pr', 'github', 'PR #776', 'https://github.com/2lab-ai/soma-work/pull/776'],
      ['issue', 'github', '#41', 'https://github.com/2lab-ai/soma-work/issues/41'],
      ['issue', 'jira', 'PAY-12', 'https://2lab.atlassian.net/browse/PAY-12'],
      [
        'doc',
        'confluence',
        'Confluence',
        'https://2lab.atlassian.net/wiki/spaces/PAY/pages/123456/Payment+Form+Design',
      ],
      ['issue', 'linear', 'ENG-42', 'https://linear.app/acme/issue/eng-42'],
      ['doc', 'unknown', 'Notion', 'https://www.notion.so/acme/Plan-abc123'],
      ['pr', 'unknown', 'MR !9', 'https://gitlab.com/acme/group/app/-/merge_requests/9'],
    ]);
  });

  it('A2 — Slack and Markdown wrappers and trailing punctuation are not part of the URL', () => {
    const text =
      'see <https://github.com/a/b/pull/1|PR #1>, [이슈](https://github.com/a/b/issues/2). ' +
      'and <https://acme.atlassian.net/browse/OPS-3>! also https://github.com/a/b/pull/4.';
    expect(linksInText(text).map((l) => l.url)).toEqual([
      'https://github.com/a/b/pull/1',
      'https://github.com/a/b/issues/2',
      'https://acme.atlassian.net/browse/OPS-3',
      'https://github.com/a/b/pull/4',
    ]);
  });

  it('A3 — other URLs are not links; a long list is cut', () => {
    const others =
      'https://github.com/a/b https://github.com/a/b/commit/abc https://github.com/a/b/blob/main/x.ts ' +
      'https://github.com/a/b/pulls?q=is%3Aopen https://example.com/browse/X-1 http://github.com/a/b/pull/9x';
    expect(linksInText(others)).toEqual([]);
    expect(linksInText(undefined)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `https://github.com/a/b/pull/${i + 1}`).join(' ');
    expect(linksInText(many)).toHaveLength(MAX_LINKS_PER_TEXT);
    expect(classifyLinkUrl('https://github.com/a/b/issues/7#issuecomment-1')?.url).toBe(
      'https://github.com/a/b/issues/7',
    );
  });
});

describe('linksCreatedByTools', () => {
  it('A4 — only a create call counts: the last line of its output is the new URL', () => {
    const results = [
      {
        toolUseId: 'c1',
        toolName: 'Bash',
        result: 'Creating pull request for feat/x into main in a/b\n\nhttps://github.com/a/b/pull/12\n',
      },
      { toolUseId: 'c2', toolName: 'Bash', result: [{ type: 'text', text: 'https://github.com/a/b/issues/34' }] },
      // gh pr view --json url -q .url / gh pr edit print a lone URL too — not a creation.
      { toolUseId: 'v1', toolName: 'Bash', result: 'https://github.com/a/b/pull/40' },
      // A listing names PRs but ends with something else.
      { toolUseId: 'c3', toolName: 'Bash', result: '#1 https://github.com/a/b/pull/1\nshowing 1' },
      { toolUseId: 'c4', toolName: 'Bash', result: 'https://github.com/a/b/pull/99', isError: true },
      { toolUseId: 'c5', toolName: 'Read', result: 'https://github.com/a/b/pull/98' },
      { toolUseId: 'c6', toolName: 'Bash', result: 'https://github.com/a/b/pull/12' },
    ];
    const creates = new Set(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    expect(linksCreatedByTools(results, creates).map((l) => [l.type, l.url])).toEqual([
      ['pr', 'https://github.com/a/b/pull/12'],
      ['issue', 'https://github.com/a/b/issues/34'],
    ]);
    expect(linksCreatedByTools(undefined, creates)).toEqual([]);
    expect(isCreateCommand('cd x && gh pr create --fill --base main')).toBe(true);
    expect(isCreateCommand('gh issue create -t t -b b')).toBe(true);
    expect(isCreateCommand('gh pr view 40 --json url -q .url')).toBe(false);
    expect(isCreateCommand('gh pr edit 40 --add-label x')).toBe(false);
    expect(isCreateCommand(undefined)).toBe(false);
  });
});

describe('what a text says', () => {
  it('A5 — code and quotes are not links; the canonical URL; a pathological URL stays linear', () => {
    const text = [
      '이번 PR: https://github.com/a/b/pull/5',
      '```',
      '#1 https://github.com/a/b/pull/1',
      '#2 https://github.com/a/b/pull/2',
      '```',
      '로그 `https://github.com/a/b/pull/3` 참고',
      '> 이전 답변: https://github.com/a/b/pull/4',
      '&gt; Slack 인용: https://github.com/a/b/pull/6',
    ].join('\n');
    expect(linksInText(text).map((l) => l.url)).toEqual(['https://github.com/a/b/pull/5']);
    expect(canonicalLinkUrl('https://github.com/a/b/pull/12/files?notification_referrer_id=x')).toBe(
      'https://github.com/a/b/pull/12',
    );
    expect(canonicalLinkUrl('https://example.com/x')).toBe('https://example.com/x');
    const t0 = Date.now();
    expect(linksInText(`https://github.com/a/b/pull/1${'.'.repeat(40_000)}`)).toEqual([]);
    expect(classifyLinkUrl(`https://github.com/a/b/pull/1${'.'.repeat(1000)}`)?.url).toBe(
      'https://github.com/a/b/pull/1',
    );
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

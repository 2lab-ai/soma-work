/**
 * 작업 카드의 연결 (SSOT 2026-11-02 goal: "작업 카드에 디폴트로 표시해야 하는 중요한 것: 연결된 이슈(지라 혹은
 * 깃허브 이슈)들과 이슈 상태, 연결된 PR들과 머지 상태, 연결된 위키들") — what the board sends per card.
 *
 *   K1  every linked issue, PR and wiki (the active ones and the history): first the current one of each kind
 *       (issue · PR · wiki), then the rest of each kind newest first — many issues never push the PR off the face
 *   K2  short references: Jira KEY-123, GitHub #N (issues and PRs), Linear KEY-123, a wiki's page title
 *   K3  status: the PR's live state (the thread's check, unless the link was re-recorded since) → the fetched state
 *       → the state recorded with the link; a merge from any of them wins (it never goes back)
 *   K4  status words and tones (PR 열림 · 초안 · 머지됨 · 닫힘; GitHub issue 열림 · 닫힘; Jira as named, toned by kind)
 */
import { describe, expect, it } from 'vitest';
import { cardLinksOf, linkState } from '../card-links';

const JIRA = 'https://acme.atlassian.net/browse/PROJ-12';
const JIRA2 = 'https://acme.atlassian.net/browse/PROJ-9';
const GH_ISSUE = 'https://github.com/acme/app/issues/41';
const PR = 'https://github.com/acme/app/pull/733';
const PR_OLD = 'https://github.com/acme/app/pull/700';
const WIKI = 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Payment+Form+Design';

describe('K1 · K2 — every linked page, in order, with a short reference', () => {
  it('the current issue, PR and wiki first; then the rest of each kind, newest first; each once', () => {
    const links = cardLinksOf({
      links: {
        issue: { url: JIRA, type: 'issue', provider: 'jira', label: 'PROJ-12' },
        pr: { url: PR, type: 'pr', provider: 'github', label: 'PR #733' },
        doc: { url: WIKI, type: 'doc', provider: 'confluence', label: 'Confluence' },
      },
      linkHistory: {
        issues: [
          { url: JIRA2, type: 'issue', provider: 'jira' },
          { url: GH_ISSUE, type: 'issue', provider: 'github' },
          { url: JIRA, type: 'issue', provider: 'jira' },
        ],
        prs: [
          { url: PR_OLD, type: 'pr', provider: 'github' },
          { url: PR, type: 'pr', provider: 'github' },
        ],
        docs: [{ url: WIKI, type: 'doc', provider: 'confluence' }],
      },
    });
    expect(links.map((l) => [l.kind, l.text])).toEqual([
      ['issue', 'PROJ-12'],
      ['pr', '#733'],
      ['wiki', 'Payment Form Design'],
      ['issue', '#41'],
      ['issue', 'PROJ-9'],
      ['pr', '#700'],
    ]);
    expect(links.map((l) => l.url)).toEqual([JIRA, PR, WIKI, GH_ISSUE, JIRA2, PR_OLD]);
  });

  it('many issues never push the PR or the wiki behind the face’s six chips; without an active one, the newest', () => {
    const issues = Array.from({ length: 25 }, (_, i) => ({
      url: `https://github.com/acme/app/issues/${i + 1}`,
      type: 'issue',
      provider: 'github',
    }));
    const links = cardLinksOf({
      linkHistory: {
        issues,
        prs: [
          { url: PR_OLD, type: 'pr', provider: 'github' },
          { url: PR, type: 'pr', provider: 'github' },
        ],
        docs: [{ url: WIKI, type: 'doc', provider: 'confluence' }],
      },
    });
    expect(links.slice(0, 3).map((l) => [l.kind, l.text])).toEqual([
      ['issue', '#25'],
      ['pr', '#733'],
      ['wiki', 'Payment Form Design'],
    ]);
    // The rest share the room left: the older PR keeps its place, the issues take the rest.
    expect(links).toHaveLength(20);
    expect(links.map((l) => l.url)).toContain(PR_OLD);
    expect(links.filter((l) => l.kind === 'issue')).toHaveLength(17);
  });

  it('a wiki is named by its title, else its page slug, else its label; an unknown link by its label', () => {
    const titled = cardLinksOf({
      links: { doc: { url: WIKI, type: 'doc', provider: 'confluence', title: '결제 폼 설계' } },
    });
    expect(titled[0].text).toBe('결제 폼 설계');
    const notion = cardLinksOf({
      links: { doc: { url: 'https://www.notion.so/acme/Plan-abc', type: 'doc', label: 'Plan' } },
    });
    expect(notion[0]).toMatchObject({ kind: 'wiki', text: 'Plan' });
    const linear = cardLinksOf({ links: { issue: { url: 'https://linear.app/acme/issue/ENG-42/x', type: 'issue' } } });
    expect(linear[0].text).toBe('ENG-42');
  });

  it('no links, nothing; a link without an http(s) URL is skipped', () => {
    expect(cardLinksOf({})).toEqual([]);
    expect(cardLinksOf({ links: { issue: { url: 'javascript:alert(1)', type: 'issue' } } })).toEqual([]);
  });
});

describe('K3 · K4 — status', () => {
  it('a PR: the live state from the thread’s check wins; then the fetched state; then the recorded one', () => {
    const live = cardLinksOf({
      links: { pr: { url: PR, type: 'pr', provider: 'github', status: 'open' } },
      actionPanel: {
        prStatus: { state: 'closed', merged: true, draft: false, fetchedForUrl: PR, linkStatusAtFetch: 'open' },
      },
    });
    expect(live[0]).toMatchObject({ status: '머지됨', tone: 'done' });
    const closed = cardLinksOf(
      {
        links: { pr: { url: PR, type: 'pr', provider: 'github', status: 'open' } },
        actionPanel: {
          prStatus: { state: 'closed', merged: false, draft: false, fetchedForUrl: PR, linkStatusAtFetch: 'open' },
        },
      },
      () => ({ status: 'open' }),
    );
    expect(closed[0]).toMatchObject({ status: '닫힘', tone: 'fail' });
    // A check made before the link was recorded again is not this link's.
    const stale = cardLinksOf({
      links: { pr: { url: PR, type: 'pr', provider: 'github', status: 'open' } },
      actionPanel: {
        prStatus: { state: 'closed', merged: false, draft: false, fetchedForUrl: PR, linkStatusAtFetch: 'draft' },
      },
    });
    expect(stale[0]).toMatchObject({ status: '열림', tone: 'run' });
    // A live check for another URL is not this PR's.
    const other = cardLinksOf({
      links: { pr: { url: PR, type: 'pr', provider: 'github', status: 'open' } },
      actionPanel: { prStatus: { state: 'merged', merged: true, draft: false, fetchedForUrl: PR_OLD } },
    });
    expect(other[0]).toMatchObject({ status: '열림', tone: 'run' });
    const fetched = cardLinksOf(
      { links: { pr: { url: PR, type: 'pr', provider: 'github', status: 'open' } } },
      (url) => (url === PR ? { status: 'merged', title: 'feat: 결제 폼' } : undefined),
    );
    expect(fetched[0]).toMatchObject({ status: '머지됨', tone: 'done', title: 'feat: 결제 폼' });
  });

  it('a merge wins from any source: a live check made before the merge does not hide it', () => {
    const links = cardLinksOf(
      {
        links: { pr: { url: PR, type: 'pr', provider: 'github', status: 'open' } },
        actionPanel: {
          prStatus: { state: 'open', merged: false, draft: false, fetchedForUrl: PR, linkStatusAtFetch: 'open' },
        },
      },
      (url) => (url === PR ? { status: 'merged' } : undefined),
    );
    expect(links[0]).toMatchObject({ status: '머지됨', tone: 'done' });
    const recorded = cardLinksOf({
      links: { pr: { url: PR, type: 'pr', provider: 'github', status: 'merged' } },
      actionPanel: {
        prStatus: { state: 'open', merged: false, draft: false, fetchedForUrl: PR, linkStatusAtFetch: 'merged' },
      },
    });
    expect(recorded[0]).toMatchObject({ status: '머지됨', tone: 'done' });
  });

  it('an issue: the fetched state, else the recorded one; a wiki has none', () => {
    const links = cardLinksOf(
      {
        links: {
          issue: { url: JIRA, type: 'issue', provider: 'jira', status: 'To Do' },
          doc: { url: WIKI, type: 'doc', provider: 'confluence' },
        },
        linkHistory: { issues: [{ url: GH_ISSUE, type: 'issue', provider: 'github', status: 'closed' }] },
      },
      (url) => (url === JIRA ? { status: 'In Progress' } : undefined),
    );
    expect(links.map((l) => [l.text, l.status, l.tone])).toEqual([
      ['PROJ-12', 'In Progress', 'run'],
      ['Payment Form Design', undefined, undefined],
      ['#41', '닫힘', 'done'],
    ]);
  });

  it('words and tones', () => {
    expect(linkState('pr', 'OPEN')).toEqual({ status: '열림', tone: 'run' });
    expect(linkState('pr', 'draft')).toEqual({ status: '초안' });
    expect(linkState('pr', 'closed')).toEqual({ status: '닫힘', tone: 'fail' });
    expect(linkState('issue', 'open')).toEqual({ status: '열림', tone: 'run' });
    expect(linkState('issue', 'Done')).toEqual({ status: 'Done', tone: 'done' });
    expect(linkState('issue', '진행 중')).toEqual({ status: '진행 중', tone: 'run' });
    expect(linkState('issue', 'In Review')).toEqual({ status: 'In Review', tone: 'wait' });
    expect(linkState('issue', 'Backlog')).toEqual({ status: 'Backlog' });
    expect(linkState('issue', '')).toEqual({});
    expect(linkState('issue', undefined)).toEqual({});
  });
});

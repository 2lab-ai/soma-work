/**
 * .prd/29 §6 — the 변경점 tab draws the session's issue tree in place of the PR list: issues (GitHub, Jira, internal)
 * with their PRs under them, every node with children folds, the head folds the whole tree, a PR row still picks that
 * PR's files, a collected PR the tree lacks sits under the representative issue, and a push repaints only on a change.
 */
import { describe, expect, it } from 'vitest';
import { CODE_CHANGES_CSS, CODE_CHANGES_JS } from '../code-changes-client';

type El = { innerHTML: string; _chgHtml?: string; querySelectorAll?: () => unknown[] };
type Api = {
  chgIssueForest: (view: unknown, doc: unknown) => Array<Record<string, any>>;
  chgIssueTreeHtml: (doc: unknown) => string;
  chgPaint: () => void;
  chgNoteTree: () => void;
  chgOnClick: (e: unknown) => void;
  state: () => Record<string, any>;
  setState: (s: Record<string, any>) => void;
  setTree: (t: unknown) => void;
};

const GH = 'https://github.com/acme/web';
function load(el: El, tree?: unknown): Api {
  const document = { getElementById: (id: string) => (id === 'panel-changes' ? el : null) };
  const fn = new Function(
    'document',
    'initialTree',
    `var _sessionCache = { k1: { issueTree: initialTree } }; var panelSessionKey = 'k1';
    ${CODE_CHANGES_JS}
    return { chgIssueForest, chgIssueTreeHtml, chgPaint, chgNoteTree, chgOnClick,
      state: function() { return _chg; }, setState: function(s) { _chg = s; },
      setTree: function(t) { _sessionCache.k1 = { issueTree: t }; } };`,
  );
  return fn(document, tree) as Api;
}
const pr = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `acme/web#${n}`,
  url: `${GH}/pull/${n}`,
  repo: 'acme/web',
  number: n,
  title: `PR ${n}`,
  state: 'merged',
  additions: 10 * n,
  deletions: n,
  changedFiles: n,
  files: [],
  ...extra,
});
const DOC = {
  version: 1,
  conversationId: 'c1',
  updatedAt: 1,
  checkouts: [],
  prs: [pr(1), pr(2, { state: 'open' }), pr(3)],
  counted: {},
};
const id = (path: string) => `${GH}/${path}`.toLowerCase();
const TREE = {
  nodes: [
    {
      id: id('issues/10'),
      kind: 'issue',
      source: 'github',
      url: `${GH}/issues/10`,
      label: '#10',
      title: 'EPIC',
      status: 'open',
      placed: 'default',
    },
    {
      id: id('issues/11'),
      kind: 'issue',
      source: 'github',
      url: `${GH}/issues/11`,
      title: 'collector',
      status: 'closed',
      parent: id('issues/10'),
      placed: 'sub-issue',
    },
    { id: id('pull/1'), kind: 'pr', source: 'github', url: `${GH}/pull/1`, parent: id('issues/11'), placed: 'closes' },
    { id: id('pull/2'), kind: 'pr', source: 'github', url: `${GH}/pull/2`, parent: id('pull/1'), placed: 'stack' },
    { id: 'internal:2', kind: 'issue', source: 'internal', title: '조사', placed: 'model' },
    {
      id: 'https://acme.atlassian.net/browse/web-7',
      kind: 'issue',
      source: 'jira',
      url: 'https://acme.atlassian.net/browse/WEB-7',
      title: '<b>jira</b>',
      placed: 'model',
    },
    {
      id: id('pull/9'),
      kind: 'pr',
      source: 'github',
      url: `${GH}/pull/9`,
      title: 'older PR',
      status: 'closed',
      parent: 'internal:2',
      placed: 'model',
    },
  ],
};
/** Rows as "depth kind mark/num title" lines, in order. */
const rows = (html: string) =>
  [...html.matchAll(/class="chg-inode chg-(issue|pr)[^"]*" style="--chg-depth:(\d+)" data-chg-node="([^"]+)"/g)].map(
    (m) => `${m[2]} ${m[1]} ${m[3].replace(`${GH}/`.toLowerCase(), '')}`,
  );

describe('the 변경점 tab’s issue tree', () => {
  it('nests issues and PRs as the tree says; a collected PR the tree lacks goes under the representative issue', () => {
    const api = load({ innerHTML: '' }, TREE);
    api.setState({ ...api.state(), cid: 'c1', doc: DOC, state: 'ok' });
    const html = api.chgIssueTreeHtml(DOC);
    expect(rows(html)).toEqual([
      '0 issue issues/10',
      '1 issue issues/11',
      '2 pr pull/1',
      '3 pr pull/2',
      '1 pr pr:acme/web#3',
      '0 issue internal:2',
      '1 pr pull/9',
      '0 issue https://acme.atlassian.net/browse/web-7',
    ]);
    // The head: the label and how many nodes the tree has.
    expect(html).toContain('이슈 · PR <span class="chg-muted">8</span>');
    // An issue: its mark, title and state; GitHub #, Jira key, an internal one.
    expect(html).toContain(
      '<span class="chg-imark">#10</span> <span class="chg-pr-title">EPIC</span> <span class="chg-state chg-state-open">열림</span>',
    );
    expect(html).toContain('<span class="chg-imark">#11</span>');
    expect(html).toContain('<span class="chg-imark">내부</span> <span class="chg-pr-title">조사</span>');
    expect(html).toContain(
      '<span class="chg-imark">WEB-7</span> <span class="chg-pr-title">&lt;b&gt;jira&lt;/b&gt;</span>',
    );
    // A collected PR: the PR row with its numbers, pressed for its files.
    expect(html).toContain('data-chg-scope="pr:acme/web#2"');
    expect(html).toContain(
      '#2</span> <span class="chg-pr-title">PR 2</span> <span class="chg-state chg-state-open">열림</span>',
    );
    // A PR the collect did not read (older than the session): its row, no numbers, not a scope.
    expect(html).toMatch(
      /chg-pr chg-pr-bare[^>]*data-chg-node="[^"]*pull\/9"><span class="chg-icaret" aria-hidden="true"><\/span><span class="chg-pr-main"><span class="chg-pr-num">#9<\/span> <span class="chg-pr-title">older PR<\/span> <span class="chg-state chg-state-closed">닫힘<\/span>/,
    );
    expect(html).not.toContain('data-chg-scope="pr:acme/web#9"');
  });

  it('with no tree at all (a payload before it): the PRs under one stand-in issue — never a flat list', () => {
    const api = load({ innerHTML: '' }, undefined);
    expect(rows(api.chgIssueTreeHtml(DOC))).toEqual([
      '0 issue session',
      '1 pr pr:acme/web#1',
      '1 pr pr:acme/web#2',
      '1 pr pr:acme/web#3',
    ]);
  });

  it('joins a collected PR to its node as the host names it: www.github.com and a default port are the same PR', () => {
    const view = {
      nodes: [
        { id: id('issues/10'), kind: 'issue', source: 'github', url: `${GH}/issues/10`, placed: 'default' },
        {
          id: id('pull/1'),
          kind: 'pr',
          source: 'github',
          url: 'https://www.github.com/acme/web/pull/1/',
          parent: id('issues/10'),
          placed: 'default',
        },
        {
          id: id('pull/2'),
          kind: 'pr',
          source: 'github',
          url: 'https://github.com:443/acme/web/pull/2',
          parent: id('issues/10'),
          placed: 'default',
        },
      ],
    };
    const api = load({ innerHTML: '' }, view);
    const roots = api.chgIssueForest(view, { ...DOC, prs: [pr(1), pr(2)] });
    // One issue with its two PRs, each joined to its collected numbers — no second copy as a stray.
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((c: Record<string, any>) => c.pr?.id)).toEqual(['acme/web#1', 'acme/web#2']);
  });

  it('folds a node and the whole tree; a press keeps the PR scope working', () => {
    const el: El = { innerHTML: '', querySelectorAll: () => [] };
    const api = load(el, TREE);
    api.setState({ ...api.state(), cid: 'c1', doc: DOC, state: 'ok' });
    api.chgPaint();
    expect(el.innerHTML).toContain(
      `data-chg-itree="${id('issues/11')}" aria-expanded="true" aria-label="접기">▾</button>`,
    );
    const press = (sel: string, value: string) =>
      api.chgOnClick({
        target: {
          closest: () => ({ hasAttribute: (a: string) => a === sel, getAttribute: () => value, closest: () => null }),
        },
      });
    press('data-chg-itree', id('issues/11'));
    expect(rows(el.innerHTML)).toEqual([
      '0 issue issues/10',
      '1 issue issues/11',
      '1 pr pr:acme/web#3',
      '0 issue internal:2',
      '1 pr pull/9',
      '0 issue https://acme.atlassian.net/browse/web-7',
    ]);
    expect(el.innerHTML).toContain(
      `data-chg-itree="${id('issues/11')}" aria-expanded="false" aria-label="펼치기">▸</button>`,
    );
    press('data-chg-itree', '*');
    expect(rows(el.innerHTML)).toEqual([]);
    expect(el.innerHTML).toContain('data-chg-itree="*" aria-expanded="false"');
    press('data-chg-itree', '*');
    press('data-chg-scope', 'pr:acme/web#3');
    expect(api.state().scope).toBe('pr:acme/web#3');
    expect(el.innerHTML).toContain('chg-inode chg-pr on');
  });

  it('a push repaints the tab when its tree changed, and leaves it as it is otherwise', () => {
    const el: El = { innerHTML: '' };
    const api = load(el, TREE);
    api.setState({ ...api.state(), cid: 'c1', doc: DOC, state: 'ok' });
    api.chgPaint();
    const first = el.innerHTML;
    el.innerHTML = 'untouched';
    api.chgNoteTree();
    expect(el.innerHTML).toBe('untouched');
    api.setTree({
      nodes: [...TREE.nodes, { id: 'internal:3', kind: 'issue', source: 'internal', title: '새 일', placed: 'model' }],
    });
    api.chgNoteTree();
    expect(el.innerHTML).not.toBe(first);
    expect(el.innerHTML).toContain('새 일');
  });

  it('the CSS indents a node by its depth and keeps the internal mark apart', () => {
    expect(CODE_CHANGES_CSS).toContain(
      '.chg-inode { display: flex; align-items: center; gap: 4px; padding-left: calc(var(--chg-depth, 0) * 14px); }',
    );
    expect(CODE_CHANGES_CSS).toContain('.chg-issue-internal .chg-imark {');
  });
});

describe('a PR the server could not read (a private repository the host token cannot read)', () => {
  const tree = {
    nodes: [
      { id: 'internal:1', kind: 'issue', source: 'internal', title: 'work', placed: 'model' },
      {
        id: id('pull/5'),
        kind: 'pr',
        source: 'github',
        url: `${GH}/pull/5`,
        title: 'five',
        status: 'merged',
        parent: 'internal:1',
        placed: 'model',
      },
      {
        id: id('pull/9'),
        kind: 'pr',
        source: 'github',
        url: `${GH}/pull/9`,
        title: 'nine',
        status: 'merged',
        parent: 'internal:1',
        placed: 'model',
      },
    ],
  };
  const doc = {
    ...DOC,
    prs: [pr(5, { source: 'local' })],
    unreadPrs: [{ url: `${GH}/pull/9`, repo: 'acme/web', number: 9 }],
  };

  it('its row is marked 읽지 못함 with the reason; a note names it; a PR read from the session clone says so', () => {
    const el: El = { innerHTML: '' };
    const api = load(el, tree);
    api.setState({ ...api.state(), cid: 'c1', doc, state: 'ok' });
    api.chgPaint();
    const html = el.innerHTML;
    const row9 = html.split('data-chg-node="').find((r) => r.startsWith(id('pull/9'))) ?? '';
    expect(row9).toContain('class="chg-unread"');
    expect(row9).toContain('읽지 못함');
    expect(row9).toContain('호스트 토큰에 접근 권한 없음');
    const row5 = html.split('data-chg-node="').find((r) => r.startsWith(id('pull/5'))) ?? '';
    expect(row5).not.toContain('chg-unread');
    expect(row5).toContain('세션 폴더 클론의 머지 커밋에서 읽은 변경');
    expect(html).toContain('<div class="chg-note chg-note-unread">acme/web #9 — GitHub에서 읽을 수 없는 레포이고');
  });

  it('nothing unread: no mark, no note', () => {
    const el: El = { innerHTML: '' };
    const api = load(el, tree);
    api.setState({ ...api.state(), cid: 'c1', doc: { ...doc, prs: [pr(5)], unreadPrs: undefined }, state: 'ok' });
    api.chgPaint();
    expect(el.innerHTML).not.toContain('chg-unread');
    expect(el.innerHTML).not.toContain('chg-note-unread');
    expect(el.innerHTML).not.toContain('세션 폴더 클론');
  });
});

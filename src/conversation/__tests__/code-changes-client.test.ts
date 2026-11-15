/**
 * .prd/26 §4 (#1296) — the 변경점 tab's client: which files a scope shows, the repo → directory → file tree, the hunk
 * rows of the viewer, and what the tab paints (escaped).
 */
import { describe, expect, it } from 'vitest';
import { CODE_CHANGES_CSS, CODE_CHANGES_JS } from '../code-changes-client';
import { renderDashboardPage } from '../dashboard';

type Api = {
  chgFilesOf: (doc: unknown, scope: string) => Array<Record<string, any>>;
  chgCounts: (doc: unknown) => Record<string, number>;
  chgTree: (files: unknown[]) => Array<Record<string, any>>;
  chgHunkRows: (patch: string) => Array<Record<string, any>>;
  chgSummaryText: (doc: unknown) => Record<string, any>;
  chgTreeHtml: (tree: unknown[], current: string) => string;
  chgPaint: () => void;
  state: () => Record<string, any>;
  setState: (s: Record<string, any>) => void;
};

function load(el?: { innerHTML: string; _chgHtml?: string }): Api {
  const document = { getElementById: (id: string) => (id === 'panel-changes' ? el : null) };
  const fn = new Function(
    'document',
    `${CODE_CHANGES_JS}
    return { chgFilesOf, chgCounts, chgTree, chgHunkRows, chgSummaryText, chgTreeHtml, chgPaint,
      state: function() { return _chg; }, setState: function(s) { _chg = s; } };`,
  );
  return fn(document) as Api;
}

const DOC = {
  version: 1,
  conversationId: 'c1',
  updatedAt: Date.parse('2026-11-16T02:42:00Z'),
  checkouts: [
    {
      id: 'k1',
      repo: 'acme/web',
      dir: 'web',
      uncommitted: {
        files: [
          { path: 'src/conversation/dashboard.ts', status: 'modified', additions: 2, deletions: 1 },
          { path: 'notes/<b>x.md', status: 'added', additions: 3, deletions: 0 },
        ],
        additions: 5,
        deletions: 1,
      },
      committed: {
        files: [{ path: 'src/conversation/routes.ts', status: 'added', additions: 10, deletions: 0 }],
        additions: 10,
        deletions: 0,
        commits: [],
      },
    },
  ],
  prs: [
    {
      id: 'acme/web#2',
      url: 'https://github.com/acme/web/pull/2',
      repo: 'acme/web',
      number: 2,
      title: 'open one',
      state: 'open',
      additions: 4,
      deletions: 4,
      changedFiles: 1,
      files: [{ path: 'src/conversation/dashboard.ts', status: 'modified', additions: 4, deletions: 4 }],
    },
    {
      id: 'acme/api#1',
      url: 'https://github.com/acme/api/pull/1',
      repo: 'acme/api',
      number: 1,
      title: 'merged one',
      state: 'merged',
      additions: 7,
      deletions: 0,
      changedFiles: 1,
      files: [{ path: 'lib/x.go', status: 'added', additions: 7, deletions: 0 }],
    },
    {
      id: 'acme/api#9',
      url: 'https://github.com/acme/api/pull/9',
      repo: 'acme/api',
      number: 9,
      state: 'closed',
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      files: [{ path: 'lib/dead.go', status: 'added', additions: 1, deletions: 0 }],
    },
  ],
};

describe('chgFilesOf / chgCounts — scopes', () => {
  const api = load();
  it('전체 is every layer but closed PRs; one row per repo + path with its layers, +/− summed', () => {
    const all = api.chgFilesOf(DOC, 'all');
    expect(all.map((f) => `${f.repo}:${f.path}`)).toEqual([
      'acme/api:lib/x.go',
      'acme/web:notes/<b>x.md',
      'acme/web:src/conversation/dashboard.ts',
      'acme/web:src/conversation/routes.ts',
    ]);
    const dash = all.find((f) => f.path === 'src/conversation/dashboard.ts')!;
    expect(dash.layers).toEqual(['pr', 'uncommitted']);
    expect([dash.additions, dash.deletions]).toEqual([6, 5]);
  });

  it('a layer scope, and one PR (a closed PR only this way)', () => {
    expect(api.chgFilesOf(DOC, 'uncommitted').map((f) => f.path)).toEqual([
      'notes/<b>x.md',
      'src/conversation/dashboard.ts',
    ]);
    expect(api.chgFilesOf(DOC, 'merged').map((f) => f.path)).toEqual(['lib/x.go']);
    expect(api.chgFilesOf(DOC, 'pr:acme/api#9').map((f) => f.path)).toEqual(['lib/dead.go']);
    expect(api.chgCounts(DOC)).toEqual({ all: 4, uncommitted: 2, committed: 1, pr: 1, merged: 1 });
  });
});

describe('chgTree — repo → directory → file', () => {
  it('repos at the root, single-child directory chains folded, totals on every node', () => {
    const api = load();
    const tree = api.chgTree(api.chgFilesOf(DOC, 'all'));
    expect(tree.map((r) => [r.name, r.count, r.additions, r.deletions])).toEqual([
      ['acme/api', 1, 7, 0],
      ['acme/web', 3, 19, 5],
    ]);
    const web = tree[1];
    expect(web.children.map((c: any) => [c.type, c.name])).toEqual([
      ['dir', 'notes'],
      ['dir', 'src/conversation'],
    ]);
    expect(web.children[1].children.map((c: any) => c.name)).toEqual(['dashboard.ts', 'routes.ts']);
    expect(tree[0].children[0].name).toBe('lib');
  });
});

describe('chgHunkRows — GitHub-style line numbers', () => {
  it('numbers old and new lines through hunks; marks the no-newline note', () => {
    const rows = load().chgHunkRows(
      '@@ -10,3 +10,4 @@ fn\n ctx\n-old\n+new\n+more\n ctx2\n\\ No newline at end of file',
    );
    expect(rows.map((r) => [r.type, r.old, r.nu, r.text])).toEqual([
      ['hunk', '', '', '@@ -10,3 +10,4 @@ fn'],
      ['ctx', 10, 10, 'ctx'],
      ['del', 11, '', 'old'],
      ['add', '', 11, 'new'],
      ['add', '', 12, 'more'],
      ['ctx', 12, 13, 'ctx2'],
      ['note', '', '', 'No newline at end of file'],
    ]);
  });
});

describe('chgPaint — the tab', () => {
  it('summary, scope chips, PR rows and the tree; every server string escaped', () => {
    const el: { innerHTML: string; _chgHtml?: string } = { innerHTML: '' };
    const api = load(el);
    api.setState({ ...api.state(), cid: 'c1', doc: DOC, state: 'ok', scope: 'all', closed: {} });
    api.chgPaint();
    const html = el.innerHTML;
    expect(html).toContain('레포 수 <b>2</b>');
    expect(html).toContain('파일 수 <b>4</b>');
    expect(html).toContain('data-chg-scope="uncommitted"');
    expect(html).toContain('#2</span> <span class="chg-pr-title">open one');
    expect(html).toContain('머지됨');
    expect(html).toContain('&lt;b&gt;x.md');
    expect(html).not.toContain('<b>x.md');
    expect(html).toContain('data-chg-file="f:acme/web\nsrc/conversation/dashboard.ts"');
  });

  it('owner-only and empty states', () => {
    const el: { innerHTML: string; _chgHtml?: string } = { innerHTML: '' };
    const api = load(el);
    api.setState({ ...api.state(), cid: 'c1', doc: null, state: 'denied' });
    api.chgPaint();
    expect(el.innerHTML).toContain('변경점은 세션 소유자만 볼 수 있어요');
    api.setState({ ...api.state(), state: 'ok', doc: null });
    el._chgHtml = '';
    api.chgPaint();
    expect(el.innerHTML).toContain('아직 변경 기록이 없습니다');
  });

  it('a closed directory hides its children', () => {
    const api = load();
    api.setState({ ...api.state(), closed: { 'r:acme/web/notes': true } });
    const html = api.chgTreeHtml(api.chgTree(api.chgFilesOf(DOC, 'uncommitted')), '');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('x.md');
  });
});

describe('the page', () => {
  it('ships the tab between 작업 로그 and 에이전트 트리, its box, the script and the CSS', () => {
    const page = renderDashboardPage();
    expect(page).toContain("var PSEC_ORDER = ['conv', 'log', 'changes', 'tree'];");
    expect(page).toContain("{ id: 'changes', label: '변경점'");
    expect(page).toContain('id="psec-changes" slot="changes"');
    expect(page).toContain('function chgOpen(cid)');
    expect(page).toContain(CODE_CHANGES_CSS.trim().slice(0, 40));
    expect(CODE_CHANGES_JS).not.toContain('${');
  });
});

import { describe, expect, it } from 'vitest';
import {
  addInternalIssue,
  emptyIssueTree,
  ISSUE_TREE_MAX_NODES,
  issueTreeFromLinks,
  issueTreeNodeId,
  issueTreeView,
  moveIssueTreeNode,
  rebalanceIssueTree,
  removeIssueTreeNode,
  representativeIssue,
  SEED_ID,
  sanitizeIssueTree,
  upsertIssueTreeLink,
} from './issue-tree';
import type { SessionIssueTree } from './session-types';

const GH = 'https://github.com/2lab-ai/soma-work';
const issue = (n: number) => `${GH}/issues/${n}`;
const pr = (n: number) => `${GH}/pull/${n}`;
let clock = 1_000;
const now = () => ++clock;

function tree(): SessionIssueTree {
  const t = emptyIssueTree();
  rebalanceIssueTree(t, now());
  return t;
}
const add = (t: SessionIssueTree, kind: 'issue' | 'pr', url: string, extra: Record<string, unknown> = {}) => {
  const r = upsertIssueTreeLink(t, { kind, url, provider: 'github', ...extra }, now());
  rebalanceIssueTree(t, now());
  return r;
};
/** id → parent id ('' = root), the tree's shape. */
const shape = (t: SessionIssueTree) =>
  Object.fromEntries(
    t.nodes.map((n) => [
      n.id.replace(`${GH.toLowerCase()}/`, ''),
      (n.parent || '').replace(`${GH.toLowerCase()}/`, ''),
    ]),
  );
const placed = (t: SessionIssueTree, url: string) => t.nodes.find((n) => n.id === issueTreeNodeId(url))?.placed;

describe('issue tree — .prd/29 §3', () => {
  it('S1: a session with no issue has the seed — its own internal issue, titled with the session title', () => {
    const t = tree();
    expect(t.nodes.map((n) => [n.id, n.kind, n.source, n.placed])).toEqual([[SEED_ID, 'issue', 'internal', 'seed']]);
    expect(issueTreeView(t, '대시보드 개선').nodes[0]).toMatchObject({ id: SEED_ID, title: '대시보드 개선' });
    // Idempotent: a second pass changes nothing.
    const before = JSON.stringify(t);
    rebalanceIssueTree(t, now());
    expect(JSON.stringify(t)).toBe(before);
  });

  it('S2: a PR without an issue sits under the seed (no PR is a root)', () => {
    const t = tree();
    add(t, 'pr', pr(10));
    expect(shape(t)).toEqual({ [SEED_ID]: '', 'pull/10': SEED_ID });
    expect(placed(t, pr(10))).toBe('default');
  });

  it('S3: the first external issue retires the untouched seed; its PRs go under that issue', () => {
    const t = tree();
    add(t, 'pr', pr(10));
    add(t, 'issue', issue(5));
    expect(shape(t)).toEqual({ 'pull/10': 'issues/5', 'issues/5': '' });
    expect(representativeIssue(t)?.id).toBe(issueTreeNodeId(issue(5)));
  });

  it('S4: an unrelated issue (parent null) is a pinned root next to the representative', () => {
    const t = tree();
    add(t, 'issue', issue(5));
    add(t, 'issue', issue(9), { parent: null });
    expect(shape(t)).toEqual({ 'issues/5': '', 'issues/9': '' });
    expect(placed(t, issue(9))).toBe('model');
    // New PRs still go to the representative — the first external root issue.
    add(t, 'pr', pr(11));
    expect(shape(t)['pull/11']).toBe('issues/5');
  });

  it('S5: a PR that closes an issue in the tree sits under it — learned later, it moves there', () => {
    const t = tree();
    add(t, 'issue', issue(5));
    add(t, 'issue', issue(6));
    add(t, 'pr', pr(12));
    expect(shape(t)['pull/12']).toBe('issues/5');
    add(t, 'pr', pr(12), { rel: { closes: [issue(6)] } });
    expect(shape(t)['pull/12']).toBe('issues/6');
    expect(placed(t, pr(12))).toBe('closes');
    // A closing ref to an issue not in the tree is kept but does not place it.
    add(t, 'pr', pr(13), { rel: { closes: [issue(99)] } });
    expect(shape(t)['pull/13']).toBe('issues/5');
  });

  it('S6: a stacked PR (based on another session PR) sits under that PR', () => {
    const t = tree();
    add(t, 'issue', issue(5));
    add(t, 'pr', pr(20));
    add(t, 'pr', pr(21), { rel: { base: pr(20) } });
    expect(shape(t)).toMatchObject({ 'pull/20': 'issues/5', 'pull/21': 'pull/20' });
    expect(placed(t, pr(21))).toBe('stack');
    // A stack loop in the data does not survive: one of them falls back to the representative.
    add(t, 'pr', pr(20), { rel: { base: pr(21) } });
    const s = shape(t);
    expect([s['pull/20'], s['pull/21']]).toContain('issues/5');
  });

  it('S7: a sub-issue sits under its parent issue when the parent is here, else at the root', () => {
    const t = tree();
    add(t, 'issue', issue(7), { rel: { subOf: issue(1) } });
    expect(shape(t)['issues/7']).toBe('');
    add(t, 'issue', issue(1));
    expect(shape(t)).toMatchObject({ 'issues/1': '', 'issues/7': 'issues/1' });
    expect(placed(t, issue(7))).toBe('sub-issue');
  });

  it('S8: move pins a node; remove lifts its children; add_internal makes and edits a session-only issue', () => {
    const t = tree();
    add(t, 'issue', issue(5));
    add(t, 'issue', issue(6));
    add(t, 'pr', pr(30));
    expect(moveIssueTreeNode(t, pr(30), issue(6))).toEqual({ ok: true, id: issueTreeNodeId(pr(30)) });
    rebalanceIssueTree(t, now());
    expect(shape(t)['pull/30']).toBe('issues/6');
    expect(placed(t, pr(30))).toBe('model');
    // The host never moves the model's placement, even when a relation says otherwise.
    add(t, 'pr', pr(30), { rel: { closes: [issue(5)] } });
    expect(shape(t)['pull/30']).toBe('issues/6');
    // An internal issue under #5, then #6 removed: the pinned PR loses its parent and the host places it again.
    const made = addInternalIssue(t, { title: '리뷰 반영', parent: issue(5) }, now());
    expect(made).toMatchObject({ ok: true });
    const internalId = (made as { id: string }).id;
    rebalanceIssueTree(t, now());
    expect(shape(t)[internalId]).toBe('issues/5');
    expect(removeIssueTreeNode(t, issue(6))).toMatchObject({ ok: true });
    rebalanceIssueTree(t, now());
    expect(shape(t)['pull/30']).toBe('issues/5');
    expect(placed(t, pr(30))).toBe('closes');
    // add_internal with id edits it.
    expect(addInternalIssue(t, { id: internalId, status: 'closed', title: '리뷰 반영 끝' }, now())).toMatchObject({
      ok: true,
    });
    expect(t.nodes.find((n) => n.id === internalId)).toMatchObject({ title: '리뷰 반영 끝', status: 'closed' });
  });

  it('refuses what would break the tree: a root PR, a missing parent, a cycle, an untitled internal issue', () => {
    const t = tree();
    add(t, 'issue', issue(5));
    add(t, 'issue', issue(6), { parent: issue(5) });
    expect(upsertIssueTreeLink(t, { kind: 'pr', url: pr(1), parent: null }, now())).toMatchObject({ ok: false });
    expect(upsertIssueTreeLink(t, { kind: 'pr', url: pr(1), parent: issue(404) }, now())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not in the issue tree'),
    });
    expect(moveIssueTreeNode(t, issue(5), issue(6))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('under it'),
    });
    expect(moveIssueTreeNode(t, issue(5), issue(5))).toMatchObject({ ok: false });
    expect(addInternalIssue(t, { title: '  ' }, now())).toMatchObject({ ok: false });
    expect(moveIssueTreeNode(t, issue(404), null)).toMatchObject({ ok: false });
    // Nothing was added by the refusals.
    expect(t.nodes.map((n) => n.id)).toEqual([issueTreeNodeId(issue(5)), issueTreeNodeId(issue(6))]);
  });

  it('the seed stays when the model kept something under it, or named it', () => {
    const kept = tree();
    add(kept, 'pr', pr(10), { parent: SEED_ID });
    add(kept, 'issue', issue(5));
    expect(shape(kept)).toMatchObject({ [SEED_ID]: '', 'pull/10': SEED_ID, 'issues/5': '' });
    const named = tree();
    addInternalIssue(named, { id: SEED_ID, title: '탐색' }, now());
    add(named, 'issue', issue(5));
    expect(named.nodes.map((n) => n.id)).toContain(SEED_ID);
    // The representative is still the first external root issue.
    expect(representativeIssue(named)?.id).toBe(issueTreeNodeId(issue(5)));
  });

  it('ids: one URL, one node — case, query, hash and a trailing slash do not make a second', () => {
    expect(issueTreeNodeId('https://GitHub.com/2lab-ai/Soma-Work/pull/7/?x=1#y')).toBe(issueTreeNodeId(pr(7)));
    expect(issueTreeNodeId('https://acme.atlassian.net/browse/PROJ-12')).toBe(
      'https://acme.atlassian.net/browse/PROJ-12',
    );
    expect(issueTreeNodeId('internal:3')).toBe('internal:3');
    const t = tree();
    add(t, 'pr', pr(7), { title: 'a' });
    add(t, 'pr', 'https://github.com/2lab-ai/soma-work/pull/7/', { title: 'b', status: 'merged' });
    expect(t.nodes.filter((n) => n.kind === 'pr')).toHaveLength(1);
    expect(t.nodes.find((n) => n.kind === 'pr')).toMatchObject({ title: 'b', status: 'merged' });
  });

  it('the cap: past the limit the oldest PRs the host placed go first', () => {
    const t = tree();
    add(t, 'issue', issue(1));
    for (let i = 0; i < ISSUE_TREE_MAX_NODES + 5; i++) {
      upsertIssueTreeLink(t, { kind: 'pr', url: pr(1000 + i) }, now());
    }
    rebalanceIssueTree(t, now());
    expect(t.nodes.length).toBe(ISSUE_TREE_MAX_NODES);
    expect(t.nodes.some((n) => n.id === issueTreeNodeId(pr(1000)))).toBe(false);
    expect(t.nodes.some((n) => n.id === issueTreeNodeId(issue(1)))).toBe(true);
  });

  it('a session made before the tree: its link records become one (issues roots, PRs under the representative)', () => {
    const t = issueTreeFromLinks(
      {
        issues: [{ url: issue(1294), type: 'issue', provider: 'github', label: '#1294', status: 'closed' }],
        prs: [
          { url: pr(1299), type: 'pr', provider: 'github', title: 'collector', status: 'merged' },
          { url: pr(1300), type: 'pr', provider: 'github' },
        ],
        docs: [],
      },
      now(),
    );
    expect(shape(t)).toEqual({ 'issues/1294': '', 'pull/1299': 'issues/1294', 'pull/1300': 'issues/1294' });
    expect(issueTreeFromLinks(undefined, now()).nodes.map((n) => n.id)).toEqual([SEED_ID]);
  });

  it('the view: nodes in the order they came, the fields the model and the dashboard read', () => {
    const t = tree();
    add(t, 'pr', pr(10), { title: 'PR ten', status: 'open', label: 'PR #10' });
    const v = issueTreeView(t, 'S');
    expect(v.nodes).toEqual([
      { id: SEED_ID, kind: 'issue', source: 'internal', title: 'S', placed: 'seed' },
      {
        id: issueTreeNodeId(pr(10)),
        kind: 'pr',
        source: 'github',
        url: pr(10),
        label: 'PR #10',
        title: 'PR ten',
        status: 'open',
        parent: SEED_ID,
        placed: 'default',
      },
    ]);
  });

  it('sanitize: a broken node is dropped, the rest of the stored tree is kept', () => {
    const t = tree();
    add(t, 'pr', pr(10), { rel: { closes: [issue(1)] } });
    const stored = JSON.parse(JSON.stringify(t));
    stored.nodes.push({ id: 'x', kind: 'epic', source: 'github', placed: 'default', addedAt: 1 });
    stored.nodes.push({ id: issueTreeNodeId(pr(10)), kind: 'pr', source: 'github', placed: 'default', addedAt: 1 });
    stored.nodes.push('junk');
    const back = sanitizeIssueTree(stored) as SessionIssueTree;
    expect(back.nodes.map((n) => n.id)).toEqual(t.nodes.map((n) => n.id));
    expect(back.nodes[1].rel).toEqual({ closes: [issueTreeNodeId(issue(1))] });
    expect(sanitizeIssueTree(null)).toBeUndefined();
    expect(sanitizeIssueTree({ nodes: 'no' })).toBeUndefined();
  });
});

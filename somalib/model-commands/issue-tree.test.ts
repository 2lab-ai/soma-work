import { describe, expect, it } from 'vitest';
import {
  addInternalIssue,
  emptyIssueTree,
  ISSUE_TREE_MAX_NODES,
  issueTreeFromLinks,
  issueTreeFromView,
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
    // A fresh read is the truth (review of #1321): the body now closes #5 — the PR moves; no closing ref — it clears.
    add(t, 'pr', pr(12), { rel: { closes: [issue(5)] } });
    expect(t.nodes.find((n) => n.id === issueTreeNodeId(pr(12)))?.rel).toEqual({ closes: [issueTreeNodeId(issue(5))] });
    add(t, 'pr', pr(12), { rel: { closes: [] } });
    expect(t.nodes.find((n) => n.id === issueTreeNodeId(pr(12)))?.rel).toBeUndefined();
    expect(placed(t, pr(12))).toBe('default');
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

  it('remove lifts the children one level and keeps them there (a relation naming the removed node is dropped)', () => {
    const t = tree();
    add(t, 'issue', issue(1));
    add(t, 'issue', issue(2), { rel: { subOf: issue(1) } });
    add(t, 'issue', issue(3), { rel: { subOf: issue(2) } });
    add(t, 'pr', pr(40), { rel: { closes: [issue(3)] } });
    expect(shape(t)).toMatchObject({ 'issues/2': 'issues/1', 'issues/3': 'issues/2', 'pull/40': 'issues/3' });
    removeIssueTreeNode(t, issue(2));
    rebalanceIssueTree(t, now());
    expect(shape(t)).toMatchObject({ 'issues/1': '', 'issues/3': 'issues/1', 'pull/40': 'issues/3' });
    expect(placed(t, issue(3))).toBe('model');
    expect(t.nodes.find((n) => n.id === issueTreeNodeId(issue(3)))?.rel).toBeUndefined();
  });

  it('S7: a sub-issue sits under its parent issue when the parent is here, else at the root', () => {
    const t = tree();
    add(t, 'issue', issue(7), { rel: { subOf: issue(1) } });
    expect(shape(t)['issues/7']).toBe('');
    add(t, 'issue', issue(1));
    expect(shape(t)).toMatchObject({ 'issues/1': '', 'issues/7': 'issues/1' });
    expect(placed(t, issue(7))).toBe('sub-issue');
    // A fresh read with no parent clears the relation: the issue is a root again.
    add(t, 'issue', issue(7), { rel: { subOf: null } });
    expect(shape(t)['issues/7']).toBe('');
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

  it('the seed gives way to an internal issue the model made too: one issue, the model’s, takes the PRs', () => {
    const t = tree();
    add(t, 'pr', pr(10));
    const made = addInternalIssue(t, { title: '로그인 오류 조사' }, now());
    rebalanceIssueTree(t, now());
    const id = (made as { id: string }).id;
    expect(shape(t)).toEqual({ [id]: '', 'pull/10': id });
    expect(id).not.toBe(SEED_ID);
  });

  it('the seed stays while every other issue sits under a PR: the tree keeps a root issue, no PR becomes a root', () => {
    const t = tree();
    add(t, 'pr', pr(10));
    // The model files a follow-up under the PR (its only parent choice besides the seed).
    expect(addInternalIssue(t, { title: '후속 조사', parent: pr(10) }, now())).toMatchObject({ ok: true });
    rebalanceIssueTree(t, now());
    const followUp = t.nodes.find((n) => n.title === '후속 조사')?.id as string;
    expect(shape(t)).toEqual({ [SEED_ID]: '', 'pull/10': SEED_ID, [followUp]: 'pull/10' });
    const before = JSON.stringify(t);
    rebalanceIssueTree(t, now());
    expect(JSON.stringify(t)).toBe(before);
  });

  it('removing the last root issue while the others sit under PRs brings a seed back to hold the PRs', () => {
    const t = tree();
    add(t, 'issue', issue(5));
    add(t, 'pr', pr(10));
    expect(shape(t)).toEqual({ 'issues/5': '', 'pull/10': 'issues/5' });
    addInternalIssue(t, { title: '후속 조사', parent: pr(10) }, now());
    expect(removeIssueTreeNode(t, issue(5))).toMatchObject({ ok: true });
    rebalanceIssueTree(t, now());
    const followUp = t.nodes.find((n) => n.title === '후속 조사')?.id as string;
    expect(shape(t)).toEqual({ [SEED_ID]: '', 'pull/10': SEED_ID, [followUp]: 'pull/10' });
    expect(t.nodes.filter((n) => n.kind === 'pr' && !n.parent)).toEqual([]);
  });

  it('a learned closing ref never puts a PR under its own descendant, nor moves the model’s node (both orders)', () => {
    // Order 1: issues A, B, then PR P (P defaults under A); the model puts B under P; GitHub then says P closes B.
    const t = tree();
    add(t, 'issue', issue(1));
    add(t, 'issue', issue(2));
    add(t, 'pr', pr(10));
    expect(moveIssueTreeNode(t, issue(2), pr(10))).toMatchObject({ ok: true });
    rebalanceIssueTree(t, now());
    add(t, 'pr', pr(10), { rel: { closes: [issue(2)] } });
    expect(shape(t)).toEqual({ 'issues/1': '', 'issues/2': 'pull/10', 'pull/10': 'issues/1' });
    expect(placed(t, issue(2))).toBe('model');
    // Order 2: PR P first, then the issues.
    const u = tree();
    add(u, 'pr', pr(10));
    add(u, 'issue', issue(1));
    add(u, 'issue', issue(2));
    expect(moveIssueTreeNode(u, issue(2), pr(10))).toMatchObject({ ok: true });
    rebalanceIssueTree(u, now());
    add(u, 'pr', pr(10), { rel: { closes: [issue(2)] } });
    expect(shape(u)).toMatchObject({ 'issues/2': 'pull/10', 'pull/10': 'issues/1' });
    expect(placed(u, issue(2))).toBe('model');
    // The closing ref is skipped, not followed and then undone: the PR takes its next relation (its stack base).
    const w = tree();
    add(w, 'issue', issue(1));
    add(w, 'issue', issue(2));
    add(w, 'pr', pr(9));
    add(w, 'pr', pr(10));
    expect(moveIssueTreeNode(w, issue(2), pr(10))).toMatchObject({ ok: true });
    rebalanceIssueTree(w, now());
    add(w, 'pr', pr(10), { rel: { closes: [issue(2)], base: pr(9) } });
    expect(shape(w)).toMatchObject({ 'issues/2': 'pull/10', 'pull/10': 'pull/9', 'pull/9': 'issues/1' });
    expect(placed(w, pr(10))).toBe('stack');
    // A cycle in stored data through a host edge: the host re-places its PR; the model's issue keeps its place.
    const broken = sanitizeIssueTree({
      nodes: [
        { id: issueTreeNodeId(issue(1)), kind: 'issue', source: 'github', placed: 'default', addedAt: 1 },
        {
          id: issueTreeNodeId(issue(2)),
          kind: 'issue',
          source: 'github',
          parent: issueTreeNodeId(pr(10)),
          placed: 'model',
          addedAt: 2,
        },
        {
          id: issueTreeNodeId(pr(10)),
          kind: 'pr',
          source: 'github',
          parent: issueTreeNodeId(issue(2)),
          placed: 'stack',
          addedAt: 3,
        },
      ],
      nextInternal: 1,
    }) as SessionIssueTree;
    rebalanceIssueTree(broken, now());
    expect(shape(broken)).toEqual({ 'issues/1': '', 'issues/2': 'pull/10', 'pull/10': 'issues/1' });
  });

  it('a status-only edit leaves the seed the seed, titled with the session title', () => {
    const t = tree();
    expect(addInternalIssue(t, { id: SEED_ID, status: 'closed' }, now())).toMatchObject({ ok: true });
    rebalanceIssueTree(t, now());
    expect(issueTreeView(t, '대시보드 개선').nodes[0]).toMatchObject({
      id: SEED_ID,
      title: '대시보드 개선',
      status: 'closed',
      placed: 'seed',
    });
  });

  it('a PR-only link history at the cap leaves room for the seed: the tree stays within the cap', () => {
    const prs = Array.from({ length: ISSUE_TREE_MAX_NODES + 5 }, (_, i) => ({
      url: pr(3000 + i),
      type: 'pr' as const,
      provider: 'github' as const,
    }));
    const t = issueTreeFromLinks({ issues: [], prs, docs: [] }, now());
    expect(t.nodes.length).toBe(ISSUE_TREE_MAX_NODES);
    expect(t.nodes[0]).toMatchObject({ id: SEED_ID, placed: 'seed' });
    expect(t.nodes.filter((n) => n.kind === 'pr' && !n.parent)).toEqual([]);
    // Save and load keep every node.
    expect(sanitizeIssueTree(JSON.parse(JSON.stringify(t)))?.nodes.length).toBe(ISSUE_TREE_MAX_NODES);
  });

  it('merged is final: a late or cached read of an earlier state does not undo it', () => {
    const t = tree();
    add(t, 'pr', pr(10), { status: 'merged' });
    add(t, 'pr', pr(10), { status: 'open' });
    expect(t.nodes.find((n) => n.id === issueTreeNodeId(pr(10)))?.status).toBe('merged');
    // An issue's state still follows its reads.
    add(t, 'issue', issue(5), { status: 'closed' });
    add(t, 'issue', issue(5), { status: 'open' });
    expect(t.nodes.find((n) => n.id === issueTreeNodeId(issue(5)))?.status).toBe('open');
  });

  it('a moved seed keeps the session title (it has none of its own)', () => {
    // A fresh session: the model pins the seed at the root (move internal:1, parent null).
    const t = tree();
    expect(moveIssueTreeNode(t, SEED_ID, null)).toMatchObject({ ok: true });
    rebalanceIssueTree(t, now());
    expect(issueTreeView(t, '대시보드 개선').nodes.find((n) => n.id === SEED_ID)).toMatchObject({
      title: '대시보드 개선',
      placed: 'model',
    });
    // Pinned, it no longer gives way to an external issue.
    add(t, 'issue', issue(5));
    expect(t.nodes.map((n) => n.id)).toContain(SEED_ID);
  });

  it('a stack retargeted in one read settles in one pass, whatever the order (A then B: B was on A, now A on B)', () => {
    const t = tree();
    add(t, 'issue', issue(5));
    add(t, 'pr', pr(10));
    add(t, 'pr', pr(11), { rel: { base: pr(10) } });
    expect(shape(t)).toMatchObject({ 'pull/10': 'issues/5', 'pull/11': 'pull/10' });
    // One collect: #11 now targets main, #10 is rebased onto #11's branch.
    upsertIssueTreeLink(t, { kind: 'pr', url: pr(10), rel: { base: pr(11) } }, now());
    upsertIssueTreeLink(t, { kind: 'pr', url: pr(11), rel: { base: null } }, now());
    rebalanceIssueTree(t, now());
    expect(shape(t)).toMatchObject({ 'pull/11': 'issues/5', 'pull/10': 'pull/11' });
    expect(placed(t, pr(10))).toBe('stack');
    const once = JSON.stringify(t);
    rebalanceIssueTree(t, now());
    expect(JSON.stringify(t)).toBe(once);
  });

  it('an old session with current links and no history: its tree holds them (issue at the root, the PR under it)', () => {
    const t = issueTreeFromLinks(undefined, now(), {
      issue: { url: issue(7), type: 'issue', provider: 'github' },
      pr: { url: pr(8), type: 'pr', provider: 'github' },
    });
    expect(shape(t)).toEqual({ 'issues/7': '', 'pull/8': 'issues/7' });
  });

  it('relations from an older read (the other reader, slower) do not replace a newer read’s', () => {
    const t = tree();
    add(t, 'issue', issue(1));
    add(t, 'issue', issue(2));
    upsertIssueTreeLink(t, { kind: 'pr', url: pr(10), rel: { closes: [issue(2)] }, relReadAt: 200 }, now());
    rebalanceIssueTree(t, now());
    expect(shape(t)['pull/10']).toBe('issues/2');
    // The collect that began earlier lands now with the old body's ref: ignored.
    upsertIssueTreeLink(t, { kind: 'pr', url: pr(10), rel: { closes: [issue(1)] }, relReadAt: 100 }, now());
    rebalanceIssueTree(t, now());
    expect(shape(t)['pull/10']).toBe('issues/2');
    // A newer read moves it.
    upsertIssueTreeLink(t, { kind: 'pr', url: pr(10), rel: { closes: [issue(1)] }, relReadAt: 300 }, now());
    rebalanceIssueTree(t, now());
    expect(shape(t)['pull/10']).toBe('issues/1');
    // Saved and loaded, the read time stays (and never reaches the view).
    const loaded = sanitizeIssueTree(JSON.parse(JSON.stringify(t)));
    expect(loaded?.nodes.find((n) => n.id === issueTreeNodeId(pr(10)))?.relReadAt).toBe(300);
    expect(issueTreeView(t).nodes.find((n) => n.id === issueTreeNodeId(pr(10)))).not.toHaveProperty('relReadAt');
  });

  it('the representative is the same in the preview rebuilt from the view (the order the issues came)', () => {
    // A (external root) ← P ← X (the model's follow-up under P); A removed: a new seed stands in, first in the array
    // but newer than X. The model names the seed, then moves X to the root.
    const t = tree();
    add(t, 'issue', issue(1));
    add(t, 'pr', pr(10));
    const x = (addInternalIssue(t, { title: '후속', parent: pr(10) }, now()) as { id: string }).id;
    rebalanceIssueTree(t, now());
    removeIssueTreeNode(t, issue(1));
    rebalanceIssueTree(t, now());
    const seed = t.nodes.find((n) => n.placed === 'seed')!.id;
    addInternalIssue(t, { id: seed, title: '탐색' }, now());
    expect(moveIssueTreeNode(t, x, null)).toMatchObject({ ok: true });
    rebalanceIssueTree(t, now());
    const preview = issueTreeFromView(issueTreeView(t, 'S'));
    rebalanceIssueTree(preview, now());
    expect(representativeIssue(t)?.id).toBe(x);
    expect(representativeIssue(preview)?.id).toBe(x);
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
    // A non-default port is another server; the scheme's default port is no port.
    expect(issueTreeNodeId('https://jira.example.com:8443/browse/WEB-7')).not.toBe(
      issueTreeNodeId('https://jira.example.com:9443/browse/WEB-7'),
    );
    expect(issueTreeNodeId('https://jira.example.com:443/browse/WEB-7')).toBe(
      issueTreeNodeId('https://jira.example.com/browse/WEB-7'),
    );
    const t = tree();
    add(t, 'pr', pr(7), { title: 'a' });
    add(t, 'pr', 'https://github.com/2lab-ai/soma-work/pull/7/', { title: 'b', status: 'merged' });
    expect(t.nodes.filter((n) => n.kind === 'pr')).toHaveLength(1);
    expect(t.nodes.find((n) => n.kind === 'pr')).toMatchObject({ title: 'b', status: 'merged' });
  });

  it('the cap holds for everything the host notes too: at the limit a new node is refused', () => {
    const t = emptyIssueTree();
    for (let i = 0; i < ISSUE_TREE_MAX_NODES; i++)
      upsertIssueTreeLink(t, { kind: 'issue', url: issue(5000 + i) }, now());
    rebalanceIssueTree(t, now());
    expect(t.nodes.length).toBe(ISSUE_TREE_MAX_NODES);
    expect(upsertIssueTreeLink(t, { kind: 'issue', url: issue(9999) }, now())).toMatchObject({ ok: false });
    // A node already there is still refreshed.
    expect(upsertIssueTreeLink(t, { kind: 'issue', url: issue(5000), title: 'x' }, now())).toMatchObject({ ok: true });
    rebalanceIssueTree(t, now());
    expect(t.nodes.length).toBe(ISSUE_TREE_MAX_NODES);
    // add_internal is refused too, with nothing changed (not the nodes, not the counter); an edit of one still works.
    const full = emptyIssueTree();
    const made = addInternalIssue(full, { title: '조사' }, now());
    for (let i = 0; full.nodes.length < ISSUE_TREE_MAX_NODES; i++)
      upsertIssueTreeLink(full, { kind: 'issue', url: issue(6000 + i) }, now());
    rebalanceIssueTree(full, now());
    const snapshot = JSON.stringify(full);
    expect(addInternalIssue(full, { title: '하나 더' }, now())).toMatchObject({ ok: false });
    expect(JSON.stringify(full)).toBe(snapshot);
    const madeId = (made as { id: string }).id;
    expect(addInternalIssue(full, { id: madeId, status: 'closed' }, now())).toMatchObject({ ok: true, id: madeId });
  });

  it('a full tree whose last root issue a GitHub read puts under the model’s issue takes no 201st node', () => {
    // A (root) ← P (host PR) ← B (the model's issue under P); the rest fills the tree, all under A.
    const t = tree();
    add(t, 'issue', issue(1));
    add(t, 'pr', pr(10));
    add(t, 'issue', issue(2), { parent: pr(10) });
    for (let i = 0; t.nodes.length < ISSUE_TREE_MAX_NODES; i++)
      upsertIssueTreeLink(t, { kind: 'pr', url: pr(7000 + i) }, now());
    rebalanceIssueTree(t, now());
    expect(t.nodes.length).toBe(ISSUE_TREE_MAX_NODES);
    // GitHub: A's parent is B. Placing A under B would leave no root issue: A stays the root, no seed is made.
    upsertIssueTreeLink(t, { kind: 'issue', url: issue(1), rel: { subOf: issue(2) } }, now());
    rebalanceIssueTree(t, now());
    expect(t.nodes.length).toBe(ISSUE_TREE_MAX_NODES);
    expect(t.nodes.some((n) => n.placed === 'seed')).toBe(false);
    expect(shape(t)).toMatchObject({ 'issues/1': '', 'pull/10': 'issues/1', 'issues/2': 'pull/10' });
    expect(t.nodes.filter((n) => n.kind === 'pr' && !n.parent)).toEqual([]);
    const once = JSON.stringify(t);
    rebalanceIssueTree(t, now());
    expect(JSON.stringify(t)).toBe(once);
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
    // The host's next internal number travels with the view (a preview numbers a new internal issue the same way).
    expect(v.nextInternal).toBe(2);
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

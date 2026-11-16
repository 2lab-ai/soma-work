import { describe, expect, it } from 'vitest';
import { getDefaultSessionSnapshot, listModelCommands, runModelCommand } from './catalog';
import {
  applyIssueTreeOperations,
  emptyIssueTree,
  issueTreeNodeId,
  issueTreeView,
  rebalanceIssueTree,
  upsertIssueTreeLink,
} from './issue-tree';
import type { SessionResourceSnapshot } from './session-types';
import type { ModelCommandRunRequest } from './types';
import { validateModelCommandRunArgs } from './validator';

/**
 * .prd/29 §5 — the model shapes the session's issue tree with UPDATE_SESSION: `parent` on an issue/PR add,
 * `add_internal`, `move`; GET_SESSION and the MCP preview return `issueTree`.
 */

const GH = 'https://github.com/2lab-ai/soma-work';
const parse = (operations: unknown[]) =>
  validateModelCommandRunArgs({ commandId: 'UPDATE_SESSION', params: { operations } });

function snapshotWithTree(): SessionResourceSnapshot {
  const t = emptyIssueTree();
  upsertIssueTreeLink(t, { kind: 'issue', url: `${GH}/issues/5`, provider: 'github', label: '#5' }, 1);
  upsertIssueTreeLink(
    t,
    { kind: 'pr', url: `${GH}/pull/7`, provider: 'github', rel: { closes: [`${GH}/issues/5`] } },
    2,
  );
  rebalanceIssueTree(t, 3);
  const s = getDefaultSessionSnapshot();
  s.issues = [{ url: `${GH}/issues/5`, type: 'issue', provider: 'github', label: '#5' }];
  s.active = { issue: s.issues[0] };
  s.issueTree = issueTreeView(t, 'S');
  return s;
}
const run = (session: SessionResourceSnapshot, operations: unknown[]) => {
  const v = validateModelCommandRunArgs({ commandId: 'UPDATE_SESSION', params: { operations } });
  if (!v.ok) throw new Error(JSON.stringify(v.error));
  return runModelCommand(v.request as ModelCommandRunRequest, { channel: 'C1', threadTs: '1.1', user: 'U1', session });
};
const parentOf = (s: SessionResourceSnapshot, url: string) =>
  s.issueTree?.nodes.find((n) => n.id === issueTreeNodeId(url))?.parent;

describe('validator — the issue tree operations', () => {
  it('accepts parent on an issue/PR add (a node or null), add_internal and move', () => {
    const r = parse([
      { action: 'add', resourceType: 'pr', url: `${GH}/pull/9`, parent: `${GH}/issues/5` },
      { action: 'add', resourceType: 'issue', url: `${GH}/issues/8`, parent: null },
      { action: 'add_internal', resourceType: 'issue', title: '  조사  ', parent: 'internal:1' },
      { action: 'add_internal', resourceType: 'issue', id: 'internal:2', status: 'closed' },
      { action: 'move', resourceType: 'pr', node: `${GH}/pull/9`, parent: null },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.request.params as { operations: unknown[] }).operations).toEqual([
      expect.objectContaining({ action: 'add', parent: `${GH}/issues/5` }),
      expect.objectContaining({ action: 'add', parent: null }),
      { action: 'add_internal', resourceType: 'issue', title: '조사', parent: 'internal:1' },
      { action: 'add_internal', resourceType: 'issue', title: '', status: 'closed', id: 'internal:2' },
      { action: 'move', resourceType: 'pr', node: `${GH}/pull/9`, parent: null },
    ]);
    // An add without parent stays without it (the host places it).
    const plain = parse([{ action: 'add', resourceType: 'pr', url: `${GH}/pull/9` }]);
    expect(plain.ok && (plain.request.params as { operations: object[] }).operations[0]).not.toHaveProperty('parent');
  });

  it.each([
    ['a parent that is not a string or null', [{ action: 'add', resourceType: 'pr', url: `${GH}/pull/9`, parent: 3 }]],
    ['a doc with a parent', [{ action: 'add', resourceType: 'doc', url: 'https://x/doc', parent: null }]],
    ['add_internal without a title', [{ action: 'add_internal', resourceType: 'issue' }]],
    ['add_internal for a PR', [{ action: 'add_internal', resourceType: 'pr', title: 'x' }]],
    ['add_internal with a foreign id', [{ action: 'add_internal', resourceType: 'issue', id: `${GH}/issues/5` }]],
    [
      'add_internal with another status',
      [{ action: 'add_internal', resourceType: 'issue', title: 'x', status: 'done' }],
    ],
    ['move without node', [{ action: 'move', resourceType: 'pr', parent: null }]],
    ['move without parent', [{ action: 'move', resourceType: 'pr', node: `${GH}/pull/9` }]],
    ['move of a doc', [{ action: 'move', resourceType: 'doc', node: 'x', parent: null }]],
  ])('refuses %s', (_name, operations) => {
    expect(parse(operations).ok).toBe(false);
  });

  it('the schema the model reads offers the operations and the parent', () => {
    const update = listModelCommands({ channel: 'C1', threadTs: '1.1', user: 'U1' } as never).find(
      (c) => c.id === 'UPDATE_SESSION',
    );
    const item = (update?.paramsSchema as any).properties.operations.items;
    expect(item.properties.action.enum).toEqual(['add', 'remove', 'set_active', 'add_internal', 'move']);
    expect(item.properties.parent.type).toEqual(['string', 'null']);
    expect(Object.keys(item.properties)).toEqual(expect.arrayContaining(['parent', 'node', 'title', 'status', 'id']));
    const get = listModelCommands({ channel: 'C1', threadTs: '1.1', user: 'U1' } as never).find(
      (c) => c.id === 'GET_SESSION',
    );
    expect(get?.description).toContain('issueTree');
  });
});

describe('the MCP preview applies them with the host’s function', () => {
  it('a PR added under an issue, an unrelated issue at the root, an internal issue — and the active link stays', () => {
    const r = run(snapshotWithTree(), [
      { action: 'add', resourceType: 'pr', url: `${GH}/pull/9`, parent: `${GH}/pull/7` },
      { action: 'add', resourceType: 'issue', url: `${GH}/issues/8`, parent: null },
      { action: 'add_internal', resourceType: 'issue', title: '조사', parent: `${GH}/issues/5` },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = (r.payload as { session: SessionResourceSnapshot }).session;
    expect(parentOf(s, `${GH}/pull/9`)).toBe(issueTreeNodeId(`${GH}/pull/7`));
    expect(parentOf(s, `${GH}/issues/8`)).toBeUndefined();
    const internal = s.issueTree?.nodes.find((n) => n.source === 'internal');
    expect(internal).toMatchObject({ title: '조사', parent: issueTreeNodeId(`${GH}/issues/5`), placed: 'model' });
    // The PR the host placed from its closing ref keeps its place in the preview (the relation is rebuilt).
    expect(s.issueTree?.nodes.find((n) => n.id === issueTreeNodeId(`${GH}/pull/7`))).toMatchObject({
      parent: issueTreeNodeId(`${GH}/issues/5`),
      placed: 'closes',
    });
    // add_internal is not a set_active: the card's current issue is still #5 (the add of #8 made #8 current).
    expect(s.active.issue?.url).toBe(`${GH}/issues/8`);
    expect(s.issues.map((l) => l.url)).toEqual([`${GH}/issues/5`, `${GH}/issues/8`]);
  });

  it('move alone changes the tree and the sequence, not the card links', () => {
    const before = snapshotWithTree();
    const r = run(before, [{ action: 'add_internal', resourceType: 'issue', title: '정리' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = (r.payload as { session: SessionResourceSnapshot }).session;
    const id = s.issueTree?.nodes.find((n) => n.title === '정리')?.id as string;
    const m = run(s, [{ action: 'move', resourceType: 'pr', node: `${GH}/pull/7`, parent: id }]);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const after = (m.payload as { session: SessionResourceSnapshot }).session;
    expect(parentOf(after, `${GH}/pull/7`)).toBe(id);
    expect(after.active.issue?.url).toBe(`${GH}/issues/5`);
    expect(after.sequence).toBe(2);
  });

  it('a new internal issue gets the number the host will give it, also after the seed gave way', () => {
    // The host's tree: the seed (internal:1) retired when #5 came in, its counter at 2.
    const s = snapshotWithTree();
    expect(s.issueTree?.nextInternal).toBe(1);
    s.issueTree = { ...s.issueTree!, nextInternal: 2 };
    const r = run(s, [{ action: 'add_internal', resourceType: 'issue', title: '정리' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = (r.payload as { session: SessionResourceSnapshot }).session;
    expect(after.issueTree?.nodes.find((n) => n.title === '정리')?.id).toBe('internal:2');
    expect(after.issueTree?.nextInternal).toBe(3);
  });

  it('host/preview parity: a closing ref whose issue is not in the tree yet places the PR the same way on both', () => {
    // Host: #5, and PR #7 that closes #6 — not in the tree yet, so #7 sits under #5 for now.
    const host = emptyIssueTree();
    upsertIssueTreeLink(host, { kind: 'issue', url: `${GH}/issues/5`, provider: 'github' }, 1);
    upsertIssueTreeLink(
      host,
      { kind: 'pr', url: `${GH}/pull/7`, provider: 'github', rel: { closes: [`${GH}/issues/6`] } },
      2,
    );
    rebalanceIssueTree(host, 3);
    const s = getDefaultSessionSnapshot();
    s.issues = [{ url: `${GH}/issues/5`, type: 'issue', provider: 'github' }];
    s.issueTree = issueTreeView(host, 'S');
    expect(parentOf(s, `${GH}/pull/7`)).toBe(issueTreeNodeId(`${GH}/issues/5`));
    // One batch: add #6 (the host moves #7 under it), then put #5 under #7 — valid only once #7 left #5.
    const ops = [
      { action: 'add', resourceType: 'issue', url: `${GH}/issues/6` },
      { action: 'move', resourceType: 'issue', node: `${GH}/issues/5`, parent: `${GH}/pull/7` },
    ];
    const r = run(s, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const preview = (r.payload as { session: SessionResourceSnapshot }).session;
    const v = validateModelCommandRunArgs({ commandId: 'UPDATE_SESSION', params: { operations: ops } });
    const hostOps = (v.ok ? (v.request.params as { operations: never[] }).operations : []) as never[];
    const onHost = applyIssueTreeOperations(host, hostOps, 4);
    expect(onHost.ok).toBe(true);
    const shapeOf = (nodes: ReadonlyArray<{ id: string; parent?: string }>) =>
      Object.fromEntries(nodes.map((n) => [n.id, n.parent ?? '']));
    expect(shapeOf(preview.issueTree?.nodes ?? [])).toEqual(shapeOf(onHost.ok ? onHost.tree.nodes : []));
    expect(parentOf(preview, `${GH}/pull/7`)).toBe(issueTreeNodeId(`${GH}/issues/6`));
    expect(parentOf(preview, `${GH}/issues/5`)).toBe(issueTreeNodeId(`${GH}/pull/7`));
  });

  it('a refused batch in the preview leaves the caller’s snapshot as it was: links, current link, tree, sequence', () => {
    const s = snapshotWithTree();
    const before = JSON.stringify(s);
    const r = run(s, [
      { action: 'add', resourceType: 'pr', url: `${GH}/pull/9` },
      { action: 'add_internal', resourceType: 'issue', title: '조사' },
      { action: 'move', resourceType: 'pr', node: `${GH}/pull/7`, parent: null },
    ]);
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringContaining('PR cannot be a root') } });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('refuses what would break the tree, naming why', () => {
    const r = run(snapshotWithTree(), [{ action: 'move', resourceType: 'pr', node: `${GH}/pull/7`, parent: null }]);
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'INVALID_OPERATION', message: expect.stringContaining('PR cannot be a root') },
    });
    const missing = run(snapshotWithTree(), [
      { action: 'add', resourceType: 'pr', url: `${GH}/pull/9`, parent: `${GH}/issues/404` },
    ]);
    expect(missing).toMatchObject({ ok: false, error: { message: expect.stringContaining('not in the issue tree') } });
  });
});

/**
 * .prd/29 — the session's issue tree, as pure functions over `SessionIssueTree`. The host (session registry) and the
 * MCP server's preview both apply writes through these, so what the model reads back is what the host stored.
 *
 * Invariants (kept by `rebalanceIssueTree` after every write):
 *   1. there is an issue node — without one, the seed (`internal:1`, the session's own issue) is made;
 *   2. no PR is a root — its parent is an issue or a PR;
 *   3. every parent is a node of the tree and there is no cycle;
 *   4. at most ISSUE_TREE_MAX_NODES nodes — a new node past it is refused (the seed only ever replaces a node that left).
 * The model's placements (`placed: 'model'`) are never moved by the host.
 */
import type {
  IssueTreeNode,
  IssueTreeNodeKind,
  IssueTreeRelations,
  IssueTreeSource,
  IssueTreeView,
  IssueTreeViewNode,
  SessionIssueTree,
  SessionLink,
  SessionLinkHistory,
  SessionResourceOperation,
} from './session-types';

export const ISSUE_TREE_MAX_NODES = 200;
export const SEED_ID = 'internal:1';
const INTERNAL_RE = /^internal:(\d+)$/;

export type IssueTreeResult = { ok: true; id: string } | { ok: false; reason: string };

export function emptyIssueTree(): SessionIssueTree {
  return { nodes: [], nextInternal: 1 };
}

/** An external node's id: its URL with the host lower-cased, no query, hash or trailing slash (GitHub paths lower-cased too). */
export function issueTreeNodeId(url: string): string {
  const raw = String(url || '').trim();
  if (INTERNAL_RE.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    let path = u.pathname.replace(/\/+$/, '');
    if (host === 'github.com' || host === 'www.github.com') path = path.toLowerCase();
    return `${u.protocol.toLowerCase()}//${host.replace(/^www\.github\.com$/, 'github.com')}${path}`;
  } catch {
    return raw.toLowerCase();
  }
}

function sourceOf(provider: SessionLink['provider'] | undefined): IssueTreeSource {
  return provider === 'github' || provider === 'jira' || provider === 'linear' || provider === 'confluence'
    ? provider
    : 'unknown';
}

function byId(tree: SessionIssueTree): Map<string, IssueTreeNode> {
  return new Map(tree.nodes.map((n) => [n.id, n]));
}

/** A reference the model gives (a URL or an id) → the node's id, when the tree has it. */
export function resolveIssueTreeRef(tree: SessionIssueTree, ref: string): string | undefined {
  const id = issueTreeNodeId(ref);
  return tree.nodes.some((n) => n.id === id) ? id : undefined;
}

/** Whether `ancestor` is `id` or above it. */
function isAncestor(nodes: Map<string, IssueTreeNode>, ancestor: string, id: string): boolean {
  const seen = new Set<string>();
  let cur: string | undefined = id;
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = nodes.get(cur)?.parent;
  }
  return false;
}

/** Check a parent the model asked for. */
function checkParent(
  tree: SessionIssueTree,
  kind: IssueTreeNodeKind,
  selfId: string | undefined,
  parent: string | null,
): { ok: true; parent: string | undefined } | { ok: false; reason: string } {
  if (parent === null) {
    if (kind === 'pr') return { ok: false, reason: 'a PR cannot be a root: give it a parent issue or PR' };
    return { ok: true, parent: undefined };
  }
  const pid = resolveIssueTreeRef(tree, parent);
  if (!pid) return { ok: false, reason: `parent ${parent} is not in the issue tree` };
  if (selfId && isAncestor(byId(tree), selfId, pid)) {
    return { ok: false, reason: `parent ${parent} is the node itself or under it` };
  }
  return { ok: true, parent: pid };
}

/**
 * Relations as a fresh read of GitHub tells them: a key given replaces what the node had (`null`, or no closing refs,
 * clears it); a key not given leaves it. An edited PR body that now closes another issue moves the PR there.
 */
export interface IssueTreeRelationsInput {
  subOf?: string | null;
  closes?: string[];
  base?: string | null;
}

function mergeRel(node: IssueTreeNode, rel: IssueTreeRelationsInput | undefined): void {
  if (!rel) return;
  const next: IssueTreeRelations = { ...(node.rel || {}) };
  if (rel.subOf !== undefined) {
    if (rel.subOf) next.subOf = issueTreeNodeId(rel.subOf);
    else delete next.subOf;
  }
  if (rel.base !== undefined) {
    if (rel.base) next.base = issueTreeNodeId(rel.base);
    else delete next.base;
  }
  if (rel.closes !== undefined) {
    const all = [...new Set(rel.closes.map(issueTreeNodeId))].slice(0, 10);
    if (all.length) next.closes = all;
    else delete next.closes;
  }
  if (Object.keys(next).length) node.rel = next;
  else delete node.rel;
}

export interface IssueTreeLinkInput {
  kind: IssueTreeNodeKind;
  url: string;
  provider?: SessionLink['provider'];
  label?: string;
  title?: string;
  status?: string;
  rel?: IssueTreeRelationsInput;
  /** The model's placement: a node to sit under, `null` for the root (issues), absent for the host to place it. */
  parent?: string | null;
}

/** Put an issue or PR link in the tree (or refresh the node it already has). Rebalance after. */
export function upsertIssueTreeLink(tree: SessionIssueTree, input: IssueTreeLinkInput, now: number): IssueTreeResult {
  const id = issueTreeNodeId(input.url);
  if (!id) return { ok: false, reason: 'a link needs a URL' };
  const existing = tree.nodes.find((n) => n.id === id);
  let parent: string | undefined;
  const pinned = input.parent !== undefined;
  if (pinned) {
    const checked = checkParent(
      tree,
      existing ? existing.kind : input.kind,
      existing ? id : undefined,
      input.parent ?? null,
    );
    if (!checked.ok) return checked;
    parent = checked.parent;
  }
  if (existing) {
    if (input.title) existing.title = input.title;
    if (input.status) existing.status = input.status;
    if (input.label) existing.label = input.label;
    mergeRel(existing, input.rel);
    if (pinned) {
      existing.parent = parent;
      existing.placed = 'model';
    }
    return { ok: true, id };
  }
  if (tree.nodes.length >= ISSUE_TREE_MAX_NODES) {
    return { ok: false, reason: `the issue tree holds at most ${ISSUE_TREE_MAX_NODES} nodes` };
  }
  const node: IssueTreeNode = {
    id,
    kind: input.kind,
    source: sourceOf(input.provider),
    url: input.url,
    ...(input.label ? { label: input.label } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(parent ? { parent } : {}),
    placed: pinned ? 'model' : 'default',
    addedAt: now,
  };
  mergeRel(node, input.rel);
  tree.nodes.push(node);
  return { ok: true, id };
}

/** A new issue that lives only in this session, or (`id`) a change to one: its title, its state, its place. */
export function addInternalIssue(
  tree: SessionIssueTree,
  input: { title?: string; status?: 'open' | 'closed'; parent?: string | null; id?: string },
  now: number,
): IssueTreeResult {
  if (input.id !== undefined) {
    const node = tree.nodes.find((n) => n.id === input.id && n.source === 'internal');
    if (!node) return { ok: false, reason: `internal issue ${input.id} is not in the issue tree` };
    if (input.parent !== undefined) {
      const checked = checkParent(tree, 'issue', node.id, input.parent);
      if (!checked.ok) return checked;
      node.parent = checked.parent;
      node.placed = 'model';
    } else if (node.placed === 'seed') {
      // Named by the model, the seed is this session's own issue now: it no longer gives way to an external one.
      node.placed = 'default';
    }
    if (input.title && input.title.trim()) node.title = input.title.trim();
    if (input.status) node.status = input.status;
    return { ok: true, id: node.id };
  }
  const title = (input.title || '').trim();
  if (!title) return { ok: false, reason: 'an internal issue needs a title' };
  if (tree.nodes.length >= ISSUE_TREE_MAX_NODES) {
    return { ok: false, reason: `the issue tree holds at most ${ISSUE_TREE_MAX_NODES} nodes` };
  }
  let parent: string | undefined;
  if (input.parent !== undefined) {
    const checked = checkParent(tree, 'issue', undefined, input.parent);
    if (!checked.ok) return checked;
    parent = checked.parent;
  }
  const id = nextInternalId(tree);
  tree.nodes.push({
    id,
    kind: 'issue',
    source: 'internal',
    title,
    status: input.status || 'open',
    ...(parent ? { parent } : {}),
    placed: input.parent !== undefined ? 'model' : 'default',
    addedAt: now,
  });
  return { ok: true, id };
}

function nextInternalId(tree: SessionIssueTree): string {
  let n = Math.max(1, tree.nextInternal || 1);
  const taken = new Set(tree.nodes.map((x) => x.id));
  while (taken.has(`internal:${n}`)) n++;
  tree.nextInternal = n + 1;
  return `internal:${n}`;
}

/** Move a node under another (or to the root — issues only). The model's choice: pinned. */
export function moveIssueTreeNode(tree: SessionIssueTree, ref: string, parent: string | null): IssueTreeResult {
  const id = resolveIssueTreeRef(tree, ref);
  if (!id) return { ok: false, reason: `${ref} is not in the issue tree` };
  const node = tree.nodes.find((n) => n.id === id) as IssueTreeNode;
  const checked = checkParent(tree, node.kind, id, parent);
  if (!checked.ok) return checked;
  node.parent = checked.parent;
  node.placed = 'model';
  return { ok: true, id };
}

/**
 * Take a node out; its children go up one level, to its parent, and stay there (a relation that named the node is
 * dropped, so the next rebalance does not flatten them). A PR left with no parent is placed again by the host.
 */
export function removeIssueTreeNode(tree: SessionIssueTree, ref: string): IssueTreeResult {
  const id = resolveIssueTreeRef(tree, ref);
  if (!id) return { ok: false, reason: `${ref} is not in the issue tree` };
  const node = tree.nodes.find((n) => n.id === id) as IssueTreeNode;
  for (const other of tree.nodes) {
    if (other.rel) {
      const rel = other.rel;
      if (rel.subOf === id) delete rel.subOf;
      if (rel.base === id) delete rel.base;
      if (rel.closes) {
        rel.closes = rel.closes.filter((c) => c !== id);
        if (!rel.closes.length) delete rel.closes;
      }
      if (!Object.keys(rel).length) delete other.rel;
    }
    if (other.parent !== id) continue;
    other.parent = node.parent;
    other.placed = other.kind === 'pr' && !other.parent ? 'default' : 'model';
  }
  tree.nodes = tree.nodes.filter((n) => n.id !== id);
  return { ok: true, id };
}

/** The representative issue: the first external root issue to come in, else the first root issue. */
export function representativeIssue(tree: SessionIssueTree): IssueTreeNode | undefined {
  const roots = tree.nodes.filter((n) => n.kind === 'issue' && !n.parent);
  return roots.find((n) => n.source !== 'internal') || roots[0];
}

/** Keep the invariants and place every node the model did not place. Idempotent. */
export function rebalanceIssueTree(tree: SessionIssueTree, now: number): void {
  // Dangling parents: a node whose parent left falls back to the host's placement.
  let nodes = byId(tree);
  for (const n of tree.nodes) {
    if (n.parent && !nodes.has(n.parent)) {
      n.parent = undefined;
      if (n.placed === 'model') n.placed = 'default';
    }
    if (n.kind === 'pr' && !n.parent && n.placed === 'model') n.placed = 'default';
  }
  // 1. An issue node, always: the seed when there is none.
  if (!tree.nodes.some((n) => n.kind === 'issue')) {
    tree.nodes.unshift({ id: SEED_ID, kind: 'issue', source: 'internal', placed: 'seed', addedAt: now });
    if (tree.nextInternal <= 1) tree.nextInternal = 2;
  }
  // The seed stands in only while the session has no other issue: it gives way to the first one (an external issue, or
  // an internal one the model made) unless the model kept something under it.
  const seed = tree.nodes.find((n) => n.placed === 'seed');
  if (seed && tree.nodes.some((n) => n.kind === 'issue' && n.id !== seed.id)) {
    const kept = tree.nodes.some((n) => n.parent === seed.id && n.placed === 'model');
    if (!kept) {
      for (const n of tree.nodes) if (n.parent === seed.id) n.parent = undefined;
      tree.nodes = tree.nodes.filter((n) => n.id !== seed.id);
    }
  }
  nodes = byId(tree);
  // 2. Issues: under their GitHub parent when it is here, else roots.
  for (const n of tree.nodes) {
    if (n.kind !== 'issue' || n.placed === 'model' || n.placed === 'seed') continue;
    const sub = n.rel?.subOf;
    const subNode = sub ? nodes.get(sub) : undefined;
    if (sub && subNode && subNode.kind === 'issue' && sub !== n.id && !isAncestor(nodes, n.id, sub)) {
      n.parent = sub;
      n.placed = 'sub-issue';
    } else {
      n.parent = undefined;
      n.placed = 'default';
    }
  }
  // 3. PRs: under an issue they close, else the PR they are stacked on, else the representative issue.
  const rep = representativeIssue(tree);
  for (const n of tree.nodes) {
    if (n.kind !== 'pr' || n.placed === 'model') continue;
    n.parent = undefined;
    const closes = (n.rel?.closes || []).find((c) => nodes.get(c)?.kind === 'issue');
    if (closes) {
      n.parent = closes;
      n.placed = 'closes';
      continue;
    }
    const base = n.rel?.base;
    if (base && base !== n.id && nodes.get(base)?.kind === 'pr' && !isAncestor(nodes, n.id, base)) {
      n.parent = base;
      n.placed = 'stack';
      continue;
    }
    n.parent = rep?.id;
    n.placed = 'default';
  }
  // 4. No cycle survives (a stack loop in the data): the node falls to the representative (PR) or the root (issue).
  nodes = byId(tree);
  for (const n of tree.nodes) {
    if (!n.parent || !isAncestor(nodes, n.id, n.parent)) continue;
    n.parent = n.kind === 'pr' && rep && rep.id !== n.id ? rep.id : undefined;
    n.placed = 'default';
  }
}

/** What GET_SESSION and the dashboard read: the nodes in the order they came, the seed titled with the session's title. */
export function issueTreeView(tree: SessionIssueTree, sessionTitle?: string): IssueTreeView {
  const nodes: IssueTreeViewNode[] = [...tree.nodes]
    .sort((a, b) => a.addedAt - b.addedAt)
    .map((n) => {
      const title = n.title || (n.placed === 'seed' ? sessionTitle : undefined);
      return {
        id: n.id,
        kind: n.kind,
        source: n.source,
        ...(n.url ? { url: n.url } : {}),
        ...(n.label ? { label: n.label } : {}),
        ...(title ? { title } : {}),
        ...(n.status ? { status: n.status } : {}),
        ...(n.parent ? { parent: n.parent } : {}),
        placed: n.placed,
      };
    });
  return { nodes, nextInternal: tree.nextInternal };
}

/** A tree for a session that has only its link records (made before .prd/29): issues and PRs in the order they came. */
export function issueTreeFromLinks(history: SessionLinkHistory | undefined, now: number): SessionIssueTree {
  const tree = emptyIssueTree();
  const add = (links: SessionLink[] | undefined, kind: IssueTreeNodeKind) => {
    for (const link of links || []) {
      upsertIssueTreeLink(
        tree,
        { kind, url: link.url, provider: link.provider, label: link.label, title: link.title, status: link.status },
        now,
      );
    }
  };
  add(history?.issues, 'issue');
  add(history?.prs, 'pr');
  rebalanceIssueTree(tree, now);
  return tree;
}

const KINDS = new Set(['issue', 'pr']);
const SOURCES = new Set(['github', 'jira', 'linear', 'confluence', 'internal', 'unknown']);
const PLACEMENTS = new Set(['model', 'sub-issue', 'closes', 'stack', 'default', 'seed']);

/** A stored tree, checked field by field on load: a broken node is dropped, not the tree. */
export function sanitizeIssueTree(raw: unknown): SessionIssueTree | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { nodes?: unknown; nextInternal?: unknown };
  if (!Array.isArray(r.nodes)) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const nodes: IssueTreeNode[] = [];
  const seen = new Set<string>();
  for (const item of r.nodes) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    const id = str(n.id);
    if (!id || seen.has(id) || !KINDS.has(n.kind as string) || !SOURCES.has(n.source as string)) continue;
    if (!PLACEMENTS.has(n.placed as string) || typeof n.addedAt !== 'number') continue;
    const relRaw = n.rel && typeof n.rel === 'object' ? (n.rel as Record<string, unknown>) : undefined;
    const rel: IssueTreeRelations | undefined = relRaw
      ? {
          ...(str(relRaw.subOf) ? { subOf: str(relRaw.subOf) } : {}),
          ...(str(relRaw.base) ? { base: str(relRaw.base) } : {}),
          ...(Array.isArray(relRaw.closes)
            ? { closes: relRaw.closes.filter((c): c is string => typeof c === 'string' && !!c).slice(0, 10) }
            : {}),
        }
      : undefined;
    seen.add(id);
    nodes.push({
      id,
      kind: n.kind as IssueTreeNodeKind,
      source: n.source as IssueTreeSource,
      ...(str(n.url) ? { url: str(n.url) } : {}),
      ...(str(n.label) ? { label: str(n.label) } : {}),
      ...(str(n.title) ? { title: str(n.title) } : {}),
      ...(str(n.status) ? { status: str(n.status) } : {}),
      ...(str(n.parent) ? { parent: str(n.parent) } : {}),
      placed: n.placed as IssueTreeNode['placed'],
      ...(rel && Object.keys(rel).length ? { rel } : {}),
      addedAt: n.addedAt as number,
      ...(typeof n.checkedAt === 'number' ? { checkedAt: n.checkedAt } : {}),
      ...(typeof n.triedAt === 'number' ? { triedAt: n.triedAt } : {}),
    });
  }
  const next = typeof r.nextInternal === 'number' && r.nextInternal >= 1 ? Math.floor(r.nextInternal) : 1;
  return { nodes: nodes.slice(0, ISSUE_TREE_MAX_NODES), nextInternal: next };
}

/**
 * The tree behind a view (the MCP server's preview has only the view): a placement the host made from a relation
 * keeps that relation, so a rebalance leaves the node where the host put it.
 */
export function issueTreeFromView(view: IssueTreeView | undefined): SessionIssueTree {
  const tree = emptyIssueTree();
  let max = 0;
  (view?.nodes || []).forEach((v, i) => {
    const m = INTERNAL_RE.exec(v.id);
    if (m) max = Math.max(max, Number(m[1]));
    const rel: IssueTreeRelations | undefined =
      v.placed === 'closes' && v.parent
        ? { closes: [v.parent] }
        : v.placed === 'stack' && v.parent
          ? { base: v.parent }
          : v.placed === 'sub-issue' && v.parent
            ? { subOf: v.parent }
            : undefined;
    tree.nodes.push({
      id: v.id,
      kind: v.kind,
      source: v.source,
      ...(v.url ? { url: v.url } : {}),
      ...(v.label ? { label: v.label } : {}),
      ...(v.title && v.placed !== 'seed' ? { title: v.title } : {}),
      ...(v.status ? { status: v.status } : {}),
      ...(v.parent ? { parent: v.parent } : {}),
      placed: v.placed,
      ...(rel ? { rel } : {}),
      addedAt: i,
    });
  });
  // The host's counter (a retired seed still took internal:1): a new internal issue gets the number the host gives it.
  tree.nextInternal = Math.max(max + 1, Math.floor(Number(view?.nextInternal) || 1));
  return tree;
}

/**
 * UPDATE_SESSION's operations on the issue tree (the host's write and the MCP preview): an issue or PR `add` puts the
 * link in the tree (at `parent` when given), `remove` takes it out, `add_internal` and `move` shape it. Docs and
 * `set_active` do not touch it. All or nothing: on a refusal the tree is left as it was.
 */
export function applyIssueTreeOperations(
  tree: SessionIssueTree,
  operations: SessionResourceOperation[],
  now: number,
): { ok: true; tree: SessionIssueTree; changed: boolean } | { ok: false; error: string } {
  const next = structuredClone(tree);
  let changed = false;
  for (const op of operations) {
    if (op.resourceType === 'doc' || op.action === 'set_active') continue;
    let result: IssueTreeResult | undefined;
    if (op.action === 'add') {
      result = upsertIssueTreeLink(
        next,
        {
          kind: op.resourceType === 'pr' ? 'pr' : 'issue',
          url: op.link.url,
          provider: op.link.provider,
          label: op.link.label,
          title: op.link.title,
          status: op.link.status,
          ...(op.parent !== undefined ? { parent: op.parent } : {}),
        },
        now,
      );
    } else if (op.action === 'remove') {
      if (!resolveIssueTreeRef(next, op.url)) continue;
      result = removeIssueTreeNode(next, op.url);
    } else if (op.action === 'add_internal') {
      result = addInternalIssue(next, op, now);
    } else if (op.action === 'move') {
      result = moveIssueTreeNode(next, op.node, op.parent);
    }
    if (!result) continue;
    if (!result.ok) return { ok: false, error: `issue tree: ${result.reason}` };
    changed = true;
    // Each step sees the tree as the host keeps it (a seed that gave way, a PR placed) — the next reference resolves
    // against that.
    rebalanceIssueTree(next, now);
  }
  if (!changed) return { ok: true, tree, changed: false };
  return { ok: true, tree: next, changed: true };
}

/**
 * .prd/29 — the session's issue tree, as pure functions over `SessionIssueTree`. The host (session registry) and the
 * MCP server's preview both apply writes through these, so what the model reads back is what the host stored.
 *
 * Invariants (kept by `rebalanceIssueTree` after every write):
 *   1. there is a root issue — without one (no issue, or every issue under a PR), the seed (`internal:1`, the session's
 *      own issue) stands in;
 *   2. no PR is a root — its parent is an issue or a PR;
 *   3. every parent is a node of the tree and there is no cycle;
 *   4. at most ISSUE_TREE_MAX_NODES nodes — a new node past it is refused (the seed only ever replaces a node that left).
 * The model's placements (`placed: 'model'`) are never moved by the host.
 */
import type {
  IssueTreeNode,
  IssueTreeNodeKind,
  IssueTreeRelationReadAt,
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
    // A non-default port names another server (`URL.port` is empty for the scheme's default).
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol.toLowerCase()}//${host.replace(/^www\.github\.com$/, 'github.com')}${port}${path}`;
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

const REL_KEYS = ['subOf', 'closes', 'base'] as const;

/**
 * A read's relations onto a node, field by field: a relation read before the one the node has (two readers landing out
 * of order: the collect, the turn-end reconciler) is skipped; each relation applied keeps its read's start. A field the
 * read did not give is left alone — and its time too.
 */
function applyRelRead(node: IssueTreeNode, rel: IssueTreeRelationsInput | undefined, readAt: number | undefined): void {
  if (!rel) return;
  const fresh: IssueTreeRelationsInput = {};
  for (const key of REL_KEYS) {
    if (rel[key] === undefined) continue;
    const seen = node.relReadAt?.[key];
    if (readAt !== undefined && seen !== undefined && seen > readAt) continue;
    (fresh as Record<string, unknown>)[key] = rel[key];
    if (readAt !== undefined) node.relReadAt = { ...(node.relReadAt || {}), [key]: readAt };
  }
  mergeRel(node, fresh);
}

export interface IssueTreeLinkInput {
  kind: IssueTreeNodeKind;
  url: string;
  provider?: SessionLink['provider'];
  label?: string;
  title?: string;
  status?: string;
  rel?: IssueTreeRelationsInput;
  /** When the read behind `rel` began: a relation from an older read than the node's is not applied. */
  relReadAt?: number;
  /** When the read behind `status` began; absent = a read made as it is noted (`now`). */
  statusReadAt?: number;
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
    // Merged is final (as on the card): a late or cached read of an earlier state does not undo it. Any other state
    // follows the newest read: one that began before the node's last state read (a slower collect, a reused record)
    // is not applied; a newer one is (a reopen too).
    const statusAt = input.statusReadAt ?? now;
    const newer = existing.statusReadAt === undefined || statusAt >= existing.statusReadAt;
    if (input.status && !(existing.kind === 'pr' && existing.status === 'merged') && newer) {
      existing.status = input.status;
      existing.statusReadAt = statusAt;
    }
    if (input.label) existing.label = input.label;
    applyRelRead(existing, input.rel, input.relReadAt);
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
    ...(input.status ? { status: input.status, statusReadAt: input.statusReadAt ?? now } : {}),
    ...(parent ? { parent } : {}),
    placed: pinned ? 'model' : 'default',
    addedAt: now,
  };
  applyRelRead(node, input.rel, input.relReadAt);
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
    } else if (node.placed === 'seed' && input.title?.trim()) {
      // Named by the model, the seed is this session's own issue now: it no longer gives way to an external one. A
      // status-only edit leaves it the seed (still titled with the session's title).
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

/** Make room for the seed in a full tree: the oldest host-placed PR nothing depends on (else the oldest host-placed PR). */
function evictForSeed(tree: SessionIssueTree): void {
  const dependedOn = new Set<string>();
  for (const n of tree.nodes) {
    if (n.parent) dependedOn.add(n.parent);
    if (n.rel?.base) dependedOn.add(n.rel.base);
    if (n.rel?.subOf) dependedOn.add(n.rel.subOf);
    for (const c of n.rel?.closes || []) dependedOn.add(c);
  }
  const hostPrs = tree.nodes
    .filter((n) => n.kind === 'pr' && n.placed !== 'model')
    .sort((a, b) => a.addedAt - b.addedAt);
  const out = hostPrs.find((n) => !dependedOn.has(n.id)) ?? hostPrs[0];
  if (!out) return;
  for (const n of tree.nodes) {
    if (n.parent !== out.id) continue;
    n.parent = undefined; // placed again below (a model PR loses the place it no longer has)
    if (n.placed === 'model' && n.kind === 'pr') n.placed = 'default';
  }
  tree.nodes = tree.nodes.filter((n) => n !== out);
}

function firstSubIssue(tree: SessionIssueTree): IssueTreeNode | undefined {
  return tree.nodes.find((n) => n.kind === 'issue' && n.placed === 'sub-issue');
}

/** A fresh seed: `internal:1` unless the model's own issue holds that id. */
function newSeed(tree: SessionIssueTree, now: number): IssueTreeNode {
  const free = !tree.nodes.some((n) => n.id === SEED_ID);
  const id = free ? SEED_ID : nextInternalId(tree);
  if (free && tree.nextInternal <= 1) tree.nextInternal = 2;
  return { id, kind: 'issue', source: 'internal', placed: 'seed', addedAt: now };
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
  // In the order they came (`addedAt`, as the view lists them): the preview rebuilt from the view picks the same one.
  const roots = tree.nodes.filter((n) => n.kind === 'issue' && !n.parent).sort((a, b) => a.addedAt - b.addedAt);
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
  // 1. The seed stands in only while the session has no other root issue: it gives way to the first one (an external
  // issue, or an internal one the model made) unless the model kept something under it. It is taken out here and put
  // back after the issues are placed when no root issue is left (every other issue under a PR).
  const seed = tree.nodes.find((n) => n.placed === 'seed');
  let retired: IssueTreeNode | undefined;
  if (seed && !tree.nodes.some((n) => n.parent === seed.id && n.placed === 'model')) {
    for (const n of tree.nodes) if (n.parent === seed.id) n.parent = undefined;
    tree.nodes = tree.nodes.filter((n) => n !== seed);
    retired = seed;
  }
  nodes = byId(tree);
  // Every host placement is made afresh from the relations, on a tree without the host's old edges: a stack retargeted
  // in one read settles in one pass, and the result does not depend on the nodes' order.
  for (const n of tree.nodes) if (n.placed !== 'model' && n.placed !== 'seed') n.parent = undefined;
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
  // A root issue, always (a PR is never a root): the seed when no other issue is one. A full tree takes no new seed —
  // the first issue the host put under a GitHub parent goes back to the root instead.
  if (!tree.nodes.some((n) => n.kind === 'issue' && !n.parent)) {
    const full = !retired && tree.nodes.length >= ISSUE_TREE_MAX_NODES;
    const lifted = full ? firstSubIssue(tree) : undefined;
    if (lifted) {
      lifted.parent = undefined;
      lifted.placed = 'default';
    } else {
      // Full and no issue at all (a stored tree of PRs only): the oldest PR the host placed gives way to the seed, so
      // the tree stays within the cap and a save/load does not cut a node (G2).
      if (full) evictForSeed(tree);
      tree.nodes.unshift(retired || newSeed(tree, now));
    }
    nodes = byId(tree);
  }
  // 3. PRs: under an issue they close, else the PR they are stacked on, else the representative issue.
  const rep = representativeIssue(tree);
  for (const n of tree.nodes) {
    if (n.kind !== 'pr' || n.placed === 'model') continue;
    n.parent = undefined;
    // Never under its own descendant (an issue the model put under this PR): no learned relation makes a cycle.
    const closes = (n.rel?.closes || []).find((c) => nodes.get(c)?.kind === 'issue' && !isAncestor(nodes, n.id, c));
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
  // 4. No cycle survives. Every placement above checks ancestry against the tree as it stands, so the host never makes
  // one; what is left is a cycle in stored data, of the model's own edges: the node falls to the representative (PR) or
  // the root (issue).
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
      // The seed (the one internal issue with no title of its own) shows the session's title, moved or not.
      const title = n.title || (n.source === 'internal' ? sessionTitle : undefined);
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
        ...(n.rel ? { rel: structuredClone(n.rel) } : {}),
      };
    });
  return { nodes, nextInternal: tree.nextInternal, ...(sessionTitle ? { title: sessionTitle } : {}) };
}

/**
 * A tree for a session that has only its link records (made before .prd/29): issues and PRs in the order they came,
 * then the current ones (an old archived session may have those and no history).
 */
export function issueTreeFromLinks(
  history: SessionLinkHistory | undefined,
  now: number,
  active?: { issue?: SessionLink; pr?: SessionLink } | null,
): SessionIssueTree {
  const tree = emptyIssueTree();
  const add = (links: SessionLink[] | undefined, kind: IssueTreeNodeKind) => {
    for (const link of links || []) {
      // A PR-only history leaves room for the seed the rebalance adds (the cap holds after it too).
      const noIssue = !tree.nodes.some((n) => n.kind === 'issue');
      if (kind === 'pr' && noIssue && tree.nodes.length >= ISSUE_TREE_MAX_NODES - 1) break;
      upsertIssueTreeLink(
        tree,
        { kind, url: link.url, provider: link.provider, label: link.label, title: link.title, status: link.status },
        now,
      );
    }
  };
  add([...(history?.issues || []), ...(active?.issue ? [active.issue] : [])], 'issue');
  add([...(history?.prs || []), ...(active?.pr ? [active.pr] : [])], 'pr');
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
      ...(readAtOf(n.relReadAt) ? { relReadAt: readAtOf(n.relReadAt) } : {}),
      ...(typeof n.statusReadAt === 'number' && Number.isFinite(n.statusReadAt)
        ? { statusReadAt: n.statusReadAt }
        : {}),
    });
  }
  return { nodes: nodes.slice(0, ISSUE_TREE_MAX_NODES), nextInternal: safeCounter(r.nextInternal) };
}

/** A stored relation read-time record: numbers per known relation, nothing else. */
function readAtOf(raw: unknown): IssueTreeRelationReadAt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: IssueTreeRelationReadAt = {};
  for (const key of REL_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The internal-issue counter from stored or sent data: a small whole number (a huge one could stop counting). */
function safeCounter(raw: unknown): number {
  if (typeof raw !== 'number' && typeof raw !== 'string') return 1; // an object could throw on conversion
  const n = Math.floor(Number(raw));
  return Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000 ? n : 1;
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
    if (m && Number(m[1]) < 1_000_000) max = Math.max(max, Number(m[1]));
    // The stored node without the host's read bookkeeping — its relations too (one not in force yet: a PR that closes
    // an issue not in the tree), so the preview places nodes as the host does.
    const node: IssueTreeNode = { ...structuredClone(v), addedAt: i };
    // The seed's shown title is the session's, not its own.
    if (node.source === 'internal' && node.placed === 'seed') delete node.title;
    tree.nodes.push(node);
  });
  // The host's counter (a retired seed still took internal:1): a new internal issue gets the number the host gives it.
  // The host's counter as given (a repaired one too — allocation skips taken ids, as on the host); one past the highest
  // internal id only when the view has none.
  tree.nextInternal = view?.nextInternal !== undefined ? safeCounter(view.nextInternal) : max + 1;
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
      const id = resolveIssueTreeRef(next, op.url);
      if (!id) continue;
      const kind = next.nodes.find((n) => n.id === id)?.kind;
      // The card removes the link from that kind's list: the tree removes only a node of that kind.
      result =
        kind === op.resourceType
          ? removeIssueTreeNode(next, op.url)
          : {
              ok: false,
              reason: `${op.url} is an ${kind === 'pr' ? 'PR' : 'issue'} in the tree, not ${op.resourceType === 'pr' ? 'a PR' : 'an issue'}`,
            };
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

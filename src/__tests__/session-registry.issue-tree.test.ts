/**
 * .prd/29 — the session's issue tree, through the host's own paths: the snapshot the model reads (GET_SESSION),
 * UPDATE_SESSION's operations, the links the host notes, what GitHub tells (`noteIssueTree`), and sessions.json.
 *
 *   T1  a session with no issue reads the seed (titled with the session); one with only link records gets a tree from them
 *   T2  a noted PR sits under the seed; the first GitHub issue retires the seed and takes the PR (S1–S3)
 *   T3  'update' (a merge or close) changes a node's state and adds nothing; merged is final
 *   T4  UPDATE_SESSION: parent on add, add_internal, move, remove; a refusal changes neither the tree nor the sequence
 *   T5  noteIssueTree: a PR's closing refs place it; a checked issue is not asked again; the PR stacked on another sits under it
 *   T5c a parent found by a read that began before the model removed it stays out
 *   T5d a PR state from an older read landing late does not undo a newer one (G1)
 *   T6  the tree survives save / load
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-session-registry-issue-tree-test',
}));

import { SessionRegistry } from '../session-registry';

const DIR = '/tmp/soma-work-session-registry-issue-tree-test';
const GH = 'https://github.com/a/b';
const PR = (n: number, extra: Record<string, unknown> = {}) => ({
  url: `${GH}/pull/${n}`,
  type: 'pr' as const,
  provider: 'github' as const,
  label: `PR #${n}`,
  ...extra,
});
const ISSUE = (n: number) => ({
  url: `${GH}/issues/${n}`,
  type: 'issue' as const,
  provider: 'github' as const,
  label: `#${n}`,
});
const id = (url: string) => url.toLowerCase();

function setup() {
  const reg = new SessionRegistry();
  const s = reg.createSession('U1', 'Tester', 'C1', '100.001');
  s.sessionId = 'sess-1';
  s.title = '대시보드 개선';
  return { reg, s, key: reg.getSessionKey('C1', '100.001') };
}
const tree = (reg: SessionRegistry) => reg.getSessionResourceSnapshot('C1', '100.001').issueTree!.nodes;
const parentOf = (reg: SessionRegistry, url: string) => tree(reg).find((n) => n.id === id(url))?.parent;

describe('the session issue tree (host)', () => {
  beforeEach(() => {
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true });
    fs.mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true });
  });

  it('T1: the seed for a session with no issue; a tree from the link records of one made before it', () => {
    const { reg } = setup();
    expect(tree(reg)).toEqual([
      { id: 'internal:1', kind: 'issue', source: 'internal', title: '대시보드 개선', placed: 'seed' },
    ]);
    const old = reg.createSession('U1', 'Tester', 'C1', '100.002');
    old.linkHistory = { issues: [ISSUE(3)], prs: [PR(4, { status: 'merged' })], docs: [] };
    const nodes = reg.getSessionResourceSnapshot('C1', '100.002').issueTree!.nodes;
    expect(nodes.map((n) => [n.id, n.parent ?? ''])).toEqual([
      [id(`${GH}/issues/3`), ''],
      [id(`${GH}/pull/4`), id(`${GH}/issues/3`)],
    ]);
  });

  it('T2: a noted PR sits under the seed; the first GitHub issue retires the seed and takes the PR', () => {
    const { reg } = setup();
    reg.noteSessionLinks('C1', '100.001', [PR(10, { status: 'open' })], 'always');
    expect(parentOf(reg, `${GH}/pull/10`)).toBe('internal:1');
    reg.noteSessionLinks('C1', '100.001', [ISSUE(5)], 'if-empty');
    expect(tree(reg).map((n) => n.id)).toEqual([id(`${GH}/pull/10`), id(`${GH}/issues/5`)]);
    expect(parentOf(reg, `${GH}/pull/10`)).toBe(id(`${GH}/issues/5`));
    // Docs never enter the tree.
    reg.noteSessionLinks(
      'C1',
      '100.001',
      [{ url: 'https://x.atlassian.net/wiki/p/1', type: 'doc', provider: 'confluence' }],
      'if-empty',
    );
    expect(tree(reg)).toHaveLength(2);
  });

  it('T3: a merge or close changes the node state and adds nothing; merged is final', () => {
    const { reg } = setup();
    reg.noteSessionLinks('C1', '100.001', [PR(10, { status: 'open' })], 'always');
    reg.noteSessionLinks('C1', '100.001', [PR(10, { status: 'merged' }), PR(99, { status: 'merged' })], 'update');
    expect(tree(reg).find((n) => n.id === id(`${GH}/pull/10`))?.status).toBe('merged');
    expect(tree(reg).some((n) => n.id === id(`${GH}/pull/99`))).toBe(false);
    reg.noteSessionLinks('C1', '100.001', [PR(10, { status: 'closed' })], 'update');
    expect(tree(reg).find((n) => n.id === id(`${GH}/pull/10`))?.status).toBe('merged');
  });

  it('T4: UPDATE_SESSION shapes the tree; a refusal changes neither the tree nor the sequence', () => {
    const { reg } = setup();
    const up = (operations: unknown[]) =>
      reg.updateSessionResources('C1', '100.001', { operations: operations as never });
    expect(up([{ action: 'add', resourceType: 'issue', link: ISSUE(5) }]).ok).toBe(true);
    expect(up([{ action: 'add', resourceType: 'issue', link: ISSUE(9), parent: null }]).ok).toBe(true);
    expect(up([{ action: 'add', resourceType: 'pr', link: PR(11), parent: `${GH}/issues/9` }]).ok).toBe(true);
    const made = up([{ action: 'add_internal', resourceType: 'issue', title: '조사', parent: `${GH}/issues/5` }]);
    expect(made.ok).toBe(true);
    const internal = tree(reg).find((n) => n.source === 'internal');
    expect(internal).toMatchObject({ title: '조사', parent: id(`${GH}/issues/5`), placed: 'model' });
    expect(parentOf(reg, `${GH}/pull/11`)).toBe(id(`${GH}/issues/9`));
    expect(up([{ action: 'move', resourceType: 'pr', node: `${GH}/pull/11`, parent: internal!.id }]).ok).toBe(true);
    expect(parentOf(reg, `${GH}/pull/11`)).toBe(internal!.id);
    // The card keeps its links: add_internal and move are not set_active.
    expect(reg.getSessionResourceSnapshot('C1', '100.001').active.pr?.url).toBe(`${GH}/pull/11`);
    const before = reg.getSessionResourceSnapshot('C1', '100.001');
    const refused = up([
      { action: 'add', resourceType: 'issue', link: ISSUE(77) },
      { action: 'add_internal', resourceType: 'issue', title: '먼저 성공하는 연산' },
      { action: 'move', resourceType: 'pr', node: `${GH}/pull/11`, parent: null },
    ]);
    expect(refused).toMatchObject({
      ok: false,
      reason: 'INVALID_OPERATION',
      error: expect.stringContaining('PR cannot be a root'),
    });
    const after = reg.getSessionResourceSnapshot('C1', '100.001');
    // All or nothing: the valid add and add_internal before the refused move changed neither the tree nor the card.
    expect(after.issueTree).toEqual(before.issueTree);
    expect(after.issues).toEqual(before.issues);
    expect(after.active).toEqual(before.active);
    expect(after.sequence).toBe(before.sequence);
    // remove: the link and the node; its children go up.
    expect(up([{ action: 'remove', resourceType: 'issue', url: `${GH}/issues/5` }]).ok).toBe(true);
    expect(tree(reg).some((n) => n.id === id(`${GH}/issues/5`))).toBe(false);
    expect(tree(reg).find((n) => n.id === internal!.id)?.parent).toBeUndefined();
    // remove names a node of its own kind: an issue's URL removed as a PR is refused, the tree as it was.
    const treeBefore = JSON.stringify(tree(reg));
    expect(up([{ action: 'remove', resourceType: 'pr', url: `${GH}/issues/9` }])).toMatchObject({ ok: false });
    expect(JSON.stringify(tree(reg))).toBe(treeBefore);
    // An internal issue is removed by its id (`url: internal:<n>`): its PR goes up, the card's links stay.
    const cardBefore = reg.getSessionResourceSnapshot('C1', '100.001');
    expect(up([{ action: 'remove', resourceType: 'issue', url: internal!.id }]).ok).toBe(true);
    expect(tree(reg).some((n) => n.id === internal!.id)).toBe(false);
    expect(parentOf(reg, `${GH}/pull/11`)).toBe(id(`${GH}/issues/9`));
    const cardAfter = reg.getSessionResourceSnapshot('C1', '100.001');
    expect(cardAfter.issues).toEqual(cardBefore.issues);
    expect(cardAfter.active).toEqual(cardBefore.active);
  });

  it('T5: what GitHub tells places nodes — closing refs, stacks, a parent issue; a checked issue is not asked again', () => {
    const { reg, key } = setup();
    reg.noteSessionLinks('C1', '100.001', [ISSUE(5), ISSUE(6), PR(20), PR(21)], 'history');
    expect(parentOf(reg, `${GH}/pull/20`)).toBe(id(`${GH}/issues/5`));
    expect(reg.issueTreeIssuesToCheck(key)).toEqual([`${GH}/issues/5`, `${GH}/issues/6`]);
    expect(
      reg.noteIssueTree(key, [
        { kind: 'pr', url: `${GH}/pull/20`, rel: { closes: [`${GH}/issues/6`] } },
        { kind: 'pr', url: `${GH}/pull/21`, rel: { base: `${GH}/pull/20` } },
        { kind: 'issue', url: `${GH}/issues/1`, provider: 'github' },
        {
          kind: 'issue',
          url: `${GH}/issues/6`,
          provider: 'github',
          title: 'six',
          rel: { subOf: `${GH}/issues/1` },
          checkedAt: 5,
        },
      ]),
    ).toBe(true);
    expect(parentOf(reg, `${GH}/pull/20`)).toBe(id(`${GH}/issues/6`));
    expect(parentOf(reg, `${GH}/pull/21`)).toBe(id(`${GH}/pull/20`));
    expect(parentOf(reg, `${GH}/issues/6`)).toBe(id(`${GH}/issues/1`));
    expect(tree(reg).find((n) => n.id === id(`${GH}/issues/6`))?.title).toBe('six');
    expect(reg.issueTreeIssuesToCheck(key)).toEqual([`${GH}/issues/5`, `${GH}/issues/1`]);
    // The same news again changes nothing (no save, no receipt).
    expect(reg.noteIssueTree(key, [{ kind: 'pr', url: `${GH}/pull/20`, rel: { closes: [`${GH}/issues/6`] } }])).toBe(
      false,
    );
  });

  it('T5b: a read that lands after the model removed its issue brings nothing back; a failed read rotates', () => {
    const { reg, key } = setup();
    reg.noteSessionLinks('C1', '100.001', [ISSUE(5), ISSUE(6), ISSUE(7)], 'history');
    reg.updateSessionResources('C1', '100.001', {
      operations: [{ action: 'remove', resourceType: 'issue', url: `${GH}/issues/6` }],
    });
    reg.noteIssueTree(key, [
      { kind: 'issue', url: `${GH}/issues/1`, provider: 'github', addedFor: `${GH}/issues/6` },
      { kind: 'issue', url: `${GH}/issues/6`, provider: 'github', title: 'six', checkedAt: 5, onlyIfPresent: true },
    ]);
    expect(tree(reg).map((n) => n.id)).not.toContain(id(`${GH}/issues/6`));
    expect(tree(reg).map((n) => n.id)).not.toContain(id(`${GH}/issues/1`));
    // #5 failed to read: the next pass asks #7 first.
    expect(reg.issueTreeIssuesToCheck(key)).toEqual([`${GH}/issues/5`, `${GH}/issues/7`]);
    reg.noteIssueTree(key, [{ kind: 'issue', url: `${GH}/issues/5`, triedAt: 9, onlyIfPresent: true }]);
    expect(reg.issueTreeIssuesToCheck(key)).toEqual([`${GH}/issues/7`, `${GH}/issues/5`]);
  });

  it('T5c: a parent a read found stays out when the model removed it after the read began; a later read adds it', () => {
    const { reg, key } = setup();
    reg.noteSessionLinks('C1', '100.001', [ISSUE(5), ISSUE(6)], 'history');
    const readAt = Date.now() - 1_000; // the read of #6 began before the removal
    reg.updateSessionResources('C1', '100.001', {
      operations: [{ action: 'remove', resourceType: 'issue', url: `${GH}/issues/5` }],
    });
    // #6's read says its GitHub parent is #5 — the node the model just removed.
    reg.noteIssueTree(key, [
      { kind: 'issue', url: `${GH}/issues/5`, provider: 'github', addedFor: `${GH}/issues/6`, readAt },
      { kind: 'issue', url: `${GH}/issues/6`, rel: { subOf: `${GH}/issues/5` }, checkedAt: 5, onlyIfPresent: true },
    ]);
    expect(tree(reg).map((n) => n.id)).not.toContain(id(`${GH}/issues/5`));
    expect(parentOf(reg, `${GH}/issues/6`)).toBeUndefined();
    // A read that began after the removal may add it (GitHub still says so).
    reg.noteIssueTree(key, [
      { kind: 'issue', url: `${GH}/issues/5`, provider: 'github', addedFor: `${GH}/issues/6`, readAt: Date.now() + 1 },
    ]);
    expect(parentOf(reg, `${GH}/issues/6`)).toBe(id(`${GH}/issues/5`));
  });

  it('T5d (G1): a noted link’s state carries its read time; a slower, older read landing after it does not undo it', () => {
    const { reg, key } = setup();
    const now = Date.now();
    reg.noteSessionLinks('C1', '100.001', [ISSUE(5)], 'history');
    reg.noteSessionLinks('C1', '100.001', [PR(12, { status: 'open', statusCheckedAt: now - 3_000 })], 'history');
    // The reconciler read it closed (its read began 1 s ago)…
    reg.noteSessionLinks('C1', '100.001', [PR(12, { status: 'closed', statusCheckedAt: now - 1_000 })], 'update');
    // …then a collect that began 2 s ago lands with the open state it read: it stays closed.
    reg.noteIssueTree(key, [
      { kind: 'pr', url: `${GH}/pull/12`, status: 'open', statusReadAt: now - 2_000, onlyIfPresent: true },
    ]);
    expect(tree(reg).find((n) => n.id === id(`${GH}/pull/12`))?.status).toBe('closed');
    // A read that began after the reconciler's read (1 s ago) but before its note was written (now): it reopens —
    // only when the note carried its read time (stamped at the note's own time, this read would be refused).
    reg.noteIssueTree(key, [
      { kind: 'pr', url: `${GH}/pull/12`, status: 'open', statusReadAt: now - 500, onlyIfPresent: true },
    ]);
    expect(tree(reg).find((n) => n.id === id(`${GH}/pull/12`))?.status).toBe('open');
  });

  it('T6b: a noted link reaches sessions.json with its tree change, without another save', () => {
    const { reg } = setup();
    reg.saveSessions();
    reg.noteSessionLinks('C1', '100.001', [ISSUE(5), PR(30)], 'if-empty');
    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(
      reader.getSessionResourceSnapshot('C1', '100.001').issueTree!.nodes.map((n) => [n.id, n.parent ?? '']),
    ).toEqual([
      [id(`${GH}/issues/5`), ''],
      [id(`${GH}/pull/30`), id(`${GH}/issues/5`)],
    ]);
    // A state change alone (update mode) too: the link helper saved before the tree moved.
    reg.noteSessionLinks('C1', '100.001', [PR(30, { status: 'merged' })], 'update');
    const again = new SessionRegistry();
    again.loadSessions();
    expect(
      again.getSessionResourceSnapshot('C1', '100.001').issueTree!.nodes.find((n) => n.id === id(`${GH}/pull/30`))
        ?.status,
    ).toBe('merged');
  });

  it('T6: the tree survives save / load', () => {
    const { reg } = setup();
    reg.updateSessionResources('C1', '100.001', {
      operations: [{ action: 'add_internal', resourceType: 'issue', title: '탐색' } as never],
    });
    reg.noteSessionLinks('C1', '100.001', [PR(30)], 'always');
    const saved = tree(reg);
    reg.saveSessions();
    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSessionResourceSnapshot('C1', '100.001').issueTree!.nodes).toEqual(saved);
  });
});

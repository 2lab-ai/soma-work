/**
 * 세션 링크 자동 기록 (SSOT 2026-11-02) — recording the links a conversation names.
 *
 *   N1  'if-empty' (an assistant reply): each new link joins the history; the current link of a kind is set only when
 *       there is none — a PR mentioned in passing does not replace the one the session works on
 *   N2  'first' (a user message): the first link of each kind becomes current, the others join the history
 *   N3  'always' (a PR or issue the session just created): it becomes current
 *   N4  a link already known changes nothing (no save); the same calls work by key
 *   N5  a history keeps at most MAX_NOTED_LINKS recorded links per kind: the oldest that is not current goes first;
 *       a link the model or the user set is never trimmed
 *   N6  links compare by their canonical URL: the dispatch's `/pull/12/files?x` is the `/pull/12` a turn names
 *   N7  recording never moves the sequence the model's UPDATE_SESSION compares against
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-session-registry-note-links-test',
}));

import { MAX_NOTED_LINKS, SessionRegistry } from '../session-registry';

const DIR = '/tmp/soma-work-session-registry-note-links-test';
const PR = (n: number) => ({
  url: `https://github.com/a/b/pull/${n}`,
  type: 'pr' as const,
  provider: 'github' as const,
  label: `PR #${n}`,
});
const ISSUE = (k: string) => ({
  url: `https://acme.atlassian.net/browse/${k}`,
  type: 'issue' as const,
  provider: 'jira' as const,
  label: k,
});
const DOC = {
  url: 'https://acme.atlassian.net/wiki/spaces/X/pages/1/Spec',
  type: 'doc' as const,
  provider: 'confluence' as const,
  label: 'Confluence',
};

function setup() {
  const reg = new SessionRegistry();
  const s = reg.createSession('U1', 'Tester', 'C1', '100.001');
  s.sessionId = 'sess-1';
  return { reg, s };
}

describe('noteSessionLinks', () => {
  beforeEach(() => {
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true });
    fs.mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true });
  });

  it('N1 — an assistant reply: new links join the history; the current one is set only when there is none', () => {
    const { reg, s } = setup();
    expect(reg.noteSessionLinks('C1', '100.001', [PR(700), ISSUE('PAY-1'), DOC], 'if-empty')).toBe(true);
    expect(s.links?.pr?.url).toBe(PR(700).url);
    expect(s.links?.issue?.url).toBe(ISSUE('PAY-1').url);
    expect(s.links?.doc?.url).toBe(DOC.url);
    // The session works on #800 now (the user said so); a reply mentioning #650 does not replace it.
    reg.noteSessionLinks('C1', '100.001', [PR(800)], 'always');
    reg.noteSessionLinks('C1', '100.001', [PR(650)], 'if-empty');
    expect(s.links?.pr?.url).toBe(PR(800).url);
    expect(s.linkHistory?.prs?.map((l) => l.url)).toEqual([PR(700).url, PR(800).url, PR(650).url]);
  });

  it('N2 — a user message: the first link of each kind becomes current; the rest join the history', () => {
    const { reg, s } = setup();
    reg.noteSessionLinks('C1', '100.001', [PR(1)], 'if-empty');
    reg.noteSessionLinks('C1', '100.001', [PR(2), ISSUE('OPS-9'), PR(3)], 'first');
    expect(s.links?.pr?.url).toBe(PR(2).url);
    expect(s.links?.issue?.url).toBe(ISSUE('OPS-9').url);
    expect(s.linkHistory?.prs?.map((l) => l.url)).toEqual([PR(1).url, PR(2).url, PR(3).url]);
  });

  it('N3 — a PR the session just created becomes current', () => {
    const { reg, s } = setup();
    reg.noteSessionLinks('C1', '100.001', [PR(10)], 'first');
    reg.noteSessionLinks('C1', '100.001', [PR(11)], 'always');
    expect(s.links?.pr?.url).toBe(PR(11).url);
  });

  it('N4 — a known link changes nothing; by key too', () => {
    const { reg, s } = setup();
    reg.noteSessionLinks('C1', '100.001', [PR(5)], 'if-empty');
    const save = vi.spyOn(reg, 'saveSessions');
    expect(reg.noteSessionLinks('C1', '100.001', [PR(5)], 'if-empty')).toBe(false);
    expect(reg.noteSessionLinks('C1', '100.001', [], 'always')).toBe(false);
    expect(save).not.toHaveBeenCalled();
    const key = reg.getSessionKey('C1', '100.001');
    expect(reg.noteSessionLinksByKey(key, [ISSUE('KEY-1')], 'if-empty')).toBe(true);
    expect(s.links?.issue?.url).toBe(ISSUE('KEY-1').url);
    expect(reg.noteSessionLinks('C9', '1.0', [PR(1)], 'always')).toBe(false);
  });

  it('N5 — a history keeps the newest MAX_NOTED_LINKS per kind, the current one always', () => {
    const { reg, s } = setup();
    reg.noteSessionLinks('C1', '100.001', [PR(1)], 'always');
    for (let i = 2; i <= MAX_NOTED_LINKS + 5; i++) reg.noteSessionLinks('C1', '100.001', [PR(i)], 'if-empty');
    const urls = s.linkHistory?.prs?.map((l) => l.url) ?? [];
    expect(urls).toHaveLength(MAX_NOTED_LINKS);
    expect(urls).toContain(PR(1).url);
    expect(urls).toContain(PR(MAX_NOTED_LINKS + 5).url);
    expect(urls).not.toContain(PR(2).url);
  });

  it('N5 — a link set on purpose is never trimmed', () => {
    const { reg, s } = setup();
    reg.setSessionLinks('C1', '100.001', { pr: PR(500) });
    for (let i = 1; i <= MAX_NOTED_LINKS + 3; i++) reg.noteSessionLinks('C1', '100.001', [PR(1000 + i)], 'if-empty');
    reg.noteSessionLinks('C1', '100.001', [PR(9)], 'always');
    const urls = s.linkHistory?.prs?.map((l) => l.url) ?? [];
    expect(urls).toContain(PR(500).url);
    expect(urls.filter((u) => u !== PR(500).url)).toHaveLength(MAX_NOTED_LINKS);
  });

  it('N6 — the canonical URL: what the dispatch set is not recorded twice, and stays current', () => {
    const { reg, s } = setup();
    const long = 'https://github.com/a/b/pull/12/files?notification_referrer_id=x';
    reg.setSessionLinks('C1', '100.001', { pr: { url: long, type: 'pr', provider: 'github', label: 'PR #12' } });
    expect(reg.noteSessionLinks('C1', '100.001', [PR(12)], 'first')).toBe(false);
    expect(s.linkHistory?.prs?.map((l) => l.url)).toEqual([long]);
    expect(s.links?.pr?.url).toBe(long);
    // An older PR the dispatch already set becomes current again on 'always' — its entry (not a copy) moves.
    reg.noteSessionLinks('C1', '100.001', [PR(13)], 'always');
    reg.noteSessionLinks('C1', '100.001', [PR(12)], 'always');
    expect(s.links?.pr?.url).toBe(long);
    expect(s.linkHistory?.prs?.map((l) => l.url)).toEqual([PR(13).url, long]);
  });

  it('N7 — recording never moves the sequence the model compares against', () => {
    const { reg, s } = setup();
    const before = s.linkSequence ?? 0;
    reg.noteSessionLinks('C1', '100.001', [PR(1), ISSUE('A-1'), DOC], 'always');
    expect(s.linkSequence ?? 0).toBe(before);
    expect(
      reg.updateSessionResources('C1', '100.001', {
        expectedSequence: before,
        operations: [{ action: 'add', resourceType: 'pr', link: PR(2) }],
      }).ok,
    ).toBe(true);
  });
});

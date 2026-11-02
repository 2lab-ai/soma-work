import { describe, expect, it } from 'vitest';
import { type SessionLink, ThreadHeaderBuilder, type ThreadHeaderData } from '../thread-header-builder';

/**
 * T2 — the header half of the surface redesign (2026-10-27, trinity-reviewed).
 *
 *   - colour circles belong to the session badge; the header's own markers stop
 *     using 🔴 / 🟢 and link rows carry state as words, not dots;
 *   - in the combined surface the panel states 종료됨 once, so the header can be
 *     asked to suppress its own session-status decorations;
 *   - a PR link's suffix says where its value came from: the live PR state is a
 *     bare word; the state stored when the link was recorded is past tense
 *     (`기록 당시 …`); when both exist and differ, the live word leads and the
 *     recorded one follows in parentheses. Nothing is dropped, nothing invented.
 */

const PR_URL = 'https://github.com/acme/app/pull/664';
const OTHER_PR = 'https://github.com/acme/app/pull/700';

function pr(status?: string, url = PR_URL): SessionLink {
  return { url, type: 'pr', provider: 'github', label: 'PR #664', title: 'feat: ERC20 withdraw', status };
}

function linkRow(data: Partial<ThreadHeaderData>): string {
  const payload = ThreadHeaderBuilder.build({ title: 'PR #664 Review', theme: 'default', ...data });
  const texts = (payload.blocks ?? []).flatMap((b: any) => (b.elements ?? []).map((e: any) => String(e.text)));
  return texts.find((t: string) => t.includes('PR #664')) ?? '';
}

function allText(data: Partial<ThreadHeaderData>): string {
  return JSON.stringify(ThreadHeaderBuilder.build({ title: 'PR #664 Review', ...data }).blocks);
}

describe('ThreadHeaderBuilder — T2 PR link suffix by source', () => {
  it('live equals stored → one word', () => {
    const row = linkRow({ linkHistory: { prs: [pr('merged')] }, liveLinkStatus: { [PR_URL]: 'merged' } });
    expect(row).toBe(`🔀 <${PR_URL}|PR #664>: feat: ERC20 withdraw · Merged`);
  });

  it('live differs from stored → live word first, recorded word in parentheses', () => {
    const row = linkRow({ linkHistory: { prs: [pr('open')] }, liveLinkStatus: { [PR_URL]: 'merged' } });
    expect(row).toBe(`🔀 <${PR_URL}|PR #664>: feat: ERC20 withdraw · Merged (기록 당시 Open)`);
  });

  it('stored only → past tense, never a present-tense word', () => {
    const row = linkRow({ linkHistory: { prs: [pr('open')] } });
    expect(row).toBe(`🔀 <${PR_URL}|PR #664>: feat: ERC20 withdraw · 기록 당시 Open`);
  });

  it('live only → the live word', () => {
    const row = linkRow({ linkHistory: { prs: [pr(undefined)] }, liveLinkStatus: { [PR_URL]: 'draft' } });
    expect(row).toBe(`🔀 <${PR_URL}|PR #664>: feat: ERC20 withdraw · Draft`);
  });

  it('neither → no suffix, nothing invented', () => {
    const row = linkRow({ linkHistory: { prs: [pr(undefined)] } });
    expect(row).toBe(`🔀 <${PR_URL}|PR #664>: feat: ERC20 withdraw`);
  });

  it('live state for a different URL never labels this link', () => {
    const row = linkRow({ linkHistory: { prs: [pr('open')] }, liveLinkStatus: { [OTHER_PR]: 'merged' } });
    expect(row).toBe(`🔀 <${PR_URL}|PR #664>: feat: ERC20 withdraw · 기록 당시 Open`);
  });

  it('keeps an unknown stored status verbatim, in past tense', () => {
    const issue: SessionLink = {
      url: 'https://jira.example/PROJ-4217',
      type: 'issue',
      label: 'PROJ-4217',
      status: 'In Progress',
    };
    const text = allText({ linkHistory: { issues: [issue] } });
    expect(text).toContain('🗂 <https://jira.example/PROJ-4217|PROJ-4217> · 기록 당시 In Progress');
  });

  it('uses no colour dot in any link row', () => {
    const statuses = ['open', 'draft', 'merged', 'closed', 'done', 'in review', 'in progress', 'to do'];
    for (const status of statuses) {
      const text = allText({
        linkHistory: { prs: [pr(status)], issues: [{ url: 'https://jira.example/X-1', type: 'issue', status }] },
      });
      expect(text).not.toMatch(/🟢|🟡|🔵|⚪|⬜|✅|🔴|🟣/);
    }
  });

  it('derives the live map from a PR status, keyed by the URL it was fetched for', () => {
    expect(ThreadHeaderBuilder.livePrLinkStatus(PR_URL, { state: 'merged', merged: true, draft: false })).toEqual({
      [PR_URL]: 'merged',
    });
    expect(ThreadHeaderBuilder.livePrLinkStatus(PR_URL, { state: 'open', merged: false, draft: true })).toEqual({
      [PR_URL]: 'draft',
    });
    expect(ThreadHeaderBuilder.livePrLinkStatus(PR_URL, { state: 'closed', merged: false, draft: false })).toEqual({
      [PR_URL]: 'closed',
    });
    expect(ThreadHeaderBuilder.livePrLinkStatus(PR_URL, { state: 'open', merged: false, draft: false })).toEqual({
      [PR_URL]: 'open',
    });
    expect(
      ThreadHeaderBuilder.livePrLinkStatus(undefined, { state: 'open', merged: false, draft: false }),
    ).toBeUndefined();
    expect(ThreadHeaderBuilder.livePrLinkStatus(PR_URL, undefined)).toBeUndefined();
  });
});

describe('ThreadHeaderBuilder — T2 session-status markers', () => {
  it('marks a closed header with ⚫, never 🔴', () => {
    const text = allText({ closed: true, theme: 'default' });
    expect(text).toContain('⚫ _종료됨_');
    expect(text).not.toContain('🔴');
  });

  it('drops the live dot from the compact headline and uses ⚫ when closed', () => {
    expect(allText({ theme: 'compact', ownerName: 'Z' })).toContain('*Z — PR #664 Review*');
    expect(allText({ theme: 'compact', ownerName: 'Z' })).not.toMatch(/🟢|🔴/);
    expect(allText({ theme: 'compact', ownerName: 'Z', closed: true })).toContain('⚫ *Z — PR #664 Review*');
  });

  it('suppresses its own session-status decorations when the panel states them', () => {
    for (const theme of ['default', 'compact', 'minimal'] as const) {
      const text = allText({ theme, ownerName: 'Z', closed: true, suppressSessionStatus: true });
      expect(text).not.toContain('종료됨');
      expect(text).not.toMatch(/⚫|🔴|🟢/);
      expect(text).toContain('PR #664 Review');
    }
  });

  it('leaves a standalone header (no suppression) unchanged in content', () => {
    const text = allText({ theme: 'minimal', closed: true });
    expect(text).toContain('_종료됨_');
  });
});

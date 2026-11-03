/**
 * #829 T3/T5 — the Executive Summary's ⚠️ TL;DR line is the card's "waiting for the user" signal.
 *
 * SSOT_1 (Z, 2026-11-03): "자신이 만든 이슈나 pr의 상태가 완료가 아니면 그것에 대해서 완료 할수 없는 이유가
 * 반드시 tl;dr에 포함되야 하고 그 내용은 강조해서 맨 밑에 어떻게 그 걸 처리해야하는지 방법을 자세히
 * 기술하도록 … 가능하면 그럴 경우에 작업 카드가 완료가 되면 안되고 유저의 후속 작업을 입력 대기로 표기해여함"
 *
 *  - the host prompt (Path B, no tools) carries the contract: ⚠️ bold reason line in the TL;DR, a final
 *    user follow-up section, own issues/PRs/documents marked in Status;
 *  - `followUpFromTldr` turns a ⚠️ line into the card's follow-up reason;
 *  - `displayOnThread` sets it, clears it when the new TL;DR has none, and keeps it when no TL;DR came;
 *  - `clearDisplay` (the next user input) does not clear it — only the next Executive Summary decides.
 */

import { describe, expect, it } from 'vitest';
import {
  cleanTldrLine,
  followUpFromTldr,
  SUMMARY_PROMPT,
  SummaryService,
  type SummarySessionInfo,
} from '../summary-service.js';

const BLOCKED = [
  '<tldr>',
  'PR #12 opened: login error fixed and CI is green.',
  '⚠️ **PR #12 not merged — merging needs a maintainer approval I do not have.**',
  'Next: approve and merge PR #12, then say "merged" here.',
  '</tldr>',
  '',
  '## SSOT',
  '```',
  'fix login',
  '```',
].join('\n');

const DONE = [
  '<tldr>',
  'PR #12 merged: login error fixed.',
  'CI green on main.',
  'Next: deploy to dev.',
  '</tldr>',
  '',
  '## SSOT',
].join('\n');

function session(over: Partial<SummarySessionInfo> = {}): SummarySessionInfo {
  return { isActive: true, actionPanel: {}, ...over };
}

describe('host prompt — the follow-up contract (Path B)', () => {
  it('asks for a bold ⚠️ reason line in the TL;DR when an own issue/PR is not complete', () => {
    expect(SUMMARY_PROMPT).toContain('⚠️');
    expect(SUMMARY_PROMPT).toMatch(/not complete/i);
    expect(SUMMARY_PROMPT).toMatch(/why it cannot be completed/i);
    expect(SUMMARY_PROMPT).toMatch(/\*\*/);
  });

  it('asks for a final user follow-up section with steps per item', () => {
    expect(SUMMARY_PROMPT).toMatch(/User follow-up/);
    expect(SUMMARY_PROMPT).toMatch(/very last section|last section/i);
    expect(SUMMARY_PROMPT).toMatch(/step/i);
  });

  it('asks Status to mark what this session created, documents included', () => {
    expect(SUMMARY_PROMPT).toMatch(/created this session/i);
    expect(SUMMARY_PROMPT).toMatch(/document/i);
  });

  it('reserves ⚠️ at the start of a TL;DR line for that signal only', () => {
    expect(SUMMARY_PROMPT).toMatch(/only for|reserved/i);
  });

  it('every mode prompt carries it', () => {
    const svc = new SummaryService();
    for (const s of [
      session(),
      session({ links: { pr: { url: 'https://github.com/a/b/pull/1', type: 'pr', provider: 'github' } } }),
      session({ workflow: 'z-epic-update' as any }),
    ]) {
      expect(svc.buildPrompt(s)).toContain(SUMMARY_PROMPT);
    }
  });
});

describe('followUpFromTldr — the ⚠️ line is the reason', () => {
  it('a leading ⚠️ (with or without the variation selector, in bold or not) gives the reason without markup', () => {
    expect(followUpFromTldr(['done', '⚠️ **PR #12 not merged — needs approval.**', 'next'])).toEqual({
      reason: 'PR #12 not merged — needs approval.',
    });
    expect(followUpFromTldr(['⚠ PR #3 is a draft'])).toEqual({ reason: 'PR #3 is a draft' });
    expect(followUpFromTldr(['**⚠️ Issue #9 open: waiting on QA**'])).toEqual({
      reason: 'Issue #9 open: waiting on QA',
    });
  });

  it('several ⚠️ lines join into one reason', () => {
    expect(followUpFromTldr(['⚠️ PR #1 open', '⚠️ PR #2 draft'])).toEqual({ reason: 'PR #1 open · PR #2 draft' });
  });

  it('no line starts with ⚠️: no follow-up (a ⚠️ inside a line does not count)', () => {
    expect(followUpFromTldr(['all merged', 'CI ⚠️ flaky once', 'next: deploy'])).toBeUndefined();
    expect(followUpFromTldr([])).toBeUndefined();
    expect(followUpFromTldr(['⚠️ **  **'])).toBeUndefined();
  });
});

describe('displayOnThread — the latest Executive Summary decides the follow-up', () => {
  it('a ⚠️ TL;DR line sets session.followUp with the reason and a time', () => {
    const s = session();
    new SummaryService().displayOnThread(s, BLOCKED);
    expect(s.followUp?.reason).toBe('PR #12 not merged — merging needs a maintainer approval I do not have.');
    expect(typeof s.followUp?.at).toBe('number');
  });

  it('a TL;DR without one clears it', () => {
    const s = session({ followUp: { reason: 'old', at: 1 } });
    new SummaryService().displayOnThread(s, DONE);
    expect(s.followUp).toBeUndefined();
  });

  it('no TL;DR at all (malformed reply) keeps the previous verdict', () => {
    const s = session({ followUp: { reason: 'old', at: 1 } });
    new SummaryService().displayOnThread(s, '## SSOT\nno envelope here');
    expect(s.followUp).toEqual({ reason: 'old', at: 1 });
  });

  it('it is decided even without a thread panel (a Slack-less task)', () => {
    const s: SummarySessionInfo = { isActive: true };
    new SummaryService().displayOnThread(s, BLOCKED);
    expect(s.followUp?.reason).toContain('PR #12');
  });

  // trinity R2 (astra/fable P2): the es turn's card is one pair — TL;DR and verdict are kept or replaced together.
  it("the model-run es's card (TL;DR + verdict) survives the same turn's host summary, then the next one decides", () => {
    const svc = new SummaryService();
    const esTldr = ['PR #12 opened.', '⚠️ **PR #12 not merged (checked with gh)**', 'Next: merge #12.'];
    const s = session({
      executiveSummary: { tldr: esTldr, at: 1, source: 'es' },
      followUp: { reason: 'PR #12 not merged (checked with gh)', at: 1 },
    });
    svc.displayOnThread(s, DONE); // same turn: the host fork has no tools — the es card stands as a pair
    expect(s.executiveSummary).toEqual({ tldr: esTldr, at: 1, source: 'es' });
    expect(s.followUp).toEqual({ reason: 'PR #12 not merged (checked with gh)', at: 1 });
    svc.clearDisplay(s); // the user's next input: the box goes, the verdict stays until a summary judges it
    expect(s.executiveSummary).toBeUndefined();
    expect(s.followUp).toEqual({ reason: 'PR #12 not merged (checked with gh)', at: 1 });
    svc.displayOnThread(s, DONE);
    expect(s.followUp).toBeUndefined();
    expect(s.executiveSummary?.tldr[0]).toBe('PR #12 merged: login error fixed.');
  });

  it("the reverse: es said everything is complete — the same turn's host ⚠️ line does not add a follow-up", () => {
    const svc = new SummaryService();
    const s = session({
      executiveSummary: { tldr: ['PR #12 merged.', 'CI green.', 'Next: deploy.'], at: 1, source: 'es' },
    });
    svc.displayOnThread(s, BLOCKED);
    expect(s.followUp).toBeUndefined();
    expect(s.executiveSummary?.tldr[0]).toBe('PR #12 merged.');
  });

  it('a list marker before the ⚠️ line does not hide the signal (both paths normalize the same way)', () => {
    expect(cleanTldrLine('- ⚠️ **PR #3 is a draft**')).toBe('⚠️ **PR #3 is a draft**');
    expect(cleanTldrLine('  1. plain line ')).toBe('plain line');
  });

  it('clearDisplay (the next user input) leaves it: the card stays waiting until the next summary', () => {
    const s = session();
    const svc = new SummaryService();
    svc.displayOnThread(s, BLOCKED);
    svc.clearDisplay(s);
    expect(s.executiveSummary).toBeUndefined();
    expect(s.followUp?.reason).toContain('PR #12');
  });
});

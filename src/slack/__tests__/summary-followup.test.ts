/**
 * #829 T3/T5 — the Executive Summary's ⚠️ TL;DR line is the card's "waiting for the user" signal.
 *
 * SSOT_1 (Z, 2026-11-03): "자신이 만든 이슈나 pr의 상태가 완료가 아니면 그것에 대해서 완료 할수 없는 이유가
 * 반드시 tl;dr에 포함되야 하고 그 내용은 강조해서 맨 밑에 어떻게 그 걸 처리해야하는지 방법을 자세히
 * 기술하도록 … 가능하면 그럴 경우에 작업 카드가 완료가 되면 안되고 유저의 후속 작업을 입력 대기로 표기해여함"
 *
 *  - the turn-end prompt (Path B, no tools) carries `local:auto-es`'s contract (#857): ⚠️ bold reason line in the
 *    TL;DR, a final user follow-up section, own issues/PRs/documents marked in Status;
 *  - `followUpFromTldr` turns a ⚠️ line into the card's follow-up reason;
 *  - `displayOnThread` sets it, clears it when the new TL;DR has none, and keeps it when no TL;DR came;
 *  - `clearDisplay` (the next user input) does not clear it — only the next Executive Summary decides.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO_ES_TURN_END_FILE, loadAutoEsTurnEndContract } from '../../plugin/harness-skills';
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

// #857 — the turn-end summary runs `local:auto-es`: the host's tool-less fork is prompted with that skill's
// turn-end contract, read from the harness plugin. SUMMARY_PROMPT stays the generic es contract.
describe('turn end — the host runs local:auto-es (Path B)', () => {
  const contract = loadAutoEsTurnEndContract();

  it('loads the contract from the harness skill file', () => {
    expect(AUTO_ES_TURN_END_FILE.split(path.sep).join('/')).toMatch(
      /local-harness\/skills\/auto-es\/reference\/turn-end\.md$/,
    );
    expect(contract).toBe(readFileSync(AUTO_ES_TURN_END_FILE, 'utf8').trim());
  });

  it('the contract asks for the bold ⚠️ reason line, the final follow-up section and the 🆕 marks', () => {
    expect(contract).toContain('⚠️');
    expect(contract).toMatch(/why it cannot be completed/i);
    expect(contract).toMatch(/\*\*/);
    expect(contract).toMatch(/User follow-up required/);
    expect(contract).toMatch(/very last section/i);
    expect(contract).toMatch(/step/i);
    expect(contract).toMatch(/created this session/i);
    expect(contract).toMatch(/reserved/i);
  });

  it('every mode prompt carries SUMMARY_PROMPT and then the auto-es contract', () => {
    const svc = new SummaryService(undefined, undefined, { turnEndContract: contract });
    for (const s of [
      session(),
      session({ links: { pr: { url: 'https://github.com/a/b/pull/1', type: 'pr', provider: 'github' } } }),
      session({ workflow: 'z-epic-update' as any }),
    ]) {
      const prompt = svc.buildPrompt(s);
      expect(prompt).toContain(SUMMARY_PROMPT);
      expect(prompt).toContain(contract as string);
      expect(prompt.indexOf(contract as string)).toBeGreaterThan(prompt.indexOf(SUMMARY_PROMPT));
    }
  });

  // trinity R1 (grok P1): appended after SUMMARY_PROMPT and the mode template, the contract must say it overrides
  // their TL;DR line rule and section order — otherwise the prompt forbids the very ⚠️ line the card waits on.
  it('the contract states it overrides the TL;DR line rule and the section order before it', () => {
    const head = (contract as string).split('\n')[0];
    expect(head).toMatch(/override/i);
    expect(head).toMatch(/TL;DR/);
    expect(head).toMatch(/section order|last section/i);
    expect(head).toMatch(/mode template/i);
  });

  it('the composed turn-end prompt asks for the ⚠️ line and the final section without leaving the conflict open', () => {
    const prompt = new SummaryService(undefined, undefined, { turnEndContract: contract }).buildPrompt(
      session({ links: { pr: { url: 'https://github.com/a/b/pull/1', type: 'pr', provider: 'github' } } }),
    );
    const override = prompt.search(/override/i);
    expect(override).toBeGreaterThan(prompt.indexOf(SUMMARY_PROMPT));
    expect(prompt.indexOf('⚠️ **')).toBeGreaterThan(override);
    expect(prompt.indexOf('User follow-up required')).toBeGreaterThan(override);
  });

  it('SUMMARY_PROMPT is the generic es contract — the harness rules live in the skill', () => {
    expect(SUMMARY_PROMPT).not.toContain('⚠️');
    expect(SUMMARY_PROMPT).not.toMatch(/created this session|User follow-up required/);
    expect(new SummaryService().buildPrompt(session())).not.toContain('⚠️');
  });

  it('a missing file is undefined, never a throw', () => {
    expect(loadAutoEsTurnEndContract('/nonexistent/turn-end.md')).toBeUndefined();
  });

  it('the service wiring hands the auto-es contract to the turn-end summary', () => {
    const src = readFileSync(path.resolve(__dirname, '..', '..', 'slack-handler.ts'), 'utf8');
    expect(src).toMatch(
      /new SummaryService\(\s*forkExecutor,\s*this\.slackApi,\s*\{\s*turnEndContract: loadAutoEsTurnEndContract\(\),?\s*\}\s*\)/,
    );
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

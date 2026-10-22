/**
 * Executive Summary — TL;DR on the channel surface, full text in the thread.
 *
 * SSOT (Z, 2026-10-22): "스레드안에는 전체를 출력하고 스레드 서피스 (채널에서
 * 보이는 화면)에는 별도로 세줄요약으로 출력해줘. 지금 채널에서 작업하나가
 * 익스큐티브 서머리 너무 길에서 지저분함 / 익스큐티브 서머리를 항상 tldr이랑
 * 같이 받고 스레드 서피스에는 tldr만 출력"
 *
 * Before: `displayOnThread` and `postInThread` rendered the same full ES, so
 * the thread root message — the one the channel timeline shows — grew by the
 * whole summary on every completed turn.
 *
 * After:
 * - T3: the ES prompt always asks for a `<tldr>` block of exactly 3 lines, and
 *   the host parses it out (`parseExecutiveSummary`).
 * - T2: the thread surface shows only the TL;DR — never more than 3 lines,
 *   even when the model ignores the contract.
 * - T1: the in-thread message keeps the full ES (TL;DR + body), with the raw
 *   `<tldr>` tag removed so Slack does not read it as a link token.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type ExecutiveSummaryMode,
  parseExecutiveSummary,
  SUMMARY_PROMPT,
  SummaryService,
  type SummarySessionInfo,
  TLDR_MISSING_POINTER,
} from '../summary-service.js';

const BODY_MARKER = 'BODY_ONLY_DETAIL_src/slack/foo.ts:42';

const TAGGED = [
  '<tldr>',
  'PR #7 merged: the channel surface now shows a 3-line TL;DR.',
  'The full Executive Summary is still posted inside the thread.',
  'Next: deploy to dev and check one real turn.',
  '</tldr>',
  '',
  '## SSOT',
  '```',
  '스레드 서피스에는 tldr만 출력',
  '```',
  '## Summary',
  `Edited ${BODY_MARKER} and ran npm test (passed).`,
].join('\n');

function makeSession(overrides: Partial<SummarySessionInfo & Record<string, any>> = {}): any {
  return { isActive: true, actionPanel: {}, ...overrides };
}

function surfaceText(session: any): string {
  return (session.actionPanel.summaryBlocks as any[])
    .filter((b) => b.type === 'section')
    .map((b) => b.text.text as string)
    .join('\n');
}

// ── T3: prompt contract ──────────────────────────────────────────────────
describe('T3 — ES prompt always asks for a 3-line <tldr> block', () => {
  it('SUMMARY_PROMPT carries the <tldr> … </tldr> contract with exactly 3 lines', () => {
    expect(SUMMARY_PROMPT).toContain('<tldr>');
    expect(SUMMARY_PROMPT).toContain('</tldr>');
    expect(SUMMARY_PROMPT).toMatch(/exactly 3 lines/i);
  });

  it.each<[ExecutiveSummaryMode, Partial<SummarySessionInfo>]>([
    ['brief', {}],
    [
      'issue',
      {
        links: { pr: { url: 'https://github.com/o/r/pull/7', type: 'pr', provider: 'github' } },
        linkHistory: {
          issues: [],
          prs: [{ url: 'https://github.com/o/r/pull/7', type: 'pr', provider: 'github' }],
          docs: [],
        },
      },
    ],
    ['epic', { workflow: 'z-epic-update' as any }],
  ])('buildPrompt() in %s mode includes the <tldr> contract', (mode, overrides) => {
    const prompt = new SummaryService().buildPrompt(makeSession(overrides));
    expect(prompt).toContain(`Active ES mode: ${mode}`);
    expect(prompt).toContain('<tldr>');
  });
});

// ── T3: host parser ──────────────────────────────────────────────────────
describe('T3 — parseExecutiveSummary()', () => {
  it('extracts the model TL;DR and removes the block from the body', () => {
    const parsed = parseExecutiveSummary(TAGGED);
    expect(parsed.tldrSource).toBe('model');
    expect(parsed.tldr).toEqual([
      'PR #7 merged: the channel surface now shows a 3-line TL;DR.',
      'The full Executive Summary is still posted inside the thread.',
      'Next: deploy to dev and check one real turn.',
    ]);
    expect(parsed.body).toContain(BODY_MARKER);
    expect(parsed.body).not.toMatch(/<\/?tldr>/i);
    expect(parsed.body).not.toContain('Next: deploy to dev');
    expect(parsed.body.startsWith('## SSOT')).toBe(true);
  });

  it('strips bullet / numbering markers and blank lines inside the block', () => {
    const parsed = parseExecutiveSummary('<TLDR>\n- one\n\n* two\n2. three\n</TLDR>\nbody');
    expect(parsed.tldr).toEqual(['one', 'two', 'three']);
    expect(parsed.body).toBe('body');
  });

  it('keeps at most 3 lines when the model returns more', () => {
    const parsed = parseExecutiveSummary('<tldr>\na\nb\nc\nd\ne\n</tldr>\nbody');
    expect(parsed.tldr).toEqual(['a', 'b', 'c']);
  });

  it('caps each TL;DR line length so one line cannot carry the whole summary', () => {
    const parsed = parseExecutiveSummary(`<tldr>\n${'x'.repeat(500)}\n</tldr>\nbody`);
    expect(parsed.tldr).toHaveLength(1);
    expect(parsed.tldr[0].length).toBeLessThanOrEqual(140);
    expect(parsed.tldr[0].endsWith('…')).toBe(true);
  });

  it('ignores a <tldr> block that is not at the top — the body keeps it verbatim', () => {
    const raw = 'Executive Summary\n<tldr>\nonly line\n</tldr>\nbody';
    const parsed = parseExecutiveSummary(raw);
    expect(parsed.tldrSource).toBe('missing');
    expect(parsed.tldr).toEqual([]);
    expect(parsed.body).toBe(raw);
  });

  it('never builds a TL;DR out of the body when the model omits the block', () => {
    // The body starts with the verbatim SSOT quote and Status links; lifting
    // "the first lines" would put the user's own instruction on the channel.
    const raw = [
      '## SSOT',
      '스레드 서피스에는 tldr만 출력',
      '## Status',
      '- PR: https://github.com/o/r/pull/7 — Merged',
      '## Summary',
      'Edited the summary service.',
    ].join('\n');
    const parsed = parseExecutiveSummary(raw);
    expect(parsed.tldrSource).toBe('missing');
    expect(parsed.tldr).toEqual([]);
    expect(parsed.body).toBe(raw);
  });

  it('treats an unclosed leading <tldr> as missing, dropping only the opener line', () => {
    const parsed = parseExecutiveSummary('<tldr>\nfirst\nsecond\n## SSOT\nquote');
    expect(parsed.tldrSource).toBe('missing');
    expect(parsed.tldr).toEqual([]);
    expect(parsed.body).toBe('first\nsecond\n## SSOT\nquote');
  });

  it('does not let a </tldr> inside a fenced example close an unclosed leading opener', () => {
    const raw = '<tldr>\nfirst\n```\n</tldr>\n```\nafter';
    const parsed = parseExecutiveSummary(raw);
    expect(parsed.tldrSource).toBe('missing');
    expect(parsed.body).toBe('first\n```\n</tldr>\n```\nafter');
  });

  it('treats a closed but empty block as missing and removes the envelope', () => {
    const parsed = parseExecutiveSummary('<tldr>\n\n</tldr>\nreal content');
    expect(parsed.tldrSource).toBe('missing');
    expect(parsed.tldr).toEqual([]);
    expect(parsed.body).toBe('real content');
  });

  it('keeps <tldr> examples that appear inside the document body', () => {
    const raw = [
      '<tldr>',
      'one',
      '</tldr>',
      'The prompt now asks for a `<tldr>` block:',
      '```',
      '<tldr>',
      'x',
      '</tldr>',
      '```',
    ].join('\n');
    const parsed = parseExecutiveSummary(raw);
    expect(parsed.tldr).toEqual(['one']);
    expect(parsed.body).toBe(
      ['The prompt now asks for a `<tldr>` block:', '```', '<tldr>', 'x', '</tldr>', '```'].join('\n'),
    );
  });

  it('accepts leading blank lines before the block', () => {
    const parsed = parseExecutiveSummary('\n\n<tldr>\na\n</tldr>\nbody');
    expect(parsed.tldrSource).toBe('model');
    expect(parsed.tldr).toEqual(['a']);
    expect(parsed.body).toBe('body');
  });
});

// ── T2: thread surface = TL;DR only ──────────────────────────────────────
describe('T2 — displayOnThread() puts only the TL;DR on the thread surface', () => {
  it('renders divider + one section holding the 3 TL;DR lines and none of the body', () => {
    const service = new SummaryService();
    const session = makeSession();
    service.displayOnThread(session, TAGGED);

    const blocks = session.actionPanel.summaryBlocks as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'divider' });
    const text = surfaceText(session);
    expect(text).toContain('TL;DR');
    expect(text).toContain('PR #7 merged: the channel surface now shows a 3-line TL;DR.');
    expect(text).toContain('Next: deploy to dev and check one real turn.');
    expect(text).not.toContain(BODY_MARKER);
    expect(text).not.toContain('스레드 서피스에는 tldr만 출력');
    expect(text).not.toMatch(/<\/?tldr>/i);
  });

  it('shows the pointer line, not the body, when the model ignores the contract (long untagged ES)', () => {
    const service = new SummaryService();
    const session = makeSession();
    const longEs = Array.from({ length: 80 }, (_, i) => `- line ${i} ${'detail '.repeat(10)}`).join('\n');
    service.displayOnThread(session, longEs);

    const blocks = session.actionPanel.summaryBlocks as any[];
    expect(blocks.length).toBeLessThanOrEqual(2);
    const lines = surfaceText(session)
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(4); // header + 3 TL;DR lines
    expect(surfaceText(session)).not.toContain('line 0 ');
    expect(surfaceText(session)).toContain(TLDR_MISSING_POINTER);
  });

  it('converts GFM bold in TL;DR lines to Slack mrkdwn', () => {
    const service = new SummaryService();
    const session = makeSession();
    service.displayOnThread(session, '<tldr>\n**PR #7** merged\n</tldr>\nbody');
    expect(surfaceText(session)).toContain('*PR #7* merged');
    expect(surfaceText(session)).not.toContain('**PR #7**');
  });

  it('never leaves the surface blank: a missing TL;DR becomes one pointer line', () => {
    const service = new SummaryService();
    const session = makeSession();
    service.displayOnThread(session, '```\nonly code\n```');
    const lines = surfaceText(session)
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2); // header + pointer
    expect(surfaceText(session)).toContain(TLDR_MISSING_POINTER);
    expect(surfaceText(session)).not.toContain('only code');
  });
});

// ── T1: in-thread message = full ES ──────────────────────────────────────
describe('T1 — postInThread() posts the full ES (TL;DR + body) inside the thread', () => {
  it('posts the TL;DR and the full body, without the raw <tldr> tag', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: '1.234' });
    const service = new SummaryService(undefined, { postMessage });
    const session = makeSession({ channelId: 'C1', threadTs: '1700000000.000' });

    await service.postInThread(session, TAGGED);

    expect(postMessage).toHaveBeenCalledOnce();
    const [, , opts] = postMessage.mock.calls[0];
    expect(opts.threadTs).toBe('1700000000.000');
    const text = (opts.blocks as any[])
      .filter((b) => b.type === 'section')
      .map((b) => b.text.text as string)
      .join('\n');
    expect(text).toContain('Executive Summary');
    expect(text).toContain('PR #7 merged: the channel surface now shows a 3-line TL;DR.');
    expect(text).toContain(BODY_MARKER);
    expect(text).toContain('스레드 서피스에는 tldr만 출력');
    expect(text).not.toMatch(/<\/?tldr>/i);
  });

  it('keeps chunking a long body under the 3000-char section limit', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: '1.234' });
    const service = new SummaryService(undefined, { postMessage });
    const session = makeSession({ channelId: 'C1', threadTs: '1700000000.000' });
    const longBody = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');

    await service.postInThread(session, `<tldr>\na\nb\nc\n</tldr>\n${longBody}`);

    const blocks = postMessage.mock.calls[0][2].blocks as any[];
    const sections = blocks.filter((b) => b.type === 'section');
    expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const s of sections) expect(s.text.text.length).toBeLessThanOrEqual(3000);
    const text = sections.map((s) => s.text.text).join('\n');
    expect(text).toContain('line 199');
  });
});

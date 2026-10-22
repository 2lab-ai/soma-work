import { ReleaseNotesDirectiveHandler } from '@soma/slack/directives/release-notes-directive';
import { describe, expect, it } from 'vitest';

const VALID = {
  type: 'release_notes',
  repo: 'acme/App',
  target: 'deploy/dev2',
  version: '0.2.58 (c8a026e)',
  tldr: ['Fixed payout rounding', 'Added the settings screen', 'Faster admin login'],
  text: '# Release Notes (English)\n\n# App deploy/dev2 c8a026e — 2026-10-22\n\n- item',
};

const PAYLOAD = {
  repo: VALID.repo,
  target: VALID.target,
  version: VALID.version,
  tldr: VALID.tldr,
  text: VALID.text,
};

describe('ReleaseNotesDirectiveHandler', () => {
  it('returns nothing for plain text', () => {
    const result = ReleaseNotesDirectiveHandler.extract('Deployed.');
    expect(result.payloads).toEqual([]);
    expect(result.cleanedText).toBe('Deployed.');
  });

  it('extracts a fenced directive and strips it', () => {
    const text = `Merged.\n\`\`\`json\n${JSON.stringify(VALID, null, 2)}\n\`\`\`\nRelease notes posted.`;
    const result = ReleaseNotesDirectiveHandler.extract(text);
    expect(result.payloads).toEqual([PAYLOAD]);
    expect(result.cleanedText).toBe('Merged.\n\nRelease notes posted.');
  });

  it('extracts a raw directive and strips it', () => {
    const text = `Merged.\n${JSON.stringify(VALID)}\nDone.`;
    const result = ReleaseNotesDirectiveHandler.extract(text);
    expect(result.payloads).toEqual([PAYLOAD]);
    expect(result.cleanedText).toBe('Merged.\n\nDone.');
  });

  it('collects one directive per repo in a multi-repo deploy, in order', () => {
    const other = { ...VALID, repo: 'acme/Web', version: '1.4.0 (abc1234)' };
    const text = `${JSON.stringify(VALID)}\n${JSON.stringify(other)}`;
    const result = ReleaseNotesDirectiveHandler.extract(text);
    expect(result.payloads.map((p) => p.repo)).toEqual(['acme/App', 'acme/Web']);
    expect(result.cleanedText).toBe('');
  });

  it('accepts one to three TL;DR lines', () => {
    const one = ReleaseNotesDirectiveHandler.extract(JSON.stringify({ ...VALID, tldr: ['Only change'] }));
    expect(one.payloads[0].tldr).toEqual(['Only change']);
  });

  it.each([
    ['four TL;DR lines', { tldr: ['a', 'b', 'c', 'd'] }],
    ['no TL;DR lines', { tldr: [] }],
    ['an empty TL;DR line', { tldr: ['a', ' '] }],
    ['a multi-line TL;DR entry', { tldr: ['a\nb'] }],
    ['a repo that is not owner/repo', { repo: 'App' }],
    ['an empty version', { version: '' }],
    ['an empty text', { text: '   ' }],
    ['a target with spaces', { target: 'deploy dev2' }],
  ])('leaves a directive with %s in the text', (_label, override) => {
    const raw = JSON.stringify({ ...VALID, ...override });
    const result = ReleaseNotesDirectiveHandler.extract(`Merged.\n${raw}`);
    expect(result.payloads).toEqual([]);
    expect(result.cleanedText).toBe(`Merged.\n${raw}`);
  });

  it('ignores prose that names the directive without a JSON object', () => {
    const text = 'I will emit the `"release_notes"` directive next.';
    expect(ReleaseNotesDirectiveHandler.extract(text)).toEqual({ payloads: [], cleanedText: text });
  });

  it('does not touch a channel_message directive', () => {
    const text = JSON.stringify({ type: 'channel_message', text: 'hi' });
    expect(ReleaseNotesDirectiveHandler.extract(text).payloads).toEqual([]);
  });
});

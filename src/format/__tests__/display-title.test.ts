import { describe, expect, it } from 'vitest';
import {
  displayTitle,
  isPlaceholderSessionTitle,
  PLACEHOLDER_SESSION_TITLE,
  SESSION_RESET_TITLE,
  SKIP_DISPATCH_TITLE,
} from '../display-title';

describe('displayTitle — Dashboard v2.1 chunk E + #762 link-derived priority', () => {
  it('prefers summaryTitle when present and non-empty', () => {
    expect(displayTitle({ summaryTitle: 'LLM title', title: 'fallback' })).toBe('LLM title');
  });

  it('falls back to title when summaryTitle is missing', () => {
    expect(displayTitle({ title: 'plain title' })).toBe('plain title');
  });

  it('treats empty-string summaryTitle as missing and falls through to title', () => {
    expect(displayTitle({ summaryTitle: '', title: 'plain title' })).toBe('plain title');
    expect(displayTitle({ summaryTitle: '   ', title: 'plain title' })).toBe('plain title');
  });

  it('treats empty-string title as missing and returns Untitled', () => {
    expect(displayTitle({ summaryTitle: undefined, title: '' })).toBe('Untitled');
    expect(displayTitle({ summaryTitle: '   ', title: '   ' })).toBe('Untitled');
  });

  it('returns Untitled when both fields are missing', () => {
    expect(displayTitle({})).toBe('Untitled');
    expect(displayTitle({ summaryTitle: undefined, title: undefined })).toBe('Untitled');
  });

  // ── #762: link-derived priority chain ─────────────────────────────────

  it('prefers issue title over PR title and raw title when summaryTitle is absent', () => {
    expect(
      displayTitle({
        title: 'first-message blob',
        links: {
          issue: { title: 'Fix login redirect bug' },
          pr: { title: 'Add OAuth2 callback handler' },
        },
      }),
    ).toBe('Fix login redirect bug');
  });

  it('falls through to PR title when issue link has no fetched title', () => {
    expect(
      displayTitle({
        title: 'raw',
        links: {
          issue: { title: undefined },
          pr: { title: 'Add OAuth2 callback handler' },
        },
      }),
    ).toBe('Add OAuth2 callback handler');
  });

  it('falls through to title when both link titles are blank', () => {
    expect(
      displayTitle({
        title: 'raw first message',
        links: {
          issue: { title: '' },
          pr: { title: '   ' },
        },
      }),
    ).toBe('raw first message');
  });

  it('summaryTitle still wins over fetched issue/PR titles', () => {
    expect(
      displayTitle({
        summaryTitle: 'LLM-generated headline',
        title: 'raw',
        links: {
          issue: { title: 'Fix login bug' },
          pr: { title: 'Add OAuth2 handler' },
        },
      }),
    ).toBe('LLM-generated headline');
  });

  it('whitespace-only summaryTitle falls through to issue title (not Untitled)', () => {
    expect(
      displayTitle({
        summaryTitle: '   ',
        title: '',
        links: { issue: { title: 'Fix login bug' } },
      }),
    ).toBe('Fix login bug');
  });

  it('whitespace-only issue title falls through to PR title', () => {
    expect(
      displayTitle({
        links: { issue: { title: '   ' }, pr: { title: 'Add tests' } },
      }),
    ).toBe('Add tests');
  });

  it('returns Untitled when nothing in the chain has content', () => {
    expect(
      displayTitle({
        summaryTitle: '',
        title: '   ',
        links: { issue: { title: '' }, pr: { title: '   ' } },
      }),
    ).toBe('Untitled');
  });

  it('trims trailing/leading whitespace on the resolved title', () => {
    // displayTitle uses nonBlank() which trims; verify the trimmed value is returned.
    expect(displayTitle({ summaryTitle: '  My Title  ' })).toBe('My Title');
    expect(displayTitle({ links: { issue: { title: '  Issue Headline  ' } } })).toBe('Issue Headline');
  });
});

// Voice / image-only first messages leave a host-written stand-in title.
// These are the ONLY strings the host writes when it has no real title, and
// the session-title notice keys off them — so they live in one place.
describe('isPlaceholderSessionTitle — host stand-in titles', () => {
  it('recognises every host-written stand-in title', () => {
    expect(PLACEHOLDER_SESSION_TITLE).toBe('New Session');
    expect(SESSION_RESET_TITLE).toBe('Session Reset');
    expect(SKIP_DISPATCH_TITLE).toBe('Direct (skipDispatch)');
    for (const t of [PLACEHOLDER_SESSION_TITLE, SESSION_RESET_TITLE, SKIP_DISPATCH_TITLE]) {
      expect(isPlaceholderSessionTitle(t)).toBe(true);
    }
  });

  it('ignores surrounding whitespace', () => {
    expect(isPlaceholderSessionTitle('  New Session  ')).toBe(true);
  });

  it('treats a deliberate title as real', () => {
    expect(isPlaceholderSessionTitle('음성·이미지 첫 지시 세션의 대시보드 제목 자동 갱신')).toBe(false);
    expect(isPlaceholderSessionTitle('Onboarding')).toBe(false);
    expect(isPlaceholderSessionTitle('New Session plan for Q3')).toBe(false);
  });

  // Empty titles belong to the pre-existing per-turn summary fallback
  // (src/index.ts onSummaryGenerated). Claiming them here would race it.
  it('leaves empty titles to the per-turn summary fallback', () => {
    expect(isPlaceholderSessionTitle(undefined)).toBe(false);
    expect(isPlaceholderSessionTitle('')).toBe(false);
    expect(isPlaceholderSessionTitle('   ')).toBe(false);
  });
});

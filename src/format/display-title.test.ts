import { describe, expect, it } from 'vitest';
import { displayTitle } from './display-title';

describe('displayTitle — Dashboard v2.1 chunk E', () => {
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
});

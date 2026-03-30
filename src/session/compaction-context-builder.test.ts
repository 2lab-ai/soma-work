import { describe, it, expect } from 'vitest';
import { buildCompactionContext, CompactionContextInput } from './compaction-context-builder';

describe('compaction-context-builder', () => {
  const baseInput: CompactionContextInput = {
    sessionTitle: undefined,
    workflow: undefined,
    links: undefined,
    linkHistory: undefined,
    persona: undefined,
    effort: undefined,
  };

  it('returns empty string when no context to preserve', () => {
    const result = buildCompactionContext(baseInput);
    expect(result).toBe('');
  });

  it('includes session title when present', () => {
    const result = buildCompactionContext({
      ...baseInput,
      sessionTitle: '[PTN-123] Fix auth bug',
    });
    expect(result).toContain('[PTN-123] Fix auth bug');
    expect(result).toContain('세션 제목');
  });

  it('includes workflow type when present', () => {
    const result = buildCompactionContext({
      ...baseInput,
      workflow: 'pr-review',
    });
    expect(result).toContain('pr-review');
  });

  it('includes active session links when present', () => {
    const result = buildCompactionContext({
      ...baseInput,
      links: {
        issue: { type: 'issue', url: 'https://github.com/org/repo/issues/42', provider: 'github', label: '#42' },
        pr: { type: 'pr', url: 'https://github.com/org/repo/pull/99', provider: 'github', label: 'PR #99' },
      },
    });
    expect(result).toContain('https://github.com/org/repo/issues/42');
    expect(result).toContain('https://github.com/org/repo/pull/99');
  });

  it('includes link history when present', () => {
    const result = buildCompactionContext({
      ...baseInput,
      linkHistory: {
        issues: [
          { type: 'issue', url: 'https://jira.example.com/PTN-100', provider: 'jira', label: 'PTN-100' },
        ],
        prs: [],
        docs: [],
      },
    });
    expect(result).toContain('PTN-100');
  });

  it('includes persona when not default', () => {
    const result = buildCompactionContext({
      ...baseInput,
      persona: 'linus',
    });
    expect(result).toContain('linus');
  });

  it('does NOT include default persona', () => {
    const result = buildCompactionContext({
      ...baseInput,
      persona: 'default',
    });
    expect(result).not.toContain('persona');
  });

  it('includes effort level when present', () => {
    const result = buildCompactionContext({
      ...baseInput,
      effort: 'max',
    });
    expect(result).toContain('max');
  });

  it('combines multiple fields', () => {
    const result = buildCompactionContext({
      sessionTitle: 'Implement feature X',
      workflow: 'jira-create-pr',
      links: {
        issue: { type: 'issue', url: 'https://jira.example.com/PTN-456', provider: 'jira', label: 'PTN-456' },
      },
      linkHistory: { issues: [], prs: [], docs: [] },
      persona: 'einstein',
      effort: 'high',
    });
    expect(result).toContain('Implement feature X');
    expect(result).toContain('jira-create-pr');
    expect(result).toContain('PTN-456');
    expect(result).toContain('einstein');
    expect(result).toContain('high');
  });

  it('wraps output in system-reminder tags', () => {
    const result = buildCompactionContext({
      ...baseInput,
      sessionTitle: 'Test',
    });
    expect(result).toMatch(/^<system-reminder>/);
    expect(result).toMatch(/<\/system-reminder>$/);
  });

  it('stays within token budget (~1500 tokens ≈ ~6000 chars)', () => {
    const result = buildCompactionContext({
      sessionTitle: 'A'.repeat(200),
      workflow: 'jira-create-pr',
      links: {
        issue: { type: 'issue', url: 'https://github.com/org/repo/issues/1', provider: 'github' },
        pr: { type: 'pr', url: 'https://github.com/org/repo/pull/2', provider: 'github' },
        doc: { type: 'doc', url: 'https://confluence.example.com/doc/3', provider: 'confluence' },
      },
      linkHistory: {
        issues: Array.from({ length: 10 }, (_, i) => ({
          type: 'issue' as const,
          url: `https://github.com/org/repo/issues/${i}`,
          provider: 'github' as const,
        })),
        prs: Array.from({ length: 10 }, (_, i) => ({
          type: 'pr' as const,
          url: `https://github.com/org/repo/pull/${i}`,
          provider: 'github' as const,
        })),
        docs: [],
      },
      persona: 'linus',
      effort: 'max',
    });
    expect(result.length).toBeLessThan(6000);
  });
});

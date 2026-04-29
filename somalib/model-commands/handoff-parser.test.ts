import { describe, expect, it } from 'vitest';
import {
  expectedHandoffKind,
  extractSentinelType,
  HandoffAbortError,
  hasHandoffSentinel,
  parseHandoff,
} from './handoff-parser';

// -------------------------------------------------------------------
// Fixture helpers — mirror SKILL.md §Session Handoff Protocol payloads.
// -------------------------------------------------------------------

function planToWorkMinimal(): string {
  return [
    '$z phase2 https://github.com/owner/repo/issues/42',
    '',
    '<z-handoff type="plan-to-work">',
    '## Issue',
    'https://github.com/owner/repo/issues/42',
    '## Parent Epic',
    'https://github.com/owner/repo/issues/10',
    '## Task List',
    '- [ ] first task',
    '- [ ] second task',
    '## Dependency Groups',
    'Group 1: [first-task, second-task]',
    '## Per-Task Dispatch Payloads',
    '### first-task',
    'Implement first thing per planner spec.',
    '### second-task',
    'Implement second thing per planner spec.',
    '</z-handoff>',
  ].join('\n');
}

function planToWorkCaseAEscape(): string {
  return [
    '$z phase2 refactor-rename',
    '',
    '<z-handoff type="plan-to-work">',
    '## Issue',
    'none (Case A escape, tier=tiny)',
    '## Parent Epic',
    'none',
    '## Tier',
    'tiny',
    '## Escape Eligible',
    'true',
    '## Issue Required By User',
    'false',
    '## Task List',
    '- [ ] inline rename',
    '## Dependency Groups',
    'Group 1: [inline-rename]',
    '## Per-Task Dispatch Payloads',
    '### inline-rename',
    'Rename foo -> bar across src/.',
    '</z-handoff>',
  ].join('\n');
}

function planToWorkFullTyped(): string {
  return [
    '$z phase2 https://github.com/owner/repo/issues/99',
    '',
    '<z-handoff type="plan-to-work">',
    '## Issue',
    'https://github.com/owner/repo/issues/99',
    '## Parent Epic',
    'https://github.com/owner/repo/issues/90',
    '## Tier',
    'medium',
    '## Escape Eligible',
    'false',
    '## Issue Required By User',
    'true',
    '## Task List',
    '- [ ] step a',
    '- [ ] step b',
    '## Dependency Groups',
    'Group 1: [step-a]',
    'Group 2: [step-b]',
    '## Per-Task Dispatch Payloads',
    '### step-a',
    'Step A subagent prompt.',
    '### step-b',
    'Step B subagent prompt.',
    '</z-handoff>',
  ].join('\n');
}

function workCompleteMinimal(): string {
  return [
    '$z epic-update https://github.com/owner/repo/issues/10',
    '',
    '<z-handoff type="work-complete">',
    '## Completed Subissue',
    'https://github.com/owner/repo/issues/42',
    '## PR',
    'https://github.com/owner/repo/pull/77',
    '## Summary',
    'Added host-side handoff parser and deterministic workflow entry.',
    '## Remaining Epic Checklist',
    '- [x] #42 parser + metadata',
    '- [ ] #43 next subissue',
    '</z-handoff>',
  ].join('\n');
}

// -------------------------------------------------------------------
// parseHandoff — happy paths
// -------------------------------------------------------------------

describe('parseHandoff — happy paths', () => {
  it('parses plan-to-work minimal with conservative defaults for optional typed fields', () => {
    const result = parseHandoff(planToWorkMinimal());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.context.handoffKind).toBe('plan-to-work');
    expect(result.context.sourceIssueUrl).toBe('https://github.com/owner/repo/issues/42');
    expect(result.context.parentEpicUrl).toBe('https://github.com/owner/repo/issues/10');
    expect(result.context.tier).toBeNull();
    expect(result.context.escapeEligible).toBe(false);
    expect(result.context.issueRequiredByUser).toBe(true);
    expect(result.context.hopBudget).toBe(1);
    expect(typeof result.context.chainId).toBe('string');
    expect(result.context.chainId.length).toBeGreaterThan(0);
    // Required structured fields are now persisted.
    expect(result.context.dependencyGroups).toEqual([['first-task', 'second-task']]);
    expect(result.context.perTaskDispatchPayloads).toEqual([
      { taskId: 'first-task', prompt: 'Implement first thing per planner spec.' },
      { taskId: 'second-task', prompt: 'Implement second thing per planner spec.' },
    ]);
  });

  it('parses plan-to-work Case A escape with typed fields', () => {
    const result = parseHandoff(planToWorkCaseAEscape());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.context.sourceIssueUrl).toBeNull();
    expect(result.context.parentEpicUrl).toBeNull();
    expect(result.context.tier).toBe('tiny');
    expect(result.context.escapeEligible).toBe(true);
    expect(result.context.issueRequiredByUser).toBe(false);
    expect(result.context.dependencyGroups).toEqual([['inline-rename']]);
    expect(result.context.perTaskDispatchPayloads).toEqual([
      { taskId: 'inline-rename', prompt: 'Rename foo -> bar across src/.' },
    ]);
  });

  it('parses plan-to-work Case B with tier=medium and multiple dependency groups', () => {
    const result = parseHandoff(planToWorkFullTyped());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.context.tier).toBe('medium');
    expect(result.context.sourceIssueUrl).toBe('https://github.com/owner/repo/issues/99');
    // Across-group sequencing is preserved by parse order.
    expect(result.context.dependencyGroups).toEqual([['step-a'], ['step-b']]);
    expect(result.context.perTaskDispatchPayloads.map((p) => p.taskId)).toEqual([
      'step-a',
      'step-b',
    ]);
  });

  it('parses work-complete minimal — plan-only fields are empty', () => {
    const result = parseHandoff(workCompleteMinimal());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.context.handoffKind).toBe('work-complete');
    expect(result.context.sourceIssueUrl).toBe('https://github.com/owner/repo/issues/42');
    expect(result.context.parentEpicUrl).toBeNull();
    expect(result.context.escapeEligible).toBe(false);
    expect(result.context.issueRequiredByUser).toBe(true);
    expect(result.context.hopBudget).toBe(1);
    expect(result.context.dependencyGroups).toEqual([]);
    expect(result.context.perTaskDispatchPayloads).toEqual([]);
  });

  it('accepts prompt with no $z prefix — sentinel directly at top', () => {
    const result = parseHandoff(
      [
        '<z-handoff type="work-complete">',
        '## Completed Subissue',
        'https://github.com/owner/repo/issues/1',
        '## PR',
        'https://github.com/owner/repo/pull/2',
        '## Summary',
        'Done.',
        '## Remaining Epic Checklist',
        '- [x] #1',
        '</z-handoff>',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
  });
});

// -------------------------------------------------------------------
// parseHandoff — malformed inputs
// -------------------------------------------------------------------

describe('parseHandoff — malformed inputs', () => {
  it('reports no-sentinel when <z-handoff> is absent', () => {
    const result = parseHandoff('just a regular user message');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('no-sentinel');
  });

  it('reports missing-closing when opening tag has no matching close', () => {
    const result = parseHandoff(
      [
        '<z-handoff type="plan-to-work">',
        '## Issue',
        'https://example.com/1',
        '## Parent Epic',
        'none',
        '## Task List',
        '- [ ] work',
      ].join('\n'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('missing-closing');
  });

  it('reports duplicate-sentinel for two plan-to-work sentinels', () => {
    const body = planToWorkMinimal();
    const doubled = `${body}\n${body}`;
    const result = parseHandoff(doubled);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('duplicate-sentinel');
  });

  it('reports duplicate-sentinel for plan-to-work followed by work-complete', () => {
    const doubled = `${planToWorkMinimal()}\n${workCompleteMinimal()}`;
    const result = parseHandoff(doubled);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('duplicate-sentinel');
  });

  it('reports duplicate-sentinel when a second <z-handoff> opens inside the body before closing', () => {
    // Inner opening BEFORE the first closing tag — without this check the
    // parser would stop at the inner closing and mis-parse (grammar rule 5).
    const text = [
      '<z-handoff type="plan-to-work">',
      '## Issue',
      'https://example.com/issue/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] outer',
      '<z-handoff type="work-complete">',
      '## Completed Subissue',
      'https://example.com/issue/2',
      '## PR',
      'https://example.com/pr/1',
      '## Summary',
      'inner',
      '## Remaining Epic Checklist',
      '- [x] inner',
      '</z-handoff>',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('duplicate-sentinel');
  });

  it('reports unknown-type for an unrecognized type attribute', () => {
    const text = [
      '<z-handoff type="foo-bar">',
      '## Issue',
      'https://example.com/1',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unknown-type');
    expect(result.detail).toBe('foo-bar');
  });

  it('reports missing-required-field when plan-to-work has no ## Issue', () => {
    const text = [
      '<z-handoff type="plan-to-work">',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] foo',
      '## Dependency Groups',
      'Group 1: [foo]',
      '## Per-Task Dispatch Payloads',
      '### foo',
      'do foo',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('missing-required-field');
    expect(result.detail).toBe('Issue');
  });

  it('reports missing-required-field when plan-to-work has no ## Dependency Groups', () => {
    // Phase-2 controller cannot dispatch without the planner's dependency
    // groups in the handoff payload (z/SKILL.md §Hard Rules forbids reading
    // PLAN.md from the working folder).
    const text = [
      '<z-handoff type="plan-to-work">',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] foo',
      '## Per-Task Dispatch Payloads',
      '### foo',
      'do foo',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('missing-required-field');
    expect(result.detail).toBe('Dependency Groups');
  });

  it('reports missing-required-field when plan-to-work has no ## Per-Task Dispatch Payloads', () => {
    const text = [
      '<z-handoff type="plan-to-work">',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] foo',
      '## Dependency Groups',
      'Group 1: [foo]',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('missing-required-field');
    expect(result.detail).toBe('Per-Task Dispatch Payloads');
  });

  it('reports sentinel-not-top-level when other content precedes the sentinel', () => {
    const text = [
      'Here is a sample handoff for documentation purposes:',
      '',
      '<z-handoff type="plan-to-work">',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] work',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('sentinel-not-top-level');
  });

  it('reports malformed-opening for missing quotes in type attribute', () => {
    const text = [
      '<z-handoff type=plan-to-work>',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] work',
      '## Dependency Groups',
      'Group 1: [work]',
      '## Per-Task Dispatch Payloads',
      '### work',
      'do work',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('malformed-opening');
  });

  it('reports malformed-opening for double-space variant in opening tag', () => {
    // Grammar rule 1: "변형(대소문자·홑따옴표·공백 변형) 불매칭". Strict regex
    // is the contract — multi-space between `<z-handoff` and `type=` is a
    // whitespace variant.
    const text = [
      '<z-handoff  type="plan-to-work">',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] work',
      '## Dependency Groups',
      'Group 1: [work]',
      '## Per-Task Dispatch Payloads',
      '### work',
      'do work',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('malformed-opening');
  });

  it('reports malformed-opening for trailing whitespace in opening tag', () => {
    const text = [
      '<z-handoff type="plan-to-work"> ',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] work',
      '## Dependency Groups',
      'Group 1: [work]',
      '## Per-Task Dispatch Payloads',
      '### work',
      'do work',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('malformed-opening');
  });
});

// -------------------------------------------------------------------
// Parser edge cases — multi-line values, chainId uniqueness, defaults
// -------------------------------------------------------------------

describe('parseHandoff — edge cases', () => {
  it('captures multi-line value under ## Task List heading', () => {
    const text = [
      '<z-handoff type="plan-to-work">',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] step 1',
      '- [ ] step 2',
      '  - sub step',
      '- [ ] step 3',
      '## Dependency Groups',
      'Group 1: [s1, s2, s3]',
      '## Per-Task Dispatch Payloads',
      '### s1',
      'step 1 prompt',
      '### s2',
      'step 2 prompt',
      '### s3',
      'step 3 prompt',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
  });

  it('mints a different chainId on each parse', () => {
    const a = parseHandoff(planToWorkMinimal());
    const b = parseHandoff(planToWorkMinimal());
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.context.chainId).not.toBe(b.context.chainId);
  });

  it('hopBudget is initialized to 1 on successful parse (foundation for #697)', () => {
    const result = parseHandoff(planToWorkMinimal());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.context.hopBudget).toBe(1);
  });

  it('falls back to tier=null when ## Tier value is not in HandoffTier set', () => {
    const text = [
      '<z-handoff type="plan-to-work">',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Tier',
      'gigantic',
      '## Task List',
      '- [ ] work',
      '## Dependency Groups',
      'Group 1: [work]',
      '## Per-Task Dispatch Payloads',
      '### work',
      'work prompt',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.context.tier).toBeNull();
  });

  it('parses comma- or whitespace-separated taskIds inside group brackets', () => {
    const text = [
      '<z-handoff type="plan-to-work">',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] a',
      '- [ ] b',
      '- [ ] c',
      '## Dependency Groups',
      'Group 1: [a, b]',
      'Group 2: [c]',
      '## Per-Task Dispatch Payloads',
      '### a',
      'do a',
      '### b',
      'do b',
      '### c',
      'do c',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.context.dependencyGroups).toEqual([['a', 'b'], ['c']]);
  });

  it('preserves multi-line dispatch payload bodies verbatim', () => {
    const text = [
      '<z-handoff type="plan-to-work">',
      '## Issue',
      'https://example.com/1',
      '## Parent Epic',
      'none',
      '## Task List',
      '- [ ] alpha',
      '## Dependency Groups',
      'Group 1: [alpha]',
      '## Per-Task Dispatch Payloads',
      '### alpha',
      'Line one of alpha prompt.',
      '',
      'Line two with more detail:',
      '- bullet 1',
      '- bullet 2',
      '</z-handoff>',
    ].join('\n');
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.context.perTaskDispatchPayloads).toEqual([
      {
        taskId: 'alpha',
        prompt: [
          'Line one of alpha prompt.',
          '',
          'Line two with more detail:',
          '- bullet 1',
          '- bullet 2',
        ].join('\n'),
      },
    ]);
  });
});

// -------------------------------------------------------------------
// hasHandoffSentinel / extractSentinelType
// -------------------------------------------------------------------

describe('hasHandoffSentinel', () => {
  it('returns true for a well-formed top-level sentinel', () => {
    expect(hasHandoffSentinel(planToWorkMinimal())).toBe(true);
    expect(hasHandoffSentinel(workCompleteMinimal())).toBe(true);
  });

  it('returns false for a prompt with no sentinel', () => {
    expect(hasHandoffSentinel('hey there')).toBe(false);
  });

  it('returns false for a sentinel that is not top-level', () => {
    const text = `some preamble\n\n${planToWorkMinimal()}`;
    expect(hasHandoffSentinel(text)).toBe(false);
  });
});

describe('extractSentinelType', () => {
  it('extracts plan-to-work from a valid top-level sentinel', () => {
    expect(extractSentinelType(planToWorkMinimal())).toBe('plan-to-work');
  });

  it('extracts work-complete from a valid top-level sentinel', () => {
    expect(extractSentinelType(workCompleteMinimal())).toBe('work-complete');
  });

  it('returns null for unknown type string', () => {
    const text = '<z-handoff type="foo">\n## Issue\nx\n</z-handoff>';
    expect(extractSentinelType(text)).toBeNull();
  });

  it('returns null for no sentinel', () => {
    expect(extractSentinelType('plain text')).toBeNull();
  });
});

// -------------------------------------------------------------------
// expectedHandoffKind mapping
// -------------------------------------------------------------------

describe('expectedHandoffKind', () => {
  it('maps z-plan-to-work to plan-to-work', () => {
    expect(expectedHandoffKind('z-plan-to-work')).toBe('plan-to-work');
  });

  it('maps z-epic-update to work-complete', () => {
    expect(expectedHandoffKind('z-epic-update')).toBe('work-complete');
  });
});

// -------------------------------------------------------------------
// HandoffAbortError
// -------------------------------------------------------------------

describe('HandoffAbortError', () => {
  it('carries reason, detail, and forceWorkflow', () => {
    const err = new HandoffAbortError('missing-closing', 'no </z-handoff>', 'z-plan-to-work');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HandoffAbortError');
    expect(err.reason).toBe('missing-closing');
    expect(err.detail).toBe('no </z-handoff>');
    expect(err.forceWorkflow).toBe('z-plan-to-work');
    expect(err.message).toContain('z-plan-to-work');
  });
});

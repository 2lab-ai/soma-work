import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillForceHandler } from '../skill-force-handler';

vi.mock('node:fs');

vi.mock('../../../env-paths', () => ({
  PLUGINS_DIR: '/mock/plugins',
  DATA_DIR: '/mock/data',
}));

vi.mock('../../../path-utils', () => ({
  isSafePathSegment: (s: string) => !!s && !s.includes('/') && !s.includes('..'),
}));

// These tests exercise cross-user RESOLUTION mechanics, not the permission gate
// — assume the owner has granted access. The deny path is covered in
// skill-force-handler-permission.test.ts.
vi.mock('../../../user-skill-grants-store', () => ({
  isSkillUseAllowed: () => true,
  hasOneTimeGrant: () => false,
  consumeOneTimeGrant: () => false,
}));

/**
 * RED tests for cross-user forced skill invocation (S3) + owner-scoped nested
 * resolution (S7) + copied-skill owner context (S8 at invocation time).
 *
 * `${user}:{skill}` (display name or uid) and `$<@UID>:{skill}` (mention markup)
 * force another user's skill. Owner-relative refs inside resolve to the OWNER,
 * not the requester. A copied skill resolves its owner-relative refs to the
 * ORIGINAL owner via the `copied_from` frontmatter field.
 */
describe('SkillForceHandler — cross-user', () => {
  const mockSay = vi.fn().mockResolvedValue({ ts: '1' });

  // Display-name → uid resolver stub (offline; injected).
  const resolveUser = (token: string): string | null => ({ Zhuge: 'U094', Bob: 'U0BOB' })[token] ?? null;
  const handler = new SkillForceHandler(resolveUser);

  const makeCtx = (text: string, user = 'U1') => ({
    user,
    channel: 'C1',
    threadTs: '171.100',
    text,
    say: mockSay,
  });

  /** Install a virtual filesystem keyed by absolute path. */
  function mountFs(files: Record<string, string>) {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p) in files);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const c = files[String(p)];
      if (c === undefined) throw new Error(`ENOENT ${String(p)}`);
      return c as any;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('canHandle: matches "$Zhuge:deploy" (display-name cross-user force)', () => {
    mountFs({ '/mock/data/U094/skills/deploy/SKILL.md': '# Deploy' });
    expect(handler.canHandle('$Zhuge:deploy', 'U1')).toBe(true);
  });

  it('canHandle: matches "$<@U094E5L4A15>:deploy" (mention cross-user force)', () => {
    expect(handler.canHandle('$<@U094E5L4A15>:deploy', 'U1')).toBe(true);
  });

  it('resolves another user’s skill by display name into <invoked_skills>', async () => {
    const deploy = '# Zhuge Deploy\nShip it.';
    mountFs({ '/mock/data/U094/skills/deploy/SKILL.md': deploy });

    const result = await handler.execute(makeCtx('$Zhuge:deploy'));

    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('<invoked_skills>');
    expect(result.continueWithPrompt).toContain(deploy);
  });

  it('resolves another user’s skill by mention markup', async () => {
    const deploy = '# Mention Deploy';
    mountFs({ '/mock/data/U094E5L4A15/skills/deploy/SKILL.md': deploy });

    const result = await handler.execute(makeCtx('$<@U094E5L4A15>:deploy'));

    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain(deploy);
  });

  it('S7: nested owner-relative ref inside a borrowed skill resolves to the OWNER', async () => {
    // Zhuge's qa-dev references `$user:dev` — must inline ZHUGE's dev, not the
    // requester U1's dev (which also exists but must be ignored).
    mountFs({
      '/mock/data/U094/skills/qa-dev/SKILL.md': '# QA Dev\nThen run $user:dev',
      '/mock/data/U094/skills/dev/SKILL.md': '# ZHUGE DEV SKILL',
      '/mock/data/U1/skills/dev/SKILL.md': '# REQUESTER DEV SKILL (must NOT appear)',
    });

    const result = await handler.execute(makeCtx('$Zhuge:qa-dev'));

    expect(result.continueWithPrompt).toContain('# ZHUGE DEV SKILL');
    expect(result.continueWithPrompt).not.toContain('REQUESTER DEV SKILL');
  });

  it('S7: two borrowed skills nesting `$user:dev` keep each owner’s dev (no key collision)', async () => {
    // Both Zhuge and Bob have a qa-dev that nests `$user:dev`. The two devs
    // differ — both must appear (owner-aware dedupe), not collapse to one.
    mountFs({
      '/mock/data/U094/skills/qa-dev/SKILL.md': '# Zhuge qa\n$user:dev',
      '/mock/data/U094/skills/dev/SKILL.md': '# ZHUGE DEV',
      '/mock/data/U0BOB/skills/qa-dev/SKILL.md': '# Bob qa\n$user:dev',
      '/mock/data/U0BOB/skills/dev/SKILL.md': '# BOB DEV',
    });

    const result = await handler.execute(makeCtx('$Zhuge:qa-dev 하고 $Bob:qa-dev'));

    expect(result.continueWithPrompt).toContain('# ZHUGE DEV');
    expect(result.continueWithPrompt).toContain('# BOB DEV');
  });

  it('S8: a copied skill resolves owner-relative refs to the ORIGINAL owner', async () => {
    // U1 owns a COPY of Zhuge's qa-dev (copied_from=U094). Its body references
    // `$user:dev`, which must resolve to U094's dev (origin), not U1's dev.
    const copied = ['---', 'name: qa-dev', 'copied_from: "U094:qa-dev"', '---', 'Then run $user:dev'].join('\n');
    mountFs({
      '/mock/data/U1/skills/qa-dev/SKILL.md': copied,
      '/mock/data/U094/skills/dev/SKILL.md': '# ORIGIN DEV SKILL',
      '/mock/data/U1/skills/dev/SKILL.md': '# LOCAL DEV (must NOT appear)',
    });

    const result = await handler.execute(makeCtx('$user:qa-dev', 'U1'));

    expect(result.continueWithPrompt).toContain('# ORIGIN DEV SKILL');
    expect(result.continueWithPrompt).not.toContain('LOCAL DEV');
  });

  it('errors when the cross-user target cannot be resolved', async () => {
    mountFs({});
    const result = await handler.execute(makeCtx('$nobody:deploy'));
    // Either not handled (no refs) or handled with an error message — never a
    // successful injection of a non-existent skill.
    expect(result.continueWithPrompt ?? '').not.toContain('<invoked_skills>');
  });

  // --- S2: soft (no-$) natural-language cross-user use ---------------------

  it('S2: soft "Zhuge:deploy" (no $) resolves when user + skill both exist', async () => {
    const deploy = '# Soft Deploy';
    mountFs({ '/mock/data/U094/skills/deploy/SKILL.md': deploy });

    expect(handler.canHandle('Zhuge:deploy 해줘', 'U1')).toBe(true);
    const result = await handler.execute(makeCtx('Zhuge:deploy 해줘'));
    expect(result.continueWithPrompt).toContain(deploy);
  });

  it('S2: soft mention "<@UID>:deploy" (no $) resolves', async () => {
    const deploy = '# Soft Mention Deploy';
    mountFs({ '/mock/data/U094E5L4A15/skills/deploy/SKILL.md': deploy });

    const result = await handler.execute(makeCtx('<@U094E5L4A15>:deploy 부탁'));
    expect(result.continueWithPrompt).toContain(deploy);
  });

  it('S2: does NOT fire on a normal colon token like "TODO:fix"', () => {
    mountFs({ '/mock/data/U094/skills/deploy/SKILL.md': '#' });
    // "TODO" does not resolve to a user; the kebab skill "fix" doesn't exist.
    expect(handler.canHandle('TODO:fix the bug', 'U1')).toBe(false);
  });

  it('S2: does NOT fire when the user resolves but the skill is missing', () => {
    mountFs({}); // Zhuge resolves but has no "deploy" skill on disk
    expect(handler.canHandle('Zhuge:deploy', 'U1')).toBe(false);
  });

  it('S2: does NOT treat colons inside a skill body as cross-user refs', async () => {
    // The borrowed skill body contains `description: foo` — must NOT be parsed
    // as a soft cross-user ref (top-level detection only).
    mountFs({
      '/mock/data/U094/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: ship\n---\nstep: do it',
    });
    const result = await handler.execute(makeCtx('$Zhuge:deploy'));
    // Only the deploy skill is injected — no spurious "description:"/"step:" refs.
    expect(result.continueWithPrompt).toContain('step: do it');
  });
});

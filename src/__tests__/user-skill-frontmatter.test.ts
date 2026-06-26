import { describe, expect, it } from 'vitest';
import { extractCopiedFrom, withCopiedFrom } from '../user-skill-frontmatter';

/**
 * RED tests for the owner-attribution frontmatter helpers (S8).
 *
 * When a skill is copied from another user, the copy embeds the ORIGINAL
 * owner's uid via a `copied_from` frontmatter field. At invocation time the
 * resolver reads this field so that owner-relative refs inside the copied
 * skill (`$user:dev`, bare `$dev`) keep resolving to the original owner — NOT
 * to the new owner who would otherwise shadow them. No body rewrite.
 */
describe('extractCopiedFrom', () => {
  it('parses uid:skill from frontmatter', () => {
    const md = ['---', 'name: qa-dev', 'description: "x"', 'copied_from: "U094E5L4A15:qa-dev"', '---', '# body'].join(
      '\n',
    );
    expect(extractCopiedFrom(md)).toEqual({ ownerUserId: 'U094E5L4A15', skillName: 'qa-dev' });
  });

  it('parses a bare uid with no skill suffix', () => {
    const md = ['---', 'name: qa-dev', 'copied_from: U094E5L4A15', '---', 'body'].join('\n');
    expect(extractCopiedFrom(md)).toEqual({ ownerUserId: 'U094E5L4A15', skillName: null });
  });

  it('returns null when there is no copied_from field', () => {
    const md = ['---', 'name: qa-dev', 'description: "x"', '---', 'body'].join('\n');
    expect(extractCopiedFrom(md)).toBeNull();
  });

  it('ignores a copied_from-looking line in the BODY (only frontmatter counts)', () => {
    const md = ['---', 'name: qa-dev', '---', 'copied_from: U0HACKER001:evil'].join('\n');
    expect(extractCopiedFrom(md)).toBeNull();
  });
});

describe('withCopiedFrom', () => {
  it('inserts copied_from into existing frontmatter', () => {
    const md = ['---', 'name: qa-dev', 'description: "x"', '---', '# body'].join('\n');
    const out = withCopiedFrom(md, 'U094E5L4A15', 'qa-dev');
    expect(extractCopiedFrom(out)).toEqual({ ownerUserId: 'U094E5L4A15', skillName: 'qa-dev' });
    // Body preserved verbatim.
    expect(out).toContain('# body');
    expect(out).toContain('name: qa-dev');
  });

  it('replaces an existing copied_from (idempotent re-copy keeps origin)', () => {
    const md = ['---', 'name: qa-dev', 'copied_from: "U0OLD000001:qa-dev"', '---', 'body'].join('\n');
    const out = withCopiedFrom(md, 'U094E5L4A15', 'qa-dev');
    expect(extractCopiedFrom(out)).toEqual({ ownerUserId: 'U094E5L4A15', skillName: 'qa-dev' });
    // Only one copied_from line survives.
    expect(out.match(/copied_from:/g)?.length).toBe(1);
  });

  it('prepends a frontmatter block when the source has none', () => {
    const md = '# just a body, no frontmatter';
    const out = withCopiedFrom(md, 'U094E5L4A15', 'qa-dev');
    expect(extractCopiedFrom(out)).toEqual({ ownerUserId: 'U094E5L4A15', skillName: 'qa-dev' });
    expect(out).toContain('# just a body, no frontmatter');
  });
});

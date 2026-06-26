/**
 * Owner-attribution frontmatter helpers for cross-user skill copy (S8).
 *
 * Pure string utilities — NO filesystem / env imports — so both the persistence
 * layer (`user-skill-store.ts`) and the synchronous message preprocessor
 * (`slack/commands/skill-force-handler.ts`) can share them without pulling the
 * full store dependency chain into the handler's unit tests.
 *
 * Design (per the codex design review): a copied skill is NOT body-rewritten.
 * Instead the copy records the original owner's uid in a `copied_from`
 * frontmatter field, and the skill resolver derives the owner context from that
 * field at invocation time. This avoids mutating authored prose / code fences /
 * examples while still making owner-relative refs (`$user:dev`, bare `$dev`)
 * resolve against the original owner for the new owner who installed the copy.
 */

/** Matches the leading YAML frontmatter block: `---\n …\n---`. */
const FRONTMATTER_RE = /^(---\s*\n[\s\S]*?\n---)/;

/**
 * `copied_from` value: `<uid>` or `<uid>:<skill>`, optionally quoted.
 * Restricted to the frontmatter block by the caller so a body line cannot
 * forge an owner (a privilege-escalation vector — see the body-ignore test).
 */
const COPIED_FROM_LINE_RE = /^[ \t]*copied_from:[ \t]*["']?([\w-]+)(?::([\w-]+))?["']?[ \t]*$/m;

export interface CopiedFromMeta {
  ownerUserId: string;
  skillName: string | null;
}

/**
 * Extract the original-owner attribution from a SKILL.md's frontmatter, or
 * `null` when absent. Only the leading frontmatter block is consulted — a
 * `copied_from:` line in the body is ignored.
 */
export function extractCopiedFrom(content: string): CopiedFromMeta | null {
  if (typeof content !== 'string') return null;
  const fm = content.match(FRONTMATTER_RE);
  if (!fm) return null;
  const m = fm[1].match(COPIED_FROM_LINE_RE);
  if (!m) return null;
  return { ownerUserId: m[1], skillName: m[2] ?? null };
}

/**
 * Return `content` with a `copied_from` frontmatter field set to
 * `<ownerUserId>:<skillName>`. Body bytes are preserved verbatim.
 *
 * - Existing frontmatter with no `copied_from` → the field is inserted before
 *   the closing `---`.
 * - Existing `copied_from` → it is replaced (idempotent; a re-copy keeps the
 *   true origin owner because the caller passes the already-resolved origin).
 * - No frontmatter at all → a minimal block is prepended.
 */
export function withCopiedFrom(content: string, ownerUserId: string, skillName: string): string {
  const line = `copied_from: "${ownerUserId}:${skillName}"`;
  const src = typeof content === 'string' ? content : '';
  const fm = src.match(FRONTMATTER_RE);

  if (!fm) {
    // No frontmatter — prepend a minimal block.
    return `---\n${line}\n---\n${src}`;
  }

  const block = fm[1];
  let newBlock: string;
  if (COPIED_FROM_LINE_RE.test(block)) {
    // Replace the existing field in place.
    newBlock = block.replace(COPIED_FROM_LINE_RE, line);
  } else {
    // Insert before the closing `---` (the last line of the block).
    const closingIdx = block.lastIndexOf('\n---');
    newBlock = `${block.slice(0, closingIdx)}\n${line}${block.slice(closingIdx)}`;
  }
  return newBlock + src.slice(block.length);
}

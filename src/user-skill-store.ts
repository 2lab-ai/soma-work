/**
 * User Personal Skill Store
 *
 * Mirrors user-memory-store.ts pattern for per-user skill management.
 * Skills are stored at DATA_DIR/{userId}/skills/{name}/SKILL.md
 * Format: YAML frontmatter + markdown body (same as src/local/skills/).
 *
 * Inspired by hermes-agent skill_manager_tool.py — but multi-tenant (per-user isolation).
 *
 * Persistence policy (issue #750):
 *   - Validation uses `content.trim()` for empty / size checks.
 *   - Persistence uses the original `content` byte-for-byte (verbatim).
 *     This lets the inline-edit modal (`$user` overflow → 편집) round-trip
 *     a SKILL.md without silently rewriting the user's whitespace.
 *   - The skill-count cap is enforced on `createUserSkill` only. `updateUserSkill`
 *     never adds a new directory, so it cannot push the user past the cap.
 *   - The skill-name length cap is enforced on `createUserSkill` only — older
 *     skills with longer names (created before the cap) must remain editable.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  invalidSkillNameMessage,
  MAX_SKILL_NAME_LENGTH as MAX_SKILL_NAME_LENGTH_SHARED,
  type SkillRenameErrorCode,
  skillNotFoundMessage,
  skillRenameIoFailureMessage,
  skillRenameSameNameMessage,
  skillRenameSourceMissingMessage,
  skillRenameSuccessMessage,
  skillRenameTargetExistsMessage,
} from 'somalib/model-commands/skill-share-errors';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import { isSafePathSegment } from './path-utils';
import { createPromptInvalidator } from './prompt-cache-invalidation';

const logger = new Logger('UserSkillStore');

/**
 * Invalidation hook for cached `session.systemPrompt` snapshots.
 *
 * Personal skills are injected into every system prompt via `prompt-builder.ts`,
 * so any mutation (create/update/delete/rename) must drop cached snapshots for
 * the affected user. Wired at startup in `src/index.ts` to
 * `SessionRegistry.invalidateSystemPromptForUser`.
 *
 * Mutators (4 functions) call `fireInvalidate(userId)` only on the happy path —
 * a failed write doesn't change disk state and shouldn't waste a rebuild.
 *
 * Mirrors the user-memory-store / user-settings-store pattern.
 */
const invalidator = createPromptInvalidator(logger, 'Skill');
export const setSkillPromptInvalidationHook = invalidator.setHook;
const fireInvalidate = invalidator.fire;

/** Max SKILL.md file size in bytes (post-trim length used for the check). */
export const MAX_SKILL_SIZE = 10 * 1024; // 10KB
/** Max skills per user (enforced on create only). */
const MAX_SKILLS_PER_USER = 50;
/**
 * Max skill-name length in characters (enforced on create / rename only).
 *
 * Slack `overflow` option `text.text` is capped at 75 chars; an `action_id`
 * is capped at 255. Our action_id format is `user_skill_menu_<name>` (16-byte
 * prefix), so 64 keeps the longest action_id under 80 chars with comfortable
 * headroom for future prefix changes. Older skills with longer names predate
 * this cap and must stay editable, so update/delete do not enforce it.
 *
 * Re-exported from `skill-share-errors.ts` so this and the standalone MCP
 * store import the SAME constant — the previous "kept in lockstep" comment
 * was enforced only by code-review.
 */
export const MAX_SKILL_NAME_LENGTH = MAX_SKILL_NAME_LENGTH_SHARED;
/** Kebab-case skill name pattern. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Max characters of SKILL.md that the inline-edit modal can safely round-trip.
 *
 * Slack `plain_text_input.max_length` caps at 3000 chars; we use the same
 * value here so callers can fail-closed *before* opening a modal whose
 * `initial_value` would be silently truncated by the Slack client.
 *
 * Skills larger than this are not blocked from existing — they can still be
 * invoked, listed, and edited via `MANAGE_SKILL update`. The only thing
 * gated by this cap is the inline-edit ✏️ entry point.
 */
export const MAX_INLINE_EDIT_CHARS = 3000;

/**
 * List-time projection of a skill — what the `$user` renderer needs.
 *
 * `isSingleFile` is computed in the same `readdirSync` pass that already
 * opens the dir to read the description, so the renderer does not need a
 * follow-up `isSingleFileSkill` call per skill (issue #750). Detail-level
 * fetches (`getUserSkill`) deliberately omit it — the edit click path
 * re-checks `isSingleFileSkill` separately as a stale guard, and bundling
 * both reads here would couple unrelated concerns.
 */
export interface UserSkillMeta {
  name: string;
  description: string;
  isSingleFile: boolean;
}

export interface UserSkillDetail {
  name: string;
  description: string;
  content: string;
}

interface SkillOperationResult {
  ok: boolean;
  message: string;
}

function getUserSkillsDir(userId: string): string {
  if (!isSafePathSegment(userId)) {
    throw new Error(`Invalid userId for skill storage: ${userId}`);
  }
  return path.join(DATA_DIR, userId, 'skills');
}

function getSkillPath(userId: string, skillName: string): string {
  return path.join(getUserSkillsDir(userId), skillName, 'SKILL.md');
}

/**
 * Strict skill-name validator: kebab-case pattern AND path-segment safety.
 *
 * Exported so Slack action handlers can guard payload-supplied names with
 * the SAME predicate the store uses — replacing inline `SKILL_NAME_PATTERN`
 * checks that would skip `isSafePathSegment` and thus weaken the defense
 * against `..` / null-byte / separator injection.
 */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && isSafePathSegment(name);
}

/**
 * Extract description from YAML frontmatter.
 * Expects: ---\nname: ...\ndescription: "..."\n---
 *
 * Broken / missing frontmatter is allowed by design — the inline editor must
 * round-trip whatever the user actually wrote. A skill with no `description:`
 * line simply renders with an empty description in the `$user` list.
 */
function extractDescription(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?description:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/);
  return match?.[1]?.trim() ?? '';
}

/**
 * Stable 32-hex content fingerprint (truncated SHA-256).
 *
 * Used by the inline-edit flow to detect concurrent modification: the menu
 * handler captures the hash at click time and embeds it in modal
 * `private_metadata`; the view-submission handler re-reads SKILL.md and
 * compares hashes before writing. Mismatch ⇒ stale, fail closed.
 *
 * 32 hex chars = 128 bits — collision risk is irrelevant at the scale of a
 * single user's edit window. Full SHA-256 would be wasted bytes in the
 * Slack-imposed 3000-byte `private_metadata` budget.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 32);
}

// --- Public API ---

export function listUserSkills(userId: string): UserSkillMeta[] {
  const skillsDir = getUserSkillsDir(userId);
  if (!fs.existsSync(skillsDir)) return [];

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const skills: UserSkillMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(skillsDir, entry.name);

      // One readdir per skill dir — gives us BOTH the SKILL.md presence check
      // AND the single-file determination in a single syscall, so the `$user`
      // renderer can skip a follow-up `isSingleFileSkill` call per skill.
      let skillEntries: fs.Dirent[];
      try {
        skillEntries = fs.readdirSync(skillDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const skillFileEntry = skillEntries.find((e) => e.isFile() && e.name === 'SKILL.md');
      if (!skillFileEntry) continue;

      const isSingleFile = skillEntries.length === 1;
      const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
      skills.push({
        name: entry.name,
        description: extractDescription(content),
        isSingleFile,
      });
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Cheap existence check used by Slack action handlers as a stale-skill guard.
 * Validates the skill name, then a single `existsSync` on `SKILL.md`.
 *
 * Replaces `listUserSkills(...).some(s => s.name === skillName)` at click-
 * time, which scanned every skill directory just to answer "does this one
 * exist." Up to ~50 redundant `readFileSync`s eliminated per click.
 */
export function userSkillExists(userId: string, skillName: string): boolean {
  if (!isValidSkillName(skillName)) return false;
  return fs.existsSync(getSkillPath(userId, skillName));
}

/**
 * True iff `DATA_DIR/{userId}/skills/{skillName}/` exists and contains
 * exactly one entry, the file `SKILL.md`. Anything else (extra files, sub-
 * directories, missing SKILL.md, invalid name, missing dir) returns false.
 *
 * Used by the `$user` renderer and the inline-edit handlers to decide whether
 * the skill is safely round-trippable through a single Slack modal input.
 * Multi-file skills (sibling resources, sub-dirs) are out of scope until the
 * zip-roundtrip path lands (issue #751).
 *
 * Re-checked at every transition (render → click → submit) so that a skill
 * which gained a sibling file between render and submit fails closed.
 */
export function isSingleFileSkill(userId: string, skillName: string): boolean {
  if (!isValidSkillName(skillName)) return false;

  let skillDir: string;
  try {
    skillDir = path.join(getUserSkillsDir(userId), skillName);
  } catch {
    return false;
  }
  if (!fs.existsSync(skillDir)) return false;

  try {
    const entries = fs.readdirSync(skillDir, { withFileTypes: true });
    if (entries.length !== 1) return false;
    const only = entries[0];
    return only.isFile() && only.name === 'SKILL.md';
  } catch {
    return false;
  }
}

export function getUserSkill(userId: string, skillName: string): UserSkillDetail | null {
  if (!isValidSkillName(skillName)) return null;

  const skillFile = getSkillPath(userId, skillName);
  if (!fs.existsSync(skillFile)) return null;

  const content = fs.readFileSync(skillFile, 'utf-8');
  return {
    name: skillName,
    description: extractDescription(content),
    content,
  };
}

export function createUserSkill(userId: string, skillName: string, content: string): SkillOperationResult {
  if (!isValidSkillName(skillName)) {
    return { ok: false, message: `Invalid skill name "${skillName}". Use kebab-case (e.g. my-deploy).` };
  }
  if (skillName.length > MAX_SKILL_NAME_LENGTH) {
    return {
      ok: false,
      message: `Skill name too long (${skillName.length} > ${MAX_SKILL_NAME_LENGTH} chars).`,
    };
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, message: 'Skill content is empty.' };
  }
  if (Buffer.byteLength(trimmed, 'utf-8') > MAX_SKILL_SIZE) {
    return { ok: false, message: `Skill exceeds max size (${MAX_SKILL_SIZE / 1024}KB).` };
  }

  // Check skill count limit (create-only enforce).
  const existing = listUserSkills(userId);
  if (existing.length >= MAX_SKILLS_PER_USER) {
    return { ok: false, message: `Maximum ${MAX_SKILLS_PER_USER} skills reached. Delete some first.` };
  }

  const skillFile = getSkillPath(userId, skillName);
  if (fs.existsSync(skillFile)) {
    return { ok: false, message: `Skill "${skillName}" already exists. Use update instead.` };
  }

  const skillDir = path.dirname(skillFile);
  fs.mkdirSync(skillDir, { recursive: true });
  // Verbatim persistence — see file header. Validation used the trimmed
  // length for size/empty checks, but we write the exact bytes the caller
  // gave us so the inline editor can round-trip without surprise.
  fs.writeFileSync(skillFile, content, 'utf-8');

  logger.info('User skill created', { userId, skillName });
  fireInvalidate(userId);
  return { ok: true, message: `Skill "${skillName}" created.` };
}

export function updateUserSkill(userId: string, skillName: string, content: string): SkillOperationResult {
  if (!isValidSkillName(skillName)) {
    return { ok: false, message: `Invalid skill name "${skillName}". Use kebab-case.` };
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, message: 'Skill content is empty.' };
  }
  if (Buffer.byteLength(trimmed, 'utf-8') > MAX_SKILL_SIZE) {
    return { ok: false, message: `Skill exceeds max size (${MAX_SKILL_SIZE / 1024}KB).` };
  }

  const skillFile = getSkillPath(userId, skillName);
  if (!fs.existsSync(skillFile)) {
    return { ok: false, message: `Skill "${skillName}" not found. Use create instead.` };
  }

  // Verbatim persistence — see file header.
  fs.writeFileSync(skillFile, content, 'utf-8');

  logger.info('User skill updated', { userId, skillName });
  fireInvalidate(userId);
  return { ok: true, message: `Skill "${skillName}" updated.` };
}

export function deleteUserSkill(userId: string, skillName: string): SkillOperationResult {
  if (!isValidSkillName(skillName)) {
    return { ok: false, message: `Invalid skill name "${skillName}".` };
  }

  const skillDir = path.join(getUserSkillsDir(userId), skillName);
  if (!fs.existsSync(skillDir)) {
    return { ok: false, message: `Skill "${skillName}" not found.` };
  }

  fs.rmSync(skillDir, { recursive: true, force: true });

  logger.info('User skill deleted', { userId, skillName });
  fireInvalidate(userId);
  return { ok: true, message: `Skill "${skillName}" deleted.` };
}

interface SkillRenameResult {
  ok: boolean;
  message: string;
  /** Granular discriminant — see `SkillRenameErrorCode`. */
  error?: SkillRenameErrorCode;
}

/**
 * Rename `skills/{oldName}/` → `skills/{newName}/` in place.
 *
 * Why a 2-step `fs.rename` through a uuid-suffixed temp directory:
 *   - On case-insensitive filesystems (Darwin APFS default, Windows NTFS
 *     without the case-sensitive flag), `fs.renameSync(src, dst)` where
 *     `src.toLowerCase() === dst.toLowerCase()` is a no-op — the inode is
 *     identical, the OS reports success, but the directory keeps its old
 *     casing. Staging through a temp name makes case-only renames real.
 *   - The temp path makes the operation atomic from the dir-listing
 *     perspective: a parallel `listUserSkills` can never observe both old
 *     and new names at the same time.
 *   - The uuid suffix is collision-resistant against parallel renames in
 *     the same `skills/` dir.
 *
 * Validation order:
 *   1. Both names match `isValidSkillName` (kebab + path-segment safety).
 *   2. `newName` length ≤ MAX_SKILL_NAME_LENGTH (the same cap createUserSkill
 *      enforces — rename is functionally a "create with old content").
 *   3. `oldName !== newName` (no-op rejected with INVALID so the caller
 *      doesn't fire an invalidation hook for nothing).
 *   4. Source exists.
 *   5. Target doesn't exist (skipped on case-only rename — the inode lookup
 *      would lie).
 *
 * Failure modes return a granular `error` discriminant so the Slack rename
 * modal can map storage errors onto inline `response_action: 'errors'`
 * strings without re-parsing prose:
 *   - INVALID    name violates predicate / length cap / same as old
 *   - NOT_FOUND  source dir missing
 *   - EEXIST     target dir already taken (true collision, not case-only)
 *   - IO         fs.rename threw despite the pre-checks (rare, post-race)
 *
 * Verbatim persistence: SKILL.md bytes are not touched. The frontmatter
 * `name:` field is left as-is — same policy as updateUserSkill (the user
 * owns the body content; the dirname is the SSOT for invocation).
 */
export function renameUserSkill(userId: string, oldName: string, newName: string): SkillRenameResult {
  if (!isValidSkillName(oldName)) {
    return { ok: false, message: invalidSkillNameMessage(oldName), error: 'INVALID' };
  }
  if (!isValidSkillName(newName)) {
    return { ok: false, message: invalidSkillNameMessage(newName), error: 'INVALID' };
  }
  if (newName.length > MAX_SKILL_NAME_LENGTH) {
    return {
      ok: false,
      message: `Skill name too long (${newName.length} > ${MAX_SKILL_NAME_LENGTH} chars).`,
      error: 'INVALID',
    };
  }
  if (oldName === newName) {
    return { ok: false, message: skillRenameSameNameMessage(oldName), error: 'INVALID' };
  }

  const skillsRoot = getUserSkillsDir(userId);
  const srcDir = path.join(skillsRoot, oldName);
  const dstDir = path.join(skillsRoot, newName);

  if (!fs.existsSync(srcDir)) {
    return { ok: false, message: skillRenameSourceMissingMessage(oldName), error: 'NOT_FOUND' };
  }

  // Case-only rename: existsSync(dstDir) returns true on case-insensitive FS
  // because the inode is the source. Skip the EEXIST guard in that case —
  // the temp staging step below is what makes the rename real.
  //
  // Currently unreachable under the kebab-case predicate (which rejects
  // uppercase outright), so `oldName.toLowerCase() === newName.toLowerCase()`
  // can only be true when oldName === newName, which we already short-circuit
  // above. Kept as defense-in-depth in case the predicate is ever relaxed
  // (e.g. to allow camelCase aliases). The temp-staging path below is what
  // makes a future case-only rename actually move bits, not just no-op.
  const isCaseOnlyRename = oldName.toLowerCase() === newName.toLowerCase();
  if (!isCaseOnlyRename && fs.existsSync(dstDir)) {
    return { ok: false, message: skillRenameTargetExistsMessage(newName), error: 'EEXIST' };
  }

  const tempDir = path.join(skillsRoot, `.rename-${randomUUID()}`);

  try {
    fs.renameSync(srcDir, tempDir);
  } catch {
    return { ok: false, message: skillRenameIoFailureMessage(oldName, newName), error: 'IO' };
  }

  try {
    fs.renameSync(tempDir, dstDir);
  } catch {
    // Roll back so the user's skill doesn't vanish silently.
    try {
      fs.renameSync(tempDir, srcDir);
    } catch {
      logger.warn('User skill rename: rollback failed — temp dir survives', {
        userId,
        oldName,
        newName,
        tempDir,
      });
    }
    return { ok: false, message: skillRenameIoFailureMessage(oldName, newName), error: 'IO' };
  }

  logger.info('User skill renamed', { userId, oldName, newName });
  fireInvalidate(userId);
  return { ok: true, message: skillRenameSuccessMessage(oldName, newName) };
}

interface SkillShareResult {
  ok: boolean;
  message: string;
  content?: string;
}

/**
 * Read raw SKILL.md for cross-user copy-paste install via MANAGE_SKILL share.
 *
 * The dispatcher (`somalib/model-commands/catalog.ts`) applies the
 * character-count cap and crafts the success/over-limit message. This layer
 * only answers: "is the name valid?" / "does it exist?" / "here is the
 * content". Error messages come from the shared `skill-share-errors` module
 * so the standalone MCP layer (`SkillFileStore.shareSkill`) can never drift.
 */
export function shareUserSkill(userId: string, skillName: string): SkillShareResult {
  // Disambiguate invalid-name vs not-found before delegating: getUserSkill
  // collapses both into `null`, but the dispatcher needs distinct messages
  // sourced from the shared skill-share-errors module.
  if (!isValidSkillName(skillName)) {
    return { ok: false, message: invalidSkillNameMessage(skillName) };
  }

  const detail = getUserSkill(userId, skillName);
  if (!detail) {
    return { ok: false, message: skillNotFoundMessage(skillName) };
  }

  logger.info('User skill shared', { userId, skillName, length: detail.content.length });
  return { ok: true, message: `Skill "${skillName}" read for share.`, content: detail.content };
}

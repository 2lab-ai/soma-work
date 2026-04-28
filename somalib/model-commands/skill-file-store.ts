/**
 * Standalone SkillStore implementation using file I/O.
 * No dependency on app-level modules (Logger, env-paths, etc.).
 * Used by MCP servers that run as separate processes.
 * Mirrors memory-file-store.ts pattern.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SkillStore } from './catalog';
import {
  invalidSkillNameMessage,
  type SkillRenameErrorCode,
  skillNotFoundMessage,
  skillRenameIoFailureMessage,
  skillRenameSameNameMessage,
  skillRenameSourceMissingMessage,
  skillRenameSuccessMessage,
  skillRenameTargetExistsMessage,
} from './skill-share-errors';

const MAX_SKILL_SIZE = 10 * 1024; // 10KB
const MAX_SKILLS_PER_USER = 50;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/**
 * Mirrors `MAX_SKILL_NAME_LENGTH` in `src/user-skill-store.ts` — kept in lock-
 * step so the rename action enforces the same length cap on both stores.
 */
const MAX_SKILL_NAME_LENGTH_RENAME = 64;

function isSafeSegment(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s);
}

function extractDescription(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?description:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/);
  return match?.[1]?.trim() ?? '';
}

export class SkillFileStore implements SkillStore {
  constructor(private readonly dataDir: string) {}

  private skillsDir(user: string): string {
    if (!isSafeSegment(user)) throw new Error(`Invalid userId: ${user}`);
    return path.join(this.dataDir, user, 'skills');
  }

  private skillPath(user: string, name: string): string {
    return path.join(this.skillsDir(user), name, 'SKILL.md');
  }

  listSkills(user: string): Array<{ name: string; description: string }> {
    const dir = this.skillsDir(user);
    if (!fs.existsSync(dir)) return [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const skills: Array<{ name: string; description: string }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fp = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(fp)) continue;
        skills.push({ name: entry.name, description: extractDescription(fs.readFileSync(fp, 'utf-8')) });
      }
      return skills.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  createSkill(user: string, name: string, content: string): { ok: boolean; message: string } {
    if (!SKILL_NAME_PATTERN.test(name) || !isSafeSegment(name)) {
      return { ok: false, message: `Invalid skill name "${name}". Use kebab-case.` };
    }
    const trimmed = content.trim();
    if (!trimmed) return { ok: false, message: 'Skill content is empty.' };
    if (Buffer.byteLength(trimmed, 'utf-8') > MAX_SKILL_SIZE) {
      return { ok: false, message: `Skill exceeds max size (${MAX_SKILL_SIZE / 1024}KB).` };
    }
    if (this.listSkills(user).length >= MAX_SKILLS_PER_USER) {
      return { ok: false, message: `Maximum ${MAX_SKILLS_PER_USER} skills reached.` };
    }
    const fp = this.skillPath(user, name);
    if (fs.existsSync(fp)) return { ok: false, message: `Skill "${name}" already exists. Use update.` };
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    // Verbatim persistence — validation used the trimmed length, but we
    // write the original bytes so the inline-edit modal (Slack-host counterpart
    // of this MCP store) can round-trip a SKILL.md without silent rewrites.
    fs.writeFileSync(fp, content, 'utf-8');
    return { ok: true, message: `Skill "${name}" created.` };
  }

  updateSkill(user: string, name: string, content: string): { ok: boolean; message: string } {
    if (!SKILL_NAME_PATTERN.test(name) || !isSafeSegment(name)) {
      return { ok: false, message: `Invalid skill name "${name}". Use kebab-case.` };
    }
    const trimmed = content.trim();
    if (!trimmed) return { ok: false, message: 'Skill content is empty.' };
    if (Buffer.byteLength(trimmed, 'utf-8') > MAX_SKILL_SIZE) {
      return { ok: false, message: `Skill exceeds max size (${MAX_SKILL_SIZE / 1024}KB).` };
    }
    const fp = this.skillPath(user, name);
    if (!fs.existsSync(fp)) return { ok: false, message: `Skill "${name}" not found. Use create.` };
    // Verbatim persistence — see createSkill comment.
    fs.writeFileSync(fp, content, 'utf-8');
    return { ok: true, message: `Skill "${name}" updated.` };
  }

  deleteSkill(user: string, name: string): { ok: boolean; message: string } {
    if (!SKILL_NAME_PATTERN.test(name) || !isSafeSegment(name)) {
      return { ok: false, message: `Invalid skill name "${name}".` };
    }
    const skillDir = path.join(this.skillsDir(user), name);
    if (!fs.existsSync(skillDir)) return { ok: false, message: `Skill "${name}" not found.` };
    fs.rmSync(skillDir, { recursive: true, force: true });
    return { ok: true, message: `Skill "${name}" deleted.` };
  }

  /**
   * Read raw SKILL.md for cross-user copy-paste. The dispatcher applies the
   * character-count cap (`SHARE_CONTENT_CHAR_LIMIT`) — this layer just answers
   * "valid name?" / "exists?" / "here is the content".
   *
   * Error messages are imported from `skill-share-errors.ts` so this layer and
   * the in-process `src/user-skill-store.ts` cannot drift on user-facing
   * wording (the test suite would catch drift, but routing both through one
   * module makes drift impossible by construction).
   */
  shareSkill(user: string, name: string): { ok: boolean; message: string; content?: string } {
    if (!SKILL_NAME_PATTERN.test(name) || !isSafeSegment(name)) {
      return { ok: false, message: invalidSkillNameMessage(name) };
    }
    const fp = this.skillPath(user, name);
    if (!fs.existsSync(fp)) {
      return { ok: false, message: skillNotFoundMessage(name) };
    }
    const content = fs.readFileSync(fp, 'utf-8');
    return { ok: true, message: `Skill "${name}" read for share.`, content };
  }

  /**
   * Rename `skills/{name}` → `skills/{newName}` via temp-staging.
   *
   * Why a 2-step move with a uuid-suffixed temp dir:
   *   1. `fs.renameSync(src, dst)` is a no-op (and silently succeeds) on
   *      case-insensitive filesystems when `src.toLowerCase() ===
   *      dst.toLowerCase()` and the directories share an inode (Darwin HFS+
   *      / APFS default, NTFS without case-sensitivity flag). A pure-case
   *      rename would leave the source intact under its old casing.
   *   2. The temp staging path makes the operation atomic from the dir-
   *      listing perspective: the source disappears, the temp briefly
   *      exists (named with a uuid so a parallel rename can't collide),
   *      then the target appears. Listing in between is racy by design but
   *      can never see *both* old + new names at once.
   *
   * Failure handling: if the second rename fails, we attempt to roll the
   * temp dir back to the original source name. A failed rollback is logged
   * indirectly via the IO error code — the user sees `IO` and can investigate
   * the user's skills/ directory manually.
   */
  renameSkill(
    user: string,
    name: string,
    newName: string,
  ): { ok: boolean; message: string; error?: SkillRenameErrorCode } {
    if (!SKILL_NAME_PATTERN.test(name) || !isSafeSegment(name)) {
      return { ok: false, message: invalidSkillNameMessage(name), error: 'INVALID' };
    }
    if (!SKILL_NAME_PATTERN.test(newName) || !isSafeSegment(newName)) {
      return { ok: false, message: invalidSkillNameMessage(newName), error: 'INVALID' };
    }
    if (newName.length > MAX_SKILL_NAME_LENGTH_RENAME) {
      return {
        ok: false,
        message: `Skill name too long (${newName.length} > ${MAX_SKILL_NAME_LENGTH_RENAME} chars).`,
        error: 'INVALID',
      };
    }
    if (name === newName) {
      return { ok: false, message: skillRenameSameNameMessage(name), error: 'INVALID' };
    }

    const skillsRoot = this.skillsDir(user);
    const srcDir = path.join(skillsRoot, name);
    const dstDir = path.join(skillsRoot, newName);

    if (!fs.existsSync(srcDir)) {
      return { ok: false, message: skillRenameSourceMissingMessage(name), error: 'NOT_FOUND' };
    }

    // Case-only rename guard: when `name.toLowerCase() === newName.toLowerCase()`
    // and they refer to the same inode (case-insensitive FS), `existsSync(dstDir)`
    // would lie and return true. Currently unreachable under the kebab-case
    // predicate (which rejects uppercase outright), so this branch is
    // defense-in-depth against future predicate relaxation (e.g. camelCase
    // aliases). The temp-staging step below is what makes a future case-only
    // rename actually move bits, not just no-op.
    const isCaseOnlyRename = name.toLowerCase() === newName.toLowerCase();
    if (!isCaseOnlyRename && fs.existsSync(dstDir)) {
      return { ok: false, message: skillRenameTargetExistsMessage(newName), error: 'EEXIST' };
    }

    const tempDir = path.join(skillsRoot, `.rename-${randomUUID()}`);

    try {
      fs.renameSync(srcDir, tempDir);
    } catch {
      return { ok: false, message: skillRenameIoFailureMessage(name, newName), error: 'IO' };
    }

    try {
      fs.renameSync(tempDir, dstDir);
    } catch {
      // Roll back so the user's skill doesn't vanish.
      try {
        fs.renameSync(tempDir, srcDir);
      } catch {
        // Both renames failed — temp dir survives. The IO error message
        // tells the user to look manually; we don't try to delete because
        // that would lose data.
      }
      return { ok: false, message: skillRenameIoFailureMessage(name, newName), error: 'IO' };
    }

    return { ok: true, message: skillRenameSuccessMessage(name, newName) };
  }
}

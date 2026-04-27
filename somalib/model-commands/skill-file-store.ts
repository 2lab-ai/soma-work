/**
 * Standalone SkillStore implementation using file I/O.
 * No dependency on app-level modules (Logger, env-paths, etc.).
 * Used by MCP servers that run as separate processes.
 * Mirrors memory-file-store.ts pattern.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { SkillStore } from './catalog';
import { invalidSkillNameMessage, skillNotFoundMessage } from './skill-share-errors';

const MAX_SKILL_SIZE = 10 * 1024; // 10KB
const MAX_SKILLS_PER_USER = 50;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
    fs.writeFileSync(fp, trimmed, 'utf-8');
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
    fs.writeFileSync(fp, trimmed, 'utf-8');
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
}

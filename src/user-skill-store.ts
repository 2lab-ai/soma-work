/**
 * User Personal Skill Store
 *
 * Mirrors user-memory-store.ts pattern for per-user skill management.
 * Skills are stored at DATA_DIR/{userId}/skills/{name}/SKILL.md
 * Format: YAML frontmatter + markdown body (same as src/local/skills/).
 *
 * Inspired by hermes-agent skill_manager_tool.py — but multi-tenant (per-user isolation).
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import { isSafePathSegment } from './path-utils';

const logger = new Logger('UserSkillStore');

/** Max SKILL.md file size in bytes */
const MAX_SKILL_SIZE = 10 * 1024; // 10KB
/** Max skills per user */
const MAX_SKILLS_PER_USER = 50;
/** Kebab-case skill name pattern */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface UserSkillMeta {
  name: string;
  description: string;
}

export interface UserSkillDetail extends UserSkillMeta {
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

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && isSafePathSegment(name);
}

/**
 * Extract description from YAML frontmatter.
 * Expects: ---\nname: ...\ndescription: "..."\n---
 */
function extractDescription(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?description:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/);
  return match?.[1]?.trim() ?? '';
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
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      const content = fs.readFileSync(skillFile, 'utf-8');
      skills.push({
        name: entry.name,
        description: extractDescription(content),
      });
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
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

  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, message: 'Skill content is empty.' };
  }
  if (Buffer.byteLength(trimmed, 'utf-8') > MAX_SKILL_SIZE) {
    return { ok: false, message: `Skill exceeds max size (${MAX_SKILL_SIZE / 1024}KB).` };
  }

  // Check skill count limit
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
  fs.writeFileSync(skillFile, trimmed, 'utf-8');

  logger.info('User skill created', { userId, skillName });
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

  fs.writeFileSync(skillFile, trimmed, 'utf-8');

  logger.info('User skill updated', { userId, skillName });
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
  return { ok: true, message: `Skill "${skillName}" deleted.` };
}

/**
 * Get the filesystem path for a user skill's SKILL.md.
 * Used by SkillForceHandler for resolving $user:skill-name references.
 */
export function getUserSkillPath(userId: string, skillName: string): string {
  return getSkillPath(userId, skillName);
}

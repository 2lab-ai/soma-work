import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../../logger';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * LOCAL_SKILLS_DIR: resolves to dist/local/skills at runtime.
 * __dirname at runtime = dist/slack/commands/ → ../../local/skills
 */
const LOCAL_SKILLS_DIR = path.resolve(__dirname, '..', '..', 'local', 'skills');

/** Max recursion depth to prevent infinite loops in skill references. */
const MAX_DEPTH = 10;

/** Regex to find $local:skillname or $stv:skillname patterns in text. */
const SKILL_REF_PATTERN = /\$local:([a-zA-Z0-9_-]+)/g;

/**
 * Handles forced skill invocation via $local:skillname syntax.
 *
 * When a user message contains $local:z, this handler:
 * 1. Extracts all $local:skillname references from the text
 * 2. Reads each SKILL.md file
 * 3. Recursively resolves nested $local: references inside skill content
 * 4. Builds an <invoked_skills> block and appends it to the user's original text
 * 5. Returns via continueWithPrompt so Claude processes both the instruction and the skills
 */
export class SkillForceHandler implements CommandHandler {
  private logger = new Logger('SkillForceHandler');

  canHandle(text: string): boolean {
    SKILL_REF_PATTERN.lastIndex = 0;
    return SKILL_REF_PATTERN.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, say, threadTs } = ctx;

    // Reset regex lastIndex (stateful global regex)
    SKILL_REF_PATTERN.lastIndex = 0;

    // Collect all top-level skill references from user text
    const topLevelSkills = this.extractSkillNames(text);

    if (topLevelSkills.length === 0) {
      return { handled: false };
    }

    // Resolve all skills recursively, collecting content
    const resolved = new Map<string, string>();
    const errors: string[] = [];

    for (const skillName of topLevelSkills) {
      this.resolveSkill(skillName, resolved, errors, 0);
    }

    if (resolved.size === 0) {
      // All skills failed to resolve
      await say({
        text: `❌ 스킬을 찾을 수 없습니다: ${errors.join(', ')}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Report any partial errors
    if (errors.length > 0) {
      this.logger.warn('Some skills could not be resolved', { errors });
    }

    // Build the <invoked_skills> block
    const skillBlocks = Array.from(resolved.entries())
      .map(([name, content]) => `<local:${name}>\n${content}\n</local:${name}>`)
      .join('\n');

    const invokedBlock = `<invoked_skills>\n${skillBlocks}\n</invoked_skills>`;

    // Compose final prompt: original user text + invoked skills
    const finalPrompt = `${text}\n\n${invokedBlock}`;

    this.logger.info('Forced skill invocation', {
      skills: Array.from(resolved.keys()),
      errorSkills: errors,
    });

    return {
      handled: true,
      continueWithPrompt: finalPrompt,
    };
  }

  /**
   * Extract unique skill names from text (in order of appearance).
   */
  private extractSkillNames(text: string): string[] {
    SKILL_REF_PATTERN.lastIndex = 0;
    const names: string[] = [];
    const seen = new Set<string>();
    for (;;) {
      const match = SKILL_REF_PATTERN.exec(text);
      if (match === null) break;
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }

  /**
   * Recursively resolve a skill and all its nested $local: references.
   * Results are added to the `resolved` map in dependency order.
   */
  private resolveSkill(skillName: string, resolved: Map<string, string>, errors: string[], depth: number): void {
    // Guard: already resolved or max depth
    if (resolved.has(skillName)) return;
    if (depth >= MAX_DEPTH) {
      this.logger.warn('Max skill recursion depth reached', { skillName, depth });
      return;
    }

    // Read SKILL.md
    const skillPath = path.join(LOCAL_SKILLS_DIR, skillName, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      errors.push(skillName);
      this.logger.warn('Skill file not found', { skillPath });
      return;
    }

    const content = fs.readFileSync(skillPath, 'utf-8');

    // Find nested $local: references in the skill content
    const nested = this.extractSkillNames(content);
    for (const nestedName of nested) {
      this.resolveSkill(nestedName, resolved, errors, depth + 1);
    }

    // Add this skill AFTER its dependencies (depth-first)
    resolved.set(skillName, content);
  }
}

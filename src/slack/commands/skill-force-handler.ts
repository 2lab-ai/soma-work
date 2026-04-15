import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLUGINS_DIR } from '../../env-paths';
import { Logger } from '../../logger';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * LOCAL_SKILLS_DIR: resolves to dist/local/skills at runtime.
 * __dirname at runtime = dist/slack/commands/ → ../../local/skills
 */
const LOCAL_SKILLS_DIR = path.resolve(__dirname, '..', '..', 'local', 'skills');

/** Max recursion depth to prevent infinite loops in skill references. */
const MAX_DEPTH = 10;

/**
 * Regex to find $plugin:skillname patterns in text.
 * Matches: $local:z, $stv:new-task, $superpowers:brainstorming, etc.
 */
const SKILL_REF_PATTERN = /\$([\w-]+):([\w-]+)/g;

/** Qualified skill reference: plugin + skill name */
interface SkillRef {
  plugin: string;
  skill: string;
  /** Canonical key for deduplication: "plugin:skill" */
  key: string;
}

/**
 * Handles forced skill invocation via $plugin:skillname syntax.
 *
 * Examples:
 *   $local:z         → reads local/skills/z/SKILL.md
 *   $stv:new-task    → reads plugins/stv/skills/new-task/SKILL.md
 *   $superpowers:tdd → reads plugins/superpowers/skills/tdd/SKILL.md
 *
 * Nested $plugin:skill references inside skill content are resolved recursively.
 */
export class SkillForceHandler implements CommandHandler {
  private logger = new Logger('SkillForceHandler');

  canHandle(text: string): boolean {
    SKILL_REF_PATTERN.lastIndex = 0;
    return SKILL_REF_PATTERN.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, say, threadTs } = ctx;

    // Collect all top-level skill references from user text
    const topLevelRefs = this.extractSkillRefs(text);

    if (topLevelRefs.length === 0) {
      return { handled: false };
    }

    // Resolve all skills recursively, collecting content
    const resolved = new Map<string, string>();
    const errors: string[] = [];

    for (const ref of topLevelRefs) {
      this.resolveSkill(ref, resolved, errors, 0);
    }

    if (resolved.size === 0) {
      await say({
        text: `❌ 스킬을 찾을 수 없습니다: ${errors.join(', ')}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (errors.length > 0) {
      this.logger.warn('Some skills could not be resolved', { errors });
    }

    // Build the <invoked_skills> block with plugin:skill tags
    const skillBlocks = Array.from(resolved.entries())
      .map(([key, content]) => `<${key}>\n${content}\n</${key}>`)
      .join('\n');

    const invokedBlock = `<invoked_skills>\n${skillBlocks}\n</invoked_skills>`;
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
   * Extract unique skill references from text (in order of appearance).
   */
  private extractSkillRefs(text: string): SkillRef[] {
    SKILL_REF_PATTERN.lastIndex = 0;
    const refs: SkillRef[] = [];
    const seen = new Set<string>();
    for (;;) {
      const match = SKILL_REF_PATTERN.exec(text);
      if (match === null) break;
      const key = `${match[1]}:${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ plugin: match[1], skill: match[2], key });
      }
    }
    return refs;
  }

  /**
   * Resolve the filesystem path for a skill based on its plugin.
   *
   * - local  → dist/local/skills/{skill}/SKILL.md
   * - others → {PLUGINS_DIR}/{plugin}/skills/{skill}/SKILL.md
   */
  private resolveSkillPath(ref: SkillRef): string {
    if (ref.plugin === 'local') {
      return path.join(LOCAL_SKILLS_DIR, ref.skill, 'SKILL.md');
    }
    return path.join(PLUGINS_DIR, ref.plugin, 'skills', ref.skill, 'SKILL.md');
  }

  /**
   * Recursively resolve a skill and all its nested $plugin:skill references.
   * Results are added to the `resolved` map in dependency order (depth-first).
   */
  private resolveSkill(ref: SkillRef, resolved: Map<string, string>, errors: string[], depth: number): void {
    if (resolved.has(ref.key)) return;
    if (depth >= MAX_DEPTH) {
      this.logger.warn('Max skill recursion depth reached', { skill: ref.key, depth });
      return;
    }

    const skillPath = this.resolveSkillPath(ref);
    if (!fs.existsSync(skillPath)) {
      errors.push(ref.key);
      this.logger.warn('Skill file not found', { skill: ref.key, skillPath });
      return;
    }

    const content = fs.readFileSync(skillPath, 'utf-8');

    // Recursively resolve nested skill references
    const nested = this.extractSkillRefs(content);
    for (const nestedRef of nested) {
      this.resolveSkill(nestedRef, resolved, errors, depth + 1);
    }

    // Add this skill AFTER its dependencies (depth-first)
    resolved.set(ref.key, content);
  }
}

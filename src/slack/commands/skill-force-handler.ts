import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from '../../env-paths';
import { Logger } from '../../logger';
import { isSafePathSegment } from '../../path-utils';
import { ToolFormatter } from '../tool-formatter';
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

/**
 * Regex to find bare $skillname patterns (no plugin prefix).
 * Matches: $z, $zcheck, $learn — namespace resolved via fallback chain.
 * Negative lookahead prevents matching the plugin part of $plugin:skill.
 */
const BARE_SKILL_PATTERN = /\$([\w-]+)(?![\w-]*:)/g;

/**
 * Fallback order for bare `$skill` resolution. Probed sequentially; the first
 * namespace whose `SKILL.md` exists on disk wins.
 *
 * - `user`        — `DATA_DIR/{userId}/skills/{name}/SKILL.md` (only when userId present)
 * - `local`       — `LOCAL_SKILLS_DIR/{name}/SKILL.md`
 * - `stv`         — `PLUGINS_DIR/stv/skills/{name}/SKILL.md`
 * - `superpowers` — `PLUGINS_DIR/superpowers/skills/{name}/SKILL.md`
 *
 * If all four miss, a final pass scans every other plugin directory under
 * `PLUGINS_DIR` for an exact-name match (see {@link SkillForceHandler.scanRemainingPlugins}).
 */
const BARE_FALLBACK_NAMESPACES: ReadonlyArray<'user' | 'local' | 'stv' | 'superpowers'> = [
  'user',
  'local',
  'stv',
  'superpowers',
];

/** Qualified skill reference: plugin + skill name */
interface SkillRef {
  plugin: string;
  skill: string;
  /** Canonical key for deduplication: "plugin:skill" */
  key: string;
}

/**
 * Outcome of resolving a bare `$skill` against the fallback chain.
 *
 * - `found`     — single namespace owns the name; use `ref`
 * - `ambiguous` — exactly one of the priority slots (1–4) didn't match but
 *                 the final PLUGINS_DIR scan turned up multiple plugins
 *                 hosting the same name; surface to user as an error
 * - `not_found` — no namespace owns the name
 */
type BareResolution =
  | { kind: 'found'; ref: SkillRef }
  | { kind: 'ambiguous'; name: string; matches: string[] }
  | { kind: 'not_found'; name: string };

/**
 * Handles forced skill invocation via $plugin:skillname syntax.
 *
 * Resolution order for bare $skill:
 *   1. user        → DATA_DIR/{userId}/skills/{skill}/SKILL.md (only if userId present)
 *   2. local       → LOCAL_SKILLS_DIR/{skill}/SKILL.md
 *   3. stv         → PLUGINS_DIR/stv/skills/{skill}/SKILL.md
 *   4. superpowers → PLUGINS_DIR/superpowers/skills/{skill}/SKILL.md
 *   5. PLUGINS_DIR full scan, exact name match. Multiple hits → ambiguous error.
 *
 * Examples:
 *   $z               → first slot of user/local/stv/superpowers/other-plugins owning "z"
 *   $local:z         → reads local/skills/z/SKILL.md (qualified, no fallback)
 *   $user:my-deploy  → reads DATA_DIR/{userId}/skills/my-deploy/SKILL.md
 *   $stv:new-task    → reads plugins/stv/skills/new-task/SKILL.md
 *
 * Qualified `$plugin:skill` references are NEVER fallback-resolved — they
 * point at exactly the namespace the user typed.
 *
 * Nested $plugin:skill references inside skill content are resolved recursively.
 * Nested bare $skill references inherit the same fallback chain (and the
 * caller's userId for the `user` slot).
 */
export class SkillForceHandler implements CommandHandler {
  private logger = new Logger('SkillForceHandler');

  canHandle(text: string, userId?: string): boolean {
    const trimmed = text.trim();
    SKILL_REF_PATTERN.lastIndex = 0;
    if (SKILL_REF_PATTERN.test(trimmed)) return true;

    // Bare $skill — match only when the fallback chain actually resolves
    // (or detects an ambiguity worth surfacing). This keeps `$model`,
    // `$verbosity`, `$effort` and other unrelated `$word` tokens from being
    // intercepted.
    BARE_SKILL_PATTERN.lastIndex = 0;
    for (;;) {
      const match = BARE_SKILL_PATTERN.exec(trimmed);
      if (match === null) break;
      const resolution = this.resolveBareSkill(match[1], userId);
      if (resolution.kind !== 'not_found') return true;
    }
    return false;
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, say, threadTs, user } = ctx;

    // Collect all top-level skill references from user text
    const { refs: topLevelRefs, ambiguous } = this.extractSkillRefs(text, user);

    if (ambiguous.length > 0) {
      // Ambiguous bare reference — surface immediately so the user knows to
      // disambiguate with an explicit `$plugin:name` form.
      const lines = ambiguous.map(
        (a) =>
          `\`$${a.name}\` 가 여러 plugin 에 존재합니다: ${a.matches
            .map((m) => `\`${m}\``)
            .join(', ')}. 명시적으로 \`$plugin:${a.name}\` 형태로 호출해 주세요.`,
      );
      await say({
        text: `❌ 모호한 스킬 참조:\n${lines.join('\n')}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (topLevelRefs.length === 0) {
      return { handled: false };
    }

    // Resolve all skills recursively, collecting content
    const resolved = new Map<string, string>();
    const errors: string[] = [];

    for (const ref of topLevelRefs) {
      this.resolveSkill(ref, resolved, errors, 0, user);
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

    const resolvedKeys = Array.from(resolved.keys());
    this.logger.info('Forced skill invocation', {
      skills: resolvedKeys,
      errorSkills: errors,
    });

    // Emit RPG-style forced skill invocation banner (red attachment bar)
    const casterName = user ? `<@${user}>` : '누군가';
    const rpg = ToolFormatter.formatSkillForceInvocationRPG(resolvedKeys, casterName);
    await say({
      text: '',
      thread_ts: threadTs,
      attachments: [{ color: rpg.color, text: rpg.text }],
    });

    return {
      handled: true,
      continueWithPrompt: finalPrompt,
    };
  }

  /**
   * Extract unique skill references from text (in order of appearance).
   * Supports both qualified ($plugin:skill — namespace as typed) and bare
   * ($skill — namespace via {@link resolveBareSkill}).
   *
   * Returned `ambiguous` entries belong to bare references that hit multiple
   * plugins in the PLUGINS_DIR scan; the caller (execute) reports them and
   * does NOT include them in `refs`.
   */
  private extractSkillRefs(
    text: string,
    userId?: string,
  ): { refs: SkillRef[]; ambiguous: { name: string; matches: string[] }[] } {
    const refs: SkillRef[] = [];
    const seen = new Set<string>();
    const ambiguous: { name: string; matches: string[] }[] = [];
    const ambiguousSeen = new Set<string>();

    // 1. Qualified refs: $plugin:skill (no fallback — namespace is explicit)
    SKILL_REF_PATTERN.lastIndex = 0;
    for (;;) {
      const match = SKILL_REF_PATTERN.exec(text);
      if (match === null) break;
      const key = `${match[1]}:${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ plugin: match[1], skill: match[2], key });
      }
    }

    // 2. Bare refs: $skill → resolve via fallback chain
    BARE_SKILL_PATTERN.lastIndex = 0;
    for (;;) {
      const match = BARE_SKILL_PATTERN.exec(text);
      if (match === null) break;
      const name = match[1];
      const resolution = this.resolveBareSkill(name, userId);

      if (resolution.kind === 'found') {
        if (!seen.has(resolution.ref.key)) {
          seen.add(resolution.ref.key);
          refs.push(resolution.ref);
        }
      } else if (resolution.kind === 'ambiguous') {
        if (!ambiguousSeen.has(name)) {
          ambiguousSeen.add(name);
          ambiguous.push({ name, matches: resolution.matches });
        }
      }
      // 'not_found' — silently skip; caller's regex matched a `$word` that
      // simply isn't a skill (likely `$model`, `$effort`, etc).
    }

    return { refs, ambiguous };
  }

  /**
   * Resolve a bare `$skill` to a single namespace by walking the fallback
   * chain. Pure read-only filesystem probing; no caching (skill installs are
   * rare and the call is gated by canHandle / extractSkillRefs anyway).
   */
  private resolveBareSkill(name: string, userId?: string): BareResolution {
    if (!isSafePathSegment(name)) {
      return { kind: 'not_found', name };
    }

    // 1–4: priority slots (user → local → stv → superpowers)
    for (const ns of BARE_FALLBACK_NAMESPACES) {
      if (ns === 'user' && (!userId || !isSafePathSegment(userId))) {
        continue;
      }
      const ref: SkillRef = { plugin: ns, skill: name, key: `${ns}:${name}` };
      if (fs.existsSync(this.resolveSkillPath(ref, userId))) {
        return { kind: 'found', ref };
      }
    }

    // 5: scan remaining plugins under PLUGINS_DIR for an exact-name match.
    // Excludes `stv` and `superpowers` (already probed) and any plugin
    // directory that fails the safe-segment check.
    const skip = new Set<string>(['stv', 'superpowers']);
    const matches = this.scanRemainingPlugins(name, skip);

    if (matches.length === 1) {
      const plugin = matches[0];
      return { kind: 'found', ref: { plugin, skill: name, key: `${plugin}:${name}` } };
    }
    if (matches.length > 1) {
      return {
        kind: 'ambiguous',
        name,
        matches: matches.map((p) => `${p}:${name}`),
      };
    }
    return { kind: 'not_found', name };
  }

  /**
   * List plugin directories under {@link PLUGINS_DIR} that own a skill named
   * `name`, excluding the ones in `skip`. Used as the final fallback step
   * for bare `$skill` resolution.
   *
   * Errors (missing PLUGINS_DIR, unreadable entries) are swallowed — this is
   * a best-effort lookup, not a critical path.
   */
  private scanRemainingPlugins(name: string, skip: Set<string>): string[] {
    if (!fs.existsSync(PLUGINS_DIR)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    } catch (err) {
      this.logger.warn('PLUGINS_DIR read failed during bare-skill scan', {
        pluginsDir: PLUGINS_DIR,
        error: (err as Error).message,
      });
      return [];
    }

    const matches: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const plugin = entry.name;
      if (skip.has(plugin)) continue;
      if (!isSafePathSegment(plugin)) continue;
      const skillPath = path.join(PLUGINS_DIR, plugin, 'skills', name, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        matches.push(plugin);
      }
    }
    return matches;
  }

  /**
   * Resolve the filesystem path for a skill based on its plugin.
   *
   * - local  → dist/local/skills/{skill}/SKILL.md
   * - user   → DATA_DIR/{userId}/skills/{skill}/SKILL.md
   * - others → {PLUGINS_DIR}/{plugin}/skills/{skill}/SKILL.md
   */
  private resolveSkillPath(ref: SkillRef, userId?: string): string {
    if (ref.plugin === 'local') {
      return path.join(LOCAL_SKILLS_DIR, ref.skill, 'SKILL.md');
    }
    if (ref.plugin === 'user' && userId && isSafePathSegment(userId) && isSafePathSegment(ref.skill)) {
      return path.join(DATA_DIR, userId, 'skills', ref.skill, 'SKILL.md');
    }
    return path.join(PLUGINS_DIR, ref.plugin, 'skills', ref.skill, 'SKILL.md');
  }

  /**
   * Recursively resolve a skill and all its nested $plugin:skill references.
   * Results are added to the `resolved` map in dependency order (depth-first).
   *
   * Nested bare references inherit the caller's `userId` so a user-scoped
   * skill can transitively reference its sibling user-scoped skills.
   * Ambiguous nested bare refs are dropped silently with a warning — they
   * are not the user's direct request, so a thrown error would be surprising.
   */
  private resolveSkill(
    ref: SkillRef,
    resolved: Map<string, string>,
    errors: string[],
    depth: number,
    userId?: string,
  ): void {
    if (resolved.has(ref.key)) return;
    if (depth >= MAX_DEPTH) {
      this.logger.warn('Max skill recursion depth reached', { skill: ref.key, depth });
      return;
    }

    const skillPath = this.resolveSkillPath(ref, userId);
    if (!fs.existsSync(skillPath)) {
      errors.push(ref.key);
      this.logger.warn('Skill file not found', { skill: ref.key, skillPath });
      return;
    }

    const content = fs.readFileSync(skillPath, 'utf-8');

    // Recursively resolve nested skill references
    const nested = this.extractSkillRefs(content, userId);
    if (nested.ambiguous.length > 0) {
      this.logger.warn('Ambiguous bare skill refs in nested content', {
        parent: ref.key,
        ambiguous: nested.ambiguous.map((a) => a.name),
      });
    }
    for (const nestedRef of nested.refs) {
      this.resolveSkill(nestedRef, resolved, errors, depth + 1, userId);
    }

    // Add this skill AFTER its dependencies (depth-first)
    resolved.set(ref.key, content);
  }
}

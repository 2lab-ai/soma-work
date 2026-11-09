/**
 * Skill locator — shared resolution + listing for skill NAMES.
 *
 * The `$skill` force-invocation path (`slack/commands/skill-force-handler.ts`)
 * owns the rich, recursive, permission-gated resolver used at message time.
 * This module is the lightweight, read-only counterpart used where we only
 * need to (a) turn a bare skill name into its SKILL.md content for prompt
 * injection, or (b) enumerate every skill a user could pick from.
 *
 * It deliberately mirrors the SAME fallback ORDER as the force handler so the
 * two never disagree about which namespace owns a bare name:
 *
 *   1. user        → DATA_DIR/{userId}/skills/{name}/SKILL.md (only if userId)
 *   2. local       → LOCAL_SKILLS_DIR/{name}/SKILL.md
 *   3. stv         → PLUGINS_DIR/stv/skills/{name}/SKILL.md
 *   4. superpowers → PLUGINS_DIR/superpowers/skills/{name}/SKILL.md
 *   5. other plugins under PLUGINS_DIR (first match wins, alphabetical)
 *
 * 3–5 and {@link skillMdFile} serve a PLUGINS_DIR plugin only when PluginManager admitted it on its
 * latest pass (`plugin/admitted-plugin-names`): a directory on disk is not proof of admission
 * (refused, blocked or unconfigured plugins can stay behind when their deletion fails).
 *
 * Used by:
 *   - prompt-builder.applyAutoskills (resolveAutoskillContent)
 *   - the `autoskill` add-picker UI (listAvailableSkills)
 *   - the settings page's 시스템 스킬 list (listInstalledSkills, `conversation/skills-routes.ts`)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from './env-paths';
import { Logger } from './logger';
import { isSafePathSegment } from './path-utils';
import { isAdmittedPluginName } from './plugin/admitted-plugin-names';

const logger = new Logger('SkillLocator');

/**
 * LOCAL_SKILLS_DIR resolves to dist/local/skills at runtime. This module
 * compiles to dist/skill-locator.js, so __dirname = dist root → local/skills.
 * (The build step copies src/local → dist/local; see package.json `build`.)
 */
const LOCAL_SKILLS_DIR = path.join(__dirname, 'local', 'skills');
/** #857 — the soma-work harness plugin (`local`): its skills resolve under the same `local:` key, after zworkflow's. */
const LOCAL_HARNESS_SKILLS_DIR = path.join(__dirname, 'local-harness', 'skills');

/** Priority plugin slots, probed before the generic PLUGINS_DIR scan. */
const PRIORITY_PLUGINS = ['stv', 'superpowers'] as const;

/** Source namespace of a located skill. `plugin:<name>` for non-priority plugins. */
export type SkillSource = 'user' | 'local' | 'stv' | 'superpowers' | string;

export interface AvailableSkill {
  /** Skill name (directory / invocation name). */
  name: string;
  /** Where it was found — first hit by priority order wins. */
  source: SkillSource;
}

export interface ResolvedAutoskill {
  /** Canonical `<namespace>:<name>` key used to tag the injected block. */
  key: string;
  /** Verbatim SKILL.md content. */
  content: string;
  /** Absolute SKILL.md path; its directory is the skill's base directory. */
  file: string;
}

function skillMdPath(dir: string, name: string): string {
  return path.join(dir, name, 'SKILL.md');
}

function userSkillsDir(userId: string): string {
  return path.join(DATA_DIR, userId, 'skills');
}

/**
 * Resolve a bare skill name to its SKILL.md content using the shared fallback
 * chain. Returns null when no namespace owns the name (caller logs/skips).
 * Pure read-only filesystem probing — no permission gate (autoskills only ever
 * reference the OWNER's own user namespace + shared local/plugin skills).
 */
export function resolveAutoskillContent(name: string, userId?: string): ResolvedAutoskill | null {
  if (!isSafePathSegment(name)) return null;

  const candidates: Array<{ key: string; file: string }> = [];

  if (userId && isSafePathSegment(userId)) {
    candidates.push({ key: `user:${name}`, file: skillMdPath(userSkillsDir(userId), name) });
  }
  candidates.push({ key: `local:${name}`, file: skillMdPath(LOCAL_SKILLS_DIR, name) });
  candidates.push({ key: `local:${name}`, file: skillMdPath(LOCAL_HARNESS_SKILLS_DIR, name) });
  for (const plugin of PRIORITY_PLUGINS) {
    if (!isAdmittedPluginName(plugin)) continue;
    candidates.push({ key: `${plugin}:${name}`, file: skillMdPath(path.join(PLUGINS_DIR, plugin, 'skills'), name) });
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c.file)) {
        return { key: c.key, content: fs.readFileSync(c.file, 'utf-8'), file: c.file };
      }
    } catch (err) {
      logger.warn('resolveAutoskillContent: read failed', { name, file: c.file, error: (err as Error).message });
    }
  }

  // 5. Scan remaining plugins (alphabetical), excluding the priority slots.
  for (const plugin of scanPluginNames()) {
    if ((PRIORITY_PLUGINS as readonly string[]).includes(plugin)) continue;
    const file = skillMdPath(path.join(PLUGINS_DIR, plugin, 'skills'), name);
    try {
      if (fs.existsSync(file)) {
        return { key: `${plugin}:${name}`, content: fs.readFileSync(file, 'utf-8'), file };
      }
    } catch {
      // best-effort — skip unreadable plugin dirs
    }
  }

  return null;
}

/** True iff a bare skill name resolves to some namespace on disk. */
export function autoskillExists(name: string, userId?: string): boolean {
  return resolveAutoskillContent(name, userId) !== null;
}

/**
 * List every skill the given user could register as an autoskill. Each name
 * appears once, attributed to the HIGHEST-priority namespace that owns it
 * (user > local > stv > superpowers > other plugins). Sorted by name.
 */
export function listAvailableSkills(userId?: string): AvailableSkill[] {
  const byName = new Map<string, SkillSource>();

  const add = (name: string, source: SkillSource): void => {
    if (!isSafePathSegment(name)) return;
    if (!byName.has(name)) byName.set(name, source);
  };

  // 1. user namespace (highest priority)
  if (userId && isSafePathSegment(userId)) {
    for (const name of listSkillDirsWithMd(userSkillsDir(userId))) add(name, 'user');
  }
  // 2. local
  for (const name of listSkillDirsWithMd(LOCAL_SKILLS_DIR)) add(name, 'local');
  for (const name of listSkillDirsWithMd(LOCAL_HARNESS_SKILLS_DIR)) add(name, 'local');
  // 3-4. priority plugins
  for (const plugin of PRIORITY_PLUGINS) {
    if (!isAdmittedPluginName(plugin)) continue;
    for (const name of listSkillDirsWithMd(path.join(PLUGINS_DIR, plugin, 'skills'))) add(name, plugin);
  }
  // 5. remaining plugins (alphabetical)
  for (const plugin of scanPluginNames()) {
    if ((PRIORITY_PLUGINS as readonly string[]).includes(plugin)) continue;
    for (const name of listSkillDirsWithMd(path.join(PLUGINS_DIR, plugin, 'skills'))) add(name, plugin);
  }

  return Array.from(byName.entries())
    .map(([name, source]) => ({ name, source }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The SKILL.md a listed skill reads from (the dashboard's `$` menu takes its description line), or null when its
 * source cannot name a file. `local` is zworkflow's skill, else the harness plugin's — the order the resolver uses.
 */
export function skillMdFile(skill: AvailableSkill, userId?: string): string | null {
  const { name, source } = skill;
  if (!isSafePathSegment(name) || !isSafePathSegment(source)) return null;
  if (source === 'user') return userId && isSafePathSegment(userId) ? skillMdPath(userSkillsDir(userId), name) : null;
  if (source === 'local') {
    const portable = skillMdPath(LOCAL_SKILLS_DIR, name);
    return fs.existsSync(portable) ? portable : skillMdPath(LOCAL_HARNESS_SKILLS_DIR, name);
  }
  if (!isAdmittedPluginName(source)) return null;
  return skillMdPath(path.join(PLUGINS_DIR, source, 'skills'), name);
}

/** One installed skill of a built-in or installed plugin, and the SKILL.md it reads from. */
export interface InstalledSkill {
  /** `local` for the bundled plugins, else the plugin's directory name under PLUGINS_DIR. */
  source: string;
  name: string;
  file: string;
}

/**
 * Every installed skill of the bundled `local` plugins and of every plugin under PLUGINS_DIR, as
 * (source, name) pairs — the settings page's 시스템 스킬 list (#1079). Not deduped by name the way
 * {@link listAvailableSkills} is: the page shows what is installed, not what a bare name resolves to.
 * `excludePlugins` leaves plugins out entirely — the environment plugins, whose skills carry host
 * values and are listed (gated) elsewhere. Dot-directories (`.backups` keeps old copies of the
 * environment plugins) are never scanned, and a PLUGINS_DIR plugin only when PluginManager admitted it
 * (`plugin/admitted-plugin-names`). User skills live under DATA_DIR and are not part of this.
 * Order: local (zworkflow's, then the harness's), then plugins by name; names sorted inside each.
 */
export function listInstalledSkills(
  opts: { excludePlugins?: Iterable<string>; pluginsDir?: string; localDirs?: string[] } = {},
): InstalledSkill[] {
  const exclude = new Set(opts.excludePlugins ?? []);
  const out: InstalledSkill[] = [];
  const seen = new Set<string>();
  const addDir = (source: string, dir: string): void => {
    for (const name of listSkillDirsWithMd(dir).sort((a, b) => a.localeCompare(b))) {
      // The two local dirs share the `local:` key; the resolver reads zworkflow's first, and so does this.
      if (seen.has(`${source}\u0000${name}`)) continue;
      seen.add(`${source}\u0000${name}`);
      out.push({ source, name, file: skillMdPath(dir, name) });
    }
  };
  for (const dir of opts.localDirs ?? [LOCAL_SKILLS_DIR, LOCAL_HARNESS_SKILLS_DIR]) addDir('local', dir);
  const pluginsDir = opts.pluginsDir ?? PLUGINS_DIR;
  for (const plugin of scanPluginNames(pluginsDir)) {
    if (plugin.startsWith('.') || exclude.has(plugin)) continue;
    addDir(plugin, path.join(pluginsDir, plugin, 'skills'));
  }
  return out;
}

/** Directory names under `dir` that contain a `SKILL.md`. Empty on any error. */
function listSkillDirsWithMd(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!isSafePathSegment(e.name)) continue;
    try {
      if (fs.existsSync(skillMdPath(dir, e.name))) out.push(e.name);
    } catch {
      // skip
    }
  }
  return out;
}

/** Admitted plugin directory names under `pluginsDir` (alphabetical). Empty on error. */
function scanPluginNames(pluginsDir: string = PLUGINS_DIR): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isSafePathSegment(e.name) && isAdmittedPluginName(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

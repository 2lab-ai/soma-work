/**
 * Environment skills — the skills of the deploy-time environment plugins.
 *
 * The fleet deploy installs a host's environment plugin (`src/deploy/apply-env-plugins.ts`) and
 * marks it in `config.json` `plugin.envPlugins`. Such a plugin carries the host's environment
 * values and policy (post-deploy QA targets, tracker states, test accounts, …), so its skills run
 * for a non-admin only on an admin's grant:
 *
 *   - the decision is step 6b of `evaluateToolPolicy` (the model's `Skill` tool), fed by
 *     {@link checkEnvSkillPermission}, and the same check in `SkillForceHandler` (`$plugin:skill`);
 *   - grants live in the single skill-grant store under `ENV_SKILL_GRANT_OWNER`
 *     (`user-skill-grants-store.ts`);
 *   - the ask is `requestEnvSkillPermission` (`slack/env-skill-permission-request.ts`) and the
 *     admins' answer `EnvSkillPermissionActionHandler`.
 *
 * Admins never reach this check: the policy and the force handler exempt them first.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_FILE, PLUGINS_DIR } from './env-paths';
import { Logger } from './logger';
import { isSafePathSegment } from './path-utils';
import { parsePluginRef } from './plugin/config-parser';
import { ENV_SKILL_GRANT_OWNER, type GrantScope, isEnvSkillUseAllowed, loadGrants } from './user-skill-grants-store';
import { extractDescription } from './user-skill-store';

const logger = new Logger('EnvSkillRegistry');

/**
 * The deny reason of a non-admin `Skill` call whose `skill` input is missing or not a string on a
 * host with environment plugins: it cannot be told apart from an environment skill, so it is denied
 * (fail closed). No admin is asked — there is no skill to name.
 */
export const ENV_SKILL_UNNAMED = '(no skill name)';

/** Which plugins are environment plugins, and where their skill files live. */
export interface EnvSkillRegistry {
  /** Plugin names (`name` of `name@marketplace`) from `plugin.envPlugins`. */
  pluginNames: ReadonlySet<string>;
  /** `PLUGINS_DIR` — `<pluginsDir>/<plugin>/skills/<skill>/SKILL.md`. */
  pluginsDir: string;
}

/**
 * The registry of this host: the plugin manager's `plugin.envPlugins`, or — when there is no plugin
 * manager (it failed to start) — the same list read from `config.json`, so a missing manager never
 * opens the gate while the plugin files still sit in `PLUGINS_DIR`.
 */
export function envSkillRegistry(
  pluginManager: { getEnvPluginNames(): ReadonlySet<string> } | undefined,
  pluginsDir: string = PLUGINS_DIR,
  configFile?: string,
): EnvSkillRegistry {
  const pluginNames = pluginManager
    ? pluginManager.getEnvPluginNames()
    : envPluginNamesFromConfig(configFile ?? configPath());
  return { pluginNames, pluginsDir };
}

/** `CONFIG_FILE`, or '' when this process has none (an embedding that resolves no config path). */
function configPath(): string {
  try {
    return CONFIG_FILE ?? '';
  } catch {
    return '';
  }
}

/** `plugin.envPlugins` of `configFile`, as plugin names; empty when there is none. */
export function envPluginNamesFromConfig(configFile: string): ReadonlySet<string> {
  const names = new Set<string>();
  if (!configFile || !fs.existsSync(configFile)) return names;
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as { plugin?: { envPlugins?: unknown } };
    const refs = raw?.plugin?.envPlugins;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        const parsed = typeof ref === 'string' ? parsePluginRef(ref) : null;
        if (parsed) names.add(parsed.pluginName);
      }
    }
  } catch (error) {
    logger.warn('config.json unreadable while resolving environment plugins', {
      error: (error as Error)?.message ?? String(error),
    });
  }
  return names;
}

function skillFileExists(registry: EnvSkillRegistry, plugin: string, skill: string): boolean {
  try {
    return fs.existsSync(path.join(registry.pluginsDir, plugin, 'skills', skill, 'SKILL.md'));
  } catch {
    return false;
  }
}

/**
 * The canonical `plugin:skill` key when `skillId` names an environment skill, else null.
 *
 *   - `plugin:skill` — an environment skill whenever `plugin` is an environment plugin, whether or
 *     not the file exists (a name the SDK cannot resolve stays denied rather than slipping past).
 *   - a bare `skill` — an environment skill when an environment plugin ships a skill of that name
 *     (the first such plugin, in name order).
 */
export function resolveEnvSkillKey(skillId: string, registry: EnvSkillRegistry): string | null {
  if (registry.pluginNames.size === 0) return null;
  const id = skillId.trim();
  if (!id) return null;
  const colon = id.indexOf(':');
  if (colon >= 0) {
    const plugin = id.slice(0, colon);
    const skill = id.slice(colon + 1);
    return registry.pluginNames.has(plugin) ? `${plugin}:${skill}` : null;
  }
  if (!isSafePathSegment(id)) return null;
  for (const plugin of [...registry.pluginNames].sort()) {
    if (isSafePathSegment(plugin) && skillFileExists(registry, plugin, id)) return `${plugin}:${id}`;
  }
  return null;
}

/** Does the environment skill `skillKey` (`plugin:skill`) still exist on disk? */
export function envSkillExists(skillKey: string, registry: EnvSkillRegistry): boolean {
  const colon = skillKey.indexOf(':');
  if (colon < 0) return false;
  const plugin = skillKey.slice(0, colon);
  const skill = skillKey.slice(colon + 1);
  if (!registry.pluginNames.has(plugin) || !isSafePathSegment(plugin) || !isSafePathSegment(skill)) return false;
  return skillFileExists(registry, plugin, skill);
}

/** One skill of an environment plugin, as the `skill` command lists it. */
export interface EnvSkillEntry {
  /** `plugin:skill` — what a user types after `$` to run it. */
  key: string;
  plugin: string;
  skill: string;
  /** Frontmatter `description`, or '' when the SKILL.md has none. */
  description: string;
}

/**
 * Every skill the environment plugins of this host ship, sorted by key. A skill is a
 * `<plugin>/skills/<skill>/` directory holding a SKILL.md; anything else is skipped.
 */
export function listEnvSkills(registry: EnvSkillRegistry): EnvSkillEntry[] {
  const entries: EnvSkillEntry[] = [];
  for (const plugin of registry.pluginNames) {
    if (!isSafePathSegment(plugin)) continue;
    const skillsDir = path.join(registry.pluginsDir, plugin, 'skills');
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue; // plugin not installed (yet) on this host
    }
    for (const dir of dirs) {
      if (!dir.isDirectory() || !isSafePathSegment(dir.name)) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(skillsDir, dir.name, 'SKILL.md'), 'utf-8');
      } catch {
        continue;
      }
      entries.push({
        key: `${plugin}:${dir.name}`,
        plugin,
        skill: dir.name,
        description: extractDescription(content),
      });
    }
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * `ctx.checkEnvSkillPermission` for a non-admin `requesterId` in `scope`'s thread: the environment
 * skill key when `skillId` names an environment skill the requester holds no grant for (step 6b
 * denies it with that reason), else null.
 */
export function checkEnvSkillPermission(
  skillId: string,
  requesterId: string,
  scope: GrantScope,
  registry: EnvSkillRegistry,
): string | null {
  const key = resolveEnvSkillKey(skillId, registry);
  if (key === null) return null;
  return isEnvSkillUseAllowed(key, requesterId, scope) ? null : key;
}

/** `PLUGINS_DIR` as written and as the OS resolves it (symbolic links followed). */
function pluginRoots(registry: EnvSkillRegistry): string[] {
  const roots = new Set([path.resolve(registry.pluginsDir)]);
  try {
    roots.add(fs.realpathSync(registry.pluginsDir));
  } catch {
    // PLUGINS_DIR may not exist (tests, dev) — the lexical root is enough then.
  }
  return [...roots];
}

/**
 * The directories of the environment plugins and of their backups, as written and resolved — the
 * OS-level read deny list a non-admin's sandboxed Bash gets (every shell spelling, symbolic link
 * and wildcard included, which a text check cannot see).
 */
export function envPluginDirectories(registry: EnvSkillRegistry): string[] {
  const dirs: string[] = [];
  for (const root of pluginRoots(registry)) {
    for (const plugin of registry.pluginNames) {
      if (!isSafePathSegment(plugin)) continue;
      dirs.push(path.join(root, plugin), path.join(root, '.backups', plugin));
    }
  }
  return [...new Set(dirs)];
}

/** The sandbox `denyRead` entries for a non-admin `requesterId`: none with the all-environment-skills grant. */
export function envSkillSandboxDenyRead(registry: EnvSkillRegistry, requesterId: string): string[] {
  if (registry.pluginNames.size === 0) return [];
  if (loadGrants(ENV_SKILL_GRANT_OWNER).allowAll.includes(requesterId)) return [];
  return envPluginDirectories(registry);
}

/**
 * Where a path sits relative to the environment plugins: inside a skill's directory
 * (`plugin:skill`), elsewhere in an environment plugin or its backups (the plugin name), or outside
 * them (null). A relative path resolves against `cwd`; an existing path is also checked as the OS
 * resolves it, so a symbolic link elsewhere cannot point into a plugin. With `scan` (a recursive
 * Grep or Glob), `PLUGINS_DIR` itself or any directory above it reaches every plugin: the first
 * environment plugin is returned.
 */
function classifyEnvPath(target: string, registry: EnvSkillRegistry, cwd?: string, scan = false): string | null {
  const lexical = path.resolve(cwd ?? '/', target);
  const spellings = [lexical];
  try {
    spellings.push(fs.realpathSync(lexical));
  } catch {
    // A path that does not exist yet (or cannot be resolved) is checked as written.
  }
  const roots = pluginRoots(registry);
  for (const resolved of spellings) {
    for (const root of roots) {
      if (scan && (root === resolved || root.startsWith(`${resolved}${path.sep}`) || resolved === path.sep)) {
        return [...registry.pluginNames].sort()[0] ?? null;
      }
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
      const parts = path.relative(root, resolved).split(path.sep);
      // `.backups/<plugin>/...` holds old copies of a plugin: treat it as the plugin itself.
      const plugin = parts[0] === '.backups' ? parts[1] : parts[0];
      if (!plugin || !registry.pluginNames.has(plugin)) continue;
      if (parts[0] !== '.backups' && parts[1] === 'skills' && parts[2]) return `${plugin}:${parts[2]}`;
      return plugin;
    }
  }
  return null;
}

/** Bash words that may name a path inside an environment plugin (text-level, like the sensitive-path check). */
function envPathsInCommand(command: string, registry: EnvSkillRegistry): string[] {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const roots = new Set([path.resolve(registry.pluginsDir)]);
  try {
    roots.add(fs.realpathSync(registry.pluginsDir));
  } catch {
    // PLUGINS_DIR may not exist (tests, dev).
  }
  // The plugin directory spelled as this host's PLUGINS_DIR (or its .backups), or as any
  // `…/plugins/<plugin>` / `….backups/<plugin>` path — the directory layout, never the bare name.
  const prefixes = [
    ...[...roots].map((root) => `${escape(root)}/(?:\\.backups/)?`),
    `(?:^|[\\s'"=])(?:[^\\s'"|;&]*/)?(?:plugins|\\.backups)/`,
  ];
  const found: string[] = [];
  for (const plugin of registry.pluginNames) {
    const re = new RegExp(`(?:${prefixes.join('|')})${escape(plugin)}(?=$|[/\\s'"|;&])(?:/skills/([\\w.-]+))?`, 'g');
    for (const m of command.matchAll(re)) {
      const key = m[1] && !m[0].includes('.backups/') ? `${plugin}:${m[1]}` : plugin;
      if (!found.includes(key)) found.push(key);
    }
  }
  return found;
}

/**
 * `ctx.checkEnvSkillPermission` (step 6b) for a non-admin `requesterId` in `scope`'s thread: the deny
 * reason when the call reaches an environment plugin the requester holds no grant for, else null.
 *
 *   - `Skill` — the named skill ({@link checkEnvSkillPermission}); a missing or non-string `skill`
 *     input is denied with {@link ENV_SKILL_UNNAMED} while the host has environment plugins.
 *   - `Read` / `Glob` / `Grep` / `Bash` — a path inside `<plugin>/skills/<skill>/` needs that skill's
 *     grant (reason `plugin:skill`); any other path of the plugin, or of its backups, needs the
 *     all-environment-skills grant (reason: the plugin name, for which no admin is asked).
 */
export function checkEnvSkillAccess(
  toolName: string,
  toolInput: Record<string, unknown>,
  requesterId: string,
  scope: GrantScope,
  registry: EnvSkillRegistry,
  cwd?: string,
): string | null {
  if (registry.pluginNames.size === 0) return null;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  // The SDK resolves a relative path against the session's working directory, else the process's.
  cwd = cwd ?? process.cwd();

  if (toolName === 'Skill') {
    const skill = str(toolInput.skill);
    if (skill === undefined || !skill.trim()) return ENV_SKILL_UNNAMED;
    return checkEnvSkillPermission(skill, requesterId, scope, registry);
  }

  // Writing an environment plugin's files is never granted: a grant lets the requester run a skill,
  // not rewrite what an admin will run next.
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const p = str(toolInput.file_path) ?? str(toolInput.notebook_path);
    const hit = p ? classifyEnvPath(p, registry, cwd) : null;
    return hit === null ? null : hit.split(':')[0];
  }

  const targets: string[] = [];
  const add = (hit: string | null) => {
    if (hit !== null) targets.push(hit);
  };
  switch (toolName) {
    case 'Read': {
      const p = str(toolInput.file_path);
      if (p) add(classifyEnvPath(p, registry, cwd));
      break;
    }
    case 'Grep': {
      // Without a path Grep searches the session's working directory.
      add(classifyEnvPath(str(toolInput.path) ?? cwd, registry, cwd, true));
      break;
    }
    case 'Glob': {
      const pattern = str(toolInput.pattern) ?? '';
      const base = str(toolInput.path) ?? cwd;
      // A glob's wildcard segment never names a directory: classify the part before the first one,
      // as a scan (it may reach every plugin below it).
      const literal = path.resolve(base, pattern).split(/[*?[{]/)[0] || '/';
      add(classifyEnvPath(literal, registry, cwd, /[*?[{]/.test(pattern)));
      break;
    }
    case 'Bash': {
      const command = str(toolInput.command);
      if (command) targets.push(...envPathsInCommand(command, registry));
      break;
    }
    default:
      return null;
  }

  const allowAll = targets.length > 0 && loadGrants(ENV_SKILL_GRANT_OWNER).allowAll.includes(requesterId);
  for (const target of targets) {
    if (allowAll) continue;
    if (target.includes(':') && isEnvSkillUseAllowed(target, requesterId, scope)) continue;
    return target;
  }
  return null;
}

/**
 * Environments (env-access WU4, #1212) — the unit an admin grants as a whole.
 *
 * An environment is an environment user: a `server-tools` entry in `config.json` with `envUser`
 * (`env:<org>-dev2`). Several entries may act as the same environment (an app host and a database host).
 * Each entry lists the environment-plugin skills that belong to it:
 *
 *   "server-tools": {
 *     "dev2": { "envUser": "env:acme-dev2", "skills": ["acme-env:deploy-dev2", "acme-env:qa-dev2"], … }
 *   }
 *
 * A skill key is `plugin:skill`, or `plugin:*` for every skill of that plugin. The admin's "this environment,
 * always" answer grants the requester every skill of the environment and every server-tools tool on its
 * servers (`user-skill-grants-store` `grantEnvironment`).
 *
 * A skill two environments both claim belongs to neither: the admin is offered no environment-wide answer for it.
 */
import * as fs from 'node:fs';
import { CONFIG_FILE } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('EnvUsers');

/** `env:` and a lower-case name; also a safe key in the grant file. */
const ENV_USER = /^env:[a-z0-9][a-z0-9-]{0,62}$/;
/** `plugin:skill` or `plugin:*` — plugin and skill names as the plugin cache allows them. */
const SKILL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*:(\*|[A-Za-z0-9][A-Za-z0-9._-]*)$/;

export interface Environment {
  /** `env:<org>-dev2` */
  id: string;
  /** The server-tools entries that act as this environment, in config order. */
  servers: string[];
  /** Its environment-plugin skills: `plugin:skill`, or `plugin:*`. */
  skills: string[];
}

/** What an admin reads: the environment's name without `env:`. */
export function environmentLabel(id: string): string {
  return id.startsWith('env:') ? id.slice(4) : id;
}

export function isEnvironmentId(value: unknown): value is string {
  return typeof value === 'string' && ENV_USER.test(value);
}

/** The environments of a parsed `config.json`. Malformed entries are left out and logged. */
export function environmentsFromConfig(raw: unknown): Environment[] {
  const section = (raw as { 'server-tools'?: unknown } | null)?.['server-tools'];
  if (!section || typeof section !== 'object') return [];
  const byId = new Map<string, Environment>();
  for (const [server, entry] of Object.entries(section as Record<string, unknown>)) {
    if (server === 'permission' || !entry || typeof entry !== 'object') continue;
    const { envUser, skills } = entry as { envUser?: unknown; skills?: unknown };
    if (envUser === undefined) continue;
    if (!isEnvironmentId(envUser)) {
      logger.warn(`server-tools "${server}": envUser must look like env:<name> — left out`);
      continue;
    }
    const env = byId.get(envUser) ?? { id: envUser, servers: [], skills: [] };
    env.servers.push(server);
    if (Array.isArray(skills)) {
      for (const key of skills) {
        if (typeof key === 'string' && SKILL_KEY.test(key)) {
          if (!env.skills.includes(key)) env.skills.push(key);
        } else {
          logger.warn(`server-tools "${server}": skill ${JSON.stringify(key)} is not plugin:skill — left out`);
        }
      }
    }
    byId.set(envUser, env);
  }
  return [...byId.values()];
}

let cache: { file: string; mtimeMs: number; size: number; envs: Environment[] } | undefined;

/**
 * This host's environments, from `configFile` (default `CONFIG_FILE`). Re-read when the file changes; empty when
 * there is no file or it does not parse.
 */
export function loadEnvironments(configFile: string = CONFIG_FILE): Environment[] {
  if (!configFile) return [];
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(configFile);
  } catch {
    return [];
  }
  // A stubbed or odd file system may answer without a stat: no environments rather than a crash in the gate.
  if (!stat || typeof stat.mtimeMs !== 'number') return [];
  if (cache && cache.file === configFile && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.envs;
  }
  let envs: Environment[];
  try {
    envs = environmentsFromConfig(JSON.parse(fs.readFileSync(configFile, 'utf-8')));
  } catch (error) {
    // A config that stops parsing (a half-written edit) must not drop the environment gate: keep the last
    // environments read from this file. server-tools keeps its last servers on the same failure.
    logger.warn('config.json unreadable while resolving environments — keeping the last ones read', {
      error: (error as Error)?.message ?? String(error),
    });
    return cache && cache.file === configFile ? cache.envs : [];
  }
  cache = { file: configFile, mtimeMs: stat.mtimeMs, size: stat.size, envs };
  return envs;
}

/** Does `pattern` (`plugin:skill` or `plugin:*`) cover the skill `skillKey` (`plugin:skill`)? */
export function skillPatternCovers(pattern: string, skillKey: string): boolean {
  if (pattern === skillKey) return true;
  return pattern.endsWith(':*') && skillKey.startsWith(pattern.slice(0, -1));
}

/** The one environment whose skills cover `skillKey`; null when none or more than one does. */
export function environmentOfSkill(skillKey: string, envs: readonly Environment[]): Environment | null {
  const owners = envs.filter((env) => env.skills.some((pattern) => skillPatternCovers(pattern, skillKey)));
  return owners.length === 1 ? owners[0] : null;
}

/** The environment a server-tools entry acts as, or null. */
export function environmentOfServer(server: string, envs: readonly Environment[]): Environment | null {
  return envs.find((env) => env.servers.includes(server)) ?? null;
}

/** The environments that own at least one skill of `plugin` (`plugin:…` keys). */
export function environmentsOfPlugin(plugin: string, envs: readonly Environment[]): Environment[] {
  return envs.filter((env) => env.skills.some((pattern) => pattern.startsWith(`${plugin}:`)));
}

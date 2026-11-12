/**
 * Cross-user skill PERMISSION grants store.
 *
 * Gates A (requester) using B (owner)'s personal skills. Until B grants A
 * access, A's attempt to use/view/copy B's skill is intercepted and B is asked
 * for permission (see `skill-permission-request-store.ts` + the force/menu
 * handlers). Three tiers:
 *   - one-time   — transient, in-memory, strict single-use. Consumed only at
 *                  the actual fulfillment, never by a check (codex review).
 *   - per-skill  — persisted: A may use B's skill X.
 *   - all-skills — persisted: A may use any of B's skills.
 *
 * Persisted grants live at `DATA_DIR/{ownerId}/skill-grants.json`. Mirrors the
 * per-user JSON-store pattern of `user-settings-store` / `user-skill-store`.
 *
 * Environment skills (skills of a deploy-time environment plugin) use the same
 * store under the reserved owner {@link ENV_SKILL_GRANT_OWNER}: no user owns
 * them, admins grant them (`env-skill-permission-action-handler`). Their grants
 * live at `DATA_DIR/env-skill-grants.json`, keyed by `plugin:skill`, and add one
 * tier the user-skill flow does not have — a thread grant (the admin's "1회"):
 * the requester may run the skill in that one thread until it expires, because
 * one deploy calls the same environment skill several times. Any grant of one of
 * a plugin's skills also opens that plugin's MCP tools (`isEnvPluginUseAllowed`).
 */
import { atomicWriteJson } from '@soma/common/atomic-json';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import { isSafePathSegment } from './path-utils';

const logger = new Logger('UserSkillGrantsStore');

/** Default TTL for a one-time grant — long enough to cover a re-dispatch. */
const ONE_TIME_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Reserved owner id for environment-skill grants. Not a Slack id shape (those
 * are upper-case), so no user can be this owner — and `isSkillUseAllowed`'s
 * "own skill" shortcut can never fire for it.
 */
export const ENV_SKILL_GRANT_OWNER = 'env-skills';

/** How long an admin's "1회" (one thread) environment-skill grant lasts. */
export const THREAD_GRANT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface SkillGrants {
  /** Requester uids allowed to use ANY of the owner's skills. */
  allowAll: string[];
  /** skillName → requester uids allowed to use that specific skill. */
  perSkill: Record<string, string[]>;
  /**
   * Environment-skill owner only (env-access WU4, #1212): environment id (`env:<name>`) → requester uids
   * allowed every skill and every server-tools tool of that environment ("this environment, always").
   */
  perEnvironment?: Record<string, string[]>;
}

function emptyGrants(): SkillGrants {
  return { allowAll: [], perSkill: {} };
}

/** `env:` and a lower-case name (`env-users.ts`); anything else is never a key in the grant file. */
const ENVIRONMENT_ID = /^env:[a-z0-9][a-z0-9-]{0,62}$/;

function grantsFile(ownerId: string): string {
  if (ownerId === ENV_SKILL_GRANT_OWNER) return path.join(DATA_DIR, 'env-skill-grants.json');
  if (!isSafePathSegment(ownerId)) {
    throw new Error(`Invalid ownerId for skill grants: ${ownerId}`);
  }
  return path.join(DATA_DIR, ownerId, 'skill-grants.json');
}

/** Load an owner's persisted grants (missing / malformed → empty). */
export function loadGrants(ownerId: string): SkillGrants {
  if (!isSafePathSegment(ownerId)) return emptyGrants();
  let file: string;
  try {
    file = grantsFile(ownerId);
  } catch {
    return emptyGrants();
  }
  if (!fs.existsSync(file)) return emptyGrants();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SkillGrants>;
    return {
      allowAll: Array.isArray(parsed.allowAll) ? parsed.allowAll : [],
      perSkill: parsed.perSkill && typeof parsed.perSkill === 'object' ? parsed.perSkill : {},
      ...(parsed.perEnvironment && typeof parsed.perEnvironment === 'object'
        ? { perEnvironment: parsed.perEnvironment }
        : {}),
    };
  } catch {
    return emptyGrants();
  }
}

function saveGrants(ownerId: string, grants: SkillGrants): void {
  atomicWriteJson(grantsFile(ownerId), grants);
}

// --- one-time grants (in-memory, single-use) ---

/** key = owner\0skill\0requester → expiresAt (epoch ms). */
const oneTimeGrants = new Map<string, number>();

function oneTimeKey(ownerId: string, skillName: string, requesterId: string): string {
  return `${ownerId}\u0000${skillName}\u0000${requesterId}`;
}

/**
 * Arm a single-use grant for (owner, skill, requester). Honored by exactly one
 * `consumeOneTimeGrant` before `expiresAt`. `isSkillUseAllowed` observes it
 * WITHOUT consuming.
 */
export function addOneTimeGrant(ownerId: string, skillName: string, requesterId: string, expiresAt?: number): void {
  oneTimeGrants.set(oneTimeKey(ownerId, skillName, requesterId), expiresAt ?? Date.now() + ONE_TIME_TTL_MS);
}

/** Non-mutating: is there a live one-time grant for this triple? */
export function hasOneTimeGrant(ownerId: string, skillName: string, requesterId: string): boolean {
  const exp = oneTimeGrants.get(oneTimeKey(ownerId, skillName, requesterId));
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    oneTimeGrants.delete(oneTimeKey(ownerId, skillName, requesterId));
    return false;
  }
  return true;
}

/**
 * Consume a one-time grant. Returns true iff a live grant existed and was
 * removed. Call ONLY on the successful fulfillment path so a halted turn never
 * burns the grant.
 */
export function consumeOneTimeGrant(ownerId: string, skillName: string, requesterId: string): boolean {
  const key = oneTimeKey(ownerId, skillName, requesterId);
  const exp = oneTimeGrants.get(key);
  if (exp === undefined) return false;
  oneTimeGrants.delete(key);
  return exp > Date.now();
}

// --- thread grants (in-memory, reusable within one thread until expiry) ---

/** key = owner\0skill\0requester\0channel\0thread → expiresAt (epoch ms). */
const threadGrants = new Map<string, number>();

/**
 * Index of `threadGrants` by plugin: key = owner\0plugin\0requester\0channel\0thread → the
 * `threadGrants` keys of that plugin's skills (`plugin:skill`) there. Answers "any live grant of this
 * plugin in this thread" without a scan; entries are dropped lazily, on lookup, once their grant is
 * gone from `threadGrants` or expired.
 */
const threadGrantsByPlugin = new Map<string, Set<string>>();

/** Where a thread grant applies: one Slack thread. */
export interface GrantScope {
  channel: string;
  threadTs?: string;
}

function threadKey(ownerId: string, skillName: string, requesterId: string, scope: GrantScope): string {
  return [ownerId, skillName, requesterId, scope.channel, scope.threadTs ?? ''].join('\u0000');
}

function pluginThreadKey(ownerId: string, pluginName: string, requesterId: string, scope: GrantScope): string {
  return [ownerId, pluginName, requesterId, scope.channel, scope.threadTs ?? ''].join('\u0000');
}

/** The plugin of a `plugin:skill` key, or null for a name without one. */
function pluginOfSkillKey(skillName: string): string | null {
  const colon = skillName.indexOf(':');
  return colon > 0 ? skillName.slice(0, colon) : null;
}

/**
 * Arm a thread grant: (owner, skill, requester) may use the skill in `scope`'s
 * thread, any number of times, until `expiresAt`. Lost on restart, like the
 * one-time grants — the requester then asks again.
 */
export function addThreadGrant(
  ownerId: string,
  skillName: string,
  requesterId: string,
  scope: GrantScope,
  expiresAt?: number,
): void {
  const key = threadKey(ownerId, skillName, requesterId, scope);
  threadGrants.set(key, expiresAt ?? Date.now() + THREAD_GRANT_TTL_MS);
  const plugin = pluginOfSkillKey(skillName);
  if (plugin !== null) {
    const indexKey = pluginThreadKey(ownerId, plugin, requesterId, scope);
    const keys = threadGrantsByPlugin.get(indexKey) ?? new Set<string>();
    keys.add(key);
    threadGrantsByPlugin.set(indexKey, keys);
  }
}

/**
 * Non-mutating apart from dropping expired entries: is there a live thread grant of any skill of
 * `pluginName` (`pluginName:*`) for (owner, requester) in `scope`'s thread?
 */
export function hasThreadGrantForPlugin(
  ownerId: string,
  pluginName: string,
  requesterId: string,
  scope: GrantScope,
): boolean {
  const indexKey = pluginThreadKey(ownerId, pluginName, requesterId, scope);
  const keys = threadGrantsByPlugin.get(indexKey);
  if (keys === undefined) return false;
  const now = Date.now();
  for (const key of keys) {
    const exp = threadGrants.get(key);
    if (exp !== undefined && exp > now) return true;
    if (exp !== undefined) threadGrants.delete(key);
    keys.delete(key);
  }
  threadGrantsByPlugin.delete(indexKey);
  return false;
}

/** The skill keys (`plugin:skill`) of `pluginName` with a live thread grant for (owner, requester) in `scope`. */
export function liveThreadGrantSkills(
  ownerId: string,
  pluginName: string,
  requesterId: string,
  scope: GrantScope,
): string[] {
  const keys = threadGrantsByPlugin.get(pluginThreadKey(ownerId, pluginName, requesterId, scope));
  if (keys === undefined) return [];
  const now = Date.now();
  const skills: string[] = [];
  const prefix = `${[ownerId].join('\u0000')}\u0000`;
  for (const key of keys) {
    const exp = threadGrants.get(key);
    if (exp === undefined || exp <= now) continue;
    // key = owner\0skill\0requester\0channel\0thread
    const skill = key.slice(prefix.length).split('\u0000')[0];
    if (skill) skills.push(skill);
  }
  return skills;
}

/** Non-mutating apart from dropping an expired entry: is there a live thread grant? */
export function hasThreadGrant(ownerId: string, skillName: string, requesterId: string, scope: GrantScope): boolean {
  const key = threadKey(ownerId, skillName, requesterId, scope);
  const exp = threadGrants.get(key);
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    threadGrants.delete(key);
    return false;
  }
  return true;
}

// --- permission check + persisted grants ---

/**
 * NON-MUTATING permission check. True iff:
 *   - requester is the owner (own skills), OR
 *   - owner granted requester all-skills, OR
 *   - owner granted requester this specific skill, OR
 *   - a live one-time grant exists (observed, NOT consumed).
 */
export function isSkillUseAllowed(ownerId: string, skillName: string, requesterId: string): boolean {
  if (ownerId === requesterId) return true;
  const grants = loadGrants(ownerId);
  if (grants.allowAll.includes(requesterId)) return true;
  if (grants.perSkill[skillName]?.includes(requesterId)) return true;
  return hasOneTimeGrant(ownerId, skillName, requesterId);
}

/** Persist a per-skill grant (idempotent). */
export function grantSkill(ownerId: string, skillName: string, requesterId: string): void {
  if (!isSafePathSegment(ownerId)) return;
  const grants = loadGrants(ownerId);
  const list = grants.perSkill[skillName] ?? (grants.perSkill[skillName] = []);
  if (!list.includes(requesterId)) list.push(requesterId);
  saveGrants(ownerId, grants);
  logger.info('Granted per-skill use', { ownerId, skillName, requesterId });
}

/** Persist an all-skills grant (idempotent). */
export function grantAllSkills(ownerId: string, requesterId: string): void {
  if (!isSafePathSegment(ownerId)) return;
  const grants = loadGrants(ownerId);
  if (!grants.allowAll.includes(requesterId)) grants.allowAll.push(requesterId);
  saveGrants(ownerId, grants);
  logger.info('Granted all-skills use', { ownerId, requesterId });
}

/**
 * Take back a per-skill grant (idempotent). An emptied skill entry is dropped so the file
 * does not collect dead keys. Returns whether a grant was removed; nothing removed → no write.
 */
export function revokeSkill(ownerId: string, skillName: string, requesterId: string): boolean {
  if (!isSafePathSegment(ownerId)) return false;
  const grants = loadGrants(ownerId);
  const list = grants.perSkill[skillName];
  if (!Array.isArray(list) || !list.includes(requesterId)) return false;
  const rest = list.filter((id) => id !== requesterId);
  if (rest.length) grants.perSkill[skillName] = rest;
  else delete grants.perSkill[skillName];
  saveGrants(ownerId, grants);
  logger.info('Revoked per-skill use', { ownerId, skillName, requesterId });
  return true;
}

/**
 * Take back an all-skills grant (idempotent). Per-skill grants of the same requester stay —
 * they were given one by one and are taken back one by one.
 */
export function revokeAllSkills(ownerId: string, requesterId: string): boolean {
  if (!isSafePathSegment(ownerId)) return false;
  const grants = loadGrants(ownerId);
  if (!grants.allowAll.includes(requesterId)) return false;
  grants.allowAll = grants.allowAll.filter((id) => id !== requesterId);
  saveGrants(ownerId, grants);
  logger.info('Revoked all-skills use', { ownerId, requesterId });
  return true;
}

// --- environment grants (env-access WU4, #1212) ---

function environmentRequesters(grants: SkillGrants, environmentId: string): string[] {
  if (!ENVIRONMENT_ID.test(environmentId) || !grants.perEnvironment) return [];
  if (!Object.prototype.hasOwnProperty.call(grants.perEnvironment, environmentId)) return [];
  const list = grants.perEnvironment[environmentId];
  return Array.isArray(list) ? list : [];
}

/** Who holds the whole environment `environmentId` (the settings page lists them). */
export function environmentGrantees(environmentId: string): string[] {
  return [...environmentRequesters(loadGrants(ENV_SKILL_GRANT_OWNER), environmentId)];
}

/** Has an admin granted the requester the whole environment `environmentId`? */
export function hasEnvironmentGrant(environmentId: string, requesterId: string): boolean {
  return environmentRequesters(loadGrants(ENV_SKILL_GRANT_OWNER), environmentId).includes(requesterId);
}

/** Persist "this environment, always" for the requester (idempotent). */
export function grantEnvironment(environmentId: string, requesterId: string): void {
  if (!ENVIRONMENT_ID.test(environmentId)) throw new Error(`Invalid environment id: ${environmentId}`);
  const grants = loadGrants(ENV_SKILL_GRANT_OWNER);
  const perEnvironment = grants.perEnvironment ?? {};
  const list = environmentRequesters(grants, environmentId);
  if (list.includes(requesterId)) return;
  perEnvironment[environmentId] = [...list, requesterId];
  saveGrants(ENV_SKILL_GRANT_OWNER, { ...grants, perEnvironment });
  logger.info('Granted environment use', { environmentId, requesterId });
}

/** Take back an environment grant (idempotent). Returns whether one was removed. */
export function revokeEnvironment(environmentId: string, requesterId: string): boolean {
  const grants = loadGrants(ENV_SKILL_GRANT_OWNER);
  const list = environmentRequesters(grants, environmentId);
  if (!list.includes(requesterId) || !grants.perEnvironment) return false;
  const rest = list.filter((id) => id !== requesterId);
  if (rest.length) grants.perEnvironment[environmentId] = rest;
  else delete grants.perEnvironment[environmentId];
  saveGrants(ENV_SKILL_GRANT_OWNER, grants);
  logger.info('Revoked environment use', { environmentId, requesterId });
  return true;
}

/**
 * NON-MUTATING environment-skill check (`skillKey` = `plugin:skill`). True iff an
 * admin granted the requester all environment skills, this skill, this skill
 * in `scope`'s thread, or the whole environment `environmentId` the skill belongs to.
 * Admins are not checked here — the policy exempts them.
 */
export function isEnvSkillUseAllowed(
  skillKey: string,
  requesterId: string,
  scope?: GrantScope,
  environmentId?: string,
): boolean {
  const grants = loadGrants(ENV_SKILL_GRANT_OWNER);
  if (grants.allowAll.includes(requesterId)) return true;
  if (grants.perSkill[skillKey]?.includes(requesterId)) return true;
  if (environmentId !== undefined && environmentRequesters(grants, environmentId).includes(requesterId)) return true;
  return scope !== undefined && hasThreadGrant(ENV_SKILL_GRANT_OWNER, skillKey, requesterId, scope);
}

/**
 * NON-MUTATING: may the requester use the server-tools tools of `environment` (its servers) — directly or from
 * one of its skills? True iff an admin granted the whole environment, all environment skills, or one of its
 * skills — always, or in `scope`'s thread. `owns` says which `plugin:skill` keys are this environment's (a
 * `plugin:*` entry must not count a skill another environment lists by name). A skill's grant opens its environment's tools in the same scope: the
 * skill runs on them. Admins are not checked here — the policy exempts them.
 */
export function isEnvironmentToolUseAllowed(
  environment: { id: string; skills: readonly string[] },
  requesterId: string,
  scope?: GrantScope,
  owns: (skillKey: string) => boolean = () => true,
): boolean {
  const grants = loadGrants(ENV_SKILL_GRANT_OWNER);
  if (grants.allowAll.includes(requesterId)) return true;
  if (environmentRequesters(grants, environment.id).includes(requesterId)) return true;
  for (const pattern of environment.skills) {
    if (pattern.endsWith(':*')) {
      // Only skills this environment owns: another environment may list one of the plugin's skills by name.
      const plugin = pattern.slice(0, -2);
      const prefix = `${plugin}:`;
      for (const [key, requesters] of Object.entries(grants.perSkill)) {
        if (key.startsWith(prefix) && owns(key) && Array.isArray(requesters) && requesters.includes(requesterId)) {
          return true;
        }
      }
      if (scope !== undefined) {
        if (liveThreadGrantSkills(ENV_SKILL_GRANT_OWNER, plugin, requesterId, scope).some(owns)) return true;
      }
    } else {
      // A skill another environment also claims belongs to neither.
      if (!owns(pattern)) continue;
      if (grants.perSkill[pattern]?.includes(requesterId)) return true;
      if (scope !== undefined && hasThreadGrant(ENV_SKILL_GRANT_OWNER, pattern, requesterId, scope)) return true;
    }
  }
  return false;
}

/**
 * NON-MUTATING environment-plugin check: may the requester use the environment plugin `pluginName`
 * as a whole — its MCP tools (policy step 6d)? True iff an admin granted the requester all
 * environment skills, any skill of this plugin (a `pluginName:` key), any skill of this plugin in
 * `scope`'s thread, or one of `environmentIds` (the environments whose skills come from this plugin)
 * whole: the plugin's tools run on the approval of any of its skills. Admins are not
 * checked here — the policy exempts them.
 */
export function isEnvPluginUseAllowed(
  pluginName: string,
  requesterId: string,
  scope?: GrantScope,
  environmentIds: readonly string[] = [],
): boolean {
  if (!pluginName) return false;
  const grants = loadGrants(ENV_SKILL_GRANT_OWNER);
  if (grants.allowAll.includes(requesterId)) return true;
  // An environment granted whole whose skills come from this plugin (env-access WU4).
  if (environmentIds.some((id) => environmentRequesters(grants, id).includes(requesterId))) return true;
  const prefix = `${pluginName}:`;
  for (const [skillKey, requesters] of Object.entries(grants.perSkill)) {
    if (skillKey.startsWith(prefix) && Array.isArray(requesters) && requesters.includes(requesterId)) return true;
  }
  return scope !== undefined && hasThreadGrantForPlugin(ENV_SKILL_GRANT_OWNER, pluginName, requesterId, scope);
}

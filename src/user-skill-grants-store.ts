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
 * one deploy calls the same environment skill several times.
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
}

function emptyGrants(): SkillGrants {
  return { allowAll: [], perSkill: {} };
}

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

/** Where a thread grant applies: one Slack thread. */
export interface GrantScope {
  channel: string;
  threadTs?: string;
}

function threadKey(ownerId: string, skillName: string, requesterId: string, scope: GrantScope): string {
  return [ownerId, skillName, requesterId, scope.channel, scope.threadTs ?? ''].join('\u0000');
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
  threadGrants.set(threadKey(ownerId, skillName, requesterId, scope), expiresAt ?? Date.now() + THREAD_GRANT_TTL_MS);
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
 * NON-MUTATING environment-skill check (`skillKey` = `plugin:skill`). True iff an
 * admin granted the requester all environment skills, this skill, or this skill
 * in `scope`'s thread. Admins are not checked here — the policy exempts them.
 */
export function isEnvSkillUseAllowed(skillKey: string, requesterId: string, scope?: GrantScope): boolean {
  const grants = loadGrants(ENV_SKILL_GRANT_OWNER);
  if (grants.allowAll.includes(requesterId)) return true;
  if (grants.perSkill[skillKey]?.includes(requesterId)) return true;
  return scope !== undefined && hasThreadGrant(ENV_SKILL_GRANT_OWNER, skillKey, requesterId, scope);
}

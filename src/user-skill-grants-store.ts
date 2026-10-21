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
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import { isSafePathSegment } from './path-utils';

const logger = new Logger('UserSkillGrantsStore');

/** Default TTL for a one-time grant — long enough to cover a re-dispatch. */
const ONE_TIME_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
  const file = grantsFile(ownerId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(grants, null, 2), 'utf-8');
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

/**
 * Session lifecycle policy — the three durations that decide when a session
 * sleeps, when it ends, and how long the dashboard keeps listing it after.
 *
 *   active ──(idle sleepAfterMs)──► SLEEPING ──(asleep archiveAfterMs)──► archived (ended)
 *   archived cards stay in the dashboard's DONE column for boardArchiveWindowMs
 *
 * Admins change it from the dashboard (PUT /api/dashboard/lifecycle). The value
 * lives in `<DATA_DIR>/session-lifecycle.json`, so each instance has its own.
 * Every reader calls getSessionLifecyclePolicy() at use time — a change takes
 * effect on the next sweep / board build without a restart.
 *
 * Missing file = defaults. An unreadable live file is different: the saved
 * values are unknown, and both the defaults and the `.bak` (the previous save)
 * may be far shorter than what an admin chose (a 90-day archive time falling
 * back to 7 days would end sessions in bulk). That state is `degraded`: the
 * registry skips the sleep / archive transitions until an admin saves again.
 */

import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('SessionLifecyclePolicy');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SessionLifecyclePolicy {
  /** Idle time after which an active session goes to SLEEPING. */
  sleepAfterMs: number;
  /** Time a SLEEPING session is kept before it is archived (ended). */
  archiveAfterMs: number;
  /** How long an archived session stays listed in the dashboard's DONE column. 0 = never listed. */
  boardArchiveWindowMs: number;
}

export type SessionLifecycleField = keyof SessionLifecyclePolicy;

export const DEFAULT_SESSION_LIFECYCLE_POLICY: Readonly<SessionLifecyclePolicy> = Object.freeze({
  sleepAfterMs: 24 * HOUR_MS,
  archiveAfterMs: 7 * DAY_MS,
  boardArchiveWindowMs: 48 * HOUR_MS,
});

/** Inclusive bounds per field, in ms. */
export const SESSION_LIFECYCLE_BOUNDS: Readonly<Record<SessionLifecycleField, { min: number; max: number }>> =
  Object.freeze({
    sleepAfterMs: { min: HOUR_MS, max: 30 * DAY_MS },
    archiveAfterMs: { min: HOUR_MS, max: 365 * DAY_MS },
    boardArchiveWindowMs: { min: 0, max: 365 * DAY_MS },
  });

const FIELDS = Object.keys(DEFAULT_SESSION_LIFECYCLE_POLICY) as SessionLifecycleField[];

/** A rejected policy update. `field` is the offending key, or null for a malformed body. */
export class SessionLifecyclePolicyError extends Error {
  constructor(
    message: string,
    readonly field: SessionLifecycleField | null,
  ) {
    super(message);
    this.name = 'SessionLifecyclePolicyError';
  }
}

function checkField(field: SessionLifecycleField, value: unknown): number {
  const { min, max } = SESSION_LIFECYCLE_BOUNDS[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SessionLifecyclePolicyError(`${field} must be an integer between ${min} and ${max} ms`, field);
  }
  return value;
}

/**
 * Validate an update body: a plain object carrying at least one known field.
 * Unknown keys are refused so a typo cannot pass as a no-op save.
 */
export function parseSessionLifecyclePatch(raw: unknown): Partial<SessionLifecyclePolicy> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SessionLifecyclePolicyError('body must be a JSON object', null);
  }
  const patch: Partial<SessionLifecyclePolicy> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(FIELDS as string[]).includes(key)) {
      throw new SessionLifecyclePolicyError(`unknown field: ${key}`, null);
    }
    patch[key as SessionLifecycleField] = checkField(key as SessionLifecycleField, value);
  }
  if (Object.keys(patch).length === 0) {
    throw new SessionLifecyclePolicyError('no field to update', null);
  }
  return patch;
}

/** A stored file must carry every field, in bounds. */
function validateStored(raw: unknown): SessionLifecyclePolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  const obj = raw as Record<string, unknown>;
  const out = {} as SessionLifecyclePolicy;
  for (const field of FIELDS) out[field] = checkField(field, obj[field]);
  return out;
}

let _filePath: string | null = null;
let _cached: { policy: SessionLifecyclePolicy; degraded: boolean } | null = null;

function filePath(): string {
  return _filePath ?? path.join(DATA_DIR, 'session-lifecycle.json');
}

function load(): { policy: SessionLifecyclePolicy; degraded: boolean } {
  // readJsonWithBackup warns exactly when it serves the .bak. That generation is
  // the PREVIOUS save — possibly shorter than the unreadable live one — so it is
  // shown, but transitions stay paused until an admin saves again.
  let servedBackup = false;
  try {
    const stored = readJsonWithBackup(filePath(), validateStored, {
      warn: (message, detail) => {
        servedBackup = true;
        logger.warn(message, detail);
      },
    });
    if (servedBackup) {
      logger.error(
        'Session lifecycle policy served from .bak — sleep/archive transitions are paused until an admin saves',
      );
    }
    return { policy: stored ?? { ...DEFAULT_SESSION_LIFECYCLE_POLICY }, degraded: servedBackup };
  } catch (error) {
    logger.error(
      'Session lifecycle policy file and its .bak are unusable — sleep/archive transitions are paused until an admin saves a policy',
      error,
    );
    return { policy: { ...DEFAULT_SESSION_LIFECYCLE_POLICY }, degraded: true };
  }
}

function current(): { policy: SessionLifecyclePolicy; degraded: boolean } {
  if (!_cached) _cached = load();
  return _cached;
}

/** The current policy (a copy — callers cannot mutate the cache). Defaults while degraded. */
export function getSessionLifecyclePolicy(): SessionLifecyclePolicy {
  return { ...current().policy };
}

/**
 * True when a saved policy exists but cannot be read (live file and `.bak`).
 * The registry pauses sleep / archive transitions in that state.
 */
export function isSessionLifecyclePolicyDegraded(): boolean {
  return current().degraded;
}

/** The policy an update body would produce, without saving it. Throws on a bad body. */
export function previewSessionLifecyclePolicy(raw: unknown): SessionLifecyclePolicy {
  return { ...getSessionLifecyclePolicy(), ...parseSessionLifecyclePatch(raw) };
}

/**
 * Apply a validated update and persist it. Throws SessionLifecyclePolicyError
 * on a bad body; the stored policy is unchanged in that case. A successful save
 * ends a degraded state.
 */
export function updateSessionLifecyclePolicy(raw: unknown): SessionLifecyclePolicy {
  const next = previewSessionLifecyclePolicy(raw);
  atomicWriteJson(filePath(), next, {
    validatePrevious: (prev) => {
      try {
        validateStored(prev);
        return true;
      } catch {
        return false;
      }
    },
    warn: (message, detail) => logger.warn(message, detail),
  });
  _cached = { policy: next, degraded: false };
  return { ...next };
}

/** What a sweep looks at in a session. */
export interface LifecycleSessionView {
  state?: string;
  activityState?: string;
  lastActivity: Date | string;
  sleepStartedAt?: Date | string;
}

function ms(v: Date | string | undefined): number {
  if (v === undefined) return Number.NaN;
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

/**
 * Sessions the next sweep would move ONLY because the policy changed from
 * `from` to `to`: newly past the idle limit (→ SLEEPING) or newly past the
 * sleep time (→ archived, which ends the session and removes its work dirs).
 * Sessions already past the current thresholds move on the next sweep anyway
 * and are not counted.
 */
export function countLifecycleTransitions(
  sessions: Iterable<LifecycleSessionView>,
  from: SessionLifecyclePolicy,
  to: SessionLifecyclePolicy,
  now: number,
): { willSleep: number; willArchive: number } {
  let willSleep = 0;
  let willArchive = 0;
  for (const s of sessions) {
    if (s.activityState === 'working') continue; // the sweep never sleeps a running turn
    if (s.state === 'SLEEPING') {
      const started = ms(s.sleepStartedAt);
      const age = Number.isFinite(started) ? now - started : Number.POSITIVE_INFINITY;
      if (age >= to.archiveAfterMs && age < from.archiveAfterMs) willArchive++;
    } else {
      const idle = now - ms(s.lastActivity);
      if (idle >= to.sleepAfterMs && idle < from.sleepAfterMs) willSleep++;
    }
  }
  return { willSleep, willArchive };
}

/** Test seam: point the store at a scratch file and drop the cache. */
export function __resetSessionLifecyclePolicyForTests(file?: string): void {
  _filePath = file ?? null;
  _cached = null;
}

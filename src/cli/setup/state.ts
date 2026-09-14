/**
 * Setup-state persistence for `somawork setup`.
 *
 * The state file records *where the wizard is*, never *what it learned in
 * confidence*: per the plan's global constraints no credential may enter the
 * setup-state JSON. `assertSecretFree` enforces that mechanically on every
 * save so a future step cannot quietly start parking a token here.
 *
 * All writes go through `@soma/common/atomic-write` (`rules/config.md` §3).
 */

import { atomicWriteJson, CorruptStateError, loadJsonWithBackup } from '@soma/common/atomic-write';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isProfileName, type ProfileName } from '../profile';

/** Bump when the on-disk shape changes incompatibly. */
export const SETUP_STATE_SCHEMA_VERSION = 1;
/** File name inside the profile's state directory. */
export const SETUP_STATE_FILENAME = 'setup-state.json';

const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

/** Receipt proving a setup step completed, used to resume without redoing work. */
export interface CompletedStepReceipt {
  step: string;
  completedAt: string;
}

/**
 * Resumable wizard state. Deliberately has no token/code/ticket field — runtime
 * credentials live in `secrets.env` (see `./secrets`), never here.
 */
export interface SetupState {
  schemaVersion: number;
  profile: ProfileName;
  currentStep: string | null;
  slackAppId: string | null;
  slackTeamId: string | null;
  completedSteps: CompletedStepReceipt[];
  lastError: string | null;
}

/** Field-name fragments that indicate a credential. Matched per tokenized word. */
const SECRET_KEY_WORDS = new Set([
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'cert',
  'code',
  'codes',
  'cookie',
  'credential',
  'credentials',
  'key',
  'keys',
  'passphrase',
  'oauth',
  'passwd',
  'password',
  'pem',
  'privatekey',
  'pwd',
  'secret',
  'secrets',
  'signature',
  'ticket',
  'tickets',
  'token',
  'tokens',
]);

/**
 * Value shapes that are credentials no matter which field carries them.
 *
 * Anchored on a word boundary rather than `^`: `lastError` is the only
 * free-text field in {@link SetupState} and is exactly where an API error body
 * lands, so a `^`-anchored scan would miss `"invalid_auth token=xoxb-…"` — the
 * whole remaining leak surface once {@link validateSetupState} has rejected
 * unknown keys. `\b` keeps the prefixes from matching mid-identifier (so
 * `risk-analysis` is not read as an `sk-` key), and each pattern still requires
 * a credential-length body so ordinary prose cannot trip it.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bxox[abeprs]-[A-Za-z0-9-]{3,}/i, // Slack bot/user/app-level/legacy tokens
  /\bxapp-[A-Za-z0-9-]{3,}/i, // Slack app-level token
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/i, // Anthropic API/OAuth credentials
  /\bsk-[A-Za-z0-9]{20,}/, // OpenAI-style API keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const MAX_SCAN_DEPTH = 32;

/**
 * Substring probes for the highest-value words, applied to the key with all
 * separators stripped. This is what catches names the tokenizer cannot split —
 * all-caps runs (`OAUTHTOKEN`) and digit-glued forms (`accessToken2`). Kept
 * deliberately short: broader words like `key` or `code` stay tokenizer-only so
 * `monkeyPatch` / `decoded` are not swept up.
 */
const SECRET_KEY_SUBSTRINGS = ['token', 'secret', 'password', 'passphrase', 'credential', 'apikey', 'oauth'];

/** Split `slackAppId` / `client_secret` / `SLACK_BOT_TOKEN` into lowercase words. */
function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

function keyLooksSecret(key: string): boolean {
  const squashed = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SECRET_KEY_SUBSTRINGS.some((word) => squashed.includes(word))) return true;
  return tokenizeKey(key).some((word) => SECRET_KEY_WORDS.has(word));
}

function valueLooksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Raised when a credential-shaped key or value is found in setup state. */
export class SecretInStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretInStateError';
  }
}

/**
 * Throw if `value` contains a credential-shaped field name or a
 * credential-shaped string anywhere in its object/array graph.
 */
export function assertSecretFree(value: unknown, label = '$'): void {
  scanSecretFree(value, label, 0, new WeakSet<object>());
}

function scanSecretFree(value: unknown, label: string, depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_SCAN_DEPTH) {
    throw new SecretInStateError(
      `Setup state at ${label} nests deeper than ${MAX_SCAN_DEPTH}; refusing to persist it.`,
    );
  }

  if (typeof value === 'string') {
    if (valueLooksSecret(value)) {
      throw new SecretInStateError(
        `Setup state at ${label} holds a credential-shaped value; secrets belong in secrets.env.`,
      );
    }
    return;
  }

  if (value === null || typeof value !== 'object') return;

  if (seen.has(value as object)) return;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      scanSecretFree(item, `${label}[${index}]`, depth + 1, seen);
    }
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keyLooksSecret(key)) {
      throw new SecretInStateError(
        `Setup state at ${label}.${key} is a credential field; secrets belong in secrets.env.`,
      );
    }
    scanSecretFree(child, `${label}.${key}`, depth + 1, seen);
  }
}

/** Raised when the on-disk state does not match {@link SetupState}. */
export class SetupStateSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupStateSchemaError';
  }
}

const SETUP_STATE_KEYS: readonly string[] = [
  'schemaVersion',
  'profile',
  'currentStep',
  'slackAppId',
  'slackTeamId',
  'completedSteps',
  'lastError',
];

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new SetupStateSchemaError(`Setup state field "${field}" must be a string or null.`);
}

function parseCompletedSteps(value: unknown): CompletedStepReceipt[] {
  if (!Array.isArray(value)) {
    throw new SetupStateSchemaError('Setup state field "completedSteps" must be an array.');
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SetupStateSchemaError(`Setup state completedSteps[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'step' && key !== 'completedAt') {
        throw new SetupStateSchemaError(`Setup state completedSteps[${index}] has unknown field "${key}".`);
      }
    }
    if (typeof record.step !== 'string' || typeof record.completedAt !== 'string') {
      throw new SetupStateSchemaError(`Setup state completedSteps[${index}] needs string "step" and "completedAt".`);
    }
    return { step: record.step, completedAt: record.completedAt };
  });
}

/**
 * Validate an unknown value as {@link SetupState}, rejecting unknown fields,
 * wrong schema versions, and anything credential-shaped.
 */
export function validateSetupState(value: unknown): SetupState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SetupStateSchemaError('Setup state must be a JSON object.');
  }

  assertSecretFree(value, 'setupState');

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SETUP_STATE_KEYS.includes(key)) {
      throw new SetupStateSchemaError(`Setup state has unknown field "${key}".`);
    }
  }

  if (record.schemaVersion !== SETUP_STATE_SCHEMA_VERSION) {
    throw new SetupStateSchemaError(
      `Setup state schemaVersion ${String(record.schemaVersion)} is unsupported (expected ${SETUP_STATE_SCHEMA_VERSION}).`,
    );
  }

  if (typeof record.profile !== 'string' || !isProfileName(record.profile)) {
    throw new SetupStateSchemaError(`Setup state field "profile" must be a valid profile name.`);
  }

  return {
    schemaVersion: SETUP_STATE_SCHEMA_VERSION,
    profile: record.profile,
    currentStep: requireNullableString(record.currentStep, 'currentStep'),
    slackAppId: requireNullableString(record.slackAppId, 'slackAppId'),
    slackTeamId: requireNullableString(record.slackTeamId, 'slackTeamId'),
    completedSteps: parseCompletedSteps(record.completedSteps),
    lastError: requireNullableString(record.lastError, 'lastError'),
  };
}

/** A fresh, empty state for `profile`. */
export function createDefaultSetupState(profile: ProfileName): SetupState {
  return {
    schemaVersion: SETUP_STATE_SCHEMA_VERSION,
    profile,
    currentStep: null,
    slackAppId: null,
    slackTeamId: null,
    completedSteps: [],
    lastError: null,
  };
}

export interface SetupStateStoreOptions {
  profile: ProfileName;
  /** Profile-scoped state directory, e.g. `profilePaths(home, profile).stateDir`. */
  stateDir: string;
}

/** Atomic, backup-protected reader/writer for a profile's setup state. */
export class SetupStateStore {
  private readonly profile: ProfileName;
  private readonly stateFile: string;

  constructor(options: SetupStateStoreOptions) {
    this.profile = options.profile;
    this.stateFile = path.join(options.stateDir, SETUP_STATE_FILENAME);
  }

  /** Absolute path of the live state file. */
  get filePath(): string {
    return this.stateFile;
  }

  /**
   * Load the persisted state, recovering from `<file>.bak` when the live file
   * was truncated by an interrupted write. `null` means nothing saved yet.
   */
  load(): SetupState | null {
    return loadJsonWithBackup(this.stateFile, validateSetupState);
  }

  /** Validate and atomically persist `state` (previous contents kept as `.bak`). */
  save(state: SetupState): void {
    const validated = validateSetupState(state);
    atomicWriteJson(this.stateFile, validated, {
      mode: STATE_FILE_MODE,
      dirMode: STATE_DIR_MODE,
      backup: true,
    });
  }

  /**
   * Move an unloadable live state file and its backup out of the load path.
   *
   * Called only after {@link load} has already refused both documents (see
   * {@link isRecoverableSetupStateError}). The state file is **advisory** —
   * every setup step re-validates the machine live — so an unparseable one must
   * cost a re-check, not the ability to run setup at all. Deleting it would
   * also destroy the only evidence of *how* it broke, so it is renamed instead.
   *
   * The new name is content-addressed: `<file>.corrupt-<sha256 prefix>`.
   * Deterministic, so a rerun against the same bytes reuses the same slot
   * rather than growing a new file per attempt, and non-overwriting, because
   * two different documents cannot collide on a name. If the slot already
   * holds those exact bytes, the source is simply unlinked — nothing is lost.
   *
   * `rename` does not follow symlinks and preserves the 0600 mode. Returns the
   * absolute paths it created, in load order, for the caller's one info line.
   */
  quarantine(): string[] {
    const moved: string[] = [];
    for (const source of [this.stateFile, `${this.stateFile}.bak`]) {
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(source);
      } catch {
        // Absent (the common case for `.bak`) or unreadable; either way there
        // is nothing here to take out of the load path.
        continue;
      }
      const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const destination = `${source}.corrupt-${digest}`;
      try {
        if (fs.existsSync(destination)) {
          // Same bytes already preserved under this name; drop the duplicate.
          fs.rmSync(source, { force: true });
        } else {
          fs.renameSync(source, destination);
        }
        moved.push(destination);
      } catch {
        // Best-effort: a state directory we cannot rename inside is a problem
        // the next write will report with a better message than this one could.
      }
    }
    return moved;
  }

  /** Read-modify-write; the mutator sees a default state when nothing is saved. */
  update(mutator: (current: SetupState) => SetupState): SetupState {
    const current = this.load() ?? createDefaultSetupState(this.profile);
    const next = mutator(current);
    this.save(next);
    return next;
  }
}

/**
 * Is `error` the "this state document is unusable" family, as opposed to an
 * I/O or programmer error?
 *
 * The three named classes are the complete set a *load* can produce from a
 * document's own contents: unparseable JSON or a failed validator on both the
 * live file and its backup ({@link CorruptStateError}), a shape or schema
 * version this build does not speak ({@link SetupStateSchemaError}), and a
 * document carrying credential-shaped bytes ({@link SecretInStateError}). Each
 * is recoverable by starting over, because the state file is advisory.
 *
 * Everything else — `EACCES`, an `UnsafePathError` from a symlinked state file,
 * a `TypeError` — is deliberately excluded: those are not "the document is
 * bad", they are "this machine or this code is not in a state where continuing
 * is safe", and swallowing them would turn a security refusal into a silent
 * reset.
 */
export function isRecoverableSetupStateError(error: unknown): boolean {
  return (
    error instanceof CorruptStateError || error instanceof SetupStateSchemaError || error instanceof SecretInStateError
  );
}

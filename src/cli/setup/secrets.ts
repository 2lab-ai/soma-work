/**
 * Runtime secret persistence for `somawork setup`.
 *
 * Credentials never enter setup-state JSON, argv, URLs, or stdout (plan global
 * constraints). They land in a profile-scoped `secrets.env` written 0600 inside
 * a 0700 directory, in plain `KEY=VALUE` bytes so the runtime can source it as
 * an env file without a JSON parse step.
 *
 * The key allowlist is strict: an unknown key is a bug or an injection attempt,
 * not something to persist "just in case".
 */

import { assertNotSymlink, atomicWriteFile } from '@soma/common/atomic-write';
import * as fs from 'fs';

/** Every secret the somawork runtime is allowed to receive from setup. */
export const SECRET_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];
export type SecretValues = Partial<Record<SecretKey, string>>;

const SECRETS_FILE_MODE = 0o600;
const SECRETS_DIR_MODE = 0o700;

/** Raised when a key outside {@link SECRET_KEYS} or an unwritable value is offered. */
export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

export interface SecretStoreOptions {
  /** Absolute path to the profile's `secrets.env`, e.g. `profilePaths(...).secretsFile`. */
  secretsFile: string;
}

/** Atomic reader/writer for a profile's `secrets.env`. */
export class SecretStore {
  private readonly secretsFile: string;

  constructor(options: SecretStoreOptions) {
    this.secretsFile = options.secretsFile;
  }

  /** Absolute path of the live secrets file. */
  get filePath(): string {
    return this.secretsFile;
  }

  /** Read allowlisted secrets. Returns `{}` when nothing has been written yet. */
  read(): SecretValues {
    assertNotSymlink(this.secretsFile);

    let raw: string;
    try {
      raw = fs.readFileSync(this.secretsFile, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }

    const values: SecretValues = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

      const separator = trimmed.indexOf('=');
      if (separator <= 0) {
        console.warn(`[setup/secrets] WARN skipping malformed line in "${this.secretsFile}".`);
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      if (!isSecretKey(key)) {
        // Never echo the value; the key name alone is enough to act on.
        console.warn(`[setup/secrets] WARN ignoring non-allowlisted key "${key}" in "${this.secretsFile}".`);
        continue;
      }
      values[key] = trimmed.slice(separator + 1);
    }
    return values;
  }

  /**
   * Merge `values` into the existing secrets and rewrite the file atomically at
   * 0600, keeping the previous contents as `<file>.bak`.
   */
  write(values: SecretValues): void {
    const incoming = Object.entries(values as Record<string, unknown>);

    for (const [key, value] of incoming) {
      if (!isSecretKey(key)) {
        throw new SecretKeyError(`Refusing to store "${key}": not in the somawork secret allowlist.`);
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new SecretKeyError(`Refusing to store "${key}": value must be a non-empty string.`);
      }
      if (/[\n\r\0]/.test(value)) {
        throw new SecretKeyError(`Refusing to store "${key}": value contains a newline or NUL byte.`);
      }
    }

    const merged: SecretValues = { ...this.read() };
    for (const [key, value] of incoming) {
      merged[key as SecretKey] = value as string;
    }

    const body = SECRET_KEYS.filter((key) => merged[key] !== undefined)
      .map((key) => `${key}=${merged[key] as string}\n`)
      .join('');

    atomicWriteFile(this.secretsFile, body, {
      mode: SECRETS_FILE_MODE,
      dirMode: SECRETS_DIR_MODE,
      backup: true,
    });
  }
}

/**
 * Secret references — configuration names a secret, the secret store holds its value
 * (`.prd/25-env-access-architecture.md` §2).
 *
 * A reference is an object with exactly one key, `{"$secret": "<name>"}`. It resolves to the
 * content of `<secrets dir>/<name>`. The secret store is read by the bot process and its MCP
 * servers only; every model sandbox read-denies it. Resolution fails closed: a bad name, a missing
 * store or a missing, empty or out-of-store file is an error — never an empty string — and the
 * error names the secret, never its value.
 *
 * Pure apart from the file reads: no work at module load, so MCP servers can import it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One safe path segment: no separators, no leading dot, no `..`. */
const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class SecretRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretRefError';
  }
}

export interface SecretRef {
  $secret: string;
}

export function isSecretRef(value: unknown): value is SecretRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === '$secret' && typeof (value as SecretRef).$secret === 'string';
}

/**
 * The value of secret `name` in `secretsDir`, with one trailing newline dropped (an editor's or
 * `echo`'s). Throws {@link SecretRefError} instead of returning anything doubtful.
 */
export function readSecret(name: string, secretsDir: string | undefined): string {
  if (!SECRET_NAME_RE.test(name) || name.includes('..')) {
    // Not echoed: an operator may have pasted the value where the name goes.
    throw new SecretRefError(`invalid secret name (${name.length} characters)`);
  }
  if (!secretsDir) {
    throw new SecretRefError(`secret "${name}": no secret store is configured`);
  }
  let root: string;
  let file: string;
  try {
    root = fs.realpathSync(secretsDir);
    file = fs.realpathSync(path.join(secretsDir, name));
  } catch {
    throw new SecretRefError(`secret "${name}": not found in the secret store`);
  }
  // A link inside the store must not point outside it.
  if (path.dirname(file) !== root) {
    throw new SecretRefError(`secret "${name}": resolves outside the secret store`);
  }
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new SecretRefError(`secret "${name}": unreadable`);
  }
  const value = content.endsWith('\r\n')
    ? content.slice(0, -2)
    : content.endsWith('\n')
      ? content.slice(0, -1)
      : content;
  if (value.length === 0) {
    throw new SecretRefError(`secret "${name}": empty`);
  }
  return value;
}

/**
 * A deep copy of `value` with every {@link SecretRef} replaced by its secret. A value without
 * references needs no store. Throws on the first reference that does not resolve.
 */
export function resolveSecretRefs<T>(value: T, secretsDir: string | undefined): T {
  return resolve(value, secretsDir) as T;
}

function resolve(value: unknown, secretsDir: string | undefined): unknown {
  if (isSecretRef(value)) return readSecret(value.$secret, secretsDir);
  if (Array.isArray(value)) return value.map((item) => resolve(item, secretsDir));
  if (value !== null && typeof value === 'object') {
    // A `$secret` key in any other shape is a reference written wrong — never pass it through as data.
    if (Object.hasOwn(value, '$secret')) throw new SecretRefError('malformed secret reference');
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolve(item, secretsDir);
    return out;
  }
  return value;
}

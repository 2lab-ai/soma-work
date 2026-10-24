import type { SessionCronJob } from '../types';

/**
 * A `cronJob` stamp (SSOT 2026-10-23) read from untrusted storage — persisted
 * sessions, archives, sibling boards — or undefined when absent or malformed.
 */
export function sanitizeCronJob(raw: unknown): SessionCronJob | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { id, name } = raw as { id?: unknown; name?: unknown };
  if (typeof name !== 'string' || !name.trim()) return undefined;
  return typeof id === 'string' && id ? { id, name } : { name };
}

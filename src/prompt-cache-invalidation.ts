/**
 * Shared hook plumbing for SSOT mutators that need to invalidate cached
 * `session.systemPrompt` snapshots.
 *
 * Why this file exists: user-memory-store and user-settings-store both live
 * outside the stream-executor reset points, so the rebuild gate in
 * `claude-handler.ts` never fires for their writes. Each one needs a way to
 * signal "my data changed — please drop cached prompts owned by this user"
 * without importing SessionRegistry (cycle risk via claude-handler). The
 * runtime wiring is set once at startup in `index.ts` and pointed at
 * `SessionRegistry.invalidateSystemPromptForUser`.
 *
 * Swallow-and-log: a broken hook must never abort a successful write — the
 * prompt cache will self-heal on the next reset point even if invalidation
 * is missed. Errors are logged at debug only (routine).
 */

import type { Logger } from './logger';

export type InvalidationHook = (userId: string) => void;

export interface PromptInvalidator {
  setHook(hook: InvalidationHook | undefined): void;
  fire(userId: string): void;
}

export function createPromptInvalidator(logger: Logger, context: string): PromptInvalidator {
  let hook: InvalidationHook | undefined;
  return {
    setHook(next) {
      hook = next;
    },
    fire(userId) {
      try {
        hook?.(userId);
      } catch (err) {
        logger.debug(`${context} prompt invalidation hook failed`, { userId, err });
      }
    },
  };
}

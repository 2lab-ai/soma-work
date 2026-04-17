/**
 * SLASH_FORBIDDEN — topics/verbs that require a thread context and therefore
 * cannot run via the `/z` slash command (Slack slash commands have no thread).
 *
 * DM and channel-mention entry points ARE allowed for these commands.
 *
 * See: plan/MASTER-SPEC.md §5-4.
 *
 * Key format: `topic` OR `topic:verb` OR `topic:verb:arg` (all lowercase).
 */

export const SLASH_FORBIDDEN: ReadonlySet<string> = new Set<string>([
  'new',
  'close',
  'renew',
  'context',
  'restore',
  'link',
  'compact',
  'session:set:model',
  'session:set:verbosity',
  'session:set:effort',
  'session:set:thinking',
  'session:set:thinking_summary',
  // Phase 0 of #525 — slash path sets `threadTs = channel_id` placeholder,
  // which is incompatible with `chat.startStream({ thread_ts })`. Forced to
  // DM-only naked trigger.
  'ui-test',
]);

/**
 * Returns true if the given (topic, verb, arg) tuple is forbidden on the slash
 * entry point. Always compares on the normalized `topic[:verb[:arg]]` key.
 *
 * - `isSlashForbidden('new')` → true
 * - `isSlashForbidden('session', 'set', 'model')` → true
 * - `isSlashForbidden('session', 'set', 'persona')` → false
 */
export function isSlashForbidden(topic: string, verb?: string, arg?: string): boolean {
  if (!topic) return false;
  const parts = [topic, verb, arg].filter((p): p is string => !!p).map((p) => p.toLowerCase());
  // topic-only check (always)
  if (SLASH_FORBIDDEN.has(parts[0])) return true;
  if (parts.length >= 2 && SLASH_FORBIDDEN.has(parts.slice(0, 2).join(':'))) return true;
  if (parts.length >= 3 && SLASH_FORBIDDEN.has(parts.slice(0, 3).join(':'))) return true;
  return false;
}

/** Localized rejection message for forbidden slash capability. */
export const SLASH_FORBIDDEN_MESSAGE =
  '이 명령은 스레드 컨텍스트가 필요해서 slash `/z`로 실행할 수 없습니다. ' +
  '스레드에서 `@bot /z <topic>` 형식으로 실행해주세요.';

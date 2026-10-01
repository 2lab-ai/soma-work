/**
 * Keep a turn open while the background agents it launched still run (#257).
 *
 * A `run_in_background` agent outlives the turn that launched it: the turn
 * answers its prompt ("I'll wait for the agent") and the agent reports back
 * later, as a `task_notification` that makes the SAME CLI process run a turn
 * of its own. Measured with SDK 0.3.284: that only happens while the host's
 * input stays open. A host that closes the input on the answering result ends
 * the CLI, the agent dies with it, and the next turn's fresh process reports it
 * `stopped`. So `ClaudeHandler` holds the answering result while an agent is
 * live, and ends the turn on the result that follows the agent's report.
 *
 * The liveness signal is `system`/`background_tasks_changed` (sdk.d.ts:3690):
 * a level frame carrying the FULL live set, with REPLACE semantics. It is per
 * process and nothing is emitted at startup, so a turn starts from the empty
 * set. The `task_started` / `task_notification` edge frames are deliberately
 * not paired against it — a missed bookend would wedge a stale set.
 *
 * Pure and duck-typed on the raw frame, like `turn-result-attribution.ts`. It
 * reads no env: the cap's knob (`SOMA_BG_KEEPALIVE_MAX_MS`) is read once, by
 * `getBgKeepaliveMaxMs` in `src/config.ts` (`rules/config.md`), which parses
 * it with {@link parseBgKeepaliveMaxMs}.
 */

/**
 * Default keepalive cap: 30 minutes. Well under the Slack consumer's own
 * per-frame stall timeout (2 h, `SOMA_STREAM_STALL_TIMEOUT_MS`), so the
 * handler's cap — which stops the agents and still ends the turn with an
 * answer — always fires first.
 */
export const DEFAULT_BG_KEEPALIVE_MAX_MS = 1_800_000;

/**
 * Largest delay `setTimeout` honours. A longer one overflows and fires after
 * 1 ms (Node `TimeoutOverflowWarning`), which would turn a "very long" cap into
 * an instant one.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The only task type that holds a turn open. */
const AGENT_TASK_TYPE = 'local_agent';

/**
 * The ids of the live background AGENTS a `system`/`background_tasks_changed`
 * frame announces; `undefined` for any other frame.
 *
 * Only `local_agent` tasks that are not `ambient` count. Shells
 * (`local_bash`), workflows, MCP tasks and monitors can be long-lived by
 * design, and an ambient task is by definition not activity (sdk.d.ts:3703) —
 * none of them may hold a turn open.
 *
 * A level frame whose `tasks` is not an array carries no information, so it
 * also answers `undefined`: the caller keeps the set it has rather than
 * reading "nothing is live" into a malformed frame (which would end the turn
 * and kill the agents this exists to keep).
 */
export function liveAgentIds(frame: Record<string, unknown>): string[] | undefined {
  if (frame.type !== 'system' || frame.subtype !== 'background_tasks_changed') return undefined;
  if (!Array.isArray(frame.tasks)) return undefined;
  const ids: string[] = [];
  for (const task of frame.tasks) {
    if (!task || typeof task !== 'object') continue;
    const { task_id: taskId, task_type: taskType, ambient } = task as Record<string, unknown>;
    if (taskType !== AGENT_TASK_TYPE || ambient === true) continue;
    if (typeof taskId === 'string' && taskId.length > 0) ids.push(taskId);
  }
  return ids;
}

/** A parsed keepalive cap; `invalid` → the raw value was ignored for the default. */
export interface BgKeepaliveMaxMsParse {
  value: number;
  invalid: boolean;
}

/**
 * Parse a raw `SOMA_BG_KEEPALIVE_MAX_MS` value. Operator contract:
 *  - unset, empty or whitespace → {@link DEFAULT_BG_KEEPALIVE_MAX_MS}
 *  - non-numeric, negative, or above the largest delay `setTimeout` honours →
 *    {@link DEFAULT_BG_KEEPALIVE_MAX_MS}, `invalid`
 *  - `0` → `0` = keepalive disabled (a turn ends on its answering result)
 *  - positive → that many ms (floored, at least 1)
 */
export function parseBgKeepaliveMaxMs(raw: string | undefined): BgKeepaliveMaxMsParse {
  const trimmed = raw?.trim();
  // `Number('')` is 0: an empty (or whitespace-only) value must not read as "disabled".
  if (trimmed === undefined || trimmed === '') return { value: DEFAULT_BG_KEEPALIVE_MAX_MS, invalid: false };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_TIMER_DELAY_MS) {
    return { value: DEFAULT_BG_KEEPALIVE_MAX_MS, invalid: true };
  }
  if (parsed === 0) return { value: 0, invalid: false };
  return { value: Math.max(1, Math.floor(parsed)), invalid: false };
}

/**
 * Output visibility flags (bitfield) for controlling Slack message verbosity.
 *
 * Each flag represents a category of Slack output. Log levels are
 * defined as combinations (bitwise OR) of these flags.
 */

// ── Individual output flags ──────────────────────────────────────────

export const OutputFlag = {
  /** Final assistant text response */
  FINAL_RESULT: 1 << 0,
  /** LLM extended thinking / reasoning output */
  THINKING: 1 << 1,
  /** Tool call notification — name only (e.g. "📝 Edit file.ts") */
  TOOL_CALL: 1 << 2,
  /** Tool call detail — args, diff, command, MCP inputs */
  TOOL_DETAIL: 1 << 3,
  /** Tool execution result */
  TOOL_RESULT: 1 << 4,
  /** MCP / subagent progress status messages */
  MCP_PROGRESS: 1 << 5,
  /** Status text messages (Thinking / Working / Completed) */
  STATUS_MESSAGE: 1 << 6,
  /** Emoji reactions (thinking_face, gear, check_mark) */
  STATUS_REACTION: 1 << 7,
  /** Native Slack assistant spinner */
  STATUS_SPINNER: 1 << 8,
  /** User choice / form prompts (ALWAYS shown) */
  USER_CHOICE: 1 << 9,
  /** Permission approval prompts (ALWAYS shown) */
  PERMISSION: 1 << 10,
  /** Action panel updates */
  ACTION_PANEL: 1 << 11,
  /** Thread header (title, workflow badge) */
  THREAD_HEADER: 1 << 12,
  /** Session footer (timing, context, usage) */
  SESSION_FOOTER: 1 << 13,
  /** Context window emoji (80p, 60p, …) */
  CONTEXT_EMOJI: 1 << 14,
  /** Todo list create / update */
  TODO_UPDATE: 1 << 15,
  /** Todo progress reactions */
  TODO_REACTION: 1 << 16,
  /** Error messages and error status */
  ERROR: 1 << 17,
  /** System / command responses, onboarding */
  SYSTEM: 1 << 18,
  /** Raw model response data (debug) */
  RAW_DATA: 1 << 19,
  /** Skill invocation announcement */
  SKILL_INVOCATION: 1 << 20,
  /**
   * Mid-turn model narration — assistant text segments streamed while the turn
   * runs. Without it only the turn's final answer reaches Slack; the narration
   * still goes to the dashboard work log (`StreamContext.workLog`).
   */
  NARRATION: 1 << 21,
} as const;

export type OutputFlagValue = (typeof OutputFlag)[keyof typeof OutputFlag];

// ── Preset log-level names ───────────────────────────────────────────

export type LogVerbosity = 'minimal' | 'compact' | 'detail' | 'verbose';

/** Flags that are ALWAYS active regardless of log level */
const ALWAYS = OutputFlag.USER_CHOICE | OutputFlag.PERMISSION | OutputFlag.ERROR;

/**
 * MINIMAL — task list + final answer + essential interactions, nothing else
 * (spec 10 §3.2-2). Narration, MCP/subagent/background progress and skill
 * banners go to the dashboard work log instead.
 */
export const LOG_MINIMAL = ALWAYS | OutputFlag.FINAL_RESULT | OutputFlag.TODO_UPDATE | OutputFlag.TODO_REACTION;

/** COMPACT — narration + long-running status + thinking + tool names (no detail) + status/meta */
const LOG_COMPACT =
  LOG_MINIMAL |
  OutputFlag.NARRATION |
  OutputFlag.MCP_PROGRESS |
  OutputFlag.SKILL_INVOCATION |
  OutputFlag.THINKING |
  OutputFlag.TOOL_CALL |
  OutputFlag.STATUS_MESSAGE |
  OutputFlag.STATUS_REACTION |
  OutputFlag.STATUS_SPINNER |
  OutputFlag.ACTION_PANEL |
  OutputFlag.THREAD_HEADER |
  OutputFlag.SESSION_FOOTER |
  OutputFlag.CONTEXT_EMOJI;

/** DETAIL — full output (current default behaviour) */
export const LOG_DETAIL = LOG_COMPACT | OutputFlag.TOOL_DETAIL | OutputFlag.TOOL_RESULT | OutputFlag.SYSTEM;

/** VERBOSE — everything including raw data */
const LOG_VERBOSE = LOG_DETAIL | OutputFlag.RAW_DATA;

// ── Lookup helpers ───────────────────────────────────────────────────

const VERBOSITY_MAP: Record<LogVerbosity, number> = {
  minimal: LOG_MINIMAL,
  compact: LOG_COMPACT,
  detail: LOG_DETAIL,
  verbose: LOG_VERBOSE,
};

export const DEFAULT_LOG_VERBOSITY: LogVerbosity = 'minimal';

/** Resolve a verbosity name to its flag mask */
export function getVerbosityFlags(level: LogVerbosity): number {
  return VERBOSITY_MAP[level];
}

/**
 * Version of the mask encoding, persisted next to every stored mask
 * (sessions.json `logVerbosityVersion`). 2 = masks that carry `NARRATION`.
 * A stored mask WITHOUT it predates this release and is the only kind
 * {@link upgradeLegacyVerbosityMask} may rewrite — a current custom mask that
 * happens to equal an old preset number is left alone.
 */
export const LOG_VERBOSITY_MASK_VERSION = 2;

/**
 * The preset masks as stored before `NARRATION` (bit 21) existed — the values
 * of `getVerbosityFlags()` at main e992de7c, pinned in
 * `__tests__/output-flags.minimal.test.ts`. Kept only to upgrade masks that
 * were persisted then (sessions.json); never produced any more.
 */
const LEGACY_PRESET_MASKS: ReadonlyMap<number, LogVerbosity> = new Map<number, LogVerbosity>([
  [LOG_MINIMAL | OutputFlag.MCP_PROGRESS | OutputFlag.SKILL_INVOCATION, 'minimal'],
  [LOG_COMPACT & ~OutputFlag.NARRATION, 'compact'],
  [LOG_DETAIL & ~OutputFlag.NARRATION, 'detail'],
  [LOG_VERBOSE & ~OutputFlag.NARRATION, 'verbose'],
]);

/**
 * Map a persisted mask that equals a pre-`NARRATION` preset to the current
 * preset of the same name; anything else (current presets, custom masks,
 * `undefined`) passes through. Without it a restored thread at an old
 * compact/detail/verbose mask would silently lose its narration and show a
 * `custom` chip. Callers apply it only to masks stored without
 * {@link LOG_VERBOSITY_MASK_VERSION}.
 */
export function upgradeLegacyVerbosityMask(mask: number | undefined): number | undefined {
  if (mask === undefined) return undefined;
  const level = LEGACY_PRESET_MASKS.get(mask);
  return level ? VERBOSITY_MAP[level] : mask;
}

/** Check whether a given output flag is enabled for the active verbosity mask */
export function shouldOutput(flag: number, verbosityMask: number): boolean {
  return (verbosityMask & flag) !== 0;
}

/** All valid verbosity names (for command parsing) */
export const VERBOSITY_NAMES = Object.keys(VERBOSITY_MAP) as LogVerbosity[];

/** Reverse-resolve a verbosity bitmask to its level name (falls back to 'custom') */
export function getVerbosityName(mask: number): LogVerbosity | 'custom' {
  for (const [name, flags] of Object.entries(VERBOSITY_MAP)) {
    if (flags === mask) return name as LogVerbosity;
  }
  return 'custom';
}

// ── Render mode (per-category verbosity dispatch) ───────────────────

/** How a category should be rendered at a given verbosity level */
export type RenderMode = 'hidden' | 'compact' | 'detail' | 'verbose';

/** Resolve the render mode for tool call output */
export function getToolCallRenderMode(mask: number): RenderMode {
  if (!shouldOutput(OutputFlag.TOOL_CALL, mask)) return 'hidden';
  if (shouldOutput(OutputFlag.RAW_DATA, mask)) return 'verbose';
  if (shouldOutput(OutputFlag.TOOL_DETAIL, mask)) return 'detail';
  return 'compact';
}

/** Resolve the render mode for tool result output */
export function getToolResultRenderMode(mask: number): RenderMode {
  if (!shouldOutput(OutputFlag.TOOL_CALL, mask)) return 'hidden';
  if (shouldOutput(OutputFlag.RAW_DATA, mask)) return 'verbose';
  if (shouldOutput(OutputFlag.TOOL_RESULT, mask)) return 'detail';
  return 'compact'; // compact = no separate result, update tool call in-place
}

/** Resolve the render mode for thinking output */
export function getThinkingRenderMode(mask: number): RenderMode {
  if (!shouldOutput(OutputFlag.THINKING, mask)) return 'hidden';
  if (shouldOutput(OutputFlag.RAW_DATA, mask)) return 'verbose';
  if (shouldOutput(OutputFlag.TOOL_DETAIL, mask)) return 'detail';
  return 'compact';
}

// ── Verbose tagging (debug annotations) ─────────────────────────────

/** Reverse map: flag value → name */
const FLAG_NAME_MAP: Record<number, string> = Object.fromEntries(
  Object.entries(OutputFlag).map(([name, value]) => [value, name]),
);

/** Ordered levels for determining minimum level that includes a flag */
const LEVELS_ASC: { name: string; mask: number }[] = [
  { name: 'always', mask: ALWAYS },
  { name: 'minimal', mask: LOG_MINIMAL },
  { name: 'compact', mask: LOG_COMPACT },
  { name: 'detail', mask: LOG_DETAIL },
  { name: 'verbose', mask: LOG_VERBOSE },
];

/** Get the human-readable name of an OutputFlag value */
function getOutputFlagName(flag: number): string {
  return FLAG_NAME_MAP[flag] ?? `FLAG_${flag}`;
}

/** Get the minimum verbosity level that includes the given flag */
function getMinVerbosityLevel(flag: number): string {
  for (const { name, mask } of LEVELS_ASC) {
    if ((mask & flag) !== 0) return name;
  }
  return 'verbose';
}

/**
 * Returns a `[CATEGORY @level]` prefix when verbose mode is active.
 * Returns empty string otherwise. Use to annotate Slack messages
 * so users can see which flag/level controls each output.
 */
export function verboseTag(flag: number, verbosityMask: number): string {
  if (!shouldOutput(OutputFlag.RAW_DATA, verbosityMask)) return '';
  const name = getOutputFlagName(flag);
  const level = getMinVerbosityLevel(flag);
  return `\`[${name} @${level}]\` `;
}

/**
 * Auxiliary (side-call) model choice — the one place an aux call picks its model.
 *
 * An aux call is a model call soma-work makes on its own behalf around the
 * work: titles, summaries, the instructions summary, memory dreaming / improve,
 * the dispatch classifier, cron `fast`, the goal-eval fallback. It names a TIER
 * — `haiku` (cheap, fast) or `sonnet` (mid) — and the model comes from the MAIN
 * model's provider, the same rule llmux applies to Claude Code's own harness
 * requests (`.prd/27-claude-code-harness-requests.md` there):
 *
 *   tier   | main is Claude (or unknown) | main is Codex / GPT | main is Grok
 *   haiku  | alias `haiku`               | alias `luna`        | alias `grok`, effort low
 *   sonnet | alias `sonnet`              | alias `terra`       | alias `grok`, effort medium
 *
 * Aliases resolve at CALL time through the soma-work alias table
 * (`userSettingsStore.resolveModelInput` → `MODEL_ALIASES` → llmux catalog
 * overlay), so a model update — an edit of that table — moves every aux call
 * with no code change. An alias that does not resolve is passed bare (llmux
 * resolves it). The static table has no bare `grok` alias: when neither it nor
 * the llmux catalog resolves `grok`, the newest grok on the allow-list is used.
 *
 * MAIN model: the session's model when the call is made for a session, else the
 * user's default model, else `DEFAULT_MODEL`. An operator env override
 * (`SUMMARY_MODEL`, `DEFAULT_DISPATCH_MODEL`, …) wins as-is; the caller reads it
 * through config and passes it in — this module reads no env.
 */

import { providerGroupOf } from '../conversation/new-task';
import { AVAILABLE_MODELS, DEFAULT_MODEL, type EffortLevel, userSettingsStore } from '../user-settings-store';

/** `haiku` = cheap / fast, `sonnet` = mid. */
export type AuxTier = 'haiku' | 'sonnet';

/** The provider family of a main model. Anything unrecognised counts as `claude`. */
export type AuxProvider = 'claude' | 'codex' | 'grok';

/** The alias (and, for grok, the reasoning effort) each provider runs each tier on. */
const AUX_ROUTES: Record<AuxProvider, Record<AuxTier, { alias: string; effort?: EffortLevel }>> = {
  claude: { haiku: { alias: 'haiku' }, sonnet: { alias: 'sonnet' } },
  codex: { haiku: { alias: 'luna' }, sonnet: { alias: 'terra' } },
  grok: { haiku: { alias: 'grok', effort: 'low' }, sonnet: { alias: 'grok', effort: 'medium' } },
};

export interface AuxModelInput {
  /** The session's model, when the call is made for a session. */
  mainModel?: string;
  /** The user the call is made for: their default model is the main model when there is no session model. */
  userId?: string;
  /** Operator env override (e.g. `SUMMARY_MODEL`). When set it wins as-is: no alias resolution, no effort. */
  override?: string;
}

export interface AuxModel {
  model: string;
  /** Reasoning effort the tier asks for (grok only); absent = the call path's own default. */
  effort?: EffortLevel;
}

/** The provider family of `model` (an id or an alias such as `sol`). */
export function auxProviderOf(model: string): AuxProvider {
  const group = providerGroupOf(userSettingsStore.resolveModelInput(model) ?? model);
  return group === 'codex' || group === 'grok' ? group : 'claude';
}

/** The newest grok id on the allow-list (numeric order: 4.10 > 4.7) — adding a grok there moves it. */
function newestGrokModel(): string | undefined {
  return AVAILABLE_MODELS.filter((id) => /^grok-\d/.test(id)).sort((a, b) =>
    b.localeCompare(a, 'en', { numeric: true }),
  )[0];
}

/** Resolve a tier alias NOW through the alias table; unresolved → the bare alias (grok: newest allow-listed grok). */
function resolveTierAlias(alias: string): string {
  const resolved = userSettingsStore.resolveModelInput(alias);
  if (resolved) return resolved;
  if (alias === 'grok') return newestGrokModel() ?? alias;
  return alias;
}

/** The model (and grok effort) an aux call of `tier` runs on. */
export function auxModelFor(tier: AuxTier, input: AuxModelInput = {}): AuxModel {
  if (input.override) return { model: input.override };
  const main =
    input.mainModel?.trim() ||
    (input.userId ? userSettingsStore.getUserDefaultModel(input.userId) : '') ||
    DEFAULT_MODEL;
  const route = AUX_ROUTES[auxProviderOf(main)][tier];
  const model = resolveTierAlias(route.alias);
  return route.effort ? { model, effort: route.effort } : { model };
}

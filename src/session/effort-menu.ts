/**
 * The effort levels a model runs — one rule for every place that sets a model
 * and an effort together (the session's model menu, the new task, the default
 * model and effort): the levels this app can set (`EFFORT_LEVELS`) that the
 * llmux catalog lists for the model, in level order.
 *
 * A model the catalog does not know has no menu here (`undefined`); a setter
 * then accepts the SDK levels (`allowedEffortsFor`) — never `ultra`, which only
 * a model whose menu lists it runs.
 */

import { EFFORT_LEVELS, type EffortLevel, SDK_EFFORT_LEVELS } from 'soma-lib';
import { modelCatalog } from '../model-catalog';

/** The catalog's levels for a model ∩ the levels this app sets, in level order; undefined without a menu. */
export function effortMenuOf(catalogEfforts: readonly string[] | null | undefined): EffortLevel[] | undefined {
  if (!catalogEfforts || catalogEfforts.length === 0) return undefined;
  const menu = new Set(catalogEfforts.map((e) => String(e).toLowerCase()));
  const levels = EFFORT_LEVELS.filter((level) => menu.has(level));
  return levels.length > 0 ? levels : undefined;
}

/** The levels `model` runs (see the module comment); undefined when the catalog has no menu for it. */
export function effortMenuFor(model: string | undefined): EffortLevel[] | undefined {
  return model ? effortMenuOf(modelCatalog.getEffortsFor(model)) : undefined;
}

/**
 * The levels a setter accepts for `model`: its menu, or — without one — the
 * SDK levels (`ultra` is only for a model whose menu lists it).
 */
export function allowedEffortsFor(model: string | undefined): readonly EffortLevel[] {
  return effortMenuFor(model) ?? SDK_EFFORT_LEVELS;
}

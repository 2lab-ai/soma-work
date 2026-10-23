/**
 * Production wiring of the personal settings registry (SSOT 2026-10-23 T2):
 * the real store, the `/z` card apply functions, and the validators the Slack
 * commands use. `src/index.ts` hands the result to the settings routes.
 */

import { DEFAULT_LOG_VERBOSITY, VERBOSITY_NAMES } from '@soma/slack/output-flags';
import * as path from 'path';
import { isAdminUser } from './admin-utils';
import { config } from './config';
import { getAvailablePersonas } from './prompt-builder';
import { productionModelCatalogDeps } from './session/model-catalog-deps';
import { listRepresentativeModels } from './session/model-switch';
import { autoskillExists, listAvailableSkills } from './skill-locator';
import { applyBypass } from './slack/z/topics/bypass-topic';
import { applyEmail } from './slack/z/topics/email-topic';
import { applyModel } from './slack/z/topics/model-topic';
import { applyNotify } from './slack/z/topics/notify-topic';
import { applyPersona } from './slack/z/topics/persona-topic';
import { applySandbox } from './slack/z/topics/sandbox-topic';
import { applyTheme } from './slack/z/topics/theme-topic';
import { applyVerbosity } from './slack/z/topics/verbosity-topic';
import { DEFAULT_GOAL_MAX_CONTINUATIONS } from './types';
import { createSettingsRegistry, type SettingsRegistry } from './user-settings-registry';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  GOAL_MAX_CONTINUATIONS_MAX,
  GOAL_MAX_CONTINUATIONS_MIN,
  MAX_AUTOSKILLS,
  THEME_NAMES,
  userSettingsStore,
  validateGoalMaxContinuations,
} from './user-settings-store';
import { validateWebhookUrl } from './webhook-url-validator';

export function productionSettingsRegistry(): SettingsRegistry {
  return createSettingsRegistry({
    store: userSettingsStore,
    apply: {
      model: applyModel,
      persona: applyPersona,
      theme: applyTheme,
      verbosity: applyVerbosity,
      permissionMode: applyBypass,
      sandbox: applySandbox,
      notify: applyNotify,
      email: applyEmail,
    },
    effortLevels: EFFORT_LEVELS,
    verbosityLevels: VERBOSITY_NAMES,
    themes: THEME_NAMES,
    defaults: {
      model: DEFAULT_MODEL,
      effort: DEFAULT_EFFORT,
      verbosity: DEFAULT_LOG_VERBOSITY,
      theme: 'default',
      goalMaxContinuations: DEFAULT_GOAL_MAX_CONTINUATIONS,
    },
    goalMaxBounds: { min: GOAL_MAX_CONTINUATIONS_MIN, max: GOAL_MAX_CONTINUATIONS_MAX },
    maxAutoskills: MAX_AUTOSKILLS,
    validateGoalMax: validateGoalMaxContinuations,
    listPersonas: getAvailablePersonas,
    listModels: (userId) =>
      listRepresentativeModels(productionModelCatalogDeps(), userId).map((m) => ({
        nickname: m.nickname,
        model: m.model,
        label: m.label,
      })),
    listSkills: (userId) => listAvailableSkills(userId).map((s) => ({ name: s.name, source: s.source })),
    skillExists: autoskillExists,
    validateWebhookUrl,
    // The same fixed path WorkingDirectoryManager resolves (no mkdir on read).
    workingDirectoryFor: (userId) => (config.baseDirectory ? path.join(config.baseDirectory, userId) : undefined),
    isAdmin: isAdminUser,
  });
}

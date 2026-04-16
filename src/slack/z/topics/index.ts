/**
 * `/z` topic registry wiring — Phase 2 (#507).
 *
 * Single entry point that instantiates every `ZTopicBinding` produced by
 * the per-topic modules and registers them into a `ZTopicRegistry`.
 *
 * Intentionally side-effect free — callers control registry lifetime and
 * test isolation. The bootstrap (`src/slack/actions/index.ts`) calls
 * `registerAllTopics()` once per process.
 */

import { ZTopicRegistry } from '../../actions/z-settings-actions';
import { createBypassTopicBinding } from './bypass-topic';
import { createCctTopicBinding } from './cct-topic';
import { createCwdTopicBinding } from './cwd-topic';
import { createEmailTopicBinding } from './email-topic';
import { createMemoryTopicBinding } from './memory-topic';
import { createModelTopicBinding } from './model-topic';
import { createNotifyTopicBinding } from './notify-topic';
import { createPersonaTopicBinding } from './persona-topic';
import { createSandboxTopicBinding } from './sandbox-topic';
import { createThemeTopicBinding } from './theme-topic';
import { createVerbosityTopicBinding } from './verbosity-topic';

/**
 * Register all 11 Phase 2 topic bindings into the given registry.
 *
 * Order is alphabetical (by topic id) and does not affect behaviour —
 * `ZTopicRegistry` stores one binding per topic name.
 */
export function registerAllTopics(registry: ZTopicRegistry): void {
  registry.register(createBypassTopicBinding());
  registry.register(createCctTopicBinding());
  registry.register(createCwdTopicBinding());
  registry.register(createEmailTopicBinding());
  registry.register(createMemoryTopicBinding());
  registry.register(createModelTopicBinding());
  registry.register(createNotifyTopicBinding());
  registry.register(createPersonaTopicBinding());
  registry.register(createSandboxTopicBinding());
  registry.register(createThemeTopicBinding());
  registry.register(createVerbosityTopicBinding());
}

/** Convenience: build + populate a registry in one call. */
export function buildDefaultTopicRegistry(): ZTopicRegistry {
  const registry = new ZTopicRegistry();
  registerAllTopics(registry);
  return registry;
}

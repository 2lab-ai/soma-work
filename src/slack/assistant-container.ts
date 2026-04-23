/**
 * Bolt Assistant container factory — #666 P4 Part 1/2.
 *
 * Registers an `Assistant` middleware with Bolt so the Slack client surfaces
 * the native Assistant sidebar (features.assistant_view) and routes
 * `assistant_thread_started` / `assistant_thread_context_changed` /
 * `message.im`-within-assistant-thread events through Bolt's Assistant
 * middleware chain.
 *
 * Scope boundary (see docs/slack-ui-phase4.md):
 *   - Part 1 (this file): threadStarted presents 4 placeholder prompts;
 *     userMessage delegates to the existing DM `handleMessage` so assistant
 *     threads behave identically to a regular DM. Native `setStatus` spinner
 *     activation lives in Part 2 behind `SOMA_UI_B4_NATIVE_STATUS=1` and
 *     turn-surface wiring.
 *   - threadContextChanged is intentionally omitted so Bolt's default
 *     context store handles `assistant_thread_context_changed` automatically.
 *     (Bolt v4.7.0 — see Assistant.ts#L23-L28.)
 */
import { Assistant, type AssistantConfig } from '@slack/bolt';
import type { Logger } from '../logger';
import type { MessageEvent } from './pipeline';

/**
 * Placeholder prompts surfaced in the assistant sidebar on
 * `assistant_thread_started`. Intentionally generic — this PR does NOT own
 * prompt content design (see #666 "Out of Scope: setSuggestedPrompts 컨텐츠
 * 디자인"). Max 4 prompts (Slack API cap).
 */
export const SUGGESTED_PROMPTS_PLACEHOLDER: ReadonlyArray<{ title: string; message: string }> = [
  { title: 'Help me with a task', message: 'I need help with…' },
  { title: 'Explain a concept', message: 'Please explain…' },
  { title: 'Debug an error', message: 'I got this error:' },
  { title: 'Review my code', message: 'Please review this code:' },
];

/**
 * Title shown above the suggested prompts in the Assistant sidebar.
 * Keep in sync with `slack-app-manifest.json#features.assistant_view.assistant_description`.
 */
export const ASSISTANT_VIEW_TITLE = 'What can I help with?';

export interface AssistantContainerDeps {
  logger: Logger;
  /**
   * The handler the existing DM pipeline uses
   * (`SlackHandler.handleMessage`). We delegate `userMessage` straight into
   * it so an assistant-thread message behaves identically to a regular DM
   * until Part 2 wires up PHASE>=4 spinner integration.
   */
  handleMessage: (event: MessageEvent, say: any) => Promise<void>;
}

/**
 * Build the raw `AssistantConfig` used by the Bolt `Assistant` constructor.
 * Exported as a separate factory so tests can exercise `threadStarted` /
 * `userMessage` directly without having to mock the `Assistant` constructor.
 */
export function buildAssistantConfig(deps: AssistantContainerDeps): AssistantConfig {
  return {
    threadStarted: async ({ setSuggestedPrompts }) => {
      try {
        await setSuggestedPrompts({
          prompts: [...SUGGESTED_PROMPTS_PLACEHOLDER],
          title: ASSISTANT_VIEW_TITLE,
        });
      } catch (err) {
        deps.logger.warn('setSuggestedPrompts failed', {
          error: (err as Error).message,
          hint: 'assistant:write scope likely not installed in workspace; Part 2 adds clamp fallback.',
        });
      }
    },
    // threadContextChanged intentionally omitted → Bolt default context store.
    userMessage: async ({ message, say }) => {
      await deps.handleMessage(message as unknown as MessageEvent, say);
    },
  };
}

/**
 * Build the Bolt `Assistant` instance to pass into `app.assistant(...)`.
 */
export function createAssistantContainer(deps: AssistantContainerDeps): Assistant {
  return new Assistant(buildAssistantConfig(deps));
}

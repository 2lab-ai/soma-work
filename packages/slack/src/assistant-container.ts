/**
 * Bolt Assistant container factory — #666 P4 Part 1/2.
 *
 * Registers an `Assistant` middleware with Bolt so the Slack client surfaces
 * the native Assistant sidebar (features.assistant_view) and routes
 * `assistant_thread_started` / `assistant_thread_context_changed` /
 * `message.im`-within-assistant-thread events through Bolt's Assistant
 * middleware chain.
 *
 * Scope boundary (see docs/archive/features/slack-ui/phase4.md):
 *   - Part 1 (this file): threadStarted presents 4 placeholder prompts;
 *     userMessage delegates to the existing DM `handleMessage` so assistant
 *     threads behave identically to a regular DM. Native `setStatus` spinner
 *     updates are handled by turn-surface wiring.
 *   - threadContextChanged is intentionally omitted so Bolt's default
 *     context store handles `assistant_thread_context_changed` automatically.
 *     (Bolt v4.7.0 — see Assistant.ts#L23-L28.)
 */
import { Assistant, type AssistantConfig } from '@slack/bolt';
import type { Logger } from '@soma/common/logger';

export interface MessageEvent {
  user: string;
  channel: string;
  team?: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  synthetic?: boolean;
  skipDispatch?: boolean;
  modelOverride?: string;
  routeContext?: {
    skipAutoBotThread?: boolean;
    sourceChannel?: string;
    sourceThreadTs?: string;
  };
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

/**
 * Workflow-aware prompts surfaced in the assistant sidebar on
 * `assistant_thread_started`. These mirror soma-work's actual agent workflows
 * (PR review / issue implementation / dev deploy / debugging) so the sidebar
 * advertises what the agent can do rather than generic chat starters (#1064
 * surface modernization — supersedes the #666 generic placeholders). Max 4
 * prompts (Slack API cap). The `message` is pre-filled into the composer, not
 * auto-sent, so a trailing ": " invites the user to complete the request.
 */
export const SUGGESTED_PROMPTS: ReadonlyArray<{ title: string; message: string }> = [
  { title: 'PR 리뷰', message: 'PR을 리뷰해줘: ' },
  { title: '이슈/기능 구현', message: '이 이슈를 완벽하게 구현해줘: ' },
  { title: 'dev 배포 + QA', message: 'dev 환경에 배포하고 QA해줘' },
  { title: '에러 디버그', message: '이 에러를 디버그해줘: ' },
];

/**
 * @deprecated Use {@link SUGGESTED_PROMPTS}. Retained as an alias so external
 * importers don't break during the rename.
 */
export const SUGGESTED_PROMPTS_PLACEHOLDER = SUGGESTED_PROMPTS;

/**
 * Title shown above the suggested prompts in the Assistant sidebar.
 * Keep in sync with `infra/slack/slack-app-manifest.json#features.assistant_view.assistant_description`.
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
    threadStarted: async ({ saveThreadContext, setSuggestedPrompts }) => {
      // Persist the initial assistant-thread context so later handlers can
      // correlate the conversation (Bolt's default context store only kicks
      // in for `assistant_thread_context_changed` once we've saved at least
      // once — see the Bolt AI assistant tutorial).
      try {
        await saveThreadContext();
      } catch (err) {
        deps.logger.debug('saveThreadContext failed on thread_started', {
          error: (err as Error).message,
        });
      }

      try {
        await setSuggestedPrompts({
          prompts: [...SUGGESTED_PROMPTS],
          title: ASSISTANT_VIEW_TITLE,
        });
      } catch (err) {
        deps.logger.warn('setSuggestedPrompts failed', {
          error: (err as Error).message,
          hint: 'assistant:write scope likely not installed in workspace; Part 2 adds clamp fallback.',
        });
      }
    },
    // threadContextChanged intentionally omitted → Bolt default context store
    // (the one we primed via saveThreadContext above) handles it.
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

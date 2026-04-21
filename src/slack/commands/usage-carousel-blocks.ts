/**
 * buildCarouselBlocks — pure Block Kit builder for the usage-card v2 carousel
 * message. Emits 3 blocks:
 *   [0] context    — caller attribution (<@userId> — Usage Card)
 *   [1] image      — slack_file.id === fileIds[selectedTab]
 *   [2] actions    — 4 tab buttons (24h / 7d / 30d / all), selected → primary
 *
 * Trace: docs/usage-card-dark/trace.md, Scenario 1 (lines 60–61),
 *        Scenario 8 (line 232 — `block_id` must be static).
 *
 * Pure function — no I/O, no side effects. Block union uses loose typing
 * (`unknown[]`) to match existing codebase convention (see `ui-test-handler`
 * commentary on @slack/types loose unions).
 */

import type { TabId } from '../../metrics/usage-render/types';

/** Button order on the carousel. Matches TabId tuple in `types.ts`. */
const TAB_ORDER: readonly TabId[] = ['24h', '7d', '30d', 'all'] as const;

/** Human-readable button labels. Korean/English neutral. */
const LABEL: Record<TabId, string> = {
  '24h': 'Last 24h',
  '7d': 'Last 7d',
  '30d': 'Last 30d',
  all: 'All time',
};

/**
 * Build the 3-block carousel message body.
 *
 * @param fileIds    Slack file IDs keyed by tab (all 4 required).
 * @param selectedTab Which tab is currently active — image + primary button.
 * @param userId     Caller's Slack user ID (for context attribution).
 * @returns Ordered Block Kit array: [context, image, actions].
 */
export function buildCarouselBlocks(fileIds: Record<TabId, string>, selectedTab: TabId, userId: string): unknown[] {
  const context = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `<@${userId}> — Usage Card`,
      },
    ],
  };

  const image = {
    type: 'image',
    slack_file: { id: fileIds[selectedTab] },
    alt_text: `Usage card (${selectedTab})`,
  };

  const actions = {
    type: 'actions',
    block_id: 'usage_card_tabs',
    elements: TAB_ORDER.map((tabId) => {
      const button: Record<string, unknown> = {
        type: 'button',
        action_id: `usage_card_tab:${tabId}`,
        value: tabId,
        text: { type: 'plain_text', text: LABEL[tabId] },
      };
      if (tabId === selectedTab) {
        button.style = 'primary';
      }
      return button;
    }),
  };

  return [context, image, actions];
}

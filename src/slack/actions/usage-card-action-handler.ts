/**
 * UsageCardActionHandler — handles `usage_card_tab` block_actions clicks
 * from the `/usage card` carousel.
 *
 * Trace: docs/usage-card-dark/trace.md
 *   - Scenario 8 (happy path — owner click, chat.update)
 *   - Scenario 9 (non-owner click — ephemeral reject)
 *   - Scenario 11 (TabCache miss — ephemeral "session expired")
 *
 * Design notes:
 *  - Ack is performed in the Bolt wrapper (see ActionHandlers.registerHandlers).
 *  - In-place UI swap uses bot-token `client.chat.update` (response_url has
 *    a 30min / 5-call budget that is too tight for a persistent carousel).
 *  - Rejection paths use `respond({ replace_original: false })` so the card
 *    stays visible and the clicker gets an ephemeral toast.
 *  - Body is typed `any` to match the existing action-handler convention
 *    (Bolt's block_actions union is wide and noisy — see
 *    `user-acceptance-action-handler.ts`).
 */

import { Logger } from '../../logger';
import type { TabId } from '../../metrics/usage-render/types';
import { buildCarouselBlocks } from '../commands/usage-carousel-blocks';
import type { TabCache } from '../commands/usage-carousel-cache';

interface UsageCardDeps {
  tabCache: TabCache;
}

/** Module-local typeguard — keeps the handler closed against future tab drift. */
function isTabId(v: unknown): v is TabId {
  return v === '24h' || v === '7d' || v === '30d' || v === 'all';
}

export class UsageCardActionHandler {
  private logger = new Logger('UsageCardActionHandler');

  constructor(private deps: UsageCardDeps) {}

  /**
   * Handle a `usage_card_tab` button click.
   *
   * Contract (see trace.md Scenario 8/9/11):
   *  - Malformed payload → silent return (already ack'd).
   *  - Unknown tab value → silent return + warn log.
   *  - Cache miss → ephemeral "session expired" via `respond`.
   *  - Non-owner → ephemeral "owner only" via `respond`, no chat.update.
   *  - Owner happy path → `chat.update` with rebuilt carousel blocks.
   *  - chat.update failure → log + best-effort ephemeral fallback.
   */
  async handleTabClick(body: any, client: any, respond: any): Promise<void> {
    const messageTs: string | undefined = body?.container?.message_ts;
    const channel: string | undefined = body?.container?.channel_id;
    const clickingUserId: string | undefined = body?.user?.id;
    const rawSelectedTab: unknown = body?.actions?.[0]?.value;

    if (!messageTs || !channel || !clickingUserId || !rawSelectedTab) {
      this.logger.warn('usage_card_tab malformed payload', {
        messageTs,
        channel,
        clickingUserId,
        rawSelectedTab,
      });
      return;
    }

    if (!isTabId(rawSelectedTab)) {
      this.logger.warn('usage_card_tab unknown tab', { rawSelectedTab });
      return;
    }
    const selectedTab: TabId = rawSelectedTab;

    const entry = this.deps.tabCache.get(messageTs);

    // Scenario 11 — cache miss (TTL expired, LRU evicted, or process restart).
    if (!entry) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '⌛ 세션이 만료되었습니다. `/usage card` 를 다시 실행해 주세요.',
      });
      return;
    }

    // Scenario 9 — non-owner. Ephemeral reject, no chat.update, no cache mutation.
    if (clickingUserId !== entry.userId) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '⚠️ 본인 카드만 조작할 수 있습니다.',
      });
      return;
    }

    // Scenario 8 — owner happy path. Rebuild blocks with selected tab, in-place update.
    const blocks = buildCarouselBlocks(entry.fileIds, selectedTab, entry.userId);
    try {
      await client.chat.update({ channel, ts: messageTs, blocks });
    } catch (err) {
      this.logger.error('usage_card_tab chat.update failed', {
        messageTs,
        selectedTab,
        error: err instanceof Error ? err.message : String(err),
      });
      // Best-effort ephemeral so the clicker knows the click went nowhere.
      try {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '⚠️ 탭 전환에 실패했습니다. 다시 시도해 주세요.',
        });
      } catch {
        /* swallow — we already logged the primary failure */
      }
    }
  }
}

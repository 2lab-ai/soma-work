import { describe, expect, it, vi } from 'vitest';
import { ActionPanelActionHandler } from '../action-panel-action-handler';

/**
 * T1 — the workflow buttons are gone, and so is the code behind them.
 *
 * A Slack message rendered before this change still carries the old buttons
 * until its next re-render. A click on one must get a plain "unsupported"
 * reply and nothing else: no message posted, no prompt injected, no merge
 * (the handler no longer has a message pipeline or a merge helper to call).
 */

const REMOVED = [
  'pr_fix_new',
  'pr_fix_renew',
  'pr_review_new',
  'pr_review_renew',
  'pr_docs',
  'pr_approve',
  'pr_merge',
  'pr_fix',
  'pr_review',
  'pr_create',
  'issue_research',
  'focus_choice',
  // ⏸ 중지 too: the user kept only 세션 종료. Stopping a turn stays available
  // from the thread (`!`) and the dashboard.
  'stop',
];

function makeHandler() {
  const postMessage = vi.fn();
  const abortSession = vi.fn().mockReturnValue(true);
  const handler = new ActionPanelActionHandler({
    slackApi: { postMessage } as any,
    claudeHandler: {
      getSessionByKey: vi.fn().mockReturnValue({
        ownerId: 'U123',
        channelId: 'C123',
        threadTs: '111.222',
        activityState: 'idle',
        workflow: 'default',
        actionPanel: { waitingForChoice: true },
        links: { pr: { url: 'https://github.com/acme/repo/pull/1', label: 'PR #1' } },
      }),
    } as any,
    requestCoordinator: { abortSession } as any,
  });
  return { handler, postMessage, abortSession };
}

describe('ActionPanelActionHandler — T1: removed workflow actions', () => {
  for (const action of REMOVED) {
    it(`replies "unsupported" to a stale ${action} click and injects nothing`, async () => {
      const { handler, postMessage, abortSession } = makeHandler();
      const respond = vi.fn().mockResolvedValue(undefined);

      await handler.handleAction(
        {
          user: { id: 'U123' },
          actions: [
            { value: JSON.stringify({ sessionKey: 's1', action, prUrl: 'https://github.com/acme/repo/pull/1' }) },
          ],
        },
        respond as any,
      );

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral', text: '❌ 지원하지 않는 액션입니다.' }),
      );
      expect(postMessage).not.toHaveBeenCalled();
      expect(abortSession).not.toHaveBeenCalled();
    });
  }
});

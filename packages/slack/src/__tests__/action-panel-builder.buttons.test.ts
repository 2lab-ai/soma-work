import { describe, expect, it } from 'vitest';
import { ActionPanelBuilder, type WorkflowType } from '../action-panel-builder';

/**
 * T1 — the surface carries no workflow buttons (2026-10-27 user directive:
 * "new fix, renew fix pr 문서화 등의 버튼은 아무도 사용하지 않음 … 세션 종료 버튼을
 * 제외하고 모두 삭제").
 *
 * New Fix / Renew Fix / PR 문서화 / New 리뷰 / Renew 리뷰 / PR 승인 / Merge were
 * prompt-string shortcuts nobody clicked. Whatever the workflow, PR state or
 * PR URL, an idle panel offers exactly one control: 세션 종료.
 */

const NOW = 1_700_000_000_000;

const WORKFLOWS: WorkflowType[] = [
  'onboarding',
  'jira-executive-summary',
  'jira-brainstorming',
  'jira-planning',
  'jira-create-pr',
  'pr-review',
  'pr-fix-and-update',
  'pr-docs-confluence',
  'deploy',
  'default',
  'z-plan-to-work',
  'z-epic-update',
];

function buttons(blocks: any[]): any[] {
  return blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
}

describe('ActionPanelBuilder — T1: only 세션 종료 survives', () => {
  for (const workflow of WORKFLOWS) {
    it(`idle ${workflow} panel with an open, mergeable PR renders only 세션 종료`, () => {
      const { blocks } = ActionPanelBuilder.build({
        sessionKey: 'C1:1700.000000',
        workflow,
        disabled: false,
        now: NOW,
        prStatus: { state: 'open', mergeable: true, draft: false, merged: false, approved: false },
      });

      const ids = buttons(blocks).map((b) => b.action_id);
      expect(ids).toEqual(['panel_close']);
    });
  }

  it('renders only 세션 종료 while a turn runs — no ⏸ 중지 (T1, literal: "세션 종료 버튼을 제외하고 모두 삭제")', () => {
    for (const working of [{ activityState: 'working' as const }, { hasActiveRequest: true }]) {
      const { blocks } = ActionPanelBuilder.build({
        sessionKey: 'C1:1700.000000',
        workflow: 'pr-review',
        now: NOW,
        ...working,
      });
      expect(buttons(blocks).map((b) => b.action_id)).toEqual(['panel_close']);
      expect(JSON.stringify(blocks)).not.toMatch(/panel_stop|⏸|중지/);
    }
  });

  it('never emits a workflow action id, whatever the state', () => {
    const states = [
      { activityState: 'working' as const },
      { activityState: 'idle' as const },
      { waitingForChoice: true },
      { closed: true },
    ];
    for (const state of states) {
      const { blocks } = ActionPanelBuilder.build({
        sessionKey: 'C1:1700.000000',
        workflow: 'pr-review',
        now: NOW,
        prStatus: { state: 'open', mergeable: true, draft: false, merged: false },
        ...state,
      });
      const json = JSON.stringify(blocks);
      expect(json).not.toMatch(/panel_pr_|New Fix|Renew Fix|PR 문서화|New 리뷰|Renew 리뷰|PR 승인|"Merge"/);
    }
  });

  it('keeps one action row with no workflow_actions block id', () => {
    const { blocks } = ActionPanelBuilder.build({
      sessionKey: 'C1:1700.000000',
      workflow: 'pr-review',
      now: NOW,
    });
    const rows = blocks.filter((b) => b.type === 'actions');
    expect(rows).toHaveLength(1);
    expect(rows[0].block_id).toBe('control_actions');
  });
});

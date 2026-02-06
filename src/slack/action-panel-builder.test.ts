import { describe, it, expect } from 'vitest';
import { ActionPanelBuilder } from './action-panel-builder';

describe('ActionPanelBuilder', () => {
  it('builds two action rows for default workflow', () => {
    const payload = ActionPanelBuilder.build({ sessionKey: 'session-1', workflow: 'default' });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));

    expect(actionBlocks).toHaveLength(2);
    expect(actionBlocks[0].elements).toHaveLength(5);
    expect(actionBlocks[1].elements).toHaveLength(1);
    expect(actionIds).toEqual(expect.arrayContaining([
      'panel_issue_research',
      'panel_pr_create',
      'panel_pr_review',
      'panel_pr_docs',
      'panel_pr_fix',
      'panel_pr_approve',
    ]));
  });

  it('includes fix/approve buttons for pr-review workflow', () => {
    const payload = ActionPanelBuilder.build({ sessionKey: 'session-2', workflow: 'pr-review' });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));

    expect(actionIds).toEqual(expect.arrayContaining(['panel_pr_fix', 'panel_pr_approve']));
  });

  it('shows disabled state in header without using unsupported button properties', () => {
    const disabledPayload = ActionPanelBuilder.build({ sessionKey: 'session-3', workflow: 'default' });
    const disabledButton = disabledPayload.blocks.find((block) => block.type === 'actions').elements[0];
    expect(disabledButton.disabled).toBeUndefined();
    const disabledHeader = disabledPayload.blocks.find((block) => block.type === 'context');
    expect(disabledHeader.elements[1].text).toContain('비활성');

    const enabledPayload = ActionPanelBuilder.build({ sessionKey: 'session-4', workflow: 'default', disabled: false });
    const enabledButton = enabledPayload.blocks.find((block) => block.type === 'actions').elements[0];
    expect(enabledButton.disabled).toBeUndefined();
    const enabledHeader = enabledPayload.blocks.find((block) => block.type === 'context');
    expect(enabledHeader.elements[1].text).toContain('사용 가능');
  });

  it('appends choice blocks', () => {
    const choiceBlocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Choice block' },
      },
    ];
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-5',
      workflow: 'default',
      choiceBlocks,
    });

    expect(payload.blocks[payload.blocks.length - 1]).toEqual(choiceBlocks[0]);
  });
});

import { describe, it, expect } from 'vitest';
import { ActionPanelBuilder } from './action-panel-builder';

function getDialogText(payload: { blocks: any[] }): string {
  const sectionBlock = payload.blocks.find((block) => block.type === 'section');
  const raw = sectionBlock?.text?.text || '';
  return String(raw).replace(/^```/, '').replace(/```$/, '').trim();
}

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
    const disabledPayload = ActionPanelBuilder.build({
      sessionKey: 'session-3',
      workflow: 'default',
      styleVariant: 0,
    });
    const disabledButton = disabledPayload.blocks.find((block) => block.type === 'actions').elements[0];
    expect(disabledButton.disabled).toBeUndefined();
    expect(getDialogText(disabledPayload)).toContain('비활성');

    const enabledPayload = ActionPanelBuilder.build({
      sessionKey: 'session-4',
      workflow: 'default',
      disabled: false,
      styleVariant: 0,
    });
    const enabledButton = enabledPayload.blocks.find((block) => block.type === 'actions').elements[0];
    expect(enabledButton.disabled).toBeUndefined();
    expect(getDialogText(enabledPayload)).toContain('사용 가능');
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

  it('renders dialog text without thread permalink preview text', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-6',
      workflow: 'default',
      panelTitle: 'PTN-2411',
      styleVariant: 3,
    });

    const allText = JSON.stringify(payload.blocks);
    expect(allText).toContain('PTN-2411');
    expect(allText).toContain('(Thread)');
    expect(allText).not.toContain('|Thread');
    expect(allText).not.toContain('Thread link unavailable');
  });

  it('supports 10 distinct dialog styles', () => {
    const rendered = new Set<string>();

    for (let i = 0; i < 10; i++) {
      const payload = ActionPanelBuilder.build({
        sessionKey: `session-style-${i}`,
        workflow: 'default',
        panelTitle: 'PTN-1234',
        styleVariant: i,
      });
      rendered.add(getDialogText(payload));
    }

    expect(rendered.size).toBe(10);
  });
});

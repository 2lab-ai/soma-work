import { describe, it, expect } from 'vitest';
import { ActionPanelBuilder } from './action-panel-builder';

function getSectionText(payload: { blocks: any[] }): string {
  return String(payload.blocks.find((block) => block.type === 'section')?.text?.text || '');
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

  it('renders a text dashboard instead of ascii frame', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-3',
      workflow: 'jira-brainstorming',
      disabled: true,
    });

    const sectionText = getSectionText(payload);
    expect(sectionText).toContain('*Thread Dashboard*');
    expect(sectionText).toContain('상태: 비활성');
    expect(sectionText).toContain('워크플로우: `jira-brainstorming`');
    expect(sectionText).not.toContain('```');
    expect(sectionText).not.toContain('+-<');
    expect(sectionText).not.toContain('[이슈 리서치]');
  });

  it('shows waiting status when choice input is pending', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-4',
      workflow: 'default',
      waitingForChoice: true,
    });

    expect(getSectionText(payload)).toContain('상태: 입력 대기');
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

  it('renders real clickable links in a separate context block', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-6',
      workflow: 'default',
      links: {
        issue: {
          type: 'issue',
          provider: 'jira',
          url: 'https://jira.example.com/browse/PTN-2411',
          label: 'PTN-2411',
        },
        pr: {
          type: 'pr',
          provider: 'github',
          url: 'https://github.com/acme/repo/pull/854',
          label: 'PR #854',
        },
      },
    });

    const contextBlock = payload.blocks.find((block) => block.type === 'context');
    expect(contextBlock).toBeDefined();
    expect(contextBlock.elements[0].text).toContain('<https://jira.example.com/browse/PTN-2411|PTN-2411>');
    expect(contextBlock.elements[0].text).toContain('<https://github.com/acme/repo/pull/854|PR #854>');
  });
});

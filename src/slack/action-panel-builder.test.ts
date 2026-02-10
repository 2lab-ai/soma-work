import { describe, it, expect } from 'vitest';
import { ActionPanelBuilder } from './action-panel-builder';

function getSummaryText(payload: { blocks: any[] }): string {
  const sectionBlock = payload.blocks.find((block) => block.type === 'section');
  return String(sectionBlock?.text?.text || '');
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

    const summary = getSummaryText(payload);
    expect(summary).toContain('🧵 Thread');
    expect(summary).toContain('⏸️ 비활성');
    expect(summary).toContain('`jira-brainstorming`');
    expect(summary).toContain('🎛️ 2');
    expect(summary).not.toContain('*Thread Dashboard*');
    expect(summary).not.toContain('```');
  });

  it('shows waiting status when choice input is pending', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-4',
      workflow: 'default',
      waitingForChoice: true,
    });

    expect(getSummaryText(payload)).toContain('✋ 입력 대기');
  });

  it('shows reactive agent status chips (phase/tool/live)', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-4b',
      workflow: 'default',
      disabled: false,
      agentPhase: '워크플로우 분석 중',
      activeTool: 'Read',
      statusUpdatedAt: Date.now(),
      hasActiveRequest: true,
    });

    const summary = getSummaryText(payload);
    expect(summary).toContain('🛠 파일 읽기');
    expect(summary).toContain('🟢 live');
  });

  it('keeps summary compact without slack permalink unfurl', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-4c',
      workflow: 'default',
    });

    expect(getSummaryText(payload)).toContain('🧵 Thread');
    expect(getSummaryText(payload)).not.toContain('slack.com/archives');
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

    const contextBlock = payload.blocks.find((block) =>
      block.type === 'context' && String(block.elements?.[0]?.text || '').includes('🔗')
    );
    expect(contextBlock).toBeDefined();
    expect(contextBlock.elements[0].text).toContain('<https://jira.example.com/browse/PTN-2411|PTN-2411>');
    expect(contextBlock.elements[0].text).toContain('<https://github.com/acme/repo/pull/854|PR #854>');
  });

  it('skips slack message links to prevent original message preview unfurl', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-7',
      workflow: 'default',
      links: {
        issue: {
          type: 'issue',
          provider: 'unknown',
          url: 'https://workspace.slack.com/archives/C123/p1739000000001000',
          label: 'Thread header',
        },
      },
    });

    const linkContext = payload.blocks.find((block) =>
      block.type === 'context' && String(block.elements?.[0]?.text || '').includes('🔗')
    );
    expect(linkContext).toBeUndefined();
  });
});

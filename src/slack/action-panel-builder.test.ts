import { describe, it, expect } from 'vitest';
import { ActionPanelBuilder } from './action-panel-builder';

function getSummaryText(payload: { blocks: any[] }): string {
  const sectionBlock = payload.blocks.find(
    (block) => block.type === 'section'
      && /(비활성|작업 중|입력 대기|사용 가능|요청 처리 중|대기 중)/.test(String(block?.text?.text || ''))
  );
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

  it('renders dynamic summary only (status/tool/context/live)', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-3',
      workflow: 'jira-brainstorming',
      disabled: false,
      activityState: 'working',
      activeTool: 'Read',
      contextUsagePercent: 61,
      statusUpdatedAt: Date.now(),
    });

    const summary = getSummaryText(payload);
    expect(summary).toContain('⚙️ 작업 중');
    expect(summary).toContain('🛠 파일 읽기');
    expect(summary).toContain('📦 61%');
    expect(summary).toContain('🟢 live');
    expect(summary).not.toContain('`jira-brainstorming`');
    expect(summary).not.toContain('🎛️');
    expect(summary).not.toContain('🔗');
  });

  it('shows context usage placeholder when usage is unavailable', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-4',
      workflow: 'default',
      disabled: true,
    });

    expect(getSummaryText(payload)).toContain('📦 --%');
  });

  it('replaces main actions with question response button when choice is pending', () => {
    const choiceBlocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '❓ *배포 타임라인을 어떤 방식으로 정리할까요?*' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '💡 릴리즈 공지 범위를 같이 정해야 합니다.' }],
      },
    ];

    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-5',
      workflow: 'default',
      waitingForChoice: true,
      choiceBlocks,
      choiceMessageLink: 'https://workspace.slack.com/archives/C123/p111222333',
      contextUsagePercent: 73,
    });

    const userAskSection = payload.blocks.find((block) =>
      block.type === 'section'
      && String(block.text?.text || '').includes('*User Ask*')
    );
    expect(userAskSection).toBeDefined();
    expect(String(userAskSection.text.text)).toContain('배포 타임라인');

    const actionsBlocks = payload.blocks.filter((block) => block.type === 'actions');
    expect(actionsBlocks).toHaveLength(1);
    expect(actionsBlocks[0].elements).toHaveLength(1);
    expect(actionsBlocks[0].elements[0].action_id).toBe('panel_focus_choice');
    expect(actionsBlocks[0].elements[0].style).toBe('primary');
    expect(actionsBlocks[0].elements[0].url).toContain('slack.com/archives');
    expect(actionsBlocks[0].elements[0].text.text).toBe('질문 응답');

    const summary = getSummaryText(payload);
    expect(summary).toContain('✋ 입력 대기');
    expect(summary).toContain('🧩 질문 응답 필요');
    expect(summary).toContain('📦 73%');
  });

  it('keeps question slot with fallback text even without parsable choice blocks', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-6',
      workflow: 'default',
      waitingForChoice: true,
      choiceBlocks: [],
    });

    const userAskSection = payload.blocks.find((block) =>
      block.type === 'section'
      && String(block.text?.text || '').includes('*User Ask*')
    );
    expect(userAskSection).toBeDefined();
    expect(String(userAskSection.text?.text || '')).toContain('응답이 필요한 질문이 있습니다');
  });
});

import { describe, it, expect } from 'vitest';
import { ActionPanelBuilder } from './action-panel-builder';

function getStatusSectionText(payload: { blocks: any[] }): string {
  const sectionBlock = payload.blocks.find(
    (block) => block.type === 'section'
      && /(대기|작업 중|입력 대기|사용 가능|요청 처리 중|종료됨)/.test(String(block?.text?.text || ''))
  );
  return String(sectionBlock?.text?.text || '');
}

function getMetricsContextText(payload: { blocks: any[] }): string {
  const ctxBlock = payload.blocks.find(
    (block) => block.type === 'context'
      && block.elements?.some((el: any) => /📦/.test(String(el?.text || '')))
  );
  if (!ctxBlock) return '';
  return String(ctxBlock.elements?.[0]?.text || '');
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

  it('renders structural layout with section + context blocks', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-3',
      workflow: 'jira-brainstorming',
      disabled: false,
      activityState: 'working',
      activeTool: 'Read',
      contextRemainingPercent: 61,
      statusUpdatedAt: Date.now(),
    });

    // Status section (big text)
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('⚙️ *작업 중*');
    expect(statusText).toContain('🛠 파일 읽기');
    expect(statusText).not.toContain('📦'); // metrics are in context block

    // Metrics context (small text)
    const metricsText = getMetricsContextText(payload);
    expect(metricsText).toContain('📦 61%');
    expect(metricsText).toContain('🟢 live');
  });

  it('shows context usage placeholder when usage is unavailable', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-4',
      workflow: 'default',
      disabled: true,
    });

    const metricsText = getMetricsContextText(payload);
    expect(metricsText).toContain('📦 --%');
  });

  it('shows one decimal for non-integer remaining context percent', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-4-1',
      workflow: 'default',
      contextRemainingPercent: 63.2,
    });

    const metricsText = getMetricsContextText(payload);
    expect(metricsText).toContain('📦 63.2%');
  });

  it('mirrors thread choice blocks with divider when choice is pending', () => {
    const choiceBlocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '❓ *배포 타임라인을 어떤 방식으로 정리할까요?*' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '💡 릴리즈 공지 범위를 같이 정해야 합니다.' }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'user_choice_1',
            text: { type: 'plain_text', text: '1️⃣ 옵션 A' },
            value: '{"sessionKey":"session-5","choiceId":"1"}',
          },
          {
            type: 'button',
            action_id: 'user_choice_2',
            text: { type: 'plain_text', text: '2️⃣ 옵션 B' },
            value: '{"sessionKey":"session-5","choiceId":"2"}',
          },
        ],
      },
    ];

    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-5',
      workflow: 'default',
      waitingForChoice: true,
      choiceBlocks,
      choiceMessageLink: 'https://workspace.slack.com/archives/C123/p111222333',
      contextRemainingPercent: 73,
    });

    // Divider before choice blocks
    const dividerIdx = payload.blocks.findIndex((b) => b.type === 'divider');
    expect(dividerIdx).toBeGreaterThan(0);

    const mirroredQuestionSection = payload.blocks.find((block) =>
      block.type === 'section'
      && String(block.text?.text || '').includes('배포 타임라인')
    );
    expect(mirroredQuestionSection).toBeDefined();

    const actionsBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionsBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));
    expect(actionIds).toContain('user_choice_1');
    expect(actionIds).toContain('user_choice_2');
    expect(actionIds).not.toContain('panel_focus_choice');

    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('✋ *입력 대기*');
    expect(statusText).toContain('🧩 질문 응답 필요');

    const metricsText = getMetricsContextText(payload);
    expect(metricsText).toContain('📦 73%');
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

  it('renders closed state with section + context blocks', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-7',
      workflow: 'default',
      closed: true,
      contextRemainingPercent: 62,
      prStatus: { state: 'merged', mergeable: false, draft: false, merged: true },
    });

    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('🔒 *종료됨*');
    expect(statusText).toContain('🟣 Merged');

    const metricsText = getMetricsContextText(payload);
    expect(metricsText).toContain('📦 62%');

    // No action buttons in closed state
    const actionBlocks = payload.blocks.filter((b) => b.type === 'actions');
    expect(actionBlocks).toHaveLength(0);
  });

  it('block order: status section → metrics context → actions', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-8',
      workflow: 'default',
      activityState: 'idle',
      contextRemainingPercent: 90,
      turnSummary: '⏱ 1:30 · 🛠 5',
    });

    const types = payload.blocks.map((b) => b.type);
    const sectionIdx = types.indexOf('section');
    const contextIdx = types.indexOf('context');
    const actionsIdx = types.indexOf('actions');

    expect(sectionIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(actionsIdx);
  });
});

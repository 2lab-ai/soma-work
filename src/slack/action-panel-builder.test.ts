import { describe, it, expect } from 'vitest';
import { ActionPanelBuilder } from './action-panel-builder';

function getStatusSectionText(payload: { blocks: any[] }): string {
  const sectionBlock = payload.blocks.find(
    (block) => block.type === 'section'
      && /(대기|작업 중|입력 대기|사용 가능|요청 처리 중|종료됨)/.test(String(block?.text?.text || ''))
  );
  return String(sectionBlock?.text?.text || '');
}

function getFieldsSectionText(payload: { blocks: any[] }): string {
  const fieldsBlock = payload.blocks.find(
    (block) => block.type === 'section' && Array.isArray(block.fields)
  );
  if (!fieldsBlock) return '';
  return fieldsBlock.fields.map((f: any) => String(f.text || '')).join(' ');
}

describe('ActionPanelBuilder', () => {
  it('builds close-only action row for default workflow', () => {
    const payload = ActionPanelBuilder.build({ sessionKey: 'session-1', workflow: 'default' });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));

    expect(actionBlocks).toHaveLength(1);
    expect(actionIds).toEqual(['panel_close']);
  });

  it('includes fix_new/fix_renew/approve/docs/close buttons for pr-review workflow', () => {
    const payload = ActionPanelBuilder.build({ sessionKey: 'session-2', workflow: 'pr-review' });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));

    expect(actionIds).toEqual(expect.arrayContaining([
      'panel_pr_fix_new',
      'panel_pr_fix_renew',
      'panel_pr_approve',
      'panel_pr_docs',
      'panel_close',
    ]));
  });

  it('dynamically adds review buttons when prUrl exists and workflow has no review buttons', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-2b',
      workflow: 'jira-create-pr',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));

    expect(actionIds).toContain('panel_pr_review_new');
    expect(actionIds).toContain('panel_pr_review_renew');
    expect(actionIds).toContain('panel_close');
  });

  it('does not duplicate review buttons when workflow already has them', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-2c',
      workflow: 'pr-fix-and-update',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));

    const reviewCount = actionIds.filter((id: string) => id === 'panel_pr_review_new').length;
    expect(reviewCount).toBe(1);
  });

  it('renders structural layout with hero section + fields section + context blocks', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-3',
      workflow: 'jira-brainstorming',
      disabled: false,
      activityState: 'working',
      activeTool: 'Read',
      contextRemainingPercent: 61,
      statusUpdatedAt: Date.now(),
    });

    // Hero section (badge + italic subtitle)
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('🟢 *작업 중*');
    expect(statusText).toContain('_파일 읽기_');
    expect(statusText).not.toContain('📦');

    // Fields section (context% in fields)
    const fieldsText = getFieldsSectionText(payload);
    expect(fieldsText).toContain('61%');

    // Metrics context (live indicator)
    const ctxBlock = payload.blocks.find(
      (block) => block.type === 'context'
        && block.elements?.some((el: any) => /live/.test(String(el?.text || '')))
    );
    expect(ctxBlock).toBeDefined();
  });

  it('shows context usage placeholder when usage is unavailable', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-4',
      workflow: 'default',
      disabled: true,
    });

    const fieldsText = getFieldsSectionText(payload);
    expect(fieldsText).toContain('--%');
  });

  it('shows one decimal for non-integer remaining context percent', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-4-1',
      workflow: 'default',
      contextRemainingPercent: 63.2,
    });

    const fieldsText = getFieldsSectionText(payload);
    expect(fieldsText).toContain('63.2%');
  });

  it('shows choice blocks in panel when choice is pending', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-5',
      workflow: 'default',
      waitingForChoice: true,
      choiceBlocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '❓ *질문*' } },
      ],
      contextRemainingPercent: 73,
    });

    // Choice blocks are rendered in the panel
    const choiceSection = payload.blocks.find(
      (b) => b.type === 'section' && b.text?.text === '❓ *질문*'
    );
    expect(choiceSection).toBeDefined();

    // Workflow buttons are hidden (only close button remains)
    const actionsBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionsBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));
    expect(actionIds).toEqual(['panel_close']);

    // Hero section shows waiting
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('🟡 *입력 대기*');
    expect(statusText).toContain('_질문 응답 필요_');

    // Fields section shows context%
    const fieldsText = getFieldsSectionText(payload);
    expect(fieldsText).toContain('73%');
  });

  it('renders closed state with status blocks only', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-7',
      workflow: 'default',
      closed: true,
      contextRemainingPercent: 62,
      prStatus: { state: 'merged', mergeable: false, draft: false, merged: true },
    });

    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('⚫ *종료됨*');

    const fieldsText = getFieldsSectionText(payload);
    expect(fieldsText).toContain('🟣 Merged');
    expect(fieldsText).toContain('62%');

    // No action buttons in closed state
    const actionBlocks = payload.blocks.filter((b) => b.type === 'actions');
    expect(actionBlocks).toHaveLength(0);
  });

  it('block order: hero section → fields section → metrics context → actions', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-8',
      workflow: 'default',
      activityState: 'idle',
      contextRemainingPercent: 90,
      turnSummary: '⏱ 1:30 · 🛠 5',
    });

    const types = payload.blocks.map((b) => b.type);
    const heroIdx = types.indexOf('section');
    const fieldsIdx = types.indexOf('section', heroIdx + 1);
    const contextIdx = types.indexOf('context');
    const actionsIdx = types.indexOf('actions');

    expect(heroIdx).toBeLessThan(fieldsIdx);
    expect(fieldsIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(actionsIdx);
  });
});

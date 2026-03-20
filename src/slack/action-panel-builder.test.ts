import { describe, it, expect } from 'vitest';
import { ActionPanelBuilder } from './action-panel-builder';
import { LOG_DETAIL } from './output-flags';

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

  it('hides merge button for pr-review workflow even when PR is mergeable', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-2d',
      workflow: 'pr-review',
      prUrl: 'https://github.com/org/repo/pull/1',
      prStatus: { state: 'open', mergeable: true, draft: false, merged: false, approved: true },
    });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));

    expect(actionIds).not.toContain('panel_pr_merge');
  });

  it('hides merge button for pr-fix-and-update workflow even when PR is mergeable', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-2e',
      workflow: 'pr-fix-and-update',
      prUrl: 'https://github.com/org/repo/pull/1',
      prStatus: { state: 'open', mergeable: true, draft: false, merged: false, approved: true },
    });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));

    expect(actionIds).not.toContain('panel_pr_merge');
  });

  it('renders structural layout with hero section + fields section + context blocks', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-3',
      workflow: 'jira-brainstorming',
      disabled: false,
      activityState: 'working',
      activeTool: 'Read',
      contextRemainingPercent: 61,
      logVerbosity: LOG_DETAIL,
    });

    // Hero section (badge + italic subtitle)
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('🟢 *작업 중*');
    expect(statusText).toContain('_파일 읽기_');
    expect(statusText).not.toContain('📦');

    // Fields section exists (context% removed — shown in thread header badge instead)

    // Metrics context (verbosity label)
    const ctxBlock = payload.blocks.find(
      (block) => block.type === 'context'
        && block.elements?.some((el: any) => /detail/.test(String(el?.text || '')))
    );
    expect(ctxBlock).toBeDefined();
  });

  // Context percentage tests removed — context is now displayed in thread header badge only.

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

    // Context% moved to thread header badge
  });

  it('renders closed state with hero + divider + summary grid + footer', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-7',
      workflow: 'default',
      closed: true,
      contextRemainingPercent: 62,
      prStatus: { state: 'merged', mergeable: false, draft: false, merged: true },
      turnSummary: '⏱ 3:20 · 🛠 12',
      latestResponseLink: 'https://workspace.slack.com/archives/C123/p111',
    });

    // Hero: status + PR inline
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('⚫ *종료됨*');
    expect(statusText).toContain('Merged');

    // Summary fields grid
    const fieldsText = getFieldsSectionText(payload);
    expect(fieldsText).toContain('소요 시간');
    expect(fieldsText).toContain('3:20');
    expect(fieldsText).toContain('도구 사용');
    expect(fieldsText).toContain('12회');
    // Context% moved to thread header badge

    // Divider present
    const hasDivider = payload.blocks.some((b) => b.type === 'divider');
    expect(hasDivider).toBe(true);

    // Footer context with timestamp and link
    const footerCtx = payload.blocks.find(
      (b) => b.type === 'context'
        && b.elements?.some((el: any) => /종료/.test(String(el?.text || '')))
    );
    expect(footerCtx).toBeDefined();
    const footerTexts = footerCtx.elements.map((el: any) => String(el.text)).join(' ');
    expect(footerTexts).toContain('최신 응답');

    // No action buttons in closed state
    const actionBlocks = payload.blocks.filter((b) => b.type === 'actions');
    expect(actionBlocks).toHaveLength(0);
  });

  it('renders closed state without turnSummary (minimal)', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-7b',
      workflow: 'default',
      closed: true,
      contextRemainingPercent: 45,
    });

    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('⚫ *종료됨*');

    // Context% is now in thread header badge — not in action panel
    const fieldsText = getFieldsSectionText(payload);
    expect(fieldsText).not.toContain('컨텍스트');
    expect(fieldsText).not.toContain('소요 시간');

    const actionBlocks = payload.blocks.filter((b) => b.type === 'actions');
    expect(actionBlocks).toHaveLength(0);
  });

  it('separates workflow_actions and control_actions block_ids', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-9',
      workflow: 'pr-review',
    });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');

    // workflow_actions + control_actions = 2 action blocks
    expect(actionBlocks.length).toBeGreaterThanOrEqual(2);
    expect(actionBlocks[0].block_id).toBe('workflow_actions');
    expect(actionBlocks[actionBlocks.length - 1].block_id).toBe('control_actions');

    // Close button is in control_actions, not workflow_actions
    const controlIds = actionBlocks[actionBlocks.length - 1].elements.map((el: any) => el.action_id);
    expect(controlIds).toEqual(['panel_close']);
  });

  it('keeps max 1 primary button when review workflow is mergeable', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-10',
      workflow: 'pr-review',
      prUrl: 'https://github.com/org/repo/pull/1',
      prStatus: { state: 'open', mergeable: true, draft: false, merged: false, approved: false },
    });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const allButtons = actionBlocks.flatMap((block: any) => block.elements);
    const primaryButtons = allButtons.filter((b: any) => b.style === 'primary');

    expect(primaryButtons.length).toBeLessThanOrEqual(1);
    if (primaryButtons.length === 1) {
      expect(primaryButtons[0].action_id).toBe('panel_pr_approve');
    }
  });

  it('stop button shows ⏸ emoji prefix when working', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-11',
      workflow: 'default',
      activityState: 'working',
      hasActiveRequest: true,
    });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const stopButton = actionBlocks
      .flatMap((b: any) => b.elements)
      .find((el: any) => el.action_id === 'panel_stop');

    expect(stopButton).toBeDefined();
    expect(stopButton.text.text).toBe('⏸ 중지');
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

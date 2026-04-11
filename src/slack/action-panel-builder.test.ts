import { describe, expect, it } from 'vitest';
import { ActionPanelBuilder } from './action-panel-builder';
import { LOG_DETAIL } from './output-flags';

function getStatusSectionText(payload: { blocks: any[] }): string {
  // Status may be in section.text.text (no PR) or section.fields[0].text (with PR)
  for (const block of payload.blocks) {
    if (block.type !== 'section') continue;
    const textStr = String(block?.text?.text || '');
    if (/(대기|작업 중|입력 대기|사용 가능|요청 처리 중|종료됨)/.test(textStr)) {
      return textStr;
    }
    // Check fields[0] for 2-column layout
    const fieldStr = String(block?.fields?.[0]?.text || '');
    if (/(대기|작업 중|입력 대기|사용 가능|요청 처리 중|종료됨)/.test(fieldStr)) {
      // Return all fields text combined so callers can check PR chip too
      return block.fields.map((f: any) => String(f.text || '')).join(' | ');
    }
  }
  return '';
}

function getFieldsSectionText(payload: { blocks: any[] }): string {
  // Find the summary fields section (has "소요 시간" or "도구 사용"), not the hero fields
  const fieldsBlock = payload.blocks.find(
    (block) =>
      block.type === 'section' &&
      Array.isArray(block.fields) &&
      block.fields.some((f: any) => /소요 시간|도구 사용/.test(String(f.text || ''))),
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

    expect(actionIds).toEqual(
      expect.arrayContaining([
        'panel_pr_fix_new',
        'panel_pr_fix_renew',
        'panel_pr_approve',
        'panel_pr_docs',
        'panel_close',
      ]),
    );
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

  it('renders structural layout with hero section + context blocks', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-3',
      workflow: 'jira-brainstorming',
      disabled: false,
      activityState: 'working',
      activeTool: 'Read',
      contextRemainingPercent: 61,
      logVerbosity: LOG_DETAIL,
    });

    // Hero section (badge + italic subtitle) — single section, no fields (no PR)
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('🟢 *작업 중*');
    expect(statusText).toContain('_파일 읽기_');
    expect(statusText).not.toContain('📦');

    // Metrics context (verbosity label)
    const ctxBlock = payload.blocks.find(
      (block) => block.type === 'context' && block.elements?.some((el: any) => /detail/.test(String(el?.text || ''))),
    );
    expect(ctxBlock).toBeDefined();
  });

  // Context percentage tests removed — context is now displayed in thread header badge only.

  it('shows choice link section (not interactive choice blocks) when choice is pending', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-5',
      workflow: 'default',
      waitingForChoice: true,
      choiceBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: '❓ *질문*' } }],
      choiceMessageLink: 'https://workspace.slack.com/archives/C123/p999',
      contextRemainingPercent: 73,
    });

    // Actual choice blocks should NOT be embedded in the panel
    const embeddedChoice = payload.blocks.find((b) => b.type === 'section' && b.text?.text === '❓ *질문*');
    expect(embeddedChoice).toBeUndefined();

    // Instead, a link section with "질문에 답변해 주세요" text should appear
    const linkSection = payload.blocks.find(
      (b) => b.type === 'section' && b.text?.text === '❓ 질문에 답변해 주세요',
    );
    expect(linkSection).toBeDefined();

    // Link button should point to the choice message permalink
    expect(linkSection.accessory).toBeDefined();
    expect(linkSection.accessory.type).toBe('button');
    expect(linkSection.accessory.url).toBe('https://workspace.slack.com/archives/C123/p999');
    expect(linkSection.accessory.action_id).toBe('panel_choice_link');

    // Workflow buttons are hidden (only close button remains)
    const actionsBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionsBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));
    expect(actionIds).toEqual(['panel_close']);

    // Hero section shows waiting
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('🟡 *입력 대기*');
    expect(statusText).toContain('_질문 응답 필요_');
  });

  it('shows choice text section without link button when choiceMessageLink is absent', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-5b',
      workflow: 'default',
      waitingForChoice: true,
      choiceBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: '❓ *질문*' } }],
    });

    // Link section text should still appear
    const linkSection = payload.blocks.find(
      (b) => b.type === 'section' && b.text?.text === '❓ 질문에 답변해 주세요',
    );
    expect(linkSection).toBeDefined();

    // No accessory button when there's no permalink
    expect(linkSection.accessory).toBeUndefined();
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

    // Hero: status (left) + PR (right) in 2-column fields
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('⚫ *종료됨*');
    expect(statusText).toContain('Merged');
    expect(statusText).toContain('*PR*');

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
      (b) => b.type === 'context' && b.elements?.some((el: any) => /종료/.test(String(el?.text || ''))),
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
    const stopButton = actionBlocks.flatMap((b: any) => b.elements).find((el: any) => el.action_id === 'panel_stop');

    expect(stopButton).toBeDefined();
    expect(stopButton.text.text).toBe('⏸ 중지');
  });

  it('block order: hero section → metrics context → actions', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-8',
      workflow: 'default',
      activityState: 'idle',
      contextRemainingPercent: 90,
      turnSummary: '⏱ 1:30 · 🛠 5',
    });

    const types = payload.blocks.map((b) => b.type);
    const heroIdx = types.indexOf('section');
    const contextIdx = types.indexOf('context');
    const actionsIdx = types.indexOf('actions');

    expect(heroIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(actionsIdx);
  });

  it('renders PR status in 2-column layout beside status badge', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-pr-layout',
      workflow: 'pr-review',
      disabled: false,
      prStatus: { state: 'open', mergeable: true, draft: false, merged: false, approved: true },
    });

    // First section should have fields (2-column)
    const heroSection = payload.blocks.find((b: any) => b.type === 'section' && Array.isArray(b.fields));
    expect(heroSection).toBeDefined();
    expect(heroSection.fields).toHaveLength(2);
    expect(heroSection.fields[0].text).toContain('사용 가능');
    expect(heroSection.fields[1].text).toContain('*PR*');
    expect(heroSection.fields[1].text).toContain('Approved');
  });
});

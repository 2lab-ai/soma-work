import { LOG_DETAIL } from '@soma/slack/output-flags';
import { describe, expect, it } from 'vitest';
import { ActionPanelBuilder } from '../action-panel-builder';

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

describe('ActionPanelBuilder', () => {
  // Workflow buttons were removed on 2026-10-27; every workflow now renders the
  // same controls (see action-panel-builder.buttons.test.ts).
  it('builds close-only action row for default workflow', () => {
    const payload = ActionPanelBuilder.build({ sessionKey: 'session-1', workflow: 'default' });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));

    expect(actionBlocks).toHaveLength(1);
    expect(actionIds).toEqual(['panel_close']);
  });

  it('renders the status area as one section carrying badge and metrics', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-3',
      workflow: 'jira-brainstorming',
      disabled: false,
      activityState: 'working',
      contextRemainingPercent: 61,
      logVerbosity: LOG_DETAIL,
    });

    // Hero section (badge + step/progress) — single section, no fields (no PR)
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('🟢 *작업 중*');
    expect(statusText).not.toContain('📦');

    // Metrics (verbosity label) moved into line 2 of that same section
    // (2026-09-17 compact panel) — no separate context block any more.
    expect(statusText).toMatch(/detail/);
    expect(payload.blocks.some((block) => block.type === 'context')).toBe(false);
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

    // Instead, a mrkdwn link section (no interactive element) should appear
    const linkSection = payload.blocks.find(
      (b) => b.type === 'section' && b.text?.text?.includes('질문에 답변해 주세요'),
    );
    expect(linkSection).toBeDefined();

    // Plain mrkdwn link — no button accessory (avoids Slack interactive element suppression)
    expect(linkSection.accessory).toBeUndefined();
    expect(linkSection.text.text).toContain('https://workspace.slack.com/archives/C123/p999');
    expect(linkSection.text.text).toContain('질문 보기');

    // Workflow buttons are hidden (only close button remains)
    const actionsBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionsBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));
    expect(actionIds).toEqual(['panel_close']);

    // Hero section shows waiting
    const statusText = getStatusSectionText(payload);
    expect(statusText).toContain('🟡 *입력 대기*');
  });

  it('shows choice text section without permalink when choiceMessageLink is absent', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-5b',
      workflow: 'default',
      waitingForChoice: true,
      choiceBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: '❓ *질문*' } }],
    });

    // The question prompt is the last line of the status rail (T2), not its
    // own section behind a divider; no URL when the permalink is absent.
    const rail = payload.blocks.find((b) => b.type === 'section');
    const lines = String(rail.text.text).split('\n');
    expect(lines[lines.length - 1]).toBe('❓ 질문에 답변해 주세요');
    expect(rail.accessory).toBeUndefined();
  });
  it('renders closed state as one rail: badge + close time, then summary, PR and link', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-7',
      workflow: 'default',
      closed: true,
      contextRemainingPercent: 62,
      prStatus: { state: 'merged', mergeable: false, draft: false, merged: true },
      turnSummary: '⏱ 3:20 · 🛠 12',
      latestResponseLink: 'https://workspace.slack.com/archives/C123/p111',
    });

    // T2: one full-width section, no hero grid / divider / summary grid / footer.
    expect(payload.blocks.map((b) => b.type)).toEqual(['section']);
    const [line1, line2] = String(payload.blocks[0].text.text).split('\n');
    expect(line1).toMatch(/^⚫ \*종료됨\* · \d{2}-\d{2} \d{2}:\d{2} 종료$/);
    expect(line2).toBe('⏱ 3:20 · 🛠 12 · 🔀 Merged · <https://workspace.slack.com/archives/C123/p111|💬 최신 응답>');
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
    // Nothing to summarise → the rail is the single closed line.
    expect(statusText.split('\n')).toHaveLength(1);
    expect(statusText).not.toContain('컨텍스트');

    const actionBlocks = payload.blocks.filter((b) => b.type === 'actions');
    expect(actionBlocks).toHaveLength(0);
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

  it('block order: status rail (badge + metrics) → actions, no divider', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-8',
      workflow: 'default',
      activityState: 'idle',
      contextRemainingPercent: 90,
      turnSummary: '⏱ 1:30 · 🛠 5',
    });

    expect(payload.blocks.map((b) => b.type)).toEqual(['section', 'actions']);
    expect(getStatusSectionText(payload)).toContain('⏱ 1:30 · 🛠 5');
  });
  it('renders PR status on the full-width rail, not in a second column', () => {
    const payload = ActionPanelBuilder.build({
      sessionKey: 'session-pr-layout',
      workflow: 'pr-review',
      disabled: false,
      prStatus: { state: 'open', mergeable: true, draft: false, merged: false, approved: true },
    });

    const rail = payload.blocks.find((b: any) => b.type === 'section');
    expect(rail.fields).toBeUndefined();
    expect(String(rail.text.text).split('\n')).toEqual(['⚪ *사용 가능*', '🔀 Approved · Merge 가능']);
  });
  it('renders only close button for z-plan-to-work handoff workflow (#695)', () => {
    const payload = ActionPanelBuilder.build({ sessionKey: 'session-z1', workflow: 'z-plan-to-work' });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));
    expect(actionIds).toEqual(['panel_close']);
  });

  it('renders only close button for z-epic-update handoff workflow (#695)', () => {
    const payload = ActionPanelBuilder.build({ sessionKey: 'session-z2', workflow: 'z-epic-update' });
    const actionBlocks = payload.blocks.filter((block) => block.type === 'actions');
    const actionIds = actionBlocks.flatMap((block: any) => block.elements.map((el: any) => el.action_id));
    expect(actionIds).toEqual(['panel_close']);
  });
});

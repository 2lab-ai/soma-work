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
});

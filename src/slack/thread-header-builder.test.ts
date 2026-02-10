import { describe, it, expect } from 'vitest';
import { ThreadHeaderBuilder } from './thread-header-builder';

describe('ThreadHeaderBuilder', () => {
  it('maps activity state to label and color', () => {
    expect(ThreadHeaderBuilder.getStatusStyle('working')).toEqual({
      label: '작업 중',
      color: '#F2C744',
      emoji: '⚙️',
    });
    expect(ThreadHeaderBuilder.getStatusStyle('waiting')).toEqual({
      label: '입력 대기',
      color: '#3B82F6',
      emoji: '✋',
    });
    expect(ThreadHeaderBuilder.getStatusStyle('idle')).toEqual({
      label: '대기',
      color: '#36a64f',
      emoji: '✅',
    });
  });

  it('does not render Slack message links in thread header link context', () => {
    const payload = ThreadHeaderBuilder.build({
      title: 'Header',
      links: {
        issue: {
          url: 'https://workspace.slack.com/archives/C123/p1739000000001000',
          type: 'issue',
          provider: 'unknown',
          label: 'Slack link',
        },
        pr: {
          url: 'https://github.com/org/repo/pull/10',
          type: 'pr',
          provider: 'github',
          label: 'PR #10',
        },
      },
    });

    const blocks = (payload.blocks || payload.attachments?.[0]?.blocks || []) as any[];
    const linkContext = blocks.find((block) =>
      block.type === 'context' &&
      Array.isArray(block.elements) &&
      block.elements.some((el: any) => String(el.text || '').includes('github.com'))
    );

    expect(linkContext).toBeDefined();
    const linkTexts = linkContext.elements.map((el: any) => String(el.text));
    expect(linkTexts.join(' ')).toContain('github.com');
    expect(linkTexts.join(' ')).not.toContain('slack.com/archives');
  });

  it('builds thread header as top-level blocks to avoid duplicate attachment rendering', () => {
    const payload = ThreadHeaderBuilder.build({
      title: 'Header',
      workflow: 'default',
      ownerName: 'Tester',
      activityState: 'idle',
      lastActivity: new Date(),
      links: {
        pr: {
          url: 'https://github.com/org/repo/pull/10',
          type: 'pr',
          provider: 'github',
          label: 'PR #10',
        },
      },
    });

    expect(Array.isArray(payload.blocks)).toBe(true);
    expect((payload.blocks || []).length).toBeGreaterThan(0);
    expect(payload.attachments).toBeUndefined();
  });
});

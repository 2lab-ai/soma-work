import { describe, expect, it } from 'vitest';
import {
  buildCancelledNotice,
  buildDeferredNotice,
  buildQueuedNotice,
  buildStartedNotice,
  parseQueueActionValue,
  USER_TASK_QUEUE_BYPASS_ACTION_ID,
  USER_TASK_QUEUE_CANCEL_ACTION_ID,
} from '../slack-notice';

const running = [{ title: '로그인 버그 고치기', link: 'https://x.slack.com/archives/C1/p1' }];

function allText(blocks: any[]): string {
  return JSON.stringify(blocks);
}

describe('buildQueuedNotice', () => {
  it('explains the queue: what runs, in which thread, that this one starts after it, and how to go first', () => {
    const { text, blocks } = buildQueuedNotice({ entryId: 'utq_1', position: 1, limit: 1, running, waitingCount: 1 });
    expect(text).toContain('대기');
    const body = allText(blocks);
    expect(body).toContain('<https://x.slack.com/archives/C1/p1|로그인 버그 고치기>');
    expect(body).toContain('끝나면');
    expect(body).toContain('자동으로 시작');
    expect(body).toContain('먼저 진행');
    expect(body).toContain('멈춘 지점부터');
    expect(body).toContain('1개');
    expect(body).toContain('대기큐');
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions.elements.map((e: any) => e.action_id)).toEqual([
      USER_TASK_QUEUE_BYPASS_ACTION_ID,
      USER_TASK_QUEUE_CANCEL_ACTION_ID,
    ]);
    for (const e of actions.elements) expect(parseQueueActionValue(e.value)).toBe('utq_1');
    // Block Kit guardrail: no undocumented button fields.
    for (const e of actions.elements) expect(e).not.toHaveProperty('disabled');
  });

  it('says where it stands when others wait before it', () => {
    const { blocks } = buildQueuedNotice({ entryId: 'utq_2', position: 3, limit: 2, running, waitingCount: 3 });
    const body = allText(blocks);
    expect(body).toContain('3번째');
    expect(body).toContain('2개');
  });

  it('escapes a title that would break mrkdwn and falls back when a link is missing', () => {
    const { blocks } = buildQueuedNotice({
      entryId: 'utq_3',
      position: 1,
      limit: 1,
      running: [{ title: 'a <b> & *c*', link: undefined }],
      waitingCount: 1,
    });
    const body = allText(blocks);
    expect(body).not.toContain('<b>');
    expect(body).toContain('&lt;b&gt;');
  });
});

describe('the other notices', () => {
  it('started: no buttons left', () => {
    const turn = buildStartedNotice('turn');
    expect(turn.text).toContain('시작');
    expect(turn.blocks.some((b: any) => b.type === 'actions')).toBe(false);
    const bypass = buildStartedNotice('bypass', { title: '로그인 버그 고치기', link: 'https://l' });
    expect(allText(bypass.blocks)).toContain('뒤로 미뤘습니다');
  });

  it('cancelled and deferred say what happened', () => {
    expect(buildCancelledNotice().text).toContain('취소');
    const deferred = buildDeferredNotice({ title: '새 작업', link: 'https://n' });
    expect(deferred.text).toContain('멈췄습니다');
    expect(allText(deferred.blocks)).toContain('이어서');
  });

  it('parses only its own button values', () => {
    expect(parseQueueActionValue('utq:abc')).toBe('abc');
    expect(parseQueueActionValue('nope')).toBeUndefined();
    expect(parseQueueActionValue(undefined)).toBeUndefined();
  });
});

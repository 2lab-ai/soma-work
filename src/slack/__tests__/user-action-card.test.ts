import { inspectUserActionScript, type UserActionRecord } from 'somalib/user-action/user-action';
import { describe, expect, it } from 'vitest';
import {
  buildUserActionCard,
  parseUserActionButtonValue,
  USER_ACTION_DONE_ACTION_ID,
  USER_ACTION_FAILED_ACTION_ID,
} from '../user-action-card';

function record(over: Partial<UserActionRecord> = {}): UserActionRecord {
  const script = over.script ?? "open 'https://myaccount.google.com/video-verification/submit'";
  return {
    id: 'ua_1',
    title: '동영상 인증 페이지 열기',
    host: 'owner-mac',
    why: '채널 소유자 본인 얼굴 인증이라 봇이 대신할 수 없다.',
    script,
    shell: 'bash',
    expect: '브라우저에 인증 페이지가 열린다',
    effects: '페이지 하나를 연다.',
    optional: false,
    createdAt: 1,
    status: 'pending',
    inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
    ...over,
  };
}

const allText = (card: ReturnType<typeof buildUserActionCard>) => JSON.stringify(card);

describe('buildUserActionCard', () => {
  it('is its own section: a colored attachment headed 사용자 작업, not a question form', () => {
    const card = buildUserActionCard(record(), 'work:C1:1.0');
    expect(card.attachments).toHaveLength(1);
    expect(card.attachments[0].color).toMatch(/^#/);
    expect(card.text).toContain('사용자 작업');
    expect(card.text).toContain('동영상 인증 페이지 열기');
    expect(allText(card)).not.toContain('user_choice');
  });

  it('shows where to run it, the script in a code block, and what success looks like', () => {
    const t = allText(buildUserActionCard(record(), 'work:C1:1.0'));
    expect(t).toContain('owner-mac');
    expect(t).toContain("```open 'https://myaccount.google.com/video-verification/submit'```");
    expect(t).toContain('브라우저에 인증 페이지가 열린다');
    expect(t).toContain('페이지 하나를 연다.');
  });

  it('shows the inspection: verdict, syntax check, the commands it runs and every finding', () => {
    const script = 'rm -rf ~/Downloads/old';
    const card = buildUserActionCard(
      record({
        script,
        inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
      }),
      'k',
    );
    const t = allText(card);
    expect(t).toContain('점검 결과');
    expect(t).toContain('주의');
    expect(t).toContain('bash -n');
    expect(t).toContain('`rm`');
    expect(t).toContain('재귀 삭제');
  });

  it('escapes mrkdwn in model text so it cannot mention or link', () => {
    const t = allText(buildUserActionCard(record({ title: '<!channel> 확인', why: '<@U999> 때문' }), 'k'));
    expect(t).not.toContain('<!channel>');
    expect(t).not.toContain('<@U999>');
    expect(t).toContain('&lt;!channel&gt;');
  });

  it('a pending card carries done / failed buttons whose value names the session and the action', () => {
    const card = buildUserActionCard(record(), 'work:C1:1.0');
    const actions = card.attachments[0].blocks.find((b: any) => b.type === 'actions');
    expect(actions.elements.map((e: any) => e.action_id)).toEqual([
      USER_ACTION_DONE_ACTION_ID,
      USER_ACTION_FAILED_ACTION_ID,
    ]);
    expect(parseUserActionButtonValue(actions.elements[0].value)).toEqual({ sessionKey: 'work:C1:1.0', id: 'ua_1' });
  });

  it('a resolved card has no buttons and says who resolved it', () => {
    const card = buildUserActionCard(record({ status: 'done', resolvedBy: 'U1', resolvedAt: 1_700_000_000_000 }), 'k');
    const blocks = card.attachments[0].blocks;
    expect(blocks.some((b: any) => b.type === 'actions')).toBe(false);
    expect(allText(card)).toContain('<@U1>');
    expect(allText(card)).toContain('완료');
  });

  it('marks an optional task as optional, with no alarm', () => {
    const t = buildUserActionCard(record({ optional: true }), 'k').text;
    expect(t).toContain('선택');
    expect(t).not.toContain('⚠️');
  });

  it('parseUserActionButtonValue rejects junk', () => {
    expect(parseUserActionButtonValue('nope')).toBeNull();
    expect(parseUserActionButtonValue(JSON.stringify({ id: 1 }))).toBeNull();
    expect(parseUserActionButtonValue(undefined)).toBeNull();
  });
});

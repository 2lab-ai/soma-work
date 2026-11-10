/**
 * #1131 — every kind that can be decided in one pass says so: a one-line summary of what an approval does, and
 * the choice ids that mean approve and deny (`batch`). A free question (session_question) carries no `batch` —
 * it is answered one at a time.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn((userId: string) => userId === 'UADMIN01'),
}));

import { botDeleteApproval } from '../bot-delete-decision';
import { envSkillApproval } from '../env-skill-admin-approval';
import { VALUE_KIND_ENV_SKILL_DENY, VALUE_KIND_ENV_SKILL_ONCE } from '../env-skill-permission-blocks';
import { mcpGrantApproval } from '../mcp-grant-decision';
import { newUserApproval } from '../new-user-decision';
import { sessionQuestionAdminApprovalAdapter } from '../session-question-admin-approval';

describe('admin approval batch fields (#1131)', () => {
  it('a new user: approve / deny, the user named in the summary, the risk kept', () => {
    const a = newUserApproval('U0USER01', 'alice', 1);
    expect(a.batch).toEqual({ approve: 'approve', deny: 'deny' });
    expect(a.summary).toBe('`alice` 님을 사용자로 추가');
    expect(a.risk).toBe('low');
    // No display name: the id stands in.
    expect(newUserApproval('U0USER02', '', 1).summary).toBe('`U0USER02` 님을 사용자로 추가');
  });

  it('an MCP grant: approve / deny, the tool, the level, the duration and the channel in the summary', () => {
    const write = mcpGrantApproval('r1', {
      tool_name: 'mcp_grant',
      input: { server: 'github', level: 'write', duration: '24h' },
      channel: 'C0CHAN01',
      user: 'U0USER01',
      created_at: 1,
      expires_at: 2,
    });
    expect(write.batch).toEqual({ approve: 'approve', deny: 'deny' });
    expect(write.summary).toBe('`mcp__github` 쓰기 권한 부여 (24h) — #C0CHAN01');
    expect(write.risk).toBe('medium');
    const read = mcpGrantApproval('r2', {
      tool_name: 'mcp_grant',
      input: { server: 'github', level: 'read', duration: '1h' },
      user: 'U0USER01',
      created_at: 1,
      expires_at: 2,
    });
    expect(read.summary).toBe('`mcp__github` 읽기 권한 부여 (1h)');
    expect(read.risk).toBe('low');
  });

  it('a bot-message delete: approve / deny, the channel and the preview in the summary', () => {
    const a = botDeleteApproval('r1', {
      requesterId: 'U0USER01',
      data: { targetChannel: 'C0CHAN01', targetTs: '1.2', preview: '배포 완료' },
      createdAt: 1,
    });
    expect(a.batch).toEqual({ approve: 'approve', deny: 'deny' });
    expect(a.summary).toBe('봇 메시지 삭제 — #C0CHAN01: 배포 완료');
    expect(a.risk).toBe('medium');
    const long = botDeleteApproval('r2', {
      requesterId: 'U0USER01',
      data: { targetChannel: 'C0CHAN01', targetTs: '1.2', preview: 'x'.repeat(200) },
      createdAt: 1,
    });
    expect(long.summary?.length).toBeLessThanOrEqual(120);
    expect(
      botDeleteApproval('r3', {
        requesterId: 'U0USER01',
        data: { targetChannel: 'C0CHAN01', targetTs: '1.2' },
        createdAt: 1,
      }).summary,
    ).toBe('봇 메시지 삭제 — #C0CHAN01');
  });

  it('an environment skill: approve is the narrowest grant (once, this thread), deny is deny; risk medium', () => {
    const a = envSkillApproval({
      requestId: 'r1',
      operation: 'invoke',
      requesterId: 'U0USER01',
      ownerId: 'env',
      skillName: 'acme-env:post-deploy',
      channel: 'C0CHAN01',
      threadTs: '1.2',
      createdAt: 1,
      expiresAt: 2,
      handled: false,
    });
    expect(a.batch).toEqual({ approve: VALUE_KIND_ENV_SKILL_ONCE, deny: VALUE_KIND_ENV_SKILL_DENY });
    expect(a.summary).toBe('환경 스킬 `acme-env:post-deploy` 1회 실행 허용 — #C0CHAN01');
    expect(a.risk).toBe('medium');
    // The batch choices are among the card's own choices.
    expect(a.choices?.map((c) => c.id)).toEqual(expect.arrayContaining([a.batch?.approve, a.batch?.deny]));
  });

  it('an agent question is never batchable', () => {
    const adapter = sessionQuestionAdminApprovalAdapter({
      sessions: () => [
        [
          'C0CHAN01:root',
          {
            ownerId: 'U0USER01',
            channelId: 'C0CHAN01',
            threadRootTs: 'root',
            activityState: 'waiting',
            actionPanel: {
              choiceMessageTs: 'cts',
              pendingChoice: { kind: 'single', turnId: 't1', choiceTs: 'cts', formIds: [], createdAt: 1 },
              pendingQuestion: {
                type: 'user_choice',
                audience: 'admins',
                question: '배포할까요?',
                choices: [
                  { id: 'approve', label: '승인' },
                  { id: 'deny', label: '거부' },
                ],
              },
            },
          } as any,
        ],
      ],
      answer: vi.fn(),
      now: () => 1,
    });
    const [card] = adapter.pending(0) as any[];
    expect(card).toBeDefined();
    expect(card.batch).toBeUndefined();
  });
});

import * as fs from 'node:fs';
import { getVerbosityFlags, LOG_DETAIL, LOG_MINIMAL } from '@soma/slack/output-flags';
import { setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';
import type { WorkLogInput } from '@soma/slack/work-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillForceHandler } from '../skill-force-handler';

vi.mock('node:fs');

vi.mock('../../../env-paths', () => ({ PLUGINS_DIR: '/mock/plugins', DATA_DIR: '/mock/data' }));
vi.mock('../../../path-utils', () => ({
  isSafePathSegment: (s: string) => !!s && !s.includes('/') && !s.includes('..'),
}));

/**
 * The RPG banner of a non-deferred forced `$skill` reaches the thread only when
 * the session's mask carries `SKILL_INVOCATION` (compact and above). It is
 * recorded in the conversation's work log as a `notice` at every level, so at
 * `minimal` the dashboard still shows the skill fired. The `<invoked_skills>`
 * block is never gated — the skill must still execute.
 */
describe('SkillForceHandler — banner follows the session verbosity', () => {
  const mockSay = vi.fn().mockResolvedValue({ ts: '1' });
  const makeCtx = (text: string) => ({ user: 'U1', channel: 'C1', threadTs: '171.100', text, say: mockSay });

  const recorded: Array<[string, WorkLogInput]> = [];

  function handlerFor(session: Record<string, unknown> | undefined) {
    const getSession = vi.fn().mockReturnValue(session);
    const handler = new SkillForceHandler(undefined, { claudeHandler: { getSession } as any });
    return { handler, getSession };
  }

  const bannerPosts = () =>
    mockSay.mock.calls.filter(([arg]) => Array.isArray(arg?.attachments) && arg.attachments[0]?.color === '#FF0000');

  beforeEach(() => {
    vi.clearAllMocks();
    recorded.length = 0;
    setStreamExecutorProviders({
      appendWorkLog: (conversationId, entry) => {
        recorded.push([conversationId, entry]);
      },
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('# Z Skill');
  });

  afterEach(() => {
    setStreamExecutorProviders({ appendWorkLog: () => {} });
  });

  it('minimal: no banner post, one work-log notice, and the skill still executes', async () => {
    const { handler, getSession } = handlerFor({ logVerbosity: LOG_MINIMAL, conversationId: 'conv-1' });

    const result = await handler.execute(makeCtx('$local:z'));

    expect(getSession).toHaveBeenCalledWith('C1', '171.100');
    expect(bannerPosts()).toHaveLength(0);
    expect(mockSay).not.toHaveBeenCalled();
    expect(recorded).toEqual([
      ['conv-1', { kind: 'notice', text: expect.stringContaining('강제 발동'), ts: expect.any(Number) }],
    ]);
    expect(recorded[0][1].text).toContain('`local:z`');
    expect(recorded[0][1].turnId).toBeUndefined();
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('<invoked_skills>');
    expect(result.continueWithPrompt).toContain('<local:z>');
  });

  it.each([
    ['compact', getVerbosityFlags('compact')],
    ['detail', LOG_DETAIL],
    ['verbose', getVerbosityFlags('verbose')],
    ['unset (read as detail)', undefined],
  ])('%s: banner posted as today, and recorded', async (_label, mask) => {
    const { handler } = handlerFor({ logVerbosity: mask, conversationId: 'conv-1' });

    const result = await handler.execute(makeCtx('$local:z'));

    const posts = bannerPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0][0].thread_ts).toBe('171.100');
    expect(posts[0][0].attachments[0].text).toContain('강제 발동');
    expect(recorded).toEqual([
      ['conv-1', { kind: 'notice', text: posts[0][0].attachments[0].text, ts: expect.any(Number) }],
    ]);
    expect(result.continueWithPrompt).toContain('<invoked_skills>');
  });

  it('no session and no settings store in scope: banner posted (mask read as detail), nothing recorded', async () => {
    const { handler } = handlerFor(undefined);

    await handler.execute(makeCtx('$local:z'));

    expect(bannerPosts()).toHaveLength(1);
    expect(recorded).toEqual([]);
  });

  describe('no session in scope: the requesting user default verbosity decides', () => {
    function handlerWithUserDefault(mask: number) {
      const getUserLogVerbosityFlags = vi.fn().mockReturnValue(mask);
      const handler = new SkillForceHandler(undefined, {
        claudeHandler: { getSession: vi.fn().mockReturnValue(undefined) } as any,
        userSettingsStore: { getUserLogVerbosityFlags } as any,
      });
      return { handler, getUserLogVerbosityFlags };
    }

    it('user default minimal: no post, nothing recorded, the skill still executes', async () => {
      const { handler, getUserLogVerbosityFlags } = handlerWithUserDefault(LOG_MINIMAL);

      const result = await handler.execute(makeCtx('$local:z'));

      expect(getUserLogVerbosityFlags).toHaveBeenCalledWith('U1');
      expect(mockSay).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
      expect(result.continueWithPrompt).toContain('<invoked_skills>');
    });

    it('user default compact: banner posted', async () => {
      const { handler } = handlerWithUserDefault(getVerbosityFlags('compact'));

      await handler.execute(makeCtx('$local:z'));

      expect(bannerPosts()).toHaveLength(1);
    });

    it('a found session wins over the user default', async () => {
      const getUserLogVerbosityFlags = vi.fn().mockReturnValue(LOG_MINIMAL);
      const handler = new SkillForceHandler(undefined, {
        claudeHandler: { getSession: vi.fn().mockReturnValue({ logVerbosity: LOG_DETAIL }) } as any,
        userSettingsStore: { getUserLogVerbosityFlags } as any,
      });

      await handler.execute(makeCtx('$local:z'));

      expect(bannerPosts()).toHaveLength(1);
      expect(getUserLogVerbosityFlags).not.toHaveBeenCalled();
    });
  });

  it('minimal session without a conversation: no post, nothing recorded', async () => {
    const { handler } = handlerFor({ logVerbosity: LOG_MINIMAL });

    const result = await handler.execute(makeCtx('$local:z'));

    expect(mockSay).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    expect(result.continueWithPrompt).toContain('<invoked_skills>');
  });

  it('deferred fire is not announced here — the banner rides out on deferredSkillFire', async () => {
    const { handler } = handlerFor({ logVerbosity: LOG_MINIMAL, conversationId: 'conv-1' });

    const result = await handler.execute({ ...makeCtx('$local:z'), deferSkillFire: true });

    expect(mockSay).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    expect(result.deferredSkillFire?.banner.text).toContain('강제 발동');
  });
});

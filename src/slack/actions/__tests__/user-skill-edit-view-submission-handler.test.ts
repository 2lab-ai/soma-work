import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as userSkillStore from '../../../user-skill-store';
import { UserSkillEditViewSubmissionHandler } from '../user-skill-edit-view-submission-handler';

vi.mock('../../../user-skill-store');

const HASH = 'h'.repeat(32);

const buildMeta = (
  overrides: {
    requesterId?: string;
    skillName?: string;
    channelId?: string;
    threadTs?: string;
    messageTs?: string;
    contentHash?: string;
  } = {},
) =>
  JSON.stringify({
    requesterId: overrides.requesterId ?? 'U1',
    skillName: overrides.skillName ?? 'a',
    channelId: overrides.channelId ?? 'C1',
    threadTs: overrides.threadTs ?? 'thread-ts',
    messageTs: overrides.messageTs ?? '',
    contentHash: overrides.contentHash ?? HASH,
  });

const buildBody = (overrides: { submitterId?: string; privateMetadata?: string; bodyValue?: string | null } = {}) => ({
  user: { id: overrides.submitterId ?? 'U1' },
  view: {
    private_metadata: overrides.privateMetadata ?? buildMeta(),
    state: {
      values:
        overrides.bodyValue === null
          ? {}
          : {
              // input block_id / action_id pair must match the modal builder.
              user_skill_edit_body: {
                user_skill_edit_value: { value: overrides.bodyValue ?? 'NEW BODY' },
              },
            },
    },
  },
});

describe('UserSkillEditViewSubmissionHandler', () => {
  let slackApi: any;
  let ack: any;
  let client: any;
  let handler: UserSkillEditViewSubmissionHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    slackApi = {
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph' }),
    };
    ack = vi.fn().mockResolvedValue(undefined);
    client = {};

    handler = new UserSkillEditViewSubmissionHandler({ slackApi });

    // Defaults — every test starts with a single-file skill whose hash matches.
    vi.mocked(userSkillStore.isValidSkillName).mockImplementation((name: string) => /^[a-z0-9][a-z0-9-]*$/.test(name));
    vi.mocked(userSkillStore.getUserSkill).mockReturnValue({
      name: 'a',
      description: '',
      content: 'CURRENT',
    });
    vi.mocked(userSkillStore.isSingleFileSkill).mockReturnValue(true);
    vi.mocked(userSkillStore.computeContentHash).mockReturnValue(HASH);
    vi.mocked(userSkillStore.updateUserSkill).mockReturnValue({
      ok: true,
      message: 'Skill "a" updated.',
    });
  });

  it('returns inline error when private_metadata is missing/invalid', async () => {
    await handler.handleSubmit(ack, buildBody({ privateMetadata: 'not-json' }), client);

    expect(ack).toHaveBeenCalledTimes(1);
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe('errors');
    expect(Object.values(arg.errors)[0]).toMatch(/메타데이터/);
    expect(userSkillStore.updateUserSkill).not.toHaveBeenCalled();
  });

  it('returns inline error when submitter id !== requesterId', async () => {
    await handler.handleSubmit(ack, buildBody({ submitterId: 'U-other' }), client);

    expect(ack).toHaveBeenCalledTimes(1);
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe('errors');
    expect(Object.values(arg.errors)[0]).toMatch(/권한/);
    expect(userSkillStore.updateUserSkill).not.toHaveBeenCalled();
  });

  it('returns inline error when skillName fails the kebab-case pattern', async () => {
    await handler.handleSubmit(ack, buildBody({ privateMetadata: buildMeta({ skillName: 'Bad_Name' }) }), client);

    expect(ack).toHaveBeenCalledTimes(1);
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe('errors');
    expect(Object.values(arg.errors)[0]).toMatch(/잘못된/);
  });

  it('returns inline error when the skill no longer exists', async () => {
    vi.mocked(userSkillStore.getUserSkill).mockReturnValue(null);

    await handler.handleSubmit(ack, buildBody(), client);

    expect(ack).toHaveBeenCalledTimes(1);
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe('errors');
    expect(Object.values(arg.errors)[0]).toMatch(/존재하지 않/);
  });

  it('returns inline error when the skill became multi-file mid-edit', async () => {
    vi.mocked(userSkillStore.isSingleFileSkill).mockReturnValue(false);

    await handler.handleSubmit(ack, buildBody(), client);

    expect(ack).toHaveBeenCalledTimes(1);
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe('errors');
    expect(Object.values(arg.errors)[0]).toMatch(/멀티 파일|MANAGE_SKILL/i);
    expect(userSkillStore.updateUserSkill).not.toHaveBeenCalled();
  });

  it('returns inline error on hash mismatch (concurrent modification)', async () => {
    vi.mocked(userSkillStore.computeContentHash).mockReturnValue('different-hash'.padEnd(32, '0'));

    await handler.handleSubmit(ack, buildBody(), client);

    expect(ack).toHaveBeenCalledTimes(1);
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe('errors');
    expect(Object.values(arg.errors)[0]).toMatch(/다른 곳에서 수정|stale/i);
    expect(userSkillStore.updateUserSkill).not.toHaveBeenCalled();
  });

  it('skips the store call entirely when newBody === current (no-op)', async () => {
    await handler.handleSubmit(ack, buildBody({ bodyValue: 'CURRENT' }), client);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0][0]).toEqual({ response_action: 'clear' });
    expect(userSkillStore.updateUserSkill).not.toHaveBeenCalled();
    // Still posts an ephemeral confirming no-op (transparency).
    expect(slackApi.postEphemeral).toHaveBeenCalledTimes(1);
    expect(slackApi.postEphemeral.mock.calls[0][2]).toMatch(/변경 없음/);
  });

  it('returns inline error when the input block is missing entirely', async () => {
    await handler.handleSubmit(ack, buildBody({ bodyValue: null }), client);

    expect(ack).toHaveBeenCalledTimes(1);
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe('errors');
    expect(Object.values(arg.errors)[0]).toMatch(/본문 입력/);
  });

  it('passes new body to updateUserSkill verbatim and ack-clears on success', async () => {
    await handler.handleSubmit(ack, buildBody({ bodyValue: 'NEXT' }), client);

    expect(userSkillStore.updateUserSkill).toHaveBeenCalledWith('U1', 'a', 'NEXT');
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0][0]).toEqual({ response_action: 'clear' });
    expect(slackApi.postEphemeral).toHaveBeenCalledTimes(1);
    const epArgs = slackApi.postEphemeral.mock.calls[0];
    expect(epArgs[0]).toBe('C1');
    expect(epArgs[1]).toBe('U1');
    expect(epArgs[2]).toMatch(/저장됨/);
    expect(epArgs[3]).toBe('thread-ts');
  });

  it('surfaces updateUserSkill failure as an inline error', async () => {
    vi.mocked(userSkillStore.updateUserSkill).mockReturnValue({
      ok: false,
      message: 'Skill exceeds max size (10KB).',
    });

    await handler.handleSubmit(ack, buildBody({ bodyValue: 'NEXT' }), client);

    expect(ack).toHaveBeenCalledTimes(1);
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe('errors');
    expect(Object.values(arg.errors)[0]).toMatch(/exceeds max size/);
  });

  it('does not bubble postEphemeral transport failures', async () => {
    slackApi.postEphemeral.mockRejectedValueOnce(new Error('slack 5xx'));

    // Should not throw.
    await expect(handler.handleSubmit(ack, buildBody({ bodyValue: 'NEXT' }), client)).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0][0]).toEqual({ response_action: 'clear' });
  });

  it('falls back to a generic ack(errors) when an unexpected exception is thrown', async () => {
    vi.mocked(userSkillStore.getUserSkill).mockImplementation(() => {
      throw new Error('disk full');
    });

    await handler.handleSubmit(ack, buildBody(), client);

    expect(ack).toHaveBeenCalledTimes(1);
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe('errors');
    expect(Object.values(arg.errors)[0]).toMatch(/예상치 못한|unexpected/i);
  });
});

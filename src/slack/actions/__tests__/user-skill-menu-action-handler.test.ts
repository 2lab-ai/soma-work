import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as userSkillStore from '../../../user-skill-store';
import { UserSkillMenuActionHandler } from '../user-skill-menu-action-handler';

vi.mock('../../../user-skill-store');

describe('UserSkillMenuActionHandler', () => {
  let slackApi: any;
  let claudeHandler: any;
  let messageHandler: any;
  let respond: any;
  let viewsOpen: any;
  let client: any;
  let handler: UserSkillMenuActionHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    slackApi = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
    };
    claudeHandler = {};
    messageHandler = vi.fn().mockResolvedValue(undefined);
    respond = vi.fn().mockResolvedValue(undefined);
    viewsOpen = vi.fn().mockResolvedValue({ ok: true });
    client = { views: { open: viewsOpen } };

    handler = new UserSkillMenuActionHandler({
      slackApi,
      claudeHandler,
      messageHandler,
    });

    // Sensible defaults — individual tests override.
    vi.mocked(userSkillStore.isValidSkillName).mockImplementation((name: string) => /^[a-z0-9][a-z0-9-]*$/.test(name));
    vi.mocked(userSkillStore.userSkillExists).mockReturnValue(true);
    vi.mocked(userSkillStore.isSingleFileSkill).mockReturnValue(true);
    vi.mocked(userSkillStore.getUserSkill).mockReturnValue({
      name: 'a',
      description: 'sk',
      content: 'BODY',
    });
    vi.mocked(userSkillStore.computeContentHash).mockReturnValue('a'.repeat(32));
    Object.defineProperty(userSkillStore, 'MAX_INLINE_EDIT_CHARS', {
      value: 3000,
      configurable: true,
    });
  });

  // ---------- helpers ----------

  const makeButtonBody = (
    overrides: { value?: any; userId?: string; channel?: string; messageTs?: string; triggerId?: string } = {},
  ) => ({
    actions: [
      {
        type: 'button',
        value:
          overrides.value !== undefined
            ? typeof overrides.value === 'string'
              ? overrides.value
              : JSON.stringify(overrides.value)
            : JSON.stringify({
                kind: 'user_skill_invoke',
                skillName: 'a',
                requesterId: 'U1',
              }),
      },
    ],
    user: { id: overrides.userId ?? 'U1' },
    channel: { id: overrides.channel ?? 'C1' },
    message: { ts: overrides.messageTs ?? 'msg-ts', thread_ts: 'thread-ts' },
    trigger_id: overrides.triggerId,
  });

  const makeOverflowBody = (
    overrides: {
      kind?: 'user_skill_invoke' | 'user_skill_edit';
      skillName?: string;
      requesterId?: string;
      userId?: string;
      triggerId?: string;
    } = {},
  ) => ({
    actions: [
      {
        type: 'overflow',
        selected_option: {
          value: JSON.stringify({
            kind: overrides.kind ?? 'user_skill_edit',
            skillName: overrides.skillName ?? 'a',
            requesterId: overrides.requesterId ?? 'U1',
          }),
        },
      },
    ],
    user: { id: overrides.userId ?? 'U1' },
    channel: { id: 'C1' },
    message: { ts: 'msg-ts', thread_ts: 'thread-ts' },
    trigger_id: overrides.triggerId ?? 'trig-1',
  });

  // ---------- invoke (BC button) ----------

  describe('invoke (BC button)', () => {
    it('rejects clickers other than the requester (ephemeral, no re-injection)', async () => {
      await handler.handleAction(makeButtonBody({ userId: 'U2' }), respond, client);

      expect(respond).toHaveBeenCalledTimes(1);
      const arg = respond.mock.calls[0][0];
      expect(arg.response_type).toBe('ephemeral');
      expect(arg.text).toMatch(/U1/);
      expect(messageHandler).not.toHaveBeenCalled();
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
    });

    it('blocks invocation when the skill no longer exists (stale click)', async () => {
      vi.mocked(userSkillStore.userSkillExists).mockReturnValue(false);

      await handler.handleAction(makeButtonBody(), respond, client);

      expect(respond).toHaveBeenCalledTimes(1);
      const arg = respond.mock.calls[0][0];
      expect(arg.response_type).toBe('ephemeral');
      expect(arg.text).toMatch(/존재하지 않습니다|not found|deleted/i);
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('replaces the buttons message and re-injects "$user:{name}" when valid', async () => {
      vi.mocked(userSkillStore.userSkillExists).mockReturnValue(true);

      await handler.handleAction(makeButtonBody(), respond, client);

      // Buttons replaced
      expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
      const updateArgs = slackApi.updateMessage.mock.calls[0];
      expect(updateArgs[0]).toBe('C1');
      expect(updateArgs[1]).toBe('msg-ts');
      expect(updateArgs[4]).toEqual([]); // attachments cleared

      // $user:{name} re-injected with requesterId as user
      expect(messageHandler).toHaveBeenCalledTimes(1);
      const event = messageHandler.mock.calls[0][0];
      expect(event.user).toBe('U1');
      expect(event.channel).toBe('C1');
      expect(event.text).toBe('$user:a');
      expect(event.thread_ts).toBe('thread-ts');
      expect(respond).not.toHaveBeenCalled();
    });

    it('silently drops malformed JSON values (no throw, no side effects)', async () => {
      await handler.handleAction(makeButtonBody({ value: '{not json' }), respond, client);

      expect(messageHandler).not.toHaveBeenCalled();
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
    });

    it('rejects skill names that fail the kebab-case pattern (defense)', async () => {
      await handler.handleAction(
        makeButtonBody({ value: { kind: 'user_skill_invoke', skillName: '../etc/passwd', requesterId: 'U1' } }),
        respond,
        client,
      );

      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('uses messageTs as thread_ts fallback when message.thread_ts is absent', async () => {
      const body = makeButtonBody();
      delete (body.message as any).thread_ts;

      await handler.handleAction(body, respond, client);

      expect(messageHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler.mock.calls[0][0].thread_ts).toBe('msg-ts');
    });
  });

  // ---------- invoke (overflow option, kind=invoke) ----------

  describe('invoke (overflow option)', () => {
    it('dispatches the same flow as the BC button when kind=user_skill_invoke', async () => {
      await handler.handleAction(makeOverflowBody({ kind: 'user_skill_invoke' }), respond, client);

      expect(messageHandler).toHaveBeenCalledTimes(1);
      const event = messageHandler.mock.calls[0][0];
      expect(event.text).toBe('$user:a');
      expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- edit (overflow option, kind=edit) ----------

  describe('edit (overflow option)', () => {
    it('opens the inline-edit modal with private_metadata carrying the content hash', async () => {
      await handler.handleAction(makeOverflowBody({ kind: 'user_skill_edit' }), respond, client);

      expect(viewsOpen).toHaveBeenCalledTimes(1);
      const args = viewsOpen.mock.calls[0][0];
      expect(args.trigger_id).toBe('trig-1');
      const view = args.view;
      expect(view.callback_id).toBe('user_skill_edit_modal_submit');
      const meta = JSON.parse(view.private_metadata);
      expect(meta).toMatchObject({
        requesterId: 'U1',
        skillName: 'a',
        channelId: 'C1',
        threadTs: 'thread-ts',
        contentHash: 'a'.repeat(32),
      });
      // initial_value should match the SKILL.md the menu handler captured.
      const inputBlock = view.blocks.find((b: any) => b.type === 'input');
      expect(inputBlock.element.initial_value).toBe('BODY');
      // No re-injection / message update on edit.
      expect(messageHandler).not.toHaveBeenCalled();
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
    });

    it('fails closed with an ephemeral when the skill no longer exists', async () => {
      // getUserSkill returns null on missing skill — that IS the stale guard
      // for the edit branch (no separate listUserSkills enumeration).
      vi.mocked(userSkillStore.getUserSkill).mockReturnValue(null);

      await handler.handleAction(makeOverflowBody({ kind: 'user_skill_edit' }), respond, client);

      expect(viewsOpen).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0][0].text).toMatch(/존재하지 않/);
    });

    it('fails closed with an ephemeral when the skill became multi-file', async () => {
      vi.mocked(userSkillStore.isSingleFileSkill).mockReturnValue(false);

      await handler.handleAction(makeOverflowBody({ kind: 'user_skill_edit' }), respond, client);

      expect(viewsOpen).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0][0].text).toMatch(/multi.file|멀티 파일/i);
    });

    it('fails closed with an ephemeral when the body exceeds MAX_INLINE_EDIT_CHARS', async () => {
      vi.mocked(userSkillStore.getUserSkill).mockReturnValue({
        name: 'a',
        description: '',
        content: 'x'.repeat(3001),
      });

      await handler.handleAction(makeOverflowBody({ kind: 'user_skill_edit' }), respond, client);

      expect(viewsOpen).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0][0].text).toMatch(/너무 깁니다|too long/i);
    });

    it('fails closed with an ephemeral when trigger_id is missing', async () => {
      const body = makeOverflowBody({ kind: 'user_skill_edit' });
      delete (body as any).trigger_id;

      await handler.handleAction(body, respond, client);

      expect(viewsOpen).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0][0].text).toMatch(/trigger/i);
    });

    it('rejects edit when clicker !== requester (no views.open)', async () => {
      await handler.handleAction(makeOverflowBody({ kind: 'user_skill_edit', userId: 'U-other' }), respond, client);

      expect(viewsOpen).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0][0].response_type).toBe('ephemeral');
    });

    it('surfaces views.open transport failure as an ephemeral', async () => {
      viewsOpen.mockRejectedValueOnce(new Error('boom'));

      await handler.handleAction(makeOverflowBody({ kind: 'user_skill_edit' }), respond, client);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0][0].text).toMatch(/실패|fail/i);
    });
  });

  // ---------- delete (overflow option, kind=delete) — issue #774 ----------

  describe('delete (overflow option)', () => {
    const makeDeleteBody = (overrides: { userId?: string; triggerId?: string | null } = {}) => ({
      actions: [
        {
          type: 'overflow',
          selected_option: {
            value: JSON.stringify({
              kind: 'user_skill_delete',
              skillName: 'a',
              requesterId: 'U1',
            }),
          },
        },
      ],
      user: { id: overrides.userId ?? 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'msg-ts', thread_ts: 'thread-ts' },
      trigger_id: overrides.triggerId === null ? undefined : (overrides.triggerId ?? 'trig-1'),
    });

    it('opens the delete confirmation modal when the skill exists', async () => {
      await handler.handleAction(makeDeleteBody(), respond, client);

      expect(viewsOpen).toHaveBeenCalledTimes(1);
      const view = viewsOpen.mock.calls[0][0].view;
      expect(view.callback_id).toBe('user_skill_delete_modal_submit');
      const meta = JSON.parse(view.private_metadata);
      expect(meta).toMatchObject({
        requesterId: 'U1',
        skillName: 'a',
        channelId: 'C1',
      });
      // No re-injection / message update on delete-click.
      expect(messageHandler).not.toHaveBeenCalled();
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
    });

    it('rejects delete when clicker !== requester (no views.open)', async () => {
      await handler.handleAction(makeDeleteBody({ userId: 'U-other' }), respond, client);
      expect(viewsOpen).not.toHaveBeenCalled();
      expect(respond.mock.calls[0][0].response_type).toBe('ephemeral');
    });

    it('fails closed with an ephemeral when the skill no longer exists', async () => {
      vi.mocked(userSkillStore.userSkillExists).mockReturnValue(false);
      await handler.handleAction(makeDeleteBody(), respond, client);
      expect(viewsOpen).not.toHaveBeenCalled();
      expect(respond.mock.calls[0][0].text).toMatch(/존재하지 않/);
    });

    it('fails closed with an ephemeral when trigger_id is missing', async () => {
      await handler.handleAction(makeDeleteBody({ triggerId: null }), respond, client);
      expect(viewsOpen).not.toHaveBeenCalled();
      expect(respond.mock.calls[0][0].text).toMatch(/trigger/i);
    });
  });

  // ---------- rename (overflow option, kind=rename) — issue #774 ----------

  describe('rename (overflow option)', () => {
    const makeRenameBody = (overrides: { userId?: string; triggerId?: string | null } = {}) => ({
      actions: [
        {
          type: 'overflow',
          selected_option: {
            value: JSON.stringify({
              kind: 'user_skill_rename',
              skillName: 'a',
              requesterId: 'U1',
            }),
          },
        },
      ],
      user: { id: overrides.userId ?? 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'msg-ts', thread_ts: 'thread-ts' },
      trigger_id: overrides.triggerId === null ? undefined : (overrides.triggerId ?? 'trig-1'),
    });

    it('opens the rename modal pre-filled with the current name', async () => {
      await handler.handleAction(makeRenameBody(), respond, client);

      expect(viewsOpen).toHaveBeenCalledTimes(1);
      const view = viewsOpen.mock.calls[0][0].view;
      expect(view.callback_id).toBe('user_skill_rename_modal_submit');
      const meta = JSON.parse(view.private_metadata);
      expect(meta).toMatchObject({ requesterId: 'U1', skillName: 'a', channelId: 'C1' });
      // Input must pre-fill with the current name so a small edit
      // (e.g. typo fix) doesn't require retyping.
      const input = view.blocks.find((b: any) => b.type === 'input');
      expect(input.element.initial_value).toBe('a');
    });

    it('rejects rename when clicker !== requester', async () => {
      await handler.handleAction(makeRenameBody({ userId: 'U-other' }), respond, client);
      expect(viewsOpen).not.toHaveBeenCalled();
    });

    it('fails closed when the skill no longer exists', async () => {
      vi.mocked(userSkillStore.userSkillExists).mockReturnValue(false);
      await handler.handleAction(makeRenameBody(), respond, client);
      expect(viewsOpen).not.toHaveBeenCalled();
      expect(respond.mock.calls[0][0].text).toMatch(/존재하지 않/);
    });
  });

  // ---------- share (overflow option, kind=share) — issue #774 ----------

  describe('share (overflow option)', () => {
    const makeShareBody = (overrides: { userId?: string } = {}) => ({
      actions: [
        {
          type: 'overflow',
          selected_option: {
            value: JSON.stringify({
              kind: 'user_skill_share',
              skillName: 'a',
              requesterId: 'U1',
            }),
          },
        },
      ],
      user: { id: overrides.userId ?? 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'msg-ts', thread_ts: 'thread-ts' },
      trigger_id: 'trig-1',
    });

    it('posts an ephemeral with a four-backtick fenced SKILL.md (so triple-backtick examples round-trip)', async () => {
      const skillBody = ['---', 'name: a', '---', '', '```python', 'print("inner fence")', '```'].join('\n');
      vi.mocked(userSkillStore.shareUserSkill).mockReturnValue({
        ok: true,
        message: 'ok',
        content: skillBody,
      });

      await handler.handleAction(makeShareBody(), respond, client);

      expect(respond).toHaveBeenCalledTimes(1);
      const arg = respond.mock.calls[0][0];
      expect(arg.response_type).toBe('ephemeral');
      // Four-backtick fence is what the plan calls out so SKILL.md content
      // containing triple backticks (e.g. inline code examples) does NOT
      // chop the share message at the first inner fence.
      expect(arg.text).toContain('````');
      expect(arg.text).toContain('print("inner fence")');
      // The fence must wrap the body — count outer fences == 2.
      const fenceCount = (arg.text.match(/^````$/gm) || []).length;
      expect(fenceCount).toBe(2);
      // Read-only — no views.open, no message update, no re-injection.
      expect(viewsOpen).not.toHaveBeenCalled();
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('reports an ephemeral error when shareUserSkill fails (storage layer)', async () => {
      vi.mocked(userSkillStore.shareUserSkill).mockReturnValue({
        ok: false,
        message: 'Skill "a" not found.',
      });

      await handler.handleAction(makeShareBody(), respond, client);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0][0].text).toContain('not found');
    });

    it('reports an over-limit ephemeral when SKILL.md exceeds the share cap', async () => {
      // SHARE_CONTENT_CHAR_LIMIT === 2500 (skill-share-errors.ts).
      const oversized = 'x'.repeat(2501);
      vi.mocked(userSkillStore.shareUserSkill).mockReturnValue({
        ok: true,
        message: 'ok',
        content: oversized,
      });

      await handler.handleAction(makeShareBody(), respond, client);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0][0].text).toMatch(/exceeds share limit|2500/);
      // The over-limit branch must NOT leak the body — ephemeral text should
      // not contain the giant payload.
      expect(respond.mock.calls[0][0].text).not.toContain('xxxxx'.repeat(100));
    });

    it('rejects share when clicker !== requester', async () => {
      vi.mocked(userSkillStore.shareUserSkill).mockReturnValue({
        ok: true,
        message: 'ok',
        content: 'body',
      });

      await handler.handleAction(makeShareBody({ userId: 'U-other' }), respond, client);

      // Requester guard fires first → ephemeral, no shareUserSkill call.
      expect(userSkillStore.shareUserSkill).not.toHaveBeenCalled();
      expect(respond.mock.calls[0][0].response_type).toBe('ephemeral');
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserAutoskills: vi.fn(() => []),
    addUserAutoskill: vi.fn(() => true),
  },
}));

vi.mock('../../../skill-locator', () => ({
  autoskillExists: vi.fn(() => true),
}));

import { autoskillExists } from '../../../skill-locator';
import { userSettingsStore } from '../../../user-settings-store';
import { AUTOSKILL_ADD_BLOCK_ID, AUTOSKILL_ADD_SELECT_ACTION_ID } from '../../autoskill-blocks';
import { AutoskillAddViewSubmissionHandler } from '../autoskill-add-view-submission-handler';

const REQ = 'U_REQ';

function makeBody(selected: string[], metaOverrides: object = {}, user = REQ): any {
  const meta = { requesterId: REQ, channelId: 'C1', messageTs: 'm1', threadTs: 't1', ...metaOverrides };
  return {
    user: { id: user },
    view: {
      private_metadata: JSON.stringify(meta),
      state: {
        values: {
          [AUTOSKILL_ADD_BLOCK_ID]: {
            [AUTOSKILL_ADD_SELECT_ACTION_ID]: {
              selected_options: selected.map((v) => ({ value: v })),
            },
          },
        },
      },
    },
  };
}

describe('AutoskillAddViewSubmissionHandler', () => {
  let slackApi: { updateMessage: ReturnType<typeof vi.fn>; postEphemeral: ReturnType<typeof vi.fn> };
  let ack: any;
  let handler: AutoskillAddViewSubmissionHandler;

  beforeEach(() => {
    slackApi = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'e1' }),
    };
    ack = vi.fn().mockResolvedValue(undefined);
    handler = new AutoskillAddViewSubmissionHandler({ slackApi: slackApi as any });
    vi.mocked(autoskillExists).mockReturnValue(true);
    vi.mocked(userSettingsStore.addUserAutoskill).mockReturnValue(true);
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue(['using-ssot']);
  });

  afterEach(() => vi.clearAllMocks());

  it('adds the selected skills and clears the modal', async () => {
    await handler.handleSubmit(ack, makeBody(['using-ssot', 'using-govuk']));
    expect(userSettingsStore.addUserAutoskill).toHaveBeenCalledWith(REQ, 'using-ssot');
    expect(userSettingsStore.addUserAutoskill).toHaveBeenCalledWith(REQ, 'using-govuk');
    expect(ack).toHaveBeenCalledWith({ response_action: 'clear' });
    expect(slackApi.updateMessage).toHaveBeenCalled();
  });

  it('returns an inline error when nothing was selected', async () => {
    await handler.handleSubmit(ack, makeBody([]));
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        response_action: 'errors',
        errors: expect.objectContaining({ [AUTOSKILL_ADD_BLOCK_ID]: expect.any(String) }),
      }),
    );
    expect(userSettingsStore.addUserAutoskill).not.toHaveBeenCalled();
  });

  it('rejects a submitter who is not the requester', async () => {
    await handler.handleSubmit(ack, makeBody(['using-ssot'], {}, 'U_OTHER'));
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: 'errors' }));
    expect(userSettingsStore.addUserAutoskill).not.toHaveBeenCalled();
  });

  it('returns an inline error on malformed metadata', async () => {
    const body = { user: { id: REQ }, view: { private_metadata: 'nope', state: { values: {} } } };
    await handler.handleSubmit(ack, body);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: 'errors' }));
  });

  it('skips names that no longer resolve', async () => {
    vi.mocked(autoskillExists).mockImplementation((name: string) => name === 'using-ssot');
    await handler.handleSubmit(ack, makeBody(['using-ssot', 'ghost']));
    expect(userSettingsStore.addUserAutoskill).toHaveBeenCalledWith(REQ, 'using-ssot');
    expect(userSettingsStore.addUserAutoskill).not.toHaveBeenCalledWith(REQ, 'ghost');
    expect(ack).toHaveBeenCalledWith({ response_action: 'clear' });
  });
});

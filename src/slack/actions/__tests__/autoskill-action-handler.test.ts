import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserAutoskills: vi.fn(() => []),
    removeUserAutoskill: vi.fn(),
  },
}));

vi.mock('../../../skill-locator', () => ({
  listAvailableSkills: vi.fn(() => [{ name: 'using-ssot', source: 'local' }]),
}));

import { listAvailableSkills } from '../../../skill-locator';
import { userSettingsStore } from '../../../user-settings-store';
import { AUTOSKILL_ADD_OPEN_ACTION_ID, AUTOSKILL_REMOVE_ACTION_ID } from '../../autoskill-blocks';
import { AutoskillActionHandler } from '../autoskill-action-handler';

const REQ = 'U_REQ';

function makeBody(actionId: string, value: object, overrides: any = {}): any {
  return {
    actions: [{ action_id: actionId, value: JSON.stringify(value) }],
    user: { id: REQ },
    channel: { id: 'C1' },
    message: { ts: 'm1', thread_ts: 't1' },
    trigger_id: 'trig1',
    ...overrides,
  };
}

describe('AutoskillActionHandler', () => {
  let slackApi: { updateMessage: ReturnType<typeof vi.fn> };
  let client: { views: { open: ReturnType<typeof vi.fn> } };
  let respond: any;
  let handler: AutoskillActionHandler;

  beforeEach(() => {
    slackApi = { updateMessage: vi.fn().mockResolvedValue(undefined) };
    client = { views: { open: vi.fn().mockResolvedValue(undefined) } };
    respond = vi.fn().mockResolvedValue(undefined);
    handler = new AutoskillActionHandler({ slackApi: slackApi as any });
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue([]);
    vi.mocked(listAvailableSkills).mockReturnValue([{ name: 'using-ssot', source: 'local' }]);
  });

  afterEach(() => vi.clearAllMocks());

  it('rejects clicks from a non-owner without mutating', async () => {
    const body = makeBody(
      AUTOSKILL_REMOVE_ACTION_ID,
      { requesterId: REQ, skillName: 'a' },
      { user: { id: 'U_OTHER' } },
    );
    await handler.handleAction(body, respond, client as any);
    expect(userSettingsStore.removeUserAutoskill).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });

  it('remove deletes the skill and re-renders the card', async () => {
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue(['b']);
    const body = makeBody(AUTOSKILL_REMOVE_ACTION_ID, { requesterId: REQ, skillName: 'a' });
    await handler.handleAction(body, respond, client as any);
    expect(userSettingsStore.removeUserAutoskill).toHaveBeenCalledWith(REQ, 'a');
    expect(slackApi.updateMessage).toHaveBeenCalledWith('C1', 'm1', expect.any(String), expect.any(Array), []);
  });

  it('add-open opens the modal with the picker', async () => {
    const body = makeBody(AUTOSKILL_ADD_OPEN_ACTION_ID, { requesterId: REQ });
    await handler.handleAction(body, respond, client as any);
    expect(client.views.open).toHaveBeenCalledWith(
      expect.objectContaining({ trigger_id: 'trig1', view: expect.any(Object) }),
    );
  });

  it('add-open with nothing left to add responds ephemerally instead of opening a modal', async () => {
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue(['using-ssot']); // the only available skill
    const body = makeBody(AUTOSKILL_ADD_OPEN_ACTION_ID, { requesterId: REQ });
    await handler.handleAction(body, respond, client as any);
    expect(client.views.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });

  it('malformed value is ignored (no throw, no mutation)', async () => {
    const body = { actions: [{ action_id: AUTOSKILL_REMOVE_ACTION_ID, value: 'not-json' }], user: { id: REQ } };
    await handler.handleAction(body, respond, client as any);
    expect(userSettingsStore.removeUserAutoskill).not.toHaveBeenCalled();
  });
});

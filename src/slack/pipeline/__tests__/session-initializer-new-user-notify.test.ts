/**
 * #622 — the session initializer's new-user gate asks the admins through the
 * app's notifier, which records where each DM landed (so the dashboard card and
 * every admin's copy stay in sync), using the initializer's own Slack API.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../admin-utils', () => ({
  isAdminUser: (u: string) => u === 'U_ADMIN1' || u === 'U_ADMIN2',
  getAdminUsers: () => new Set(['U_ADMIN1', 'U_ADMIN2']),
}));

import { getAdminRequest } from '../../../admin-request-store';
import { DATA_DIR } from '../../../env-paths';
import { SessionInitializer } from '../session-initializer';

describe('new-user gate → admin notification (#622)', () => {
  it('posts one DM per admin through the initializer’s Slack API and records the round with every prompt', async () => {
    fs.rmSync(path.join(DATA_DIR, 'admin-requests.json'), { force: true });
    fs.rmSync(path.join(DATA_DIR, 'admin-requests.json.bak'), { force: true });
    const slackApi = {
      postMessage: vi.fn(async (channel: string) => ({ ts: `ts-${channel}`, channel: `D-${channel}` })),
      updateMessage: vi.fn(async () => undefined),
    };
    const init = new SessionInitializer({ slackApi } as any);
    await (init as any).notifyAdminsNewUser('U_NEW_GATE', 'Kim');
    expect(slackApi.postMessage.mock.calls.map((c) => c[0])).toEqual(['U_ADMIN1', 'U_ADMIN2']);
    expect(getAdminRequest('new_user', 'U_NEW_GATE')).toMatchObject({
      requesterId: 'U_NEW_GATE',
      handled: false,
      prompts: [
        { channel: 'D-U_ADMIN1', ts: 'ts-U_ADMIN1' },
        { channel: 'D-U_ADMIN2', ts: 'ts-U_ADMIN2' },
      ],
    });
  });
});

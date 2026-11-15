/**
 * .prd/26 §4.1 · A6 — the code changes API: the work log's readers only, the list without patches, one file's layers.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeChangesDoc } from '../../code-changes/types';

const VIEWER_TOKEN = 'test-token';
const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: VIEWER_TOKEN,
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};
const paths = vi.hoisted(() => ({ dataDir: '' }));

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  get DATA_DIR() {
    return paths.dataDir;
  },
}));
vi.mock('../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: vi.fn().mockReturnValue([]) }),
}));

const AUTH_HEADER = { Authorization: `Bearer ${VIEWER_TOKEN}` };
function userCookie(sub: string): string {
  const token = jwt.sign({ sub, email: `${sub}@x`, name: sub, provider: 'slack' }, VIEWER_TOKEN, { expiresIn: 3600 });
  return `soma_dash_token=${encodeURIComponent(token)}`;
}
const CONVERSATION = {
  id: 'conv-1',
  ownerId: 'U_OWNER',
  ownerName: 'Owner',
  title: 'W',
  workflow: 'default',
  createdAt: 1,
  updatedAt: 2,
  turns: [],
};

const DOC: CodeChangesDoc = {
  version: 1,
  conversationId: 'conv-1',
  owner: { id: 'U_OWNER', name: 'Owner' },
  updatedAt: 42,
  checkouts: [
    {
      id: 'c1',
      repo: 'acme/web',
      dir: 'web',
      branch: 'feat/x',
      uncommitted: {
        files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-x\n+y' }],
        additions: 1,
        deletions: 1,
      },
      committed: { files: [], additions: 0, deletions: 0, commits: [] },
    },
  ],
  prs: [],
  counted: { commits: ['abc'] },
};

describe('code changes API', () => {
  let web: typeof import('../web-server');
  let routes: typeof import('../code-changes-routes');

  beforeEach(async () => {
    vi.resetModules();
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-cc-route-'));
    web = await import('../web-server');
    routes = await import('../code-changes-routes');
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockImplementation(async (id: string) => (id === 'conv-1' ? CONVERSATION : null));
    const { getCodeChangesStore } = await import('../../code-changes/store');
    getCodeChangesStore().write(JSON.parse(JSON.stringify(DOC)));
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    routes.setCodeChangesRefresher(undefined);
    await web.stopWebServer();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  const get = (url: string, headers: Record<string, string> = AUTH_HEADER) =>
    web.injectWebServer({ method: 'GET', url, headers });

  it('401 without credentials, 404 for an unknown conversation, 403 for a signed-in non-owner (A6)', async () => {
    expect((await get('/api/dashboard/session/conv-1/changes', {})).statusCode).toBe(401);
    expect((await get('/api/dashboard/session/conv-nope/changes')).statusCode).toBe(404);
    const other = await get('/api/dashboard/session/conv-1/changes', { cookie: userCookie('U_OTHER') });
    expect(other.statusCode).toBe(403);
    expect(other.headers['cache-control']).toBe('no-store');
    const file = await get('/api/dashboard/session/conv-1/changes/file?repo=acme/web&path=src/a.ts', {
      cookie: userCookie('U_OTHER'),
    });
    expect(file.statusCode).toBe(403);
  });

  it('the owner reads the list without patches; refresh=1 waits for the host and answers the new snapshot', async () => {
    const { getCodeChangesStore } = await import('../../code-changes/store');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The host's run writes a newer snapshot, and only then resolves.
    const refresher = vi.fn(async () => {
      await gate;
      getCodeChangesStore().write({ ...JSON.parse(JSON.stringify(DOC)), updatedAt: 424242 });
      return true;
    });
    routes.setCodeChangesRefresher(refresher);
    let answered = false;
    const pending = get('/api/dashboard/session/conv-1/changes?refresh=1', { cookie: userCookie('U_OWNER') }).then(
      (r) => {
        answered = true;
        return r;
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(refresher).toHaveBeenCalledWith('conv-1');
    expect(answered).toBe(false);
    release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.doc.updatedAt).toBe(424242);
    expect(body.live).toBe(true);
    expect(body.doc.checkouts[0].uncommitted.files[0]).toEqual({
      path: 'src/a.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
    });
    expect(res.body).not.toContain('@@');
    expect(body.doc.counted.commits).toEqual([]);
  });

  it('one file: every layer with its patch; 404 when no layer has it; 400 without repo/path', async () => {
    const res = await get('/api/dashboard/session/conv-1/changes/file?repo=acme%2Fweb&path=src%2Fa.ts');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources).toEqual([{ layer: 'uncommitted', label: 'web', file: DOC.checkouts[0].uncommitted.files[0] }]);
    expect((await get('/api/dashboard/session/conv-1/changes/file?repo=acme/web&path=nope.ts')).statusCode).toBe(404);
    expect((await get('/api/dashboard/session/conv-1/changes/file?repo=acme/web')).statusCode).toBe(400);
  });

  it('a conversation with no document answers doc: null', async () => {
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockImplementation(async (id: string) =>
      id === 'conv-2' ? { ...CONVERSATION, id } : null,
    );
    const res = await get('/api/dashboard/session/conv-2/changes');
    expect(JSON.parse(res.body)).toEqual({ doc: null, live: false });
  });
});

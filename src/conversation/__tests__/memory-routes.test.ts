import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SSOT 2026-10-23 T3 — the "기억" tab's HTTP surface over the real memory
 * stores (vitest setup pins DATA_DIR to a scratch dir per file): view and edit
 * every personal memory — agent notes, user profile, knowledge pages (Current
 * and History), episodic days — for the signed-in user only, every edit
 * conditional on the revision the page loaded.
 */

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
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
  getArchiveStore: () => ({ listRecent: () => [] }),
}));

describe('memory routes (SSOT 2026-10-23 T3)', () => {
  let stopWebServer: any;
  let inject: any;
  let mem: typeof import('../../user-memory-store');
  let hier: typeof import('../../hierarchical-memory');
  let user = '';
  let seq = 0;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    inject = webServer.injectWebServer;
    mem = await import('../../user-memory-store');
    hier = await import('../../hierarchical-memory');
    await webServer.startWebServer({ listen: false });
    seq += 1;
    user = `UMEM${seq}`;
  });

  afterEach(async () => {
    await stopWebServer();
  });

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await inject({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json' };
  }

  async function call(method: string, url: string, payload?: unknown, who = user) {
    const res = await inject({
      method,
      url,
      headers: await signIn(who),
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  }

  it('GET shows both L1 stores with meters and revisions, every page, every episodic day', async () => {
    mem.addMemory(user, 'memory', '테스트 전에 빌드');
    mem.addMemory(user, 'user', '직접적인 말투');
    hier.hierarchicalMemoryStore.upsertPage(
      user,
      { type: 'agent', slug: 'ci' },
      { title: 'CI', current: 'runner 1대' },
    );
    hier.hierarchicalMemoryStore.appendEpisodic(user, 'old day', '2026-10-01');
    hier.hierarchicalMemoryStore.appendEpisodic(user, 'new day', '2026-10-22');
    const r = await call('GET', '/api/memory');
    expect(r.status).toBe(200);
    expect(r.body.l1.memory).toMatchObject({ entries: ['테스트 전에 빌드'], charLimit: 2200, perEntryCap: 660 });
    expect(r.body.l1.user.entries).toEqual(['직접적인 말투']);
    expect(r.body.l1.memory.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(r.body.pages.map((p: any) => p.id)).toEqual(['agent/ci']);
    expect(r.body.episodicDates).toEqual(['2026-10-22', '2026-10-01']);
  });

  it('L1: add, replace, delete and clear — each conditional on the loaded revision', async () => {
    mem.addMemory(user, 'memory', 'one');
    let rev = (await call('GET', '/api/memory')).body.l1.memory.revision;

    let r = await call('POST', '/api/memory/l1/memory', { text: 'two', revision: rev });
    expect(r.status).toBe(200);
    expect(r.body.l1.entries).toEqual(['one', 'two']);
    rev = r.body.l1.revision;

    r = await call('PUT', '/api/memory/l1/memory/0', { text: 'ONE', revision: rev });
    expect(r.body.l1.entries).toEqual(['ONE', 'two']);
    rev = r.body.l1.revision;

    r = await call('DELETE', '/api/memory/l1/memory/1', { revision: rev });
    expect(r.body.l1.entries).toEqual(['ONE']);
    rev = r.body.l1.revision;

    r = await call('DELETE', '/api/memory/l1/memory', { revision: rev });
    expect(r.body.l1.entries).toEqual([]);
    expect(mem.loadMemory(user, 'memory').entries).toEqual([]);
  });

  it('a stale revision is a 409 and nothing is written (the agent saved meanwhile)', async () => {
    mem.addMemory(user, 'user', 'a');
    const rev = (await call('GET', '/api/memory')).body.l1.user.revision;
    mem.addMemory(user, 'user', 'agent wrote this'); // SAVE_MEMORY in between
    const r = await call('DELETE', '/api/memory/l1/user/0', { revision: rev });
    expect(r.status).toBe(409);
    expect(mem.loadMemory(user, 'user').entries).toEqual(['a', 'agent wrote this']);
    expect((await call('POST', '/api/memory/l1/user', { text: 'x' })).status).toBe(400); // no revision
  });

  it('L1 limits match the store: an over-cap entry is refused with the reason', async () => {
    const rev = (await call('GET', '/api/memory')).body.l1.user.revision;
    const r = await call('POST', '/api/memory/l1/user', { text: 'x'.repeat(500), revision: rev });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('412');
  });

  it('pages: read Current + full History, replace everything (history lines too), create, delete', async () => {
    const store = hier.hierarchicalMemoryStore;
    store.upsertPage(user, { type: 'concepts', slug: 'ssot' }, { title: 'SSOT', current: 'v1', historyEntry: 'first' });
    store.upsertPage(user, { type: 'concepts', slug: 'ssot' }, { historyEntry: 'second' });
    let r = await call('GET', '/api/memory/page?id=concepts/ssot');
    expect(r.status).toBe(200);
    expect(r.body.page.history).toHaveLength(2);
    const rev = r.body.revision;

    r = await call('PUT', '/api/memory/page', {
      id: 'concepts/ssot',
      title: 'Single source',
      aliases: ['ssot', 'source of truth'],
      current: 'v2\n### detail',
      history: [r.body.page.history[1]],
      revision: rev,
    });
    expect(r.status).toBe(200);
    const page = store.getPage(user, { type: 'concepts', slug: 'ssot' })!;
    expect(page).toMatchObject({
      title: 'Single source',
      aliases: ['ssot', 'source of truth'],
      current: 'v2\n### detail',
    });
    expect(page.history).toHaveLength(1);

    // the same stale revision again → 409
    expect(
      (
        await call('PUT', '/api/memory/page', {
          id: 'concepts/ssot',
          title: 't',
          aliases: [],
          current: '',
          history: [],
          revision: rev,
        })
      ).status,
    ).toBe(409);

    // create with revision null; creating over an existing page → 409
    r = await call('PUT', '/api/memory/page', {
      id: 'agent/new',
      title: 'New',
      aliases: [],
      current: 'c',
      history: [],
      revision: null,
    });
    expect(r.status).toBe(200);
    expect(
      (
        await call('PUT', '/api/memory/page', {
          id: 'agent/new',
          title: 'New',
          aliases: [],
          current: 'c',
          history: [],
          revision: null,
        })
      ).status,
    ).toBe(409);

    // a Current line starting with "## " would be cut off on re-read → 400
    const newRev = (await call('GET', '/api/memory/page?id=agent/new')).body.revision;
    expect(
      (
        await call('PUT', '/api/memory/page', {
          id: 'agent/new',
          title: 'New',
          aliases: [],
          current: '## x',
          history: [],
          revision: newRev,
        })
      ).status,
    ).toBe(400);

    r = await call('DELETE', '/api/memory/page', { id: 'agent/new', revision: newRev });
    expect(r.status).toBe(200);
    expect(store.getPage(user, { type: 'agent', slug: 'new' })).toBeNull();
    expect((await call('GET', '/api/memory')).body.pages.map((p: any) => p.id)).toEqual(['concepts/ssot']);
  });

  it('a page the form cannot hold losslessly is never saved through the form; it is edited as raw markdown (review R3 P1)', async () => {
    const store = hier.hierarchicalMemoryStore;
    const fs = await import('node:fs');
    const path = await import('node:path');
    // written the way the agent writes it: a sub-heading inside Current, a multi-line History entry
    store.upsertPage(
      user,
      { type: 'concepts', slug: 'lossy' },
      { title: 'Lossy', current: 'intro\n## Details\nimportant text', historyEntry: 'line one\nline two' },
    );
    const { memoryRoot } = await import('somalib/model-commands/hierarchical-memory-store');
    const { DATA_DIR } = await import('../../env-paths');
    const file = path.join(memoryRoot(DATA_DIR, user), 'concepts', 'lossy.md');
    const before = fs.readFileSync(file, 'utf-8');
    expect(before).toContain('important text');

    let r = await call('GET', '/api/memory/page?id=concepts/lossy');
    expect(r.status).toBe(200);
    expect(r.body.representable).toBe(false);
    expect(r.body.raw).toBe(before);

    // the form path refuses — saving the parsed fields would drop "important text" and "line two"
    r = await call('PUT', '/api/memory/page', {
      id: 'concepts/lossy',
      title: 'Lossy renamed',
      aliases: [],
      current: r.body.page.current,
      history: r.body.page.history,
      revision: r.body.revision,
    });
    expect(r.status).toBe(400);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);

    // raw markdown: whatever the file holds can be edited, revision-checked
    const rev = (await call('GET', '/api/memory/page?id=concepts/lossy')).body.revision;
    const edited = before.replace('important text', 'important text, edited');
    r = await call('PUT', '/api/memory/page/raw', { id: 'concepts/lossy', raw: edited, revision: rev });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(file, 'utf-8')).toBe(edited);
    expect(
      (await call('PUT', '/api/memory/page/raw', { id: 'concepts/lossy', raw: before, revision: rev })).status,
    ).toBe(409);
    expect(
      (await call('PUT', '/api/memory/page/raw', { id: 'concepts/lossy', raw: '  ', revision: r.body.revision }))
        .status,
    ).toBe(400);

    // a page the form round-trips exactly stays on the form
    store.upsertPage(
      user,
      { type: 'concepts', slug: 'plain' },
      { title: 'Plain', current: 'v1', historyEntry: 'first' },
    );
    expect((await call('GET', '/api/memory/page?id=concepts/plain')).body.representable).toBe(true);
  });

  it("every page write from the tab — form, raw markdown, delete — clears the user's cached prompt (review R4)", async () => {
    const store = hier.hierarchicalMemoryStore;
    store.upsertPage(user, { type: 'concepts', slug: 'cache' }, { title: 'Cache', current: 'v1' });
    const fired: string[] = [];
    hier.setHierarchicalMemoryPromptInvalidationHook((u: string) => fired.push(u));
    try {
      let page = (await call('GET', '/api/memory/page?id=concepts/cache')).body;
      let r = await call('PUT', '/api/memory/page/raw', {
        id: 'concepts/cache',
        raw: page.raw.replace(/Cache/g, 'Cache renamed'), // frontmatter title and heading, so the page stays form-editable
        revision: page.revision,
      });
      expect(r.status).toBe(200);
      expect(fired).toEqual([user]);

      page = (await call('GET', '/api/memory/page?id=concepts/cache')).body;
      r = await call('PUT', '/api/memory/page', {
        id: 'concepts/cache',
        title: 'Cache again',
        aliases: [],
        current: 'v2',
        history: page.page.history,
        revision: page.revision,
      });
      expect(r.status).toBe(200);
      expect(fired).toEqual([user, user]);

      r = await call('DELETE', '/api/memory/page', { id: 'concepts/cache', revision: r.body.revision });
      expect(r.status).toBe(200);
      expect(fired).toEqual([user, user, user]);
    } finally {
      hier.setHierarchicalMemoryPromptInvalidationHook(undefined as never);
    }
  });

  it('a malformed page id is a 400, never a path outside the memory root', async () => {
    expect((await call('GET', '/api/memory/page?id=../../etc/passwd')).status).toBe(400);
    expect((await call('GET', '/api/memory/page?id=agent/..')).status).toBe(400);
    expect(
      (
        await call('PUT', '/api/memory/page', {
          id: 'nope/x',
          title: 't',
          aliases: [],
          current: '',
          history: [],
          revision: null,
        })
      ).status,
    ).toBe(400);
  });

  it('episodic: read a day as entries, add a note, edit and delete entries by revision', async () => {
    const store = hier.hierarchicalMemoryStore;
    store.appendEpisodic(user, 'Ask: A\nDid: B', '2026-10-20');
    store.appendEpisodic(user, 'second entry', '2026-10-20');
    let r = await call('GET', '/api/memory/episodic/2026-10-20');
    expect(r.status).toBe(200);
    expect(r.body.entries.map((e: any) => e.content)).toEqual(['Ask: A\nDid: B', 'second entry']);

    r = await call('PUT', '/api/memory/episodic/2026-10-20/0', {
      content: 'Ask: A (fixed)',
      revision: r.body.revision,
    });
    expect(r.status).toBe(200);
    expect(r.body.day.entries[0]).toMatchObject({ title: 'Ask: A (fixed)', content: 'Ask: A (fixed)' });

    const stale = r.body.day.revision;
    store.appendEpisodic(user, 'captured by a turn', '2026-10-20');
    expect((await call('DELETE', '/api/memory/episodic/2026-10-20/1', { revision: stale })).status).toBe(409);

    r = await call('GET', '/api/memory/episodic/2026-10-20');
    r = await call('DELETE', '/api/memory/episodic/2026-10-20/1', { revision: r.body.revision });
    expect(r.body.day.entries.map((e: any) => e.content)).toEqual(['Ask: A (fixed)', 'captured by a turn']);

    r = await call('POST', '/api/memory/episodic', { text: '대시보드에서 남긴 메모' });
    expect(r.status).toBe(200);
    expect(r.body.day.entries.at(-1).content).toBe('대시보드에서 남긴 메모');
    expect((await call('GET', '/api/memory/episodic/20261020')).status).toBe(400);
  });

  it('memory is self only: another signed-in user sees their own, a viewer token has none, writes need CSRF', async () => {
    mem.addMemory(user, 'memory', 'mine');
    const other = await call('GET', '/api/memory', undefined, `${user}X`);
    expect(other.body.l1.memory.entries).toEqual([]);
    const viewer = await inject({ method: 'GET', url: '/api/memory', headers: { Authorization: 'Bearer test-token' } });
    expect(viewer.statusCode).toBe(400);
    const { cookie } = await signIn(user);
    const noCsrf = await inject({
      method: 'POST',
      url: '/api/memory/episodic',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { text: 'x' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

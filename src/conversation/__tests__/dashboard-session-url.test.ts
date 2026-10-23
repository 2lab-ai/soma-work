/**
 * `getDashboardSessionUrl` — the producer behind the `📋 작업 로그` links in
 * Slack (thread header `dashboardLink` and the user-started thread post).
 *
 * Undefined is the real "viewer not listening" case the callers act on (no
 * link at all), so the function must only hand out a URL while the viewer is
 * actually listening: not before start, not for a listener-less start, not
 * after a failed listen, not after stop. Exercised against the REAL server.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: '',
    instanceName: 'dashboard-session-url-test',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));

vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  DATA_DIR: path.join(os.tmpdir(), 'dashboard-session-url-test-data'),
}));

// The listening server would probe its public URL over the real network.
vi.mock('../public-url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-url')>()),
  startPublicUrlCheck: vi.fn(),
}));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type WebServer = typeof import('../web-server');
let web: WebServer;
let instanceDir: string;
const previousInstanceDir = process.env.SOMA_INSTANCE_DIR;

beforeEach(async () => {
  vi.resetModules();
  // Heartbeats from the real server go to a temp registry, not ~/.soma.
  instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-session-url-instances-'));
  process.env.SOMA_INSTANCE_DIR = instanceDir;
  mockConfig.conversation.viewerUrl = '';
  mockConfig.conversation.viewerPort = await freePort();
  web = await import('../web-server');
});

afterEach(async () => {
  await web.stopWebServer();
  if (previousInstanceDir === undefined) delete process.env.SOMA_INSTANCE_DIR;
  else process.env.SOMA_INSTANCE_DIR = previousInstanceDir;
  fs.rmSync(instanceDir, { recursive: true, force: true });
});

describe('getDashboardSessionUrl', () => {
  it('is undefined before the viewer starts', () => {
    expect(web.getDashboardSessionUrl('U1', 'work:C1:1.0')).toBeUndefined();
  });

  it('builds the encoded deep link while the viewer is listening', async () => {
    await web.startWebServer();

    expect(web.getDashboardSessionUrl('U1', 'work:C1:1.0')).toBe(
      `${web.getViewerBaseUrl()}/dashboard/U1?session=work%3AC1%3A1.0`,
    );
    expect(web.getViewerBaseUrl()).toContain(`:${mockConfig.conversation.viewerPort}`);
    expect(web.getDashboardSessionUrl('U 1/x', 'k')).toContain('/dashboard/U%201%2Fx?session=k');
  });

  it('uses the configured public URL without doubling its trailing slash', async () => {
    mockConfig.conversation.viewerUrl = 'https://soma.example.com/';
    await web.startWebServer();

    expect(web.getDashboardSessionUrl('U1', 'work:C1:1.0')).toBe(
      'https://soma.example.com/dashboard/U1?session=work%3AC1%3A1.0',
    );
  });

  it('is undefined again after the viewer stops', async () => {
    await web.startWebServer();
    expect(web.getDashboardSessionUrl('U1', 'work:C1:1.0')).toBeDefined();

    await web.stopWebServer();

    expect(web.getDashboardSessionUrl('U1', 'work:C1:1.0')).toBeUndefined();
  });

  it('is undefined for a listener-less start (in-process inject only)', async () => {
    await web.startWebServer({ listen: false });

    expect(web.getDashboardSessionUrl('U1', 'work:C1:1.0')).toBeUndefined();
  });

  it('is undefined when listen fails', async () => {
    mockConfig.conversation.viewerHost = '203.0.113.1'; // TEST-NET-3: not a local address → EADDRNOTAVAIL
    try {
      await expect(web.startWebServer()).rejects.toThrow();
      expect(web.getDashboardSessionUrl('U1', 'work:C1:1.0')).toBeUndefined();
    } finally {
      mockConfig.conversation.viewerHost = '127.0.0.1';
    }
  });

  it('is undefined without an owner or a session key', async () => {
    await web.startWebServer();

    expect(web.getDashboardSessionUrl('', 'work:C1:1.0')).toBeUndefined();
    expect(web.getDashboardSessionUrl('U1', '')).toBeUndefined();
  });
});

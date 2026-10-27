/**
 * Dashboard task view — the steering composer (T1.5): a multiline instruction
 * with pasted images, attached files and voice notes reaches the session.
 *
 *   POST /api/dashboard/session/:key/command
 *     { message, attachments?: [{ name, mimetype, data (base64) }] }
 *
 * The attachments are validated like a new task's (same limits) and handed to
 * the command handler as decoded files; a files-only instruction is allowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
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

const AUTH_HEADER = { Authorization: 'Bearer test-token' };
const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

describe('POST /api/dashboard/session/:key/command — attachments (T1.5)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let handler: ReturnType<typeof vi.fn<(key: string, message: string, files: Array<{ name: string; mimetype: string; data: Buffer }>) => Promise<void>>>;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    const dashboard = await import('../dashboard');
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date(),
    });
    dashboard.setDashboardSessionAccessor(() => sessions);
    handler = vi.fn<(key: string, message: string, files: Array<{ name: string; mimetype: string; data: Buffer }>) => Promise<void>>().mockResolvedValue(undefined);
    dashboard.setDashboardCommandHandler(handler);
    await webServer.startWebServer({ listen: false });
    // The first import transforms the whole web server — slow on a busy runner.
  }, 60_000);

  afterEach(async () => {
    await stopWebServer();
  });

  function post(payload: unknown) {
    return injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent('C1:t1')}/command`,
      headers: AUTH_HEADER,
      payload,
    });
  }

  it('passes a multiline message and its decoded attachments to the handler', async () => {
    const res = await post({
      message: '첫 줄\n둘째 줄',
      attachments: [{ name: 'shot.png', mimetype: 'image/png', data: PNG_B64 }],
    });
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const [key, message, files] = handler.mock.calls[0];
    expect(key).toBe('C1:t1');
    expect(message).toBe('첫 줄\n둘째 줄');
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('shot.png');
    expect(files[0].mimetype).toBe('image/png');
    expect(Buffer.isBuffer(files[0].data)).toBe(true);
    expect(files[0].data.toString()).toBe('fake-png-bytes');
  });

  it('accepts a files-only instruction (a voice note with no text)', async () => {
    const res = await post({
      message: '',
      attachments: [{ name: 'voice-1.m4a', mimetype: 'audio/mp4', data: PNG_B64 }],
    });
    expect(res.statusCode).toBe(200);
    expect(handler.mock.calls[0][1]).toBe('');
    expect(handler.mock.calls[0][2]).toHaveLength(1);
  });

  it('a text-only message still reaches the handler with no files', async () => {
    const res = await post({ message: 'hi' });
    expect(res.statusCode).toBe(200);
    expect(handler.mock.calls[0][1]).toBe('hi');
    expect(handler.mock.calls[0][2] ?? []).toEqual([]);
  });

  it('rejects an empty instruction and a damaged attachment with 400', async () => {
    expect((await post({ message: '   ' })).statusCode).toBe(400);
    expect(
      (await post({ message: 'x', attachments: [{ name: 'a.png', mimetype: 'image/png', data: '%%%' }] })).statusCode,
    ).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('admits a phone photo — the route body limit is the new-task one, not the 1 MiB default', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
    const res = await post({
      message: 'photo',
      attachments: [{ name: 'photo.jpg', mimetype: 'image/jpeg', data: big }],
    });
    expect(res.statusCode).toBe(200);
  });
});

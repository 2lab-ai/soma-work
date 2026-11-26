/**
 * The hot card's alert (@2lab.ai/ui 0.51.0 `data.alertIcon`): Slack's `:alert:` siren, served by the dashboard from
 * its own origin and handed to the board. A task card past one core shows it before its node pill.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const GIF = readFileSync(join(__dirname, '..', 'assets', 'card-alert.gif'));
const V = createHash('sha256').update(GIF).digest('hex').slice(0, 12);

describe('card-alert-icon — the siren image and its URL', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('reads the GIF next to the module once and versions its URL by content', async () => {
    const m = await import('../card-alert-icon');
    const icon = m.cardAlertIcon();
    expect(icon).not.toBeNull();
    expect(icon?.body.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(icon?.v).toBe(V);
    expect(m.cardAlertIcon()).toBe(icon);
    expect(m.CARD_ALERT_ICON_PATH).toBe('/dashboard/assets/card-alert.gif');
    expect(m.cardAlertIconUrl()).toBe(`/dashboard/assets/card-alert.gif?v=${V}`);
  });

  it('with the image missing it hands no URL (the card shows 🚨) and does not throw', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (orig) => {
      const real = (await orig()) as typeof import('node:fs');
      return {
        ...real,
        readFileSync: (p: string, ...rest: unknown[]) => {
          if (String(p).endsWith('card-alert.gif')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
        },
      };
    });
    const m = await import('../card-alert-icon');
    expect(m.cardAlertIcon()).toBeNull();
    expect(m.cardAlertIconUrl()).toBe('');
  });

  it('the build copies the image next to the compiled module (dist/conversation/assets), after tsc', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    const build = String(pkg.scripts.build);
    // Every step must be there (indexOf -1 would pass a bare "less than"), in this order.
    const at = (cmd: string) => {
      const i = build.indexOf(cmd);
      expect(i, cmd).toBeGreaterThan(-1);
      return i;
    };
    const tsc = at('&& tsc &&');
    const mkdir = at('mkdir -p dist/conversation &&');
    const copy = at('cp -r src/conversation/assets dist/conversation/');
    expect(tsc).toBeLessThan(mkdir);
    expect(mkdir).toBeLessThan(copy);
  });

  it('records where the image comes from', () => {
    const notice = readFileSync(join(__dirname, '..', 'assets', 'NOTICE.md'), 'utf8');
    expect(notice).toContain('card-alert.gif');
    expect(notice).toContain('slackmojis.com');
  });
});

describe('GET /dashboard/assets/card-alert.gif and the board', () => {
  let injectWebServer: (r: Record<string, unknown>) => Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    rawPayload: Buffer;
    body: string;
  }>;
  let stopWebServer: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer as typeof injectWebServer;
    stopWebServer = webServer.stopWebServer;
    const dashboard = await import('../dashboard');
    dashboard.setDashboardSessionAccessor(() => new Map());
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  it('serves the GIF without sign-in, as image/gif, kept a year when asked by its content hash', async () => {
    const res = await injectWebServer({ method: 'GET', url: `/dashboard/assets/card-alert.gif?v=${V}` });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toBe('image/gif');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.rawPayload.equals(GIF)).toBe(true);
  });

  it('an old or missing ?v= gets the hour', async () => {
    for (const url of ['/dashboard/assets/card-alert.gif', '/dashboard/assets/card-alert.gif?v=000000000000']) {
      const res = await injectWebServer({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('public, max-age=3600');
    }
  });

  it('the page names the image and the board hands it to the element as data.alertIcon', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: { Authorization: 'Bearer test-token', 'Accept-Encoding': 'identity' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`const CARD_ALERT_ICON = "/dashboard/assets/card-alert.gif?v=${V}";`);
    expect(res.body).toContain("alertIcon: typeof CARD_ALERT_ICON === 'string' ? CARD_ALERT_ICON : '',");
  });
});

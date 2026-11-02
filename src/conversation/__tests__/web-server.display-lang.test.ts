/**
 * #773 — the real web server: the dashboard has an en / ko toggle at its top
 * right, opens in the request's display language (the `soma_lang` cookie here:
 * no Slack user on a token-less dev server), and stays byte-for-byte Korean by
 * default.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerDisplayCatalog } from '@soma/common/i18n';
import { registerPageCatalog } from '@soma/common/i18n-page';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The catalogs src/index.ts loads (`@soma/common/i18n-en`), registered into the module instance this test's
// server code uses (vitest can hold a second, require()-loaded copy of the package).
const CATALOG = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog');
registerPageCatalog(JSON.parse(readFileSync(join(CATALOG, 'en-page.json'), 'utf8')));
registerDisplayCatalog('en', JSON.parse(readFileSync(join(CATALOG, 'en-text.json'), 'utf8')));

const mockConfig = {
  conversation: { summaryModel: 'x', viewerHost: '127.0.0.1', viewerPort: 0, viewerUrl: '', viewerToken: '' },
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

const HANGUL_TEXT = />[^<]*[가-힣][^<]*</;

async function get(url: string, cookie?: string) {
  const { startWebServer, injectWebServer } = await import('../web-server');
  await startWebServer({ listen: false });
  return injectWebServer({ method: 'GET', url, headers: cookie ? { cookie } : {} });
}

describe('dashboard display language (#773)', () => {
  afterEach(async () => {
    const { stopWebServer } = await import('../web-server');
    await stopWebServer();
  });

  it('has one language toggle button in the top bar that flips en ⇄ ko, and the page in Korean', async () => {
    const res = await get('/dashboard');
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('<html lang="ko">');
    // One button, not a pair: it shows the page's language and a press switches to the other one.
    const toggle = /<button[^>]*id="lang-toggle"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
    expect(toggle).toMatch(/slot="actions"/);
    expect(toggle).toMatch(/onclick="toggleDisplayLang\(\)"/);
    expect(toggle).toContain('KO');
    expect(toggle).toContain('EN');
    expect(html.match(/id="lang-toggle"/g)).toHaveLength(1);
    expect(html).not.toMatch(/class="[^"]*lang-opt/);
    expect(html).toContain('function toggleDisplayLang(');
    expect(html).toContain('새 작업');
  });

  it('opens in English for the en cookie: html lang, element lang, and no Korean left in visible text', async () => {
    const res = await get('/dashboard', 'soma_lang=en');
    const html = res.body;
    expect(html).toContain('<html lang="en">');
    // No element keeps lang="ko" (the toggle's data-lang="ko" and comments are not elements' lang).
    expect(/<[a-z][\w-]*\b[^<>]*\slang="ko"/.exec(html)?.[0]).toBeUndefined();
    expect(html).toContain('New task');
    // Visible text nodes (outside script/style/comments) carry no Hangul.
    const visible = html
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    expect(HANGUL_TEXT.exec(visible)?.[0]).toBeUndefined();
  });

  it('the settings page follows the same language', async () => {
    const res = await get('/dashboard/settings', 'soma_lang=en');
    expect(res.body).toContain('<html lang="en">');
  });
});

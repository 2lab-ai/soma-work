import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AuthCardData, authCardHtml } from '@2lab.ai/ui/server';
import { describe, expect, it } from 'vitest';
import { loginErrorMessage, renderLoginPage, renderSsoConfirmPage } from '../auth-pages';
import * as uiLib from '../ui-lib';

// The pages are a host of @2lab.ai/ui's <ui-auth-card>: the server hands the library's own `authCardHtml`
// (`@2lab.ai/ui/server`) the card's data and wraps what comes back in the page shell. These tests pin the
// host's side of that contract — the data the page hands over, that the card in the page is exactly the
// library's for that data, and the shell around it — not the card's markup, which is the library's to test.

/** The `<ui-auth-card>` in a page: the element, the data it carries for the library, and the host's slotted logos. */
function cardOf(html: string): { element: string; data: AuthCardData; logos: string } {
  const element = /<ui-auth-card [\s\S]*?<\/ui-auth-card>/.exec(html)?.[0];
  if (!element) throw new Error('no <ui-auth-card> in the page');
  const state = /<script type="application\/json" data-auth-state>([\s\S]*?)<\/script>/.exec(element)?.[1];
  if (state === undefined) throw new Error('no data-auth-state in the card');
  const afterState = element.indexOf('</script>', element.indexOf('data-auth-state')) + '</script>'.length;
  return {
    element,
    data: JSON.parse(state) as AuthCardData,
    logos: element.slice(afterState, element.length - '</ui-auth-card>'.length),
  };
}

/** The page body without its <style> and <script> blocks (the card's data JSON too) — what a reader sees. */
const markup = (html: string) =>
  html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');

/** The card in the page is the library's own rendering of the data the page handed it, plus the host's logos. */
function expectLibraryCard(html: string, lang: 'en' | 'ko' = 'en'): AuthCardData {
  const { element, data, logos } = cardOf(html);
  const own = authCardHtml(data, { lang, page: true });
  expect(element).toBe(logos ? own.replace(/<\/ui-auth-card>$/, `${logos}</ui-auth-card>`) : own);
  return data;
}

const jwt = (user: { slackUserId: string; email: string; name: string; provider: string }) =>
  ({ kind: 'jwt', user }) as const;

describe('auth pages — a host of @2lab.ai/ui <ui-auth-card>, rendered by the library on the server', () => {
  it('imports the library through its server entry only, and keeps no copy of the card', () => {
    // No DOM here: the server entry must load without one, and the page module must never load an element.
    expect(typeof (globalThis as { HTMLElement?: unknown }).HTMLElement).toBe('undefined');
    const src = readFileSync(join(__dirname, '..', 'auth-pages.ts'), 'utf8');
    const libImports = [...src.matchAll(/from '(@2lab\.ai\/ui[^']*)'/g)].map((m) => m[1]);
    expect(libImports).toEqual(['@2lab.ai/ui/server']);
    for (const copied of ['authCardMarkup', 'STRINGS', 'safeLink', 'uiLibShadowCss', 'shadowrootmode']) {
      expect(src).not.toContain(copied);
    }
    expect(uiLib).not.toHaveProperty('uiLibShadowCss');
  });

  describe('/login', () => {
    it('signed out: the brand, the enabled providers as the library draws them, the Slack hint under "or"', () => {
      const html = renderLoginPage({ googleEnabled: true, microsoftEnabled: true, session: null });
      const data = expectLibraryCard(html);
      expect(data).toEqual({
        brand: { label: 'soma-work', mark: true },
        title: 'Sign in',
        text: 'Sign in to your dashboard.',
        providers: [
          { id: 'google', label: 'Sign in with Google', href: '/auth/google' },
          { id: 'microsoft', label: 'Sign in with Microsoft', href: '/auth/microsoft' },
        ],
        hint: 'Slack 스레드에서 `dashboard`를 입력하면 로그인 링크를 받습니다.',
      });
      // The multi-colour logos are the host's, slotted into the card's `logo-<id>` slots.
      const { logos } = cardOf(html);
      expect(logos).toMatch(/^<svg slot="logo-google"[\s\S]*<\/svg><svg slot="logo-microsoft"[\s\S]*<\/svg>$/);
      const seen = markup(html);
      expect(seen).toContain('Sign in with Google');
      expect(seen).toContain('<div class="ac-divider"><span>or</span></div>');
      expect(seen).toContain('Slack 스레드에서 <code>dashboard</code>를 입력하면 로그인 링크를 받습니다.');
    });

    it('only the configured providers, and only their logos', () => {
      const google = renderLoginPage({ googleEnabled: true, microsoftEnabled: false, session: null });
      expect(expectLibraryCard(google).providers?.map((p) => p.id)).toEqual(['google']);
      expect(cardOf(google).logos).toContain('slot="logo-google"');
      expect(google).not.toContain('microsoft');
      const none = renderLoginPage({ googleEnabled: false, microsoftEnabled: false, session: null });
      const data = expectLibraryCard(none);
      expect(data.providers).toEqual([]);
      expect(data.hint).toContain('`dashboard`');
      expect(cardOf(none).logos).toBe('');
      expect(markup(none)).not.toContain('class="ac-divider"');
    });

    it('signed in: the account with continue to its dashboard and sign out, then the providers', () => {
      const html = renderLoginPage({
        googleEnabled: true,
        microsoftEnabled: false,
        session: jwt({ slackUserId: 'U/1 x', email: 'g@x.com', name: 'Gina', provider: 'google' }),
      });
      const data = expectLibraryCard(html);
      expect(data.title).toBeUndefined();
      expect(data.text).toBeUndefined();
      expect(data.account).toEqual({
        name: 'Gina',
        meta: 'g@x.com · via Google',
        continue: { href: '/dashboard/U%2F1%20x', label: 'Continue to dashboard' },
        signOut: { href: '/auth/logout' },
      });
      expect(data.providers).toEqual([{ id: 'google', label: 'Sign in with Google', href: '/auth/google' }]);
      const seen = markup(html);
      expect(seen).toContain('Signed in as');
      expect(seen).toContain('href="/dashboard/U%2F1%20x" data-act="continue"');
      expect(seen).toContain('href="/auth/logout" data-act="sign-out"');
      expect(seen).toContain('Use a different account');
    });

    it('a session without a name falls back to the email, then the id; an unknown provider has no "via"', () => {
      const byEmail = expectLibraryCard(
        renderLoginPage({
          googleEnabled: false,
          microsoftEnabled: false,
          session: jwt({ slackUserId: 'U_1', email: 'e@x', name: '', provider: 'constructor' }),
        }),
      );
      expect(byEmail.account?.name).toBe('e@x');
      expect(byEmail.account?.meta).toBe('e@x');
      const byId = expectLibraryCard(
        renderLoginPage({
          googleEnabled: false,
          microsoftEnabled: false,
          session: jwt({ slackUserId: 'U_1', email: '', name: '', provider: 'slack' }),
        }),
      );
      expect(byId.account?.name).toBe('U_1');
      expect(byId.account?.meta).toBe('via Slack');
    });

    it('a legacy viewer-token session is the admin, continuing to the plain dashboard', () => {
      const data = expectLibraryCard(
        renderLoginPage({ googleEnabled: true, microsoftEnabled: true, session: { kind: 'bearer' } }),
      );
      expect(data.account).toEqual({
        name: 'Admin',
        meta: 'Viewer token session',
        continue: { href: '/dashboard', label: 'Continue to dashboard' },
        signOut: { href: '/auth/logout' },
      });
    });

    it('works without JavaScript: provider buttons are links, the error line is in the markup', () => {
      const html = renderLoginPage({
        googleEnabled: true,
        microsoftEnabled: false,
        session: null,
        error: loginErrorMessage('no_match', '<x@y>'),
      });
      const data = expectLibraryCard(html);
      expect(data.error).toBe('No matching Slack account found for <x@y>. Contact your admin.');
      const seen = markup(html);
      expect(seen).toContain('<a class="ac-btn ac-provider" href="/auth/google" data-act="provider"');
      expect(seen).toContain('role="alert"');
      expect(seen).toContain('No matching Slack account found for &lt;x@y&gt;. Contact your admin.');
      expect(html).not.toContain('<x@y>');
    });

    it('error lines: retry for a lookup outage, the admin for a misconfiguration, a generic line otherwise', () => {
      const unavailable = loginErrorMessage('lookup_unavailable', '');
      expect(unavailable).toContain('try again');
      expect(unavailable).not.toContain('No matching Slack account');
      expect(unavailable).not.toContain('Contact your admin');
      const misconfigured = loginErrorMessage('lookup_misconfigured', '');
      expect(misconfigured).toContain('admin');
      expect(misconfigured).toContain('dashboard link');
      expect(misconfigured).not.toContain('try again');
      expect(loginErrorMessage('no_match', undefined)).toContain('for this email.');
      expect(loginErrorMessage('constructor', '')).toBe('Authentication error.');
      expect(loginErrorMessage(undefined, 'x')).toBe('');
      expect(loginErrorMessage(['a'], 'x')).toBe('');
      const quiet = renderLoginPage({ googleEnabled: true, microsoftEnabled: false, session: null });
      expect(expectLibraryCard(quiet).error).toBeUndefined();
      expect(markup(quiet)).not.toContain('role="alert"');
    });
  });

  describe('GET /auth/sso confirm', () => {
    it('is a real form the library draws: POST, the token as a hidden field, Cancel back to the dashboard', () => {
      const html = renderSsoConfirmPage(
        'tok"en<',
        jwt({ slackUserId: 'UA', email: 'a@x', name: 'Alice', provider: 'slack' }),
        { sub: 'UB', name: '', email: 'b@x' },
      );
      const data = expectLibraryCard(html);
      expect(data).toEqual({
        brand: { label: 'soma-work', mark: true },
        title: 'Switch accounts?',
        text: 'You are about to replace your current dashboard session. The account signed in now will be signed out.',
        confirm: {
          from: { name: 'Alice', meta: 'a@x' },
          to: { name: 'UB', meta: 'b@x' },
          action: '/auth/sso/confirm',
          method: 'post',
          fields: { token: 'tok"en<' },
          cancelHref: '/dashboard',
        },
      });
      const seen = markup(html);
      expect(seen).toContain('<form class="ac-form" method="post" action="/auth/sso/confirm">');
      expect(seen).toContain('<input type="hidden" name="token" value="tok&quot;en&lt;" />');
      expect(seen).toContain('<a class="ac-btn" href="/dashboard" data-act="cancel"');
      // The card's own label (0.12.0: the primary grows and wraps) — no host workaround for the row.
      expect(data.confirm?.confirmLabel).toBeUndefined();
      expect(seen).toContain('<span class="ac-label">Continue as UB</span>');
      expect(html).not.toContain('tok"en<');
    });

    it('an admin token session, and a requested user without an email', () => {
      const data = expectLibraryCard(
        renderSsoConfirmPage('t', { kind: 'bearer' }, { sub: 'UB', name: 'Bob', email: '' }),
      );
      expect(data.confirm?.from).toEqual({ name: 'Admin (API token)' });
      expect(data.confirm?.to).toEqual({ name: 'Bob' });
    });
  });

  describe('the page shell', () => {
    it('carries the library tokens only, the card with the element script, and the theme scripts', () => {
      const html = renderLoginPage({ googleEnabled: true, microsoftEnabled: true, session: null });
      expect(html).toMatch(/^<!DOCTYPE html>\n<html lang="ko">/);
      expect(html).toContain('<title>soma-work — Sign in</title>');
      expect(html).toContain('<style id="ui-tokens">');
      expect(html).toContain('--ui-bg:');
      // No palette of its own: no hex colour outside the tokens, the card's sheet and the provider logos.
      const own = html
        .replace(/<style id="ui-tokens">[\s\S]*?<\/style>/, '')
        .replace(/<template shadowrootmode="open"><style>[\s\S]*?<\/style>/, '')
        .replace(/<svg slot="logo-[\s\S]*?<\/svg>/g, '');
      expect(own).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      // The page's theme choice goes on <html> before paint, and onto the card after it.
      expect(html).toContain("localStorage.getItem('soma-theme')");
      expect(html).toContain("document.documentElement.setAttribute('data-theme',t)");
      expect(html).toContain("c.setAttribute('theme', document.documentElement.getAttribute('data-theme') || 'dark')");
      expect(html).toMatch(/<ui-auth-card lang="en" page><template shadowrootmode="open">/);
      expect(html).toContain(
        `<script type="module" src="/dashboard/ui/auth-card.js?v=${uiLib.UI_LIB_VERSION}"></script>`,
      );
      // The card is English (its strings); the page is Korean (the hint) and breaks its prose between words.
      expect(html).toContain('html:lang(ko) { word-break: keep-all; }');
      const sso = renderSsoConfirmPage('t', { kind: 'bearer' }, { sub: 'UB', name: 'Bob', email: '' });
      expect(sso).toMatch(/^<!DOCTYPE html>\n<html lang="en">/);
      expect(sso).toContain('<title>soma-work — Confirm session switch</title>');
    });

    it('a name, email or token with markup in it reaches the card as data and the page as text', () => {
      const html = renderLoginPage({
        googleEnabled: true,
        microsoftEnabled: false,
        session: jwt({
          slackUserId: 'U_E',
          email: '"><svg onload=1>@x.com',
          name: '<img src=x onerror=alert(1)></script><script>alert(2)</script>',
          provider: 'google',
        }),
      });
      // The data round-trips through the JSON state untouched …
      const data = expectLibraryCard(html);
      expect(data.account?.name).toBe('<img src=x onerror=alert(1)></script><script>alert(2)</script>');
      // … while the page holds no `<` of it: not in the markup, not in the state script (so it cannot be closed early).
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<svg onload');
      expect(html).not.toContain('<script>alert(2)');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(cardOf(html).element).toContain('\\u003cimg src=x');
      const sso = renderSsoConfirmPage(
        '</script><script>alert(1)</script>',
        jwt({ slackUserId: 'UA', email: '', name: '<b>A</b>', provider: 'slack' }),
        { sub: 'UB', name: 'B"onmouseover="x', email: 'javascript:alert(1)' },
      );
      expectLibraryCard(sso);
      expect(sso).not.toContain('</script><script>alert(1)');
      expect(sso).not.toContain('<b>A</b>');
      expect(sso).toContain('name="token" value="&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    });
  });
});

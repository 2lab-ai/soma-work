import { describe, expect, it } from 'vitest';
import {
  type AuthCardData,
  authCardHtml,
  loginErrorMessage,
  renderLoginPage,
  renderSsoConfirmPage,
} from '../auth-pages';
import { uiLibShadowCss } from '../ui-lib';

type LibAuthCardHtml = (data: AuthCardData, opts?: Record<string, unknown>) => string;

/** The library's own authCardHtml: its module defines a custom element, so the test gives it an HTMLElement. */
async function libAuthCardHtml(): Promise<LibAuthCardHtml> {
  const g = globalThis as { HTMLElement?: unknown };
  g.HTMLElement ??= class {};
  // The library's ESM subpath export (vitest resolves it; the server's commonjs tsc setup has no type path to it).
  const spec = '@2lab.ai/ui/auth-card';
  const lib = (await import(/* @vite-ignore */ spec)) as { authCardHtml: LibAuthCardHtml };
  return lib.authCardHtml;
}

const CASES: Array<[string, AuthCardData, Record<string, unknown>]> = [
  [
    'signed out: providers, a hint with code, an error',
    {
      brand: { label: 'soma-work', mark: true },
      title: 'Sign in',
      text: 'Sign in to your `dashboard`.',
      error: 'Google sign-in failed <b>now</b>',
      providers: [
        { id: 'google', label: 'Sign in with Google', href: '/auth/google' },
        { id: 'ms', label: 'Microsoft', href: 'https://login.example.com/x?a=1&b="2"', icon: 'shield' },
        { id: 'img', label: 'Img', href: 'javascript:alert(1)', logo: 'data:image/png;base64,AAAA' },
        { id: 'svg', label: 'Svg', href: '//evil.example', logo: 'data:image/svg+xml,<svg/>' },
      ],
      hint: 'Slack 스레드에서 `dashboard`를 입력하면 로그인 링크를 받습니다.',
      finePrint: 'By continuing you accept `terms`.',
    },
    { lang: 'en', page: true },
  ],
  [
    'signed in: account, continue, sign out, then the providers',
    {
      brand: { label: 'soma', mark: 'bolt', href: '/' },
      account: {
        name: '<img src=x onerror=alert(1)>',
        meta: '"><svg onload=1>@x.com · via Google',
        continue: { href: '/dashboard/U_1', label: 'Continue to dashboard' },
        signOut: { href: '/auth/logout' },
      },
      providers: [{ id: 'google', label: 'Google', href: '/auth/google' }],
      hint: 'or `dashboard` in Slack',
    },
    { lang: 'en', page: true, theme: 'dark' },
  ],
  ['signed in, no providers, no sign-out, Korean', { account: { name: '김 철수', initials: ' ' } }, { lang: 'ko' }],
  ['nothing but a hint', { hint: 'Ask in `#help`' }, {}],
  ['empty', {}, { theme: 'blue', lang: 'fr' }],
  [
    'confirm a session switch',
    {
      brand: { label: 'soma-work', mark: true },
      title: 'Switch accounts?',
      text: 'Replace your session.',
      confirm: {
        from: { name: 'Alice', meta: 'a@x' },
        to: { name: 'Bob <b>', meta: 'b@x' },
        action: '/auth/sso/confirm',
        method: 'post',
        fields: { token: 'a.b.c"<x>', other: "it's" },
        cancelHref: '/dashboard',
      },
    },
    { lang: 'en', page: true },
  ],
  [
    'confirm without a current session or a cancel link, by GET, Korean',
    {
      confirm: {
        to: { name: 'Bob' },
        action: 'javascript:void(0)',
        method: 'get',
        confirmLabel: 'Go',
        cancelLabel: 'No',
      },
    },
    { lang: 'ko', theme: 'light' },
  ],
];

// The server cannot import the ESM-only library, so it draws the card from the card's markup contract — the
// glyph table and the shadow sheet read from the build. This pins it to the library's authCardHtml, string
// for string, for every branch the card has.
describe('authCardHtml — @2lab.ai/ui <ui-auth-card> drawn on the server', () => {
  it('reads a non-empty shadow sheet from the build (the base sheet with its tokens, then the card)', () => {
    const css = uiLibShadowCss('auth-card.js');
    expect(css).toContain(':host { --ease: var(--ui-ease, ');
    expect(css).toContain('.ac-card {');
    expect(css).not.toContain('${');
  });

  for (const [name, data, opts] of CASES) {
    it(`matches the library: ${name}`, async () => {
      const expected = (await libAuthCardHtml())(data, opts);
      expect(expected).toContain('.ac-card {');
      expect(expected).toContain('<div class="ac-card">');
      expect(authCardHtml(data, opts)).toBe(expected);
    });
  }
});

describe('auth pages', () => {
  const markup = (html: string) => html.replace(/<template shadowrootmode="open"><style>[\s\S]*?<\/style>/, '');

  it('the sign-in page carries the library tokens only, the card, and the element script', () => {
    const html = renderLoginPage({ googleEnabled: true, microsoftEnabled: true, session: null });
    expect(html).toContain('<style id="ui-tokens">');
    expect(html).toContain('--ui-bg:');
    // No palette of its own: no hex colour outside the tokens, the card's sheet and the provider logos.
    const own = markup(html)
      .replace(/<style id="ui-tokens">[\s\S]*?<\/style>/, '')
      .replace(/<svg slot="logo-[\s\S]*?<\/svg>/g, '');
    expect(own).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(html).toMatch(/<ui-auth-card lang="en" page><template shadowrootmode="open">/);
    expect(html).toContain('<script type="module" src="/dashboard/ui/auth-card.js?v=');
    expect(html).toContain('<svg slot="logo-google"');
    expect(html).toContain('<svg slot="logo-microsoft"');
  });

  it('works without JavaScript: provider buttons are links, the error is in the markup', () => {
    const html = renderLoginPage({
      googleEnabled: true,
      microsoftEnabled: false,
      session: null,
      error: loginErrorMessage('no_match', '<x@y>'),
    });
    expect(html).toContain('href="/auth/google" data-act="provider"');
    expect(html).not.toContain('/auth/microsoft');
    expect(markup(html)).toContain('role="alert"');
    expect(markup(html)).toContain('No matching Slack account found for &lt;x@y&gt;. Contact your admin.');
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
  });

  it('the session-switch confirm is a real form: POST, the token as a hidden field, Cancel back to the dashboard', () => {
    const html = renderSsoConfirmPage(
      'tok"en<',
      { kind: 'jwt', user: { slackUserId: 'UA', email: 'a@x', name: 'Alice', provider: 'slack' } },
      { sub: 'UB', name: '', email: 'b@x' },
    );
    expect(html).toContain('<form class="ac-form" method="post" action="/auth/sso/confirm">');
    expect(html).toContain('<input type="hidden" name="token" value="tok&quot;en&lt;" />');
    expect(html).toContain('<a class="ac-btn" href="/dashboard" data-act="cancel"');
    expect(html).toContain('<span class="ac-label">Switch</span>');
    expect(html).toContain('UB');
    expect(html).toContain('Alice');
    expect(html).not.toContain('tok"en<');
    const admin = renderSsoConfirmPage('t', { kind: 'bearer' }, { sub: 'UB', name: 'Bob', email: '' });
    expect(admin).toContain('Admin (API token)');
  });
});

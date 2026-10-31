/**
 * The pages a browser sees before the dashboard (M-09, M-10): sign in (`/login`, also the account page of a
 * signed-in browser) and the session-switch confirm (`GET /auth/sso`). Each is @2lab.ai/ui's `<ui-auth-card>`
 * rendered on the server by the library's own `authCardHtml` (`@2lab.ai/ui/server` — no element in it, so the
 * server never runs element code): a declarative shadow root holding the card, so the provider buttons (real
 * links) and the confirm (a real `<form>`) work before, and without, the script — in a page that carries only
 * the library's tokens.css (the dashboard's single colour source) and loads `/dashboard/ui/auth-card.js` to
 * take the card over in place.
 */

import { type AuthCardData, type AuthProvider, authCardHtml, esc } from '@2lab.ai/ui/server';
import { UI_LIB_VERSION, uiLibTokensCss } from './ui-lib';

// ── The page around the card ──

/** The card's light-DOM children (provider logos in `slot="logo-<id>"`) go in before its closing tag. */
function withSlotted(card: string, slotted: string): string {
  return slotted ? card.replace(/<\/ui-auth-card>$/, `${slotted}</ui-auth-card>`) : card;
}

/**
 * The page: the dashboard's theme choice (soma-theme, else the OS) on <html>, @2lab.ai/ui's tokens.css as the
 * only palette, the server-rendered card filling the viewport, and the element script. With JavaScript off the
 * tokens follow the OS theme and the card is the same one. A Korean page breaks its prose between words:
 * `word-break` inherits into the card, whose own keep-all is keyed on its `lang` attribute (en — its strings
 * are English — with the Slack hint in Korean).
 */
function authPage(opts: { lang: 'ko' | 'en'; title: string; card: string }): string {
  return `<!DOCTYPE html>
<html lang="${opts.lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<script data-fouc>
(function(){var t=null;try{t=localStorage.getItem('soma-theme')}catch(_e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();
</script>
<style id="ui-tokens">
${uiLibTokensCss()}
</style>
<style>html, body { margin: 0; background: var(--ui-bg); } html:lang(ko) { word-break: keep-all; }</style>
</head>
<body>
<main>
${opts.card}
</main>
<script data-theme-sync>
// The card's own colour-scheme (form controls, scrollbars) follows the page's theme.
document.querySelectorAll('ui-auth-card').forEach(function (c) { c.setAttribute('theme', document.documentElement.getAttribute('data-theme') || 'dark'); });
</script>
<script type="module" src="/dashboard/ui/auth-card.js?v=${UI_LIB_VERSION}"></script>
</body>
</html>`;
}

const BRAND = { label: 'soma-work', mark: true } as const;

// Provider logos: multi-colour marks the card takes in `slot="logo-<id>"` (its own glyphs are one colour).
const GOOGLE_LOGO =
  '<svg slot="logo-google" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>';
const MICROSOFT_LOGO =
  '<svg slot="logo-microsoft" viewBox="0 0 21 21" width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';

// A Map, not an object: the claim is a string, and an object lookup would also answer for inherited keys
// such as `constructor`.
const PROVIDER_LABELS = new Map<string, string>([
  ['google', 'Google'],
  ['microsoft', 'Microsoft'],
  ['slack', 'Slack'],
]);

/**
 * Why the last sign-in failed, by the `error` the OAuth routes redirect to /login with. Drawn by the server in
 * the card's alert line, so it shows with JavaScript off; the email (a query parameter) is text only.
 */
export const LOGIN_ERRORS = new Map<string, (email: string) => string>([
  ['google_denied', () => 'Google sign-in was cancelled.'],
  ['google_failed', () => 'Google sign-in failed. Please try again.'],
  [
    'google_unverified',
    () =>
      'Your Google email address is not verified. Verify it in your Google account, or sign in with the Slack dashboard link.',
  ],
  ['microsoft_denied', () => 'Microsoft sign-in was cancelled.'],
  ['microsoft_failed', () => 'Microsoft sign-in failed. Please try again.'],
  ['no_match', (email) => `No matching Slack account found for ${email}. Contact your admin.`],
  ['lookup_unavailable', () => 'Could not reach Slack to look up your account. Please try again in a moment.'],
  [
    'lookup_misconfigured',
    () =>
      'This server cannot look up Slack accounts for Google sign-in yet. Contact your admin, or sign in with the Slack dashboard link.',
  ],
  [
    'ambiguous_email',
    () =>
      'Several Slack users registered this email via /z email, so the dashboard cannot pick one account. Keep it on one Slack user, or sign in with the Slack dashboard link.',
  ],
  ['state_mismatch', () => 'Authentication state mismatch. Please try again.'],
  ['sso_missing', () => 'Slack SSO link is missing a token. Request a new dashboard link in Slack.'],
  ['sso_invalid', () => 'Slack SSO link expired or is invalid. Request a new dashboard link in Slack.'],
  ['sso_consumed', () => 'Slack SSO link was already used. Request a new dashboard link in Slack.'],
]);

/** The alert line for `?error=…&email=…` ('' without an error). An unknown code is a generic line. */
export function loginErrorMessage(error: unknown, email: unknown): string {
  if (typeof error !== 'string' || !error) return '';
  const who = typeof email === 'string' && email ? email.slice(0, 320) : 'this email';
  return LOGIN_ERRORS.get(error)?.(who) ?? 'Authentication error.';
}

/** The browser's session as the auth pages show it (oauth.ts CurrentSession). */
export type AuthPageSession =
  | { kind: 'jwt'; user: { slackUserId: string; email: string; name: string; provider: string } }
  | { kind: 'bearer' };

const SLACK_HINT = 'Slack 스레드에서 `dashboard`를 입력하면 로그인 링크를 받습니다.';

/**
 * `/login`. Signed out: the provider buttons and the Slack `dashboard` hint. Signed in: the account first —
 * continue to the dashboard, or sign out — then the same sign-in options under "Use a different account"
 * (Google opens its account chooser, `prompt=select_account`; a cancelled or failed switch keeps the session).
 */
export function renderLoginPage(opts: {
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  session: AuthPageSession | null;
  error?: string;
}): string {
  const { googleEnabled, microsoftEnabled, session } = opts;
  const providers: AuthProvider[] = [];
  if (googleEnabled) providers.push({ id: 'google', label: 'Sign in with Google', href: '/auth/google' });
  if (microsoftEnabled) providers.push({ id: 'microsoft', label: 'Sign in with Microsoft', href: '/auth/microsoft' });
  const data: AuthCardData = { brand: BRAND, providers, hint: SLACK_HINT };
  if (opts.error) data.error = opts.error;
  if (session) {
    const user = session.kind === 'jwt' ? session.user : null;
    const provider = user ? PROVIDER_LABELS.get(user.provider) : undefined;
    data.account = {
      name: user ? user.name || user.email || user.slackUserId : 'Admin',
      meta: user ? [user.email, provider ? `via ${provider}` : ''].filter(Boolean).join(' · ') : 'Viewer token session',
      continue: {
        href: user ? `/dashboard/${encodeURIComponent(user.slackUserId)}` : '/dashboard',
        label: 'Continue to dashboard',
      },
      signOut: { href: '/auth/logout' },
    };
  } else {
    data.title = 'Sign in';
    data.text = 'Sign in to your dashboard.';
  }
  const logos = `${googleEnabled ? GOOGLE_LOGO : ''}${microsoftEnabled ? MICROSOFT_LOGO : ''}`;
  return authPage({
    lang: 'ko',
    title: 'soma-work — Sign in',
    card: withSlotted(authCardHtml(data, { lang: 'en', page: true }), logos),
  });
}

/**
 * The session-switch confirm of `GET /auth/sso` when the browser already holds another user's session:
 * "Continue as <name>" (the card's own label; its primary grows and wraps, so a long name never cuts off) POSTs
 * the exchange token to `/auth/sso/confirm` (which consumes the jti and swaps the cookie); Cancel goes back to
 * the dashboard and keeps the session — no token is consumed. The token is signed, expiring and single-use, so
 * the form needs no separate CSRF token.
 */
export function renderSsoConfirmPage(
  token: string,
  current: AuthPageSession,
  requested: { sub: string; name: string; email: string },
): string {
  const from =
    current.kind === 'jwt'
      ? { name: current.user.name || current.user.slackUserId, meta: current.user.email || undefined }
      : { name: 'Admin (API token)' };
  const data: AuthCardData = {
    brand: BRAND,
    title: 'Switch accounts?',
    text: 'You are about to replace your current dashboard session. The account signed in now will be signed out.',
    confirm: {
      from,
      to: { name: requested.name || requested.sub, meta: requested.email || undefined },
      action: '/auth/sso/confirm',
      method: 'post',
      fields: { token },
      cancelHref: '/dashboard',
    },
  };
  return authPage({
    lang: 'en',
    title: 'soma-work — Confirm session switch',
    card: authCardHtml(data, { lang: 'en', page: true }),
  });
}

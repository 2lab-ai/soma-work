/**
 * The pages a browser sees before the dashboard (M-09, M-10): sign in (`/login`, also the account page of a
 * signed-in browser) and the session-switch confirm (`GET /auth/sso`). Each is @2lab.ai/ui's `<ui-auth-card>`
 * rendered on the server — a declarative shadow root holding the card, so the provider buttons (real links) and
 * the confirm (a real `<form>`) work before, and without, the script — in a page that carries only the library's
 * tokens.css (the dashboard's single colour source) and loads `/dashboard/ui/auth-card.js` to take the card over.
 *
 * The library's `authCardHtml` cannot be imported here: the package is ESM-only (an `import`-only export map)
 * and its module defines a custom element. So `authCardHtml` below draws the same markup from the card's
 * documented contract — the glyphs from the library's glyph table (uiIcon) and the shadow sheet read from its
 * build (uiLibShadowCss) — and a test pins it to the library's own `authCardHtml` string for string.
 */

import { UI_LIB_VERSION, uiIcon, uiLibShadowCss, uiLibTokensCss } from './ui-lib';

// ── <ui-auth-card> markup (the library's auth-card.ts, on the server) ──

export type AuthLang = 'en' | 'ko';

export interface AuthProvider {
  id: string;
  label: string;
  href: string;
  /** A glyph of @2lab.ai/ui's icon set. */
  icon?: string;
  logo?: string;
}

export interface AuthAccount {
  name: string;
  meta?: string;
  initials?: string;
}

export interface AuthLink {
  href?: string;
  label?: string;
}

export interface AuthSignedIn extends AuthAccount {
  continue?: AuthLink;
  signOut?: AuthLink;
}

export interface AuthConfirm {
  from?: AuthAccount;
  to: AuthAccount;
  action: string;
  method?: 'post' | 'get';
  fields?: Record<string, string>;
  confirmLabel?: string;
  cancelLabel?: string;
  cancelHref?: string;
}

export interface AuthCardData {
  brand?: { label: string; mark?: boolean | string; href?: string };
  title?: string;
  text?: string;
  error?: string;
  account?: AuthSignedIn;
  providers?: AuthProvider[];
  switchLabel?: string;
  hint?: string;
  confirm?: AuthConfirm;
  finePrint?: string;
}

const STRINGS = {
  en: {
    signedInAs: 'Signed in as',
    continue: 'Continue',
    signOut: 'Sign out',
    or: 'or',
    useDifferent: 'Use a different account',
    redirecting: 'Redirecting…',
    leaving: 'Signed in now',
    next: 'New session',
    cancel: 'Cancel',
    continueAs: (name: string) => `Continue as ${name}`,
    switching: 'Switching…',
  },
  ko: {
    signedInAs: '로그인한 계정',
    continue: '계속',
    signOut: '로그아웃',
    or: '또는',
    useDifferent: '다른 계정 사용',
    redirecting: '이동 중…',
    leaving: '지금 로그인한 계정',
    next: '새 세션',
    cancel: '취소',
    continueAs: (name: string) => `${name}(으)로 계속`,
    switching: '전환 중…',
  },
};
type AuthStrings = (typeof STRINGS)['en'];

const authStrings = (lang: unknown): AuthStrings => (lang === 'ko' ? STRINGS.ko : STRINGS.en);

// The library's core/html escapes: text escapes & < >, an attribute also " and '.
const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const escAttr = (value: unknown): string => esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const SAFE_SCHEMES = /^(https?:|mailto:)/i;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
/** A link that cannot run script: http(s), mailto or same-site; anything else is `#`. */
function safeLink(url: unknown): string {
  const s = String(url ?? '').trim();
  if (!s) return '#';
  if (SAFE_SCHEMES.test(s)) return escAttr(s);
  if (/^[\\/]{2}/.test(s) || Array.from(s).some((c) => c.charCodeAt(0) < 32)) return '#';
  return SCHEME.test(s) ? '#' : escAttr(s);
}
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i;
function safeSrc(url: unknown): string {
  const s = String(url ?? '').trim();
  if (!s) return '';
  if (/^https?:/i.test(s) || /^blob:/i.test(s) || SAFE_DATA_IMAGE.test(s)) return escAttr(s);
  const link = safeLink(s);
  return link === '#' || /^mailto:/i.test(s) ? '' : link;
}

/** Avatar letters: the first letter of up to two words of the name (an email's part before @). "?" for none. */
export function authInitials(name: unknown): string {
  let s = String(name ?? '').trim();
  const at = s.indexOf('@');
  if (at > 0) s = s.slice(0, at);
  const words = s.split(/[\s._+-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

/** Plain text with `code` spans: everything escaped, backtick pairs become <code>. */
function authInline(text: unknown): string {
  return String(text ?? '')
    .split(/(`[^`\n]+`)/)
    .map((part) => (/^`[^`\n]+`$/.test(part) ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part)))
    .join('');
}

function avatar(a: AuthAccount, small = false): string {
  const letters = String(a.initials ?? '').trim() || authInitials(a.name);
  return `<span class="ac-av${small ? ' is-sm' : ''}" aria-hidden="true">${esc(letters)}</span>`;
}

function who(a: AuthAccount): string {
  return `<div class="ac-who-text"><p class="ac-name">${esc(a.name)}</p>${a.meta ? `<p class="ac-meta">${esc(a.meta)}</p>` : ''}</div>`;
}

function spinner(t: string): string {
  return `<span class="ac-spin" aria-hidden="true"></span><span class="ac-wait">${esc(t)}</span>`;
}

function providerIcon(p: AuthProvider): string {
  const id = String(p.id ?? '');
  const src = p.logo ? safeSrc(p.logo) : '';
  const own = src ? `<img src="${src}" alt="" width="18" height="18" />` : p.icon ? uiIcon(p.icon, { size: 18 }) : '';
  return `<span class="ac-ico"><slot name="logo-${escAttr(id)}">${own}</slot></span>`;
}

function providersHtml(list: AuthProvider[], t: AuthStrings): string {
  return list
    .map(
      (p) =>
        `<a class="ac-btn ac-provider" href="${safeLink(p.href)}" data-act="provider" data-id="${escAttr(p.id)}" data-key="p:${escAttr(p.id)}">${providerIcon(p)}<span class="ac-label">${esc(p.label)}</span>${spinner(t.redirecting)}</a>`,
    )
    .join('');
}

function confirmHtml(c: AuthConfirm, t: AuthStrings): string {
  const fields = Object.entries(c.fields ?? {})
    .map(([k, v]) => `<input type="hidden" name="${escAttr(k)}" value="${escAttr(v)}" />`)
    .join('');
  const method = c.method === 'get' ? 'get' : 'post';
  const sessions = `<ul class="ac-sessions">${
    c.from
      ? `<li class="ac-session">${avatar(c.from, true)}<div class="ac-who-text"><p class="ac-label-sm">${esc(t.leaving)}</p><p class="ac-name">${esc(c.from.name)}</p>${c.from.meta ? `<p class="ac-meta">${esc(c.from.meta)}</p>` : ''}</div></li>`
      : ''
  }<li class="ac-session is-next">${avatar(c.to, true)}<div class="ac-who-text"><p class="ac-label-sm">${esc(t.next)}</p><p class="ac-name">${esc(c.to.name)}</p>${c.to.meta ? `<p class="ac-meta">${esc(c.to.meta)}</p>` : ''}</div>${uiIcon('arrow-right', { size: 14, class: 'ac-arrow' })}</li></ul>`;
  const cancelLabel = c.cancelLabel || t.cancel;
  const cancel = c.cancelHref
    ? `<a class="ac-btn" href="${safeLink(c.cancelHref)}" data-act="cancel" data-key="cancel">${esc(cancelLabel)}</a>`
    : `<button type="button" class="ac-btn" data-act="cancel" data-key="cancel">${esc(cancelLabel)}</button>`;
  const label = c.confirmLabel || t.continueAs(c.to.name);
  return `${sessions}<form class="ac-form" method="${method}" action="${safeLink(c.action)}">${fields}<div class="ac-actions">${cancel}<button type="submit" class="ac-btn is-primary" data-key="confirm"><span class="ac-label">${esc(label)}</span>${spinner(t.switching)}</button></div></form>`;
}

function authCardMarkup(data: AuthCardData | undefined, lang: unknown): string {
  const d = data ?? {};
  const t = authStrings(lang);
  let brand = '<slot name="brand"></slot>';
  if (d.brand?.label) {
    const mark = d.brand.mark
      ? `<span class="ac-mark" aria-hidden="true">${uiIcon(d.brand.mark === true ? 'brand' : d.brand.mark, { size: 16 })}</span>`
      : '';
    const inner = `${mark}<span>${esc(d.brand.label)}</span>`;
    brand = d.brand.href
      ? `<a class="ac-brand" href="${safeLink(d.brand.href)}" data-act="brand" data-key="brand">${inner}</a>`
      : `<span class="ac-brand">${inner}</span>`;
  }
  const head =
    d.title || d.text
      ? `<header class="ac-head">${d.title ? `<h1 class="ac-title">${esc(d.title)}</h1>` : ''}${d.text ? `<p class="ac-text">${authInline(d.text)}</p>` : ''}<slot name="body"></slot></header>`
      : '<slot name="body"></slot>';
  const error = d.error
    ? `<div class="ac-error" role="alert">${uiIcon('alert', { size: 14 })}<span>${esc(d.error)}</span></div>`
    : '';
  let body: string;
  if (d.confirm) {
    body = confirmHtml(d.confirm, t);
  } else {
    const providers = Array.isArray(d.providers) ? d.providers.filter((p) => p?.id) : [];
    const hint = d.hint ? `<p class="ac-hint">${authInline(d.hint)}</p>` : '';
    const signIn = providers.length
      ? `${providersHtml(providers, t)}${hint ? `<div class="ac-divider"><span>${esc(t.or)}</span></div>${hint}` : ''}`
      : hint;
    if (d.account) {
      const a = d.account;
      const cont = `<a class="ac-btn is-primary" href="${safeLink(a.continue?.href ?? '/')}" data-act="continue" data-key="continue">${esc(a.continue?.label || t.continue)}</a>`;
      const out = a.signOut
        ? `<a class="ac-btn is-quiet" href="${safeLink(a.signOut.href ?? '#')}" data-act="sign-out" data-key="sign-out">${esc(a.signOut.label || t.signOut)}</a>`
        : '';
      body = `<section class="ac-account" aria-label="${escAttr(t.signedInAs)}"><p class="ac-label-sm">${esc(t.signedInAs)}</p><div class="ac-who">${avatar(a)}${who(a)}</div>${cont}${out}</section>${
        signIn ? `<div class="ac-divider"><span>${esc(d.switchLabel || t.useDifferent)}</span></div>${signIn}` : ''
      }`;
    } else body = signIn;
  }
  const fine = d.finePrint ? `<p class="ac-fine">${authInline(d.finePrint)}</p>` : '';
  return `<div class="ac">${brand}<div class="ac-card">${head}${error}${body}<slot></slot></div>${fine}<slot name="fine-print"></slot></div>`;
}

/**
 * `authCardHtml` of @2lab.ai/ui/auth-card: `<ui-auth-card>` with a declarative shadow root (the sheet and the
 * card) and its data as JSON (`<` escaped, so the script cannot be closed early) for the element to take over.
 */
export function authCardHtml(
  data: AuthCardData,
  opts: { lang?: AuthLang; page?: boolean; theme?: 'light' | 'dark' } = {},
): string {
  const lang = opts.lang === 'ko' ? 'ko' : 'en';
  const theme = opts.theme === 'dark' || opts.theme === 'light' ? opts.theme : '';
  const hostAttrs = `lang="${lang}"${opts.page ? ' page' : ''}${theme ? ` theme="${theme}"` : ''}`;
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<ui-auth-card ${hostAttrs}><template shadowrootmode="open"><style>${uiLibShadowCss('auth-card.js')}</style><div part="root" class="ui-root">${authCardMarkup(data, lang)}</div></template><script type="application/json" data-auth-state>${json}</script></ui-auth-card>`;
}

// ── The page around the card ──

/** The card's light-DOM children (provider logos in `slot="logo-<id>"`) go in before its closing tag. */
function withSlotted(card: string, slotted: string): string {
  return slotted ? card.replace(/<\/ui-auth-card>$/, `${slotted}</ui-auth-card>`) : card;
}

/**
 * The page: the dashboard's theme choice (soma-theme, else the OS) on <html>, @2lab.ai/ui's tokens.css as the
 * only palette, the server-rendered card filling the viewport, and the element script. With JavaScript off the
 * tokens follow the OS theme and the card is the same one.
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
<style>html, body { margin: 0; background: var(--ui-bg); }</style>
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
 * "Continue as <name>" POSTs the exchange token to `/auth/sso/confirm` (which consumes the jti and swaps the
 * cookie); Cancel goes back to the dashboard and keeps the session — no token is consumed. The token is signed,
 * expiring and single-use, so the form needs no separate CSRF token.
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
      // The card names the new session above; "Continue as <name>" would be cut off on a phone.
      confirmLabel: 'Switch',
      cancelHref: '/dashboard',
    },
  };
  return authPage({
    lang: 'en',
    title: 'soma-work — Confirm session switch',
    card: authCardHtml(data, { lang: 'en', page: true }),
  });
}

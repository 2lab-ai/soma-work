/**
 * Display language for the dashboard web server (#773).
 *
 * Each request runs in one language: the signed-in Slack user's saved setting
 * (`lang ko|en`, the dashboard's top-right toggle, the settings page), else
 * the `soma_lang` cookie the toggle also writes (a viewer-token session has no
 * Slack user to save it for), else Korean.
 *
 * On the way out the response is put in that language:
 *   - an HTML page (dashboard, settings, conversation viewer, sign-in) through
 *     the page catalog (`translatePage`: its text, attributes, script strings);
 *   - a JSON error (`error` / `message`) and the settings snapshot's labels
 *     through the text catalog (`translateText`) — values stay as they are.
 *
 * Korean — the default — is sent byte for byte as rendered.
 */

import {
  type DisplayLang,
  displayLangOf,
  parseDisplayLang,
  runWithDisplayLang,
  translateText,
} from '@soma/common/i18n';
import { translatePage } from '@soma/common/i18n-page';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The cookie the dashboard toggle writes (readable by the page; not a credential). */
export const DISPLAY_LANG_COOKIE = 'soma_lang';

const HANGUL = /[ㄱ-ㆎ가-힣]/;

export interface DisplayLangWebDeps {
  /** The user's saved language, or undefined when they never chose one. */
  savedLangOf(userId: string): DisplayLang | undefined;
}

function cookieLang(request: FastifyRequest): DisplayLang | undefined {
  const header = request.headers?.cookie;
  if (typeof header !== 'string') return undefined;
  const m = new RegExp(`(?:^|;\\s*)${DISPLAY_LANG_COOKIE}=([^;]*)`).exec(header);
  return m ? (parseDisplayLang(decodeURIComponent(m[1])) ?? undefined) : undefined;
}

/** The language of one request: saved setting → cookie → Korean. */
export function requestDisplayLang(request: FastifyRequest, deps: DisplayLangWebDeps): DisplayLang {
  const userId = (request as { authContext?: { userId?: string } }).authContext?.userId;
  const saved = userId ? deps.savedLangOf(userId) : undefined;
  return displayLangOf(saved ?? cookieLang(request));
}

/** Settings snapshot fields that are page text (labels), not the user's values. */
const SETTINGS_TEXT_KEYS = new Set(['label', 'description', 'lockedReason']);

function translateSettingsTree(node: unknown, lang: DisplayLang): unknown {
  if (Array.isArray(node)) return node.map((n) => translateSettingsTree(n, lang));
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'value' || k === 'defaultValue') out[k] = v;
    else if (typeof v === 'string' && SETTINGS_TEXT_KEYS.has(k)) out[k] = translateText(v, lang);
    else out[k] = typeof v === 'object' ? translateSettingsTree(v, lang) : v;
  }
  return out;
}

/** A JSON body in `lang`: its `error` / `message`, and on the settings API the rows' labels. */
export function translateJsonBody(body: string, lang: DisplayLang, url: string): string {
  if (lang === 'ko' || !HANGUL.test(body)) return body;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return body;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return body;
  let obj = data as Record<string, unknown>;
  if (url.startsWith('/api/settings') && !url.startsWith('/api/settings/dashboard-layout')) {
    obj = translateSettingsTree(obj, lang) as Record<string, unknown>;
  }
  for (const k of ['error', 'message']) {
    if (typeof obj[k] === 'string') obj = { ...obj, [k]: translateText(obj[k] as string, lang) };
  }
  return JSON.stringify(obj);
}

function contentTypeOf(reply: FastifyReply): string {
  const t = reply.getHeader('content-type');
  return typeof t === 'string' ? t : '';
}

/** A response body in the request's language (HTML pages, JSON errors and settings labels); anything else as is. */
export function translateResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  deps: DisplayLangWebDeps,
): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    const lang = requestDisplayLang(request, deps);
    if (lang === 'ko') return payload;
    const type = contentTypeOf(reply);
    if (type.startsWith('text/html')) return translatePage(payload, lang);
    // Only an error's words and the settings labels change: the board's big polls are not parsed.
    if (type.startsWith('application/json') && (reply.statusCode >= 400 || request.url.startsWith('/api/settings')))
      return translateJsonBody(payload, lang, request.url);
  } catch {
    // A translation fault never costs the response: it goes as rendered.
  }
  return payload;
}

/**
 * Put every route of `server` in its request's language. Call before any
 * route is registered (it appends a pre-handler to each route as it is added)
 * and before the compression plugin (its response hook must see the page
 * before it is compressed).
 */
export function registerDisplayLang(server: FastifyInstance, deps: DisplayLangWebDeps): void {
  // Last pre-handler of every route: the auth middleware before it has set the user.
  const scope = (request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
    runWithDisplayLang(requestDisplayLang(request, deps), () => done());
  };
  server.addHook('onRoute', (route) => {
    const pre = route.preHandler;
    const list = Array.isArray(pre) ? pre : pre ? [pre] : [];
    route.preHandler = [...list, scope] as typeof route.preHandler;
  });
  // Synchronous (done-callback) on purpose: an async onSend hook defers every send, and a handler that
  // calls reply.send() without returning the reply then resolves first — Fastify sends twice
  // (ERR_HTTP_HEADERS_SENT). A callback that answers at once keeps the send where it was.
  server.addHook('onSend', (request, reply, payload, done) => {
    done(null, translateResponse(request, reply, payload, deps));
  });
}

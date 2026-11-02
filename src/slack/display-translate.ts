/**
 * Display language at the Slack boundary (#774).
 *
 * The bot's Slack text is written in Korean across the code base. Instead of
 * threading a language through every builder, the text is translated where it
 * leaves the process: every Web API call (`WebClient.prototype.makeRequest` — what
 * `say`, `client.chat.*` and `views.*` all go through) and every `respond()`
 * (Bolt posts it with its own axios instance). Only bot-chrome fields are
 * touched — message `text`, Block Kit text objects, view titles and buttons,
 * the assistant status — and only text the English catalog knows: a title, a
 * user's words and the model's answer stay as written. Korean (`ko`, the
 * default) passes through untouched.
 *
 * The language is the work's (`currentDisplayLang()` — the Slack middleware
 * and the turn runner set it from the user), except where the call names its
 * reader: an ephemeral message's `user`, or a DM posted to a user id.
 */

import { WebClient } from '@slack/web-api';
import { currentDisplayLang, type DisplayLang, runWithDisplayLang, translateText } from '@soma/common/i18n';

const HANGUL = /[ㄱ-ㆎ가-힣]/;

/** Keys that hold ids, values and payloads — never display text. */
const OPAQUE_KEYS = new Set([
  'value',
  'action_id',
  'block_id',
  'callback_id',
  'private_metadata',
  'external_id',
  'url',
  'image_url',
  'initial_value',
  'initial_date',
  'initial_time',
  'initial_conversation',
  'initial_channel',
  'initial_user',
  'metadata',
  'user',
  'channel',
  'ts',
  'thread_ts',
  'team_id',
]);

/** A text object's `text`, an option's label, a button: `{ type: 'plain_text' | 'mrkdwn', text }`. */
function isTextObject(node: Record<string, unknown>): boolean {
  return (node.type === 'plain_text' || node.type === 'mrkdwn') && typeof node.text === 'string';
}

/** A Block Kit tree in `lang` — copy-on-write: the caller's objects are never changed. */
export function translateBlockTree<T>(node: T, lang: DisplayLang): T {
  if (lang === 'ko' || node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    let out: unknown[] | null = null;
    node.forEach((item, i) => {
      const next = translateBlockTree(item, lang);
      if (next !== item) {
        out ??= [...node];
        out[i] = next;
      }
    });
    return (out ?? node) as T;
  }
  const obj = node as Record<string, unknown>;
  // A rich_text block is people's and the model's words (a streamed answer, a quoted message).
  if (obj.type === 'rich_text') return node;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(obj)) {
    if (OPAQUE_KEYS.has(k)) continue;
    let next: unknown = v;
    if (k === 'text' && typeof v === 'string' && isTextObject(obj)) next = translateText(v, lang);
    else if (typeof v === 'object' && v !== null) next = translateBlockTree(v, lang);
    else if (typeof v === 'string' && (k === 'placeholder' || k === 'fallback' || k === 'pretext' || k === 'title'))
      next = translateText(v, lang);
    if (next !== v) {
      out ??= { ...obj };
      out[k] = next;
    }
  }
  return (out ?? node) as T;
}

/** A message payload (`say`, `respond`, `chat.*`): its fallback text, blocks and attachments. */
export function translateMessagePayload<T>(payload: T, lang: DisplayLang): T {
  if (lang === 'ko' || payload === null || typeof payload !== 'object') return payload;
  const p = payload as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  const set = (k: string, v: unknown) => {
    if (v === p[k]) return;
    out ??= { ...p };
    out[k] = v;
  };
  if (typeof p.text === 'string' && HANGUL.test(p.text)) set('text', translateText(p.text, lang));
  if (Array.isArray(p.blocks)) set('blocks', translateBlockTree(p.blocks, lang));
  if (Array.isArray(p.attachments)) set('attachments', translateBlockTree(p.attachments, lang));
  if (typeof p.initial_comment === 'string') set('initial_comment', translateText(p.initial_comment, lang));
  return (out ?? payload) as T;
}

const MESSAGE_METHODS = new Set([
  'chat.postMessage',
  'chat.postEphemeral',
  'chat.update',
  'chat.scheduleMessage',
  'chat.stopStream',
  'files.completeUploadExternal',
]);
const VIEW_METHODS = new Set(['views.open', 'views.update', 'views.push', 'views.publish']);

/** A Web API call's options in `lang` (the methods that carry bot text; anything else as is). */
export function translateApiOptions(method: string, options: unknown, lang: DisplayLang): unknown {
  if (lang === 'ko' || options === null || typeof options !== 'object') return options;
  const o = options as Record<string, unknown>;
  if (MESSAGE_METHODS.has(method)) {
    // chat.stopStream's markdown_text is the model's answer — only its blocks are bot chrome.
    if (method === 'chat.stopStream') {
      return Array.isArray(o.blocks) ? { ...o, blocks: translateBlockTree(o.blocks, lang) } : options;
    }
    return translateMessagePayload(options, lang);
  }
  if (VIEW_METHODS.has(method) && o.view && typeof o.view === 'object') {
    const view = translateBlockTree(o.view, lang);
    return view === o.view ? options : { ...o, view };
  }
  if (method === 'assistant.threads.setStatus') {
    const status = typeof o.status === 'string' ? translateText(o.status, lang) : o.status;
    const out: Record<string, unknown> = { ...o, status };
    if (Array.isArray(o.loading_messages))
      out.loading_messages = o.loading_messages.map((m) => (typeof m === 'string' ? translateText(m, lang) : m));
    return out;
  }
  return options;
}

/** DM channels the bot opened (`conversations.open` with one user) → that user: they read what is posted there. */
const dmReaders = new Map<string, string>();
const DM_READERS_MAX = 2000;

export function rememberDmReader(channelId: string, userId: string): void {
  if (dmReaders.size >= DM_READERS_MAX) dmReaders.delete(dmReaders.keys().next().value as string);
  dmReaders.set(channelId, userId);
}

/** Who reads this call when the call itself says: an ephemeral's user, a DM by user id, or a DM the bot opened. */
export function readerOf(method: string, options: unknown): string | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const o = options as Record<string, unknown>;
  if (method === 'chat.postEphemeral' && typeof o.user === 'string') return o.user;
  if (typeof o.channel === 'string') {
    if (/^[UW][A-Z0-9]+$/.test(o.channel)) return o.channel;
    const dm = dmReaders.get(o.channel);
    if (dm) return dm;
  }
  return undefined;
}

type LangOfUser = (userId: string) => DisplayLang;
let installed = false;

/** The Web API method of a request URL (`https://slack.com/api/chat.postMessage` → `chat.postMessage`). */
export function methodOfUrl(url: string): string {
  const path = url.split('?')[0];
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Translate every Web API call in the process. Patched once on
 * `WebClient.prototype.makeRequest`, not `apiCall`: a client binds its
 * `chat.postMessage`-style methods to `apiCall` when it is built, so a patch
 * there would miss every client built before it (Bolt's `app.client`), while
 * `apiCall` reaches `this.makeRequest` through the prototype on every call.
 */
export function installSlackDisplayTranslation(langOfUser: LangOfUser): void {
  if (installed) return;
  installed = true;
  const proto = WebClient.prototype as unknown as {
    makeRequest: (url: string, body: unknown, headers?: unknown) => Promise<unknown>;
  };
  const original = proto.makeRequest;
  proto.makeRequest = async function makeRequest(this: unknown, url: string, body: unknown, headers?: unknown) {
    const method = typeof url === 'string' ? methodOfUrl(url) : '';
    let translated = body;
    try {
      const reader = readerOf(method, body);
      const lang = reader ? langOfUser(reader) : currentDisplayLang();
      translated = translateApiOptions(method, body, lang);
    } catch {
      translated = body; // a translation fault never costs the post
    }
    const response = await original.call(this, url, translated, headers);
    if (method === 'conversations.open') {
      try {
        const users = (body as { users?: unknown } | undefined)?.users;
        const id = (response as { data?: { channel?: { id?: unknown } } })?.data?.channel?.id;
        if (typeof users === 'string' && !users.includes(',') && typeof id === 'string') rememberDmReader(id, users);
      } catch {
        /* only a hint */
      }
    }
    return response;
  };
}

/** Translate Bolt's `respond()` posts (its own axios instance, not the Web API client). */
export function installRespondTranslation(app: unknown): void {
  const axios = (app as { axios?: { interceptors?: { request?: { use: (fn: (c: any) => any) => void } } } })?.axios;
  axios?.interceptors?.request?.use((config: { data?: unknown }) => {
    try {
      config.data = translateMessagePayload(config.data, currentDisplayLang());
    } catch {
      /* the post goes as written */
    }
    return config;
  });
}

/** The Slack user an incoming request is from: an event's user, an action's or view's user, a slash command's user_id. */
export function slackUserOf(body: unknown): string | undefined {
  const b = body as { event?: { user?: unknown }; user?: { id?: unknown } | unknown; user_id?: unknown } | undefined;
  const candidates = [b?.event?.user, (b?.user as { id?: unknown } | undefined)?.id, b?.user_id];
  for (const c of candidates) if (typeof c === 'string' && c.length > 0) return c;
  return undefined;
}

/**
 * Bolt global middleware: run the listeners of each incoming request in the
 * language of the user it is from — everything they post, on any await, is
 * translated for that user. A request with no user stays in the default.
 */
export function displayLangMiddleware(langOfUser: LangOfUser) {
  return async ({ body, next }: { body: unknown; next: () => Promise<void> }): Promise<void> => {
    const user = slackUserOf(body);
    if (!user) return next();
    let lang: DisplayLang;
    try {
      lang = langOfUser(user);
    } catch {
      return next();
    }
    return runWithDisplayLang(lang, () => next());
  };
}

/** Test seam: forget the install so a test can patch a fresh prototype. */
export function __resetSlackDisplayTranslationForTests(): void {
  installed = false;
}

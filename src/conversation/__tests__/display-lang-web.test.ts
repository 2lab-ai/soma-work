/**
 * #773 — every dashboard request runs in one display language (saved setting
 * → `soma_lang` cookie → ko), and its response leaves in that language: HTML
 * pages through the page catalog, JSON errors and settings labels through the
 * text catalog. Korean is sent byte for byte.
 */
import { gunzipSync } from 'node:zlib';
import fastifyCompress from '@fastify/compress';
import { currentDisplayLang, registerDisplayCatalog } from '@soma/common/i18n';
import { registerPageCatalog } from '@soma/common/i18n-page';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DISPLAY_LANG_COOKIE, registerDisplayLang, requestDisplayLang, translateJsonBody } from '../display-lang-web';

registerPageCatalog({ '__dl 새 작업': '__dl New task', '__dl 보관함': '__dl Archive' });
registerDisplayCatalog('en', {
  '__dl 세션을 찾을 수 없어요': '__dl Session not found',
  '__dl 표시 언어': '__dl Display language',
  '__dl 한국어': '__dl Korean',
});

const saved: Record<string, 'ko' | 'en'> = { U_EN: 'en', U_KO: 'ko' };
const deps = { savedLangOf: (u: string) => saved[u] };
const req = (userId?: string, cookie?: string) =>
  ({ authContext: userId ? { userId } : undefined, headers: cookie ? { cookie } : {} }) as unknown as FastifyRequest;

describe('requestDisplayLang', () => {
  it('saved setting, then the cookie, then ko', () => {
    expect(requestDisplayLang(req('U_EN'), deps)).toBe('en');
    expect(requestDisplayLang(req('U_KO', `${DISPLAY_LANG_COOKIE}=en`), deps)).toBe('ko');
    expect(requestDisplayLang(req('U_NONE', `a=1; ${DISPLAY_LANG_COOKIE}=en`), deps)).toBe('en');
    expect(requestDisplayLang(req(undefined, `${DISPLAY_LANG_COOKIE}=en`), deps)).toBe('en');
    expect(requestDisplayLang(req(undefined, `${DISPLAY_LANG_COOKIE}=fr`), deps)).toBe('ko');
    expect(requestDisplayLang(req(), deps)).toBe('ko');
  });
});

describe('translateJsonBody', () => {
  it('translates error / message, and settings labels — never values', () => {
    expect(JSON.parse(translateJsonBody('{"error":"__dl 세션을 찾을 수 없어요","code":"x"}', 'en', '/api/x'))).toEqual({
      error: '__dl Session not found',
      code: 'x',
    });
    const settings = JSON.stringify({
      settings: [
        {
          key: 'displayLanguage',
          label: '__dl 표시 언어',
          value: '__dl 한국어',
          options: [{ value: 'ko', label: '__dl 한국어' }],
        },
      ],
    });
    const out = JSON.parse(translateJsonBody(settings, 'en', '/api/settings'));
    expect(out.settings[0].label).toBe('__dl Display language');
    expect(out.settings[0].value).toBe('__dl 한국어');
    expect(out.settings[0].options[0].label).toBe('__dl Korean');
    // Outside the settings API only errors change; ko never changes.
    expect(translateJsonBody(settings, 'en', '/api/dashboard/sessions')).toBe(settings);
    expect(translateJsonBody('{"error":"__dl 세션을 찾을 수 없어요"}', 'ko', '/api/x')).toBe(
      '{"error":"__dl 세션을 찾을 수 없어요"}',
    );
  });
});

async function app() {
  const server = Fastify();
  registerDisplayLang(server, deps);
  await server.register(fastifyCompress, { global: false });
  const auth = async (request: FastifyRequest) => {
    const u = request.headers['x-user'];
    if (typeof u === 'string') (request as any).authContext = { userId: u };
  };
  const page =
    '<!DOCTYPE html><html lang="ko"><body><button>__dl 새 작업</button><script>var a = \'__dl 보관함\';</script><ui-menu lang="ko"></ui-menu></body></html>';
  server.get(
    '/page',
    { preHandler: [auth], compress: { threshold: 0 } } as any,
    async (_r: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').send(page),
  );
  server.post('/lang', { preHandler: [auth] }, async (request) => ({ lang: currentDisplayLang(), body: request.body }));
  server.get('/missing', { preHandler: [auth] }, async (_r, reply) =>
    reply.code(404).send({ error: '__dl 세션을 찾을 수 없어요' }),
  );
  // The work-log routes' shape: an async handler that sends without returning the reply.
  server.get('/no-return', { preHandler: [auth] }, async (_r, reply) => {
    reply.code(404).send({ error: '__dl 세션을 찾을 수 없어요' });
  });
  return { server, page };
}

describe('registerDisplayLang — the web server end to end', () => {
  it('runs a handler (after its auth and body) in the user language', async () => {
    const { server } = await app();
    const en = await server.inject({ method: 'POST', url: '/lang', headers: { 'x-user': 'U_EN' }, payload: { a: 1 } });
    expect(en.json()).toEqual({ lang: 'en', body: { a: 1 } });
    const ko = await server.inject({ method: 'POST', url: '/lang', headers: { 'x-user': 'U_KO' }, payload: {} });
    expect(ko.json().lang).toBe('ko');
  });

  it('translates a page (text, script strings, lang attributes) even when it is compressed', async () => {
    const { server, page } = await app();
    const en = await server.inject({
      method: 'GET',
      url: '/page',
      headers: { 'x-user': 'U_EN', 'accept-encoding': 'gzip' },
    });
    const html = en.headers['content-encoding'] === 'gzip' ? gunzipSync(en.rawPayload).toString('utf8') : en.body;
    expect(html).toContain('<button>__dl New task</button>');
    expect(html).toContain("var a = '__dl Archive';");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<ui-menu lang="en">');
    const ko = await server.inject({ method: 'GET', url: '/page', headers: { 'x-user': 'U_KO' } });
    expect(ko.body).toBe(page);
  });

  it('translates a JSON error for an English user only', async () => {
    const { server } = await app();
    const en = await server.inject({
      method: 'GET',
      url: '/missing',
      headers: { cookie: `${DISPLAY_LANG_COOKIE}=en` },
    });
    expect(en.statusCode).toBe(404);
    expect(en.json()).toEqual({ error: '__dl Session not found' });
    const ko = await server.inject({ method: 'GET', url: '/missing' });
    expect(ko.json()).toEqual({ error: '__dl 세션을 찾을 수 없어요' });
  });

  it('an async handler that sends without returning the reply is answered once (no ERR_HTTP_HEADERS_SENT)', async () => {
    const { server } = await app();
    const en = await server.inject({ method: 'GET', url: '/no-return', headers: { 'x-user': 'U_EN' } });
    expect(en.statusCode).toBe(404);
    expect(en.json()).toEqual({ error: '__dl Session not found' });
    const ko = await server.inject({ method: 'GET', url: '/no-return' });
    expect(ko.json()).toEqual({ error: '__dl 세션을 찾을 수 없어요' });
  });
});

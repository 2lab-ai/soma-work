import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const MASK = resolve(__dirname, '..', 'scripts', 'mask.mjs');

type MaskFn = (value: unknown) => { value: unknown; count: number };
let mask: MaskFn;

beforeAll(async () => {
  const mod = (await import(pathToFileURL(MASK).href)) as { mask: MaskFn };
  mask = mod.mask;
});

function runCli(input: Buffer | string) {
  return spawnSync(process.execPath, [MASK], { input, encoding: 'utf8' });
}

describe('qa-report mask.mjs — masking shapes', () => {
  it('masks a sensitive key whatever its value type', () => {
    const r = mask({
      token: 'a',
      password: 12345,
      apiKey: ['x', 'y'],
      clientSecret: { nested: 'z' },
      Authorization: 'Bearer abcdefghijk',
    });
    expect(r.value).toEqual({
      token: '***',
      password: '***',
      apiKey: '***',
      clientSecret: '***',
      Authorization: '***',
    });
    expect(r.count).toBe(5);
  });

  it('masks token arrays and JWTs inside neutral arrays', () => {
    const r = mask({ refreshTokens: ['t1', 't2'], list: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-part_1'] });
    expect(r.value).toEqual({ refreshTokens: '***', list: ['***'] });
  });

  it('masks JSON serialized inside a string, at any depth, keeping large integers exact', () => {
    const body = '{"accessToken":"leak-1","nested":"{\\"secret\\":\\"leak-2\\",\\"id\\":12345678901234567890}"}';
    const r = mask({ body });
    const out = (r.value as { body: string }).body;
    expect(out).not.toContain('leak-1');
    expect(out).not.toContain('leak-2');
    expect(out).toContain('12345678901234567890');
    expect(r.count).toBe(2);
  });

  it('masks JSON text in place and keeps every other byte', () => {
    const text = '{\n  "user": {"password": "p", "tokens": ["a","b"], "id": 98765432109876543210},\n  "ok": true\n}';
    const r = mask(text);
    expect(r.value).toBe(
      '{\n  "user": {"password": "***", "tokens": "***", "id": 98765432109876543210},\n  "ok": true\n}',
    );
  });

  it('masks form bodies', () => {
    expect(mask('username=bob&password=hunter2&next=%2Fhome').value).toBe('username=bob&password=***&next=%2Fhome');
  });

  it('masks query parameters named token / key / secret / sig / passw…', () => {
    const url =
      'https://app.example.com/api/x?id=1&access_token=a1&apikey=a2&client_secret=a3&sig=a4&passwordReset=a5#f';
    expect(mask(url).value).toBe(
      'https://app.example.com/api/x?id=1&access_token=***&apikey=***&client_secret=***&sig=***&passwordReset=***#f',
    );
  });

  it('masks JWT shapes in free text', () => {
    expect(mask('started with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-DEF_123 ok').value).toBe('started with *** ok');
  });

  it('masks Authorization / Cookie / Set-Cookie header lines and bearer credentials', () => {
    const raw =
      'GET /api\nAuthorization: Bearer abcdefghijk\nCookie: sid=1; theme=dark\nSet-Cookie: sid=2; HttpOnly\nAccept: */*';
    expect(mask(raw).value).toBe('GET /api\nAuthorization: ***\nCookie: ***\nSet-Cookie: ***\nAccept: */*');
    expect(mask('see Bearer abc123def456 here').value).toBe('see Bearer *** here');
    expect(mask('Basic dXNlcjpwYXNzd29yZA== sent').value).toBe('Basic *** sent');
  });

  it('masks JSON fragments inside non-JSON text, plain and escaped', () => {
    expect(mask('HTTP/1.1 200 OK\n\n{"token":"leak", "count": 3} tail').value).toBe(
      'HTTP/1.1 200 OK\n\n{"token":"***", "count": 3} tail',
    );
    expect(mask('log body="{\\"accessToken\\":\\"leak\\"}"').value).toBe('log body="{\\"accessToken\\":\\"***\\"}"');
  });

  it('leaves issue keys, account references and embedded images alone, and is idempotent', () => {
    const value = {
      key: 'PROJ-123',
      auth: { accountRef: 'qaEnv.accounts.player' },
      steps: ['1) open the orders page'],
      shot: 'data:image/png;base64,iVBORw0KGgo=',
    };
    expect(mask(value)).toEqual({ value, count: 0 });
    const once = mask('{"password":"x","note":"Bearer abc123def456"}');
    expect(mask(once.value)).toEqual({ value: once.value, count: 0 });
  });
});

describe('qa-report mask.mjs — JSON embedded in plain text', () => {
  it('masks a fenced JSON block in a Markdown comment', () => {
    const r = mask('QA note:\n```json\n{"token":["credential-value"]}\n```\nend');
    expect(r.value).toBe('QA note:\n```json\n{"token":"***"}\n```\nend');
    expect(r.count).toBe(1);
  });

  it('masks comment-prefixed objects and arrays', () => {
    expect(mask('// {"auth":{"secret":"s3cr3t"}}').value).toBe('// {"auth":{"secret":"***"}}');
    expect(mask('# resp: [{"password":"p1"},{"ok":1}] done').value).toBe('# resp: [{"password":"***"},{"ok":1}] done');
  });

  it('fails closed on JSON-looking fragments that do not parse', () => {
    expect(mask('> {\n>   "token": ["x",\n>   "y"],\n>   "ok": 1\n> }').value).toBe(
      '> {\n>   "token": "***",\n>   "ok": 1\n> }',
    );
    expect(mask('body was {"password": "abc", "next":').value).toBe('body was {"password": "***", "next":');
    expect(mask('raw: {\\"secret\\":{\\"a\\":1}, trailing').value).toBe('raw: {\\"secret\\":\\"***\\", trailing');
  });

  it('masks a JSON string literal that holds JSON with an array value', () => {
    expect(mask('log body="{\\"tokens\\":[\\"a\\"]}"').value).toBe('log body="{\\"tokens\\":\\"***\\"}"');
  });

  it('masks JSON nested two string levels deep inside a quoted literal in text', () => {
    const inner = JSON.stringify({ body: JSON.stringify({ token: 'deep-leak' }) });
    const r = mask(`x=${JSON.stringify(inner)} end`);
    expect(r.value).not.toContain('deep-leak');
    expect(r.count).toBe(1);
  });

  it('leaves prose, Markdown links and non-JSON braces alone', () => {
    const prose =
      'Basic authentication is disabled; Bearer tokens are required. See [the PR](https://app.example.com/pull/1), [notes] and {not json}.';
    expect(mask(prose)).toEqual({ value: prose, count: 0 });
  });
});

describe('qa-report mask.mjs — CLI filter', () => {
  it('masks JSON on stdin and writes JSON of the same shape', () => {
    const r = runCli('{"password":"x","id":1}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{"password":"***","id":1}');
    expect(r.stderr).toContain('1 value(s) masked');
  });

  it('masks plain text on stdin', () => {
    const r = runCli('Authorization: Bearer abcdefghijk\nbody');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('Authorization: ***\nbody');
  });

  it('exits non-zero on input that is not UTF-8', () => {
    const r = runCli(Buffer.from([0xff, 0xfe, 0x20, 0x62]));
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });
});

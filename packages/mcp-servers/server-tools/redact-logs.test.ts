import { describe, expect, it } from 'vitest';
import { REDACTED, redactLogSecrets } from './redact-logs.js';

// ── Fixtures ────────────────────────────────────────────────
// Every complete credential shape is assembled at load time from parts that mean nothing on their own:
// GitHub push protection scans blobs, and a full-shape literal here would be refused at `git push`
// exactly like a real leak (see src/test-utils/slack-token-fixtures.ts). All values are made up.

const join = (sep: string, ...parts: string[]) => parts.join(sep);

const HEX32 = '0123456789abcdef'.repeat(2);
const ACCOUNT_SID = ['A', 'C', 'f00dfeed'.repeat(4)].join('');
const AUTH_TOKEN = 'cafebabe'.repeat(4);
const EMAIL_API_KEY = join('.', 'SG', 'Abc_def-Ghi1234567890j', `${'K'.repeat(16)}_lmnop-qrstu1234567890vwxyz`);
const JWT = join('.', 'eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', 'bWFkZS11cC1zaWduYXR1cmU');
const GH_TOKEN = join('_', 'ghp', 'a1B2c3D4'.repeat(4));
const GH_PAT = join('_', 'github', 'pat', '11AAAAAAA0'.repeat(3));
const CF_TOKEN = join('_', 'cfut', 'Zz9-Yy8_'.repeat(4));
const SLACK_TOKEN = join('-', 'xoxb', '1', '2', 'aaaabbbbcccc');
const BEARER_VALUE = 'abc.def-ghi_jkl~mno+pqr/stu==';
const PEM_BEGIN = join(' ', '-----BEGIN RSA', 'PRIVATE KEY-----');
const PEM_END = join(' ', '-----END RSA', 'PRIVATE KEY-----');
const PEM_BODY = ['QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w', 'cXJzdHV2d3h5ejAxMjM0NTY3ODk='];

/** Every made-up secret above: none may survive a redaction. */
const SECRETS = [ACCOUNT_SID, AUTH_TOKEN, EMAIL_API_KEY, JWT, GH_TOKEN, GH_PAT, CF_TOKEN, SLACK_TOKEN, BEARER_VALUE];

function expectNoSecrets(out: string) {
  for (const secret of SECRETS) expect(out).not.toContain(secret);
  for (const line of PEM_BODY) expect(out).not.toContain(line);
}

// ── Positive cases ──────────────────────────────────────────

describe('redactLogSecrets: JSON options object', () => {
  it('redacts the SID and auth token of a constructor that logs its options, keeping key names', () => {
    const line = `client init {"AccountSid":"${ACCOUNT_SID}","AuthToken":"${AUTH_TOKEN}","Region":"us1","Edge":"ashburn"}`;
    expect(redactLogSecrets(line)).toBe(
      `client init {"AccountSid":"${REDACTED}","AuthToken":"${REDACTED}","Region":"us1","Edge":"ashburn"}`,
    );
  });

  it('handles the same object escaped inside a JSON log line (one level of escaping)', () => {
    const line = `{"level":"info","msg":"client init {\\"AccountSid\\":\\"${ACCOUNT_SID}\\",\\"AuthToken\\":\\"${AUTH_TOKEN}\\"}"}`;
    expect(redactLogSecrets(line)).toBe(
      `{"level":"info","msg":"client init {\\"AccountSid\\":\\"${REDACTED}\\",\\"AuthToken\\":\\"${REDACTED}\\"}"}`,
    );
  });

  it('redacts the whole quoted value, spaces and escaped quotes included', () => {
    expect(redactLogSecrets('{"password":"p@ss w0rd \\"x\\" tail","user":"svc"}')).toBe(
      `{"password":"${REDACTED}","user":"svc"}`,
    );
  });

  it('redacts an escaped value that ends in an escaped backslash', () => {
    expect(redactLogSecrets('{"msg":"{\\"secret\\":\\"abc\\\\\\\\\\"}"}')).toBe(
      `{"msg":"{\\"secret\\":\\"${REDACTED}\\"}"}`,
    );
  });

  it('redacts a single-quoted value (util.inspect / Python repr)', () => {
    expect(redactLogSecrets("{ user: 'svc', password: 'hunter2', apiKey: 'k-123' }")).toBe(
      `{ user: 'svc', password: '${REDACTED}', apiKey: '${REDACTED}' }`,
    );
  });

  it('redacts an unterminated quoted value to the end of the line', () => {
    expect(redactLogSecrets('{"client_secret":"abcdef0123')).toBe(`{"client_secret":"${REDACTED}`);
  });
});

describe('redactLogSecrets: key=value and key: value', () => {
  it.each([
    ['DB_PASSWORD=hunter2', `DB_PASSWORD=${REDACTED}`],
    ['passwd=hunter2 user=svc', `passwd=${REDACTED} user=svc`],
    ['spring.datasource.password = s3cr3t', `spring.datasource.password = ${REDACTED}`],
    ['api_key: abc123def456', `api_key: ${REDACTED}`],
    ['X-Api-Key: k-live-123', `X-Api-Key: ${REDACTED}`],
    ['GET /cb?code=1&access_token=abc123&page=2', `GET /cb?code=1&access_token=${REDACTED}&page=2`],
    ['authtoken=abc auth_token=def', `authtoken=${REDACTED} auth_token=${REDACTED}`],
    ['privateKey=abc private_key=def', `privateKey=${REDACTED} private_key=${REDACTED}`],
    ['Config{secretKey=abc, region=us1}', `Config{secretKey=${REDACTED}, region=us1}`],
    ['connectionString=Server=db;Password=pw1;', `connectionString=${REDACTED};Password=${REDACTED};`],
    ['--password=hunter2', `--password=${REDACTED}`],
    ['"password"=>"hunter2"', `"password"=>"${REDACTED}"`],
    ["{'api_key' => 'k1', 'user' => 'svc'}", `{'api_key' => '${REDACTED}', 'user' => 'svc'}`],
    ['[password] => hunter2', `[password] => ${REDACTED}`],
    ['POST /signup user[password]=hunter2&user[name]=svc', `POST /signup user[password]=${REDACTED}&user[name]=svc`],
  ])('%s', (input, expected) => {
    expect(redactLogSecrets(input)).toBe(expected);
  });

  it('redacts an Authorization credential and keeps the scheme', () => {
    expect(redactLogSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(`Authorization: Basic ${REDACTED}`);
    expect(redactLogSecrets('"authorization":"Token abc123"')).toBe(`"authorization":"${REDACTED}"`);
  });

  it('redacts a SID only as the value of a key containing "sid"', () => {
    expect(redactLogSecrets(`accountSid=${ACCOUNT_SID}`)).toBe(`accountSid=${REDACTED}`);
    expect(redactLogSecrets(`{"account_sid": "${ACCOUNT_SID}"}`)).toBe(`{"account_sid": "${REDACTED}"}`);
  });
});

describe('redactLogSecrets: credential shapes', () => {
  it.each([
    ['email API key', EMAIL_API_KEY],
    ['JWT', JWT],
    ['GitHub token', GH_TOKEN],
    ['GitHub fine-grained PAT', GH_PAT],
    ['Cloudflare token', CF_TOKEN],
    ['Slack token', SLACK_TOKEN],
  ])('redacts a bare %s anywhere in a line', (_name, secret) => {
    expect(redactLogSecrets(`sending with ${secret} now`)).toBe(`sending with ${REDACTED} now`);
  });

  it('redacts a Bearer credential and keeps the scheme word', () => {
    expect(redactLogSecrets(`Authorization: Bearer ${BEARER_VALUE}`)).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactLogSecrets(`header authorization=bearer ${BEARER_VALUE}`)).toBe(
      `header authorization=bearer ${REDACTED}`,
    );
  });

  it('redacts a Bearer value under a token key without leaking the credential', () => {
    const out = redactLogSecrets(`token: Bearer ${BEARER_VALUE}`);
    expect(out).not.toContain(BEARER_VALUE);
    expect(out.startsWith('token: ')).toBe(true);
  });
});

describe('redactLogSecrets: URL userinfo', () => {
  it.each([
    [
      'mongodb://appuser:hunter2hunter2@mongo.internal:27017/app',
      `mongodb://appuser:${REDACTED}@mongo.internal:27017/app`,
    ],
    ['connecting to redis://:s3cr3t@cache.internal:6379/0', `connecting to redis://:${REDACTED}@cache.internal:6379/0`],
    ['amqp://svc:p@ss@mq.internal/vhost', `amqp://svc:${REDACTED}@mq.internal/vhost`],
    [
      '{"url":"postgres://u:pw@db.internal/x","other":"a@b"}',
      `{"url":"postgres://u:${REDACTED}@db.internal/x","other":"a@b"}`,
    ],
  ])('%s', (input, expected) => {
    expect(redactLogSecrets(input)).toBe(expected);
  });
});

describe('redactLogSecrets: PEM private key blocks', () => {
  it('redacts a multi-line block, keeping the markers and the line count', () => {
    const input = ['loaded key:', PEM_BEGIN, ...PEM_BODY, PEM_END, 'next line', ''].join('\n');
    expect(redactLogSecrets(input)).toBe(
      ['loaded key:', PEM_BEGIN, REDACTED, REDACTED, PEM_END, 'next line', ''].join('\n'),
    );
  });

  it('redacts a block whose lines carry --timestamps prefixes', () => {
    const ts = '2026-01-02T03:04:05.000000000Z ';
    const input = [`${ts}${PEM_BEGIN}`, `${ts}${PEM_BODY[0]}`, `${ts}${PEM_END}`, `${ts}ok`].join('\n');
    expect(redactLogSecrets(input)).toBe([`${ts}${PEM_BEGIN}`, REDACTED, `${ts}${PEM_END}`, `${ts}ok`].join('\n'));
  });

  it('redacts a block cut off by the tail to the end of the output', () => {
    const input = ['start', PEM_BEGIN, ...PEM_BODY].join('\n');
    expect(redactLogSecrets(input)).toBe(['start', PEM_BEGIN, REDACTED, REDACTED].join('\n'));
  });

  it('redacts a block written on one line with escaped newlines', () => {
    const line = `{"msg":"key ${PEM_BEGIN}\\n${PEM_BODY.join('\\n')}\\n${PEM_END}\\n done"}`;
    expect(redactLogSecrets(line)).toBe(`{"msg":"key ${PEM_BEGIN}${REDACTED}${PEM_END}\\n done"}`);
  });

  it('redacts a one-line block whose END is missing to the end of the line', () => {
    const line = `{"msg":"key ${PEM_BEGIN}\\n${PEM_BODY[0]}`;
    expect(redactLogSecrets(`${line}\nafter`)).toBe(`{"msg":"key ${PEM_BEGIN}${REDACTED}\n${REDACTED}`);
  });
});

// ── Negatives ───────────────────────────────────────────────

describe('redactLogSecrets: leaves ordinary log lines intact', () => {
  it.each([
    '2026-01-02T03:04:05.123Z INFO server listening on port 8080',
    '2026-01-02T03:04:05.000000000Z GET /api/v1/users 200 12ms',
    `request_id=${HEX32} status=200 duration=12ms`,
    `{"requestId":"${ACCOUNT_SID}","traceId":"${HEX32}"}`,
    `trace ${ACCOUNT_SID} finished`,
    'invalid token, please sign in again',
    'refreshing token for user 42',
    'no password provided for user svc',
    '{"input_tokens":1234,"output_tokens":56,"max_tokens":4096}',
    'usage: total_tokens=1290',
    '{"passwordRequired": true, "tokenExpired": false, "secretRef": null}',
    'user=alice action=login ok=true',
    'postgres://db.internal:5432/app',
    'https://user@example.com/path?page=2#top',
    'level=info msg="cache warmed" keys=1024',
    '',
  ])('%s', (line) => {
    expect(redactLogSecrets(line)).toBe(line);
  });

  it('preserves line endings and trailing newlines byte for byte', () => {
    expect(redactLogSecrets('line1\nline2\nline3\n')).toBe('line1\nline2\nline3\n');
    expect(redactLogSecrets('a\r\npassword=x\r\nb\r\n')).toBe(`a\r\npassword=${REDACTED}\r\nb\r\n`);
  });
});

// ── Properties ──────────────────────────────────────────────

const CORPUS = [
  `client init {"AccountSid":"${ACCOUNT_SID}","AuthToken":"${AUTH_TOKEN}","Region":"us1"}`,
  `{"level":"info","msg":"client init {\\"AccountSid\\":\\"${ACCOUNT_SID}\\",\\"AuthToken\\":\\"${AUTH_TOKEN}\\"}"}`,
  `mail key ${EMAIL_API_KEY} jwt ${JWT} gh ${GH_TOKEN} pat ${GH_PAT} cf ${CF_TOKEN} slack ${SLACK_TOKEN}`,
  `Authorization: Bearer ${BEARER_VALUE}`,
  'Authorization: Basic dXNlcjpwYXNzd29yZA==',
  'mongodb://appuser:hunter2hunter2@mongo.internal:27017/app',
  'DB_PASSWORD=hunter2 connectionString=Server=db;Password=pw1;',
  PEM_BEGIN,
  ...PEM_BODY,
  PEM_END,
  `{"msg":"key ${PEM_BEGIN}\\n${PEM_BODY.join('\\n')}\\n${PEM_END}"}`,
  '2026-01-02T03:04:05.123Z INFO server listening on port 8080',
].join('\n');

describe('redactLogSecrets: properties', () => {
  it('leaves none of the fixture secrets in a mixed log', () => {
    expectNoSecrets(redactLogSecrets(CORPUS));
  });

  it('is idempotent', () => {
    const once = redactLogSecrets(CORPUS);
    expect(redactLogSecrets(once)).toBe(once);
  });

  it('stays linear on adversarial 1 MB single lines', () => {
    const size = 1024 * 1024;
    const inputs = [
      'a'.repeat(size),
      'a.'.repeat(size / 2),
      'a-b_'.repeat(size / 4),
      'token'.repeat(size / 5),
      'a:'.repeat(size / 2),
      '"a":"'.repeat(size / 5),
      'password="'.repeat(size / 10),
      '\\"a\\":\\"'.repeat(size / 8),
      'eyJ'.repeat(size / 3),
      'SG.'.repeat(size / 3),
      'ab://'.repeat(size / 5),
      'ab://u:'.repeat(size / 7),
      'Bearer '.repeat(size / 7),
      join(' ', '-----BEGIN', 'A'.repeat(size)),
      '\\'.repeat(size),
    ];
    for (const input of inputs) {
      const start = performance.now();
      redactLogSecrets(input);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });
});

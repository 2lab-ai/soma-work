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
  expect(out).not.toContain('opaque-credential');
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
    expect(redactLogSecrets(input)).toBe(
      [`${ts}${PEM_BEGIN}`, `${ts}${REDACTED}`, `${ts}${PEM_END}`, `${ts}ok`].join('\n'),
    );
  });

  it('redacts block text before the END marker, keeping only a docker log prefix', () => {
    const ts = '2026-01-02T03:04:05.000000000Z ';
    expect(redactLogSecrets([PEM_BEGIN, `${PEM_BODY[0]} ${PEM_END}`, 'after'].join('\n'))).toBe(
      [PEM_BEGIN, `${REDACTED}${PEM_END}`, 'after'].join('\n'),
    );
    expect(redactLogSecrets([`${ts}${PEM_BEGIN}`, `${ts}${PEM_BODY[1]} ${PEM_END}`].join('\n'))).toBe(
      [`${ts}${PEM_BEGIN}`, `${ts}${REDACTED}${PEM_END}`].join('\n'),
    );
    const bareEnd = join(' ', '-----END', 'PRIVATE KEY-----');
    expect(redactLogSecrets([join(' ', '-----BEGIN', 'PRIVATE KEY-----'), `QUJDREVGR0hJ ${bareEnd}`].join('\n'))).toBe(
      [join(' ', '-----BEGIN', 'PRIVATE KEY-----'), `${REDACTED}${bareEnd}`].join('\n'),
    );
    const svc = 'mystack_web.1.abcdef123456@node-1    | ';
    expect(redactLogSecrets([`${svc}${PEM_BEGIN}`, `${svc}${PEM_BODY[0]}`, `${svc}${PEM_END}`].join('\n'))).toBe(
      [`${svc}${PEM_BEGIN}`, `${svc}${REDACTED}`, `${svc}${PEM_END}`].join('\n'),
    );
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

describe('redactLogSecrets: secret context across lines', () => {
  const ts = '2026-01-02T03:04:05.000000000Z ';

  it('redacts a value on the line after its key and separator', () => {
    expect(redactLogSecrets(`{"AuthToken":\n  "${AUTH_TOKEN}"}`)).toBe(`{"AuthToken":\n  "${REDACTED}"}`);
    expect(redactLogSecrets(`password:\n  hunter2\nnext`)).toBe(`password:\n  ${REDACTED}\nnext`);
  });

  it('skips blank lines and docker timestamp prefixes while a key waits for its value', () => {
    expect(redactLogSecrets(`${ts}{"AuthToken":\n${ts}\n${ts}  "${AUTH_TOKEN}"}`)).toBe(
      `${ts}{"AuthToken":\n${ts}\n${ts}  "${REDACTED}"}`,
    );
  });

  it('redacts a value whose separator is on the line after a quoted key', () => {
    expect(redactLogSecrets(`{"AuthToken"\n  : "${AUTH_TOKEN}"}`)).toBe(`{"AuthToken"\n  : "${REDACTED}"}`);
    expect(redactLogSecrets(`{"AccountSid"\n  :"${ACCOUNT_SID}"}`)).toBe(`{"AccountSid"\n  :"${REDACTED}"}`);
  });

  it('redacts every line of a quoted value that spans lines', () => {
    expect(redactLogSecrets('password: "line one\nline two\nline three" user=svc\nafter')).toBe(
      `password: "${REDACTED}\n${REDACTED}\n${REDACTED}" user=svc\nafter`,
    );
    expect(redactLogSecrets(`${ts}{"secret":"abc\n${ts}def"}`)).toBe(`${ts}{"secret":"${REDACTED}\n${ts}${REDACTED}"}`);
  });

  it('lets a waiting key expire after the next non-empty line', () => {
    expect(redactLogSecrets('token:\n  "v1"\n"v2"')).toBe(`token:\n  "${REDACTED}"\n"v2"`);
    expect(redactLogSecrets('{"AuthToken"\nplain line\n: "x"')).toBe('{"AuthToken"\nplain line\n: "x"');
  });

  it('does not wait on a quoted secret word that is a value, not a key', () => {
    expect(redactLogSecrets('{"msg":"token"\n: "x"}')).toBe('{"msg":"token"\n: "x"}');
  });
});

describe('redactLogSecrets: secret collections', () => {
  it('redacts a whole array or object under a secret key', () => {
    expect(redactLogSecrets('{"apiKeys":["opaque-credential"]}')).toBe(`{"apiKeys":${REDACTED}}`);
    expect(redactLogSecrets('{"secret":{"value":"opaque-credential"},"region":"us1"}')).toBe(
      `{"secret":${REDACTED},"region":"us1"}`,
    );
    expect(redactLogSecrets("{'passwords': ['p1', 'p2'], 'user': 'svc'}")).toBe(
      `{'passwords': ${REDACTED}, 'user': 'svc'}`,
    );
  });

  it('respects brackets and escapes inside strings', () => {
    expect(redactLogSecrets('{"tokens":["a]b","c}d\\\\"],"next":"ok"}')).toBe(`{"tokens":${REDACTED},"next":"ok"}`);
    expect(redactLogSecrets('{"msg":"cfg {\\"apiKeys\\":[\\"k1\\",\\"k]2\\"],\\"region\\":\\"us1\\"}"}')).toBe(
      `{"msg":"cfg {\\"apiKeys\\":${REDACTED},\\"region\\":\\"us1\\"}"}`,
    );
  });

  it('redacts a collection that spans lines, keeping docker prefixes', () => {
    const ts = '2026-01-02T03:04:05.000000000Z ';
    const input = [
      '{',
      '  "secrets": {',
      '    "user": "svc",',
      '    "value": "opaque-credential"',
      '  },',
      '  "region": "us1"',
      '}',
    ];
    expect(redactLogSecrets(input.join('\n'))).toBe(
      ['{', `  "secrets": ${REDACTED}`, REDACTED, REDACTED, `${REDACTED},`, '  "region": "us1"', '}'].join('\n'),
    );
    expect(redactLogSecrets(input.map((l) => ts + l).join('\n'))).toBe(
      ['{', `  "secrets": ${REDACTED}`, REDACTED, REDACTED, `${REDACTED},`, '  "region": "us1"', '}']
        .map((l) => ts + l)
        .join('\n'),
    );
  });

  it('redacts an unclosed collection to the end of the output rather than leak what follows', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `"opaque-${i}",`);
    const out = redactLogSecrets(['{"apiKeys":[', ...body, 'tail line'].join('\n')).split('\n');
    expect(out[0]).toBe(`{"apiKeys":${REDACTED}`);
    expect(out.slice(1).every((l) => l === REDACTED)).toBe(true);
    expect(out.length).toBe(body.length + 2);
  });

  it('ends a string inside a collection at the end of its line, so a stray quote cannot hide the close', () => {
    expect(redactLogSecrets("secrets: [it's\n  x]\nafter")).toBe(`secrets: ${REDACTED}\n${REDACTED}\nafter`);
  });

  it('leaves collections under ordinary keys to their own key matching', () => {
    expect(redactLogSecrets('{"items":["a","b"],"meta":{"page":2,"password":"x"}}')).toBe(
      `{"items":["a","b"],"meta":{"page":2,"password":"${REDACTED}"}}`,
    );
  });
});

describe('redactLogSecrets: shapes and key blocks after a waiting key', () => {
  const ts = '2026-01-02T03:04:05.000000000Z ';
  const bareBegin = join(' ', '-----BEGIN', 'PRIVATE KEY-----');
  const bareEnd = join(' ', '-----END', 'PRIVATE KEY-----');

  it('redacts a Bearer credential on the line after the key whole, keeping the scheme', () => {
    expect(redactLogSecrets('token:\nBearer opaque-credential\nafter')).toBe(`token:\nBearer ${REDACTED}\nafter`);
    expect(redactLogSecrets(`${ts}token:\n${ts}Bearer opaque-credential`)).toBe(`${ts}token:\n${ts}Bearer ${REDACTED}`);
  });

  it('redacts a credential shape on the line after the key', () => {
    expect(redactLogSecrets(`apiKey:\n${EMAIL_API_KEY} trailing`)).toBe(`apiKey:\n${REDACTED}`);
  });

  it('enters key-block state when the value is a key block', () => {
    const input = ['privateKey:', bareBegin, PEM_BODY[0], PEM_BODY[1], bareEnd, 'after'].join('\n');
    expect(redactLogSecrets(input)).toBe(['privateKey:', bareBegin, REDACTED, REDACTED, bareEnd, 'after'].join('\n'));
    const stamped = ['privateKey:', bareBegin, PEM_BODY[0], bareEnd].map((l) => ts + l).join('\n');
    expect(redactLogSecrets(stamped)).toBe(['privateKey:', bareBegin, REDACTED, bareEnd].map((l) => ts + l).join('\n'));
  });

  it('keeps the scheme of a credential under any secret key on one line', () => {
    expect(redactLogSecrets('auth_token: Token abc123 next=1')).toBe(`auth_token: Token ${REDACTED}`);
    expect(redactLogSecrets('auth_token=Token abc123 next=1')).toBe(`auth_token=Token ${REDACTED} next=1`);
    expect(redactLogSecrets(`token: Bearer ${BEARER_VALUE}`)).toBe(`token: Bearer ${REDACTED}`);
  });

  it('keeps the key-block marker when the key and BEGIN share a line', () => {
    const input = [`privateKey: ${bareBegin}`, PEM_BODY[0], bareEnd].join('\n');
    expect(redactLogSecrets(input)).toBe([`privateKey: ${bareBegin}`, REDACTED, bareEnd].join('\n'));
  });
});

describe('redactLogSecrets: multi-word values after a colon', () => {
  it.each([
    ['password: correct horse battery', `password: ${REDACTED}`],
    ['Password: correct horse, battery staple', `Password: ${REDACTED}`],
    ['password: hunter two, retries: 3', `password: ${REDACTED}, retries: 3`],
    ['{"password":hunter two,"user":"svc"}', `{"password":${REDACTED},"user":"svc"}`],
    ['{ password: correct horse }', `{ password: ${REDACTED} }`],
    [
      '{"msg":"login failed, password: correct horse","level":"warn"}',
      `{"msg":"login failed, password: ${REDACTED}","level":"warn"}`,
    ],
    [
      '{"msg":"cfg {\\"token\\": two words,\\"user\\":\\"svc\\"}"}',
      `{"msg":"cfg {\\"token\\": ${REDACTED},\\"user\\":\\"svc\\"}"}`,
    ],
    ['Authorization: Basic abc def', `Authorization: Basic ${REDACTED}`],
  ])('%s', (input, expected) => {
    expect(redactLogSecrets(input)).toBe(expected);
  });

  it('keeps the single-token end after =, => and [k] =', () => {
    expect(redactLogSecrets('password=correct horse user=svc')).toBe(`password=${REDACTED} horse user=svc`);
    expect(redactLogSecrets('"password" => correct horse')).toBe(`"password" => ${REDACTED} horse`);
    expect(redactLogSecrets('[password] => correct horse')).toBe(`[password] => ${REDACTED} horse`);
  });

  it("runs a waiting colon key's value on the next line to its end", () => {
    expect(redactLogSecrets('password:\ncorrect horse battery\nnext')).toBe(`password:\n${REDACTED}\nnext`);
  });

  it('still keeps literals and counts that end at the next field', () => {
    for (const line of ["{ token: undefined, user: 'svc' }", "{'token': None, 'user': 'svc'}", '{"secretRef": null}']) {
      expect(redactLogSecrets(line)).toBe(line);
    }
  });
});

describe('redactLogSecrets: YAML values under a secret key', () => {
  const ts = '2026-01-02T03:04:05.000000000Z ';

  it('redacts every item of an indented list, keeping the markers, up to a sibling key', () => {
    expect(redactLogSecrets('secrets:\n  - opaque-credential\n  - another-credential\nregion: us1')).toBe(
      `secrets:\n  - ${REDACTED}\n  - ${REDACTED}\nregion: us1`,
    );
  });

  it("redacts a list written at the key's own indent", () => {
    expect(redactLogSecrets('secrets:\n- opaque-credential\n- another-credential\nregion: us1')).toBe(
      `secrets:\n- ${REDACTED}\n- ${REDACTED}\nregion: us1`,
    );
  });

  it.each(['|', '>', '|-', '>+', '|2', '>-  # folded'])('redacts block-scalar text after "%s"', (indicator) => {
    const input = `password: ${indicator}\n  opaque-credential\n  second line\n\n  after blank\nuser: svc`;
    expect(redactLogSecrets(input)).toBe(
      `password: ${indicator}\n  ${REDACTED}\n  ${REDACTED}\n\n  ${REDACTED}\nuser: svc`,
    );
  });

  it('redacts a nested mapping, nested lists and quoted items', () => {
    const input = [
      'secrets:',
      '  user: svc',
      '  value: opaque-credential',
      '  - - nested-item',
      '  - "quoted-item"',
      '    continued: x',
      'region: us1',
    ].join('\n');
    expect(redactLogSecrets(input)).toBe(
      [
        'secrets:',
        `  ${REDACTED}`,
        `  ${REDACTED}`,
        `  - - ${REDACTED}`,
        `  - "${REDACTED}"`,
        `    ${REDACTED}`,
        'region: us1',
      ].join('\n'),
    );
  });

  it('measures indentation from the key, after the docker prefix', () => {
    const input = ['app:', '  password: |', '    opaque-credential', '  user: svc', 'next: 1'];
    const expected = ['app:', '  password: |', `    ${REDACTED}`, '  user: svc', 'next: 1'];
    expect(redactLogSecrets(input.join('\n'))).toBe(expected.join('\n'));
    expect(redactLogSecrets(input.map((l) => ts + l).join('\n'))).toBe(expected.map((l) => ts + l).join('\n'));
    const item = ['users:', '  - name: svc', '    password:', '      opaque-credential', '    role: admin'];
    expect(redactLogSecrets(item.join('\n'))).toBe(
      ['users:', '  - name: svc', '    password:', `      ${REDACTED}`, '    role: admin'].join('\n'),
    );
  });

  it('treats a sibling key after an empty secret key as a sibling', () => {
    expect(redactLogSecrets('password:\nusername: svc\nport: 22')).toBe('password:\nusername: svc\nport: 22');
  });

  it('resumes the YAML value after a key block that dedents inside it', () => {
    const begin = join(' ', '-----BEGIN', 'PRIVATE KEY-----');
    const end = join(' ', '-----END', 'PRIVATE KEY-----');
    const input = ['secrets:', `  - ${begin}`, PEM_BODY[0], end, '  - another-credential', 'region: us1'];
    expect(redactLogSecrets(input.join('\n'))).toBe(
      ['secrets:', `  - ${REDACTED}`, REDACTED, end, `  - ${REDACTED}`, 'region: us1'].join('\n'),
    );
  });

  it('redacts a key block nested under a YAML secret key even where it dedents', () => {
    const begin = join(' ', '-----BEGIN', 'PRIVATE KEY-----');
    const end = join(' ', '-----END', 'PRIVATE KEY-----');
    const out = redactLogSecrets(['privateKey:', `  ${begin}`, PEM_BODY[0], end, 'after'].join('\n'));
    expect(out).not.toContain(PEM_BODY[0]);
    expect(out.split('\n').at(-1)).toBe('after');
  });
});

describe('redactLogSecrets: Authorization header parameters', () => {
  it.each([
    ['Authorization: Digest username="u", response="opaque-response"', `Authorization: Digest ${REDACTED}`],
    [
      'Proxy-Authorization: Digest username="u", realm="r", response="opaque-response"',
      `Proxy-Authorization: Digest ${REDACTED}`,
    ],
    ['WWW-Authenticate: Digest realm="r", nonce="opaque-nonce", qop="auth"', `WWW-Authenticate: Digest ${REDACTED}`],
    ['Proxy-Authenticate: Basic realm="opaque-realm"', `Proxy-Authenticate: Basic ${REDACTED}`],
    [`authorization: Bearer ${BEARER_VALUE}, extra="opaque-extra"`, `authorization: Bearer ${REDACTED}`],
    ['X-Forwarded-Authorization: Token opaque-credential "x"', `X-Forwarded-Authorization: Token ${REDACTED}`],
  ])('%s', (input, expected) => {
    expect(redactLogSecrets(input)).toBe(expected);
  });

  it('redacts header parameters on the line after a waiting Authorization key', () => {
    expect(redactLogSecrets('Authorization:\nDigest username="u", response="opaque-response"\nnext')).toBe(
      `Authorization:\nDigest ${REDACTED}\nnext`,
    );
  });

  it('leaves non-header keys and literals to the ordinary rules', () => {
    expect(redactLogSecrets('{"authenticated":true,"user":"svc"}')).toBe('{"authenticated":true,"user":"svc"}');
    expect(redactLogSecrets('{"authorization": null, "user": "svc"}')).toBe('{"authorization": null, "user": "svc"}');
    expect(redactLogSecrets('"authorization":"Digest username=\\"u\\", response=\\"x\\""')).toBe(
      `"authorization":"${REDACTED}"`,
    );
  });
});

describe('redactLogSecrets: YAML comments', () => {
  it('treats a comment after a secret key as no value, for lists and mappings', () => {
    expect(redactLogSecrets('secrets: # credentials\n  - opaque-credential\n  - another-credential\nregion: us1')).toBe(
      `secrets: ${REDACTED}\n  - ${REDACTED}\n  - ${REDACTED}\nregion: us1`,
    );
    expect(redactLogSecrets('secrets:   # credentials\n  user: svc\n  value: opaque-credential\nregion: us1')).toBe(
      `secrets:   ${REDACTED}\n  ${REDACTED}\n  ${REDACTED}\nregion: us1`,
    );
    expect(redactLogSecrets('password: # set below\nopaque credential\nnext: 1')).toBe(
      `password: ${REDACTED}\n${REDACTED}\nnext: 1`,
    );
  });

  it('lets comment lines inside a waiting key or YAML value neither end it nor show', () => {
    const input = 'secrets:\n# first\n  - opaque-credential\n# between\n  - another-credential\nregion: us1';
    expect(redactLogSecrets(input)).toBe(
      `secrets:\n${REDACTED}\n  - ${REDACTED}\n${REDACTED}\n  - ${REDACTED}\nregion: us1`,
    );
  });

  it('keeps a # that is part of the value as the value', () => {
    expect(redactLogSecrets('password:#opaque-credential')).toBe(`password:${REDACTED}`);
  });
});

describe('redactLogSecrets: structure before indentation', () => {
  it('follows a collection that opens on the line after the key past any dedent', () => {
    expect(redactLogSecrets('{"secrets":\n  [\n"opaque-credential"\n]}\nafter')).toBe(
      `{"secrets":\n  ${REDACTED}\n${REDACTED}\n${REDACTED}}\nafter`,
    );
    expect(redactLogSecrets('{"secrets":\n  {\n"value": "opaque-credential"\n  },\n"region": "us1"}')).toBe(
      `{"secrets":\n  ${REDACTED}\n${REDACTED}\n${REDACTED},\n"region": "us1"}`,
    );
  });

  it('follows a quoted value that opens on the line after the key past any dedent', () => {
    expect(redactLogSecrets('password:\n  "opaque\ncredential"\nnext')).toBe(
      `password:\n  "${REDACTED}\n${REDACTED}"\nnext`,
    );
  });

  it('handles ordinary pretty-printed JSON with the value on its own line', () => {
    const input = [
      '{',
      '  "secrets":',
      '    [',
      '      "opaque-credential",',
      '      "another-credential"',
      '    ],',
      '  "region": "us1"',
      '}',
    ];
    expect(redactLogSecrets(input.join('\n'))).toBe(
      ['{', '  "secrets":', `    ${REDACTED}`, REDACTED, REDACTED, `${REDACTED},`, '  "region": "us1"', '}'].join('\n'),
    );
  });

  it('follows a flow collection opened by a YAML list item past a dedent', () => {
    expect(redactLogSecrets('secrets:\n  - [opaque-credential,\nanother-credential]\n  - x\nregion: us1')).toBe(
      `secrets:\n  - ${REDACTED}\n${REDACTED}\n  - ${REDACTED}\nregion: us1`,
    );
  });
});

describe('redactLogSecrets: a partial marker is not trusted', () => {
  it.each([
    [`{"secret":"${GH_TOKEN} opaque-credential"}`, `{"secret":"${REDACTED}"}`],
    [`password: ${GH_TOKEN} opaque-credential`, `password: ${REDACTED}`],
    [`{"token":"Bearer ${BEARER_VALUE} opaque-credential"}`, `{"token":"${REDACTED}"}`],
    [`Authorization: Bearer ${BEARER_VALUE} opaque-credential`, `Authorization: Bearer ${REDACTED}`],
    [`api_key='${SLACK_TOKEN} opaque-credential'`, `api_key='${REDACTED}'`],
    [`{"secret":"${REDACTED} opaque-credential"}`, `{"secret":"${REDACTED}"}`],
    ['secret: {"a": 1} opaque-credential', `secret: ${REDACTED}`],
  ])('%s', (input, expected) => {
    expect(redactLogSecrets(input)).toBe(expected);
  });

  it('redacts a YAML line that only starts with the marker', () => {
    expect(
      redactLogSecrets(`secrets:\n  - ${GH_TOKEN} opaque-credential\n  - ${REDACTED} another-credential\nregion: us1`),
    ).toBe(`secrets:\n  - ${REDACTED}\n  - ${REDACTED}\nregion: us1`);
    expect(redactLogSecrets(`secrets:\n  - "${REDACTED} opaque-credential"`)).toBe(`secrets:\n  - "${REDACTED}"`);
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
  `{"AuthToken":`,
  `  "${AUTH_TOKEN}"}`,
  'password: "line one',
  'line two" user=svc',
  '{"apiKeys":["opaque-credential"],',
  '  "secrets": {',
  '    "value": "opaque-credential"',
  '  }}',
  PEM_BEGIN,
  `${PEM_BODY[0]} ${PEM_END}`,
  'token:',
  `Bearer ${BEARER_VALUE}`,
  'privateKey:',
  PEM_BEGIN,
  PEM_BODY[1],
  PEM_END,
  'secrets:',
  '  - opaque-credential',
  'password: |',
  '  opaque-credential',
  'region: us1',
  'password: see opaque-credential',
  `{"secret":"${GH_TOKEN} opaque-credential"}`,
  `password: ${GH_TOKEN} opaque-credential`,
  'secrets: # credentials',
  '  - opaque-credential',
  `  - ${REDACTED} opaque-credential`,
  '{"secrets":',
  '  [',
  '"opaque-credential"',
  ']}',
  'region: us1',
  'Proxy-Authorization: Digest username="u", response="opaque-credential"',
  'WWW-Authenticate: Digest realm="r", nonce="opaque-credential"',
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
      'sid='.repeat(size / 4),
      'Authorization: '.repeat(size / 15),
      'x-authorization:a '.repeat(size / 18),
      'sid="'.repeat(size / 5),
      'secret=['.repeat(size / 8),
      'secret={"a":"'.repeat(size / 13),
      '"token"'.repeat(size / 7),
      `${join(' ', '-----BEGIN RSA', 'PRIVATE KEY-----')}x${join(' ', '-----END RSA', 'PRIVATE KEY-----')}`.repeat(
        size / 64,
      ),
    ];
    for (const input of inputs) {
      const start = performance.now();
      redactLogSecrets(input);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });

  it('stays linear on adversarial 1 MB multi-line output', () => {
    const size = 1024 * 1024;
    const inputs = [
      '"token":\n'.repeat(size / 9),
      '"token"\n'.repeat(size / 8),
      'token: "\n'.repeat(size / 9),
      'secret=[\n'.repeat(size / 9),
      `{"secret":[\n${'"x",\n'.repeat(size / 5)}`,
      `password: "${'a\\\n'.repeat(size / 3)}`,
      Array.from({ length: 1400 }, (_, i) => `${' '.repeat(i)}secret:`).join('\n'),
      `secrets:\n${' '.repeat(size / 2)}${'- '.repeat(size / 4)}x`,
      `password: |\n${' '.repeat(size)}`,
      `secrets:\n${'  - a\n'.repeat(size / 6)}`,
      'password:\n'.repeat(size / 10),
      'token:\n\n'.repeat(size / 8),
      `password: ${', aaaa'.repeat(size / 6)}`,
      `token: ${',\\"a'.repeat(size / 4)}`,
      'token: a, b: c '.repeat(size / 16),
      `secrets:\n${'  - [\n'.repeat(size / 6)}`,
      'token: # c\n'.repeat(size / 11),
      `{"secrets":\n${'  {\n'.repeat(size / 4)}`,
      'secret: {},'.repeat(size / 11),
      'secret: {}'.repeat(size / 10),
    ];
    for (const input of inputs) {
      const start = performance.now();
      redactLogSecrets(input);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });
});

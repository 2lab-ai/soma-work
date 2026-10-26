import { describe, expect, it } from 'vitest';
import { createScrubber, REDACTED, scrub, scrubTruncated } from './scrub.js';

// Output scrubbing for the broker's gh runs (.prd/16-devops-tools-architecture.md §7).
//
// Token-shaped fixtures are assembled at load time from a prefix and a body that mean nothing on their own:
// a complete literal in a source blob is indistinguishable from a leak to push protection
// (see scripts/__tests__/slack-token-literals.test.ts).

const shape = (prefix: string, body: string) => `${prefix}${body}`;
const BODY36 = 'Wq3RtY7uIo9PaS1dFg5HjK2lZx4CvB6nM8eQ';
const GH_CLASSIC = shape('ghp', `_${BODY36}`);
const GH_FINE = shape('github', `_pat_11AAAAAAA0${'aBcDeFgHiJ'.repeat(3)}_${'kLmNoPqRsT'.repeat(5)}`);
const CF_ACCOUNT = shape('cfat', `_${'Ab1-Cd2_Ef3'.repeat(4)}`);
const CF_USER = shape('cfut', `_${'Gh4-Ij5_Kl6'.repeat(4)}`);

/** A secret whose base64 carries `+` and `/`, and whose percent-encoding differs from itself. */
const ODD = 'S3cr3t???~tok/with+eq=amp&end>>>';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
/** Every byte as `%XX`, unreserved characters included. */
const pctAll = (s: string, lower = false) =>
  [...Buffer.from(s, 'utf8')]
    .map((b) => `%${b.toString(16).padStart(2, '0')}`)
    .map((e) => (lower ? e : e.toUpperCase()))
    .join('');

describe('scrub — exact secrets', () => {
  it('replaces every occurrence', () => {
    expect(scrub('a SECRET1x b SECRET1x', ['SECRET1x'])).toBe(`a ${REDACTED} b ${REDACTED}`);
    expect(REDACTED).toBe('<redacted>');
  });

  it('ignores empty secrets and an empty list', () => {
    expect(scrub('nothing here', [''])).toBe('nothing here');
    expect(scrub('nothing here', [])).toBe('nothing here');
  });

  it('replaces the longest secret first', () => {
    const out = scrub('x abcdefgh12345678 y abcdefgh12 z', ['abcdefgh12', 'abcdefgh12345678']);
    expect(out).toBe(`x ${REDACTED} y ${REDACTED} z`);
  });

  it('matches secrets literally, not as regular expressions', () => {
    const meta = 'a.b*c(d)[e]$^|+?';
    expect(scrub(`${meta} and aXbbbcde`, [meta])).toBe(`${REDACTED} and aXbbbcde`);
  });

  it('matches short secrets exactly but leaves their encodings alone (< 8 chars)', () => {
    const short = 'abc/12+';
    const out = scrub(`${short} ${b64(short)} ${encodeURIComponent(short)}`, [short]);
    expect(out).toBe(`${REDACTED} ${b64(short)} ${encodeURIComponent(short)}`);
  });

  it('does not mutate its inputs', () => {
    const secrets = Object.freeze(['SECRET1x', 'other-secret']);
    expect(scrub('SECRET1x', secrets)).toBe(REDACTED);
    expect(secrets).toEqual(['SECRET1x', 'other-secret']);
  });
});

describe('scrub — encoded forms of a secret (>= 8 chars)', () => {
  it('replaces whole base64 and base64url encodings', () => {
    expect(scrub(`key=${b64(ODD)}`, [ODD])).toBe(`key=${REDACTED}`);
    expect(scrub(`key=${b64(ODD).replace(/=+$/, '')}`, [ODD])).toBe(`key=${REDACTED}`);
    expect(scrub(`key=${b64url(ODD)}`, [ODD])).toBe(`key=${REDACTED}`);
    expect(b64(ODD)).not.toBe(b64url(ODD));
  });

  it.each([0, 1, 2])('replaces base64 of the secret embedded at byte offset %i of a larger blob', (offset) => {
    const blob = Buffer.concat([Buffer.alloc(offset, 0x41), Buffer.from(ODD), Buffer.from('tail')]);
    const std = scrub(b64(blob), [ODD]);
    expect(std).toMatch(/^[A-Za-z0-9+/]{0,3}<redacted>[A-Za-z0-9+/=]{0,10}$/);
    const url = scrub(b64url(blob), [ODD]);
    expect(url).toMatch(/^[A-Za-z0-9_-]{0,3}<redacted>[A-Za-z0-9_-]{0,10}$/);
  });

  it('replaces percent-encoding in upper- and lower-case hex', () => {
    const pct = encodeURIComponent(ODD);
    expect(pct).not.toBe(ODD);
    expect(scrub(`q=${pct}&x=1`, [ODD])).toBe(`q=${REDACTED}&x=1`);
    const lower = pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    expect(scrub(`q=${lower}&x=1`, [ODD])).toBe(`q=${REDACTED}&x=1`);
  });

  it('replaces a fully percent-encoded secret, unreserved characters included', () => {
    expect(scrub(`q=${pctAll(ODD)}&x=1`, [ODD])).toBe(`q=${REDACTED}&x=1`);
    expect(scrub(`t=${pctAll(GH_CLASSIC)};`, [GH_CLASSIC])).toBe(`t=${REDACTED};`);
  });

  it('replaces escapes in mixed-case hex', () => {
    const mixed = [...ODD].map((ch, i) => pctAll(ch, i % 2 === 1)).join('');
    expect(mixed).toMatch(/%[0-9][A-F]/);
    expect(mixed).toMatch(/%[0-9][a-f]/);
    expect(scrub(`[${mixed}]`, [ODD])).toBe(`[${REDACTED}]`);
  });

  it('replaces a partially percent-encoded secret', () => {
    // Every other character escaped, alternating hex case.
    const partial = [...ODD].map((ch, i) => (i % 2 === 0 ? ch : pctAll(ch, i % 4 === 1))).join('');
    expect(partial).not.toBe(ODD);
    expect(scrub(`a ${partial} b`, [ODD])).toBe(`a ${REDACTED} b`);
    const oneEscape = `${GH_CLASSIC.slice(0, 10)}%${GH_CLASSIC.charCodeAt(10).toString(16)}${GH_CLASSIC.slice(11)}`;
    expect(scrub(oneEscape, [GH_CLASSIC])).toBe(REDACTED);
  });

  it('percent-encodes multi-byte characters byte by byte', () => {
    const secret = 'pässwörd-0123';
    expect(scrub(`x=${encodeURIComponent(secret)}`, [secret])).toBe(`x=${REDACTED}`);
    expect(scrub(`x=${encodeURIComponent(secret).toLowerCase()}`, [secret])).toBe(`x=${REDACTED}`);
  });

  it('leaves escapes that decode to something else alone', () => {
    const near = `${pctAll(ODD.slice(0, -1))}%3F`;
    expect(scrub(near, [ODD])).toBe(near);
  });

  it('stays linear on adversarial escape runs', () => {
    const secret = `${'A'.repeat(39)}B`;
    const text = '%41'.repeat(300_000);
    const started = Date.now();
    expect(scrub(text, [secret])).toBe(text);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('scrub — credential shapes without a known secret', () => {
  it.each(['ghp', 'gho', 'ghs', 'ghu', 'ghr'])('redacts %s_ tokens', (prefix) => {
    const tok = shape(prefix, `_${BODY36}`);
    expect(scrub(`token: ${tok}.`, [])).toBe(`token: ${REDACTED}.`);
  });

  it('redacts fine-grained github_pat_ tokens', () => {
    expect(scrub(`"${GH_FINE}"`, [])).toBe(`"${REDACTED}"`);
  });

  it('redacts Cloudflare cfat_ / cfut_ tokens', () => {
    expect(scrub(`a=${CF_ACCOUNT} b=${CF_USER}`, [])).toBe(`a=${REDACTED} b=${REDACTED}`);
  });

  it.each(['xoxa', 'xoxb', 'xoxp', 'xoxr', 'xoxe'])('redacts %s- Slack tokens', (prefix) => {
    expect(scrub(`slack ${shape(prefix, '-1-2-aaaabbbbcccc')} end`, [])).toBe(`slack ${REDACTED} end`);
  });

  it('redacts Bearer credentials and keeps the scheme', () => {
    expect(scrub('Authorization: Bearer abc.DEF-123_~+/xyz==', [])).toBe('Authorization: Bearer <redacted>');
    expect(scrub('{"h":"Bearer abc123","n":1}', [])).toBe('{"h":"Bearer <redacted>","n":1}');
    expect(scrub('Bearer\tabc123\nnext line', [])).toBe('Bearer <redacted>\nnext line');
  });

  it('leaves shapes below the length floor and unknown prefixes alone', () => {
    const below = [
      shape('ghp', `_${BODY36.slice(0, 19)}`),
      shape('github', `_pat_${BODY36.slice(0, 19)}`),
      shape('cfat', `_${BODY36.slice(0, 19)}`),
      shape('xoxb', '-123456789'),
      shape('ghx', `_${BODY36}`),
      'Bearer\n\nparagraph',
    ];
    for (const text of below) expect(scrub(text, [])).toBe(text);
  });
});

describe('scrub — idempotence', () => {
  const cases: Array<[string, string, string[]]> = [
    ['plain secret', 'a SECRET1x b', ['SECRET1x']],
    ['Bearer', 'Authorization: Bearer abc123', []],
    ['secret glued to a gh token', `${ODD}${GH_CLASSIC}`, [ODD]],
    ['gh token glued to a secret', `${GH_CLASSIC}${ODD}`, [ODD]],
    ['secret that is a substring of the marker', 'the word redacted and <redacted>', ['redacted']],
    ['secret glued to the marker', `x${REDACTED}SECRET1x${REDACTED}y`, ['SECRET1x']],
    ['encoded forms', `${b64(ODD)} ${encodeURIComponent(ODD)} ${b64url(`AB${ODD}`)}`, [ODD]],
  ];

  it.each(cases)('scrub(scrub(x)) === scrub(x): %s', (_name, text, secrets) => {
    const once = scrub(text, secrets);
    expect(scrub(once, secrets)).toBe(once);
  });

  it('redacts both halves when a known secret is glued to a gh token', () => {
    expect(scrub(`${ODD}${GH_CLASSIC}`, [ODD])).toBe(`${REDACTED}${REDACTED}`);
    expect(scrub(`${GH_CLASSIC}${ODD}`, [ODD])).not.toContain(ODD);
  });

  it('holds on random mixes of secrets, encodings, shapes and marker fragments', () => {
    const secrets = [ODD, 'SECRET1x'];
    const parts = [
      ODD,
      'SECRET1x',
      b64(ODD),
      b64url(`Z${ODD}`),
      encodeURIComponent(ODD),
      GH_CLASSIC,
      GH_FINE,
      CF_ACCOUNT,
      shape('xoxb', '-1-2-aaaabbbbcccc'),
      'Bearer abc',
      'Bearer ',
      REDACTED,
      '<',
      '>',
      'redacted',
      ' ',
      '\n',
      '"',
      'x',
      'ghp',
      '_',
    ];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 500; i++) {
      let text = '';
      const n = 1 + (next() % 8);
      for (let j = 0; j < n; j++) text += parts[next() % parts.length];
      const once = scrub(text, secrets);
      expect(scrub(once, secrets), JSON.stringify(text)).toBe(once);
      expect(once, JSON.stringify(text)).not.toContain(ODD);
      expect(once, JSON.stringify(text)).not.toContain('SECRET1x');
    }
  });
});

describe('scrubTruncated — a secret cut by the output cap', () => {
  it('redacts a trailing partial secret or encoding of 4+ characters', () => {
    expect(scrubTruncated(`out: ${GH_CLASSIC.slice(0, 12)}`, [GH_CLASSIC])).toBe(`out: ${REDACTED}`);
    expect(scrubTruncated(`out: ${ODD.slice(0, 4)}`, [ODD])).toBe(`out: ${REDACTED}`);
    expect(scrubTruncated(`b=${b64(ODD).slice(0, 9)}`, [ODD])).toBe(`b=${REDACTED}`);
    expect(scrubTruncated(`p=${encodeURIComponent(ODD).slice(0, 15)}`, [ODD])).toBe(`p=${REDACTED}`);
  });

  it('redacts a trailing partial of any percent-encoding, cut mid-escape included', () => {
    const full = pctAll(GH_CLASSIC);
    expect(scrubTruncated(`p=${full.slice(0, 20)}`, [GH_CLASSIC])).toBe(`p=${REDACTED}`);
    expect(scrubTruncated(`p=${full.slice(0, 19)}`, [GH_CLASSIC])).toBe(`p=${REDACTED}`);
    const partial = [...GH_CLASSIC].map((ch, i) => (i % 3 === 0 ? pctAll(ch, true) : ch)).join('');
    expect(scrubTruncated(`p=${partial.slice(0, 11)}`, [GH_CLASSIC])).toBe(`p=${REDACTED}`);
  });

  it('redacts a trailing partial credential shape', () => {
    expect(scrubTruncated(`out: ${shape('ghs', '_abc')}`, [])).toBe(`out: ${REDACTED}`);
    expect(scrubTruncated(`out: ${shape('github', '_pat_')}`, [])).toBe(`out: ${REDACTED}`);
  });

  it('keeps short coincidental tails and still scrubs the body', () => {
    expect(scrubTruncated(`SECRET1x and ${GH_CLASSIC.slice(4, 7)}`, ['SECRET1x', GH_CLASSIC])).toBe(
      `${REDACTED} and ${GH_CLASSIC.slice(4, 7)}`,
    );
  });
});

describe('createScrubber — compiled once, reused per response', () => {
  const secrets = [ODD, GH_CLASSIC, 'SECRET1x'];
  const inputs = [
    '',
    'plain text',
    `a ${ODD} b ${GH_CLASSIC} c SECRET1x`,
    `${b64(ODD)} ${b64url(`AB${ODD}`)} ${pctAll(GH_CLASSIC)}`,
    `${[...ODD].map((ch, i) => (i % 2 ? pctAll(ch, true) : ch)).join('')}`,
    `Authorization: Bearer abc ${GH_FINE} ${CF_ACCOUNT}`,
    `x${REDACTED}SECRET1x${REDACTED}y`,
  ];
  const cutInputs = [
    `out: ${GH_CLASSIC.slice(0, 12)}`,
    `p=${pctAll(GH_CLASSIC).slice(0, 19)}`,
    `b=${b64(ODD).slice(0, 9)}`,
  ];

  it('gives the same output as scrub / scrubTruncated, call after call', () => {
    const scrubber = createScrubber(secrets);
    for (let round = 0; round < 3; round++) {
      for (const text of inputs) expect(scrubber.scrub(text), text).toBe(scrub(text, secrets));
      for (const text of [...inputs, ...cutInputs]) {
        expect(scrubber.scrubTruncated(text), text).toBe(scrubTruncated(text, secrets));
      }
    }
    expect(scrubber.scrub(inputs[2])).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
    expect(scrubber.scrubTruncated(cutInputs[0])).toBe(`out: ${REDACTED}`);
  });

  it('keeps no state between calls (a global regex must not carry lastIndex over)', () => {
    const scrubber = createScrubber([GH_CLASSIC]);
    const text = `x ${GH_CLASSIC} y`;
    expect(scrubber.scrub(`${'z'.repeat(100)} ${GH_CLASSIC}`)).toBe(`${'z'.repeat(100)} ${REDACTED}`);
    expect(scrubber.scrub(text)).toBe(`x ${REDACTED} y`);
    expect(scrubber.scrub(text)).toBe(`x ${REDACTED} y`);
  });

  it('snapshots the secrets it was created with', () => {
    const list = ['SECRET1x'];
    const scrubber = createScrubber(list);
    list.push('later-secret');
    expect(scrubber.scrub('SECRET1x later-secret')).toBe(`${REDACTED} later-secret`);
  });

  it('works with no secrets (shapes only)', () => {
    expect(createScrubber([]).scrub(`t=${GH_CLASSIC}`)).toBe(`t=${REDACTED}`);
  });
});

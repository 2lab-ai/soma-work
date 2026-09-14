/**
 * No source file may carry a complete Slack token literal.
 *
 * GitHub push protection scans blobs, not intent. A synthetic `xoxb-…` written
 * out in a test is byte-indistinguishable from a leaked one, so the branch that
 * first carried the setup/packaging fixtures was refused at `git push` — the
 * suites were correct, the bytes were not pushable. The fix was to assemble
 * every complete shape at load time from a prefix and a body that mean nothing
 * on their own.
 *
 * This file is the gate on both halves of that fix, because either half alone
 * is worthless:
 *
 * 1. **Source stays pushable.** Every file a push could carry is scanned with an
 *    approximation of the detectors push protection actually runs. The
 *    approximation is deliberately *narrower* than the packaging gate's
 *    `CREDENTIAL_PATTERNS`: this asks "would GitHub refuse this blob", not "is
 *    this credential-shaped". Short fixtures like `xoxb-1-2-aaaabbbbcccc` are
 *    below every detector's floor, are not push-blocking, and are the whole
 *    point of several redaction tests — they stay.
 * 2. **Runtime coverage is unchanged.** The assembled fixtures are asserted to
 *    still match those same detectors. Without this, a split could quietly
 *    shorten a fixture into a string no scanner recognises, every assertion
 *    downstream would keep passing, and the sanitizer tests would go vacuous.
 *
 * `packages/common` is a leaf workspace and owns its fixtures locally; its
 * canary lives beside them in `src/__tests__/redact-secrets.test.ts`. Its source
 * is still scanned here, like every other file in the repository.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYNTHETIC_SLACK_APP_TOKEN, SYNTHETIC_SLACK_BOT_TOKEN } from '../../src/test-utils/slack-token-fixtures';

const { SYNTHETIC_SLACK_TOKENS } = require('../smoke/setup-package.js') as {
  SYNTHETIC_SLACK_TOKENS: { bot: string; app: string; config: string };
};

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * The push-protection Slack detectors, approximated.
 *
 * Each requires the full shape a Slack-issued token has — the prefix, the
 * numeric segments, and a body long enough that it cannot be a placeholder.
 * Erring wide is cheap here (one more fixture gets assembled); erring narrow
 * costs a refused push, so the floors sit below the shortest literal GitHub
 * actually blocked on this branch.
 */
const DETECTORS: { name: string; re: RegExp }[] = [
  { name: 'Slack bot token', re: /xoxb-\d{8,}-\d{8,}-[A-Za-z0-9]{16,}/ },
  { name: 'Slack user token', re: /xoxp-\d+-\d+-\d+-[A-Za-z0-9]{16,}/ },
  { name: 'Slack app-level token', re: /xapp-\d-[A-Za-z0-9]{6,}-\d{8,}-[A-Za-z0-9]{16,}/ },
  { name: 'Slack configuration access token', re: /xoxe\.xoxp-\d-[A-Za-z0-9]{16,}/ },
  { name: 'Slack configuration refresh token', re: /xoxe-\d-[A-Za-z0-9]{16,}/ },
];

/** Never decoded as text: no source lives here and a match would be noise. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.icns',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.mp4',
  '.wav',
  '.mov',
  '.webm',
  '.node',
  '.wasm',
]);

/**
 * Every file a push could carry: tracked, plus new files that are not ignored.
 *
 * Untracked-but-not-ignored is the interesting half. A fixture written into a
 * brand-new file passes every suite locally, and is refused on the first push
 * after `git add` — which is exactly the loop this test exists to close.
 */
function scannableFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0);
}

/** `<file>:<line>:<detector>` per hit. The matched bytes are never echoed. */
function findCompleteTokenLiterals(): string[] {
  const hits: string[] = [];

  for (const relativePath of scannableFiles()) {
    if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) continue;

    const absolute = path.join(repoRoot, relativePath);
    let text: string;
    try {
      const bytes = fs.readFileSync(absolute);
      if (bytes.includes(0)) continue;
      text = bytes.toString('utf8');
    } catch {
      // A tracked-but-absent path (a submodule gitlink, a broken symlink) is
      // not a blob this test can read, and is not one push protection scans.
      continue;
    }

    text.split('\n').forEach((line, index) => {
      for (const detector of DETECTORS) {
        if (detector.re.test(line)) hits.push(`${relativePath}:${index + 1}: ${detector.name}`);
      }
    });
  }

  return hits;
}

const matches = (value: string): boolean => DETECTORS.some((detector) => detector.re.test(value));

describe('Slack token literals in tracked source', () => {
  it('finds no complete token shape in any file a push could carry', () => {
    expect(findCompleteTokenLiterals()).toEqual([]);
  });

  it('scans this repository rather than an empty file list', () => {
    // The assertion above passes trivially if `git ls-files` returns nothing.
    expect(scannableFiles().length).toBeGreaterThan(500);
  });
});

describe('the assembled fixtures are still complete token shapes', () => {
  it.each([
    ['shared bot token', SYNTHETIC_SLACK_BOT_TOKEN],
    ['shared app token', SYNTHETIC_SLACK_APP_TOKEN],
    ['staged-bundle bot token', SYNTHETIC_SLACK_TOKENS.bot],
    ['staged-bundle app token', SYNTHETIC_SLACK_TOKENS.app],
    ['staged-bundle configuration token', SYNTHETIC_SLACK_TOKENS.config],
  ])('%s', (_name, value) => {
    expect(matches(value)).toBe(true);
  });

  it('would refuse a fixture that was split into a placeholder', () => {
    // The mutation this file exists to catch: a shortened body still reads like
    // a token to a human and matches nothing.
    expect(matches('xoxb-1-2-aaaabbbbcccc')).toBe(false);
  });
});

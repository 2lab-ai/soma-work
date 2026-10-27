/**
 * Value tables for the deploy sandbox grant rules (`../deploy-sandbox-rules.ts`).
 *
 * Two readers apply those rules: the runtime loader (`../deploy-sandbox-grant.ts`,
 * config.json → sandbox) and the deploy-time writer
 * (`../../deploy/apply-deploy-sandbox.ts`, repo secret → config.json). Both test
 * files run these tables, so a value one side accepts can never be one the
 * other side rejects. Every value is an obviously fake fixture.
 *
 * No entry carries leading/trailing whitespace: the writer trims each list
 * item (it reads a hand-edited secret) while config.json values are exact.
 */

export const VALID_USERS = ['UAPPROVED1', 'WAPPROVED2', 'UAB'] as const;

export const INVALID_USERS = [
  '',
  'uapproved1',
  'UA',
  'XAPPROVED1',
  'U-APPROVED',
  'U APPROVED',
  '<@UAPPROVED1>',
  'UAPPROVÉD1',
] as const;

export const VALID_DOMAINS = [
  'qa.example.test',
  'admin.qa.example.test',
  'api-1.qa.example.test',
  'xn--bcher-kva.example.test',
  'example.test',
] as const;

export const INVALID_DOMAINS = [
  '',
  // Exact hostnames only: no wildcard of any shape.
  '*.qa.example.test',
  '*.example.test',
  '*',
  '*.test',
  '*qa.example.test',
  'qa.*.example.test',
  '*.*.example.test',
  'localhost',
  'QA.example.test',
  'https://qa.example.test',
  'qa.example.test:8443',
  'qa.example.test/path',
  'qa.example.test.',
  '.qa.example.test',
  '-qa.example.test',
  'qa-.example.test',
  'qa_lane.example.test',
  'qa example.test',
  '10.0.0.1',
  '0.0.1',
  '::1',
  '[::1]',
  `${'a'.repeat(64)}.example.test`,
] as const;

export const VALID_PATHS = [
  '/srv/qa/lock',
  '/srv/qa/runs',
  '/srv/qa-state/runs/evidence',
  // Inside a home directory is the ordinary case.
  '/Users/someone/qa/lock',
  '/home/someone/work/qa',
  '/data/qa/tmp',
] as const;

export const INVALID_PATHS = [
  '',
  'srv/qa/lock',
  './srv/qa/lock',
  '~/qa/lock',
  '/',
  // Fewer than three components.
  '/srv',
  '/srv/qa',
  // A forbidden root, under one, or above one.
  '/private',
  '/var',
  '/tmp',
  '/tmp/qa/lock',
  '/private/tmp/qa/lock',
  '/var/lib/qa-evidence',
  '/var/folders/qa/lock',
  '/private/var/qa/lock',
  '/etc/qa/lock',
  '/private/etc/qa/lock',
  '/System/Library/qa',
  '/Library/qa/lock',
  '/usr/local/qa',
  '/bin/qa/lock',
  '/sbin/qa/lock',
  '/opt/qa/lock',
  '/Applications/qa/lock',
  '/dev/qa/lock',
  '/proc/self/qa',
  '/root/qa/lock',
  '/private/qa/lock',
  '/sys/qa/lock',
  '/boot/qa/lock',
  '/run/qa/lock',
  '/lib/qa/lock',
  '/lib64/qa/lock',
  // …compared case-insensitively (the default macOS volume is).
  '/TMP/qa/lock',
  '/Private/Tmp/qa',
  '/VAR/qa/lock',
  // Home roots and a home directory itself.
  '/Users',
  '/Users/someone',
  '/home',
  '/home/someone',
  // Not normalized, or walks up.
  '/srv/qa/../lock',
  '/srv/qa/lock/..',
  '/srv/qa/lock/',
  '//srv/qa/lock',
  '/srv//qa/lock',
  '/srv/./qa/lock',
  '/srv/qa\nlock/x',
  '/srv/qa\u0000lock/x',
] as const;

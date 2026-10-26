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
  '*.qa.example.test',
  'api-1.qa.example.test',
  'xn--bcher-kva.example.test',
  '*.example.test',
] as const;

export const INVALID_DOMAINS = [
  '',
  '*',
  '*.test',
  'localhost',
  'QA.example.test',
  'https://qa.example.test',
  'qa.example.test:8443',
  'qa.example.test/path',
  'qa.example.test.',
  '.qa.example.test',
  '*qa.example.test',
  'qa.*.example.test',
  '*.*.example.test',
  '-qa.example.test',
  'qa-.example.test',
  'qa_lane.example.test',
  'qa example.test',
  '10.0.0.1',
  '*.0.0.1',
  '::1',
  '[::1]',
  `${'a'.repeat(64)}.example.test`,
] as const;

export const VALID_PATHS = ['/srv/qa/lock', '/srv/qa/runs', '/var/lib/qa-evidence', '/srv/qa'] as const;

export const INVALID_PATHS = [
  '',
  'srv/qa/lock',
  './srv/qa',
  '~/qa',
  '/',
  '/tmp',
  '/tmp/qa',
  '/private/tmp',
  '/private/tmp/qa',
  '/srv/qa/../lock',
  '/srv/qa/..',
  '/srv/qa/',
  '//srv/qa',
  '/srv//qa',
  '/srv/./qa',
  '/srv/qa\nlock',
  '/srv/qa\u0000lock',
] as const;

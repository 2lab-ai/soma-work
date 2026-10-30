#!/usr/bin/env node
/**
 * Build the self-contained qa-report HTML from a report-input JSON (see ../SKILL.md "Input").
 *
 *   node build.mjs --input <report-input.json> --out <report.html> [--shots <screenshotsDir>] [--title <text>]
 *
 * - Screenshots: a path is embedded only when it resolves (symlinks followed) inside --shots and the
 *   file starts with PNG / JPEG / WebP magic bytes; a caller `data:` value only when it is a plain
 *   base64 png/jpeg/webp data URL. Anything else is dropped and the case gets `evidence.shotProblem`.
 * - Secrets are masked with ./mask.mjs. The data is injected with every `<` escaped, so no input
 *   can close the data <script>.
 * - Row status per key = the caller's `outcomes[KEY].outcome` when present, otherwise derived from the
 *   qa-issue verdict (a pass with an unverified transition is "pass (not moved)", not a pass). It is
 *   injected as `data.status`, and every count below uses it.
 * - Preconditions (the input's top-level `preconditions[]`, each with its `key`, plus every qa-issue JSON's own
 *   `preconditions[]`, which wins for the same key and id) are merged into `data.preconditions` and rendered
 *   first. A precondition is open while its status is not `met` / `provisionable`.
 * - Prints one JSON line: { html, png, keys, pass, fail, other, missingFields, masked, shots, shotProblems,
 *   preconditions, preconditionsOpen }.
 *
 * Exit codes: 0 written · 1 usage or input error.
 */
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mask } from './mask.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(HERE, '..', 'template.html');
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(msg) {
  process.stderr.write(`qa-report build: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--input', '--out', '--shots', '--title'].includes(flag)) fail(`unknown arg: ${flag}`);
    if (i + 1 >= argv.length) fail(`${flag} needs a value`);
    out[flag.slice(2)] = argv[++i];
  }
  if (!out.input || !out.out) fail('usage: build.mjs --input <report-input.json> --out <report.html> [--shots <dir>] [--title <text>]');
  if (!out.out.endsWith('.html')) fail('--out must end in .html');
  return out;
}

function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** → { shot } to embed, or { problem } to report instead. */
function embed(shot, shotsRoot) {
  if (shot.startsWith('data:')) return DATA_URL.test(shot) ? { shot } : { problem: 'rejected: not a base64 png/jpeg/webp data URL' };
  if (!shotsRoot) return { problem: 'rejected: no screenshots directory given' };
  let real;
  try {
    real = realpathSync(shot);
  } catch {
    return { problem: 'missing at build time' };
  }
  if (!real.startsWith(shotsRoot + sep)) return { problem: 'rejected: outside the screenshots directory' };
  if (!statSync(real).isFile()) return { problem: 'rejected: not a file' };
  const buf = readFileSync(real);
  const type = sniff(buf);
  if (!type) return { problem: 'rejected: not a png/jpeg/webp image' };
  return { shot: `data:image/${type};base64,${buf.toString('base64')}` };
}

// Standalone (no closeout outcome from the caller): derive the row status from the qa-issue JSON.
// A pass whose transition was not verified is not a pass for the report.
function derivedStatus(d) {
  const t = d.statusTransition;
  if (d.verdict === 'pass' && t && t.to && t.verified !== true) return 'pass (not moved)';
  if (d.verdict === 'deploy_fail') return 'fail';
  if (d.verdict === 'blocked' && /^superseded:/.test(d.reason || '')) return 'superseded';
  return d.verdict;
}
const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

const args = parseArgs(process.argv);
let input;
try {
  input = JSON.parse(readFileSync(args.input, 'utf8'));
} catch (e) {
  fail(`cannot read --input as JSON (${e.code || e.name})`);
}
if (!input || typeof input !== 'object' || Array.isArray(input)) fail('--input must be one JSON object (see SKILL.md Input)');
const issues = Array.isArray(input.issues) ? input.issues : [];
const nonQa = Array.isArray(input.nonQa) ? input.nonQa : [];
const keys = issues.map((d) => d.key).concat(nonQa.map((d) => d.key));
const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
if (dup.length) fail(`duplicate keys: ${[...new Set(dup)].join(', ')} (each key appears once, in issues or nonQa)`);
const outcomes = input.outcomes && typeof input.outcomes === 'object' && !Array.isArray(input.outcomes) ? input.outcomes : {};
const stray = Object.keys(outcomes).filter((k) => !keys.includes(k));
if (stray.length) fail(`outcomes for keys with no row: ${stray.join(', ')} (add them to issues or nonQa)`);
// Preconditions: the caller's run-level list, overridden per key and id by each qa-issue JSON's own list.
const preMap = new Map();
const addPre = (key, p) => {
  if (!p || typeof p !== 'object' || !key) return;
  preMap.set(`${key}\u0000${p.id}`, { ...p, key });
};
for (const p of Array.isArray(input.preconditions) ? input.preconditions : []) addPre(p && p.key, p);
for (const d of issues) for (const p of Array.isArray(d.preconditions) ? d.preconditions : []) addPre(d.key, p);
const preStray = [...new Set([...preMap.values()].map((p) => p.key).filter((k) => !keys.includes(k)))];
if (preStray.length) fail(`preconditions for keys with no row: ${preStray.join(', ')} (add them to issues or nonQa)`);
input.preconditions = [...preMap.values()];
const preOpen = input.preconditions.filter((p) => p.status !== 'met' && p.status !== 'provisionable').length;
const outcomeOf = (k) => (outcomes[k] && typeof outcomes[k].outcome === 'string' ? outcomes[k].outcome : '');
// Row status per key: the caller's closeout outcome when given, otherwise derived.
const status = {};
for (const d of issues) status[d.key] = outcomeOf(d.key) || derivedStatus(d);
for (const d of nonQa) status[d.key] = outcomeOf(d.key) || d.status;

let shotsRoot = '';
if (args.shots) {
  try {
    shotsRoot = realpathSync(args.shots);
  } catch {
    fail('--shots directory not found');
  }
}
let shots = 0;
let shotProblems = 0;
for (const d of issues) {
  for (const c of d.cases || []) {
    const ev = c.evidence;
    if (!ev || typeof ev.shot !== 'string' || !ev.shot) continue;
    const r = embed(ev.shot, shotsRoot);
    if (r.shot) {
      ev.shot = r.shot;
      shots++;
    } else {
      delete ev.shot;
      ev.shotProblem = r.problem;
      shotProblems++;
    }
  }
}

const { value: data, count: masked } = mask(input);
data.status = status;
data.meta = Object.assign(data.meta && typeof data.meta === 'object' ? data.meta : {}, args.title ? { title: args.title } : {}, { masked });
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = readFileSync(TEMPLATE, 'utf8').replace('/*QA_DATA*/', () => json);
const out = resolve(args.out);
writeFileSync(out, html);

const statuses = keys.map((k) => status[k]);
const pass = statuses.filter((s) => s === 'pass').length;
const failCount = statuses.filter((s) => s === 'fail').length;
const missingFields = issues
  .flatMap((d) => d.cases || [])
  .reduce((n, c) => n + [typeof c.auth === 'string' ? c.auth : c.auth?.accountRef, c.steps, c.expected, c.actual].filter(empty).length, 0);
process.stdout.write(
  `${JSON.stringify({ html: out, png: out.replace(/\.html$/, '.png'), keys: statuses.length, pass, fail: failCount, other: statuses.length - pass - failCount, missingFields, masked, shots, shotProblems, preconditions: input.preconditions.length, preconditionsOpen: preOpen })}\n`,
);

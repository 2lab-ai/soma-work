#!/usr/bin/env node
/**
 * Precondition gate — the deterministic part of qa-issue §Precondition gate.
 *
 *   node gate.mjs seal <gate-KEY.json>                     validate a planned key, write its fingerprint
 *   node gate.mjs fingerprint <gate-KEY.json>              print the fingerprint (recomputed, never trusted)
 *   node gate.mjs merge --out <run-gate.json> [--carry <old run gate>] <gate-KEY.json>...
 *                                                          one run gate for the whole run; never overwrites
 *   node gate.mjs answer --gate <run-gate.json> --key <KEY|all> --decision provided|waived|skipped
 *                        --by <who> --ref <where> [--ids P1,P2]   record the requester's answer
 *   node gate.mjs decide --gate <run-gate.json> --key <KEY> --current <current.json>
 *                                                          run | skip | ask for one key on resume
 *
 * The fingerprint binds consent to the disclosed plan: the frozen cases (id, assertion, severity,
 * preconditions), the coverage matrix, the precondition requirements and mapping, and the inputs
 * (profile + revision, deployed SHAs, normalized requirement-bearing issue fields, merged PRs).
 * Probe results (`status`), decisions and workflow-owned issue fields (`updated`, `status`,
 * comments) are never hashed, so providing a missing precondition and resuming does not loop,
 * and the workflow's own tracker writes do not invalidate an answer.
 *
 * Every command prints one JSON line. Exit codes: 0 ok · 1 usage or refused write ·
 * 3 decide: ask the requester (nothing runs) · 4 invalid gate (matrix-incomplete, bad mapping, mismatch).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const DIMS = ['acceptance', 'roles', 'writes', 'crossSurface', 'dataStates', 'negative', 'persistence', 'deviceLocale', 'time', 'regression', 'observability'];
// Never N/A when the change touches a write endpoint.
const WRITE_DIMS = ['acceptance', 'writes', 'negative'];
const KINDS = ['account', 'test-data', 'write-permission', 'env-config', 'external-system', 'time-control', 'device-locale', 'observability'];
const STATUSES = ['met', 'provisionable', 'missing'];
const DECISIONS = ['provided', 'waived', 'skipped'];
const ISSUE_FIELDS = ['summary', 'description', 'acceptance'];

function die(code, msg) {
  process.stderr.write(`gate: ${msg}\n`);
  process.exit(code);
}
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    die(1, `cannot read ${p} as JSON (${e.code || e.name})`);
  }
}

// Options each command accepts. An unknown option is refused before anything is read or written:
// a misspelled restriction (`--id` for `--ids`) must never widen what a recorded answer covers.
const OPTIONS = {
  seal: [],
  fingerprint: [],
  merge: ['out', 'carry'],
  answer: ['gate', 'key', 'decision', 'by', 'ref', 'ids'],
  decide: ['gate', 'key', 'current'],
};

function flags(cmd, argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      if (!OPTIONS[cmd].includes(name)) die(1, `unknown option --${name} for ${cmd}`);
      if (i + 1 >= argv.length) die(1, `${argv[i]} needs a value`);
      if (name in out) die(1, `--${name} given twice`);
      out[name] = argv[++i];
    } else out._.push(argv[i]);
  }
  return out;
}

/** JSON with sorted object keys, so equal content always hashes equal. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const sorted = (a) => [...(a || [])].map(String).sort();

function inputsView(env, inputs) {
  const issue = inputs?.issue || {};
  return {
    profile: env?.profile ?? null,
    profileRevision: env?.profileRevision ?? null,
    deployedShas: sorted(inputs?.deployedShas),
    issue: Object.fromEntries(ISSUE_FIELDS.map((f) => [f, norm(issue[f])])),
    mergedPrs: sorted(inputs?.mergedPrs),
  };
}

function fingerprintOf(g) {
  const view = {
    key: g.key,
    inputs: inputsView(g.env, g.inputs),
    plan: {
      touchesWrite: !!g.plan?.touchesWrite,
      coverage: g.plan?.coverage ?? null,
      // The whole execution definition of each case: what runs is what was disclosed.
      cases: (g.plan?.cases || []).map((c) => ({
        id: c.id,
        type: c.type ?? null,
        desc: norm(c.desc),
        assertion: norm(c.assertion),
        severity: c.severity ?? null,
        steps: (c.steps || []).map(norm),
        expected: norm(c.expected),
        tolerance: c.tolerance ?? null,
        accountRef: c.accountRef ?? null,
        preconditions: sorted(c.preconditions),
      })),
    },
    preconditions: (g.preconditions || []).map((p) => ({ id: p.id, kind: p.kind, need: norm(p.need), cases: sorted(p.cases) })),
  };
  return createHash('sha256').update(canonical(view)).digest('hex');
}

/** Problems that make a planned key invalid; [] when it can be sealed. */
function validate(g) {
  const errs = [];
  if (!g || typeof g !== 'object') return ['gate is not an object'];
  if (!g.key) errs.push('key missing');
  if (!g.env?.profile) errs.push('env.profile missing');
  if (!g.env?.profileRevision) errs.push('env.profileRevision missing');
  if (!Array.isArray(g.inputs?.deployedShas) || !g.inputs.deployedShas.length) errs.push('inputs.deployedShas missing');
  if (!g.inputs?.issue || !norm(g.inputs.issue.summary)) errs.push('inputs.issue.summary missing');
  if (!Array.isArray(g.inputs?.mergedPrs)) errs.push('inputs.mergedPrs missing');
  const cases = g.plan?.cases;
  if (!Array.isArray(cases) || !cases.length) errs.push('plan.cases missing');
  const ids = new Set((cases || []).map((c) => c.id));
  if (ids.size !== (cases || []).length) errs.push('duplicate case ids');
  for (const c of cases || []) {
    if (!c.id || !norm(c.assertion) || !c.severity) errs.push(`case ${c.id || '?'}: id, assertion and severity are required`);
    if (!Array.isArray(c.preconditions)) errs.push(`case ${c.id || '?'}: preconditions must be listed ([] when it needs nothing)`);
  }
  const cov = g.plan?.coverage || {};
  for (const d of DIMS) {
    const v = cov[d];
    const na = typeof v === 'string' && /^N\/A: \S/.test(v);
    const listed = Array.isArray(v) && v.length > 0 && v.every((id) => ids.has(id));
    if ((!na && !listed) || (na && g.plan?.touchesWrite && WRITE_DIMS.includes(d))) errs.push(`matrix-incomplete:${d}`);
  }
  const pids = new Set();
  for (const p of g.preconditions || []) {
    if (!p.id || pids.has(p.id)) errs.push(`precondition ${p.id || '?'}: id missing or duplicated`);
    pids.add(p.id);
    if (!KINDS.includes(p.kind)) errs.push(`precondition ${p.id}: unknown kind ${p.kind}`);
    if (!norm(p.need)) errs.push(`precondition ${p.id}: need missing`);
    if (!STATUSES.includes(p.status)) errs.push(`precondition ${p.id}: status must be ${STATUSES.join('|')}`);
    if (!Array.isArray(p.cases) || !p.cases.length || !p.cases.every((id) => ids.has(id))) errs.push(`precondition ${p.id}: cases must name planned cases`);
  }
  const byId = new Map((g.preconditions || []).map((p) => [p.id, p]));
  for (const c of cases || []) {
    for (const pid of c.preconditions || []) {
      if (!pids.has(pid)) errs.push(`case ${c.id}: unknown precondition ${pid}`);
      else if (!(byId.get(pid).cases || []).includes(c.id)) errs.push(`case ${c.id} lists ${pid} but ${pid}.cases does not list ${c.id}`);
    }
  }
  for (const p of g.preconditions || []) {
    for (const id of p.cases || []) {
      const c = (cases || []).find((x) => x.id === id);
      if (c && !(c.preconditions || []).includes(p.id)) errs.push(`${p.id}.cases lists ${id} but case ${id} does not list ${p.id}`);
    }
  }
  return errs;
}

const runFingerprint = (keys) =>
  createHash('sha256')
    .update(canonical(Object.keys(keys).sort().map((k) => [k, keys[k].fingerprint])))
    .digest('hex');

const missingIds = (g) => (g.preconditions || []).filter((p) => p.status === 'missing').map((p) => p.id);

function seal(argv) {
  const [file] = argv._;
  if (!file) die(1, 'usage: seal <gate-KEY.json>');
  const g = readJson(file);
  const errs = validate(g);
  if (errs.length) die(4, errs.join('; '));
  for (const p of g.preconditions) for (const f of ['decision', 'confirmedBy', 'confirmedAt', 'confirmRef']) if (!(f in p)) p[f] = null;
  g.fingerprint = fingerprintOf(g);
  writeFileSync(file, `${JSON.stringify(g, null, 2)}\n`);
  say({ key: g.key, fingerprint: g.fingerprint, missing: missingIds(g), provisionable: g.preconditions.filter((p) => p.status === 'provisionable').map((p) => p.id) });
}

function fingerprint(argv) {
  const [file] = argv._;
  if (!file) die(1, 'usage: fingerprint <gate-KEY.json>');
  say({ fingerprint: fingerprintOf(readJson(file)) });
}

function merge(argv) {
  const out = argv.out;
  if (!out || !argv._.length) die(1, 'usage: merge --out <run-gate.json> [--carry <old run gate>] <gate-KEY.json>...');
  if (existsSync(out)) die(1, `${out} exists — a gate file is never overwritten; a new gate gets a new file`);
  const carry = argv.carry ? readJson(argv.carry) : null;
  const keys = {};
  for (const f of argv._) {
    const g = readJson(f);
    const errs = validate(g);
    if (errs.length) die(4, `${g.key || f}: ${errs.join('; ')}`);
    if (g.fingerprint !== fingerprintOf(g)) die(4, `fingerprint mismatch: ${g.key} (edited after sealing — re-plan and seal again)`);
    if (keys[g.key]) die(4, `duplicate key: ${g.key}`);
    const old = carry?.keys?.[g.key];
    for (const p of g.preconditions) {
      const prev = old && old.fingerprint === g.fingerprint ? old.preconditions.find((q) => q.id === p.id) : null;
      for (const fld of ['decision', 'confirmedBy', 'confirmedAt', 'confirmRef']) p[fld] = prev ? (prev[fld] ?? null) : null;
    }
    keys[g.key] = g;
  }
  const all = Object.values(keys);
  // Open = missing and not ended by the requester: only `waived` and `skipped` end a gap that stays missing.
  const open = all.flatMap((g) => g.preconditions.filter((p) => p.status === 'missing' && p.decision !== 'waived' && p.decision !== 'skipped'));
  const missing = all.reduce((n, g) => n + missingIds(g).length, 0);
  const run = {
    gateId: basename(out).replace(/\.json$/, ''),
    status: missing === 0 ? 'clear' : open.length ? 'pending' : 'answered',
    createdAt: new Date().toISOString(),
    keys,
    fingerprint: runFingerprint(keys),
  };
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
  say({ gateId: run.gateId, fingerprint: run.fingerprint, keys: all.length, missing, open: open.length, ask: open.length > 0 });
}

function answer(argv) {
  const { gate, key, decision, by, ref, ids } = argv;
  if (!gate || !key || !decision || !by || !ref) die(1, 'usage: answer --gate <run-gate.json> --key <KEY|all> --decision provided|waived|skipped --by <who> --ref <where> [--ids P1,P2]');
  if (!DECISIONS.includes(decision)) die(1, `decision must be ${DECISIONS.join('|')}`);
  const wanted = ids ? ids.split(',').map((s) => s.trim()) : null;
  if (wanted && wanted.some((s) => !/^[A-Za-z0-9_.-]+$/.test(s))) die(1, 'ids must be explicit precondition ids — no wildcard');
  const run = readJson(gate);
  const targets = key === 'all' ? Object.keys(run.keys || {}) : [key];
  const at = new Date().toISOString();
  let n = 0;
  for (const k of targets) {
    const g = run.keys?.[k];
    if (!g) die(1, `key not in gate: ${k}`);
    for (const p of g.preconditions) {
      if (p.status !== 'missing' || (wanted && !wanted.includes(p.id))) continue;
      Object.assign(p, { decision, confirmedBy: by, confirmedAt: at, confirmRef: ref });
      n++;
    }
  }
  if (n === 0) die(1, wanted ? 'no missing precondition matched --ids' : 'no missing precondition to answer for that key');
  const open = Object.values(run.keys).flatMap((g) => g.preconditions.filter((p) => p.status === 'missing' && !DECISIONS.includes(p.decision)));
  // `answered` = every missing precondition has a recorded decision. It is never consent to run:
  // only `decide` (which re-probes and re-asks for `provided` that is still missing) grants that.
  run.status = open.length ? 'pending' : 'answered';
  writeFileSync(gate, `${JSON.stringify(run, null, 2)}\n`);
  say({ gateId: run.gateId, recorded: n, open: open.length, status: run.status });
}

function decide(argv) {
  const { gate, key, current } = argv;
  if (!gate || !key || !current) die(1, 'usage: decide --gate <run-gate.json> --key <KEY> --current <current.json>');
  const run = readJson(gate);
  const cur = readJson(current);
  const ask = (reason) => {
    say({ key, action: 'ask', reason, runCases: [], blockedCases: [] });
    process.exit(3);
  };
  const g = run.keys?.[key];
  if (!g) ask('not in gate — newly discovered scope is never pre-consented');
  // The plan that runs is the plan that was disclosed: a gate edited after sealing is never run.
  if (g.fingerprint !== fingerprintOf(g) || run.fingerprint !== runFingerprint(run.keys)) ask(`gate edited after sealing: ${key}`);
  // The current state must be complete; a missing field never skips a check.
  if (!cur.env || typeof cur.env !== 'object' || !cur.inputs || typeof cur.inputs !== 'object' || !cur.statuses || typeof cur.statuses !== 'object') {
    die(1, '--current needs env, inputs and statuses');
  }
  const unprobed = g.preconditions.filter((p) => !STATUSES.includes(cur.statuses[p.id])).map((p) => p.id);
  if (unprobed.length) die(1, `--current statuses missing or invalid for: ${unprobed.join(',')}`);
  // Inputs changed since the answer → the disclosed plan no longer describes this run.
  const was = inputsView(g.env, g.inputs);
  const now = inputsView(cur.env, cur.inputs);
  const changed = Object.keys(was).filter((k) => canonical(was[k]) !== canonical(now[k]));
  if (changed.length) ask(`inputs changed: ${changed.join(',')}`);
  const statusOf = (p) => cur.statuses[p.id];
  const unanswered = [];
  const stillMissing = [];
  const blocked = new Map();
  // The requester chose to skip this key: that holds even if a precondition is met now.
  const skipped = g.preconditions.find((p) => p.decision === 'skipped');
  if (skipped) {
    say({ key, action: 'skip', reason: `precondition-skipped by ${skipped.confirmedBy}`, runCases: [], blockedCases: [] });
    return;
  }
  for (const p of g.preconditions) {
    if (statusOf(p) !== 'missing') continue; // met or provisionable now: running beats waiving
    if (p.decision === 'waived') {
      for (const id of p.cases) if (!blocked.has(id)) blocked.set(id, { id, precondition: p.id, reason: `precondition-waived:${p.id} by ${p.confirmedBy}` });
    } else if (p.decision === 'provided') stillMissing.push(p.id);
    else unanswered.push(p.id);
  }
  if (unanswered.length || stillMissing.length) {
    ask([unanswered.length ? `unanswered: ${unanswered.join(',')}` : '', stillMissing.length ? `still missing: ${stillMissing.join(',')}` : ''].filter(Boolean).join('; '));
  }
  const order = g.plan.cases.map((c) => c.id);
  say({ key, action: 'run', reason: '', runCases: order.filter((id) => !blocked.has(id)), blockedCases: order.filter((id) => blocked.has(id)).map((id) => blocked.get(id)) });
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { seal, fingerprint, merge, answer, decide };
if (!commands[cmd]) die(1, `usage: gate.mjs ${Object.keys(commands).join('|')} …`);
commands[cmd](flags(cmd, rest));

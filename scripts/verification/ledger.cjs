#!/usr/bin/env node
/**
 * ledger.cjs — writes verification/LEDGER.md: every production TypeScript file, how far the
 * verification layer covers it, and a count per group.
 *
 *   node scripts/verification/ledger.cjs [--date YYYY-MM-DD]
 *
 * Documentation, not a gate: nothing compares LEDGER.md with the tree, which is why it is a dated
 * snapshot. The live check is the ImportGraph theorems, which Lean Verify proves again over the
 * current file set on every run. The file set and the groups are the extractor's
 * (scripts/verification/extract-import-graph.cjs), so the two cannot disagree on either.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GROUPS, OTHER, layerOf, listProductionFiles } = require('./extract-import-graph.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = 'verification/LEDGER.md';

/** The semantically modeled files, and the `verification/lean/SomaVerify/<Module>` of each. */
const MODELED = new Map([
  ['src/sensitive-path-filter.ts', 'SensitivePath'],
  ['src/webhook-url-validator.ts', 'WebhookSsrf'],
  ['src/agent-runtime/policy/tool-policy.ts', 'ToolPolicy'],
  ['src/cli/args.ts', 'CliArgs'],
  ['packages/slack/src/cct/action-value.ts', 'CctActionValue'],
  ['packages/slack/src/followup-queue-store.ts', 'FollowupSnapshot'],
  ['src/dangerous-command-filter.ts', 'BypassDecision'],
]);

function fail(message) {
  console.error(`ledger: ${message}`);
  process.exit(1);
}

function parseDate(argv) {
  if (argv.length === 0) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
  if (argv.length === 2 && argv[0] === '--date' && /^\d{4}-\d{2}-\d{2}$/.test(argv[1])) return argv[1];
  return fail('usage: ledger.cjs [--date YYYY-MM-DD]');
}

/** The label of a group: its path prefix, or `other`. */
function groupLabel(layer) {
  const group = GROUPS.find(([, name]) => name === layer);
  return group ? `\`${group[0]}\`` : OTHER;
}

function render(date, files) {
  const layers = [...GROUPS.map(([, name]) => name), OTHER];
  const rows = files.map((file) => ({
    file,
    layer: layerOf(file),
    status: MODELED.has(file) ? `T2:${MODELED.get(file)}` : 'T1',
  }));
  const count = (layer, predicate) => rows.filter((row) => row.layer === layer && predicate(row)).length;
  const isT2 = (row) => row.status !== 'T1';
  const t2 = rows.filter(isT2).length;

  const lines = [
    '# Verification ledger',
    '',
    `Snapshot of ${date}. Every production TypeScript file (the set the ImportGraph extractor reads`,
    'from `git ls-files`: `*.ts`, `*.tsx`, `*.mts`, `*.cts`, minus declaration files, tests, specs',
    'and fixtures), and how far `verification/` covers it. Written by',
    '`node scripts/verification/ledger.cjs`. Nothing checks this file against the tree; the live',
    'check is the ImportGraph theorems, which the **Lean Verify** workflow proves again over the',
    'current file set on every run.',
    '',
    '| Status | Meaning |',
    '|---|---|',
    '| `T2:<Module>` | Semantically modeled. `verification/lean/SomaVerify/<Module>/` proves properties of a Lean model of the file, and conformance vectors replayed against its real exports tie the model to the code. |',
    '| `T1` | Structural only. The file is a node of the ImportGraph theorems: rules/packaging.md rule 4 layering, the controller CLI never loading env-paths, and coverage of every production file. Nothing about its behavior is proven. |',
    '',
    '## Summary',
    '',
    '| Group | Files | T2 | T1 |',
    '|---|---:|---:|---:|',
    ...layers.map(
      (layer) =>
        `| ${groupLabel(layer)} | ${count(layer, () => true)} | ${count(layer, isT2)} | ${count(layer, (row) => !isT2(row))} |`,
    ),
    `| **total** | **${rows.length}** | **${t2}** | **${rows.length - t2}** |`,
    '',
    '## Files',
    '',
    '| File | Group | Status |',
    '|---|---|---|',
    ...rows.map((row) => `| \`${row.file}\` | ${groupLabel(row.layer)} | ${row.status} |`),
    '',
  ];
  return lines.join('\n');
}

function main() {
  const date = parseDate(process.argv.slice(2));
  const files = listProductionFiles(REPO_ROOT);
  const production = new Set(files);
  const stale = [...MODELED.keys()].filter((file) => !production.has(file));
  if (stale.length > 0) fail(`modeled files that are no longer production files: ${stale.join(', ')}`);
  fs.writeFileSync(path.join(REPO_ROOT, OUT), render(date, files));
  console.log(`ledger: ${files.length} files (${MODELED.size} T2) -> ${OUT}`);
}

main();

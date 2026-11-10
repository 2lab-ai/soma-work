#!/usr/bin/env node
// Merge a brainstorm run's raw cell files into numbered per-field pools.
//
//   node merge.mjs <run-dir>                     merge; only the same sentence counts as a duplicate
//   node merge.mjs <run-dir> --threshold 0.7     also drop near-identical sentences (opt-in)
//   node merge.mjs <run-dir> --count             only print how many ideas each raw file holds
//
// Reads  <run-dir>/raw/<F><L>__<engine>.txt   one idea per line (F = field letter, L = lens number)
//        <run-dir>/labels.json (optional)     { "fields": { "A": "name" }, "lenses": { "1": "name" } }
// Writes <run-dir>/pool/<F>.md                survivors, one per line: "A3-017 [luna] idea"
//        <run-dir>/dropped.md                 every line dropped as a duplicate, with the id it repeats
//        <run-dir>/stats.json                 generated / kept per engine, field and cell
//
// An id is <field><lens>-<line number in that raw file>, so A3-017 is line 17 of raw/A3__<engine>.txt.
// One cell has one raw file. Duplicates are dropped per field: the same idea in two fields is two ideas.
// The default drops only a repeated sentence (case, spacing and punctuation aside). Near-match dropping is
// opt-in: five measured runs lost nothing at 0.7, and on same-frame input it removes ideas that differ.
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`merge: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let runDir;
let threshold = 1;
let countOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--threshold') threshold = Number(args[++i]);
  else if (args[i] === '--count') countOnly = true;
  else if (args[i].startsWith('--')) fail(`unknown option ${args[i]}`);
  else if (runDir === undefined) runDir = args[i];
  else fail(`unexpected argument ${args[i]}`);
}
if (!runDir) fail('usage: node merge.mjs <run-dir> [--threshold 0.7] [--count]');
if (!(threshold > 0 && threshold <= 1)) fail('--threshold must be a number in (0, 1]');

const rawDir = path.join(runDir, 'raw');
const FILE = /^([A-Z])([1-9]\d*)__([a-z0-9-]+)\.txt$/;
const names = fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : [];
const cellOrder = (name) => {
  const [, field, lens] = name.match(FILE);
  return [field, Number(lens)];
};
const files = names
  .filter((n) => FILE.test(n))
  .sort((a, b) => {
    const [fa, la] = cellOrder(a);
    const [fb, lb] = cellOrder(b);
    return fa === fb ? la - lb : fa < fb ? -1 : 1;
  });
const strays = names.filter((n) => !FILE.test(n) && !n.startsWith('.'));
if (strays.length) fail(`raw file names must look like A3__luna.txt — got: ${strays.join(', ')}`);
if (!files.length && !countOnly) fail(`no raw files in ${rawDir}`);

const cellFiles = {};
for (const name of files) {
  const [, field, lens] = name.match(FILE);
  (cellFiles[field + lens] ??= []).push(name);
}
const crowded = Object.values(cellFiles).filter((list) => list.length > 1);
if (crowded.length) fail(`one cell has one raw file — got: ${crowded.map((list) => list.join(' + ')).join('; ')}`);

const keyOf = (idea) => idea.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** One raw line → the idea text, or '' when the line carries none (blank, fence, DONE, symbols only). */
function ideaOf(line) {
  let text = line.trim();
  if (!text || text.startsWith('```') || /^DONE\b/.test(text)) return '';
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.idea === 'string') text = parsed.idea;
    } catch {
      // Not JSON after all: keep the line as written.
    }
  }
  text = text
    .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.。]$/, '')
    .trim();
  return keyOf(text) ? text : '';
}

/** The ideas of one raw file with their line numbers. Counting and merging both read through here. */
function ideasOf(name) {
  const ideas = [];
  for (const [index, line] of fs.readFileSync(path.join(rawDir, name), 'utf8').split('\n').entries()) {
    const idea = ideaOf(line);
    // A first line that ends in a colon is a lead-in ("Here are 50 ideas:"), not an idea.
    if (!idea || (!ideas.length && /[:：]$/.test(idea))) continue;
    ideas.push({ line: index + 1, idea });
  }
  return ideas;
}

if (countOnly) {
  for (const name of files) console.log(`${name} ${ideasOf(name).length}`);
  process.exit(0);
}

function trigrams(key) {
  const grams = new Set();
  for (let i = 0; i + 3 <= key.length; i++) grams.add(key.slice(i, i + 3));
  if (!grams.size) grams.add(key);
  return grams;
}

function similarity(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

let labels = {};
const labelsFile = path.join(runDir, 'labels.json');
if (fs.existsSync(labelsFile)) {
  try {
    labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
  } catch (error) {
    fail(`labels.json is not valid JSON: ${error.message}`);
  }
}

const count = () => ({ generated: 0, kept: 0 });
const stats = { threshold, total: count(), engines: {}, fields: {}, cells: {} };
const kept = {}; // field → [{ id, lens, engine, idea, key, grams }]
const dropped = []; // "A2-007 [haiku] idea ← A1-003"

for (const name of files) {
  const [, field, lens, engine] = name.match(FILE);
  const cell = field + lens;
  kept[field] ??= [];
  stats.engines[engine] ??= count();
  stats.fields[field] ??= count();
  stats.cells[cell] = { engine, ...count() };
  const tallies = [stats.total, stats.engines[engine], stats.fields[field], stats.cells[cell]];

  for (const { line, idea } of ideasOf(name)) {
    const key = keyOf(idea);
    for (const tally of tallies) tally.generated++;
    const id = `${cell}-${String(line).padStart(3, '0')}`;
    const grams = threshold < 1 ? trigrams(key) : undefined;
    const twin = kept[field].find((k) => k.key === key || (grams && similarity(k.grams, grams) >= threshold));
    if (twin) {
      dropped.push(`${id} [${engine}] ${idea} ← ${twin.id}`);
      continue;
    }
    for (const tally of tallies) tally.kept++;
    kept[field].push({ id, lens, engine, idea, key, grams });
  }
}

const poolDir = path.join(runDir, 'pool');
fs.mkdirSync(poolDir, { recursive: true });
// A field whose raw files are gone must not leave its old pool behind.
for (const stale of fs.readdirSync(poolDir)) {
  if (/^[A-Z]\.md$/.test(stale) && !kept[stale[0]]) fs.unlinkSync(path.join(poolDir, stale));
}
for (const [field, ideas] of Object.entries(kept)) {
  const title = labels.fields?.[field] ? `${field} — ${labels.fields[field]}` : field;
  const lenses = [...new Set(ideas.map((i) => i.lens))]
    .map((l) => (labels.lenses?.[l] ? `${l} ${labels.lenses[l]}` : l))
    .join(', ');
  const head = [
    `# ${title}`,
    '',
    `${stats.fields[field].generated} generated → ${ideas.length} kept. Id = field, lens, line in the raw file. Lenses: ${lenses}.`,
    '',
  ];
  const body = ideas.map((i) => `${i.id} [${i.engine}] ${i.idea}`);
  fs.writeFileSync(path.join(poolDir, `${field}.md`), `${[...head, ...body].join('\n')}\n`);
}
fs.writeFileSync(
  path.join(runDir, 'dropped.md'),
  `# Dropped as duplicates (${dropped.length})\n\nEach line: the dropped idea ← the id it repeats. ${threshold < 1 ? `Near matches at ${threshold} or more count.` : 'Only a repeated sentence counts.'}\n\n${dropped.join('\n')}\n`,
);
fs.writeFileSync(path.join(runDir, 'stats.json'), `${JSON.stringify(stats, null, 2)}\n`);

const row = (label, c) =>
  `${label}: ${c.generated} → ${c.kept} (${c.generated ? Math.round((100 * c.kept) / c.generated) : 0}%)`;
console.log(row('total', stats.total));
for (const [engine, c] of Object.entries(stats.engines)) console.log(row(`engine ${engine}`, c));
for (const [field, c] of Object.entries(stats.fields)) console.log(row(`field ${field}`, c));

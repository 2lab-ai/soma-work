#!/usr/bin/env node
// Merge a brainstorm run's raw cell files into numbered per-field pools.
//
//   node merge.mjs <run-dir> [--threshold 0.7]
//
// Reads  <run-dir>/raw/<F><L>__<engine>.txt   one idea per line (F = field letter, L = lens digit)
//        <run-dir>/labels.json (optional)     { "fields": { "A": "name" }, "lenses": { "1": "name" } }
// Writes <run-dir>/pool/<F>.md                survivors, one per line: "A3-017 [luna] idea"
//        <run-dir>/stats.json                 generated / kept per engine, field and cell
//
// An id is <field><lens>-<line number in that cell>, so it points back at the raw line.
// Duplicates are dropped per field: the same idea in two fields is two ideas.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const runDir = args.find((a) => !a.startsWith('--'));
const thresholdAt = args.indexOf('--threshold');
const threshold = thresholdAt === -1 ? 0.7 : Number(args[thresholdAt + 1]);

function fail(message) {
  console.error(`merge: ${message}`);
  process.exit(1);
}

if (!runDir) fail('usage: node merge.mjs <run-dir> [--threshold 0.7]');
if (!(threshold > 0 && threshold <= 1)) fail('--threshold must be a number in (0, 1]');

const rawDir = path.join(runDir, 'raw');
const FILE = /^([A-Z])(\d)__([a-z0-9-]+)\.txt$/;
const names = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).sort() : [];
const files = names.filter((n) => FILE.test(n));
const strays = names.filter((n) => !FILE.test(n) && !n.startsWith('.'));
if (strays.length) fail(`raw file names must look like A3__luna.txt — got: ${strays.join(', ')}`);
if (!files.length) fail(`no raw files in ${rawDir}`);

/** One raw line → the idea text, or '' when the line carries none. */
function ideaOf(line) {
  let text = line.trim();
  if (!text || text.startsWith('```') || /^DONE\b/.test(text)) return '';
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      text = typeof parsed.idea === 'string' ? parsed.idea : '';
    } catch {
      // Not JSON after all: keep the line as written.
    }
  }
  return text
    .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.。]$/, '')
    .trim();
}

const keyOf = (idea) => idea.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

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

const labelsFile = path.join(runDir, 'labels.json');
const labels = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, 'utf8')) : {};

const count = () => ({ generated: 0, kept: 0 });
const stats = { threshold, total: count(), engines: {}, fields: {}, cells: {} };
const kept = {}; // field → [{ id, engine, idea, key, grams }]
const nextLine = {}; // cell → last line number used

for (const name of files) {
  const [, field, lens, engine] = name.match(FILE);
  const cell = field + lens;
  kept[field] ??= [];
  stats.engines[engine] ??= count();
  stats.fields[field] ??= count();
  stats.cells[cell] ??= {};
  stats.cells[cell][engine] ??= count();
  const tallies = [stats.total, stats.engines[engine], stats.fields[field], stats.cells[cell][engine]];

  for (const line of fs.readFileSync(path.join(rawDir, name), 'utf8').split('\n')) {
    const idea = ideaOf(line);
    const key = keyOf(idea);
    if (!key) continue;
    nextLine[cell] = (nextLine[cell] ?? 0) + 1;
    for (const tally of tallies) tally.generated++;
    const grams = trigrams(key);
    const duplicate = kept[field].some((k) => k.key === key || similarity(k.grams, grams) >= threshold);
    if (duplicate) continue;
    for (const tally of tallies) tally.kept++;
    kept[field].push({ id: `${cell}-${String(nextLine[cell]).padStart(3, '0')}`, engine, idea, key, grams });
  }
}

const poolDir = path.join(runDir, 'pool');
fs.mkdirSync(poolDir, { recursive: true });
for (const [field, ideas] of Object.entries(kept)) {
  const title = labels.fields?.[field] ? `${field} — ${labels.fields[field]}` : field;
  const lenses = [...new Set(ideas.map((i) => i.id[1]))]
    .map((l) => (labels.lenses?.[l] ? `${l} ${labels.lenses[l]}` : l))
    .join(', ');
  const head = [
    `# ${title}`,
    '',
    `${stats.fields[field].generated} generated → ${ideas.length} kept. Id = field, lens, line in the raw cell. Lenses: ${lenses}.`,
    '',
  ];
  const body = ideas.map((i) => `${i.id} [${i.engine}] ${i.idea}`);
  fs.writeFileSync(path.join(poolDir, `${field}.md`), `${[...head, ...body].join('\n')}\n`);
}
fs.writeFileSync(path.join(runDir, 'stats.json'), `${JSON.stringify(stats, null, 2)}\n`);

const row = (label, c) =>
  `${label}: ${c.generated} → ${c.kept} (${c.generated ? Math.round((100 * c.kept) / c.generated) : 0}%)`;
console.log(row('total', stats.total));
for (const [engine, c] of Object.entries(stats.engines)) console.log(row(`engine ${engine}`, c));
for (const [field, c] of Object.entries(stats.fields)) console.log(row(`field ${field}`, c));

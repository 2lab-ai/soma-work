#!/usr/bin/env node
// Check that every skill, command and agent description says only WHEN to use it.
// Usage: node check-descriptions.mjs <file-or-dir>...   (dirs are searched for SKILL.md, commands/*.md, agents/*.md)
// Exit 0 = clean, 1 = violations (one per line), 2 = usage error.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LEAD_INS = ['Use when ', 'Also when ', 'Triggers: ', 'Not for '];
export const MAX_CHARS = 400;
// Tokens that only describe how a skill runs: arguments, flags, arrows of a pipeline.
const BANNED = [
  { re: /\bArgs\b/, why: 'argument list (move it to the body)' },
  { re: /(?:->|→)/, why: 'arrow (a pipeline step, not a situation)' },
  { re: /(?:^|\s)--[a-z]/, why: 'command-line flag (move it to the body)' },
];

/** The frontmatter `description` of a markdown file, as one line; null when absent. */
export function readDescription(md) {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i === -1) return null;
  let first = lines[i].replace(/^description:\s*/, '');
  const rest = [];
  for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || lines[j] === ''); j++) rest.push(lines[j].trim());
  if (/^[>|][-+]?$/.test(first)) first = '';
  let text = [first, ...rest].filter(Boolean).join(' ').trim();
  const q = text[0];
  if ((q === '"' || q === "'") && text.endsWith(q)) text = text.slice(1, -1);
  return text;
}

/** Sentences of a description: split after a full stop that is followed by a space. */
export function sentences(desc) {
  return desc
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Every violation of the when-only rule, as human-readable strings. */
export function checkDescription(desc) {
  if (desc === null || desc === '') return ['no description'];
  const out = [];
  if (!desc.startsWith('Use when ')) out.push('does not start with "Use when "');
  if (desc.length > MAX_CHARS) out.push(`${desc.length} chars, over ${MAX_CHARS}`);
  for (const s of sentences(desc)) {
    if (!LEAD_INS.some((l) => s.startsWith(l))) out.push(`sentence is not a situation: "${s.slice(0, 60)}"`);
  }
  for (const { re, why } of BANNED) if (re.test(desc)) out.push(why);
  return out;
}

/**
 * The markdown files whose description is a listing entry: a plugin root's `skills/<name>/SKILL.md`,
 * `commands/*.md` and `agents/*.md` (one level — templates nested deeper are not listed), or a skill folder.
 */
export function describedFiles(root) {
  if (statSync(root).isFile()) return [root];
  const out = [];
  const list = (dir) => {
    try {
      return readdirSync(dir).filter((n) => !n.startsWith('.'));
    } catch {
      return [];
    }
  };
  if (list(root).includes('SKILL.md')) out.push(join(root, 'SKILL.md'));
  for (const name of list(join(root, 'skills'))) {
    const p = join(root, 'skills', name, 'SKILL.md');
    if (list(join(root, 'skills', name)).includes('SKILL.md')) out.push(p);
  }
  for (const group of ['commands', 'agents']) {
    for (const name of list(join(root, group))) if (name.endsWith('.md')) out.push(join(root, group, name));
  }
  return out.sort();
}

function main(args) {
  if (args.length === 0) {
    console.error('usage: check-descriptions.mjs <file-or-dir>...');
    return 2;
  }
  let bad = 0;
  for (const file of args.flatMap(describedFiles)) {
    const desc = readDescription(readFileSync(file, 'utf8'));
    for (const v of checkDescription(desc)) {
      console.log(`${file}: ${v}`);
      bad++;
    }
  }
  return bad === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));

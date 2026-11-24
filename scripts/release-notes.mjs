#!/usr/bin/env node
/**
 * Release notes from main's first-parent history: one line per merged PR (or per direct commit on main).
 *
 * The first-parent chain of main is the list of what landed, in order: a PR's merge commit ("Merge pull request #N
 * from …" with the PR title as its body) or a squash commit ("title (#N)"). Walking it never lists a PR's inner
 * commits, so a note reads like the PR list a person would write.
 *
 * Usage (run inside the git checkout):
 *   node scripts/release-notes.mjs history <out.json> [limit]  — the newest <limit> first-parent entries of HEAD as
 *                                                                 JSON ({ head, entries: [{ sha, title, pr }] })
 *   node scripts/release-notes.mjs notes <base-ref>             — the notes for <base-ref>..HEAD on stdout
 *
 * The daemon (packages/slack/src/release-notes.ts) slices the history file from the commit the host ran before, so
 * each host announces what changed on that host — not what changed since the last deploy anywhere.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FIELD = '\x1f';
const RECORD = '\x1e';
export const MAX_NOTES = 30;

/** A PR merge commit's subject. */
const MERGE_PR = /^Merge pull request #(\d+) from (\S+)/;
/** A squash commit's subject ends with its PR number. */
const SQUASH_PR = /^(.*\S)\s+\(#(\d+)\)$/;

/** The title and PR number of one first-parent commit. */
export function titleOf(subject, body) {
  const merge = MERGE_PR.exec(subject);
  if (merge) {
    const first = String(body ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !/^Co-Authored-By:/i.test(line));
    return { title: first || merge[2], pr: Number(merge[1]) };
  }
  const squash = SQUASH_PR.exec(subject);
  if (squash) return { title: squash[1], pr: Number(squash[2]) };
  return { title: subject, pr: null };
}

/** `git log --format=%H<FS>%s<FS>%b<RS>` output → entries, newest first. */
export function entriesFromLog(text) {
  return String(text)
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha, subject = '', body = ''] = record.split(FIELD);
      return { sha: sha.trim(), ...titleOf(subject.trim(), body) };
    });
}

/** Slack mrkdwn control characters (`&`, `<`, `>`) in a commit title would read as markup. */
const escapeMrkdwn = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * One bullet per entry, newest first; past `max`, one line says how many more. The daemon formats a host's own range
 * the same way (packages/slack/src/release-notes.ts formatReleaseNotes).
 */
export function formatNotes(entries, max = MAX_NOTES) {
  if (entries.length === 0) return '';
  const lines = entries.slice(0, max).map((e) => `• ${escapeMrkdwn(e.title)}${e.pr ? ` (#${e.pr})` : ''}`);
  if (entries.length > max) lines.push(`… 외 ${entries.length - max}건`);
  return lines.join('\n');
}

function firstParentLog(args) {
  return execFileSync('git', ['log', '--first-parent', `--format=%H${FIELD}%s${FIELD}%b${RECORD}`, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function main(argv) {
  const [command, arg, limitArg] = argv;
  if (command === 'history') {
    if (!arg) throw new Error('usage: release-notes.mjs history <out.json> [limit]');
    const limit = Number(limitArg ?? 500);
    const entries = entriesFromLog(firstParentLog(['-n', String(limit), 'HEAD']));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.mkdirSync(path.dirname(arg), { recursive: true });
    fs.writeFileSync(arg, `${JSON.stringify({ head, entries }, null, 1)}\n`);
    return;
  }
  if (command === 'notes') {
    if (!arg) throw new Error('usage: release-notes.mjs notes <base-ref>');
    process.stdout.write(formatNotes(entriesFromLog(firstParentLog([`${arg}..HEAD`]))));
    return;
  }
  throw new Error(`unknown command: ${command ?? '(none)'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[release-notes] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

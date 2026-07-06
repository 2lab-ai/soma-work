import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const srcLocal = path.join(repoRoot, 'src', 'local');
const srcPrompt = path.join(repoRoot, 'src', 'prompt');

/**
 * Reference-integrity lint for the `zworkflow` plugin.
 *
 * Every `local:<name>` reference in prompts and skill docs must resolve to a
 * real skill / command / agent shipped by the plugin. This test walks the
 * documented reference surface and asserts that:
 *
 *  1. Every `local:<name>` reference resolves to a known skill directory,
 *     command markdown, or agent markdown (or the frontmatter `name:` of one).
 *  2. There are no occurrences of the known-bad namespace typo
 *     `superpower:` (singular, followed by a letter) — the real plugin
 *     namespace is `superpowers:` (plural).
 *
 * Kept dependency-free (fs/path + regex) to stay in line with existing tests
 * such as `no-duplicate-plugin-assets.test.ts`.
 */

function listSkillNames(): Set<string> {
  const skillsDir = path.join(srcLocal, 'skills');
  const names = new Set<string>();
  if (!fs.existsSync(skillsDir)) return names;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    names.add(entry.name);
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const head = fs.readFileSync(skillMd, 'utf8').split(/\r?\n/).slice(0, 30);
      for (const line of head) {
        const m = line.match(/^\s*name:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/);
        if (m) {
          names.add(m[1]);
          break;
        }
      }
    }
  }
  return names;
}

function listMarkdownBasenames(dir: string): Set<string> {
  const names = new Set<string>();
  if (!fs.existsSync(dir)) return names;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    names.add(entry.name.replace(/\.md$/, ''));
  }
  return names;
}

function walkFiles(root: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cur);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(cur)) {
        stack.push(path.join(cur, entry));
      }
    } else if (stat.isFile() && predicate(cur)) {
      out.push(cur);
    }
  }
  return out;
}

function collectScanTargets(): string[] {
  const files: string[] = [];
  files.push(...walkFiles(srcPrompt, (p) => p.endsWith('.prompt') || p.endsWith('.md')));
  files.push(...walkFiles(path.join(srcLocal, 'skills'), (p) => path.basename(p) === 'SKILL.md'));
  return files;
}

describe('local: skill references resolve to real assets', () => {
  const validNames = new Set<string>([
    ...listSkillNames(),
    ...listMarkdownBasenames(path.join(srcLocal, 'commands')),
    ...listMarkdownBasenames(path.join(srcLocal, 'agents')),
  ]);

  const targets = collectScanTargets();

  it('collects a non-empty asset inventory', () => {
    expect(validNames.size).toBeGreaterThan(0);
    expect(targets.length).toBeGreaterThan(0);
  });

  it('every `local:<name>` reference resolves to a known skill/command/agent', () => {
    const refRegex = /local:([A-Za-z0-9_-]+)/g;
    const offenders: { file: string; name: string }[] = [];
    for (const file of targets) {
      const text = fs.readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = refRegex.exec(text)) !== null) {
        const name = match[1];
        if (!validNames.has(name)) {
          offenders.push({ file: path.relative(repoRoot, file), name });
        }
      }
    }
    expect(offenders, offenders.map((o) => `  ${o.file}: local:${o.name}`).join('\n')).toEqual([]);
  });

  it('does not contain the known-bad `superpower:` (singular) namespace typo', () => {
    // Real namespace is `superpowers:` (plural). A bare `superpower:X` reference
    // has been a recurring copy-paste mistake in prior PRs.
    const typoRegex = /superpower:[A-Za-z]/g;
    const offenders: { file: string; snippet: string }[] = [];
    for (const file of targets) {
      const text = fs.readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = typoRegex.exec(text)) !== null) {
        offenders.push({
          file: path.relative(repoRoot, file),
          snippet: match[0],
        });
      }
    }
    expect(offenders, offenders.map((o) => `  ${o.file}: ${o.snippet}`).join('\n')).toEqual([]);
  });
});

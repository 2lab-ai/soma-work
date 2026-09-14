import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const coreRoot = path.join(repoRoot, 'plugin', 'core');
const localRoot = path.join(repoRoot, 'plugin', 'local');

/**
 * Dependency-closure gate for the `core` plugin.
 *
 * The plugin split produced two plugins: `local` (bot-bound — needs soma-work
 * MCP servers, the LLM proxy, Slack delivery, hook wiring) and `core` (runs
 * standalone in any Claude Code session). The membership rule is
 * **"unknown ⇒ local"**: a unit only belongs in `core` when its whole
 * dependency closure is free of `local`. This test is the machine judge of
 * that rule, so that moving a unit into `core` is an assertion someone has to
 * make deliberately rather than a directory rename.
 *
 * A *unit* is one directory under `plugin/core/skills/`, or one `.md` file
 * under `plugin/core/agents/` or `plugin/core/commands/`. A unit fails if any
 * file in it (recursively, over the scanned extensions) trips one of:
 *
 *  1. **Forbidden markers** — an MCP tool (`mcp__*__`), a soma/Slack runtime
 *     marker, a daemon or proprietary CLI, the retired `zworkflow:` namespace,
 *     or a `local:` / `stv:` / `oh-my-claude:` namespace reference. These name
 *     machinery that simply does not exist outside the bot.
 *  2. **A reference to a unit that lives in `plugin/local`** — via a
 *     `core:X` / `local:X` call, a backtick-quoted name directly followed by
 *     "skill"/"Skill"/"agent", or a bare local agent/command name.
 *  3. **A path reference that escapes `plugin/core`** — a
 *     `${CLAUDE_PLUGIN_ROOT}/...` include or a relative markdown link whose
 *     target does not resolve to an existing file inside `plugin/core`.
 *
 * Rule 2's bare-name matching is deliberately narrow. Local unit names include
 * ordinary English words (`explore`, `oracle`, `design`, `html`), so a plain
 * word-boundary match floods with prose false positives. Two restrictions keep
 * it usable:
 *
 *  - only **agent and command** names are matched bare (skills are reachable
 *    only through the `local:` / backtick forms, which are unambiguous), and
 *  - the token must sit on a line that also carries a dispatch-like marker
 *    (`subagent_type`, `Task(`, `Agent(`, `Skill(`, `dispatch`, `invoke`).
 *
 * That trades some recall for a signal that is actionable when it fires.
 * Rule 3 is the opposite: it has no heuristic at all — it fires only when a
 * referenced path genuinely does not exist under `plugin/core` — and it is
 * what catches a unit whose persona/rulebook file stayed behind in `local`.
 *
 * Kept dependency-free (node:fs + regex) to match the existing plugin lints
 * (`skill-refs.test.ts`, `no-duplicate-plugin-assets.test.ts`).
 */

/**
 * The exact membership of `core`. Adding a unit to the plugin requires editing
 * this list — which is the point: `core` membership is a claim, not a side
 * effect of a `git mv`.
 *
 * `zkorean` is deliberately absent: the core agent read its rulebook back out
 * of the local `zkorean` skill, so the pair is entangled and the whole pair
 * stays in `local`.
 */
const EXPECTED_CORE_UNITS = [
  'agent:code-reviewer',
  'agent:comment-analyzer',
  'agent:pr-test-analyzer',
  'agent:reviewer',
  'agent:silent-failure-hunter',
  'agent:strategist',
  'agent:type-design-analyzer',
  'skill:example',
  'skill:learn',
  'skill:release-notes',
  'skill:simplify',
  'skill:structurize',
  'skill:using-eli5',
  'skill:using-govuk',
  'skill:using-ha-thinking',
];

const SCANNED_EXTENSIONS = new Set(['.md', '.sh', '.mjs', '.js', '.py', '.json', '.ts', '.txt', '.yaml', '.yml']);

/** Line-level markers that mean "this file cannot run outside the soma-work bot". */
const FORBIDDEN_MARKERS: { label: string; pattern: RegExp }[] = [
  { label: 'MCP tool', pattern: /mcp__[a-zA-Z0-9_-]+__/ },
  { label: 'soma runtime marker', pattern: /slack-mcp|soma-html-serve|slackId|hook-proxy/ },
  { label: 'Slack Block Kit', pattern: /[Bb]lock.?[Kk]it/ },
  { label: 'daemon/proprietary CLI', pattern: /llmux|\bcodex\s+(?:exec|resume|--)|shadcn/i },
  { label: 'retired `zworkflow:` namespace', pattern: /zworkflow:/ },
  { label: '`local:` namespace reference', pattern: /\blocal:[A-Za-z0-9_-]/ },
  { label: '`stv:` namespace reference', pattern: /\bstv:[A-Za-z0-9_-]/ },
  { label: '`oh-my-claude:` namespace reference', pattern: /\boh-my-claude:[A-Za-z0-9_-]/ },
];

/** Line context that turns a bare name into a plausible dispatch. */
const DISPATCH_CONTEXT = /subagent_type|Task\(|Agent\(|Skill\(|dispatch|invoke/i;

interface Unit {
  id: string;
  files: string[];
}

interface Violation {
  unit: string;
  file: string;
  line: number;
  reason: string;
  token: string;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    const stat = fs.statSync(cur);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(cur)) stack.push(path.join(cur, entry));
    } else if (stat.isFile() && SCANNED_EXTENSIONS.has(path.extname(cur))) {
      out.push(cur);
    }
  }
  return out.sort();
}

function listDirNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function listMarkdownNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.replace(/\.md$/, ''))
    .sort();
}

function collectUnits(root: string): Unit[] {
  const units: Unit[] = [];
  for (const name of listDirNames(path.join(root, 'skills'))) {
    units.push({ id: `skill:${name}`, files: walkFiles(path.join(root, 'skills', name)) });
  }
  for (const kind of ['agents', 'commands'] as const) {
    const label = kind === 'agents' ? 'agent' : 'command';
    for (const name of listMarkdownNames(path.join(root, kind))) {
      units.push({ id: `${label}:${name}`, files: [path.join(root, kind, `${name}.md`)] });
    }
  }
  return units.sort((a, b) => a.id.localeCompare(b.id));
}

const coreUnits = collectUnits(coreRoot);
const coreUnitNames = new Set(coreUnits.map((u) => u.id.split(':')[1]));

const localSkillNames = listDirNames(path.join(localRoot, 'skills'));
const localAgentNames = listMarkdownNames(path.join(localRoot, 'agents'));
const localCommandNames = listMarkdownNames(path.join(localRoot, 'commands'));
const localNames = new Set([...localSkillNames, ...localAgentNames, ...localCommandNames]);
/** Only agents + commands are matched bare — see the header note on recall. */
const localBareNames = new Set([...localAgentNames, ...localCommandNames]);

/**
 * True when `target` looks like a file path rather than a template placeholder
 * (`compare_url`) or an anchor/URL.
 */
function isPathLike(target: string): boolean {
  if (/^(?:https?:|mailto:|#)/.test(target)) return false;
  return target.includes('/') || target.endsWith('.md');
}

function checkLine(file: string, lineNo: number, line: string, out: Violation[], unit: string) {
  const push = (reason: string, token: string) =>
    out.push({ unit, file: path.relative(repoRoot, file), line: lineNo, reason, token });

  for (const { label, pattern } of FORBIDDEN_MARKERS) {
    const m = line.match(pattern);
    if (m) push(`forbidden marker (${label})`, m[0]);
  }

  // `core:X` must name a real core unit; otherwise it points into `local`.
  for (const m of line.matchAll(/\bcore:([A-Za-z0-9_-]+)/g)) {
    if (!coreUnitNames.has(m[1])) {
      push('`core:` reference to a unit that is not in plugin/core', m[0]);
    }
  }

  // A backtick-quoted name directly followed by skill/Skill/agent.
  for (const m of line.matchAll(/`([A-Za-z0-9_-]+)`\s*(?:skill|Skill|agent)\b/g)) {
    if (localNames.has(m[1]) && !coreUnitNames.has(m[1])) {
      push('references a plugin/local skill/agent', m[0]);
    }
  }

  // Bare local agent/command name in a dispatch-like context.
  if (DISPATCH_CONTEXT.test(line)) {
    for (const name of localBareNames) {
      if (coreUnitNames.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(line)) {
        push('bare plugin/local agent/command name in a dispatch context', name);
      }
    }
  }

  // Path references must resolve inside plugin/core.
  const pathRefs: string[] = [];
  for (const m of line.matchAll(/\$\{?CLAUDE_PLUGIN_ROOT\}?\/([A-Za-z0-9._/-]+)/g)) {
    pathRefs.push(path.join(coreRoot, m[1]));
  }
  for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!isPathLike(m[1])) continue;
    pathRefs.push(path.resolve(path.dirname(file), m[1].replace(/#.*$/, '')));
  }
  for (const resolved of pathRefs) {
    const inside = resolved === coreRoot || resolved.startsWith(`${coreRoot}${path.sep}`);
    if (!inside || !fs.existsSync(resolved)) {
      push(
        inside ? 'path reference does not exist under plugin/core' : 'path reference escapes plugin/core',
        path.relative(repoRoot, resolved),
      );
    }
  }
}

function auditUnit(unit: Unit): Violation[] {
  const out: Violation[] = [];
  for (const file of unit.files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      checkLine(file, i + 1, line, out, unit.id);
    }
  }
  return out;
}

function render(violations: Violation[]): string {
  return violations.map((v) => `  ${v.unit} → ${v.file}:${v.line} → ${v.reason}: ${v.token}`).join('\n');
}

describe('plugin/core dependency closure is free of plugin/local', () => {
  it('inventories both plugins', () => {
    expect(coreUnits.length).toBeGreaterThan(0);
    expect(localNames.size).toBeGreaterThan(0);
  });

  it('core membership is exactly the declared unit list', () => {
    // Deliberate friction: promoting a unit into `core` means asserting its
    // closure here, not just moving a directory.
    expect(coreUnits.map((u) => u.id)).toEqual(EXPECTED_CORE_UNITS);
  });

  for (const unit of coreUnits) {
    it(`${unit.id} has a local-free closure`, () => {
      const violations = auditUnit(unit);
      expect(violations, `\n${render(violations)}\n`).toEqual([]);
    });
  }
});

describe('plugin hook wiring stays in plugin/local', () => {
  it('plugin/core ships no hooks.json', () => {
    const coreHooks = path.join(coreRoot, 'hooks', 'hooks.json');
    expect(
      fs.existsSync(coreHooks),
      `${coreHooks} exists. Core has no hook wiring in this round — hooks are bot-bound ` +
        '(hook-proxy, call-tracker, stop-hook) and belong to plugin/local.',
    ).toBe(false);
  });

  it('plugin/local still ships hooks.json', () => {
    const localHooks = path.join(localRoot, 'hooks', 'hooks.json');
    expect(fs.existsSync(localHooks), `${localHooks} is missing. The split must not drop the bot's hook wiring.`).toBe(
      true,
    );
  });
});

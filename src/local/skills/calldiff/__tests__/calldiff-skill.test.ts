import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RED contract for the calldiff skill.
 *
 * SSOT_1: "https://github.com/tanishqkancharla/calldiff
 *          이거 local 플러그인에 스킬 로 추가해줘 그리고 디폴트 프롬프트에
 *          작업이 완료 되면 이 calldiff 스킬로 코드 변경점을 요약하라고 써줘"
 *
 *  - T1: src/local/skills/calldiff/SKILL.md exists as a complete plugin skill
 *        (frontmatter + the three subcommands + runnable invocation + upstream
 *        attribution to tanishqkancharla/calldiff, MIT).
 *  - T2: src/prompt/default.prompt tells the agent to summarize code changes
 *        with the calldiff skill once the work is done.
 */

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const DEFAULT_PROMPT = resolve(__dirname, '..', '..', '..', '..', 'prompt', 'default.prompt');
const PLUGIN_JSON = resolve(__dirname, '..', '..', '..', '.claude-plugin', 'plugin.json');

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (key) out[key] = value;
  }
  return out;
}

describe('local:calldiff skill — contract (T1)', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('frontmatter has name: calldiff and a call-stack-diff description', () => {
    const fm = parseFrontmatter(readFileSync(SKILL_MD, 'utf8'));
    expect(fm.name).toBe('calldiff');
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/call ?stack|call flow|who-calls-whom/);
    expect(desc).toMatch(/diff/);
  });

  it('description carries triggers so the skill is discoverable on completion summaries', () => {
    const fm = parseFrontmatter(readFileSync(SKILL_MD, 'utf8'));
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/calldiff/);
    expect(desc).toMatch(/변경점|변경 사항|summar/);
  });

  it('documents a runnable invocation that is pinned, not floating on @latest', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/npx calldiff@\d+\.\d+\.\d+/);
    expect(md, 'a default-prompt rule must not run an unpinned package').not.toContain('calldiff@latest');
  });

  it('bounds the call portably — tool timeout, never the macOS-missing `timeout` binary', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/timeout .*120000|120000 ms/);
    expect(md, 'the `timeout` binary is absent on the macOS hosts this bot runs on').not.toMatch(
      /^\s*timeout \d+ npx/m,
    );
  });

  it('documents the failure path: one attempt, degrade to a file-level summary', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    const lower = md.toLowerCase();
    expect(lower).toMatch(/non-zero exit|exits non-zero/);
    expect(lower).toMatch(/timeout|times out/);
    expect(md).toMatch(/calldiff unavailable/);
    expect(lower).toMatch(/do not retry|never block|one attempt/);
  });

  it('documents all three subcommands with concrete examples', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    for (const sub of ['diff', 'tree', 'reach']) {
      expect(md, `SKILL.md must document the "${sub}" subcommand`).toMatch(
        new RegExp(`calldiff@\\d+\\.\\d+\\.\\d+ ${sub}\\b`),
      );
    }
    // git-diff shaped ref semantics — the part agents get wrong most often.
    expect(md).toMatch(/HEAD/);
    expect(md).toMatch(/--entry|-e /);
  });

  it('states the syntactic (AST) limitation so agents do not over-claim', () => {
    const md = readFileSync(SKILL_MD, 'utf8').toLowerCase();
    expect(md).toMatch(/syntactic|ast-based|tree-sitter/);
    expect(md).toMatch(/dynamic call|not a (full )?typecheck/);
  });

  it('attributes the upstream source (tanishqkancharla/calldiff, MIT)', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/tanishqkancharla\/calldiff/);
    expect(md).toMatch(/MIT/);
  });
});

describe('default prompt wires calldiff into task completion (T2)', () => {
  it('default.prompt instructs summarizing code changes with the calldiff skill when work completes', () => {
    const prompt = readFileSync(DEFAULT_PROMPT, 'utf8');
    expect(prompt).toMatch(/calldiff/);
    const lower = prompt.toLowerCase();
    // The rule must be tied to work completion, not a free-floating mention.
    expect(lower).toMatch(/complete|완료|finish|done/);
    expect(lower).toMatch(/summar|요약/);
  });

  it('the completion rule names the skill in invocable form (local:calldiff)', () => {
    const prompt = readFileSync(DEFAULT_PROMPT, 'utf8');
    expect(prompt).toMatch(/local:calldiff/);
  });

  it('the completion rule is pinned, bounded, and degrades instead of blocking', () => {
    const prompt = readFileSync(DEFAULT_PROMPT, 'utf8');
    // A rule that fires on every completed coding task must not run an unpinned
    // package, must not hang unbounded, and must not gate the report.
    expect(prompt).toMatch(/npx calldiff@\d+\.\d+\.\d+/);
    expect(prompt).toMatch(/120000/);
    expect(prompt, 'the `timeout` binary is absent on macOS hosts').not.toMatch(/timeout \d+ npx calldiff/);
    expect(prompt).not.toContain('calldiff@latest');
    expect(prompt).toMatch(/calldiff unavailable/);
    expect(prompt.toLowerCase()).toMatch(/never let it stall|not a blocker/);
  });
});

describe('plugin manifest keeps pace with its payload (src/local/CLAUDE.md rule)', () => {
  it('plugin.json version is bumped past 1.3.0 for the new skill', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')) as { version: string };
    const [major, minor] = manifest.version.split('.').map(Number);
    expect(major * 1000 + minor).toBeGreaterThan(1 * 1000 + 3);
  });
});

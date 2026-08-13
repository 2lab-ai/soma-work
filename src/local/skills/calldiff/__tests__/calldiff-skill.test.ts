import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

  it('describes the real no-change output of the pinned CLI, not "empty output"', () => {
    // Verified against calldiff@0.5.0: it prints
    // "No callstack changes between HEAD and working tree." — it does not print nothing.
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/No callstack changes between/);
  });

  it('does not claim `ascii` is an accepted --format value', () => {
    // calldiff@0.5.0 --help: --format <toon|json|yaml|md|jsonl>. ASCII is the
    // no-flag default renderer, not a value.
    const md = readFileSync(SKILL_MD, 'utf8');
    const formatRow = md.split('\n').find((line) => line.includes('`--format`')) ?? '';
    expect(formatRow, 'the --format row must exist').not.toBe('');
    expect(formatRow).toMatch(/toon/);
    expect(formatRow).toMatch(/not.*accepted value|`ascii` is \*\*not\*\*/);
  });

  it('detects the base ref instead of hardcoding main', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/do not hardcode `main`|baseRefName|origin\/HEAD/);
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

  it('the rule is scoped to turns that actually modified source, not every "coding task"', () => {
    const prompt = readFileSync(DEFAULT_PROMPT, 'utf8');
    const section = prompt.slice(prompt.indexOf('## On Task Completion'));
    // Must require a real source edit...
    expect(section).toMatch(/modified source code|edited source|changed source/i);
    // ...and must exclude read-only work explicitly.
    expect(section.toLowerCase()).toMatch(/read-only/);
    expect(section.toLowerCase()).toMatch(/review|investigat|explanation|planning/);
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

/**
 * SSOT_2: "디폴트 프롬프트에 PR 만들시 항상 코드 변경이 일어날시에 calldiff 스킬 사용해서
 *          최상단 서머리에 항상 calldiff 리포트 포함하도록 변경하고 배포까지 해줘"
 *
 *  - T4: default.prompt must require a calldiff report block at the TOP of every
 *        PR body whenever the PR carries code changes, and the block must always
 *        be present (no-change / unavailable / no-source cases each get a line).
 */
describe('default prompt requires a calldiff report at the top of every PR body (T4)', () => {
  function prCreationSection(): string {
    const prompt = readFileSync(DEFAULT_PROMPT, 'utf8');
    const start = prompt.indexOf('## On Pull Request Creation');
    if (start === -1) return '';
    const rest = prompt.slice(start + 1);
    const nextHeading = rest.indexOf('\n## ');
    return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  }

  it('has a dedicated PR-creation section', () => {
    expect(prCreationSection(), 'default.prompt needs a "## On Pull Request Creation" section').not.toBe('');
  });

  it('fires whenever the PR contains code changes', () => {
    const section = prCreationSection().toLowerCase();
    expect(section).toMatch(/code change|source change|changes source|modified source/);
    expect(section).toMatch(/pull request|\bpr\b/);
  });

  it('pins the report to the TOP summary of the PR body', () => {
    const section = prCreationSection();
    const lower = section.toLowerCase();
    // Position is the whole point of the requirement: topmost summary block.
    expect(lower).toMatch(/top of the pr body|first section|topmost|before any other section/);
    expect(lower).toMatch(/summary/);
  });

  it('states the obligation and delegates mechanics to the skill — one source of truth', () => {
    const section = prCreationSection();
    // default.prompt is loaded in EVERY session, so it carries the obligation only.
    expect(section).toMatch(/local:calldiff/);
    expect(section, 'default.prompt must not restate the pinned command — that lives in SKILL.md').not.toMatch(
      /npx calldiff@\d+\.\d+\.\d+/,
    );
    // ...and the skill must actually carry the mechanics being delegated to it.
    const prSection = readFileSync(SKILL_MD, 'utf8').slice(
      readFileSync(SKILL_MD, 'utf8').indexOf('## In a pull request body'),
    );
    expect(prSection).toMatch(/npx calldiff@\d+\.\d+\.\d+ diff/);
    expect(prSection, 'the `timeout` binary is absent on macOS hosts').not.toMatch(/timeout \d+ npx calldiff/);
  });

  it('resolves the base as the ref passed to `gh pr create --base`, not a not-yet-existing PR', () => {
    const section = prCreationSection();
    // The PR does not exist at creation time, so `gh pr view` cannot be the
    // primary source — diffing against the wrong base yields a report that is
    // present, topmost, and false.
    expect(section).toMatch(/gh pr create --base/);
    expect(section.toLowerCase()).toMatch(/existing pr/);
    expect(section).toMatch(/origin\/HEAD/);
    expect(section.toLowerCase()).not.toMatch(/always diff against `?main`?/);
  });

  it('anchors the trigger on PR creation itself', () => {
    const section = prCreationSection();
    expect(section).toMatch(/gh pr create/);
  });

  it('SKILL.md orders base resolution and fetches a missing base ref (shallow clones)', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    const prSection = md.slice(md.indexOf('## In a pull request body'));
    expect(prSection).toMatch(/gh pr create --base/);
    // A bare `git fetch origin <base>` only moves FETCH_HEAD in a narrowed
    // clone (verified: `git clone --depth 1 --branch main` then
    // `git fetch --depth=50 origin deploy/dev` leaves origin/deploy/dev
    // MISSING, and calldiff dies with "Unknown git ref"). The explicit
    // src:dst refspec is what actually creates the remote-tracking ref.
    expect(prSection).toMatch(/git fetch[^\n]*refs\/heads\/[^\n]*:refs\/remotes\/origin\//);
    expect(prSection, 'a bare `git fetch origin $BASE` is the defect, not the fix').not.toMatch(
      /git fetch --depth=\d+ origin "\$BASE"\s*$/m,
    );
    expect(prSection).toMatch(/FETCH_HEAD/);
    expect(prSection.toLowerCase()).toMatch(/shallow clone/);
    // and it must say why a wrong base is worse than nothing
    expect(prSection.toLowerCase()).toMatch(/false|wrong base/);
  });

  it('keeps the block present in all three quiet cases — never silently omitted', () => {
    const section = prCreationSection();
    // (a) call flow genuinely unchanged
    expect(section).toMatch(/No callstack changes/);
    // (b) tool could not run
    expect(section).toMatch(/calldiff unavailable/);
    // (c) no source files in the PR at all
    expect(section.toLowerCase()).toMatch(/no source|n\/a|not applicable/);
    // and the block must be stated as mandatory
    expect(section.toLowerCase()).toMatch(/always|never omit|must/);
  });

  it('does not let calldiff block PR creation', () => {
    const section = prCreationSection().toLowerCase();
    expect(section).toMatch(/not a blocker|never block|do not block/);
  });

  it('keeps the report fresh when more source commits land on the PR', () => {
    const section = prCreationSection().toLowerCase();
    expect(section).toMatch(/push|update|refresh/);
  });
});

/**
 * T5 — the "항상" (always) guarantee only holds if EVERY PR-creating surface in
 * this repo carries the rule. default.prompt is one surface among several: the
 * z/autoz pipeline creates PRs through `local:zwork`, and `local:using-epic-tasks`
 * ships PR body templates that own the `## Summary` slot. A more specific skill
 * contract beats the default prompt, so an un-updated surface is a real hole.
 */
describe('every PR-creating surface carries the calldiff-first rule (T5)', () => {
  const SKILLS_DIR = resolve(__dirname, '..', '..');
  const ZWORK = resolve(SKILLS_DIR, 'zwork', 'SKILL.md');
  const EPIC_TEMPLATES = resolve(SKILLS_DIR, 'using-epic-tasks', 'reference', 'templates.md');

  it('zwork — the pipeline surface that actually runs `gh pr create` — requires the block first', () => {
    const md = readFileSync(ZWORK, 'utf8');
    expect(md).toMatch(/gh pr create/);
    const prStep = md.slice(md.indexOf('5. Create PR.'), md.indexOf('6. Invoke'));
    expect(prStep, 'zwork step 5 must name the calldiff block').toMatch(/calldiff/);
    expect(prStep.toLowerCase()).toMatch(/first|최상단|top/);
  });

  it('using-epic-tasks PR templates reserve the top of `## Summary` for the report', () => {
    const md = readFileSync(EPIC_TEMPLATES, 'utf8');
    const summaryBlocks = md.split('## Summary').slice(1);
    expect(summaryBlocks.length, 'templates.md must still contain PR Summary templates').toBeGreaterThan(0);
    for (const [i, block] of summaryBlocks.entries()) {
      // Look only at the head of each Summary section — the report must come
      // before the one-line restatement and before `Closes #`.
      const head = block.slice(0, block.indexOf('Closes #') === -1 ? 400 : block.indexOf('Closes #'));
      expect(head, `PR Summary template #${i + 1} must lead with the calldiff block`).toMatch(/calldiff/);
    }
  });

  it('no PR-creating surface silently drops the rule — discovered by scan, not hardcoded', () => {
    // The whole point of T5 is catching a surface nobody remembered to update.
    // A hardcoded list would stay green forever while a NEW skill quietly
    // bypasses the rule — so this discovers skills instead of listing them.
    const scanned: string[] = [];
    const offenders: string[] = [];
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'calldiff') continue;
      const skillMd = resolve(SKILLS_DIR, entry.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const md = readFileSync(skillMd, 'utf8');
      if (!md.includes('gh pr create')) continue;
      scanned.push(entry.name);
      if (!md.includes('calldiff')) offenders.push(entry.name);
    }
    expect(scanned.length, 'the scan must actually find PR-creating skills').toBeGreaterThan(0);
    expect(offenders, `these skills create PRs without the calldiff rule: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('plugin manifest keeps pace with its payload (src/local/CLAUDE.md rule)', () => {
  it('plugin.json version is bumped past 1.3.0 for the new skill', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')) as { version: string };
    const [major, minor] = manifest.version.split('.').map(Number);
    expect(major * 1000 + minor).toBeGreaterThan(1 * 1000 + 3);
  });
});

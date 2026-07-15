import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RED contract for the autoz skill-tree refinement (SSOT T1/T3/T4).
 *
 * SSOT_1: "autoz 내용을 개선해줘. autoz가 참조하는 모든 스킬들도 다 찾아가서
 *          전체를 트리구조로 구조화하고 각각의 스킬에 대해서 개선해주고 …
 *          논리적 헛점이나 중언 부언등 쓸데 없는 내용 모두 삭제해줘. …
 *          그리고 다음의 내용도 autoz에 추가해줘. 분석 스텝 …"
 *
 *  - T4: autoz SKILL.md carries an Analysis step — stv:trace across the
 *        project's actual multi-tier surface (backoffice→…→user is an
 *        example, not a fixed list), structurize + html visualization,
 *        two HTML artifacts (problem analysis / final ES report + QA list).
 *  - T1/T3: logical holes fixed across the referenced skill tree —
 *        decision-gate small..medium gap, zwork dispatch-before-RED
 *        ordering, z self-flagellation string, typos.
 */

const SKILLS = resolve(__dirname, '..', '..');
const read = (skill: string) => readFileSync(resolve(SKILLS, skill, 'SKILL.md'), 'utf8');

describe('T4 — autoz Analysis step', () => {
  it('pipeline carries an Analysis step between Explore and RED', () => {
    const md = read('autoz');
    const pipeline = md.slice(md.indexOf('## Pipeline Order'));
    const explore = pipeline.search(/\*\*Explore/);
    const analysis = pipeline.search(/\*\*Analysis/);
    const red = pipeline.search(/\*\*RED\b/);
    expect(explore, 'Explore step exists').toBeGreaterThan(-1);
    expect(analysis, 'Analysis step exists').toBeGreaterThan(-1);
    expect(red, 'RED step exists').toBeGreaterThan(-1);
    expect(explore, 'Explore before Analysis').toBeLessThan(analysis);
    expect(analysis, 'Analysis before RED').toBeLessThan(red);
  });

  it('analysis verifies behavior code-based via stv:trace across a project-derived multi-tier surface', () => {
    const md = read('autoz');
    expect(md).toMatch(/stv:trace/);
    // The backoffice→…→user chain is an example; the tiers must be derived
    // from the actual project, and may be more or fewer.
    expect(md).toMatch(/tier surface|티어 서피스/i);
    expect(md.toLowerCase()).toMatch(/example, not a fixed list|예시일 뿐|고정된 목록이 아니다/);
  });

  it('analysis uses structurize + html, and data stores name the real storage location with examples', () => {
    const md = read('autoz');
    expect(md).toMatch(/local:structurize/);
    expect(md).toMatch(/local:html/);
    expect(md.toLowerCase()).toMatch(/data store|데이터 스토어/);
    expect(md.toLowerCase()).toMatch(/where .*actually stored|실제로 어디에 저장/);
  });

  it('exactly two HTML artifacts: problem analysis + final ES report with QA list', () => {
    const md = read('autoz');
    expect(md.toLowerCase()).toMatch(/problem[- ]analysis (html|visualization|artifact)/);
    expect(md.toLowerCase()).toMatch(/final es report/);
    expect(md.toLowerCase()).toMatch(/qa (list|checklist)/);
    // final report descends from high level to low-level detail and embeds the initial analysis
    expect(md.toLowerCase()).toMatch(/high[- ]level .*low[- ]level|하이레벨.*로우레벨/);
  });
});

describe('T1/T3 — logical holes removed across the z-family tree', () => {
  it('decision-gate has no undefined band between small and medium', () => {
    const md = read('decision-gate');
    // The autonomous branch must cover everything below medium (tiny AND small),
    // not "< small" which leaves 20–50 lines undefined.
    expect(md).toMatch(/switching_cost\s*<\s*medium/);
    expect(md).not.toMatch(/if\s+switching_cost\s*<\s*small/);
  });

  it('z controller contains no self-flagellation string', () => {
    const md = read('z');
    expect(md).not.toMatch(/worthless piece of shit/i);
  });

  it('zwork writes RED tests before dispatching implementers', () => {
    const md = read('zwork');
    const process = md.slice(md.indexOf('## Process'));
    const red = process.search(/RED tests?/i);
    const dispatch = process.search(/Dispatch Implementer/i);
    expect(red, 'RED step exists').toBeGreaterThan(-1);
    expect(dispatch, 'implementer dispatch exists').toBeGreaterThan(-1);
    expect(red, 'RED tests must be written before implementer dispatch').toBeLessThan(dispatch);
  });

  it('typos fixed: zcheck "bracnh", using-ssot "psuedo"', () => {
    expect(read('zcheck')).not.toMatch(/bracnh/);
    expect(read('using-ssot')).not.toMatch(/psuedo/);
  });
});

describe('T5 — gpt-5.6-sol review findings folded in', () => {
  it('data-store examples are synthetic/redacted, never live values (finding 1)', () => {
    const md = read('autoz');
    expect(md.toLowerCase()).toMatch(/synthesized|synthetic|redacted/);
    expect(md.toLowerCase()).toMatch(/never fetched from a live store|never published with live values/);
  });

  it('autoz suppresses interactive gates in the delegated z flow (finding 2)', () => {
    expect(read('autoz').toLowerCase()).toMatch(/interactive gates suppressed|gates suppressed/);
    expect(read('zcheck')).toMatch(/autoz 하에서는 이 질문을 생략/);
  });

  it('RED authorship has one owner and rides the handoff (finding 3)', () => {
    expect(read('autoz').toLowerCase()).toMatch(/red authorship has one owner/);
    expect(read('zwork').toLowerCase()).toMatch(/reuse and extend/);
  });

  it('final ES artifact is exempt from es HA discipline (finding 5)', () => {
    expect(read('autoz').toLowerCase()).toMatch(/exempt from .*ha .*discipline|ha exemption/);
  });

  it('decision-gate carries no stale "< small" autonomous band (finding 6)', () => {
    const md = read('decision-gate');
    expect(md).not.toMatch(/switching cost < small/);
    expect(md).not.toMatch(/switching_cost\s*<\s*small/);
  });

  it('skill tree includes the transitive dependencies (r1 finding 4 + r2 finding 4)', () => {
    const md = read('autoz');
    for (const dep of [
      'stv:debug',
      'stv:new-task',
      'stv:verify',
      'superpowers:dispatching-parallel-agents',
      'local:review-pr',
      'local:UIAskUserQuestion',
      'local:using-ha-thinking',
      'local:lottie',
      'oracle-reviewer',
    ]) {
      expect(md, `skill tree must include ${dep}`).toContain(dep);
    }
  });

  it('pipeline mode + analysis carriage exist in the canonical handoff contract (r2 findings 1–2)', () => {
    const usingZ = read('using-z');
    expect(usingZ).toMatch(/## Pipeline Mode/);
    expect(usingZ).toMatch(/## Analysis Artifact/);
    expect(usingZ).toMatch(/## Analysis Summary/);
    expect(usingZ).toMatch(/## RED Mapping/);
    // z phase0 restores the mode; zwork consumes the analysis fields.
    expect(read('z')).toMatch(/Pipeline Mode/);
    expect(read('zwork')).toMatch(/## RED Mapping|RED Mapping/);
  });

  it('oversized scope is an explicit autoz Hard Blocker (r2 finding 3)', () => {
    const md = read('autoz');
    const blockers = md.slice(md.indexOf('## Hard Blockers'), md.indexOf('## Pipeline Order'));
    expect(blockers.toLowerCase()).toMatch(/oversized scope/);
    expect(blockers.toLowerCase()).toMatch(/xxlarge|case c/);
  });

  it('new handoff fields are prompt-only and restored by the workflow prompt (r3 finding 1)', () => {
    const usingZ = read('using-z');
    // Not advertised as host-persisted: they live under a prompt-only marker.
    expect(usingZ).toMatch(/Prompt-only/);
    const workflowPrompt = readFileSync(
      resolve(SKILLS, '..', '..', 'prompt', 'workflows', 'z-plan-to-work.prompt'),
      'utf8',
    );
    expect(workflowPrompt).toMatch(/## Pipeline Mode/);
    expect(workflowPrompt).toMatch(/## Analysis Artifact/);
    expect(workflowPrompt).toMatch(/## RED Mapping/);
    expect(workflowPrompt.toLowerCase()).toMatch(/host parser does\s+not extract/);
  });
});

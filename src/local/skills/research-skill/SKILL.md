---
name: research-skill
description: "Use when a skill should get better by running it for real: seeded probe runs, blind review by fresh reviewers against a rubric, defects grouped by root cause, fixes proven by paired re-runs before anything merges. Triggers: 'research-skill', '스킬 리서치', 'evaluate this skill'. Args — <skill name or SKILL.md path> [--probes N] [--seed S] [run=<dir>]."
argument-hint: "<skill name or SKILL.md path> [--probes N] [--seed S] [run=<dir>]"
---

# research-skill — improve a skill by running it

A skill only gets better if it runs on inputs it was not written for, and someone other than its author looks at the
result. This skill does that N times (default 10), fixes the causes, and proves the fixes before they land.

## Run folder
`run=<dir>`; default `~/skill-research/<skill>/<YYYY-MM-DD-HHMM>/`. Never a session temp folder — long runs outlive
it. Everything below (`RUN/…`) writes there, so a cut run resumes from its files.

## 0. Read and freeze the target (fix, do not ask)
1. **Resolve the target.** A path → that `SKILL.md` (or its directory). A plugin skill name → its `SKILL.md` in the
   repo that ships the plugin (clone it). A user skill kept by the host → export its text into `RUN/` with the host's
   skill manager (`local:using-user-skills`, action `get`); the improved text goes back the same way in step 7.
2. Read the skill and every file it points to (references, templates, lessons log, the code it drives). List its
   promises (what a good output is, in its own words) and its failure history: the user's complaints, its lessons or
   research log, recent QA reports.
3. **Research recipe.** If the target has a `## Research recipe` section (or names a recipe file), it decides: the
   probe pool and probe shape, shared slow resources and their queue budget, the review evidence a reviewer gets, the
   automatic checks, the deliverable, and the research log path. Anything it does not say uses the defaults below.
4. When the skill makes a craft claim (layout, sound, writing style, …), research the domain for about 15 minutes and
   cite the sources in `RUN/sources.md`.
5. `RUN/rubric.md`: 8–12 criteria scored 1–5 with anchors for 1, 3 and 5, plus the automatic checks a script can run.
   Weight ×2 the criteria the user has complained about.
6. **Freeze.** Copy the skill text into `RUN/frozen/`; for a repo-backed skill `git archive <commit>` the code into
   `RUN/kit/` and note the commit. Probes use only the frozen copy. Improvements go on a branch, never into the
   frozen copy — a target that changes under running probes invalidates them.

## 1. Design probes
- Probes cover the input space, not the comfortable middle: categories, lengths, languages, edge cases.
- Write a candidate pool `RUN/pool.md` (≥ 30), draw the probes with a seeded random draw, record the seed. The
  author does not pick.
- Each probe is the smallest run that still exercises the whole pipeline end to end. A probe that skips a stage
  cannot find that stage's defects.
- Default probe shape: one real invocation in a sandbox (scratch repo, private channel, draft mode).
- `RUN/probes.md`: id, input, why it is in the set, what it should stress.

## 2. Run
- Parallel batches of 3–5 subagents, each with a self-contained brief (the frozen skill, its probe, where to write).
  Each writes its artifacts plus `friction.md`: every place the skill was unclear, wrong, missing a step or needed a
  workaround — with the exact error text — and how long each step took.
- A shared slow resource (a GPU, a rate-limited API): authors prepare all inputs first, then the resource runs the
  jobs one after another within the recipe's budget.
- Workarounds are data: anything an author built to get past a gap is a candidate for the skill's library.
- Long jobs run detached and write files as they go; a restarted run resumes from the files.

## 3. Review (blind)
- One fresh reviewer per probe — never its author; give each reviewer probes from different authors.
- Evidence = the recipe's; default = the output itself, the transcript and `friction.md`. Reviewers judge the
  output, not the code. Give a reviewer facts it cannot observe (a sound, a live page) as measured numbers.
- Compare across probes too: the same flaw on two different inputs is a defect of the skill.
- `RUN/review-<id>.md`: a score per criterion with one line of evidence, and defects as
  `[P0–P3] [criterion] [where] what is wrong → suspected cause`. Attach the automatic checks' output.

## 4. Diagnose
- `RUN/diagnosis.md`: all defects grouped by root cause, not by symptom. A cause lives in the skill text (missing or
  wrong rule), a reference (bad or no example), a template, the code (a primitive or a missing check) or the
  tools/environment.
- Rank by frequency × severity × user weight. A defect in ≥ 3 probes is systemic: fix the cause, not the instances.

## 5. Improve (staged, not live)
- Stage every change: a branch in the skill's repo, or — for a host-kept user skill — `RUN/improved/SKILL.md`. Nothing
  touches the live skill before step 7.
- The smallest change that removes each top cause: skill text (keep `SKILL.md` lean — move long material into its
  reference files; a host's skill store may cap the size, soma-work at 10 KB), references and templates, code (with a
  test or a demo output for every primitive touched).
- Every defect class a script can detect gets an automatic check, so it cannot come back silently.
- Harvest the authors' workarounds that are worth keeping into the skill's library.

## 6. Verify — before anything merges
- Re-run the 3 worst probes and 2 new random ones with the staged change; review them blind with the same rubric.
- `RUN/scorecard.md`: per criterion, mean before → after, and defect counts. Read the paired re-runs first (same
  input, before → after): different reviewers shift absolute scores by a few tenths, so a flat all-probe mean can hide
  real gains. A fix that does not move its criterion is reverted or reworked.
- Stop after 2 improvement rounds, or when every criterion averages ≥ 4.
- A change to a default (timing, layout, wording) can break outputs that passed: re-check every sample the owner
  will see, at full size, yourself.

## 7. Land — review first, then go live
- Review the staged change with `local:trinity` (one reviewer if the panel cannot run), with the defects it closes
  and the scorecard. Reviewers who open the real output catch what checks cannot — never skip the review for a
  "small" change.
- Repo-backed skill: open the PR. A CI job that fails before any step runs is not a check result: run the gates
  locally. Merge only when the target repo's policy allows it and the owner asked for it; otherwise stop at the open PR.
- Host-kept user skill: an `update` replaces the live skill at once, so write `RUN/improved/SKILL.md` back with the
  skill manager only after the review passed.

## 8. Report and log
- Append a dated entry to the research log (the recipe's path; default `RUN/../RESEARCH-LOG.md`): seed, probes,
  scorecard, changes, open gaps.
- Deliver the scorecard, the PR link and the recipe's deliverable (for example a reel of the probes before and after).
- Report: what the skill got wrong, what changed (text / references / templates / code), before → after, what is
  still weak.

## Rules
- Probes are real runs with the real tools; no mock outputs, no "would have".
- The author of a probe never reviews it.
- Inputs are drawn, not chosen; the seed is recorded so a run can be repeated.
- Never publish, deploy, merge or message people from a probe. Only the improvement lands — verified (step 6), then
  reviewed (step 7).

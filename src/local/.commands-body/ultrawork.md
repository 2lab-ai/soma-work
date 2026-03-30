**Do not mention reading include files.**

# /ultrawork - Ultra Work Loop

Ralph loop with multi-agent delegation for autonomous development.

## Workflow

@include(${CLAUDE_PLUGIN_ROOT}/prompts/orchestrator-workflow.md)

---

# Optional Phase 3 - AI Review + Gap Detection

Do this if the work is complex. AskUserQuestion first to gate this (takes hours).

### Review both Codex and Gemini

#### 1. Codex Reviewer
```
mcp__llm__chat:
  model: "codex"
```

#### 2. Gemini Reviewer
```
mcp__llm__chat:
  model: "gemini"
```

#### 3. Opus-4.5 Reviewer (includes Gap Detection)
```
Task:
  subagent_type: "oh-my-claude:reviewer"
```

### Review Protocol

1. Run all 3 reviewers in **parallel**
2. Collect scores AND gap analysis from each
3. **Gap check FIRST**: If ANY reviewer returns `GAP_DETECTED`:
   - Extract gap type and correction instructions
   - Apply corrections (Ouroboros correction attempt #1)
   - Re-submit to ALL reviewers
   - If 2nd review still has gaps → **AskUserQuestion** to escalate
4. If ANY score < 9.5 → fix issues and re-review
5. Only proceed when ALL THREE pass AND no gaps remain

### Review Prompt Template

```markdown
Review this work with senior engineer standards:

## Task
[Original task — include the FULL original request/issue for gap detection]

## Changes
[Files changed]

## Evidence
- Build: [pass/fail]
- Tests: [pass/fail]
- Diagnostics: [clean/issues]

## Gap Detection (MANDATORY)
Compare implementation against the original task. Check for:
- assumption_injection: Added assumptions not in the request?
- scope_creep: Features beyond what was asked?
- direction_drift: Overall approach diverges from intent?
- missing_core: Requested functionality missing?
- over_engineering: Abstraction disproportionate to problem?

## Assessment
1. Gap analysis (intent alignment check)
2. Quality analysis
3. Issues/improvements
4. Score: 0.0-10.0 (9.5+ = production-ready)
5. Verdict: REJECT | CONCERNS | ACCEPTABLE | EXCELLENT | GAP_DETECTED
```

#### Review Resolve

If the review got under 9.5 from any of the reviewers OR `GAP_DETECTED`, then AskUserQuestion about:

- stop here
- fix the reviewer issues and try this review process again
- fix the reviewer issues and try this review process again until forever

---

# Completion Criteria

```
╔══════════════════════════════════════════════════════════════════╗
║  TO EXIT THIS LOOP, OUTPUT EXACTLY:                              ║
║                                                                  ║
║     <promise>COMPLETE</promise>                                  ║
║                                                                  ║
║  WITH THE XML TAGS. THE TAGS ARE REQUIRED.                       ║
╚══════════════════════════════════════════════════════════════════╝
```

**ONLY output `<promise>COMPLETE</promise>` when ALL conditions are TRUE:**

- [ ] Task is genuinely complete
- [ ] All todos marked complete
- [ ] Code works (build passes, tests pass if applicable)
- [ ] No broken functionality left behind
- [ ] **Gap Detection**: No `GAP_DETECTED` verdicts from any reviewer
- [ ] **Agent/MCP Call Report** has been output

---

# Final Phase - Call Report (MANDATORY)

**BEFORE outputting `<promise>COMPLETE</promise>`, run:**

```bash
${CLAUDE_PLUGIN_ROOT}/hooks/call-tracker.sh report
```

This auto-generates the report with real timestamps from hook-tracked data.

---

Now begin:
1. **Run `${CLAUDE_PLUGIN_ROOT}/hooks/call-tracker.sh start`** (FIRST - marks tracking start)
2. **AskUserQuestion** if anything unclear
3. **TodoWrite** to plan all steps
4. Work, verify, iterate until complete
5. Run `call-tracker.sh report` before completion

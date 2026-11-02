/**
 * Plan mode (SSOT 2026-11-02) — step 6c's check: while a task's plan is not
 * started, a call that would do the work is refused; research runs (trinity R2, astra P1).
 *
 * ssot-task map: T2 (the model plans, it does not work) · T4 (the work starts on 시작).
 */
import { describe, expect, it } from 'vitest';
import { checkPlanPendingCall, isReadOnlyCommand, PLAN_PENDING_DENIED_TOOLS } from '../policy/plan-pending-guard';

describe('isReadOnlyCommand — reads pass, everything else is refused', () => {
  it.each([
    'ls -la',
    'cat src/index.ts',
    'head -50 README.md && tail -20 README.md',
    "grep -rn 'taskPlan' src | head -20",
    'rg -n planPending src',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    "sed -n '1,120p' src/types.ts",
    'git log --oneline -20',
    'git -C repo show HEAD~1 --stat',
    'git diff main...HEAD -- src',
    'git status --short',
    'git branch --show-current',
    'git branch -a',
    'git clone https://github.com/2lab-ai/soma-work.git',
    'git fetch origin main',
    'cd repo && git log -3',
    'gh pr view 758 --json title,body',
    'gh issue list --state open',
    'gh api repos/2lab-ai/soma-work/pulls/758',
    'wc -l src/conversation/dashboard.ts 2>/dev/null',
    'ls missing 2>&1',
    'jq .name package.json',
  ])('reads: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });

  it.each([
    'rm -rf src',
    'echo hi > notes.md',
    'cat a >> b',
    'git commit -m x',
    'git push origin HEAD',
    'git checkout -b feat',
    'git branch new-branch',
    'git branch -D old',
    'git -c core.pager=sh log',
    'git log --output=out.txt',
    'git clone --upload-pack=evil url',
    'npm install',
    'npx vitest run',
    'node -e "1"',
    'python3 script.py',
    'curl -o x https://example.com',
    'find . -name x -delete',
    'find . -exec rm {} \\;',
    "sed -i 's/a/b/' f.ts",
    "sed -n 'w out' f",
    'sort -o out in',
    'rg --pre ./x pattern',
    'gh pr create --title x',
    'gh pr merge 1',
    'gh api -X POST repos/x/y/issues',
    'gh api repos/x/y/issues -f title=x',
    'echo $(rm -rf x)',
    'echo `id`',
    'ls & rm x',
    'X=1 ls',
    './scripts/deploy.sh',
    'cat a | tee b',
    'xargs rm < list',
    "grep 'a;b' f",
    '',
  ])('refused: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false);
  });
});

describe('checkPlanPendingCall — the tools of a planning turn', () => {
  it('refuses the native write tools and subagents', () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Artifact', 'EnterWorktree', 'Agent', 'Task']) {
      expect(PLAN_PENDING_DENIED_TOOLS).toContain(tool);
      expect(checkPlanPendingCall(tool, {})).not.toBeNull();
    }
  });

  it('lets reading and research run', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill']) {
      expect(checkPlanPendingCall(tool, {})).toBeNull();
    }
    expect(checkPlanPendingCall('Bash', { command: 'git log -5' })).toBeNull();
    expect(checkPlanPendingCall('Bash', { command: 'git push' })).toMatch(/not read-only/);
    expect(checkPlanPendingCall('Bash', {})).toMatch(/not read-only/);
  });

  it('MCP: the plan tool and read-shaped tools run; a tool named for a change does not', () => {
    for (const tool of [
      'mcp__plan__plan_submit',
      'mcp__github__get_file_contents',
      'mcp__github__search_code',
      'mcp__github__list_pull_requests',
      'mcp__server-tools__db_query',
      'mcp__slack-mcp__get_thread_messages',
      'mcp__model-command__list',
      'mcp__cron__cron_list',
    ]) {
      expect(checkPlanPendingCall(tool, {})).toBeNull();
    }
    for (const tool of [
      'mcp__github__create_pull_request',
      'mcp__github__push_files',
      'mcp__github__merge_pull_request',
      'mcp__github__update_issue',
      'mcp__slack-mcp__send_thread_message',
      'mcp__model-command__run',
      'mcp__cron__cron_create',
      'mcp__x__get_or_create_item',
      'mcp__x__getAndDeleteThing',
      'mcp__x__collect',
      'mcp__weird',
    ]) {
      expect(checkPlanPendingCall(tool, {})).not.toBeNull();
    }
  });
});

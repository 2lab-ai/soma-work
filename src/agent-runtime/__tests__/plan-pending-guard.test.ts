/**
 * Plan mode (SSOT 2026-11-02) — step 6c's check: while a task's plan is not
 * started, a call that would do the work is refused; research runs (trinity R2, astra P1).
 * The shell is refused outright (trinity R3–R4): every "read-only" classifier the
 * review rounds probed had a way through, kept below as regressions.
 *
 * ssot-task map: T2 (the model plans, it does not work) · T4 (the work starts on 시작).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_SUBMIT_TOOL } from '../../task-turn/task-plan';
import {
  checkPlanPendingCall,
  PLAN_READ_MCP_TOOLS,
  PLAN_RESEARCH_TOOLS,
  PLAN_SKILLS,
} from '../policy/plan-pending-guard';

describe('checkPlanPendingCall — the shell waits for 시작', () => {
  it.each([
    // What a read-only classifier would have let through — each changed something in review.
    "find . -name '*.tmp' -de'lete'",
    'find . -de\\lete',
    'sort -ro notes.txt README.md',
    'git grep --open-files-in-page="sh -c x" -e PLAN -- src',
    "git grep -O'sed -i s/a/b/' -e x",
    'rg --hostname-bin=/usr/bin/ssh-agent --hyperlink-format=default x README.md',
    "printf '%n' 'a[$(touch /tmp/plan-mode-bypass; echo 1)]'",
    'printf -v PATH ./payload; git status',
    'git clone https://github.com/2lab-ai/soma-work.git node_modules/plan-escape',
    'gh repo view 2lab-ai/soma-work --web=true',
    'gh pr view 758 -cw',
    'git fetch origin tag v1.0.0',
    'git fetch origin main:refs/heads/main',
    // And plain reads: no shell at all while planning.
    'ls -la',
    'cat src/index.ts',
    'git log --oneline -5',
    'git status',
    '',
  ])('refused: %s', (command) => {
    expect(checkPlanPendingCall('Bash', { command })).toMatch(/plan is started/);
  });

  it('refuses a call with no command too', () => {
    expect(checkPlanPendingCall('Bash', {})).not.toBeNull();
  });
});

describe('checkPlanPendingCall — the tools of a planning turn', () => {
  it('lets reading and research run', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite']) {
      expect(PLAN_RESEARCH_TOOLS).toContain(tool);
      expect(checkPlanPendingCall(tool, {})).toBeNull();
    }
  });

  it('refuses the native write tools, subagents and every tool it does not know — an allow-list', () => {
    for (const tool of [
      'Bash',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Artifact',
      'EnterWorktree',
      'Agent',
      'Task',
      'Monitor',
      'Workflow',
      'RemoteTrigger',
      'ScheduleWakeup',
      'PushNotification',
      'SendMessage',
      'EnterPlanMode',
      'ExitPlanMode',
      'ExitWorktree',
      'CronCreate',
      'KillShell',
      'BashOutput',
      'FutureTool',
      '',
    ]) {
      expect(PLAN_RESEARCH_TOOLS).not.toContain(tool);
      expect(checkPlanPendingCall(tool, {}), tool).not.toBeNull();
    }
  });

  it('MCP: the plan tool and the exact read tools run; every other MCP tool does not', () => {
    expect(PLAN_READ_MCP_TOOLS).toContain(PLAN_SUBMIT_TOOL);
    for (const tool of [
      PLAN_SUBMIT_TOOL,
      'mcp__github__get_file_contents',
      'mcp__github__search_code',
      'mcp__github__list_pull_requests',
      'mcp__filesystem__read_text_file',
      'mcp__model-command__list',
    ]) {
      expect(checkPlanPendingCall(tool, {}), tool).toBeNull();
    }
    for (const tool of [
      'mcp__github__create_pull_request',
      'mcp__github__push_files',
      'mcp__github__merge_pull_request',
      'mcp__github__update_issue',
      'mcp__slack-mcp__send_thread_message',
      'mcp__model-command__run',
      'mcp__cron__cron_create',
      'mcp__cron__cron_list',
      // A read-shaped name proves nothing — redis_query takes GEORADIUS … STORE.
      'mcp__server-tools__redis_query',
      'mcp__server-tools__db_query',
      'mcp__x__get_anything',
      'mcp__plan__other_tool',
      'mcp__weird',
    ]) {
      expect(checkPlanPendingCall(tool, {}), tool).not.toBeNull();
    }
  });
});

describe('checkPlanPendingCall — skills (trinity R5, astra P1)', () => {
  // A skill can run shell lines while it loads (`!` lines) and register command hooks (`hooks:`
  // frontmatter) that run on later, permitted calls — outside the plan check. Only the planning
  // skills the notice names load while a plan waits.
  it('loads only the planning skills the notice names', () => {
    expect(PLAN_SKILLS).toEqual(['zworkflow:using-ssot', 'zworkflow:using-intentfirst']);
    for (const skill of PLAN_SKILLS) expect(checkPlanPendingCall('Skill', { skill })).toBeNull();
    for (const skill of ['prepare-preview', 'zworkflow:autoz', 'using-ssot', 'zworkflow:using-ssot ', '', undefined]) {
      expect(checkPlanPendingCall('Skill', { skill }), String(skill)).not.toBeNull();
    }
    expect(checkPlanPendingCall('Skill', {})).not.toBeNull();
  });

  it('the planning skills carry no shell line and no hooks (a contract: an edit that adds one fails here)', () => {
    for (const name of ['using-ssot', 'using-intentfirst']) {
      const text = readFileSync(join(__dirname, '..', '..', 'local', 'skills', name, 'SKILL.md'), 'utf8');
      const frontmatter = text.startsWith('---') ? text.slice(3, text.indexOf('\n---', 3)) : '';
      // Any spelling of the key — quoted, indented (trinity R5, astra P2) — and no forked subagent context.
      expect(/^\s*["']?hooks["']?\s*:/m.test(frontmatter), `${name} hooks`).toBe(false);
      expect(/^\s*["']?context["']?\s*:\s*["']?fork/m.test(frontmatter), `${name} context: fork`).toBe(false);
      expect(/!`|^```!/m.test(text), `${name} inline shell`).toBe(false);
    }
  });
});

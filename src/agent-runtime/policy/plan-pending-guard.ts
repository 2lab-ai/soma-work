/**
 * Plan mode (SSOT 2026-11-02 — 작업 계획 모드): while a session's plan is
 * not started, its turns plan; they do not do the work. `evaluateToolPolicy`
 * (step 6c) asks this check about every call of such a turn; a reason denies the
 * call in every permission mode, for admins too (trinity R2, astra P1).
 *
 * An allow-list of research, and nothing else: reading files (Read, Glob, Grep),
 * the web (WebFetch, WebSearch), the two planning skills, the turn's own to-do list, the exact
 * read MCP tools and the plan tool. Everything else is refused — the native
 * write tools, subagents and workflows, any tool a future SDK adds, any MCP
 * tool not on the read list, and **the shell**.
 *
 * Why no shell, not a read-only shell (trinity R3–R4): four review rounds found a
 * new way to change something through a "read-only" command each time — quoting
 * (`-de'lete'`), option clusters (`sort -ro`), git option abbreviations
 * (`--open-files-in-page=…`), programs run by readers (`rg --hostname-bin`,
 * `git grep -O`), `printf '%n' 'a[$(…)]'` in zsh, `printf -v PATH`, a clone
 * through a symbolic link, `gh … --web=true`. A command classifier has to model
 * every program's every option and the shell's every expansion; a planning turn
 * does not need it. Code to read is reached with Read/Glob/Grep in the folder and
 * the github read tools for a repository; a clone or a build is a step of the plan.
 * Pure: no I/O.
 */

/**
 * The native tools a planning turn may call: reading, searching, the web, its
 * own to-do list, MCP resource reads. Every other tool — Bash, a writer, a subagent or workflow, a tool
 * that runs a command (`Monitor`), schedules, notifies or triggers, and any tool a future SDK adds — is
 * refused: an allow-list, so a tool nobody listed fails closed. The policy hook of a planning turn sees
 * every tool (catch-all matcher, `build-stream-options.ts`), not only `TOOL_POLICY_MATCHERS`.
 */
export const PLAN_RESEARCH_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];

/**
 * The skills a planning turn may load — the planning disciplines the plan-mode notice names, from
 * soma's own plugin (`src/local/skills`). Any other skill waits for 시작: a skill can run shell lines
 * while it loads (`!` lines) and register command hooks (`hooks:` frontmatter) that run on later,
 * permitted calls, outside this check (trinity R5, astra P1). These two carry neither — a contract
 * test (`plan-pending-guard.test.ts`) fails an edit that adds one.
 */
export const PLAN_SKILLS: readonly string[] = ['zworkflow:using-ssot', 'zworkflow:using-intentfirst'];

/**
 * The MCP tools a planning turn may call: the plan tool and tools whose whole contract is a read,
 * by exact name — a read-shaped name proves nothing (`redis_query` takes `GEORADIUS … STORE`, a
 * write; trinity R3, astra P1). Any other MCP tool waits for 시작.
 */
export const PLAN_READ_MCP_TOOLS: readonly string[] = [
  'mcp__plan__plan_submit',
  'mcp__github__get_file_contents',
  'mcp__github__search_code',
  'mcp__github__search_repositories',
  'mcp__github__search_issues',
  'mcp__github__search_users',
  'mcp__github__get_issue',
  'mcp__github__get_pull_request',
  'mcp__github__get_pull_request_files',
  'mcp__github__get_pull_request_comments',
  'mcp__github__get_pull_request_reviews',
  'mcp__github__get_pull_request_status',
  'mcp__github__list_commits',
  'mcp__github__list_issues',
  'mcp__github__list_pull_requests',
  'mcp__filesystem__read_file',
  'mcp__filesystem__read_text_file',
  'mcp__filesystem__read_media_file',
  'mcp__filesystem__read_multiple_files',
  'mcp__filesystem__list_directory',
  'mcp__filesystem__list_directory_with_sizes',
  'mcp__filesystem__directory_tree',
  'mcp__filesystem__search_files',
  'mcp__filesystem__get_file_info',
  'mcp__filesystem__list_allowed_directories',
  'mcp__model-command__list',
];

/**
 * Step 6c's check: a reason when a planning turn's call would do the work (or could, as any shell
 * command could), else null. The plan tool (`mcp__plan__plan_submit`) always runs.
 */
export function checkPlanPendingCall(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName === 'Bash') return 'the shell runs once the plan is started — read with Read, Glob and Grep';
  if (toolName === 'Skill') {
    const skill = typeof toolInput.skill === 'string' ? toolInput.skill : '';
    return PLAN_SKILLS.includes(skill) ? null : `the skill ${skill || '(none)'} loads once the plan is started`;
  }
  if (toolName.startsWith('mcp__')) {
    return PLAN_READ_MCP_TOOLS.includes(toolName) ? null : `${toolName} is not one of the read tools`;
  }
  return PLAN_RESEARCH_TOOLS.includes(toolName) ? null : `${toolName || 'this tool'} is not a research tool`;
}

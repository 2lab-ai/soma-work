/**
 * Native write boundary (`policy/native-write-boundary.ts`, `evaluateToolPolicy` step 3b).
 *
 * The SDK sandbox confines Bash to the working directory and `/tmp/{userId}`;
 * the native `Write` / `Edit` / `NotebookEdit` run in the SDK process, outside
 * it. Before the boundary a non-admin session could write the data directory
 * (every user's memory, the shared project memory), `.env` or the installed
 * code with a plain `Write` — the review finding this suite reproduces first.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../../env-paths';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';
import { createNativeWriteCheck, NATIVE_WRITE_TOOLS } from '../policy/native-write-boundary';
import { evaluateToolPolicy, type ToolPolicyContext } from '../policy/tool-policy';

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-write-boundary-')));
afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

/** A root with a file in it, and a directory outside every root. */
const ROOT = path.join(SCRATCH, 'root');
const OUTSIDE = path.join(SCRATCH, 'outside');
fs.mkdirSync(path.join(ROOT, 'repo'), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'repo', 'a.txt'), 'a');
fs.writeFileSync(path.join(OUTSIDE, 'secret.json'), '{}');

const check = createNativeWriteCheck([ROOT], path.join(ROOT, 'repo'));
const write = (file_path: unknown) => check('Write', { file_path });

describe('createNativeWriteCheck — where a native write lands', () => {
  it('allows an existing file, a new file and a new file in new directories inside a root', () => {
    expect(write(path.join(ROOT, 'repo', 'a.txt'))).toBeNull();
    expect(write(path.join(ROOT, 'repo', 'b.txt'))).toBeNull();
    expect(write(path.join(ROOT, 'new', 'deeper', 'c.txt'))).toBeNull();
    expect(check('Edit', { file_path: path.join(ROOT, 'repo', 'a.txt') })).toBeNull();
    expect(check('NotebookEdit', { notebook_path: path.join(ROOT, 'repo', 'n.ipynb') })).toBeNull();
  });

  it('refuses a target outside every root', () => {
    expect(write(path.join(OUTSIDE, 'secret.json'))).toMatch(/lands outside the session's writable directories/);
    expect(write('/etc/hosts')).toMatch(/lands outside/);
    // A sibling whose name starts with the root's is not inside it.
    expect(write(`${ROOT}2/x.txt`)).toMatch(/lands outside/);
  });

  it('resolves a relative target against the working directory', () => {
    expect(write('b.txt')).toBeNull();
    const outsideCheck = createNativeWriteCheck([ROOT], OUTSIDE);
    expect(outsideCheck('Write', { file_path: 'secret.json' })).toMatch(/lands outside/);
  });

  it('follows symbolic links: a link inside a root to a directory or file outside is outside', () => {
    fs.symlinkSync(OUTSIDE, path.join(ROOT, 'link-dir'));
    fs.symlinkSync(path.join(OUTSIDE, 'secret.json'), path.join(ROOT, 'link-file'));
    expect(write(path.join(ROOT, 'link-dir', 'secret.json'))).toMatch(/lands outside/);
    expect(write(path.join(ROOT, 'link-dir', 'new.json'))).toMatch(/lands outside/);
    expect(write(path.join(ROOT, 'link-file'))).toMatch(/lands outside/);
  });

  it('follows the system links above a root (as /tmp → /private/tmp), and a link that stays inside', () => {
    const up = path.join(SCRATCH, 'up-alias'); // a link to the directory that holds the root
    fs.symlinkSync(SCRATCH, up);
    const viaUp = path.join(up, 'root');
    expect(createNativeWriteCheck([viaUp], viaUp)('Write', { file_path: path.join(ROOT, 'x.txt') })).toBeNull();
    expect(write(path.join(up, 'root', 'repo', 'a.txt'))).toBeNull();
    fs.symlinkSync(path.join(ROOT, 'repo'), path.join(ROOT, 'repo-alias'));
    expect(write(path.join(ROOT, 'repo-alias', 'a.txt'))).toBeNull();
  });

  it('never trusts a root that is a symbolic link: the session itself can put one there (review R1)', () => {
    // The working directory sits inside /tmp/{userId}, which sandboxed Bash may write:
    // `mv $PWD $PWD-old && ln -s <anywhere> $PWD` must not move the boundary.
    const userDir = path.join(SCRATCH, 'user');
    const cwd = path.join(userDir, 'session_1');
    fs.mkdirSync(cwd, { recursive: true });
    const roots = [cwd, userDir];
    expect(createNativeWriteCheck(roots, cwd)('Write', { file_path: path.join(OUTSIDE, 'secret.json') })).toMatch(
      /lands outside/,
    );
    fs.renameSync(cwd, `${cwd}-old`);
    fs.symlinkSync(OUTSIDE, cwd);
    const relinked = createNativeWriteCheck(roots, cwd);
    expect(relinked('Write', { file_path: path.join(OUTSIDE, 'secret.json') })).toMatch(/cannot be trusted/);
    expect(relinked('Write', { file_path: path.join(cwd, 'secret.json') })).toMatch(/cannot be trusted/);
    expect(relinked('Write', { file_path: '/etc/hosts' })).toMatch(/cannot be trusted/);
    expect(relinked('Write', { file_path: path.join(userDir, 'x.txt') })).toMatch(/cannot be trusted/);
    // the user directory itself, linked away
    const user2 = path.join(SCRATCH, 'user2');
    fs.symlinkSync(OUTSIDE, user2);
    expect(createNativeWriteCheck([user2], user2)('Write', { file_path: path.join(OUTSIDE, 'x.json') })).toMatch(
      /cannot be trusted/,
    );
  });

  it('compares the roots in one spelling: a relinked directory between /tmp/{userId} and the working directory refuses, whichever alias each root is written in (review R2)', () => {
    // `/tmp` and `/private/tmp` name one directory; the builder writes the user
    // root one way and keeps the working directory as given.
    const real = path.join(SCRATCH, 'alias-real');
    const alias = path.join(SCRATCH, 'alias-tmp');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, alias); // a system link above the roots
    for (const [i, cwdBase, userBase] of [
      [1, real, alias],
      [2, alias, real],
    ] as const) {
      fs.mkdirSync(path.join(real, `u${i}`, 'parent', 'session'), { recursive: true });
      const away = path.join(OUTSIDE, `away-${i}`);
      fs.mkdirSync(path.join(away, 'session'), { recursive: true });
      const cwd = path.join(cwdBase, `u${i}`, 'parent', 'session');
      const roots = [cwd, path.join(userBase, `u${i}`)];
      const target = { file_path: path.join(away, 'session', 'secret.json') };
      expect(createNativeWriteCheck(roots, cwd)('Write', target)).toMatch(/lands outside/);
      fs.renameSync(path.join(real, `u${i}`, 'parent'), path.join(real, `u${i}`, 'parent-old'));
      fs.symlinkSync(away, path.join(real, `u${i}`, 'parent'));
      expect(createNativeWriteCheck(roots, cwd)('Write', target)).toMatch(/cannot be trusted/);
      // nothing is written until the roots are restored, the user root included
      expect(createNativeWriteCheck(roots, cwd)('Write', { file_path: path.join(real, `u${i}`, 'ok.txt') })).toMatch(
        /cannot be trusted/,
      );
    }
  });

  it('refuses every write once a root is relinked, including a root reached through it: the sandbox lets the session replace /tmp/{userId} itself (review R3)', () => {
    // The sandbox allows writes to the subpath of /tmp/{userId}, the directory's own
    // name included, so the session can remove it and put a symbolic link there.
    const user = path.join(SCRATCH, 'r3-user');
    const cwd = path.join(user, 'session');
    fs.mkdirSync(cwd, { recursive: true });
    const away = path.join(OUTSIDE, 'r3-away');
    fs.mkdirSync(path.join(away, 'session'), { recursive: true });
    const roots = [cwd, user];
    const target = { file_path: path.join(away, 'session', 'x.json') };
    expect(createNativeWriteCheck(roots, cwd)('Write', target)).toMatch(/lands outside/);
    fs.renameSync(user, `${user}-old`);
    fs.symlinkSync(away, user);
    const relinked = createNativeWriteCheck(roots, cwd);
    expect(relinked('Write', target)).toMatch(/cannot be trusted/);
    expect(relinked('Write', { file_path: path.join(cwd, 'x.json') })).toMatch(/cannot be trusted/);
    expect(relinked('Write', { file_path: 'x.json' })).toMatch(/cannot be trusted/);
  });

  const caseInsensitive = SCRATCH !== SCRATCH.toUpperCase() && fs.existsSync(SCRATCH.toUpperCase());
  it.runIf(caseInsensitive)('compares the roots in the file system’s spelling of case as well (review R2)', () => {
    const user = path.join(SCRATCH, 'CaseUser');
    fs.mkdirSync(path.join(user, 'parent', 'session'), { recursive: true });
    const away = path.join(OUTSIDE, 'away-case');
    fs.mkdirSync(path.join(away, 'session'), { recursive: true });
    const cwd = path.join(SCRATCH, 'caseuser', 'parent', 'session');
    const roots = [cwd, user];
    fs.renameSync(path.join(user, 'parent'), path.join(user, 'parent-old'));
    fs.symlinkSync(away, path.join(user, 'parent'));
    expect(createNativeWriteCheck(roots, cwd)('Write', { file_path: path.join(away, 'session', 'x.json') })).toMatch(
      /cannot be trusted/,
    );
  });

  it('reads a path the way the SDK does: surrounding white space trimmed, `~` expanded (review R2)', () => {
    expect(write(` ${path.join(OUTSIDE, 'secret.json')}`)).toMatch(/lands outside/);
    expect(write(`${path.join(OUTSIDE, 'secret.json')}\n`)).toMatch(/lands outside/);
    // (the home directory is outside the roots; refused, whatever it is)
    expect(write('~/.soma-boundary-test.json')).not.toBeNull();
    expect(write('~')).not.toBeNull();
    expect(write('   ')).toMatch(/names no target/);
    expect(write(`${path.join(ROOT, 'repo')}/x\u0000.txt`)).toMatch(/NUL/);
    // inside stays inside, however it is spelled
    expect(write(` ${path.join(ROOT, 'repo', 'a.txt')} `)).toBeNull();
    expect(write(path.join(ROOT, 'repo', 'cafe\u0301.txt'))).toBeNull();
  });

  it('refuses a dangling symbolic link on the way: the write would create its target', () => {
    fs.symlinkSync(path.join(OUTSIDE, 'not-yet.json'), path.join(ROOT, 'dangling'));
    expect(write(path.join(ROOT, 'dangling'))).toMatch(/symbolic link to a missing target/);
    fs.symlinkSync(path.join(OUTSIDE, 'not-yet-dir'), path.join(ROOT, 'dangling-dir'));
    expect(write(path.join(ROOT, 'dangling-dir', 'x.json'))).toMatch(/symbolic link to a missing target/);
  });

  it('refuses `..`, which the OS climbs from a symbolic link target', () => {
    expect(write(path.join(ROOT, 'repo') + '/../repo/a.txt')).toMatch(/`\.\.` is not allowed/);
    expect(write('../repo/a.txt')).toMatch(/`\.\.` is not allowed/);
  });

  it('refuses a file with another hard link: writing it changes a file elsewhere', () => {
    fs.linkSync(path.join(OUTSIDE, 'secret.json'), path.join(ROOT, 'hard.json'));
    expect(write(path.join(ROOT, 'hard.json'))).toMatch(/2 hard links/);
  });

  it('refuses a call without a usable target, and has no opinion on other tools', () => {
    expect(write(undefined)).toMatch(/names no target/);
    expect(write('')).toMatch(/names no target/);
    expect(write(7)).toMatch(/names no target/);
    expect(check('NotebookEdit', { file_path: path.join(ROOT, 'n.ipynb') })).toMatch(
      /names no target \(notebook_path\)/,
    );
    expect(check('Read', { file_path: '/etc/hosts' })).toBeNull();
    expect(NATIVE_WRITE_TOOLS).toEqual(['Write', 'Edit', 'NotebookEdit', 'Artifact', 'EnterWorktree', 'Agent']);
  });

  it('Artifact saves into its scratchpad only: any out_dir is refused, whatever the action (review R1, R2)', () => {
    // read_asset, read_file and read_db save under out_dir names the server picks
    // (asset id + extension, published path, collection / document id), which a
    // check before the call cannot see, so out_dir is not offered at all.
    const artifact = (input: Record<string, unknown>) => check('Artifact', input);
    for (const action of ['read_asset', 'read_file', 'read_db', undefined]) {
      for (const out_dir of [OUTSIDE, ` ${OUTSIDE}`, '~/assets', path.join(ROOT, 'assets'), 7]) {
        expect(artifact({ action, url: 'u', asset_id: 'a', path: 'p', out_dir })).toMatch(/out_dir/);
      }
    }
    expect(artifact({ action: 'read_asset', url: 'u', asset_id: 'a' })).toBeNull();
    expect(artifact({ action: 'read_file', url: 'u', path: 'index.html' })).toBeNull();
    expect(artifact({ file_path: '/etc/hosts' })).toBeNull(); // publish reads the file
    expect(artifact({ action: 'upload_asset', url: 'u', file_path: '/etc/hosts' })).toBeNull();
  });

  it("a new git worktree goes under the repository's .claude/worktrees: held to the roots (review R1)", () => {
    const repo = path.join(ROOT, 'wt-repo');
    fs.mkdirSync(repo, { recursive: true });
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    const inRepo = createNativeWriteCheck([ROOT], repo);
    expect(inRepo('EnterWorktree', { name: 'feat' })).toBeNull();
    expect(inRepo('EnterWorktree', {})).toBeNull();
    expect(inRepo('Agent', { description: 'd', prompt: 'p', isolation: 'worktree' })).toBeNull();
    expect(inRepo('EnterWorktree', { name: '../../escape' })).toMatch(/`\.\.` is not allowed/);
    // a symbolic link where the SDK puts worktrees would put the checkout outside
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(repo, '.claude', 'worktrees'));
    expect(inRepo('EnterWorktree', { name: 'feat' })).toMatch(/lands outside/);
    expect(inRepo('Agent', { description: 'd', prompt: 'p', isolation: 'worktree' })).toMatch(/lands outside/);
    // switching into a worktree inside the roots, a plain subagent, and no repository write nothing
    expect(inRepo('EnterWorktree', { path: path.join(repo, 'x') })).toBeNull();
    expect(inRepo('Agent', { description: 'd', prompt: 'p' })).toBeNull();
    expect(createNativeWriteCheck([ROOT], OUTSIDE)('EnterWorktree', { name: 'feat' })).toBeNull();
  }, 30_000); // git processes: slow on a loaded runner

  it('a session never moves its working directory outside the roots: EnterWorktree `path`, Agent `cwd` (self-check before review R2)', () => {
    // The SDK sandbox lets Bash write the session's current directory, so the
    // directory a switch lands in is one Bash writes next. The SDK lists any
    // worktree `git worktree list` names, and the session owns its repository's
    // registrations, so it could list a directory outside its roots.
    const repo = path.join(ROOT, 'wt-switch');
    fs.mkdirSync(path.join(repo, '.claude', 'worktrees', 'feat'), { recursive: true });
    const inRepo = createNativeWriteCheck([ROOT], repo);
    expect(inRepo('EnterWorktree', { path: path.join(repo, '.claude', 'worktrees', 'feat') })).toBeNull();
    expect(inRepo('EnterWorktree', { path: '.claude/worktrees/feat' })).toBeNull();
    expect(inRepo('EnterWorktree', { path: OUTSIDE })).toMatch(/lands outside/);
    expect(inRepo('EnterWorktree', { path: '' })).toMatch(/names no target/);
    // an Agent `cwd` (in the CLI's schema, not yet in the public one) is the subagent's working directory
    expect(inRepo('Agent', { description: 'd', prompt: 'p', cwd: OUTSIDE })).toMatch(/lands outside/);
    expect(inRepo('Agent', { description: 'd', prompt: 'p', cwd: repo })).toBeNull();
  });

  it('a new worktree from a linked worktree goes under the main repository: both are held to the roots (self-check before review R2)', () => {
    // The main repository outside the roots, a linked worktree of it inside them.
    const main = path.join(OUTSIDE, 'main-repo');
    fs.mkdirSync(main, { recursive: true });
    const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    expect(git(main, 'init', '-q').status).toBe(0);
    expect(
      git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init').status,
    ).toBe(0);
    const linked = path.join(ROOT, 'linked-wt');
    expect(git(main, 'worktree', 'add', '-q', '--detach', linked).status).toBe(0);
    const fromLinked = createNativeWriteCheck([ROOT], linked);
    expect(fromLinked('EnterWorktree', { name: 'feat' })).toMatch(/lands outside/);
    expect(fromLinked('Agent', { description: 'd', prompt: 'p', isolation: 'worktree' })).toMatch(/lands outside/);
    // a linked worktree of a repository inside the roots stays allowed
    const inner = path.join(ROOT, 'inner-repo');
    fs.mkdirSync(inner, { recursive: true });
    expect(git(inner, 'init', '-q').status).toBe(0);
    expect(
      git(inner, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init').status,
    ).toBe(0);
    const innerLinked = path.join(inner, '.claude', 'worktrees', 'one');
    expect(git(inner, 'worktree', 'add', '-q', '--detach', innerLinked).status).toBe(0);
    expect(createNativeWriteCheck([ROOT], innerLinked)('EnterWorktree', { name: 'two' })).toBeNull();
  }, 30_000); // several git processes: slow on a loaded runner

  it('with no roots, refuses every write', () => {
    expect(createNativeWriteCheck([], ROOT)('Write', { file_path: path.join(ROOT, 'x') })).toMatch(/\(none\)/);
  });
});

function ctx(overrides: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return {
    user: 'U0BOUNDARY',
    isAdmin: false,
    mode: 'bypass',
    aborted: false,
    isDangerousRuleDisabled: () => false,
    checkMcpToolPermission: () => null,
    checkNativeWrite: check,
    ...overrides,
  };
}

describe('evaluateToolPolicy — step 3b, the native write boundary', () => {
  const outsideWrite = { file_path: path.join(OUTSIDE, 'secret.json') };

  it('denies a non-admin native write outside the roots in every mode, and tells the model why', () => {
    for (const mode of ['bypass', 'auto', 'legacy'] as const) {
      const outsideInputs: Record<string, Record<string, unknown>> = {
        Write: outsideWrite,
        Edit: outsideWrite,
        NotebookEdit: { notebook_path: outsideWrite.file_path },
        Artifact: { action: 'read_asset', url: 'u', asset_id: 'a', out_dir: OUTSIDE },
      };
      for (const [tool, input] of Object.entries(outsideInputs)) {
        const r = evaluateToolPolicy(tool, input, ctx({ mode }));
        expect(r.decision).toBe('deny');
        expect(r.reason).toMatch(/^write-boundary: /);
        expect(r.denyMessage).toMatch(tool === 'Artifact' ? /cannot save to out_dir/ : /lands outside/);
      }
    }
  });

  it('lets a non-admin native write inside the roots through to the mode tier', () => {
    expect(evaluateToolPolicy('Write', { file_path: path.join(ROOT, 'ok.txt') }, ctx()).decision).toBe('allow');
    expect(
      evaluateToolPolicy('Write', { file_path: path.join(ROOT, 'ok.txt') }, ctx({ mode: 'legacy' })).decision,
    ).toBe('pass');
  });

  it('exempts admins, and asks nothing of a session without a boundary or of another tool', () => {
    const spy = vi.fn(() => 'outside');
    expect(evaluateToolPolicy('Write', outsideWrite, ctx({ isAdmin: true, checkNativeWrite: spy })).decision).toBe(
      'allow',
    );
    expect(evaluateToolPolicy('Write', outsideWrite, ctx({ checkNativeWrite: undefined })).decision).toBe('allow');
    for (const tool of ['Read', 'Bash', 'Glob', 'TodoWrite', 'mcp__x__write', 'MultiEdit', 'write']) {
      evaluateToolPolicy(tool, outsideWrite, ctx({ checkNativeWrite: spy }));
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies to an admin in an incident session, before the incident tier', () => {
    const r = evaluateToolPolicy(
      'Write',
      outsideWrite,
      ctx({ isAdmin: true, incidentReadOnly: { allowedMcpTools: ['mcp__incident_evidence__collect'] } }),
    );
    expect(r.reason).toMatch(/^write-boundary: /);
  });
});

// ── End to end: the hook `buildStreamOptions` registers, as the SDK calls it ──

const SESSION_USER = 'U0BOUNDARY';

function deps(): BuildStreamOptionsDeps {
  const mcpConfig: McpConfig = {
    permissionMode: 'bypassPermissions',
    userBypass: true,
    somaPermissionMode: 'auto',
    allowDangerouslySkipPermissions: true,
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
    permissionPromptToolName: undefined,
  } as unknown as McpConfig;
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getEffectivePluginPaths: () => [],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: { buildConfig: vi.fn(async () => mcpConfig) },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'PROMPT') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => 'chan:thread'),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
    } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    checkMcpToolPermission: vi.fn(() => null),
  } as unknown as BuildStreamOptionsDeps;
}

const slack = { user: SESSION_USER, channel: 'C123', threadTs: '1700000000.0001' } as SlackContext;

async function writeHook(workingDirectory: string) {
  const { options } = await buildStreamOptions({ queryEnv: {}, workingDirectory, slackContext: slack }, deps());
  // every matcher entry carries the same policy hook
  const entry = (options.hooks?.PreToolUse ?? [])[0];
  const hook = (entry as { hooks: Array<(input: unknown) => Promise<unknown>> }).hooks[0];
  return {
    options,
    call: (tool_name: string, tool_input: Record<string, unknown>) =>
      hook({ hook_event_name: 'PreToolUse', tool_name, tool_input }) as Promise<{
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      }>,
  };
}

describe('buildStreamOptions — a non-admin session with the sandbox on', () => {
  it('denies a native Write into the data directory (the shared project memory)', async () => {
    const { call } = await writeHook(path.join(ROOT, 'repo'));
    const out = await call('Write', { file_path: path.join(DATA_DIR, 'project-memory.json'), content: '{}' });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/lands outside/);
    const edit = await call('Edit', { file_path: path.join(OUTSIDE, 'secret.json'), old_string: '{', new_string: '[' });
    expect(edit.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('still denies the data-directory Write after the session links its working directory there (review R1)', async () => {
    const userDir = path.join(SCRATCH, 'e2e-user');
    const cwd = path.join(userDir, 'session_1');
    fs.mkdirSync(cwd, { recursive: true });
    const { call } = await writeHook(cwd);
    const target = { file_path: path.join(DATA_DIR, 'project-memory.json'), content: '{}' };
    expect((await call('Write', target)).hookSpecificOutput?.permissionDecision).toBe('deny');
    fs.renameSync(cwd, `${cwd}-old`); // what the session's own Bash may do inside /tmp/{userId}
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.symlinkSync(DATA_DIR, cwd);
    expect((await call('Write', target)).hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  const tmpAliased = fs.realpathSync('/tmp') !== '/tmp';
  it.runIf(tmpAliased)(
    'still denies after a relink when the working directory is spelled /private/tmp and the user root /tmp (review R2)',
    async () => {
      const realUser = path.join(fs.realpathSync('/tmp'), SESSION_USER);
      const parent = path.join(realUser, `r2-parent-${process.pid}`);
      const cwd = path.join(parent, 'session');
      fs.mkdirSync(cwd, { recursive: true });
      const away = path.join(OUTSIDE, 'e2e-away');
      fs.mkdirSync(path.join(away, 'session'), { recursive: true });
      try {
        const { call } = await writeHook(cwd);
        const target = { file_path: path.join(away, 'session', 'secret.json'), content: '{}' };
        expect((await call('Write', target)).hookSpecificOutput?.permissionDecision).toBe('deny');
        fs.renameSync(parent, `${parent}-old`);
        fs.symlinkSync(away, parent);
        expect((await call('Write', target)).hookSpecificOutput?.permissionDecision).toBe('deny');
        const inUser = await call('Write', { file_path: path.join(realUser, 'ok.txt'), content: 'x' });
        expect(inUser.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(inUser.hookSpecificOutput?.permissionDecisionReason).toMatch(/cannot be trusted/);
      } finally {
        fs.rmSync(parent, { force: true });
        fs.rmSync(`${parent}-old`, { recursive: true, force: true });
      }
    },
  );

  it('denies an Artifact read_asset into the data directory, and hooks the write tools outside NATIVE_BYPASS_TOOLS', async () => {
    const { call, options } = await writeHook(path.join(ROOT, 'repo'));
    const out = await call('Artifact', { action: 'read_asset', url: 'u', asset_id: 'a', out_dir: DATA_DIR });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    const matchers = (options.hooks?.PreToolUse ?? []).map((e) => (e as { matcher?: string }).matcher ?? '');
    for (const tool of NATIVE_WRITE_TOOLS) {
      expect(matchers.some((m) => m.split('|').includes(tool))).toBe(true);
    }
  });

  it('allows a native Write in the working directory and in /tmp/{userId}', async () => {
    const { call } = await writeHook(path.join(ROOT, 'repo'));
    for (const file_path of [path.join(ROOT, 'repo', 'out.txt'), `/tmp/${SESSION_USER}/session_x/out.txt`]) {
      const out = await call('Write', { file_path, content: 'x' });
      expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
    }
  });

  it('keeps plan files inside the working directory, where the boundary lets plan mode write them', async () => {
    const { options } = await writeHook(path.join(ROOT, 'repo'));
    expect((options.settings as { plansDirectory?: string } | undefined)?.plansDirectory).toBe('.claude/plans');
  });

  it('leaves native writes unconfined when an admin turned the sandbox off, as its Bash is', async () => {
    const spy = vi.spyOn(await import('../../user-settings-store'), 'userSettingsStore', 'get').mockReturnValue({
      getUserDefaultModel: () => 'm',
      getUserThinkingEnabled: () => true,
      getUserShowThinking: () => false,
      getUserSandboxDisabled: () => true,
      getUserNetworkDisabled: () => false,
    } as never);
    try {
      const { call, options } = await writeHook(path.join(ROOT, 'repo'));
      expect(options.sandbox).toBeUndefined();
      const out = await call('Write', { file_path: path.join(OUTSIDE, 'secret.json'), content: '{}' });
      expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
    } finally {
      spy.mockRestore();
    }
  });
});

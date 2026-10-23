/**
 * Native write boundary (`policy/native-write-boundary.ts`, `evaluateToolPolicy` step 3b).
 *
 * The SDK sandbox confines Bash to the working directory and `/tmp/{userId}`;
 * the native `Write` / `Edit` / `NotebookEdit` run in the SDK process, outside
 * it. Before the boundary a non-admin session could write the data directory
 * (every user's memory, the shared project memory), `.env` or the installed
 * code with a plain `Write` — the review finding this suite reproduces first.
 */

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

  it('allows a root reached through a symbolic link, and a link that stays inside', () => {
    const alias = path.join(SCRATCH, 'root-alias');
    fs.symlinkSync(ROOT, alias);
    expect(createNativeWriteCheck([alias], ROOT)('Write', { file_path: path.join(ROOT, 'x.txt') })).toBeNull();
    expect(write(path.join(alias, 'repo', 'a.txt'))).toBeNull();
    fs.symlinkSync(path.join(ROOT, 'repo'), path.join(ROOT, 'repo-alias'));
    expect(write(path.join(ROOT, 'repo-alias', 'a.txt'))).toBeNull();
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
    expect(NATIVE_WRITE_TOOLS).toEqual(['Write', 'Edit', 'NotebookEdit']);
  });

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
      for (const tool of NATIVE_WRITE_TOOLS) {
        const input = tool === 'NotebookEdit' ? { notebook_path: outsideWrite.file_path } : outsideWrite;
        const r = evaluateToolPolicy(tool, input, ctx({ mode }));
        expect(r.decision).toBe('deny');
        expect(r.reason).toMatch(/^write-boundary: /);
        expect(r.denyMessage).toMatch(/lands outside/);
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
  const entry = (options.hooks?.PreToolUse ?? []).find((e) => (e as { matcher?: string }).matcher?.includes('Write'));
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

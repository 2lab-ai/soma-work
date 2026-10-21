import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * The todo-guard is gone — permanently.
 *
 * It was a PreToolUse hook that hard-blocked the 5th task-less tool call with
 * "Detected 5 or more tool calls without TodoWrite/TaskCreate/TaskUpdate".
 * In practice it fired mid-task on read-only exploration and turned a working
 * session into a deadlock, so it was removed from both implementations (the
 * standalone shell guard shipped in the zworkflow plugin and the Fastify hook
 * service). This test keeps it from being reintroduced.
 */
describe('todo-guard is fully removed', () => {
  const removedFiles = [
    'src/local/hooks/todo-guard.sh',
    'src/local/hooks/todo-guard.test.sh',
    'src/local/hooks/todo-guard-cleanup.sh',
    'src/hooks/todo-guard.ts',
    'src/hooks/__tests__/todo-guard.test.ts',
  ];

  it.each(removedFiles)('does not reintroduce %s', (relPath) => {
    expect(fs.existsSync(path.join(repoRoot, relPath)), `${relPath} must stay deleted`).toBe(false);
  });

  it('leaves no todo-guard reference in the hook sources', () => {
    const dirs = ['src/hooks', 'src/local/hooks'];
    const offenders: string[] = [];

    for (const dir of dirs) {
      const abs = path.join(repoRoot, dir);
      for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        const filePath = path.join(entry.parentPath ?? abs, entry.name);
        const source = fs.readFileSync(filePath, 'utf-8');
        if (/todo[-_]?guard/i.test(source)) {
          offenders.push(path.relative(repoRoot, filePath));
        }
      }
    }

    expect(offenders, `todo-guard references found in: ${offenders.join(', ')}`).toEqual([]);
  });

  // ── Behavioral: the standalone plugin hook never blocks ──

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-todo-guard-'));

  afterAll(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('lets an unlimited run of task-less tool calls through hook-proxy.sh', () => {
    const proxy = path.join(repoRoot, 'src/local/hooks/hook-proxy.sh');
    const input = JSON.stringify({
      session_id: 'no-todo-guard-session',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    });

    // 10 calls: double the old hard-block threshold of 5, with no TodoWrite in
    // between. Every one must pass (exit 0); the old guard exited 2 at call 5.
    for (let i = 0; i < 10; i++) {
      const stdout = execFileSync('bash', [proxy, 'pre_tool_use'], {
        input,
        encoding: 'utf-8',
        // Standalone mode (no soma-work service): HOOKS_PROXY_ENABLED unset.
        env: { ...process.env, HOOKS_PROXY_ENABLED: 'false', TMPDIR: stateDir },
      });
      // A non-blocking guard warning would surface as additionalContext JSON.
      expect(stdout).not.toMatch(/additionalContext/);
    }
  });
});

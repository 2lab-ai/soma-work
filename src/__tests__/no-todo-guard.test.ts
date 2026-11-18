import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * The plugin hooks never block a run of task-less tool calls (#174).
 *
 * The todo-guard was a PreToolUse hook that hard-blocked the 5th task-less tool
 * call with "Detected 5 or more tool calls without TodoWrite/TaskCreate/TaskUpdate".
 * In practice it fired mid-task on read-only exploration and turned a working
 * session into a deadlock, so it was removed. This test keeps that deadlock from
 * coming back through the standalone plugin hook.
 */
describe('the standalone plugin hook never blocks task-less tool calls (#174)', () => {
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

/**
 * Policy step 2 (the ssh ban, every user since env-access WU2 #1210) asks whether a Bash command runs ssh,
 * scp or sftp. The old check matched the word anywhere — a grep pattern, a commit message, a document written
 * through a heredoc — and since WU2 that refusal reaches admins too. This one looks at what runs.
 */

import { isSshCommand } from 'soma-lib';
import { describe, expect, it } from 'vitest';
import { isRemoteShellCommand } from '../remote-shell-command';

const RUNS = [
  'ssh host',
  'ssh -i key host ls',
  '/usr/bin/ssh host uptime',
  'sudo ssh host',
  'env A=1 ssh host',
  'FOO=1 BAR=2 ssh host',
  'timeout 5 ssh host',
  'nohup ssh host &',
  'cd x && ssh host',
  'echo a | ssh host cat',
  'true; scp a host:b',
  'sftp host',
  'bash -c "ssh host"',
  "sh -c 'scp a host:b'",
  'zsh -lc "ssh host"',
  'eval "ssh host"',
  'echo "$(ssh host)"',
  'echo `ssh host`',
  'x=$(ssh host uptime)',
  'rsync -e ssh a host:b',
  'rsync -av --rsh=ssh a host:b',
  'find . -name x -exec scp {} host: \\;',
  'xargs ssh host < hosts',
  'if true; then ssh host; fi',
  'command ssh host',
  'exec ssh host',
  'ssh prod-host',
  // An interpreter or an unknown program keeps the old, broad check: it may start ssh itself.
  `python3 -c "import os; os.system('ssh host')"`,
  "node -e \"require('child_process').execSync('ssh host')\"",
  'awk \'BEGIN { system("ssh host") }\'',
  'python3 - <<EOF\nimport os\nos.system("ssh host")\nEOF',
  'bash <<EOF\nssh host\nEOF',
];

const DATA = [
  'grep -rn ssh src',
  "rg '\\bssh\\b' src",
  'git commit -m "ssh ban for everyone"',
  'git log --grep ssh',
  'git commit -F msg.txt && git push origin main',
  "cat > notes.md <<'EOF'\nBash ssh is blocked; use ssh_exec\nEOF",
  'echo "use ssh_exec instead of ssh"',
  "printf 'ssh\\n'",
  'gh pr create --title "ssh ban" --body "scp too"',
  'gh issue comment 1 --body-file - <<EOF\nssh is refused\nEOF',
  'ls ~/.ssh',
  'which ssh',
  'type ssh',
  'man ssh',
  'git clone git@github.com:o/r.git',
  'head -3 docs/ssh.md | wc -l',
];

/** Programs that can start another (GNU sed's `e`, awk's `system`) keep the old check even on data. */
const CONSERVATIVE = ['sed -n 1,5p ssh.md', "awk '{print}' ssh.log"];

describe('isRemoteShellCommand', () => {
  it.each(CONSERVATIVE)('keeps the old check where a program can start another: %s', (command) => {
    expect(isRemoteShellCommand(command)).toBe(true);
  });

  it.each(RUNS)('runs a remote shell: %s', (command) => {
    expect(isRemoteShellCommand(command)).toBe(true);
  });

  it.each(DATA)('only mentions it: %s', (command) => {
    expect(isRemoteShellCommand(command)).toBe(false);
  });

  it('never refuses what the old check let through', () => {
    for (const command of [...RUNS, ...DATA, 'ls -la', 'git push', 'echo hi', 's"s"h host']) {
      if (!isSshCommand(command)) expect(isRemoteShellCommand(command), command).toBe(false);
    }
  });

  it('keeps every command the old check refused that runs ssh, scp or sftp', () => {
    for (const command of RUNS) expect(isSshCommand(command), command).toBe(true);
  });
});

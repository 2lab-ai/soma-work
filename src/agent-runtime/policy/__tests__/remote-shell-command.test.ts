/**
 * Policy step 2 (the ssh ban, every user since env-access WU2 #1210) asks whether a Bash command runs ssh,
 * scp or sftp. The old check matched the word anywhere — a grep pattern, a commit message, a document written
 * through a heredoc — and since WU2 that refusal reaches admins too. This one lets a command through only when
 * every program in it handles the word as data.
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
  'time ssh host',
  '( ssh host )',
  // An interpreter or an unknown program could start it.
  `python3 -c "import os; os.system('ssh host')"`,
  "node -e \"require('child_process').execSync('ssh host')\"",
  'awk \'BEGIN { system("ssh host") }\'',
  'python3 - <<EOF\nimport os\nos.system("ssh host")\nEOF',
  'bash <<EOF\nssh host\nEOF',
  'bash <<< "ssh host"',
  'bash <(echo ssh host)',
  // trinity R1 (fable): an unquoted heredoc expands its substitutions.
  'cat <<EOF\n$(ssh host uname)\nEOF',
  'cat <<EOF\n`ssh host uname`\nEOF',
  // A shell or another program reading the word from a pipe, a file, a fifo or a process substitution.
  'echo ssh host | bash',
  'cat <<EOF | bash\nssh host\nEOF',
  'echo ssh host | (bash)',
  'echo ssh host | { bash; }',
  'echo ssh host |& sh',
  'echo ssh host | tee >(bash)',
  'echo "ssh host" > run.sh && bash run.sh',
  'mkfifo p; bash < p & echo ssh host > p',
  'echo ssh host | xargs -I{} sh -c {}',
  // rsync and environment that names it.
  'rsync -avze ssh a host:b',
  'RSYNC_RSH=ssh rsync a host:b',
  "GIT_PAGER='ssh host' git log",
  "GIT_SSH_COMMAND='ssh -i k' git push",
  "x='ssh host'; $x",
  // git and gh subcommands that run programs.
  "git rebase --exec 'ssh host make' main",
  "git -c alias.x='!ssh host' x",
  "git -c core.pager='ssh host' log",
  "git grep --open-files-in-pager='ssh host' x",
  'git push ssh://host/repo main',
  'gh codespace ssh',
  "gh alias set x '!ssh host'",
  // A heredoc delimiter in pieces ends where the shell ends it.
  'cat <<E"O"F\nx\nEOF\nssh host',
  "cat <<'E'OF\nx\nEOF\nssh host",
  // Substitution inside arithmetic-looking text, ANSI-C quoting, wrapper options.
  'echo "$((ssh host) )"',
  'echo $(( $(ssh host) ))',
  "echo $'\\'' ; ssh host",
  'sudo --user git ssh host',
  'exec -a git ssh host',
  // trinity R2 (fable): a `)` in a heredoc body or a comment does not close a substitution; nested backticks.
  'echo "$(cat <<\'EOF\'\n)\nEOF\nssh host)"',
  'echo "$(: # )\nssh host)"',
  'echo "$(echo ok # )\nssh host\n)"',
  'echo `echo \\`ssh host\\``',
  // A data program's name on a path, or reached through PATH or an expansion, could be anything.
  'ln -s /usr/bin/ssh ./cat && ./cat host',
  'PATH=.:$PATH cat ssh',
  "$(printf 'ssh host ')echo",
  // Data programs told to run a program.
  'rg --pre ssh pattern dir',
  "man -P 'ssh host' ls",
  "sort --compress-program='ssh host' big",
  "ag --pager 'ssh host' x",
  "git grep -nO'ssh host' x",
  "git -cdiff.external='ssh host' diff --ext-diff",
  // zsh's short `if`, and redirections around the program (trinity R1, astra).
  'if [[ -n x ]] ssh host',
  '>echo ssh host',
  '2>/dev/null ssh host',
  '> >(true) ssh echo hi',
  'cat <<< ssh\nssh host',
  "cat <<$'EOF'\ntext\nEOF\nssh host",
  // trinity R3 (astra): an expansion where a program or setting is named; heredoc scope; escaped delimiter.
  `git -c diff.external="$(printf 'ssh host')" diff --ext-diff`,
  "rg $(printf -- '--pre=ssh') pattern host",
  `GIT_PAGER="$(printf 'ssh host')" git log`,
  "find . $(printf -- '-exec') ssh host \\;",
  `cat <<'EOF' "$(echo ok\nssh host\n)"\ntext\nEOF`,
  'cat <<"E\\\\OF"\ntext\nE\\OF\nssh host',
  // trinity R3 (fable, P2): a quote inside `${…}`, zsh `always`, more run options.
  `echo "\${x:-it's}"; ssh host; echo 'a}'`,
  '{ echo a } always { ssh host }',
  "ack --pager='ssh host' x",
  'rg --hostname-bin ssh x',
  // trinity R4 (astra, P2): line continuations in a delimiter and in an unquoted heredoc body.
  // A trusted variable the command itself sets is not trusted.
  'HOME=--pre=x; rg ssh "$HOME"',
  'read HOME; rg ssh $HOME',
  'x=--pre=x; rg ssh "$x"',
  'dir=-exec; find "$dir" ssh host \\;',
  'LC_ALL=$(printf x) grep ssh x',
  'cat <<"E\\\nOF"\ntext\nEOF\nssh host',
  'cat <<E\\\nOF\ntext\nEOF\nssh host',
  'cat <<EOF\nEO\\\nF\nssh host',
];

const DATA = [
  'grep -rn ssh src',
  "rg '\\bssh\\b' src",
  'git commit -m "ssh ban for everyone"',
  'git log --grep ssh',
  'git log --grep=ssh --oneline | grep -i ssh',
  'git commit -F msg.txt && git push origin main',
  'git add -A && git commit -m "ssh ban" && git push',
  'git -C repo show HEAD:src/ssh.ts',
  "cat > notes.md <<'EOF'\nBash ssh is blocked; use ssh_exec\nEOF",
  'cat <<-EOF > notes.md\n\tssh is text, $(date) is not ssh\n\tEOF',
  'echo "use ssh_exec instead of ssh"',
  'echo "ssh $((1+2))"',
  "printf 'ssh\\n'",
  'gh pr create --title "ssh ban" --body "scp too"',
  'gh -R o/r pr view 1 --json body | jq .body',
  'gh api repos/o/r/issues -f body="ssh"',
  'gh issue comment 1 --body-file - <<EOF\nssh is refused\nEOF',
  'ls ~/.ssh',
  'which ssh',
  'type ssh',
  'man ssh',
  'command -v ssh',
  'git clone git@github.com:o/r.git',
  'head -3 docs/ssh.md | wc -l',
  'grep -rn ssh src 2>&1 | head -20',
  'rg ssh src &> out.txt',
  'grep ssh <<< "ssh host"',
  'diff <(echo ssh) <(echo scp)',
  'grep -n \\\n  ssh src',
  'grep ssh x # ssh in a comment',
  'if grep -q ssh x; then echo found; fi',
  'echo "$(date): ssh"',
  // A commit message or PR body through a heredoc in `$(…)`, with an apostrophe in it (trinity R2, fable).
  "git commit -m \"$(cat <<'EOF'\nfix: don't refuse ssh mentions\nEOF\n)\"",
  "gh pr create --body \"$(cat <<'EOF'\nit's about ssh (and scp)\nEOF\n)\"",
  'echo ssh > out.txt 2>&1',
  'grep ssh x >> log.txt',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
  'echo "${HOME}/ssh"',
  'cat <<< "ssh host"',
  // The bot's own absolute paths, and locale settings (trinity R5, fable P2).
  'rg -n ssh "$HOME/x"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
  'rg -n ssh ${HOME}/x',
  'find "$PWD" -name "*ssh*"',
  'grep -rn ssh "$TMPDIR"',
  'LC_ALL=C grep ssh x',
  // trinity R5 (grok): harmless settings in front of a data program.
  'LC_ALL=C grep -n ssh src',
  'GIT_OPTIONAL_LOCKS=0 git commit -m "ssh ban"',
  'GIT_AUTHOR_NAME=bot GIT_AUTHOR_EMAIL=b@x git commit -m "ssh"',
];

/**
 * Still refused: a program that can start another (GNU sed's `e`, awk's `system`, an unknown tool) anywhere in a
 * command that names the word, even when this use is harmless.
 */
const CONSERVATIVE = [
  'sed -n 1,5p ssh.md',
  "awk '{print}' ssh.log",
  'npx vitest run src/ssh.test.ts',
  'npm test && git commit -m "ssh ban"',
  'find . -name "*ssh*" -exec cat {} \\;',
  'git config core.sshCommand "ssh -i k"',
  // An environment for a data program can make it run another (`RIPGREP_CONFIG_PATH`, `GIT_PAGER` …).
  'GIT_EDITOR=vi git commit -m "ssh"',
  'RIPGREP_CONFIG_PATH=./rc rg ssh x',
  // A variable set in the command could be anything.
  'dir=src; find "$dir" -name "*ssh*"',
];

describe('isRemoteShellCommand', () => {
  it.each(CONSERVATIVE)('keeps the old check where a program could run the word: %s', (command) => {
    expect(isRemoteShellCommand(command)).toBe(true);
  });

  it.each(RUNS)('runs a remote shell: %s', (command) => {
    expect(isRemoteShellCommand(command)).toBe(true);
  });

  it.each(DATA)('only mentions it: %s', (command) => {
    expect(isRemoteShellCommand(command)).toBe(false);
  });

  it('never refuses what the old check let through', () => {
    for (const command of [...RUNS, ...DATA, ...CONSERVATIVE, 'ls -la', 'git push', 'echo hi', 's"s"h host']) {
      if (!isSshCommand(command)) expect(isRemoteShellCommand(command), command).toBe(false);
    }
  });

  it('refuses nesting too deep to read, without exhausting the stack', () => {
    const deep = `echo ssh ${'$(('.repeat(20000)}1${'))'.repeat(20000)}`;
    expect(isRemoteShellCommand(deep)).toBe(true);
    expect(isRemoteShellCommand(`echo ssh ${'$('.repeat(20000)}true${')'.repeat(20000)}`)).toBe(true);
  });

  it('keeps every command the old check refused that runs ssh, scp or sftp', () => {
    for (const command of RUNS) expect(isSshCommand(command), command).toBe(true);
  });
});

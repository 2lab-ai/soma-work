import { describe, expect, it } from 'vitest';
import {
  checkDangerousCommand,
  isCrossUserAccess,
  isDangerousCommand,
  isSshCommand,
} from './dangerous-command-filter';

describe('isDangerousCommand', () => {
  describe('detects dangerous patterns', () => {
    it.each([
      ['kill 1234', 'kill with PID'],
      ['kill -9 1234', 'kill with signal'],
      ['kill -SIGTERM 1234', 'kill with named signal'],
      ['sudo kill 1234', 'sudo kill'],
      ['pkill node', 'pkill'],
      ['killall python', 'killall'],
      ['rm -rf /tmp/dir', 'rm -rf'],
      ['rm -rf /', 'rm -rf root'],
      ['rm -f file.txt', 'rm -f'],
      ['rm -rfi dir/', 'rm with -r and -f combined'],
      ['rm --recursive dir/', 'rm --recursive'],
      ['shutdown now', 'shutdown'],
      ['sudo shutdown -h now', 'sudo shutdown'],
      ['reboot', 'reboot'],
      ['halt', 'halt'],
      ['mkfs.ext4 /dev/sda1', 'mkfs'],
      ['dd if=/dev/zero of=/dev/sda', 'dd with if='],
    ])('detects: %s (%s)', (command) => {
      expect(isDangerousCommand(command)).toBe(true);
    });
  });

  describe('allows safe patterns', () => {
    it.each([
      ['git status', 'git status'],
      ['npm install', 'npm install'],
      ['ls -la', 'ls'],
      ['cat file.txt', 'cat'],
      ['echo hello', 'echo'],
      ['mkdir -p dir', 'mkdir'],
      ['cp file1 file2', 'cp'],
      ['mv file1 file2', 'mv'],
      ['grep pattern file', 'grep'],
      ['ps aux', 'ps aux (no kill)'],
      ['rm file.txt', 'rm without -f or -r'],
      ['npm run build', 'npm build'],
      ['npx vitest', 'vitest'],
      ['git push origin main', 'git push'],
      ['chmod 644 file.txt', 'safe chmod'],
      ['dd --version', 'dd version (no if=)'],
    ])('allows: %s (%s)', (command) => {
      expect(isDangerousCommand(command)).toBe(false);
    });
  });
});

describe('isSshCommand', () => {
  describe('detects SSH patterns', () => {
    it.each([
      ['ssh dev2 docker ps', 'ssh command'],
      ['ssh user@host ls', 'ssh with user@host'],
      ['ssh -i key.pem host', 'ssh with identity file'],
      ['sudo ssh dev2 docker pull nginx', 'sudo ssh'],
      ['scp file.txt user@host:/tmp/', 'scp upload'],
      ['scp user@host:/tmp/file.txt .', 'scp download'],
      ['sftp user@host', 'sftp connection'],
      ['rsync -avz -e ssh ./dir user@host:/tmp/', 'rsync over ssh'],
      ['rsync -e "ssh -i key" src dest', 'rsync with ssh key'],
    ])('detects: %s (%s)', (command) => {
      expect(isSshCommand(command)).toBe(true);
    });
  });

  describe('allows non-SSH patterns', () => {
    it.each([
      ['git status', 'git status'],
      ['npm install', 'npm install'],
      ['ls -la', 'ls'],
      ['cat ssh_config', 'cat ssh_config file (ssh_ is not word boundary)'],
      ['docker ps', 'docker ps'],
      ['rsync -avz ./dir /tmp/', 'rsync without ssh'],
      ['grep sshd /var/log/syslog', 'grep sshd (not standalone ssh)'],
    ])('allows: %s (%s)', (command) => {
      expect(isSshCommand(command)).toBe(false);
    });
  });

  describe('conservative match — contains standalone ssh word', () => {
    it.each([
      ['echo "ssh is cool"', 'echo with ssh word'],
      ['cat ~/.ssh/config', 'path with /ssh/'],
    ])('matches: %s (%s)', (command) => {
      // \bssh\b matches standalone "ssh" even in strings — this is intentional
      expect(isSshCommand(command)).toBe(true);
    });
  });
});

describe('checkDangerousCommand', () => {
  it('returns matched pattern descriptions', () => {
    const result = checkDangerousCommand('kill -9 1234');
    expect(result.isDangerous).toBe(true);
    expect(result.matchedPatterns).toContain('kill process');
  });

  it('returns multiple matches for compound commands', () => {
    const result = checkDangerousCommand('kill 1234 && rm -rf /tmp');
    expect(result.isDangerous).toBe(true);
    expect(result.matchedPatterns).toContain('kill process');
    expect(result.matchedPatterns).toContain('recursive delete');
  });

  it('returns empty matchedPatterns for safe commands', () => {
    const result = checkDangerousCommand('git status');
    expect(result.isDangerous).toBe(false);
    expect(result.matchedPatterns).toHaveLength(0);
  });
});

describe('isCrossUserAccess', () => {
  const CURRENT_USER = 'U094E5L4A15';

  describe('detects cross-user directory access', () => {
    it.each([
      ['cd /tmp/U09F1M5MML1/session_123', 'cd into another user dir'],
      ['cat /tmp/U09F1M5MML1/file.txt', 'read another user file'],
      ['mkdir -p /tmp/UOTHER123/workdir', 'create dir under another user'],
      ['git clone repo /tmp/U09F1M5MML1/repo', 'clone into another user dir'],
      ['cp /tmp/U094E5L4A15/a.txt /tmp/U09F1M5MML1/b.txt', 'copy to another user dir'],
      ['ls /private/tmp/U09F1M5MML1/', 'macOS /private/tmp path'],
    ])('detects: %s (%s)', (command) => {
      expect(isCrossUserAccess(command, CURRENT_USER)).toBe(true);
    });
  });

  describe('allows same-user directory access', () => {
    it.each([
      ['cd /tmp/U094E5L4A15/session_123', 'cd into own session dir'],
      ['mkdir -p /tmp/U094E5L4A15/soma-work_xxx', 'create sibling dir'],
      ['cat /tmp/U094E5L4A15/file.txt', 'read own file'],
      ['ls /private/tmp/U094E5L4A15/', 'macOS /private/tmp own path'],
      ['cp /tmp/U094E5L4A15/a.txt /tmp/U094E5L4A15/b.txt', 'copy within own dir'],
    ])('allows: %s (%s)', (command) => {
      expect(isCrossUserAccess(command, CURRENT_USER)).toBe(false);
    });
  });

  describe('allows commands without /tmp user paths', () => {
    it.each([
      ['git status', 'git status'],
      ['npm install', 'npm install'],
      ['ls -la /home/user', 'non-tmp path'],
      ['cat /etc/hosts', 'system file'],
      ['echo hello', 'echo'],
      ['mkdir -p /tmp/workdir', 'tmp without user ID pattern'],
    ])('allows: %s (%s)', (command) => {
      expect(isCrossUserAccess(command, CURRENT_USER)).toBe(false);
    });
  });

  it('detects cross-user in compound commands', () => {
    expect(isCrossUserAccess('cd /tmp/U094E5L4A15 && cat /tmp/U09F1M5MML1/file', CURRENT_USER)).toBe(true);
  });

  it('allows when all paths belong to current user', () => {
    expect(
      isCrossUserAccess('cp /tmp/U094E5L4A15/a.txt /tmp/U094E5L4A15/b.txt', CURRENT_USER),
    ).toBe(false);
  });
});

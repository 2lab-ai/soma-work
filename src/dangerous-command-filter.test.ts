import { describe, it, expect } from 'vitest';
import { isDangerousCommand, checkDangerousCommand } from './dangerous-command-filter';

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

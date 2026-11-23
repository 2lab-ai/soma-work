import { describe, expect, it } from 'vitest';
import { commandPreview, processName, splitArgs } from '../command-preview';

describe('processName', () => {
  it('is the executable basename, plus the script for an interpreter', () => {
    expect(processName(['/opt/homebrew/bin/node', '--enable-source-maps', '/app/dist/cli.js', 'x'])).toBe(
      'node cli.js',
    );
    expect(processName(['/bin/bash', '-c', 'ls'])).toBe('bash');
    expect(processName(['/usr/local/bin/claude', '--output-format', 'stream-json'])).toBe('claude');
    expect(processName([])).toBe('?');
  });
});

describe('commandPreview — never shows a secret', () => {
  it('hides the value after a flag that carries config, prompts or credentials', () => {
    const out = commandPreview([
      'claude',
      '--mcp-config',
      '{"mcpServers":{"gh":{"env":{"GITHUB_TOKEN":"ghs_abcdefghijklmnop"}}}}',
      '--append-system-prompt',
      'You are …',
      '--model',
      'opus',
    ]);
    expect(out).toBe('claude --mcp-config … --append-system-prompt … --model opus');
  });

  it('hides an inline --flag=value secret and NAME=value secrets', () => {
    expect(commandPreview(['curl', '--token=abc123', 'API_KEY=sk-live-1', 'MODE=fast'])).toBe(
      'curl --token=… API_KEY=… MODE=fast',
    );
  });

  it('cuts JSON blobs, long token runs and long arguments', () => {
    const long = 'a,'.repeat(60); // not a token run (commas), just long
    const out = commandPreview(['node', 'abcdefghijklmnopqrstuvwxyz0123456789', long, '{"a":1}']);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).toContain(`${long.slice(0, 79)}…`);
    expect(out.endsWith(' {…}')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(240);
  });

  it('runs the shaped-token redaction over what is left', () => {
    const out = commandPreview(['sh', '-c', 'echo', 'xoxb-1234567890-abc']);
    expect(out).not.toContain('xoxb-1234567890-abc');
  });

  it('caps the argument count', () => {
    const argv = ['cmd', ...Array.from({ length: 30 }, (_, i) => `a${i}`)];
    const out = commandPreview(argv);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('a20');
  });
});

describe('commandPreview — the review’s leaks (2026-11-23)', () => {
  const leaks: Array<[string, string]> = [
    ['gh api --access-token hunter2hunter2', 'hunter2hunter2'],
    ['curl --client-secret s3cr3tvalue https://x', 's3cr3tvalue'],
    ['tool --db-password S3cretPass', 'S3cretPass'],
    ['mysql -uroot -pS3cretPass db', 'S3cretPass'],
    ['mysql -u root -p S3cretPass db', 'S3cretPass'],
    ['psql postgres://app:S3cretPass@db/x', 'S3cretPass'],
    ['redis-cli -a hunter2 ping', 'hunter2'],
    ['curl -H Authorization: Bearer abc123short https://x', 'abc123short'],
    ['curl --header X-Api-Key: k3y-value https://x', 'k3y-value'],
  ];
  it.each(leaks)('%s → never shows %s', (line, secret) => {
    expect(commandPreview(splitArgs(line))).not.toContain(secret);
  });

  it('cuts an inline --mcp-config JSON whole even when its spaces split it into many tokens', () => {
    const argv = splitArgs(
      'claude --mcp-config {"mcpServers":{"agent":{"command":"node","args":["/Application Support/s.js"],"env":{"DB_PASSWORD":"hunter2","DESC":"a b c"}}}} --model opus',
    );
    const out = commandPreview(argv);
    expect(out).toBe('claude --mcp-config … --model opus');
    expect(out).not.toContain('hunter2');
  });

  it('cuts a JSON blob that is not behind a flag up to the next --flag', () => {
    expect(commandPreview(splitArgs('node x.js {"k": "secret value"} --port 3'))).toBe('node x.js {…} --port 3');
  });

  it('keeps the shape of a harmless command', () => {
    expect(commandPreview(splitArgs('/usr/bin/git -C /work/repo status --short'))).toBe(
      'git -C /work/repo status --short',
    );
  });
});

describe('splitArgs', () => {
  it('splits on runs of whitespace', () => {
    expect(splitArgs('  a  b\tc ')).toEqual(['a', 'b', 'c']);
  });
});

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
    const long = `/very/${'x'.repeat(120)}`;
    const out = commandPreview(['node', '{"a":1}', 'abcdefghijklmnopqrstuvwxyz0123456789', long]);
    expect(out).toContain('node {…} …');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
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

describe('splitArgs', () => {
  it('splits on runs of whitespace', () => {
    expect(splitArgs('  a  b\tc ')).toEqual(['a', 'b', 'c']);
  });
});

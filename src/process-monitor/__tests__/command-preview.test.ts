import { describe, expect, it } from 'vitest';
import { commandPreview, processName, splitArgs } from '../command-preview';

/** What the sampler does: a ps args line (argv boundaries already lost) → preview. */
const preview = (line: string) => commandPreview(splitArgs(line));

describe('processName', () => {
  it('is the executable basename, plus the script for an interpreter', () => {
    expect(processName(['/opt/homebrew/bin/node', '--enable-source-maps', '/app/dist/cli.js', 'x'])).toBe(
      'node cli.js',
    );
    expect(processName(['/bin/bash', '-c', 'ls'])).toBe('bash');
    expect(processName(['/usr/local/bin/claude', '--output-format', 'stream-json'])).toBe('claude');
    expect(processName([])).toBe('?');
  });

  it('an interpreter running inline code is named by the interpreter, never by the code', () => {
    expect(processName(splitArgs('python3 -c print("xoxb-1234567890-abcdef")'))).toBe('python3');
    expect(processName(splitArgs('node -e require("x").run("sk-ant-api03-secret")'))).toBe('node');
    expect(processName(splitArgs('perl -e print 1'))).toBe('perl');
    expect(processName(splitArgs('/usr/bin/python3 -m http.server'))).toBe('python3');
    expect(processName(splitArgs('node /app/dist/server.js'))).toBe('node server.js');
    // Equals and attached forms of inline code (round 4).
    expect(processName(splitArgs('node --eval=require("x") secret-script.js'))).toBe('node');
    expect(processName(splitArgs('python3 -cimport os secret-module.py'))).toBe('python3');
  });
});

describe('commandPreview — shows the shape, never a value', () => {
  it('keeps the program, flag names and plain words', () => {
    expect(preview('/usr/bin/git -C /work/repo status --short')).toBe('git -C … status --short');
    expect(preview('/usr/local/bin/claude --model opus --verbose')).toBe('claude --model … --verbose');
    expect(preview('/usr/bin/node /app/dist/server.js --port 3000')).toBe('node /app/dist/server.js --port …');
  });

  it('cuts the value written into a flag, long or short', () => {
    expect(preview('tool --level=debug -n5 -rf build')).toBe('tool --level=… -n… -r… …');
  });

  it('cuts NAME=value, and the whole rest of the line after a secret-named one', () => {
    expect(preview('env MODE=fast API_KEY=sk live 1 node x.js')).toBe('env MODE=… API_KEY= …');
  });

  it('cuts JSON, quoted text and token runs', () => {
    const out = preview('node x.js {"k":"v"} "quoted words" abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).toBe('node x.js …');
  });

  it('runs the shaped-token redaction over what is left', () => {
    expect(preview('slack-cli xoxb-1234567890-abc')).not.toContain('xoxb-1234567890-abc');
  });

  it('caps the argument count', () => {
    const out = commandPreview(['cmd', ...Array.from({ length: 30 }, (_, i) => `a${i}`)]);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('a20');
  });
});

describe('commandPreview — every leak the reviews found (2026-11-23), through the real ps path', () => {
  const leaks: Array<[string, string[]]> = [
    ['gh api --access-token hunter2hunter2', ['hunter2hunter2']],
    ['curl --client-secret s3cr3tvalue https://x', ['s3cr3tvalue']],
    ['tool --db-password S3cretPass', ['S3cretPass']],
    ['mysql -uroot -pS3cretPass db', ['S3cretPass', 'root']],
    ['mysql -u root -p S3cretPass db', ['S3cretPass']],
    ['psql postgres://app:S3cretPass@db/x', ['S3cretPass']],
    ['redis-cli -a hunter2 ping', ['hunter2']],
    ['curl -H Authorization: Bearer abc123short https://x', ['abc123short']],
    ['curl --header X-Api-Key: k3y-value https://x', ['k3y-value']],
    ['curl -u alice:wonderland https://x', ['wonderland', 'alice']],
    ['curl --user alice:wonderland https://x', ['wonderland']],
    // Multiword values (ps flattened the quotes away), separate and equals forms.
    ['claude --append-system-prompt Customer password is hunter2 swordfish --model opus', ['hunter2', 'swordfish']],
    ['claude --append-system-prompt Do --not reveal swordfish --model opus', ['swordfish', 'reveal']],
    ['claude --mcp-config={"env": {"DB_PASSWORD": "hunter2 swordfish"}} --model opus', ['hunter2', 'swordfish']],
    ['claude --mcp-config {"mcpServers":{"a":{"env":{"K":"hunter2 x"}}}} --model opus', ['hunter2']],
    ['tool --token=abc def ghi --x', ['abc', 'def', 'ghi']],
    ['tool -p my secret prompt words', ['secret', 'prompt', 'words']],
    ['env SECRET_PHRASE=correct horse battery staple node x.js', ['correct', 'horse', 'battery', 'staple']],
    ['python3 -c print("swordfish")', ['swordfish']],
    ['sh -c echo hello swordfish', ['swordfish', 'hello']],
    // Attached short options (round 4): the letter decides, and a written-in value's spill is cut.
    ['mysql -pcorrect horse battery staple db', ['correct', 'horse', 'battery', 'staple']],
    ['redis-cli -ahunter2 more words', ['hunter2', 'more', 'words']],
    ['curl -ualice:wonderland https://x', ['alice', 'wonderland']],
    ['curl -HAuthorization: Bearer tok3n https://x', ['tok3n', 'Bearer']],
    ['python3 -cprint("swordfish")', ['swordfish']],
    ['tool -n5 then spilled words --x', ['spilled', 'words']],
    ['tool --level=a b c --x', ['b', 'c']],
  ];
  it.each(leaks)('%s', (line, secrets) => {
    const out = preview(line);
    for (const secret of secrets) expect(out, out).not.toContain(secret);
  });
});

describe('splitArgs', () => {
  it('splits on runs of whitespace', () => {
    expect(splitArgs('  a  b\tc ')).toEqual(['a', 'b', 'c']);
  });
});

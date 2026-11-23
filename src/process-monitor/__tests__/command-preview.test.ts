import { describe, expect, it } from 'vitest';
import { commandPreview, processName, SHOWN_FLAGS, splitArgs } from '../command-preview';

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
    // A script read from stdin (`-`): the next argument is data. A bare word is not a script file.
    expect(processName(splitArgs('python3 - S3cretArg'))).toBe('python3');
    expect(processName(splitArgs('node S3cretWord'))).toBe('node');
    // The script is the first operand after known interpreter options; a value of one of them is not (round 6).
    expect(processName(splitArgs('node --require p@ss/word.js app.js'))).toBe('node app.js');
    expect(processName(splitArgs('node --inspect-brk=9229 p@ss/word.js'))).toBe('node');
  });
});

describe('commandPreview — a known prefix of the command, never a value', () => {
  it('shows the program and the flags it knows; a value is cut; the first word it does not know ends it', () => {
    expect(preview('/usr/local/bin/claude --model opus --verbose')).toBe('claude --model … --verbose');
    expect(preview('/usr/bin/node /app/dist/server.js --port 3000')).toBe('node server.js --port …');
    expect(preview('/usr/bin/git -C /work/repo status --short')).toBe('git …');
    expect(preview('/usr/bin/git status /work/repo')).toBe('git …');
    expect(preview('tool --level=debug -n5 -rf build')).toBe('tool …');
    expect(preview('env MODE=fast API_KEY=sk live 1 node x.js')).toBe('env …');
    expect(preview('node ./x.js {"k":"v"} "quoted words"')).toBe('node x.js …');
  });

  it("the SDK's own CLI line keeps its known flags and loses every value", () => {
    const line =
      'node /opt/sdk/cli.js --output-format stream-json --verbose --input-format stream-json --max-thinking-tokens 0 ' +
      '--model claude-opus --permission-mode default --setting-sources user,project --mcp-config {"mcpServers":{}} ' +
      '--append-system-prompt Customer password is hunter2';
    expect(preview(line)).toBe(
      'node cli.js --output-format … --verbose --input-format … --max-thinking-tokens … --model … ' +
        '--permission-mode … --setting-sources … …',
    );
  });

  it('a value written into a known flag is cut', () => {
    expect(preview('claude --output-format=stream-json --porcelain=v2 --verbose')).toBe(
      'claude --output-format=… --porcelain=… --verbose',
    );
  });

  it('the word after a value flag is its value, whatever it looks like (`--model --verbose` hides `--verbose`)', () => {
    expect(preview('claude --model --verbose --continue')).toBe('claude --model … --continue');
  });

  it('every word of the output is the program, its script, a known flag, or …', () => {
    const vocab = [
      '--model',
      'opus',
      '--verbose',
      '--swordfish',
      'p@ss/word',
      '/work/repo',
      '-p',
      'S3cret',
      '--arg',
      'x.js',
      './run.sh',
      '--require',
      '--output-format=stream-json',
      '--token=abc',
      'NAME=v',
      '-',
      '--',
      '{"k":1}',
    ];
    const programs = ['node', '/usr/bin/python3', 'claude', 'jq', 'git'];
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let c = 0; c < 500; c++) {
      const argv = [
        programs[next(programs.length)],
        ...Array.from({ length: 1 + next(8) }, () => vocab[next(vocab.length)]),
      ];
      const out = commandPreview(argv);
      const [exe, script] = processName(argv).split(' ');
      const words = out.split(' ');
      expect(words[0]).toBe(exe);
      for (const w of words.slice(1)) {
        const known =
          w === '…' || w === script || SHOWN_FLAGS.has(w) || (w.endsWith('=…') && SHOWN_FLAGS.has(w.slice(0, -2)));
        expect(known, `${argv.join(' ')} → ${out}`).toBe(true);
      }
      for (const secret of ['swordfish', 'p@ss', 'S3cret', 'abc', 'opus', 'stream-json', 'NAME', '/work']) {
        expect(out, `${argv.join(' ')} → ${out}`).not.toContain(secret);
      }
    }
  });

  it("runs the logger's token redaction over the program's and the script's own names", () => {
    const out = preview('/opt/tools/xoxb-12345678-abcdef --verbose');
    expect(out).not.toContain('xoxb-12345678-abcdef');
    expect(out).toContain('[REDACTED xoxb-');
    const name = processName(splitArgs('node /work/sk-ant-api03-abcdefgh.js'));
    expect(name).not.toContain('sk-ant-api03-abcdefgh');
    expect(name).toContain('[REDACTED sk-ant-api03-');
  });

  it('caps the argument count', () => {
    const out = commandPreview(['cmd', ...Array.from({ length: 30 }, () => '--verbose')]);
    expect(out.split(' ').filter((w) => w === '--verbose')).toHaveLength(16);
    expect(out.endsWith(' …')).toBe(true);
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
    // Positional and multi-operand values (round 5): a word that is not a path is never shown.
    ['jq --arg name s3cretvalue .', ['s3cretvalue', 'name']],
    ['mysql db S3cretPass', ['S3cretPass']],
    ['tool --model claude opus extra', ['opus', 'extra']],
    ['gpg --passphrase correct horse', ['correct', 'horse']],
    ['openssl enc --pin 1234 --in /x', ['1234']],
    // Option-looking and path-looking values (round 6): no word after the program is copied.
    ['jq --arg password --swordfish .', ['swordfish', 'password']],
    ['jq --arg password p@ss/word .', ['p@ss', 'word', 'password']],
    ['claude --model opus --swordfish', ['swordfish', 'opus']],
    ['claude --add-dir /a /p@ss/word --verbose', ['p@ss', '/a']],
    ['node --require p@ss/word.js app.js', ['p@ss', 'word']],
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

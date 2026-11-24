import { describe, expect, it } from 'vitest';
import { MASK, maskCommandLine, maskJson } from '../command-mask';

/** The detail view's full command line: every word, secret values masked (see command-mask.ts). */
const joined = (line: string) => maskCommandLine({ argv: [line], exact: false });
const exact = (...argv: string[]) => maskCommandLine({ argv, exact: true });

describe('maskCommandLine', () => {
  it('keeps an ordinary command line whole — program, subcommands, flags, paths', () => {
    expect(joined('/opt/homebrew/bin/node /work/repo/node_modules/.bin/tsc --noEmit -p tsconfig.json')).toBe(
      '/opt/homebrew/bin/node /work/repo/node_modules/.bin/tsc --noEmit -p tsconfig.json',
    );
    expect(joined('git checkout feat/process-explorer')).toBe('git checkout feat/process-explorer');
    // A path with capitals and digits in it is a path (its parts are short or single-case).
    expect(
      joined('/opt/homebrew/Cellar/node/26.9.0/bin/node /Users/Z/Library/Caches/ms-playwright/chromium-1255/x'),
    ).toBe('/opt/homebrew/Cellar/node/26.9.0/bin/node /Users/Z/Library/Caches/ms-playwright/chromium-1255/x');
    // A git SHA and a UUID are not keys.
    expect(joined('git show 53c597d5aa0c2e1f63d0b3f5bd4c6a1d2e3f4a5b')).toBe(
      'git show 53c597d5aa0c2e1f63d0b3f5bd4c6a1d2e3f4a5b',
    );
    expect(joined('claude --resume 0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0')).toBe(
      'claude --resume 0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0',
    );
  });

  it('masks JSON wholesale — an MCP config carries servers’ env and headers', () => {
    expect(joined('claude --mcp-config {"mcpServers":{"gh":{"env":{"GITHUB_TOKEN":"hunter2"}}}} --verbose')).toBe(
      `claude --mcp-config {${MASK}} --verbose`,
    );
    // ps splits the JSON at its spaces; the braces still bound it. An unclosed one runs to the end.
    expect(joined('x --settings {"a": "b c", "d": [1, 2]} tail')).toBe(`x --settings {${MASK}} tail`);
    expect(joined('x --settings {"token": "abc')).toBe(`x --settings {${MASK}}`);
    expect(maskJson('jq .items[0] file')).toBe('jq .items[0] file');
    expect(maskJson('x --list=["a","b"]')).toBe(`x --list=[${MASK}]`);
  });

  it('a delimiter inside a JSON string does not end the span (both modes); an escaped quote does not end the string', () => {
    expect(joined('x --settings {"label":"}","value":"hunter2"} --verbose')).toBe(`x --settings {${MASK}} --verbose`);
    expect(exact('x', '--settings', '{"label":"}","value":"hunter2"}', '--verbose')).toBe(
      `x --settings {${MASK}} --verbose`,
    );
    expect(joined('x {"a":"q\\"}","b":"hunter2"} tail')).toBe(`x {${MASK}} tail`);
    expect(joined('x ["]","hunter2"] tail')).toBe(`x [${MASK}] tail`);
    expect(joined('x {"open":"hunter2')).not.toContain('hunter2');
  });

  it('a shell command inside one exact argument is masked word by word (bash -c, sh -c)', () => {
    expect(exact('bash', '-c', 'client --password=hunter2; sleep 60')).toBe(
      `bash -c 'client --password=${MASK} sleep 60'`,
    );
    // An argument that opens with a secret assignment may be its value, spaces and all: the rest goes with it.
    expect(exact('sh', '-c', 'GITHUB_TOKEN=abc123 gh pr view 1')).toBe(`sh -c GITHUB_TOKEN=${MASK}`);
    expect(exact('sh', '-c', 'cd /w && GITHUB_TOKEN=abc123 gh pr view 1')).toBe(
      `sh -c 'cd /w && GITHUB_TOKEN=${MASK} gh pr view 1'`,
    );
    expect(exact('sh', '-c', 'mysql -uroot -phunter2 db')).toBe(`sh -c 'mysql -uroot -p${MASK} db'`);
    // The value of a secret flag is masked whole, spaces and all.
    expect(exact('tool', '--token', 'two words')).toBe(`tool --token ${MASK}`);
    expect(exact('tool', '--password=two words', 'API_KEY=two words', '"--secret=a b"')).toBe(
      `tool --password=${MASK} API_KEY=${MASK} "--secret=${MASK}`,
    );
  });

  it('masks the value of a flag or variable whose name says secret, in every form', () => {
    expect(joined('tool --token abc123 --password=pw --api-key K --out file')).toBe(
      `tool --token ${MASK} --password=${MASK} --api-key ${MASK} --out file`,
    );
    expect(joined('env GITHUB_TOKEN=ghx AWS_SECRET_ACCESS_KEY=y PATH=/bin node app.js')).toBe(
      `env GITHUB_TOKEN=${MASK} AWS_SECRET_ACCESS_KEY=${MASK} PATH=/bin node app.js`,
    );
    expect(joined('mysql -uroot -phunter2 db')).toBe(`mysql -uroot -p${MASK} db`);
    // -p elsewhere is just a flag.
    expect(joined('tsc -p tsconfig.json')).toBe('tsc -p tsconfig.json');
  });

  it('masks HTTP credentials, URL passwords and secret query values', () => {
    expect(joined('curl -H Authorization: Bearer abc.def.ghi https://api.example.com/x')).toBe(
      `curl -H Authorization: Bearer ${MASK} https://api.example.com/x`,
    );
    expect(exact('curl', '-H', 'Authorization: Bearer abc', '-H', 'Cookie: sid=1')).toBe(
      `curl -H 'Authorization: Bearer ${MASK}' -H 'Cookie: ${MASK}'`,
    );
    // ps keeps a shell line's quotes: the header is still found behind its opening quote.
    expect(joined('curl -H "Authorization: Bearer abc" https://h')).toBe(
      `curl -H "Authorization: Bearer ${MASK}" https://h`,
    );
    expect(joined('x "--password=hunter2"')).toBe(`x "--password=${MASK}`);
    expect(joined('git clone https://bot:s3cr3t@github.com/o/r.git')).toBe(
      `git clone https://bot:${MASK}@github.com/o/r.git`,
    );
    expect(joined('curl https://h/x?a=1&access_token=zzz&b=2')).toBe(`curl https://h/x?a=1&access_token=${MASK}&b=2`);
  });

  it('a value spanning words is masked whole: several cookies, a quoted flag value, a header up to the next flag or URL', () => {
    expect(joined('curl -H "Cookie: theme=dark; sid=hunter2" https://h')).toBe(
      `curl -H "Cookie: ${MASK} ${MASK}" https://h`,
    );
    expect(joined('curl -H Cookie: theme=dark; sid=hunter2 -X GET https://h')).toBe(
      `curl -H Cookie: ${MASK} ${MASK} -X GET https://h`,
    );
    expect(exact('curl', '-H', 'Cookie: theme=dark; sid=hunter2', 'https://h')).toBe(
      `curl -H 'Cookie: ${MASK} ${MASK}' https://h`,
    );
    expect(joined('client --cookie "a=b; sid=hunter2" --verbose')).toBe(`client --cookie "${MASK} ${MASK}" --verbose`);
    expect(joined('client --password="two words" --verbose')).toBe(`client --password=${MASK} ${MASK}" --verbose`);
    expect(joined('x --token abc next')).toBe(`x --token ${MASK} next`);
  });

  it('masks known key shapes and long high-entropy words anywhere', () => {
    const gh = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    expect(joined(`gh auth --with ${gh}`)).not.toContain(gh);
    expect(joined('x sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123')).not.toContain('abcdefghijklmnop');
    expect(joined('x AKIAABCDEFGHIJKLMNOP')).toBe(`x ${MASK}`);
    expect(joined('x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N')).toBe(`x ${MASK}`);
    expect(joined('x --opaque Zq8vR2mKx7pL4nW9tY3bC6dF1')).toBe(`x --opaque ${MASK}`);
    // A long all-lowercase word (a library name) is not entropy.
    expect(joined('x libabsl_log_internal_structured_proto')).toBe('x libabsl_log_internal_structured_proto');
  });

  it('a crafted long argument costs linear time: the masker reads a bounded prefix of each word and of the line', () => {
    const evil = `?${'a'.repeat(200_000)}`;
    const bomb = `x://${'a:'.repeat(100_000)}`;
    const t0 = Date.now();
    joined(`x ${evil} ${bomb} ${'&k'.repeat(50_000)}`);
    exact('x', evil, bomb, '?'.repeat(300_000));
    expect(Date.now() - t0).toBeLessThan(1_000);
    // A secret query value still goes.
    expect(joined('curl https://h/x?api_key=abc&page=2')).toBe(`curl https://h/x?api_key=${MASK}&page=2`);
  });

  it('exact argv: words with spaces are quoted back; caps a word and the line', () => {
    expect(exact('bash', '-c', 'npm run build && npm test')).toBe(`bash -c 'npm run build && npm test'`);
    expect(exact('echo', "it's")).toBe("echo it's");
    expect(exact('echo', 'a b', "c'd e")).toBe(`echo 'a b' 'c'\\''d e'`);
    expect(exact('x', 'y'.repeat(500)).length).toBeLessThan(320);
    expect(exact(...Array.from({ length: 400 }, () => 'word-word-word')).length).toBeLessThanOrEqual(4000);
    expect(maskCommandLine({ argv: [], exact: true })).toBe('');
  });
});

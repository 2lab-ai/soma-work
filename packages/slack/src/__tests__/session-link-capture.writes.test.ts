/**
 * #832 (epic #831) — a PR or issue is recorded by the effect of a write, however the call was spelled.
 *
 * On dev, 9 of 15 bot PRs opened after automatic capture went live never reached a card: all 9 were REST writes
 * (`curl -X POST …/pulls`, `node -e fetch(…, {method:"POST"})`), which `isCreateCommand` never matched. W1 replays
 * those 9 real tool calls (fixtures/github-write-leaks.json, from the two sessions' transcripts); W2 replays the 3
 * comment POSTs of the same sessions, which must record nothing.
 *
 *   W1  the 9 real REST creates each record their PR
 *   W2  a comment POST (its result is a `#issuecomment-…` URL) records nothing
 *   W3  reads, errors, pasted output, another repo's URL, reviews and labels record nothing
 *   W4  every spelling of a create: gh, gh api (explicit and implied POST), a METHOD /repos helper, GitHub MCP
 *   W5  merge and close: proven by their own result; the target comes from the call
 */
import { describe, expect, it } from 'vitest';
import { type GitHubEffect, githubEffectsOf, githubWritesOf } from '../session-link-capture';
import fixtures from './fixtures/github-write-leaks.json';

interface Call {
  toolName: string;
  input: unknown;
  result: unknown;
  isError?: boolean;
}

/** One turn: each call's writes are read from its input (onToolUse), its effects from its result (onToolResult). */
function effectsOf(...calls: Call[]): GitHubEffect[] {
  const writes = new Map<string, ReturnType<typeof githubWritesOf>>();
  const results = calls.map((c, i) => {
    const id = `tu${i}`;
    const w = githubWritesOf(c.toolName, c.input);
    if (w.length > 0) writes.set(id, w);
    return { toolUseId: id, toolName: c.toolName, result: c.result, isError: c.isError };
  });
  return githubEffectsOf(results, writes);
}

const bash = (command: string, result: unknown, isError?: boolean): Call => ({
  toolName: 'Bash',
  input: { command },
  result,
  isError,
});

const short = (e: GitHubEffect) => [e.op, e.link.type, e.link.url];

describe('githubEffectsOf — the 9 REST creates that leaked (#831)', () => {
  it.each(fixtures.leaks.map((l) => [l.expect, l] as const))('W1 — %s is recorded as created', (_url, leak) => {
    const effects = effectsOf({ toolName: leak.toolName, input: leak.input, result: leak.result });
    expect(effects.map(short)).toEqual([['create', 'pr', leak.expect]]);
    expect(effects[0].link.provider).toBe('github');
  });

  it.each(fixtures.comments.map((c) => [c.why, c] as const))('W2 — %s records nothing', (_why, comment) => {
    expect(effectsOf({ toolName: comment.toolName, input: comment.input, result: comment.result })).toEqual([]);
  });
});

describe('githubEffectsOf — what is not a write', () => {
  const PR_OBJECT = '{\n  "number": 12,\n  "html_url": "https://github.com/a/b/pull/12",\n  "state": "open"\n}';

  it('W3 — reads, errors, pasted output and other targets record nothing', () => {
    expect(
      effectsOf(
        bash('gh pr view 12 --json url -q .url', 'https://github.com/a/b/pull/12'),
        bash('curl -s -H "Authorization: Bearer $T" https://api.github.com/repos/a/b/pulls/12', PR_OBJECT),
        bash('gh api repos/a/b/pulls/12', PR_OBJECT),
        bash('gh api "repos/a/b/pulls?head=a:feat/x&state=all"', `[${PR_OBJECT}]`),
        bash('cat scratch/fixture.json', PR_OBJECT),
        // An error result: the POST did not happen.
        bash('curl -s -X POST https://api.github.com/repos/a/b/pulls -d @pr.json', PR_OBJECT, true),
        // A POST that failed in its own output (GitHub's error object has no html_url).
        bash(
          'curl -s -X POST https://api.github.com/repos/a/b/pulls -d @pr.json',
          '{"message":"Validation Failed","errors":[{"message":"A pull request already exists for a:feat/x."}]}',
        ),
        // A POST to a/b whose output names a PR of c/d.
        bash(
          'curl -s -X POST https://api.github.com/repos/a/b/pulls -d @pr.json && gh pr view 3 -R c/d --json url -q .url',
          'https://github.com/c/d/pull/3',
        ),
        // A review and a label are writes, but not of a PR or an issue.
        bash(
          'gh api -X POST repos/a/b/pulls/12/reviews -f event=COMMENT -f body=ok',
          '{"id":1,"html_url":"https://github.com/a/b/pull/12#pullrequestreview-1"}',
        ),
        bash('gh api repos/a/b/issues/12/labels -f "labels[]=P1"', PR_OBJECT),
        // A PUT or PATCH of the collection is not a create.
        bash('curl -s -X PUT https://api.github.com/repos/a/b/pulls -d @pr.json', PR_OBJECT),
        // A Read of a file that holds a URL.
        { toolName: 'Read', input: { file_path: '/tmp/x.md' }, result: 'https://github.com/a/b/pull/12' },
      ),
    ).toEqual([]);
  });

  it('W3 — a POST described in a heredoc PR body is not a write when the command only reads', () => {
    const command = [
      "cat > scratch/body.md <<'EOF'",
      'How I made it: curl -X POST https://api.github.com/repos/a/b/pulls',
      'EOF',
      'gh api repos/a/b/pulls/12',
    ].join('\n');
    expect(effectsOf(bash(command, PR_OBJECT))).toEqual([]);
  });

  it('W3 — a request that is only printed, or commented out, is not a write (review P1)', () => {
    expect(
      effectsOf(
        bash(
          `echo 'fetch("https://api.github.com/repos/a/b/pulls", {method: "POST"})' && gh pr view 12 --json url -q .url`,
          'https://github.com/a/b/pull/12',
        ),
        bash(
          'printf "%s" "curl -X POST https://api.github.com/repos/a/b/pulls" | cat',
          'https://github.com/a/b/pull/12',
        ),
        bash(
          '# curl -X POST https://api.github.com/repos/a/b/pulls -d @p\ngh pr view 12 --json url -q .url',
          'https://github.com/a/b/pull/12',
        ),
        bash(
          '# gh api -X PATCH repos/a/b/issues/31 -f state=closed\ngh api repos/a/b/issues/31',
          '{"number":31,"html_url":"https://github.com/a/b/issues/31","state":"closed"}',
        ),
        bash(
          "node <<'EOF'\n// await fetch('https://api.github.com/repos/a/b/pulls', { method: 'POST' })\nconsole.log('https://github.com/a/b/pull/12')\nEOF",
          'https://github.com/a/b/pull/12',
        ),
      ),
    ).toEqual([]);
    // A `#` inside a word or a quote is not a comment.
    expect(
      effectsOf(
        bash(
          'curl -s -X POST "https://api.github.com/repos/a/b/issues" -d \'{"title":"fix #12"}\' | jq -r .html_url',
          'https://github.com/a/b/issues/40',
        ),
      ).map(short),
    ).toEqual([['create', 'issue', 'https://github.com/a/b/issues/40']]);
  });

  it('W3 — only a sender sends: a request spelled in a commit message or a PR body is not a write (review P2)', () => {
    expect(
      effectsOf(
        bash(
          'gh pr edit 12 --body "How: curl -X POST https://api.github.com/repos/a/b/pulls" && gh pr view 12 --json url -q .url',
          'https://github.com/a/b/pull/12',
        ),
        bash(
          'git commit -q -m "feat: POST /repos/a/b/pulls helper" && gh pr view 12 --json url -q .url',
          'https://github.com/a/b/pull/12',
        ),
      ),
    ).toEqual([]);
    // A command substitution runs its command.
    expect(
      effectsOf(
        bash(
          'URL=$(curl -s -X POST https://api.github.com/repos/a/b/pulls -d @pr.json | jq -r .html_url) && echo "$URL"',
          'https://github.com/a/b/pull/41',
        ),
      ).map(short),
    ).toEqual([['create', 'pr', 'https://github.com/a/b/pull/41']]);
  });

  it('W3 — an interpreter that only prints a request is not a write (review round 2, P1)', () => {
    const view = ' && gh pr view 12 --json url -q .url';
    const url = 'https://github.com/a/b/pull/12';
    expect(
      effectsOf(
        bash(`bash -c 'echo curl -X POST https://api.github.com/repos/a/b/pulls'${view}`, url),
        bash(`node -e 'console.log("curl -X POST https://api.github.com/repos/a/b/pulls")'${view}`, url),
        bash(`python3 -c 'print("curl -X POST https://api.github.com/repos/a/b/pulls")'${view}`, url),
        bash(`python3 -c 'print("POST /repos/a/b/pulls")'${view}`, url),
        bash(`ruby -e 'puts "curl -d @p https://api.github.com/repos/a/b/pulls"'${view}`, url),
        // A shell heredoc is shell: its echo prints, it does not send.
        bash(
          "bash <<'EOF'\necho 'curl -X POST https://api.github.com/repos/a/b/pulls'\ngh pr view 12 --json url -q .url\nEOF",
          url,
        ),
        // A script reading a heredoc reads data, not code.
        bash(
          "node scratch/render.cjs <<'EOF'\nfetch('https://api.github.com/repos/a/b/pulls', { method: 'POST' })\nEOF\ngh pr view 12 --json url -q .url",
          url,
        ),
        // What a program runs is read as a command: an echo there prints too.
        bash(
          `node -e 'require("child_process").execSync("echo curl -X POST https://api.github.com/repos/a/b/pulls")'${view}`,
          url,
        ),
      ),
    ).toEqual([]);
  });

  it('W3 — in code only a call sends: data, a printed call or a comment that spells a request is not a write (review round 3, P1)', () => {
    const view = ' && gh pr view 12 --json url -q .url';
    const url = 'https://github.com/a/b/pull/12';
    expect(
      effectsOf(
        bash(`node -e 'const spec = { method: "POST", url: "https://api.github.com/repos/a/b/pulls" }'${view}`, url),
        bash(
          `node -e 'console.log(\`fetch("https://api.github.com/repos/a/b/pulls", { method: "POST" })\`)'${view}`,
          url,
        ),
        bash(
          `node -e 'const method = "POST"; const url = "https://api.github.com/repos/a/b/pulls"; console.log(method, url)'${view}`,
          url,
        ),
        bash(`node -e 'const x = 1; // octokit.request("POST /repos/a/b/pulls")'${view}`, url),
        bash(
          `node -e 'const x = 1; /* fetch("https://api.github.com/repos/a/b/pulls", {method: "POST"}) */'${view}`,
          url,
        ),
        bash(`python3 -c 'print("requests.post(\\"https://api.github.com/repos/a/b/pulls\\")")'${view}`, url),
        bash(`python3 -c 'x = 1  # requests.post("https://api.github.com/repos/a/b/pulls")'${view}`, url),
        bash(`python3 -c 'print("""fetch("https://api.github.com/repos/a/b/pulls", method="POST")""")'${view}`, url),
      ),
    ).toEqual([]);
  });

  it('W3 — a regex literal, a callback, a nested body or a plain run() is not a sending call (review round 4)', () => {
    const view = ' && gh pr view 12 --json url -q .url';
    const url = 'https://github.com/a/b/pull/12';
    expect(
      effectsOf(
        // A division, then a regex literal that spells a fetch.
        bash(
          `node -e 'const x = 4 / /fetch("https:\\/\\/api.github.com\\/repos\\/a\\/b\\/pulls", {method:"POST"})/.test(s)'${view}`,
          url,
        ),
        bash(`node -e 'if (/fetch\\("https:\\/\\/api.github.com\\/repos\\/a\\/b\\/pulls"/.test(s)) {}'${view}`, url),
        // A GET whose callback names a method.
        bash(`node -e 'fetch("https://api.github.com/repos/a/b/pulls", () => ({ method: "POST" }))'${view}`, url),
        // A GET elsewhere whose body mentions the endpoint.
        bash(
          `node -e 'fetch("https://example.com/hook", { method: "POST", body: JSON.stringify({ see: "https://api.github.com/repos/a/b/pulls" }) })'${view}`,
          url,
        ),
        // `run` and `.exec` that are not a shell.
        bash(`node -e 'run("curl -X POST https://api.github.com/repos/a/b/pulls -d @p")'${view}`, url),
        bash(`node -e '/x/.exec("curl -X POST https://api.github.com/repos/a/b/pulls -d @p")'${view}`, url),
      ),
    ).toEqual([]);
    // The real ones still count — also gh by its path, and a gh pr create with a very long inline body.
    expect(
      effectsOf(
        bash('/opt/homebrew/bin/gh pr create --fill', 'https://github.com/a/b/pull/72\n'),
        bash(`gh pr create --title x --body "${'y'.repeat(40_000)}"`, 'https://github.com/a/b/pull/73\n'),
        bash(
          `node -e 'const x = 4 / 2; fetch("https://api.github.com/repos/a/b/pulls", { method: "POST" })'`,
          'https://github.com/a/b/pull/70',
        ),
        bash(
          `python3 -c 'import os; os.system("curl -s -X POST https://api.github.com/repos/a/b/issues -d @i.json | jq -r .html_url")'`,
          'https://github.com/a/b/issues/71',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/72'],
      ['create', 'pr', 'https://github.com/a/b/pull/73'],
      ['create', 'pr', 'https://github.com/a/b/pull/70'],
      ['create', 'issue', 'https://github.com/a/b/issues/71'],
    ]);
  });

  it('W3 — a regex literal at the start of a line, after `)`, `]` or an operand is masked too (review round 5)', () => {
    const view = '; gh pr view 12 --json url -q .url';
    const url = 'https://github.com/a/b/pull/12';
    // A valid regex literal that spells a fetch call (its group is the call's parentheses).
    const re = '/fetch("https:\\/\\/api.github.com\\/repos\\/a\\/b\\/pulls", {method:"POST"})/';
    expect(
      effectsOf(
        bash(`node -e 'const s = "x"\n${re}.test(s)'${view}`, url),
        bash(`node -e '(s) ${re}.test(s)'${view}`, url),
        bash(`node -e 'a[0] ${re}'${view}`, url),
        bash(`node -e 'x ${re}.test(s)'${view}`, url),
      ),
    ).toEqual([]);
    // A division is still a division: the fetch after it counts. That includes a line that starts with `/`
    // after an operand — JS reads it as a division, so `s = 8\n/fetch(…) / 1` calls fetch (and the same line with
    // unescaped slashes ending in `/.test(s)` is a syntax error: nothing runs, but only a parser could tell).
    expect(
      effectsOf(
        bash(
          `node -e 'const s = 8\n/fetch("https://api.github.com/repos/a/b/pulls", {method:"POST"}) / 1'`,
          'https://github.com/a/b/pull/76',
        ),
        bash(
          `node -e 'const half = total / 2; const r = (a + b) / 2; fetch("https://api.github.com/repos/a/b/pulls", { method: "POST" })'`,
          'https://github.com/a/b/pull/74',
        ),
        bash(
          `node -e 'const q = a/b; fetch("https://api.github.com/repos/a/b/issues", { method: "POST" })'`,
          'https://github.com/a/b/issues/75',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/76'],
      ['create', 'pr', 'https://github.com/a/b/pull/74'],
      ['create', 'issue', 'https://github.com/a/b/issues/75'],
    ]);
  });

  it('W3 — a regex after `;` and a newline is a regex, whatever follows it; a division with a call between runs (review round 6)', () => {
    const view = '; gh pr view 12 --json url -q .url';
    const url = 'https://github.com/a/b/pull/12';
    const re = '/fetch("https:\\/\\/api.github.com\\/repos\\/a\\/b\\/pulls", {method:"POST"})/';
    // `node` evaluates these regex literals and discards them: fetch is never called.
    expect(
      effectsOf(
        bash(`node -e 'const s = 1;\n${re}+1'${view}`, url),
        bash(`node -e 'const s = 1;\n${re} && s'${view}`, url),
      ),
    ).toEqual([]);
    // JS reads these as divisions, so fetch runs: `(0) / fetch(…) / +0`, `x / fetch(…) / y`.
    expect(
      effectsOf(
        bash(`node -e '(0)${re}+0'`, 'https://github.com/a/b/pull/77'),
        bash(`node -e 'const x = 2, y = 1;\nx ${re} y'`, 'https://github.com/a/b/pull/78'),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/77'],
      ['create', 'pr', 'https://github.com/a/b/pull/78'],
    ]);
  });

  it('W3 — pathological commands are read in linear time (review P1)', () => {
    const inputs = [
      `curl -X${' '.repeat(199_000)}x https://api.github.com/repos/a/b/pulls`,
      `${'A=$('.repeat(49_990)} gh`,
      Array.from({ length: 5000 }, () => 'https://api.github.com/repos/a/b/pulls').join(' '),
      `${'`'.repeat(150_001)} github`,
      `${'$('.repeat(90_000)} github`,
      `${"bash -c '".repeat(20_000)} github`,
      `${'echo `x` '.repeat(19_000)} github`,
      `node -e '${'run("'.repeat(6000)}' github`,
      `node -e '${'fetch('.repeat(5000)}' github`,
      `node -e '${'fetch("https://api.github.com/repos/a/b/pulls", {method: "POST"}, '.repeat(400)}'`,
      `python3 -c '${'"""'.repeat(9000)} github'`,
      `node -e '${'(/['.repeat(10_000)}' github`,
      `ruby -e '${'= /'.repeat(10_000)}' github`,
    ];
    for (const command of inputs) {
      const started = Date.now();
      githubWritesOf('Bash', { command });
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('W3 — a large result is read in linear time (2,000 objects)', () => {
    const many = Array.from(
      { length: 2000 },
      (_, i) => `{"number":${i},"html_url":"https://github.com/a/b/pull/${i}"}`,
    );
    const started = Date.now();
    const effects = effectsOf(bash('gh api -X POST repos/a/b/pulls -f head=x', `[${many.join(',')}]`));
    expect(effects.map(short)).toEqual([['create', 'pr', 'https://github.com/a/b/pull/0']]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('W3 — githubWritesOf reads only the call, never prose', () => {
    expect(githubWritesOf('Bash', { command: 'gh pr list' })).toEqual([]);
    expect(githubWritesOf('Bash', { command: 'echo "gh pr create"' })).toEqual([]);
    expect(githubWritesOf('Bash', undefined)).toEqual([]);
    expect(githubWritesOf('Read', { file_path: 'x' })).toEqual([]);
  });
});

describe('W6 — review round 7 (astra-zhuge)', () => {
  const view = '; gh pr view 12 -R a/b --json url -q .url';
  const url = 'https://github.com/a/b/pull/12';

  it('a bundled -G makes curl a GET: a listing is not a create (P1)', () => {
    expect(
      effectsOf(
        bash(
          "curl -sG --data-urlencode 'state=open' https://api.github.com/repos/a/b/pulls",
          '[{"number":12,"html_url":"https://github.com/a/b/pull/12"}]',
        ),
      ),
    ).toEqual([]);
  });

  it('an endpoint inside a body, a header or an option value is not the destination (P1)', () => {
    expect(
      effectsOf(
        bash(
          `curl -s -X POST https://hooks.example.com/x -d '{"see":"https://api.github.com/repos/a/b/pulls"}'${view}`,
          url,
        ),
        bash(
          `curl -s -X POST -H "Link: <https://api.github.com/repos/a/b/pulls>" https://example.com/x -d @b${view}`,
          url,
        ),
        bash(
          `node -e 'fetch("https://example.com/hook", {method:"POST",body:"https://api.github.com/repos/a/b/pulls"})'${view}`,
          url,
        ),
        bash(
          `python3 -c 'import requests; requests.post("https://example.com/hook", json={"u": "https://api.github.com/repos/a/b/pulls"})'${view}`,
          url,
        ),
      ),
    ).toEqual([]);
    // The destination still counts, as an argument or an options `url` / `path`.
    expect(
      effectsOf(
        bash(
          'curl -s -H "Accept: application/json" -d @p.json https://api.github.com/repos/a/b/pulls',
          '{"number":80,"html_url":"https://github.com/a/b/pull/80"}',
        ),
        bash(
          `node -e 'axios({ method: "post", url: "https://api.github.com/repos/a/b/issues", data: {} })'`,
          '{"number":81,"html_url":"https://github.com/a/b/issues/81"}',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/80'],
      ['create', 'issue', 'https://github.com/a/b/issues/81'],
    ]);
  });

  it('constructing a Request sends nothing; a Request handed to urlopen or fetch does (P1)', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'new Request("https://api.github.com/repos/a/b/pulls", {method:"POST"}); console.log("${url}")'`,
          url,
        ),
      ),
    ).toEqual([]);
    expect(
      effectsOf(
        bash(
          `node -e 'fetch(new Request("https://api.github.com/repos/a/b/pulls", {method:"POST"}))'`,
          '{"number":82,"html_url":"https://github.com/a/b/pull/82"}',
        ),
      ).map(short),
    ).toEqual([['create', 'pr', 'https://github.com/a/b/pull/82']]);
  });

  it('a merge or close line proves only the PR or issue it names (P1)', () => {
    expect(
      effectsOf(
        bash(
          'gh pr merge 12 -R a/b --squash || gh pr merge 13 -R a/b --squash',
          'X Pull request a/b#12 is not mergeable\n✓ Squashed and merged pull request a/b#13 (x)',
        ),
        bash(
          'gh issue close 30 -R a/b || gh issue close 31 -R a/b',
          'X could not close a/b#30\n✓ Closed issue a/b#31 (y)',
        ),
      ).map(short),
    ).toEqual([
      ['merge', 'pr', 'https://github.com/a/b/pull/13'],
      ['close', 'issue', 'https://github.com/a/b/issues/31'],
    ]);
    // Two REST merges, one `"merged": true`: which one is unknown, so neither is recorded.
    expect(
      effectsOf(
        bash(
          'curl -s -X PUT https://api.github.com/repos/a/b/pulls/12/merge; curl -s -X PUT https://api.github.com/repos/a/b/pulls/13/merge',
          '{"message":"Pull Request is not mergeable"}\n{"sha":"abc","merged":true,"message":"Pull Request successfully merged"}',
        ),
      ),
    ).toEqual([]);
  });

  it('the state of a nested object (a milestone) is not the PR’s state (P1)', () => {
    expect(
      effectsOf(
        bash(
          'gh api -X PATCH repos/a/b/pulls/12 -f title=x',
          '{"number":12,"html_url":"https://github.com/a/b/pull/12","state":"open","milestone":{"state":"closed"}}',
        ),
      ),
    ).toEqual([]);
  });

  it('many writes with many result objects are read in linear time (P2)', () => {
    // Under the 200,000-character command cap: 3,000 creates, and a result with 3,000 PR objects.
    const n = 3000;
    const command = Array.from({ length: n }, () => 'curl -X POST https://api.github.com/repos/a/b/pulls -d @p').join(
      '\n',
    );
    expect(command.length).toBeLessThan(200_000);
    const result = Array.from(
      { length: n },
      (_, i) => `{"number":${i},"html_url":"https://github.com/a/b/pull/${i}"}`,
    ).join('\n');
    const started = Date.now();
    effectsOf(bash(command, result));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('W7 — review round 8 (astra-zhuge)', () => {
  const view = '; gh pr view 12 -R a/b --json url -q .url';
  const url = 'https://github.com/a/b/pull/12';

  it('a Request counts only as the argument of the fetch / urlopen that sends it (P1)', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'const unused = new Request("https://api.github.com/repos/a/b/pulls", {method:"POST"}); fetch("https://api.github.com/repos/a/b/pulls/12").then(r=>r.json()).then(console.log)'`,
          '{"number":12,"html_url":"https://github.com/a/b/pull/12"}',
        ),
      ),
    ).toEqual([]);
    expect(
      effectsOf(
        bash(
          `python3 -c 'import urllib.request as u; print(u.urlopen(u.Request("https://api.github.com/repos/a/b/issues", data=b"{}", method="POST")).read())'`,
          '{"number":90,"html_url":"https://github.com/a/b/issues/90"}',
        ),
      ).map(short),
    ).toEqual([['create', 'issue', 'https://github.com/a/b/issues/90']]);
  });

  it('a `url` inside a body is not the destination when the call names one (P1)', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'axios.post("https://hooks.example.com/x", {url:"https://api.github.com/repos/a/b/pulls"})'${view}`,
          url,
        ),
        bash(
          `python3 -c 'import requests; requests.post("https://hooks.example.com/x", json={"url": "https://api.github.com/repos/a/b/pulls"})'${view}`,
          url,
        ),
      ),
    ).toEqual([]);
  });

  it('a REST merge is proven only by a merge response, not by a read of another merged PR (P1)', () => {
    expect(
      effectsOf(
        bash(
          'curl -s -X PUT https://api.github.com/repos/a/b/pulls/12/merge; gh api repos/a/b/pulls/13',
          '{"message":"Pull Request is not mergeable"}\n{"number":13,"html_url":"https://github.com/a/b/pull/13","merged":true,"state":"closed"}',
        ),
      ),
    ).toEqual([]);
  });

  it('a method spelled inside curl data is not curl’s method (P1)', () => {
    expect(
      effectsOf(
        bash(
          `curl -sG --data-urlencode 'q=method:"POST"' https://api.github.com/repos/a/b/pulls`,
          '[{"number":12,"html_url":"https://github.com/a/b/pull/12"}]',
        ),
        bash(
          `curl -s -d '{"note":"-X POST"}' -X GET https://api.github.com/repos/a/b/pulls`,
          '[{"number":12,"html_url":"https://github.com/a/b/pull/12"}]',
        ),
      ),
    ).toEqual([]);
    // Real methods still count: -X, --request=, an attached -XPOST, httpie's positional method.
    expect(
      effectsOf(
        bash(
          'curl -s -XPOST https://api.github.com/repos/a/b/pulls -d @p',
          '{"number":91,"html_url":"https://github.com/a/b/pull/91"}',
        ),
        bash(
          'curl -s --request=POST https://api.github.com/repos/a/b/issues -d @i',
          '{"number":92,"html_url":"https://github.com/a/b/issues/92"}',
        ),
        bash(
          'http POST https://api.github.com/repos/a/b/pulls title=x',
          '{"number":93,"html_url":"https://github.com/a/b/pull/93"}',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/91'],
      ['create', 'issue', 'https://github.com/a/b/issues/92'],
      ['create', 'pr', 'https://github.com/a/b/pull/93'],
    ]);
  });
});

describe('githubEffectsOf — every spelling of a create', () => {
  it('W4 — gh pr create and gh issue create (the output ends with the new URL)', () => {
    expect(
      effectsOf(
        bash(
          'gh pr create --fill',
          'Creating pull request for feat/x into main in a/b\n\nhttps://github.com/a/b/pull/12\n',
        ),
        bash('gh issue create -R a/b -t x -b y', [{ type: 'text', text: 'https://github.com/a/b/issues/34' }]),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/12'],
      ['create', 'issue', 'https://github.com/a/b/issues/34'],
    ]);
  });

  it('W4 — gh api with an explicit or an implied POST, a METHOD /repos helper, curl --request', () => {
    const issue = '{"number":5,"html_url":"https://github.com/a/b/issues/5","title":"x"}';
    const pr = '{"number":7,"html_url":"https://github.com/a/b/pull/7","user":{"html_url":"https://github.com/bot"}}';
    expect(
      effectsOf(
        bash('gh api -X POST repos/a/b/pulls -f title=x -f head=feat/x -f base=main', pr),
        bash('gh api repos/a/b/issues -f title=x -f body=y --jq "{number, html_url}"', issue),
        bash(
          'node scratch/gh-app.cjs POST /repos/a/b/pulls scratch/pr.json',
          '{"number":8,"html_url":"https://github.com/a/b/pull/8"}',
        ),
        bash(
          'curl -sS --request POST "https://api.github.com/repos/a/b/issues" --data @issue.json | jq -r .html_url',
          'https://github.com/a/b/issues/6',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/7'],
      ['create', 'issue', 'https://github.com/a/b/issues/5'],
      ['create', 'pr', 'https://github.com/a/b/pull/8'],
      ['create', 'issue', 'https://github.com/a/b/issues/6'],
    ]);
  });

  it('W4 — what an interpreter, eval or a substitution runs is read as its own command (review round 2)', () => {
    expect(
      effectsOf(
        bash(
          `bash -lc 'cd x && curl -s -X POST https://api.github.com/repos/a/b/pulls -d @p.json | jq -r .html_url'`,
          'https://github.com/a/b/pull/50',
        ),
        bash('sh -c "gh pr create --fill"', 'https://github.com/a/b/pull/51\n'),
        bash(
          'echo `curl -s -X POST https://api.github.com/repos/a/b/issues -d @i.json | jq -r .html_url`',
          'https://github.com/a/b/issues/52',
        ),
        bash(
          'sudo -E curl -s -X POST https://api.github.com/repos/a/b/issues -d @i.json | jq -r .html_url',
          'https://github.com/a/b/issues/53',
        ),
        bash(
          'timeout 30s curl -s -X POST https://api.github.com/repos/a/b/pulls -d @p.json | jq -r .html_url',
          'https://github.com/a/b/pull/54',
        ),
        bash(
          `node -e 'require("child_process").execSync("curl -s -X POST https://api.github.com/repos/a/b/pulls -d @p.json", {stdio: "inherit"})'`,
          '{"number":55,"html_url":"https://github.com/a/b/pull/55"}',
        ),
        bash(
          `python3 -c 'import requests; r = requests.post("https://api.github.com/repos/a/b/issues", json={"title": "x"}); print(r.json()["html_url"])'`,
          'https://github.com/a/b/issues/56',
        ),
        bash(
          "bash <<'EOF'\ncurl -s -X POST https://api.github.com/repos/a/b/pulls -d @p.json | jq -r .html_url\nEOF",
          'https://github.com/a/b/pull/57',
        ),
        bash(
          'eval "curl -s -X POST https://api.github.com/repos/a/b/pulls -d @p.json" | jq -r .html_url',
          'https://github.com/a/b/pull/58',
        ),
        bash(
          'if curl -sf -X POST https://api.github.com/repos/a/b/issues -d @i.json -o out.json; then jq -r .html_url out.json; fi',
          'https://github.com/a/b/issues/59',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/50'],
      ['create', 'pr', 'https://github.com/a/b/pull/51'],
      ['create', 'issue', 'https://github.com/a/b/issues/52'],
      ['create', 'issue', 'https://github.com/a/b/issues/53'],
      ['create', 'pr', 'https://github.com/a/b/pull/54'],
      ['create', 'pr', 'https://github.com/a/b/pull/55'],
      ['create', 'issue', 'https://github.com/a/b/issues/56'],
      ['create', 'pr', 'https://github.com/a/b/pull/57'],
      ['create', 'pr', 'https://github.com/a/b/pull/58'],
      ['create', 'issue', 'https://github.com/a/b/issues/59'],
    ]);
  });

  it('W4 — the sending calls of code: octokit, https.request, urllib, a quoted method key; and xargs (review round 3)', () => {
    const heredoc = (lang: string, ...lines: string[]) => [`${lang} <<'EOF'`, ...lines, 'EOF'].join('\n');
    expect(
      effectsOf(
        bash(
          heredoc(
            'node',
            'const r = await octokit.request("POST /repos/a/b/issues", { title: "x" });',
            'console.log(r.data.html_url);',
          ),
          'https://github.com/a/b/issues/60',
        ),
        bash(
          heredoc(
            'node',
            'const req = https.request({ hostname: "api.github.com", path: "/repos/a/b/pulls", method: "POST" }, (res) => {',
            '  res.pipe(process.stdout);',
            '});',
          ),
          '{"number":61,"html_url":"https://github.com/a/b/pull/61"}',
        ),
        bash(
          heredoc(
            'python3',
            'import urllib.request',
            'req = urllib.request.urlopen(urllib.request.Request("https://api.github.com/repos/a/b/issues", data=b"{}", method="POST"))',
            'print(json.load(req)["html_url"])',
          ),
          'https://github.com/a/b/issues/62',
        ),
        bash(
          `node -e 'fetch("https://api.github.com/repos/a/b/pulls", {"method": "POST", body: "{}"}).then((r) => r.json()).then((j) => console.log(j.html_url))'`,
          'https://github.com/a/b/pull/63',
        ),
        bash(
          'echo @p.json | xargs -I{} curl -s -X POST https://api.github.com/repos/a/b/pulls -d {} | jq -r .html_url',
          'https://github.com/a/b/pull/64',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'issue', 'https://github.com/a/b/issues/60'],
      ['create', 'pr', 'https://github.com/a/b/pull/61'],
      ['create', 'issue', 'https://github.com/a/b/issues/62'],
      ['create', 'pr', 'https://github.com/a/b/pull/63'],
      ['create', 'pr', 'https://github.com/a/b/pull/64'],
    ]);
  });

  it('W4 — the created object is the one whose number the result gives, not another PR it mentions first', () => {
    const stacked =
      '{"base":{"ref":"feat/x"},"linked":{"html_url":"https://github.com/a/b/pull/12"},"number":13,"html_url":"https://github.com/a/b/pull/13"}';
    expect(effectsOf(bash('gh api -X POST repos/a/b/pulls -f head=feat/y -f base=feat/x', stacked)).map(short)).toEqual(
      [['create', 'pr', 'https://github.com/a/b/pull/13']],
    );
  });

  it('W4 — a node script in a heredoc is code: its fetch POST counts', () => {
    const command = [
      "node <<'EOF'",
      'const r = await fetch("https://api.github.com/repos/a/b/pulls", {',
      '  method: "POST",',
      '  body: JSON.stringify({ title: "x", head: "feat/x", base: "main" }),',
      '});',
      'console.log((await r.json()).html_url);',
      'EOF',
    ].join('\n');
    expect(effectsOf(bash(command, 'https://github.com/a/b/pull/9\n')).map(short)).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/9'],
    ]);
  });

  it('W4 — the GitHub MCP create tools (owner and repo come from the input)', () => {
    expect(
      effectsOf(
        {
          toolName: 'mcp__github__create_pull_request',
          input: { owner: 'a', repo: 'b', title: 'x', head: 'feat/x', base: 'main' },
          result: [{ type: 'text', text: '{"number":21,"html_url":"https://github.com/a/b/pull/21","state":"open"}' }],
        },
        {
          toolName: 'mcp__github__create_issue',
          input: { owner: 'a', repo: 'b', title: 'x' },
          result: '{"number":22,"html_url":"https://github.com/a/b/issues/22"}',
        },
        // The wrong repo in the result is not this call's object.
        {
          toolName: 'mcp__github__create_issue',
          input: { owner: 'a', repo: 'b', title: 'x' },
          result: '{"number":23,"html_url":"https://github.com/c/d/issues/23"}',
        },
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/21'],
      ['create', 'issue', 'https://github.com/a/b/issues/22'],
    ]);
  });
});

describe('githubEffectsOf — merge and close', () => {
  it('W5 — merges proven by their result; the PR comes from the call', () => {
    expect(
      effectsOf(
        bash('gh pr merge 12 --squash -R a/b', '✓ Squashed and merged pull request a/b#12 (feat: x)'),
        bash('gh pr merge https://github.com/a/b/pull/13 --merge', '✓ Merged pull request a/b#13 (fix: y)'),
        bash('gh pr merge 14 --squash', '✓ Squashed and merged pull request a/b#14 (z)'),
        bash(
          'curl -s -X PUT -H "Authorization: Bearer $T" https://api.github.com/repos/a/b/pulls/15/merge -d \'{"merge_method":"squash"}\'',
          '{"sha":"abc","merged":true,"message":"Pull Request successfully merged"}',
        ),
        {
          toolName: 'mcp__github__merge_pull_request',
          input: { owner: 'a', repo: 'b', pull_number: 16, merge_method: 'squash' },
          result: '{"sha":"def","merged":true,"message":"Pull Request successfully merged"}',
        },
      ).map(short),
    ).toEqual([
      ['merge', 'pr', 'https://github.com/a/b/pull/12'],
      ['merge', 'pr', 'https://github.com/a/b/pull/13'],
      ['merge', 'pr', 'https://github.com/a/b/pull/14'],
      ['merge', 'pr', 'https://github.com/a/b/pull/15'],
      ['merge', 'pr', 'https://github.com/a/b/pull/16'],
    ]);
  });

  it('W5 — a merge that did not happen records nothing', () => {
    expect(
      effectsOf(
        bash(
          'curl -s -X PUT https://api.github.com/repos/a/b/pulls/15/merge',
          '{"message":"Pull Request is not mergeable","documentation_url":"https://docs.github.com"}',
        ),
        bash(
          'gh pr merge 12 --squash -R a/b',
          'X Pull request a/b#12 is not mergeable: the base branch policy prohibits the merge.',
          true,
        ),
      ),
    ).toEqual([]);
  });

  it('W5 — closes: gh pr close, gh issue close, PATCH state=closed', () => {
    expect(
      effectsOf(
        bash('gh pr close 12 -R a/b --comment "superseded"', '✓ Closed pull request a/b#12 (feat: x)'),
        bash('gh issue close 30 -R a/b -r completed', '✓ Closed issue a/b#30 (bug)'),
        bash(
          'gh api -X PATCH repos/a/b/issues/31 -f state=closed',
          '{"number":31,"html_url":"https://github.com/a/b/issues/31","state":"closed"}',
        ),
        // A PATCH that edits the title is not a close.
        bash(
          'gh api -X PATCH repos/a/b/pulls/32 -f title=new',
          '{"number":32,"html_url":"https://github.com/a/b/pull/32","state":"open"}',
        ),
      ).map(short),
    ).toEqual([
      ['close', 'pr', 'https://github.com/a/b/pull/12'],
      ['close', 'issue', 'https://github.com/a/b/issues/30'],
      ['close', 'issue', 'https://github.com/a/b/issues/31'],
    ]);
  });
});

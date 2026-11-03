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
  // One leak made its PR and read two PRs of another repo in the same command: the reads' output could have held the
  // object (a body, a projection), so the write is not proven here — the turn-end GitHub check (#833) records it.
  const sharedCall = new Set(['https://github.com/2lab-ai/ui/pull/15']);

  it.each(fixtures.leaks.map((l) => [l.expect, l] as const))('W1 — %s is recorded', (_url, leak) => {
    const effects = effectsOf({ toolName: leak.toolName, input: leak.input, result: leak.result });
    if (sharedCall.has(leak.expect)) {
      expect(effects).toEqual([]);
      return;
    }
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

  it('W3 — a large result is read in linear time (2,000 objects); a listing proves no create', () => {
    const many = Array.from(
      { length: 2000 },
      (_, i) => `{"number":${i},"html_url":"https://github.com/a/b/pull/${i}"}`,
    );
    const started = Date.now();
    expect(effectsOf(bash('gh api -X POST repos/a/b/pulls -f head=x', `[${many.join(',')}]`))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('W3 — githubWritesOf reads only the call, never prose', () => {
    // A read is marked (it makes a create beside it ambiguous) but is not a write.
    expect(githubWritesOf('Bash', { command: 'gh pr list' }).filter((w) => w.op !== 'read')).toEqual([]);
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
          'gh pr merge 12 -R a/b --squash; gh pr merge 13 -R a/b --squash',
          'X Pull request a/b#12 is not mergeable\n✓ Squashed and merged pull request a/b#13 (x)',
        ),
        bash(
          'gh issue close 30 -R a/b; gh issue close 31 -R a/b',
          'X could not close a/b#30\n✓ Closed issue a/b#31 (y)',
        ),
      ).map(short),
      // Two merges (or closes) of one repo in one call: either output could be the other's — neither is proven (a
      // miss, which the turn-end check backs). A single one is proven by its own line (W5).
    ).toEqual([]);
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
          `python3 -c 'import urllib.request as u; r = u.urlopen(u.Request("https://api.github.com/repos/a/b/issues", data=b"{}", method="POST")); print(r.read())'`,
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

describe('W8 — review round 9 (astra-zhuge)', () => {
  const view = '; gh pr view 12 -R a/b --json url -q .url';
  const url = 'https://github.com/a/b/pull/12';
  const list = '[{"number":12,"html_url":"https://github.com/a/b/pull/12"}]';

  it('a destination held in a variable leaves the request unread — a body `url` never stands in for it (P1)', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'const target="https://hooks.example.com/x"; axios.post(target, {url:"https://api.github.com/repos/a/b/pulls"})'${view}`,
          url,
        ),
        bash(
          `python3 -c 'import requests; t="https://hooks.example.com/x"; requests.post(t, json={"url": "https://api.github.com/repos/a/b/pulls"})'${view}`,
          url,
        ),
      ),
    ).toEqual([]);
    // An options object as the first argument, or a Python `url=` keyword, is the destination.
    expect(
      effectsOf(
        bash(
          `python3 -c 'import requests; requests.post(url="https://api.github.com/repos/a/b/issues", json={})'`,
          '{"number":95,"html_url":"https://github.com/a/b/issues/95"}',
        ),
      ).map(short),
    ).toEqual([['create', 'issue', 'https://github.com/a/b/issues/95']]);
  });

  it('an implied POST comes from a parsed data option, not a flag spelled inside a header (P1)', () => {
    expect(
      effectsOf(
        bash("curl -s -H 'X-Example: -d @p' https://api.github.com/repos/a/b/pulls", list),
        bash("gh api -H 'X-Example: -f title=x' repos/a/b/pulls", list),
      ),
    ).toEqual([]);
  });

  it('curl uses its last method option; a bundled -sX is read (P1)', () => {
    expect(
      effectsOf(
        bash('curl -s -X POST -X GET https://api.github.com/repos/a/b/pulls', list),
        bash('curl -sX GET -d q=1 https://api.github.com/repos/a/b/pulls', list),
      ),
    ).toEqual([]);
    expect(
      effectsOf(
        bash(
          'curl -sXPOST https://api.github.com/repos/a/b/pulls -d @p',
          '{"number":96,"html_url":"https://github.com/a/b/pull/96"}',
        ),
      ).map(short),
    ).toEqual([['create', 'pr', 'https://github.com/a/b/pull/96']]);
  });

  it('a fetch that overrides its Request’s options is not read as the Request’s method (P1)', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'fetch(new Request("https://api.github.com/repos/a/b/pulls", {method:"POST"}), {method:"GET"}).then(r=>r.json()).then(console.log)'`,
          list,
        ),
      ),
    ).toEqual([]);
  });
});

describe('W9 — the strict grammar (review round 10, astra-zhuge sweep)', () => {
  const url = 'https://github.com/a/b/pull/12';
  const pr12 = '{"number":12,"html_url":"https://github.com/a/b/pull/12"}';
  const view = '; gh pr view 12 -R a/b --json url -q .url';

  it('a destination is a whole api.github.com URL or /repos path — never one inside another URL or a template', () => {
    expect(
      effectsOf(
        bash(`curl -s -X POST 'https://example.com/r?u=https://api.github.com/repos/a/b/pulls' -d @p${view}`, url),
        bash(
          `node -e 'https.request({ hostname: "example.com", path: "/repos/a/b/pulls", method: "POST" })'${view}`,
          url,
        ),
        bash(`node -e 'fetch("https://api.github.com/repos/a/b/pulls" + "/12/reviews", {method:"POST"})'${view}`, url),
        bash(`node -e 'fetch(\`https://api.github.com/repos/\${o}/b/pulls\`, {method:"POST"})'${view}`, url),
      ),
    ).toEqual([]);
  });

  it('a method must be one literal: an expression, a duplicate, a spread or a third fetch argument is not read', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'fetch("https://api.github.com/repos/a/b/pulls", {method: "POST".replace("POST","GET")})'${view}`,
          url,
        ),
        bash(`node -e 'fetch("https://api.github.com/repos/a/b/pulls", {method:"POST", method:"GET"})'${view}`, url),
        bash(`node -e 'fetch("https://api.github.com/repos/a/b/pulls", {method:"POST", ...o})'${view}`, url),
        bash(`node -e 'fetch("https://api.github.com/repos/a/b/pulls", {}, {method:"POST"})'${view}`, url),
        bash(`node -e 'fetch("https://api.github.com/repos/a/b/pulls", {[k]:"POST"})'${view}`, url),
        bash(
          `python3 -c 'import requests; requests.get("https://api.github.com/repos/a/b/pulls", json={"method": "POST"})'${view}`,
          url,
        ),
      ),
    ).toEqual([]);
  });

  it('curl options are read the way curl reads them; an unknown option or --next leaves the command unread', () => {
    const list = `[${pr12}]`;
    expect(
      effectsOf(
        bash('curl -sGd q=x https://api.github.com/repos/a/b/pulls', list),
        bash('curl -sH --request=POST https://api.github.com/repos/a/b/pulls', list),
        bash('curl --proxy-header --data=x https://api.github.com/repos/a/b/pulls', list),
        bash('curl -d q=x -X HEAD https://api.github.com/repos/a/b/pulls', list),
        bash('curl -X POST https://example.com/x --next https://api.github.com/repos/a/b/pulls', pr12),
        bash('curl --some-new-option -d x https://api.github.com/repos/a/b/pulls', pr12),
        bash('wget -X POST https://api.github.com/repos/a/b/pulls', pr12),
      ),
    ).toEqual([]);
  });

  it('a subprocess string runs only through a shell; execFileSync / spawnSync / subprocess without shell=True do not', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'require("child_process").spawnSync("curl -X POST https://api.github.com/repos/a/b/pulls -d @p")'${view}`,
          url,
        ),
        bash(
          `python3 -c 'import subprocess; subprocess.run("curl -X POST https://api.github.com/repos/a/b/pulls -d @p")'${view}`,
          url,
        ),
      ),
    ).toEqual([]);
    expect(
      effectsOf(
        bash(
          `python3 -c 'import subprocess; subprocess.run("curl -s -X POST https://api.github.com/repos/a/b/issues -d @i", shell=True)'`,
          '{"number":97,"html_url":"https://github.com/a/b/issues/97"}',
        ),
      ).map(short),
    ).toEqual([['create', 'issue', 'https://github.com/a/b/issues/97']]);
  });

  it('a write the command may not run is not read: a branch, the right of ||, after exit, bash -n', () => {
    expect(
      effectsOf(
        bash(`if false; then gh pr create -R a/b --fill; fi; printf '%s\\n' ${url}`, url),
        bash(`false && gh pr create -R a/b --fill; printf '%s\\n' ${url}`, url),
        bash(`true || gh pr create -R a/b --fill; printf '%s\\n' ${url}`, url),
        bash(`bash -n -c 'gh pr create -R a/b --fill'; printf '%s\\n' ${url}`, url),
        bash(`bash -c 'exit 0; gh pr create -R a/b --fill'; printf '%s\\n' ${url}`, url),
      ),
    ).toEqual([]);
    // A setup step before && is certain to have run; so is the command's last && chain.
    expect(
      effectsOf(
        bash('cd repo && T=$(cat tok) && gh pr create --fill', 'https://github.com/a/b/pull/98\n'),
        bash('git push -q && gh pr create --fill', 'https://github.com/a/b/pull/99\n'),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/98'],
      ['create', 'pr', 'https://github.com/a/b/pull/99'],
    ]);
  });

  it('evidence: creates match the result objects one to one; a read beside a create, a listing, "already exists" prove none', () => {
    expect(
      effectsOf(
        bash(
          'gh api repos/a/b/pulls/12; curl -s -X POST https://api.github.com/repos/a/b/pulls -d @p',
          `${pr12}\n{"message":"Validation Failed"}`,
        ),
        bash(
          'gh pr create -R a/b --fill || true',
          'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/a/b/pull/12',
        ),
        bash('gh api -X POST repos/a/b/pulls -f head=x', `[${pr12}]`),
        // A URL and a number from different documents are not one object.
        bash(
          'curl -s -X POST https://api.github.com/repos/a/b/pulls -d @p',
          '{"number":12}\n{"html_url":"https://github.com/a/b/pull/12"}',
        ),
      ),
    ).toEqual([]);
  });

  it('evidence: gh lines count only at a line start; documents that disagree give no state; merged is never closed', () => {
    expect(
      effectsOf(
        bash(
          'gh pr merge 12 -R a/b --squash; gh pr merge 13 -R a/b --squash',
          'X Pull request a/b#12 is not mergeable\n✓ Squashed and merged pull request a/b#13 (Fix incorrectly merged pull request a/b#12)',
        ),
      ).map(short),
      // gh's line counts at a line start only — and with two merges of one repo in the call, not at all.
    ).toEqual([]);
    expect(
      effectsOf(
        bash(
          'gh api repos/a/b/issues/31; gh api -X PATCH repos/a/b/issues/31 -f state=open',
          '{"number":31,"html_url":"https://github.com/a/b/issues/31","state":"closed"}\n{"number":31,"html_url":"https://github.com/a/b/issues/31","state":"open"}',
        ),
        bash(
          'gh api -X PATCH repos/a/b/pulls/12 -f title=x',
          '{"number":12,"html_url":"https://github.com/a/b/pull/12","state":"closed","merged":true}',
        ),
        bash(
          'curl -s -X PUT https://api.github.com/repos/a/b/pulls/12/merge; gh api repos/a/b/pulls/13 --jq "{sha: .merge_commit_sha, merged: .merged}"',
          '{"message":"Pull Request is not mergeable"}\n{"sha":"abc","merged":true}',
        ),
      ),
    ).toEqual([]);
  });
});

describe('W10 — review round 10, the rest of the sweep (astra-zhuge)', () => {
  const U = 'https://github.com/a/b/pull/12';
  const P = 'https://api.github.com/repos/a/b/pulls';
  const pr12 = '{"number":12,"html_url":"https://github.com/a/b/pull/12"}';

  it('code that may not run, or a method that is not the HTTP sender, is not read', () => {
    expect(
      effectsOf(
        bash(`node -e 'const deferred = () => fetch("${P}", {method:"POST"}); console.log("${U}")'`, U),
        bash(`node -e 'function later() { fetch("${P}", {method:"POST"}) } console.log("${U}")'`, U),
        bash(`node -e 'if (false) fetch("${P}", {method:"POST"}); console.log("${U}")'`, U),
        bash(`node -e 'ok && fetch("${P}", {method:"POST"}); console.log("${U}")'`, U),
        bash(`node -e 'const obj = {fetch:()=>{}}; obj.fetch("${P}", {method:"POST"}); console.log("${U}")'`, U),
        bash(`python3 -c 'f = lambda: __import__("requests").post("${P}")\nprint("${U}")'`, U),
        bash(`python3 - <<'EOF'\nimport requests\nif False:\n    requests.post("${P}")\nprint("${U}")\nEOF`, U),
      ),
    ).toEqual([]);
  });

  it('an unknown script, Ruby or Perl code, and quoting the shell grammar does not read are not read', () => {
    expect(
      effectsOf(
        bash(`bash /dev/null POST /repos/a/b/pulls; printf '%s\\n' ${U}`, U),
        bash(`node scratch/gh-app.cjs POST /repos/a/b/pulls body.json`, U),
        bash(`ruby -e 'text = %q{fetch("${P}",{method:"POST"})}; puts "${U}"'`, U),
        bash(`printf '%s\\n' $'example\\'; gh pr create -R a/b --fill;\\n${U}\\n'`, U),
      ),
    ).toEqual([]);
  });

  it('shell structure: a background job, a process substitution, a lazy expansion, an array, a function body, set -n', () => {
    expect(
      effectsOf(
        bash(
          `curl -s file:///dev/null &\nprintf '%s\\n' -X PUT https://api.github.com/repos/a/b/pulls/12/merge '{"sha":"abc","merged":true,"message":"Pull Request successfully merged"}'\nwait`,
          '{"sha":"abc","merged":true,"message":"Pull Request successfully merged"}',
        ),
        bash(`curl file:///dev/null <(printf '%s' -X POST ${P}); printf '%s\\n' ${U}`, U),
        bash(`x=already\n: "\${x:-$(gh pr create -R a/b --fill)}"\nprintf '%s\\n' ${U}`, U),
        bash(`arr=(\n  gh pr create -R a/b --fill\n)\nprintf '%s\\n' ${U}`, U),
        bash(`f() {\n  gh pr create -R a/b --fill\n}\nprintf '%s\\n' ${U}`, U),
        bash(`set -n\ngh pr create -R a/b --fill\nprintf '%s\\n' ${U}`, U),
      ),
    ).toEqual([]);
  });

  it('wrappers that do not run their command, and heredocs the line grammar cannot place, are not read', () => {
    expect(
      effectsOf(
        bash(`command -v gh pr create -R a/b; printf '%s\\n' ${U}`, U),
        bash(`env -S 'echo gh pr create -R a/b --fill'; printf '%s\\n' ${U}`, U),
        bash(`printf '' | xargs -I{} gh pr create -R a/b --fill; printf '%s\\n' ${U}`, U),
        bash(`cat <<'FIRST' <<'SECOND'\ndiscarded\nFIRST\ngh pr create -R a/b --fill\n${U}\nSECOND`, U),
        bash(`printf '%s\\n' 'bash <<EOF' 'gh pr create -R a/b --fill' 'EOF'; printf '%s\\n' ${U}`, U),
        bash(`cat <<\\EOF\ngh pr create -R a/b --fill\n${U}\nEOF`, U),
        bash(`cat <<'END HERE'\ngh pr create -R a/b --fill\n${U}\nEND HERE`, U),
        bash(`bash <<'EOF' </dev/null\ngh pr create -R a/b --fill\nEOF\nprintf '%s\\n' ${U}`, U),
        bash(`gh api --hostname github.example.com -X POST repos/a/b/pulls -f head=x`, pr12),
      ),
    ).toEqual([]);
  });
});

describe('W11 — review round 11 (astra-zhuge, grok-elon)', () => {
  const U = 'https://github.com/a/b/pull/12';
  const P = 'https://api.github.com/repos/a/b/pulls';
  const pr12 = '{"number":12,"html_url":"https://github.com/a/b/pull/12"}';

  it('shell: one control-flow construct makes its level unread; && after a newline keeps its operator; nested levels get no last-chain pass', () => {
    expect(
      effectsOf(
        bash(`false &&\n gh pr create -R a/b --fill\nprintf '%s\\n' ${U}`, U),
        bash(`if false; then echo fi; gh pr create -R a/b --fill; fi; printf '%s\\n' ${U}`, U),
        bash(`{ if false; then gh pr create -R a/b --fill; fi; }; printf '%s\\n' ${U}`, U),
        bash(`f() { gh pr create -R a/b --fill; }; printf '%s\\n' ${U}`, U),
        bash(`cd /nonexistent && gh pr create -R a/b --fill; printf '%s\\n' ${U}`, U),
        bash(`bash -c 'false && gh pr create -R a/b --fill'; printf '%s\\n' ${U}`, U),
        bash(`bash -n <<'EOF'\ngh pr create -R a/b --fill\nEOF\nprintf '%s\\n' ${U}`, U),
        bash(`bash -o noexec -c 'gh pr create -R a/b --fill'; printf '%s\\n' ${U}`, U),
        bash(`command -pv gh pr create -R a/b; printf '%s\\n' ${U}`, U),
      ),
    ).toEqual([]);
  });

  it('code: a condition on the line before, an exit before the call, a shadowed sender', () => {
    expect(
      effectsOf(
        bash(`node -e 'if (false)\nfetch("${P}", {method:"POST"}); console.log("${U}")'`, U),
        bash(`node -e 'false &&\nfetch("${P}", {method:"POST"}); console.log("${U}")'`, U),
        bash(`node -e 'console.log("${U}"); process.exit(0); fetch("${P}", {method:"POST"})'`, U),
        bash(`node -e 'const fetch = () => {}; fetch("${P}", {method:"POST"}); console.log("${U}")'`, U),
        bash(`python3 -c 'requests = None; requests.post("${P}"); print("${U}")'`, U),
      ),
    ).toEqual([]);
  });

  it('clients: urlopen with a timeout or None sends no body; curl --config; https.request options override the URL; a destination needs its slash', () => {
    const list = `[${pr12}]`;
    expect(
      effectsOf(
        bash(`python3 -c 'from urllib.request import urlopen; r = urlopen("${P}", timeout=10); print(r.read())'`, list),
        bash(`python3 -c 'from urllib.request import urlopen; r = urlopen("${P}", None); print(r.read())'`, list),
        bash(`curl --config - -d x ${P}`, pr12),
        bash(`node -e 'https.request("${P}", { hostname: "localhost", method: "POST" })'; printf '%s\\n' ${U}`, U),
        bash(`curl -s -X POST https://api.github.comrepos/a/b/pulls -d @p`, pr12),
        bash(`node -e 'fetch("/repos/a/b/pulls", {method:"POST"})'; printf '%s\\n' ${U}`, U),
      ),
    ).toEqual([]);
  });

  it('receipts: another request to the repo in the call — a PATCH, a read, an issues GET that returns a PR — proves nothing', () => {
    expect(
      effectsOf(
        bash(
          `curl -s -X POST ${P} -d @p; gh api -X PATCH repos/a/b/pulls/12 -f title=x`,
          `{"message":"Validation Failed"}\n{"number":12,"html_url":"https://github.com/a/b/pull/12","state":"open"}`,
        ),
        bash(
          'gh api repos/a/b/issues/30; gh api -X PATCH repos/a/b/issues/30 -f state=closed',
          '{"number":30,"html_url":"https://github.com/a/b/issues/30","state":"closed"}\n{"message":"Not Found"}',
        ),
        bash(
          'gh pr merge 12 -R a/b --squash; gh pr view 12 -R a/b --json body --jq .body',
          'X Pull request a/b#12 is not mergeable\nMerged pull request a/b#12 (quoted in a body)',
        ),
        bash(`gh api repos/a/b/issues/12; curl -s -X POST ${P} -d @p`, `${pr12}\n{"message":"Validation Failed"}`),
      ),
    ).toEqual([]);
    // A create whose title says "already exists" is still a create.
    expect(
      effectsOf(
        bash(
          `curl -s -X POST ${P} -d @p`,
          '{"number":13,"title":"Warn when a branch already exists","html_url":"https://github.com/a/b/pull/13"}',
        ),
      ).map(short),
    ).toEqual([['create', 'pr', 'https://github.com/a/b/pull/13']]);
  });
});

describe('W12 — review round 12 (astra-zhuge)', () => {
  const U = 'https://github.com/a/b/pull/12';
  const P = 'https://api.github.com/repos/a/b/pulls';

  it('env -S, gh --help, a Python one-line suite, a Node request never ended: nothing is written', () => {
    expect(
      effectsOf(
        bash(`env -S true gh pr create -R a/b --fill; printf '%s\\n' ${U}`, U),
        bash(`gh pr create -R a/b --help; printf '%s\\n' ${U}`, U),
        bash(`python3 -c 'import requests\nif False: print(); requests.post("${P}")\nprint("${U}")'`, U),
        bash(
          `node -e 'https.request({ hostname: "api.github.com", path: "/repos/a/b/pulls", method: "POST" }).destroy(); console.log("${U}")'`,
          U,
        ),
      ),
    ).toEqual([]);
  });

  it('malformed JSON is scanned once: 30,000 unclosed openings stay linear (P2)', () => {
    const started = Date.now();
    expect(effectsOf(bash(`curl -s -X POST ${P} -d @p`, '[\n'.repeat(30_000)))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a Node request ended through another object, or destroyed, sends nothing; ended through its own variable, it does', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'const r = https.request("${P}", {method:"POST"}); r.on("error", () => {}); r.destroy(); s.end(); console.log("${U}")'`,
          U,
        ),
      ),
    ).toEqual([]);
    expect(
      effectsOf(
        bash(
          `node -e 'const r = https.request("${P}", {method:"POST"}, (res) => res.pipe(process.stdout)); r.end("{}")'`,
          '{"number":14,"html_url":"https://github.com/a/b/pull/14"}',
        ),
      ).map(short),
    ).toEqual([['create', 'pr', 'https://github.com/a/b/pull/14']]);
  });

  it('an unclosed JSON listing: its elements, one per line, are not objects of the call', () => {
    expect(
      effectsOf(
        bash(
          `curl -s -X POST ${P} -d @p | head -c 200`,
          '[\n  {"number":12,"html_url":"https://github.com/a/b/pull/12"},\n  {"numb',
        ),
      ),
    ).toEqual([]);
  });

  it('a merge or close is proven only as the call’s only request — another repo’s quoted body or projection does not count', () => {
    expect(
      effectsOf(
        bash(
          'gh pr merge 12 -R a/b --squash; gh pr view 13 -R c/d --json body --jq .body',
          'X Pull request a/b#12 is not mergeable\nMerged pull request a/b#12 (quoted)',
        ),
        bash(
          'curl -s -X PUT https://api.github.com/repos/a/b/pulls/12/merge; gh api repos/c/d/pulls/13 --jq "{sha: .merge_commit_sha, merged: .merged, message: \\"Pull Request successfully merged\\"}"',
          '{"message":"Pull Request is not mergeable"}\n{"sha":"abc","merged":true,"message":"Pull Request successfully merged"}',
        ),
      ),
    ).toEqual([]);
  });
});

describe('W13 — review round 13 (fable-zhuge, astra-zhuge)', () => {
  const U = 'https://github.com/a/b/pull/12';
  const P = 'https://api.github.com/repos/a/b/pulls';

  it('linear time: 100k unquoted parentheses and 100k unclosed JSON lines (fable P1)', () => {
    for (const command of [`${'( '.repeat(99_000)} github`, `${'a('.repeat(66_000)} github`]) {
      const started = Date.now();
      githubWritesOf('Bash', { command });
      expect(Date.now() - started).toBeLessThan(500);
    }
    const started = Date.now();
    effectsOf(bash(`curl -s -X POST ${P} -d @p`, '{\n'.repeat(100_000)));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('common spellings read again: set -euo pipefail, `|| exit 1`, a test `[[ … ]]`, require(), a call in arguments, create + gh merge (fable P2)', () => {
    const pr = (n: number) => `https://github.com/a/b/pull/${n}\n`;
    expect(
      effectsOf(
        bash('set -euo pipefail\ngh pr create -R a/b --fill', pr(20)),
        bash('cd repo || exit 1\ngh pr create -R a/b --fill', pr(21)),
        bash(
          `node -e 'const axios = require("axios"); axios.post("${P}", {})'`,
          '{"number":22,"html_url":"https://github.com/a/b/pull/22"}',
        ),
        bash(
          `python3 -c 'import requests; print(requests.post("${P}", json={}).json())'`,
          '{"number":23,"html_url":"https://github.com/a/b/pull/23"}',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/20'],
      ['create', 'pr', 'https://github.com/a/b/pull/21'],
      ['create', 'pr', 'https://github.com/a/b/pull/22'],
      ['create', 'pr', 'https://github.com/a/b/pull/23'],
    ]);
    expect(
      effectsOf(
        bash(
          'gh pr create -R a/b --fill && gh pr merge 24 -R a/b --squash',
          'https://github.com/a/b/pull/24\n✓ Squashed and merged pull request a/b#24 (x)',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/24'],
      ['merge', 'pr', 'https://github.com/a/b/pull/24'],
    ]);
    // `set -n` still stops execution; the right of `||` is still never read.
    expect(
      effectsOf(
        bash(`set -n\ngh pr create -R a/b --fill\nprintf '%s\\n' ${U}`, U),
        bash(`true || gh pr create -R a/b --fill; printf '%s\\n' ${U}`, U),
      ),
    ).toEqual([]);
  });

  it('a Node request ended only in a branch, a callback or after destroy sends nothing; another repo’s body URL proves no create (astra)', () => {
    expect(
      effectsOf(
        bash(`node -e 'const r = https.request("${P}", {method:"POST"}); if (false) r.end(); console.log("${U}")'`, U),
        bash(
          `node -e 'const r = https.request("${P}", {method:"POST"}); const later = () => r.end(); console.log("${U}")'`,
          U,
        ),
        bash(
          `node -e 'const r = https.request("${P}", {method:"POST"}); r.destroy(); r.end(); console.log("${U}")'`,
          U,
        ),
        bash(
          `curl -s -X POST ${P} -d @p; gh pr view 13 -R c/d --json body --jq .body`,
          `{"message":"Validation Failed"}\n${U}`,
        ),
      ),
    ).toEqual([]);
  });
});

describe('W14 — review round 14 (astra-zhuge, fable-zhuge)', () => {
  const U = 'https://github.com/a/b/pull/12';
  const P = 'https://api.github.com/repos/a/b/pulls';

  it('the restored spellings do not reopen false writes (astra)', () => {
    expect(
      effectsOf(
        bash(`printf '%s\\n' ${U}; false || exit 0; gh pr create -R a/b --fill`, U),
        bash(`printf '%s\\n' ${U}; bash -c 'false || exit 1; gh pr create -R a/b --fill'`, U),
        bash(`printf '%s\\n' ${U}; bash -c 'set -e; false; gh pr create -R a/b --fill'`, U),
        bash(`python3 -c 'import requests; g = (requests.post("${P}") for x in []); print("${U}")'`, U),
        bash(`python3 -c 'import requests; [requests.post("${P}") for x in []]; print("${U}")'`, U),
        bash(`python3 -c 'import requests; requests.post("${P}") if False else None; print("${U}")'`, U),
        bash(
          `node -e 'const axios = require("node:util").debuglog("noop"); axios.post("${P}", {}); console.log("${U}")'`,
          U,
        ),
        bash(
          `curl -s -X POST ${P} -d @p; gh api -X PUT repos/a/b/pulls/12/merge --jq '{number:12,html_url:"${U}"}'`,
          `{"message":"Validation Failed"}\n{"number":12,"html_url":"${U}"}`,
        ),
      ),
    ).toEqual([]);
  });

  it('a redirection, a heredoc operator or a bare variable on the client line is not another request (fable P2)', () => {
    const made = (n: number) => `{"number":${n},"html_url":"https://github.com/a/b/pull/${n}"}`;
    expect(
      effectsOf(
        bash(`curl -s -X POST ${P} -d @p.json 2>&1 | jq -c .`, made(30)),
        bash(`curl -s -X POST ${P} -d @- < p.json`, made(31)),
        bash(`curl -s -X POST ${P} -d @- <<'EOF'\n{"title":"x"}\nEOF`, made(32)),
        bash(`gh api -X POST repos/a/b/pulls -f head=x -f base=main 2>/dev/null`, made(33)),
      ).map(short),
    ).toEqual([30, 31, 32, 33].map((n) => ['create', 'pr', `https://github.com/a/b/pull/${n}`]));
    // A bare variable may expand to options (`EXTRA=-XGET`): the command is unread (round 15).
    expect(effectsOf(bash(`curl -s -X POST ${P} -d @p.json "$EXTRA"`, made(34)))).toEqual([]);
  });
});

describe('W15 — review round 15 (astra-zhuge)', () => {
  const U = 'https://github.com/a/b/pull/12';
  const P = 'https://api.github.com/repos/a/b/pulls';

  it('a variable on a client line, a ( … ) subshell, exit 256, a multi-line comprehension or generator: not read', () => {
    expect(
      effectsOf(
        bash(
          `EXTRA=-XGET\ncurl -sS -X POST ${P} "$EXTRA" | jq '.[0]'`,
          '{"number":12,"html_url":"https://github.com/a/b/pull/12"}',
        ),
        bash(`(false || exit 1; gh pr create -R a/b --fill)\nprintf '%s\\n' ${U}`, U),
        bash(`(set -e; false; gh pr create -R a/b --fill)\nprintf '%s\\n' ${U}`, U),
        bash(`printf '%s\\n' ${U}\nfalse || exit 256\ngh pr create -R a/b --fill`, U),
        bash(`python3 -c 'import requests\nx = [requests.post("${P}")\nfor x in []]\nprint("${U}")'`, U),
        bash(`python3 -c 'import requests\ng = (requests.post("${P}")\nfor x in [])\nprint("${U}")'`, U),
      ),
    ).toEqual([]);
    // `|| exit 1` at the top level still lets the rest be read.
    expect(
      effectsOf(bash('cd repo || exit 1\ngh pr create -R a/b --fill', 'https://github.com/a/b/pull/40\n')).map(short),
    ).toEqual([['create', 'pr', 'https://github.com/a/b/pull/40']]);
  });
});

describe('W16 — review round 16 (astra-zhuge)', () => {
  const U = 'https://github.com/a/b/pull/12';
  const P = 'https://api.github.com/repos/a/b/pulls';
  const made = '{"number":12,"html_url":"https://github.com/a/b/pull/12"}';

  it('an unquoted $VAR value, `time ( … )`, a Python `\\` continuation, a require continued on the next line: not read', () => {
    expect(
      effectsOf(
        // `$HDR` splits into words: `-H a:b -XGET` turns the request into a GET.
        bash(`HDR='a:b -XGET'\ncurl -sS -X POST ${P} -H $HDR | jq '.[0]'`, made),
        bash(`curl -sS -X POST ${P} -d @p $(printf -- -XGET) | jq '.[0]'`, made),
        bash(`time (false || exit 1; gh pr create -R a/b --fill)\nprintf '%s\\n' ${U}`, U),
        bash(`! (set -e; false; gh pr create -R a/b --fill)\nprintf '%s\\n' ${U}`, U),
        bash(`python3 -c 'import requests\nrequests.post("${P}") \\\nif False else None\nprint("${U}")'`, U),
        bash(`python3 -c 'import requests\nx = 1 if False \\\nelse requests.post("${P}")\nprint("${U}")'`, U),
        bash(
          `node -e 'const execSync = require("child_process")\n.spawnSync;\nexecSync("curl -s -X POST ${P} -d @p");\nconsole.log(${JSON.stringify(made)})'`,
          made,
        ),
      ),
    ).toEqual([]);
  });

  it('a quoted variable, a $(…) inside quotes and a require on its own line still read', () => {
    const made2 = (n: number) => `{"number":${n},"html_url":"https://github.com/a/b/pull/${n}"}`;
    expect(
      effectsOf(
        bash(`curl -s -X POST ${P} -H "Authorization: Bearer $T" -d @p.json`, made2(41)),
        bash(`curl -s -X POST ${P} -H "Authorization: Bearer $(cat t.txt)" -d @p.json`, made2(42)),
        bash(
          `node -e 'const { execSync } = require("child_process");\nexecSync("gh pr create -R a/b --fill", { stdio: "inherit" })'`,
          'https://github.com/a/b/pull/43\n',
        ),
      ).map(short),
    ).toEqual([41, 42, 43].map((n) => ['create', 'pr', `https://github.com/a/b/pull/${n}`]));
  });
});

describe('W17 — review round 17 (fable-zhuge, astra-zhuge)', () => {
  const U = 'https://github.com/a/b/pull/12';
  const P = 'https://api.github.com/repos/a/b/pulls';
  const made = '{"number":12,"html_url":"https://github.com/a/b/pull/12"}';

  it('a require continued after a blank line or by an operator, a `{`-joined Python suite, a for-header body, gh --dry-run / --web, a quoted array splice: not read', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'const execSync = require("child_process")\n\n.spawnSync;\nexecSync("curl -s -X POST ${P} -d @p");\nconsole.log(${JSON.stringify(made)})'`,
          made,
        ),
        bash(
          `node -e 'const execSync = require("child_process")\n&& ((c) => console.log(${JSON.stringify(made)}));\nexecSync("curl -s -X POST ${P} -d @p")'`,
          made,
        ),
        bash(
          `python3 -c 'import requests\nif False: d = {\n}; requests.post("${P}")\nprint(${JSON.stringify(made)})'`,
          made,
        ),
        bash(
          `python3 -c 'import requests\nif False:\n    d = {\n}; requests.post("${P}")\nprint(${JSON.stringify(made)})'`,
          made,
        ),
        bash(
          `python3 -c 'import requests\nfor _ in []: d = {\n}; requests.post("${P}")\nprint(${JSON.stringify(made)})'`,
          made,
        ),
        bash(
          `node -e 'for (let i = 0; i < 0; i++) fetch("${P}", {method: "POST"});\nconsole.log(${JSON.stringify(made)})'`,
          made,
        ),
        bash(
          'gh pr create -R a/b --title t --body-file body.md --dry-run',
          `Would have created a Pull Request with:\ntitle:\tt\nbody:\nSee also\n${U}\n`,
        ),
        bash('gh pr create --web --fill', `Opening ${U} in your browser.\n`),
        bash(`curl -X POST ${P} -H "\${H[@]}" -d @p`, made),
        bash(`curl -X POST ${P} -H "$@" -d @p`, made),
        // grok-elon round 16 P2: a subshell glued to `{` or to a word.
        bash(`{(false || exit 1; gh pr create -R a/b --fill; );}; printf '%s\\n' ${U}`, U),
        bash(`time(false || exit 1; gh pr create -R a/b --fill); printf '%s\\n' ${U}`, U),
        bash(`{(false || exit 1; curl -s -X POST ${P} -d @p.json; );}`, made),
        // fable-zhuge round 17 P3: `"${!arr[@]}"` expands to the indices, several words.
        bash(`curl -X POST ${P} -H "\${!H[@]}" -d @p`, made),
      ),
    ).toEqual([]);
    // fable-zhuge round 18 P2-1: a flag word inside a quoted title is the title, not the flag.
    expect(
      effectsOf(
        bash('gh pr create -R a/b --title "feat(cli): add a --dry-run flag" --body "use -w" --fill', `${U}\n`),
      ).map(short),
    ).toEqual([['create', 'pr', U]]);
  });

  it('a require on its own line still binds; a GitHub MCP number that is not a primitive does not throw', () => {
    expect(
      effectsOf(
        bash(
          `node -e 'const { execSync } = require("child_process");\nexecSync("gh pr create -R a/b --fill", { stdio: "inherit" })'`,
          `${U}\n`,
        ),
      ).map(short),
    ).toEqual([['create', 'pr', U]]);
    expect(() =>
      githubWritesOf('mcp__github__create_issue', { owner: 'a', repo: 'b', number: { toString: 0 } }),
    ).not.toThrow();
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

  it('W4 — gh api with an explicit or an implied POST, curl --request (the arguments of a helper script are not read: W10)', () => {
    const issue = '{"number":5,"html_url":"https://github.com/a/b/issues/5","title":"x"}';
    const pr = '{"number":7,"html_url":"https://github.com/a/b/pull/7","user":{"html_url":"https://github.com/bot"}}';
    expect(
      effectsOf(
        bash('gh api -X POST repos/a/b/pulls -f title=x -f head=feat/x -f base=main', pr),
        bash('gh api repos/a/b/issues -f title=x -f body=y --jq "{number, html_url}"', issue),
        bash(
          'curl -sS --request POST "https://api.github.com/repos/a/b/issues" --data @issue.json | jq -r .html_url',
          'https://github.com/a/b/issues/6',
        ),
      ).map(short),
    ).toEqual([
      ['create', 'pr', 'https://github.com/a/b/pull/7'],
      ['create', 'issue', 'https://github.com/a/b/issues/5'],
      ['create', 'issue', 'https://github.com/a/b/issues/6'],
    ]);
  });

  it('W4 — what an interpreter, eval or a substitution runs is read as its own command (review round 2)', () => {
    expect(
      effectsOf(
        bash(
          `bash -lc 'curl -s -X POST https://api.github.com/repos/a/b/pulls -d @p.json | jq -r .html_url'`,
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
    ]);
  });

  it('W4 — the sending calls of code: octokit, https.request, urllib, a quoted method key (review round 3; xargs is not read: W10)', () => {
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
            'req.end();',
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
      ).map(short),
    ).toEqual([
      ['create', 'issue', 'https://github.com/a/b/issues/60'],
      ['create', 'pr', 'https://github.com/a/b/pull/61'],
      ['create', 'issue', 'https://github.com/a/b/issues/62'],
      ['create', 'pr', 'https://github.com/a/b/pull/63'],
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

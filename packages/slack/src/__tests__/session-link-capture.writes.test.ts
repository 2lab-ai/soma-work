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

  it('W3 — githubWritesOf reads only the call, never prose', () => {
    expect(githubWritesOf('Bash', { command: 'gh pr list' })).toEqual([]);
    expect(githubWritesOf('Bash', { command: 'echo "gh pr create"' })).toEqual([]);
    expect(githubWritesOf('Bash', undefined)).toEqual([]);
    expect(githubWritesOf('Read', { file_path: 'x' })).toEqual([]);
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

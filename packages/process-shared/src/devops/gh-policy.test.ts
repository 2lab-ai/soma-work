import { describe, expect, it } from 'vitest';
import {
  classifyGh,
  GH_COMMAND_TABLE,
  GH_POLICY_GH_VERSION,
  type GhClassification,
  type GhPolicyContext,
  normalizeGhApiPath,
} from './gh-policy.js';

// Table tests for the gh allowlist (.prd/16-devops-tools-architecture.md §4).
// Rows tagged RED-n are the loop.md WU1 "RED로 먼저 고정할 것" items.

const ctx: GhPolicyContext = { allowedOwners: ['example-org'] };
const R = ['-R', 'example-org/app'];

type Expect = 'read' | 'write' | 'org-admin-op' | `deny:${string}`;

function outcome(result: GhClassification): Expect {
  return result.kind === 'deny' ? `deny:${result.code}` : result.kind;
}

function check(argv: string[], expected: Expect, context: GhPolicyContext = ctx) {
  const result = classifyGh(argv, context);
  expect(outcome(result), `${argv.join(' ')} -> ${result.reason}`).toBe(expected);
  expect(result.reason.length).toBeGreaterThan(0);
  return result;
}

describe('gh-policy: loop.md WU1 RED items', () => {
  const rows: Array<[string, string[], Expect]> = [
    // RED-1: api -f / -F without -X = POST = write candidate; REST write allowlist is empty.
    ['RED-1 api -f a=b', ['api', 'repos/example-org/app/issues', '-f', 'a=b'], 'deny:api-rest-write-not-allowlisted'],
    ['RED-1 api -F a=1', ['api', 'repos/example-org/app/issues', '-F', 'a=1'], 'deny:api-rest-write-not-allowlisted'],
    [
      'RED-1 api --raw-field',
      ['api', 'repos/example-org/app/issues', '--raw-field', 'a=b'],
      'deny:api-rest-write-not-allowlisted',
    ],
    [
      'RED-1 api --field',
      ['api', 'repos/example-org/app/issues', '--field', 'a=1'],
      'deny:api-rest-write-not-allowlisted',
    ],
    // RED-2: explicit DELETE on a repo.
    [
      'RED-2 api -X DELETE repo',
      ['api', '-X', 'DELETE', '/repos/example-org/app'],
      'deny:api-rest-write-not-allowlisted',
    ],
    [
      'RED-2 api -X PATCH repo',
      ['api', '-X', 'PATCH', 'repos/example-org/app', '-f', 'private=false'],
      'deny:api-rest-write-not-allowlisted',
    ],
    [
      'RED-2 api transfer',
      ['api', '-X', 'POST', 'repos/example-org/app/transfer', '-f', 'new_owner=alice'],
      'deny:api-rest-write-not-allowlisted',
    ],
    // RED-3: graphql, with or without leading slash.
    ['RED-3 api graphql', ['api', 'graphql', '-f', 'query={viewer{login}}'], 'deny:api-graphql'],
    ['RED-3 api /graphql', ['api', '/graphql'], 'deny:api-graphql'],
    ['RED-3 api GraphQL', ['api', 'GraphQL'], 'deny:api-graphql'],
    // RED-4: file / browser / stdin inputs.
    ['RED-4 --body-file', ['pr', 'comment', '1', ...R, '--body-file', 'notes.md'], 'deny:flag-not-allowed'],
    ['RED-4 -F (body-file short)', ['issue', 'comment', '1', ...R, '-F', 'notes.md'], 'deny:flag-not-allowed'],
    ['RED-4 --notes-file', ['release', 'edit', 'v1.0.0', ...R, '--notes-file', 'notes.md'], 'deny:flag-not-allowed'],
    [
      'RED-4 api -F k=@f',
      ['api', '-X', 'GET', 'repos/example-org/app/issues', '-F', 'k=@secret.txt'],
      'deny:flag-value-invalid',
    ],
    ['RED-4 api -F k=@-', ['api', 'repos/example-org/app/issues', '-F', 'k=@-'], 'deny:flag-value-invalid'],
    ['RED-4 api --input', ['api', 'repos/example-org/app/issues', '--input', 'body.json'], 'deny:flag-not-allowed'],
    ['RED-4 api --input -', ['api', 'repos/example-org/app/issues', '--input', '-'], 'deny:flag-not-allowed'],
    [
      'RED-4 -O on an excluded download',
      ['release', 'download', 'v1.0.0', ...R, '-O', 'out.tgz'],
      'deny:subcommand-not-allowed',
    ],
    ['RED-4 -O on an allowed read', ['pr', 'view', '1', ...R, '-O', 'out.txt'], 'deny:flag-not-allowed'],
    ['RED-4 --output', ['run', 'view', '1', ...R, '--output', 'out.txt'], 'deny:flag-not-allowed'],
    ['RED-4 -D/--dir', ['run', 'view', '1', ...R, '--dir', 'out'], 'deny:flag-not-allowed'],
    ['RED-4 --web', ['pr', 'list', ...R, '--web'], 'deny:flag-not-allowed'],
    ['RED-4 -w', ['issue', 'view', '1', ...R, '-w'], 'deny:flag-not-allowed'],
    ['RED-4 workflow run --json', ['workflow', 'run', 'ci.yml', ...R, '--json'], 'deny:flag-not-allowed'],
    ['RED-4 workflow run -F', ['workflow', 'run', 'ci.yml', ...R, '-F', 'k=@f'], 'deny:flag-not-allowed'],
    ['RED-4 --template', ['pr', 'list', ...R, '--template', '{{.}}'], 'deny:flag-not-allowed'],
    ['RED-4 --recover', ['issue', 'create', ...R, '--recover', 'state.json'], 'deny:flag-not-allowed'],
    ['RED-4 --env-file', ['variable', 'set', 'X', ...R, '--env-file', '.env'], 'deny:flag-not-allowed'],
    [
      'RED-4 --attach (2.102.0 file flag)',
      ['pr', 'comment', '1', ...R, '--attach', 'img.png'],
      'deny:flag-not-allowed',
    ],
    ['RED-4 --hostname', ['api', 'user', '--hostname', 'example.test'], 'deny:flag-not-allowed'],
    ['RED-4 value - (body)', ['pr', 'comment', '1', ...R, '--body', '-'], 'deny:stdin-not-allowed'],
    ['RED-4 value - (inline)', ['issue', 'comment', '1', ...R, '--body=-'], 'deny:stdin-not-allowed'],
    ['RED-4 positional -', ['pr', 'view', '-', ...R], 'deny:stdin-not-allowed'],
    // RED-5: release create (uploads trailing positionals) is excluded as a whole.
    ['RED-5 release create v1 ./f', ['release', 'create', 'v1', './f', ...R], 'deny:subcommand-not-allowed'],
    ['RED-5 release create (no files)', ['release', 'create', 'v1', ...R], 'deny:subcommand-not-allowed'],
    ['RED-5 run download', ['run', 'download', '1', ...R], 'deny:subcommand-not-allowed'],
    ['RED-5 release upload', ['release', 'upload', 'v1', 'f', ...R], 'deny:subcommand-not-allowed'],
    ['RED-5 release delete', ['release', 'delete', 'v1', ...R], 'deny:subcommand-not-allowed'],
    ['RED-5 label delete', ['label', 'delete', 'bug', ...R], 'deny:subcommand-not-allowed'],
    // RED-6: positional count over the schema.
    ['RED-6 pr comment two numbers', ['pr', 'comment', '1', '2', ...R, '--body', 'x'], 'deny:positional-count'],
    ['RED-6 pr list with positional', ['pr', 'list', 'extra', ...R], 'deny:positional-count'],
    ['RED-6 issue view no number', ['issue', 'view', ...R], 'deny:positional-count'],
    // RED-8: auth / codespace and other top-level commands outside the allowlist.
    ['RED-8 auth token', ['auth', 'token'], 'deny:command-not-allowed'],
    ['RED-8 cs ssh', ['cs', 'ssh'], 'deny:command-not-allowed'],
    ['RED-8 codespace ssh', ['codespace', 'ssh'], 'deny:command-not-allowed'],
    ['RED-8 secret list', ['secret', 'list', ...R], 'deny:command-not-allowed'],
    ['RED-8 gist view', ['gist', 'view', '1'], 'deny:command-not-allowed'],
    ['RED-8 extension exec', ['extension', 'exec', 'x'], 'deny:command-not-allowed'],
    ['RED-8 alias set', ['alias', 'set', 'x', 'y'], 'deny:command-not-allowed'],
    ['RED-8 config get', ['config', 'get', 'oauth_token'], 'deny:command-not-allowed'],
    ['RED-8 gh as argv[0]', ['gh', 'pr', 'list', ...R], 'deny:command-not-allowed'],
    ['RED-8 --version', ['--version'], 'deny:command-not-allowed'],
    // RED-9: repo context.
    ['RED-9 pr list without -R', ['pr', 'list'], 'deny:scope-required'],
    ['RED-9 issue create without -R', ['issue', 'create', '--title', 't'], 'deny:scope-required'],
    ['RED-9 -R outside allowed owners', ['pr', 'list', '-R', 'other-org/app'], 'deny:owner-not-allowed'],
    ['RED-9 -R with host prefix', ['pr', 'list', '-R', 'github.com/example-org/app'], 'deny:flag-value-invalid'],
    ['RED-9 -R not owner/name', ['pr', 'list', '-R', 'example-org'], 'deny:flag-value-invalid'],
    // RED-10: api path normalization.
    ['RED-10 full URL', ['api', 'https://api.github.com/repos/example-org/app'], 'deny:api-path-invalid'],
    ['RED-10 other scheme', ['api', 'http://example.test/x'], 'deny:api-path-invalid'],
    ['RED-10 ..', ['api', 'repos/example-org/app/../../orgs/other-org'], 'deny:api-path-invalid'],
    ['RED-10 %2F', ['api', 'repos/example-org/app%2F..%2Fother'], 'deny:api-path-invalid'],
    ['RED-10 %2f lowercase', ['api', 'repos/example-org%2fapp'], 'deny:api-path-invalid'],
    ['RED-10 //', ['api', 'repos//example-org/app'], 'deny:api-path-invalid'],
    ['RED-10 leading //', ['api', '//repos/example-org/app'], 'deny:api-path-invalid'],
    ['RED-10 {owner}', ['api', 'repos/{owner}/{repo}/issues'], 'deny:api-path-invalid'],
    ['RED-10 :owner', ['api', 'repos/:owner/:repo/issues'], 'deny:api-path-invalid'],
    ['RED-10 path in query', ['api', 'repos/example-org/app?next=/orgs/other-org'], 'deny:api-path-invalid'],
    ['RED-10 placeholder in query', ['api', 'repos/example-org/app/issues?creator=:owner'], 'deny:api-path-invalid'],
    ['RED-10 backslash', ['api', 'repos\\example-org\\app'], 'deny:api-path-invalid'],
    ['RED-10 whitespace', ['api', 'repos/example-org/app /x'], 'deny:api-path-invalid'],
  ];

  it.each(rows)('%s', (_label, argv, expected) => {
    check(argv, expected);
  });

  it('RED-7 the allowlist has no wildcard command or subcommand, and every subcommand carries a flag table', () => {
    for (const [command, entry] of Object.entries(GH_COMMAND_TABLE)) {
      expect(command).not.toMatch(/[*?]/);
      for (const [subcommand, spec] of Object.entries(entry)) {
        expect(subcommand).not.toMatch(/[*?]/);
        expect(Array.isArray(spec.flags), `${command} ${subcommand}`).toBe(true);
        for (const flag of spec.flags) {
          expect(flag.long).toMatch(/^[a-z][a-z-]*$/);
          if (flag.short !== undefined) expect(flag.short).toMatch(/^[A-Za-z]$/);
        }
        expect(spec.positionals.min).toBeLessThanOrEqual(spec.positionals.max);
      }
    }
    // A wildcard-looking subcommand is just an unknown subcommand.
    check(['pr', '*', ...R], 'deny:subcommand-not-allowed');
    check(['*', 'list'], 'deny:command-not-allowed');
  });
});

describe('gh-policy: allowlist matches §4 items 1, 4 and 5 exactly', () => {
  const READ = [
    'pr view',
    'pr list',
    'pr diff',
    'pr checks',
    'pr status',
    'issue view',
    'issue list',
    'issue status',
    'repo view',
    'repo list',
    'run view',
    'run list',
    'workflow view',
    'workflow list',
    'release view',
    'release list',
    'label list',
    'search repos',
    'search issues',
    'search prs',
    'search code',
    'search commits',
    'org list',
    'cache list',
    'ruleset list',
    'ruleset view',
    'ruleset check',
    'variable list',
    'variable get',
    'project view',
    'project list',
    'project item-list',
    'project field-list',
  ];
  const WRITE = [
    'pr create',
    'pr comment',
    'pr edit',
    'pr merge',
    'pr close',
    'pr reopen',
    'pr ready',
    'pr review',
    'issue create',
    'issue comment',
    'issue edit',
    'issue close',
    'issue reopen',
    'run rerun',
    'run cancel',
    'workflow run',
    'workflow enable',
    'workflow disable',
    'release edit',
    'label create',
    'label edit',
    'variable set',
    'variable delete',
    'cache delete',
  ];

  function tableEntries(kind: 'read' | 'write'): string[] {
    const out: string[] = [];
    for (const [command, entry] of Object.entries(GH_COMMAND_TABLE)) {
      for (const [subcommand, spec] of Object.entries(entry)) {
        if (spec.kind === kind) out.push(`${command} ${subcommand}`);
      }
    }
    return out.sort();
  }

  it('read subcommands', () => {
    expect(tableEntries('read')).toEqual([...READ].sort());
  });

  it('write subcommands', () => {
    expect(tableEntries('write')).toEqual([...WRITE].sort());
  });

  it('top-level commands (plus api, which has its own table)', () => {
    expect([...Object.keys(GH_COMMAND_TABLE), 'api'].sort()).toEqual(
      [
        'pr',
        'issue',
        'repo',
        'run',
        'workflow',
        'release',
        'label',
        'search',
        'org',
        'cache',
        'ruleset',
        'variable',
        'project',
        'api',
      ].sort(),
    );
  });

  it('pins the gh version the flag tables were read from', () => {
    expect(GH_POLICY_GH_VERSION).toBe('2.102.0');
  });
});

describe('gh-policy: allowed commands (one positive row per subcommand)', () => {
  const rows: Array<[string[], 'read' | 'write']> = [
    [['pr', 'view', '12', ...R, '--json', 'title,body', '--jq', '.title'], 'read'],
    [['pr', 'list', ...R, '--state', 'open', '--label', 'bug', '--limit', '200', '--json', 'number'], 'read'],
    [['pr', 'diff', '12', ...R, '--name-only'], 'read'],
    [['pr', 'checks', '12', ...R, '--required'], 'read'],
    [['pr', 'status', ...R], 'read'],
    [['issue', 'view', '3', ...R, '--comments'], 'read'],
    [['issue', 'list', ...R, '--author', 'alice', '--search', 'is:open label:bug'], 'read'],
    [['issue', 'status', ...R], 'read'],
    [['repo', 'view', 'example-org/app', '--json', 'name'], 'read'],
    [['repo', 'list', 'example-org', '--limit', '50'], 'read'],
    [['run', 'view', '123456789', ...R, '--log-failed'], 'read'],
    [['run', 'list', ...R, '--workflow', 'ci.yml', '--status', 'failure'], 'read'],
    [['workflow', 'view', 'ci.yml', ...R, '--yaml'], 'read'],
    [['workflow', 'list', ...R, '--all'], 'read'],
    [['release', 'view', 'v1.2.3', ...R], 'read'],
    [['release', 'view', ...R], 'read'],
    [['release', 'list', ...R, '--exclude-drafts'], 'read'],
    [['label', 'list', ...R, '--search', 'bug'], 'read'],
    [['search', 'repos', 'topic:cli', '--owner', 'example-org'], 'read'],
    [['search', 'issues', 'flaky', 'test', ...R, '--state', 'open'], 'read'],
    [['search', 'prs', '--owner', 'example-org', '--author', 'alice', '--merged'], 'read'],
    [['search', 'code', 'TODO', ...R], 'read'],
    [['search', 'commits', 'fix', '--owner', 'example-org', '--author', 'alice'], 'read'],
    [['org', 'list', '--limit', '10'], 'read'],
    [['cache', 'list', ...R, '-O', 'asc'], 'read'],
    [['ruleset', 'list', ...R], 'read'],
    [['ruleset', 'list', '--org', 'example-org'], 'read'],
    [['ruleset', 'view', '42', ...R], 'read'],
    [['ruleset', 'check', 'main', ...R], 'read'],
    [['variable', 'list', ...R], 'read'],
    [['variable', 'get', 'APP_MODE', '--org', 'example-org'], 'read'],
    [['project', 'view', '1', '--owner', 'example-org'], 'read'],
    [['project', 'list', '--owner', 'example-org'], 'read'],
    [['project', 'item-list', '1', '--owner', 'example-org', '--format', 'json'], 'read'],
    [['project', 'field-list', '1', '--owner', 'example-org'], 'read'],
    [['pr', 'create', ...R, '--title', 'Add x', '--body', 'Details', '--base', 'main', '--head', 'feature/x'], 'write'],
    [['pr', 'comment', '12', ...R, '--body', '@alice please take a look\n- item'], 'write'],
    [['pr', 'edit', '12', ...R, '--add-label', 'bug', '--add-reviewer', 'alice'], 'write'],
    [['pr', 'merge', '12', ...R, '--squash', '--delete-branch'], 'write'],
    [['pr', 'close', '12', ...R, '--comment', 'superseded'], 'write'],
    [['pr', 'reopen', '12', ...R], 'write'],
    [['pr', 'ready', '12', ...R, '--undo'], 'write'],
    [['pr', 'review', '12', ...R, '--approve', '--body', 'LGTM'], 'write'],
    [['issue', 'create', ...R, '--title', 'Bug', '--body', 'Steps', '--label', 'bug,triage'], 'write'],
    [['issue', 'comment', '3', ...R, '--body', 'thanks'], 'write'],
    [['issue', 'edit', '3', ...R, '--remove-label', 'triage'], 'write'],
    [['issue', 'close', '3', ...R, '--reason', 'not planned'], 'write'],
    [['issue', 'reopen', '3', ...R], 'write'],
    [['run', 'rerun', '123456789', ...R, '--failed'], 'write'],
    [['run', 'cancel', '123456789', ...R], 'write'],
    [['workflow', 'run', 'ci.yml', ...R, '--ref', 'main', '-f', 'level=1', '-f', 'mode=fast'], 'write'],
    [['workflow', 'enable', 'ci.yml', ...R], 'write'],
    [['workflow', 'disable', '1234', ...R], 'write'],
    [['release', 'edit', 'v1.2.3', ...R, '--draft=false', '--notes', 'Final notes'], 'write'],
    [['label', 'create', 'bug', ...R, '--color', 'd73a4a', '--description', 'Something is broken'], 'write'],
    [['label', 'edit', 'bug', ...R, '--name', 'defect'], 'write'],
    [['variable', 'set', 'APP_MODE', ...R, '--body', 'fast'], 'write'],
    [['variable', 'set', 'APP_MODE', '--org', 'example-org', '--body', 'fast', '--visibility', 'private'], 'write'],
    [['variable', 'delete', 'APP_MODE', ...R], 'write'],
    [['cache', 'delete', '1234', ...R], 'write'],
    [['cache', 'delete', ...R, '--all'], 'write'],
  ];

  it.each(rows)('%j -> %s', (argv, expected) => {
    const result = check(argv, expected);
    if (result.kind !== 'deny') expect(result.command).toBe(argv[0]);
  });

  it('reports command, subcommand and repo for the card', () => {
    const result = classifyGh(['pr', 'comment', '12', '--repo=example-org/app', '--body', 'x'], ctx);
    expect(result).toMatchObject({ kind: 'write', command: 'pr', subcommand: 'comment', repo: 'example-org/app' });
    expect(classifyGh(['api', 'repos/example-org/app'], ctx)).toMatchObject({
      kind: 'read',
      command: 'api',
      subcommand: null,
      repo: 'example-org/app',
    });
  });

  it('compares owners case-insensitively, as GitHub does', () => {
    check(['pr', 'list', '-R', 'Example-Org/app'], 'read');
    check(['pr', 'list', '-R', 'example-org/app'], 'read', { allowedOwners: ['EXAMPLE-ORG'] });
  });
});

describe('gh-policy: argument schema', () => {
  const rows: Array<[string, string[], Expect]> = [
    // duplicate flags (same flag, long or short spelling)
    ['duplicate -R', ['pr', 'list', ...R, '-R', 'example-org/other'], 'deny:flag-duplicate'],
    ['duplicate -R / --repo', ['pr', 'list', ...R, '--repo', 'example-org/app'], 'deny:flag-duplicate'],
    ['duplicate --label', ['pr', 'list', ...R, '--label', 'a', '--label', 'b'], 'deny:flag-duplicate'],
    ['duplicate --body', ['pr', 'comment', '1', ...R, '--body', 'a', '-b', 'b'], 'deny:flag-duplicate'],
    ['duplicate bool', ['pr', 'merge', '1', ...R, '--squash', '--squash'], 'deny:flag-duplicate'],
    [
      'workflow run -f same key twice',
      ['workflow', 'run', 'ci.yml', ...R, '-f', 'a=1', '-f', 'a=2'],
      'deny:flag-duplicate',
    ],
    ['api -f same key twice', ['api', '-X', 'GET', 'search/issues', '-f', 'q=a', '-f', 'q=b'], 'deny:flag-duplicate'],
    ['api -f and -F same key', ['api', '-X', 'GET', 'search/issues', '-f', 'q=a', '-F', 'q=b'], 'deny:flag-duplicate'],
    // non-canonical flag spellings that pflag would accept differently
    ['-XGET (attached short value)', ['api', '-XGET', 'user'], 'deny:flag-form'],
    ['-X=GET', ['api', '-X=GET', 'user'], 'deny:flag-form'],
    ['combined short bools', ['pr', 'merge', '1', ...R, '-sd'], 'deny:flag-form'],
    ['-- end of flags', ['pr', 'view', ...R, '--', '1'], 'deny:flag-form'],
    ['bool with bogus inline value', ['pr', 'merge', '1', ...R, '--squash=yes'], 'deny:flag-value-invalid'],
    ['missing value at end', ['pr', 'list', ...R, '--label'], 'deny:flag-value-missing'],
    // positional formats: numbers / tags / names only, never URLs or paths
    ['pr URL positional', ['pr', 'view', 'https://github.com/other-org/app/pull/1', ...R], 'deny:positional-invalid'],
    ['pr branch positional', ['pr', 'view', 'feature/x', ...R], 'deny:positional-invalid'],
    ['issue zero', ['issue', 'view', '0', ...R], 'deny:positional-invalid'],
    ['tag with slash', ['release', 'view', 'a/b', ...R], 'deny:positional-invalid'],
    ['tag ..', ['release', 'edit', 'v1..2', ...R, '--notes', 'x'], 'deny:positional-invalid'],
    ['workflow path', ['workflow', 'view', '.github/workflows/ci.yml', ...R], 'deny:positional-invalid'],
    ['repo view other owner', ['repo', 'view', 'other-org/app'], 'deny:owner-not-allowed'],
    ['repo view without repo', ['repo', 'view'], 'deny:positional-count'],
    ['repo view with -R', ['repo', 'view', 'example-org/app', ...R], 'deny:flag-not-allowed'],
    ['repo list other owner', ['repo', 'list', 'other-org'], 'deny:owner-not-allowed'],
    ['variable name with path', ['variable', 'get', '../X', ...R], 'deny:positional-invalid'],
    // value formats
    ['--limit 201', ['pr', 'list', ...R, '--limit', '201'], 'deny:flag-value-invalid'],
    ['--limit 0', ['pr', 'list', ...R, '-L', '0'], 'deny:flag-value-invalid'],
    ['--limit not a number', ['pr', 'list', ...R, '--limit', '10e1'], 'deny:flag-value-invalid'],
    ['--state outside enum', ['pr', 'list', ...R, '--state', 'draft'], 'deny:flag-value-invalid'],
    ['--json with jq-ish value', ['pr', 'list', ...R, '--json', 'title|@sh'], 'deny:flag-value-invalid'],
    [
      '--jq over the length cap',
      ['pr', 'list', ...R, '--json', 'title', '--jq', `.${'a'.repeat(2000)}`],
      'deny:flag-value-invalid',
    ],
    // go-gh pkg/jq compiles with WithEnvironLoader(os.Environ): $ENV / env would print GH_TOKEN.
    ['--jq $ENV', ['pr', 'list', ...R, '--json', 'title', '--jq', '$ENV.GH_TOKEN'], 'deny:flag-value-invalid'],
    ['--jq env', ['pr', 'list', ...R, '--json', 'title', '-q', 'env | .GH_TOKEN | @base64'], 'deny:flag-value-invalid'],
    ['--jq env in string interpolation', ['api', 'user', '--jq', '"\\(env.GH_TOKEN)"'], 'deny:flag-value-invalid'],
    [
      '--head owner:branch',
      ['pr', 'create', ...R, '--title', 't', '--body', 'b', '--head', 'other-org:main'],
      'deny:flag-value-invalid',
    ],
    ['--base ..', ['pr', 'create', ...R, '--title', 't', '--body', 'b', '--base', 'a..b'], 'deny:flag-value-invalid'],
    ['--title with newline', ['issue', 'create', ...R, '--title', 'a\nb'], 'deny:flag-value-invalid'],
    ['NUL in body', ['issue', 'comment', '1', ...R, '--body', 'a\u0000b'], 'deny:argv-invalid'],
    ['--org outside allowed owners', ['variable', 'list', '--org', 'other-org'], 'deny:owner-not-allowed'],
    ['--owner outside allowed owners', ['project', 'list', '--owner', 'other-org'], 'deny:owner-not-allowed'],
    ['--owner @me', ['project', 'list', '--owner', '@me'], 'deny:flag-value-invalid'],
    ['search -R other owner', ['search', 'code', 'x', '-R', 'other-org/app'], 'deny:owner-not-allowed'],
    ['search --owner other owner', ['search', 'repos', 'x', '--owner', 'other-org'], 'deny:owner-not-allowed'],
    // scope rules
    ['variable list without scope', ['variable', 'list'], 'deny:scope-required'],
    ['variable list with -R and --org', ['variable', 'list', ...R, '--org', 'example-org'], 'deny:scope-required'],
    ['project list without --owner', ['project', 'list'], 'deny:scope-required'],
    // variable set reads stdin when --body is missing; stdin is never used.
    ['variable set without --body', ['variable', 'set', 'APP_MODE', ...R], 'deny:required-flag-missing'],
    // excluded on purpose
    ['pr merge --admin', ['pr', 'merge', '1', ...R, '--admin'], 'deny:flag-not-allowed'],
    [
      'pr create --dry-run (may push)',
      ['pr', 'create', ...R, '--title', 't', '--body', 'b', '--dry-run'],
      'deny:flag-not-allowed',
    ],
    ['pr create --fill', ['pr', 'create', ...R, '--fill'], 'deny:flag-not-allowed'],
    ['pr checks --watch', ['pr', 'checks', '1', ...R, '--watch'], 'deny:flag-not-allowed'],
    ['pr comment --edit-last', ['pr', 'comment', '1', ...R, '--edit-last', '--body', 'x'], 'deny:flag-not-allowed'],
    ['--editor', ['issue', 'create', ...R, '--editor'], 'deny:flag-not-allowed'],
    ['--help', ['pr', 'list', ...R, '--help'], 'deny:flag-not-allowed'],
    ['subcommand alias ls', ['pr', 'ls', ...R], 'deny:subcommand-not-allowed'],
    ['ruleset alias rs', ['rs', 'list', ...R], 'deny:command-not-allowed'],
    ['flag before subcommand', ['pr', '-R', 'example-org/app', 'list'], 'deny:subcommand-not-allowed'],
    ['missing subcommand', ['pr'], 'deny:subcommand-not-allowed'],
    ['empty argv', [], 'deny:argv-invalid'],
    // table lookups are own-key only
    ['__proto__ command', ['__proto__', 'list'], 'deny:command-not-allowed'],
    ['toString command', ['toString'], 'deny:command-not-allowed'],
    ['constructor subcommand', ['pr', 'constructor', ...R], 'deny:subcommand-not-allowed'],
    ['__proto__ subcommand', ['issue', '__proto__', ...R], 'deny:subcommand-not-allowed'],
    ['__proto__ flag', ['pr', 'list', ...R, '--__proto__', 'x'], 'deny:flag-not-allowed'],
  ];

  it.each(rows)('%s', (_label, argv, expected) => {
    check(argv, expected);
  });

  it('rejects oversized argv', () => {
    check(['pr', 'list', ...R, ...Array.from({ length: 200 }, () => '--draft')], 'deny:argv-invalid');
    check(['issue', 'comment', '1', ...R, '--body', 'x'.repeat(70_000)], 'deny:argv-invalid');
  });

  it('accepts bool flags as --flag, --flag=true and --flag=false only', () => {
    check(['release', 'edit', 'v1', ...R, '--draft'], 'write');
    check(['release', 'edit', 'v1', ...R, '--draft=true'], 'write');
    check(['release', 'edit', 'v1', ...R, '--draft=false'], 'write');
    check(['release', 'edit', 'v1', ...R, '--draft=0'], 'deny:flag-value-invalid');
  });

  it('accepts a body that starts with a dash or mentions someone', () => {
    check(['pr', 'comment', '1', ...R, '--body', '- [ ] item'], 'write');
    check(['pr', 'comment', '1', ...R, '-b', '@alice ping'], 'write');
  });
});

describe('gh-policy: gh api', () => {
  it('GET is read; method follows gh (explicit -X wins, else POST when a field is present)', () => {
    const plain = check(['api', 'repos/example-org/app/pulls'], 'read');
    expect(plain).toMatchObject({
      command: 'api',
      repo: 'example-org/app',
      api: { method: 'GET', path: '/repos/example-org/app/pulls' },
    });

    const slash = check(['api', '/repos/example-org/app/pulls?state=all&per_page=100', '--paginate'], 'read');
    expect(slash).toMatchObject({
      api: { method: 'GET', path: '/repos/example-org/app/pulls', query: 'state=all&per_page=100' },
    });

    // -X GET turns fields into query parameters (gh api.go: RequestMethodPassed).
    check(['api', '-X', 'GET', 'repos/example-org/app/issues', '-f', 'state=all', '-F', 'per_page=50'], 'read');
    check(['api', 'repos/example-org/app', '--jq', '.full_name'], 'read');
    check(['api', 'rate_limit', '-i'], 'read');
    check(['api', 'repos/example-org/app/issues', '-H', 'Accept: application/vnd.github.raw+json'], 'read');
    check(['api', 'repos/example-org/app/issues', '-H', 'Authorization: token x'], 'deny:flag-value-invalid');
    check(['api', '-X', 'get', 'user'], 'deny:flag-value-invalid');
    check(['api', '-X', 'HEAD', 'user'], 'deny:flag-value-invalid');
    check(['api', 'user', '--verbose'], 'deny:flag-not-allowed');
    check(['api', 'user', '-t', '{{.}}'], 'deny:flag-not-allowed');
    check(['api'], 'deny:positional-count');
    check(['api', 'user', 'extra'], 'deny:positional-count');
  });

  it('checks the owner of repos/* and orgs/* paths', () => {
    check(['api', 'repos/other-org/app/pulls'], 'deny:owner-not-allowed');
    check(['api', 'orgs/other-org/members'], 'deny:owner-not-allowed');
    check(['api', 'orgs/Example-Org/teams'], 'read');
    check(['api', 'repos/example-org'], 'deny:api-path-invalid');
  });

  it('denies credential paths for every method', () => {
    const rows: string[] = [
      'repos/example-org/app/actions/secrets',
      'repos/example-org/app/actions/secrets/public-key',
      'repos/example-org/app/dependabot/secrets',
      'repos/example-org/app/environments/prod/secrets',
      'orgs/example-org/actions/secrets',
      'user/codespaces/secrets',
      'user/keys',
      'user/gpg_keys',
      'user/ssh_signing_keys',
      'authorizations',
      'repos/example-org/app/keys',
      'repos/example-org/app/hooks',
      'orgs/example-org/personal-access-tokens',
      'repos/example-org/app/actions/runners/registration-token',
      'app/installations/1/access_tokens',
      'repos/example-org/app/actions/Secrets',
    ];
    for (const path of rows) {
      check(['api', path], 'deny:api-credential-path');
      check(['api', '-X', 'PUT', path, '-f', 'a=b'], 'deny:api-credential-path');
    }
  });

  it('org membership and collaborator writes point at the dedicated tools', () => {
    const member = check(
      ['api', '-X', 'PUT', 'orgs/example-org/memberships/alice', '-f', 'role=member'],
      'org-admin-op',
    );
    expect(member.reason).toMatch(/gh_org_member/);
    check(['api', '-X', 'DELETE', 'orgs/example-org/members/alice'], 'org-admin-op');
    const collab = check(
      ['api', '-X', 'PUT', 'repos/example-org/app/collaborators/alice', '-f', 'permission=push'],
      'org-admin-op',
    );
    expect(collab.reason).toMatch(/gh_repo_access/);
    // Reading them is an ordinary read.
    check(['api', 'orgs/example-org/memberships/alice'], 'read');
    check(['api', 'repos/example-org/app/collaborators'], 'read');
  });

  it('REST write allowlist is empty by default and matches (method, path pattern, fields) when given', () => {
    check(
      ['api', 'repos/example-org/app/issues/3/labels', '-f', 'labels[]=bug'],
      'deny:api-rest-write-not-allowlisted',
    );
    const withRule: GhPolicyContext = {
      allowedOwners: ['example-org'],
      restWriteAllowlist: [
        { method: 'POST', path: '/repos/{owner}/{repo}/issues/{number}/labels', fields: ['labels[]'] },
      ],
    };
    check(['api', 'repos/example-org/app/issues/3/labels', '-f', 'labels[]=bug'], 'write', withRule);
    check(
      ['api', 'repos/example-org/app/issues/3/labels', '-f', 'other=1'],
      'deny:api-field-not-allowlisted',
      withRule,
    );
    check(
      ['api', '-X', 'PUT', 'repos/example-org/app/issues/3/labels', '-f', 'labels[]=bug'],
      'deny:api-rest-write-not-allowlisted',
      withRule,
    );
    check(
      ['api', 'repos/example-org/app/issues/3/labels/x', '-f', 'labels[]=bug'],
      'deny:api-rest-write-not-allowlisted',
      withRule,
    );
    check(['api', 'repos/other-org/app/issues/3/labels', '-f', 'labels[]=bug'], 'deny:owner-not-allowed', withRule);
  });

  it('normalizeGhApiPath unifies the leading slash and rejects everything else', () => {
    expect(normalizeGhApiPath('repos/example-org/app')).toEqual({
      ok: true,
      path: '/repos/example-org/app',
      segments: ['repos', 'example-org', 'app'],
      query: null,
    });
    expect(normalizeGhApiPath('/repos/example-org/app')).toMatchObject({ ok: true, path: '/repos/example-org/app' });
    for (const bad of ['', '/', 'repos/example-org/app/', 'a/./b', 'a/.../b', 'a#b', 'a?', 'a?b?c', 'a/{b}', 'a/%41']) {
      expect(normalizeGhApiPath(bad).ok, bad).toBe(false);
    }
  });
});

// ── Review round 1 (REVISE) ───────────────────────────────

describe('gh-policy review 1: gh api GET is a path-head allowlist', () => {
  it('reads only under repos/<allowed owner>/<repo>, orgs/<allowed owner> and rate_limit', () => {
    check(['api', 'repos/example-org/app/pulls/1/files'], 'read');
    check(['api', 'orgs/example-org'], 'read');
    check(['api', 'orgs/example-org/repos', '--paginate'], 'read');
    check(['api', 'rate_limit'], 'read');
    const denied = [
      'repositories/123',
      'repositories/123/contents/README.md',
      'organizations/456',
      'organizations/456/repos',
      'user',
      'user/repos',
      'user/orgs',
      'users/alice/repos',
      'search/issues?q=is:open',
      'search/code?q=token',
      'enterprises/example-ent/settings/billing/actions',
      'gists',
      'gists/abc123',
      'notifications',
      'app',
      'installation/repositories',
      'meta',
      'emojis',
      'teams/1/members',
      'networks/example-org/app/events',
    ];
    for (const path of denied) check(['api', path], 'deny:api-path-not-allowlisted');
  });

  it('non-GET outside the allowed heads is denied too', () => {
    check(['api', '-X', 'PUT', 'user/starred/example-org/app'], 'deny:api-path-not-allowlisted');
    check(['api', '-X', 'DELETE', 'gists/abc123'], 'deny:api-path-not-allowlisted');
  });

  it('secret-scanning is a credential segment (alerts return the secret)', () => {
    check(['api', 'repos/example-org/app/secret-scanning/alerts'], 'deny:api-credential-path');
    check(['api', 'repos/example-org/app/secret-scanning/alerts/1/locations'], 'deny:api-credential-path');
    check(['api', 'orgs/example-org/secret-scanning/alerts'], 'deny:api-credential-path');
    check(['api', 'enterprises/example-ent/secret-scanning/alerts'], 'deny:api-credential-path');
    check(['api', 'repos/example-org/app/Secret-Scanning/alerts'], 'deny:api-credential-path');
  });

  it('private-registries (org registry credentials) is a credential segment', () => {
    check(['api', 'orgs/example-org/private-registries'], 'deny:api-credential-path');
    check(['api', 'orgs/example-org/private-registries/public-key'], 'deny:api-credential-path');
  });
});

describe('gh-policy review 1: every read is owner-scoped', () => {
  const rows: Array<[string, string[], Expect]> = [
    // search needs --owner <allowed> or -R <allowed>/<repo>
    ['search repos unscoped', ['search', 'repos', 'topic:cli'], 'deny:scope-required'],
    ['search issues unscoped', ['search', 'issues', 'flaky'], 'deny:scope-required'],
    ['search prs unscoped', ['search', 'prs', '--author', 'alice'], 'deny:scope-required'],
    ['search code unscoped', ['search', 'code', 'TODO'], 'deny:scope-required'],
    ['search commits unscoped', ['search', 'commits', 'fix'], 'deny:scope-required'],
    ['search issues --owner', ['search', 'issues', 'flaky', '--owner', 'example-org'], 'read'],
    ['search code -R', ['search', 'code', 'TODO', '-R', 'example-org/app'], 'read'],
    // qualifiers in query text widen the scope (GitHub ORs repo/org/user qualifiers)
    [
      'search query repo:other',
      ['search', 'issues', 'repo:other-org/app', '--owner', 'example-org'],
      'deny:owner-not-allowed',
    ],
    [
      'search query org:other',
      ['search', 'code', 'org:other-org', 'x', '-R', 'example-org/app'],
      'deny:owner-not-allowed',
    ],
    ['search query user:other', ['search', 'repos', 'user:alice', '--owner', 'example-org'], 'deny:owner-not-allowed'],
    [
      'search query owner:other',
      ['search', 'prs', 'owner:other-org', '--owner', 'example-org'],
      'deny:owner-not-allowed',
    ],
    [
      'search query REPO: (case)',
      ['search', 'issues', 'REPO:other-org/app', '--owner', 'example-org'],
      'deny:owner-not-allowed',
    ],
    [
      'search positional -repo: (parsed as a flag)',
      ['search', 'issues', '-repo:other-org/app', '--owner', 'example-org'],
      'deny:flag-form',
    ],
    ['--search -repo: (negated)', ['pr', 'list', ...R, '--search', '-repo:other-org/app'], 'deny:owner-not-allowed'],
    [
      'search query (repo:...)',
      ['search', 'issues', '(repo:other-org/app)', '--owner', 'example-org'],
      'deny:owner-not-allowed',
    ],
    [
      'search query quoted value',
      ['search', 'issues', 'repo:"other-org/app"', '--owner', 'example-org'],
      'deny:positional-invalid',
    ],
    ['search query empty value', ['search', 'issues', 'repo:', '--owner', 'example-org'], 'deny:positional-invalid'],
    ['--search quoted value', ['issue', 'list', ...R, '--search', 'org:"other-org"'], 'deny:flag-value-invalid'],
    [
      'search query repo:allowed',
      ['search', 'issues', 'repo:example-org/app', 'is:open', '--owner', 'example-org'],
      'read',
    ],
    ['search query org:allowed', ['search', 'code', 'org:Example-Org', 'x', '-R', 'example-org/app'], 'read'],
    [
      'search query repo: without name',
      ['search', 'issues', 'repo:example-org', '--owner', 'example-org'],
      'deny:positional-invalid',
    ],
    [
      'pr list --search repo:other',
      ['pr', 'list', ...R, '--search', 'is:open repo:other-org/app'],
      'deny:owner-not-allowed',
    ],
    ['issue list --search org:other', ['issue', 'list', ...R, '-S', 'org:other-org'], 'deny:owner-not-allowed'],
    [
      'issue list --search user:',
      ['issue', 'list', ...R, '--search', 'user:other-org label:bug'],
      'deny:owner-not-allowed',
    ],
    ['pr list --search repo:allowed', ['pr', 'list', ...R, '--search', 'repo:example-org/app is:open'], 'read'],
    // repo list needs an allowed owner; status (cross-org aggregate) is gone
    ['repo list without owner', ['repo', 'list'], 'deny:positional-count'],
    ['status', ['status'], 'deny:command-not-allowed'],
    ['status --org', ['status', '--org', 'example-org'], 'deny:command-not-allowed'],
    ['org list stays', ['org', 'list'], 'read'],
  ];

  it.each(rows)('%s', (_label, argv, expected) => {
    check(argv, expected);
  });
});

describe('gh-policy review 1: card-visible text has no invisible or line-breaking unicode', () => {
  const rows: Array<[string, string[], Expect]> = [
    // V.line: Cc, Cf, Zl, Zp
    [
      'title with U+2028 and fake flags',
      ['issue', 'create', ...R, '--title', 'Fix typo\u2028--admin --body ok'],
      'deny:flag-value-invalid',
    ],
    ['title with U+2029', ['pr', 'edit', '1', ...R, '--title', 'a\u2029b'], 'deny:flag-value-invalid'],
    ['title with RLO', ['issue', 'create', ...R, '--title', 'invoice \u202Efdp.exe'], 'deny:flag-value-invalid'],
    ['label with ZWSP', ['pr', 'edit', '1', ...R, '--add-label', 'bug\u200B'], 'deny:flag-value-invalid'],
    [
      'milestone with isolates',
      ['issue', 'edit', '1', ...R, '--milestone', '\u2066v1\u2069'],
      'deny:flag-value-invalid',
    ],
    ['label positional with BOM', ['label', 'create', '\uFEFFbug', ...R], 'deny:positional-invalid'],
    [
      'search term with soft hyphen (Cf)',
      ['search', 'issues', 'fl\u00ADaky', '--owner', 'example-org'],
      'deny:positional-invalid',
    ],
    ['description with LRM', ['label', 'edit', 'bug', ...R, '--description', 'x\u200Ey'], 'deny:flag-value-invalid'],
    // V.text: NUL (argv-level), bidi, zero-width, U+2028/2029; newlines and tabs stay allowed
    ['body with RLO', ['pr', 'comment', '1', ...R, '--body', 'see \u202Eevil'], 'deny:flag-value-invalid'],
    ['body with LRI', ['issue', 'comment', '1', ...R, '--body', '\u2066x\u2069'], 'deny:flag-value-invalid'],
    ['body with ZWSP', ['issue', 'comment', '1', ...R, '--body', 'a\u200Bb'], 'deny:flag-value-invalid'],
    ['body with ZWNJ', ['issue', 'comment', '1', ...R, '--body', 'a\u200Cb'], 'deny:flag-value-invalid'],
    ['body with word joiner', ['issue', 'comment', '1', ...R, '--body', 'a\u2060b'], 'deny:flag-value-invalid'],
    ['body with BOM', ['issue', 'comment', '1', ...R, '--body', '\uFEFFhello'], 'deny:flag-value-invalid'],
    ['body with U+2028', ['pr', 'comment', '1', ...R, '--body', 'line\u2028--admin'], 'deny:flag-value-invalid'],
    ['notes with U+2029', ['release', 'edit', 'v1', ...R, '--notes', 'a\u2029b'], 'deny:flag-value-invalid'],
    [
      'workflow -f value with RLO',
      ['workflow', 'run', 'ci.yml', ...R, '-f', 'mode=\u202Efast'],
      'deny:flag-value-invalid',
    ],
    ['body with newline and tab', ['pr', 'comment', '1', ...R, '--body', 'line 1\n\tline 2\r\n'], 'write'],
    ['body with emoji and CJK', ['pr', 'comment', '1', ...R, '--body', '확인 부탁 \u{1F680}'], 'write'],
    ['title with CJK', ['issue', 'create', ...R, '--title', '로그인 오류'], 'write'],
  ];

  it.each(rows)('%s', (_label, argv, expected) => {
    check(argv, expected);
  });
});

describe('gh-policy review 1: smaller table fixes', () => {
  it('pr create requires --head (no branch = gh interrogates git and may fork and push)', () => {
    check(['pr', 'create', ...R, '--title', 't', '--body', 'b'], 'deny:required-flag-missing');
    check(['pr', 'create', ...R, '--title', 't', '--body', 'b', '--head', 'feature/x'], 'write');
  });

  it('search code has no --order in gh 2.102.0', () => {
    check(['search', 'code', 'TODO', ...R, '--order', 'asc'], 'deny:flag-not-allowed');
    check(['search', 'issues', 'x', ...R, '--order', 'asc'], 'read');
  });
});

describe('gh-policy merge gate: no write leaves a standing server-side action behind', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  it('pr merge --auto is not allowed (auto-merge would merge later pushes the card never showed)', () => {
    check(['pr', 'merge', '7', ...R, '--auto', '--match-head-commit', SHA], 'deny:flag-not-allowed');
    check(['pr', 'merge', '7', ...R, '--squash', '--auto', '--match-head-commit', SHA], 'deny:flag-not-allowed');
    check(['pr', 'merge', '7', ...R, '--auto=true'], 'deny:flag-not-allowed');
    check(['pr', 'merge', '7', ...R, '--squash', '--match-head-commit', SHA], 'write');
  });

  it('pr merge --disable-auto (cancels a standing auto-merge, merges nothing) stays', () => {
    check(['pr', 'merge', '7', ...R, '--disable-auto'], 'write');
  });

  it('no write subcommand carries --auto or --admin', () => {
    for (const [command, entry] of Object.entries(GH_COMMAND_TABLE)) {
      for (const [subcommand, spec] of Object.entries(entry)) {
        if (spec.kind !== 'write') continue;
        const longs = spec.flags.map((flag) => flag.long);
        expect(longs, `${command} ${subcommand}`).not.toContain('auto');
        expect(longs, `${command} ${subcommand}`).not.toContain('admin');
      }
    }
  });
});

describe('gh-policy review 1: the table is frozen and classifyGh never throws', () => {
  it('deep-freezes the command table', () => {
    expect(Object.isFrozen(GH_COMMAND_TABLE)).toBe(true);
    for (const entry of Object.values(GH_COMMAND_TABLE)) {
      expect(Object.isFrozen(entry)).toBe(true);
      for (const spec of Object.values(entry)) {
        expect(Object.isFrozen(spec)).toBe(true);
        expect(Object.isFrozen(spec.flags)).toBe(true);
        expect(Object.isFrozen(spec.positionals)).toBe(true);
        for (const flag of spec.flags) expect(Object.isFrozen(flag)).toBe(true);
      }
    }
    const table = GH_COMMAND_TABLE as unknown as Record<string, Record<string, Record<string, unknown>>>;
    expect(() => {
      table.pr.list.kind = 'write';
    }).toThrow(TypeError);
    expect(() => {
      table.auth = {};
    }).toThrow(TypeError);
    expect(() => {
      (table.pr.view.flags as unknown as unknown[]).push({ long: 'web', value: null });
    }).toThrow(TypeError);
    check(['pr', 'list', ...R], 'read');
    check(['auth', 'token'], 'deny:command-not-allowed');
  });

  it('a malformed policy context denies instead of throwing', () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      'example-org',
      {},
      { allowedOwners: 'example-org' },
      { allowedOwners: [1] },
      { allowedOwners: [null] },
      { allowedOwners: ['example-org'], restWriteAllowlist: {} },
      { allowedOwners: ['example-org'], restWriteAllowlist: [{ method: 'POST' }] },
      { allowedOwners: ['example-org'], restWriteAllowlist: [{ method: 'POST', path: '/x', fields: 'a' }] },
    ];
    for (const context of bad) {
      for (const argv of [
        ['pr', 'list', ...R],
        ['api', 'repos/example-org/app/issues', '-f', 'a=b'],
      ]) {
        let result: GhClassification | undefined;
        expect(() => {
          result = classifyGh(argv, context as GhPolicyContext);
        }, JSON.stringify(context)).not.toThrow();
        expect(result, JSON.stringify(context)).toMatchObject({ kind: 'deny', code: 'internal-error' });
      }
    }
  });

  it('an argv that throws on access denies instead of throwing', () => {
    const hostile = new Proxy(['pr', 'list', ...R], {
      get(target, key, receiver) {
        if (key === '0') throw new Error('boom');
        return Reflect.get(target, key, receiver);
      },
    });
    let result: GhClassification | undefined;
    expect(() => {
      result = classifyGh(hostile, ctx);
    }).not.toThrow();
    expect(result).toMatchObject({ kind: 'deny', code: 'internal-error' });
    expect(() => classifyGh(undefined as unknown as string[], ctx)).not.toThrow();
    expect(classifyGh(undefined as unknown as string[], ctx)).toMatchObject({ kind: 'deny', code: 'argv-invalid' });
  });

  it('never throws on a seeded random argv corpus', () => {
    const pool = [
      'pr',
      'issue',
      'api',
      'search',
      'repo',
      'list',
      'view',
      'create',
      'code',
      '-R',
      'example-org/app',
      '--repo',
      '-f',
      '-F',
      '-X',
      'GET',
      'POST',
      'repos/example-org/app',
      '--jq',
      '.',
      '--json',
      'title',
      '--body',
      '-',
      '--',
      '--limit',
      '201',
      '1',
      '__proto__',
      'constructor',
      '=',
      '--owner',
      'example-org',
      'repo:x/y',
      '\u2028',
      '',
      'a=b',
      '@x',
      '{owner}',
      '--search',
      'org:other-org',
      '--draft=true',
      '-q',
      'env',
    ];
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 5000; i++) {
      const argv = Array.from({ length: next() % 9 }, () => pool[next() % pool.length]);
      const result = classifyGh(argv, ctx);
      expect(['read', 'write', 'org-admin-op', 'deny']).toContain(result.kind);
    }
  });
});

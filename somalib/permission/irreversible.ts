/**
 * Which tool calls cannot be undone once they run — a deploy, a publish, a
 * destructive command.
 *
 * This only changes how Approve looks on a permission prompt that is ALREADY
 * raised: the dashboard card approves it with a slide, the Slack card's Approve
 * asks once more in a confirm dialog. It never raises a prompt and never blocks
 * a call — the policy (evaluateToolPolicy, the dangerous-rule catalog, bypass
 * mode) decides whether a prompt exists at all, unchanged. A user who told the
 * agent to deploy, or runs in bypass mode, sees nothing new.
 *
 * The label is static catalog text (never a piece of the command), so it is
 * safe on the board every viewer sees and in Slack mrkdwn.
 *
 * Matching is lexical, per shell segment: a false positive costs one slide on a
 * prompt that was asked anyway, a false negative leaves the plain button.
 */

export interface IrreversibleAction {
  /** Stable id, for tests and logs. */
  readonly id: string;
  /** What cannot be undone, in Korean — "prod 배포", "force push". */
  readonly label: string;
}

const act = (id: string, label: string): IrreversibleAction => ({ id, label });

/** Non-Bash tools that are irreversible by name (a Map: no prototype keys). */
const TOOL_ACTIONS: ReadonlyMap<string, IrreversibleAction> = new Map([
  ['mcp__github__merge_pull_request', act('pr-merge', 'PR 머지')],
]);

/** Words that run the next word as the command (`sudo rm …`, `env X=1 npm …`, `npx vercel …`). */
const PREFIX = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'xargs', 'npx', 'bunx', 'nice', 'timeout']);
/** Prefix options that take the next word as their value (`sudo -u deploy rm …`). */
const PREFIX_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-U', '-C', '-h', '-p', '-r', '-t', '-D', '-R']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
};
/** git options that take the next word as their value. */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
/** gh options before the command group that take a value (`gh -R owner/repo pr merge`). */
const GH_VALUE_OPTS = new Set(['-R', '--repo', '--hostname']);
/** npm / pnpm / yarn / bun options that take a value (`pnpm --filter pkg publish`). */
const PM_VALUE_OPTS = new Set([
  '--filter',
  '-F',
  '--prefix',
  '-C',
  '--dir',
  '--cwd',
  '-w',
  '--workspace',
  '--registry',
  '--tag',
  '--access',
  '--otp',
  '--userconfig',
]);
/** Interpreters whose first operand is the script they run (`bash scripts/deploy.sh`). */
const INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'node',
  'python',
  'python3',
  'deno',
  'tsx',
  'ruby',
  'perl',
]);

/** One shell segment as words, from the command word on (prefixes and `X=1` assignments dropped). */
function commandWords(segment: string): string[] {
  const words = segment
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^['"]+|['"]+$/g, ''))
    .filter(Boolean);
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i += 1;
    else if (PREFIX.has(w)) {
      const takes = PREFIX_VALUE_OPTS[w];
      i += 1;
      // sudo -E, env -i, xargs -0 — and sudo -u <user>, whose value is not the command
      while (i < words.length && words[i].startsWith('-')) i += takes?.has(words[i]) ? 2 : 1;
      if (w === 'timeout' && i < words.length) i += 1; // the duration
    } else break;
  }
  return words.slice(i);
}

/** The program's name: no directory, no `@version` (`npx vercel@latest`). */
const base = (w: string | undefined) =>
  (w ?? '')
    .split('/')
    .pop()
    ?.replace(/@[^@]*$/, '') ?? '';
const operands = (args: string[]) => args.filter((a) => !a.startsWith('-'));
/** Operands, skipping the value of each option in `takes` (`--filter pkg`). */
function operandsAfter(args: string[], takes: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) out.push(args[i]);
    else if (takes.has(args[i])) i += 1;
  }
  return out;
}
/** A script whose name says it deploys (`deploy.sh`, `scripts/deploy-prod.mjs`) — a test file never does. */
const isDeployScript = (name: string) =>
  /deploy/i.test(name) &&
  /\.(sh|bash|zsh|py|js|ts|mjs|cjs|rb)$|^deploy/i.test(name) &&
  !/(^|[._-])test|\.(test|spec)\./i.test(name);
/** A short-flag cluster (`-fd`, `-rf`) or long flag that contains the letter / name. */
const hasShort = (args: string[], letter: string) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
const hasLong = (args: string[], ...names: string[]) =>
  args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));

function gitAction(words: string[]): IrreversibleAction | null {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += GIT_VALUE_OPTS.has(words[i]) ? 2 : 1;
  const sub = words[i];
  const args = words.slice(i + 1);
  switch (sub) {
    case 'push': {
      if (hasShort(args, 'n')) return null; // -n: dry run
      const refs = operands(args).slice(1); // the first operand is the remote
      if (
        hasLong(args, '--force', '--force-with-lease', '--force-if-includes') ||
        hasShort(args, 'f') ||
        refs.some((r) => r.startsWith('+'))
      )
        return act('git-force-push', 'force push');
      if (hasLong(args, '--delete') || hasShort(args, 'd') || refs.some((r) => r.startsWith(':')))
        return act('git-push-delete', '원격 브랜치·태그 삭제');
      if (refs.some((r) => /(^|[:/])deploy\//.test(r) || /(^|:)(refs\/heads\/)?(prod|production)$/.test(r)))
        return act('git-push-deploy', '배포 브랜치 push');
      if (hasLong(args, '--tags') || refs.some((r) => /^(refs\/tags\/)?v\d/.test(r)))
        return act('git-push-tag', '릴리스 태그 push');
      return null;
    }
    case 'reset':
      return hasLong(args, '--hard') ? act('git-reset-hard', '커밋 안 된 변경 폐기 (reset --hard)') : null;
    case 'clean':
      return hasShort(args, 'f') || hasLong(args, '--force')
        ? act('git-clean', '추적 안 된 파일 삭제 (git clean)')
        : null;
    case 'branch':
      return hasShort(args, 'D') ||
        ((hasShort(args, 'd') || hasLong(args, '--delete')) && (hasShort(args, 'f') || hasLong(args, '--force')))
        ? act('git-branch-force-delete', '브랜치 강제 삭제')
        : null;
    default:
      return null;
  }
}

function ghAction(words: string[]): IrreversibleAction | null {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += GH_VALUE_OPTS.has(words[i]) ? 2 : 1;
  const [group, verb] = [words[i], words[i + 1]];
  if (group === 'pr' && verb === 'merge') return act('pr-merge', 'PR 머지');
  if (group === 'release' && verb === 'create') return act('release-publish', '릴리스 게시');
  if (group === 'release' && verb === 'delete') return act('release-delete', '릴리스 삭제');
  if (group === 'workflow' && verb === 'run') return act('workflow-run', 'GitHub 워크플로 실행');
  if (group === 'repo' && verb === 'delete') return act('repo-delete', '저장소 삭제');
  return null;
}

/** npm / yarn / pnpm / bun: publish, unpublish, and `run deploy*` / `run release*` scripts. */
function packageManagerAction(words: string[]): IrreversibleAction | null {
  const ops = operandsAfter(words.slice(1), PM_VALUE_OPTS);
  if (ops[0] === 'npm') ops.shift(); // yarn npm publish (Yarn 2+)
  if (ops[0] === 'publish') return act('package-publish', '패키지 게시');
  if (ops[0] === 'unpublish') return act('package-unpublish', '패키지 게시 취소');
  const script = ops[0] === 'run' || ops[0] === 'run-script' ? ops[1] : ops[0];
  if (script && /^(deploy|release)([:_-]|$)/.test(script)) return act('deploy-script', '배포 스크립트 실행');
  return null;
}

function segmentAction(segment: string): IrreversibleAction | null {
  const words = commandWords(segment);
  const cmd = base(words[0]);
  const args = words.slice(1);
  if (hasLong(args, '--dry-run')) return null; // a dry run changes nothing
  const sub = operands(args)[0];
  if (INTERPRETERS.has(cmd)) {
    // `bash -c '…'` is read by irreversibleAction itself; here only `bash scripts/deploy.sh`.
    return sub && !hasShort(args, 'c') && isDeployScript(base(sub)) ? act('deploy-script', '배포 스크립트 실행') : null;
  }
  switch (cmd) {
    case 'git':
      return gitAction(words);
    case 'gh':
      return ghAction(words);
    case 'npm':
    case 'yarn':
    case 'pnpm':
    case 'bun':
      return packageManagerAction(words);
    case 'cargo':
    case 'poetry':
      return sub === 'publish' ? act('package-publish', '패키지 게시') : null;
    case 'twine':
      return sub === 'upload' ? act('package-publish', '패키지 게시') : null;
    case 'gem':
      return sub === 'push' ? act('package-publish', '패키지 게시') : null;
    case 'docker':
    case 'podman': {
      if (sub === 'push') return act('image-push', '컨테이너 이미지 게시');
      const second = operands(args)[1];
      if ((sub === 'system' || sub === 'volume') && (second === 'prune' || second === 'rm'))
        return act('docker-data-delete', 'Docker 데이터 삭제');
      return null;
    }
    case 'vercel':
      if (hasLong(args, '--prod') || sub === 'promote') return act('prod-deploy', 'prod 배포');
      return sub === 'rm' || sub === 'remove' ? act('deploy-delete', '배포 삭제') : null;
    case 'kubectl':
      if (sub === 'delete') return act('k8s-delete', 'Kubernetes 리소스 삭제');
      return sub === 'apply' || sub === 'rollout' || sub === 'replace' || sub === 'scale'
        ? act('k8s-change', 'Kubernetes 배포 변경')
        : null;
    case 'helm':
      return sub === 'install' || sub === 'upgrade' || sub === 'uninstall' || sub === 'rollback'
        ? act('helm-change', 'Helm 배포 변경')
        : null;
    case 'terraform':
    case 'tofu':
      if (sub === 'destroy') return act('infra-destroy', '인프라 삭제');
      return sub === 'apply' ? act('infra-apply', '인프라 적용') : null;
    case 'make':
      return operands(args).some((t) => /^(deploy|release)([:_-]|$)/.test(t))
        ? act('deploy-script', '배포 스크립트 실행')
        : null;
    case 'find':
      return args.includes('-delete') ||
        args.some((a, i) => (a === '-exec' || a === '-execdir') && base(args[i + 1]) === 'rm')
        ? act('find-delete', '파일 일괄 삭제 (find)')
        : null;
    case 'rm':
      return hasShort(args, 'r') || hasShort(args, 'R') || hasLong(args, '--recursive')
        ? act('rm-recursive', '재귀 삭제 (rm -r)')
        : null;
    case 'dd':
      return args.some((a) => a.startsWith('of=')) ? act('disk-overwrite', '디스크 덮어쓰기') : null;
    case 'redis-cli':
      return args.some((a) => /^flush(all|db)$/i.test(a)) ? act('redis-flush', 'Redis 데이터 삭제') : null;
    default:
      if (/^mkfs(\.|$)/.test(cmd)) return act('disk-overwrite', '디스크 덮어쓰기');
      return isDeployScript(cmd) ? act('deploy-script', '배포 스크립트 실행') : null;
  }
}

/** SQL that drops or empties data, sent through a database client (`psql -c`, `mysql -e`, a heredoc). */
const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema)|truncate\s+(table\s+)?[A-Za-z_"`])/i;
/** The same, to find where it starts from an index on (`lastIndex`). */
const SQL_DESTRUCTIVE_AT = new RegExp(SQL_DESTRUCTIVE.source, 'gi');
const SQL_CLIENT =
  /(^|[\s;&|(/])(psql|mysql|mariadb|sqlite3|duckdb|clickhouse-client|clickhouse|sqlcmd|cockroach)(\s|$)/;

/**
 * The irreversible action this tool call performs, or null.
 *
 * Bash: a `\` line continuation is joined; a heredoc body is blanked (read as
 * commands only when a shell or ssh reads it); a shell's `-c '…'` string is read
 * as a command of its own; quoted text is blanked except what runs inside double
 * quotes (`$(…)`, backticks); then the command is split on `&&`, `||`, `;`, `|`,
 * `&`, newlines, parentheses, `$(` and backticks, and each segment is read from
 * its command word (prefixes such as `sudo -u x`, `env X=1`, `timeout 60`
 * skipped); the first match wins. A `--dry-run` changes nothing. Other tools:
 * {@link TOOL_ACTIONS}.
 */
export function irreversibleAction(toolName: string, input: unknown): IrreversibleAction | null {
  if (toolName !== 'Bash') return TOOL_ACTIONS.get(toolName) ?? null;
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined;
  if (typeof command !== 'string' || !command.trim()) return null;
  // This runs while a prompt is being raised and in the dashboard's poller: it must be fast on any input and never
  // throw — a failure only costs the label (the plain Approve button), never the prompt (review 3 P1).
  try {
    return commandAction(command.length > MAX_COMMAND ? command.slice(0, MAX_COMMAND) : command, 0);
  } catch {
    return null;
  }
}

/** How much of a command is read: its head. Every step below is linear in this. */
const MAX_COMMAND = 64 * 1024;
/** At most this many heredocs and `sh -c` strings are followed per level. */
const MAX_NESTED = 16;
/** At most this many heredoc operators are looked at per level — closed or not (review 4: unclosed ones cost a walk). */
const MAX_HEREDOC_TRIES = 16;
/** A shell's `-c` flag (`bash -lc`); the quoted string after it is read as a command of its own. */
const SHELL_C = /(?:^|[^\w-])(?:ba|z|da|k)?sh[ \t]+(?:-[A-Za-z]+[ \t]+){0,4}-[A-Za-z]*c[A-Za-z]*[ \t]+(['"])/g;
/** Where one shell command ends and the next begins: lists, pipes, subshells, `$(…)` and backticks. */
const SEGMENT_BREAK = /&&|\|\||\$\(|[;|\n&()`]/g;
/** A heredoc operator (`<<'EOF'`, `<<-EOF`); its body runs from the next line to a line holding only the tag. */
const HEREDOC_OP = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]{0,63})\1/g;
/** A heredoc fed to a shell runs its body (`bash <<'EOF'`, `ssh host <<'EOF'`). */
const SHELL_WORD = /(^|[\s;&|(])(?:(?:ba|z|da|k)?sh|ssh)(\s|$)/;

/** A character that keeps its meaning when escaped only as text: an escaped separator or quote is never one. */
const SPECIAL = /[\s;|&()`'"$\\<>]/;

/**
 * The command with what is only text blanked out, so prose never reads as a command (review 2): single-quoted
 * strings, double-quoted text (an escaped backtick, a parenthesis, a `;`), and escaped separators or quotes. What
 * runs inside double quotes — `$(…)` and unescaped backticks — stays. `\rm` stays `rm` (review 3). Same length as
 * the input, so an index into the result is an index into the command.
 */
function maskText(s: string): string {
  let out = '';
  let mode: 'none' | 'single' | 'double' = 'none';
  let subst = 0; // $( depth inside double quotes
  let tick = false; // inside an unescaped backtick inside double quotes
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (mode === 'single') {
      if (c === "'") mode = 'none';
      out += c === "'" ? c : ' ';
      continue;
    }
    const live = mode === 'none' || subst > 0 || tick;
    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      out += live && !SPECIAL.test(next) ? ` ${next}` : '  ';
      i++;
      continue;
    }
    if (!live) {
      // plain text inside double quotes
      if (c === '"') mode = 'none';
      else if (c === '$' && s[i + 1] === '(') {
        subst = 1;
        out += '$(';
        i++;
        continue;
      } else if (c === '`') tick = true;
      out += c === '"' || c === '`' ? c : ' ';
      continue;
    }
    if (mode === 'double') {
      if (tick && c === '`') tick = false;
      else if (subst > 0 && c === '(') subst++;
      else if (subst > 0 && c === ')') subst--;
      out += c;
      continue;
    }
    if (c === "'") mode = 'single';
    else if (c === '"') mode = 'double';
    out += c;
  }
  return out;
}

interface Heredoc {
  /** The line it starts on, up to `<<`. */
  lead: string;
  /** The whole line it starts on (`cat <<EOF | psql`). */
  line: string;
  body: string;
}

/**
 * The command with each heredoc body blanked (the `<<` line and the closing tag stay), and the bodies themselves.
 * One forward pass: a body ends at the first line that holds only its tag; an operator with no next line, or no
 * closing tag, is left as it is.
 */
function splitHeredocs(text: string): { text: string; docs: Heredoc[] } {
  const docs: Heredoc[] = [];
  let out = '';
  let pos = 0;
  HEREDOC_OP.lastIndex = 0;
  let tries = 0;
  for (
    let m = HEREDOC_OP.exec(text);
    m && docs.length < MAX_NESTED && tries < MAX_HEREDOC_TRIES;
    m = HEREDOC_OP.exec(text)
  ) {
    tries++;
    if (m.index < pos) continue;
    const lineEnd = text.indexOf('\n', m.index);
    if (lineEnd === -1) break; // no body can follow
    const tag = m[2];
    // The closing line: only the tag (a `)` or `;` may follow). One native scan; the tag is `[A-Za-z_][\w-]*`.
    const closing = new RegExp(`\\n[ \\t]*${tag}[ \\t);]*(?=\\n|$)`, 'g');
    closing.lastIndex = lineEnd;
    const found = closing.exec(text);
    const close = found ? found.index + 1 : -1;
    if (close === -1) {
      HEREDOC_OP.lastIndex = lineEnd + 1;
      continue;
    }
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    docs.push({
      lead: text.slice(lineStart, m.index),
      line: text.slice(lineStart, lineEnd),
      body: text.slice(lineEnd + 1, close),
    });
    out += text.slice(pos, lineEnd + 1);
    pos = close;
    HEREDOC_OP.lastIndex = close;
  }
  return { text: out + text.slice(pos), docs };
}

/** The quoted strings after `sh -c` (up to MAX_NESTED); an unclosed one runs to the end. */
function shellStrings(text: string): string[] {
  const found: string[] = [];
  SHELL_C.lastIndex = 0;
  for (let m = SHELL_C.exec(text); m && found.length < MAX_NESTED; m = SHELL_C.exec(text)) {
    const from = m.index + m[0].length;
    const to = text.indexOf(m[1], from);
    found.push(text.slice(from, to === -1 ? text.length : to));
    if (to === -1) break;
    SHELL_C.lastIndex = to + 1;
  }
  return found;
}

const isSqlRun = (code: string, raw: string) => SQL_CLIENT.test(code) && SQL_DESTRUCTIVE.test(raw);

function commandAction(raw: string, depth: number): IrreversibleAction | null {
  const joined = raw.replace(/\\\r?\n/g, ' '); // a `\` line continuation is one line
  // A heredoc body is input, not commands — unless a shell reads it (`bash <<'EOF'`) or a database client runs it.
  // Either way it is blanked before the command is split, so the prose of a `git commit -m "$(cat <<'EOF' …)"`
  // message never reads as one.
  const { text: command, docs } = splitHeredocs(joined);
  for (const doc of docs) {
    // The body feeds the client on its line: `psql <<SQL`, `cat <<EOF | psql` (review 4).
    if (isSqlRun(maskText(doc.line), doc.body)) return act('db-delete', 'DB 데이터 삭제');
    if (depth < 3 && SHELL_WORD.test(doc.lead)) {
      const hit = commandAction(doc.body, depth + 1);
      if (hit) return hit;
    }
  }
  if (depth < 3) {
    for (const str of shellStrings(command)) {
      const hit = commandAction(str, depth + 1);
      if (hit) return hit;
    }
  }
  // Segments of the masked code, each with its raw text (same indices): the command word comes from the code, the
  // SQL a client runs from the raw text of the same segment (review 3 — never from another segment's grep pattern).
  // A client also runs what is piped into it (`echo "DROP TABLE x" | psql`, review 4): its SQL is read from the
  // whole pipeline it ends, back to the last break that is not a single `|`.
  const code = maskText(command);
  let from = 0;
  let pipeline = 0;
  let sqlAt = -2; // where the pipeline's first destructive SQL starts: -2 not looked yet, -1 none (review 5: once)
  SEGMENT_BREAK.lastIndex = 0;
  for (;;) {
    let m = SEGMENT_BREAK.exec(code);
    // A redirection (`2>&1`, `&>log`) is not a break.
    while (m && m[0] === '&' && (code[m.index - 1] === '>' || code[m.index + 1] === '>')) m = SEGMENT_BREAK.exec(code);
    const to = m ? m.index : code.length;
    const segment = code.slice(from, to);
    const hit = segmentAction(segment);
    if (hit) return hit;
    if (SQL_CLIENT.test(segment)) {
      if (sqlAt === -2) {
        SQL_DESTRUCTIVE_AT.lastIndex = pipeline;
        sqlAt = SQL_DESTRUCTIVE_AT.exec(command)?.index ?? -1;
      }
      if (sqlAt !== -1 && sqlAt < to) return act('db-delete', 'DB 데이터 삭제');
    }
    if (!m) return null;
    from = to + m[0].length;
    if (m[0] !== '|') {
      pipeline = from;
      sqlAt = -2;
    }
  }
}

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

/** Non-Bash tools that are irreversible by name. */
const TOOL_ACTIONS: Readonly<Record<string, IrreversibleAction>> = {
  mcp__github__merge_pull_request: act('pr-merge', 'PR 머지'),
};

/** Words that run the next word as the command (`sudo rm …`, `env X=1 npm …`, `npx vercel …`). */
const PREFIX = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'xargs', 'npx', 'bunx']);
/** git options that take the next word as their value. */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/** One shell segment as words, from the command word on (prefixes and `X=1` assignments dropped). */
function commandWords(segment: string): string[] {
  const words = segment
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/^['"]|['"]$/g, ''));
  let i = 0;
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
    else if (PREFIX.has(words[i])) {
      i += 1;
      while (i < words.length && words[i].startsWith('-')) i += 1; // sudo -E, env -i, xargs -0
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
const flags = (args: string[]) => args.filter((a) => a.startsWith('-'));
const operands = (args: string[]) => args.filter((a) => !a.startsWith('-'));
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
      return hasShort(args, 'D') || (hasLong(args, '--delete') && hasLong(args, '--force'))
        ? act('git-branch-force-delete', '브랜치 강제 삭제')
        : null;
    default:
      return null;
  }
}

function ghAction(words: string[]): IrreversibleAction | null {
  const [, group, verb] = words;
  if (group === 'pr' && verb === 'merge') return act('pr-merge', 'PR 머지');
  if (group === 'release' && verb === 'create') return act('release-publish', '릴리스 게시');
  if (group === 'release' && verb === 'delete') return act('release-delete', '릴리스 삭제');
  if (group === 'workflow' && verb === 'run') return act('workflow-run', 'GitHub 워크플로 실행');
  if (group === 'repo' && verb === 'delete') return act('repo-delete', '저장소 삭제');
  return null;
}

/** npm / yarn / pnpm / bun: publish, unpublish, and `run deploy*` / `run release*` scripts. */
function packageManagerAction(words: string[]): IrreversibleAction | null {
  const ops = operands(words.slice(1));
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
  const sub = operands(args)[0];
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
      return /deploy/i.test(cmd) && /\.(sh|bash|zsh|py|js|ts|mjs)$|^deploy/i.test(cmd)
        ? act('deploy-script', '배포 스크립트 실행')
        : null;
  }
}

/** SQL that drops or empties data, sent through a database client (`psql -c`, `mysql -e`, a heredoc). */
const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema)|truncate\s+(table\s+)?[A-Za-z_"`])/i;
const SQL_CLIENT =
  /(^|[\s;&|(/])(psql|mysql|mariadb|sqlite3|duckdb|clickhouse-client|clickhouse|sqlcmd|cockroach)(\s|$)/;

/**
 * The irreversible action this tool call performs, or null.
 *
 * Bash: the command is split on `&&`, `||`, `;`, `|` and newlines and each
 * segment is read from its command word; the first match wins. Other tools:
 * {@link TOOL_ACTIONS}.
 */
export function irreversibleAction(toolName: string, input: unknown): IrreversibleAction | null {
  if (toolName !== 'Bash') return TOOL_ACTIONS[toolName] ?? null;
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined;
  if (typeof command !== 'string' || !command.trim()) return null;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const hit = segmentAction(segment);
    if (hit) return hit;
  }
  return SQL_DESTRUCTIVE.test(command) && SQL_CLIENT.test(command) ? act('db-delete', 'DB 데이터 삭제') : null;
}

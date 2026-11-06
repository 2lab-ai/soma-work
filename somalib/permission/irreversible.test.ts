/**
 * Which tool calls cannot be undone — the label an already-raised permission
 * prompt shows (dashboard: approve by sliding; Slack: Approve asks once more).
 * The classifier decides nothing about whether a prompt exists.
 */

import { describe, expect, it } from 'vitest';
import { irreversibleAction } from './irreversible';

const bash = (command: string) => irreversibleAction('Bash', { command });
const id = (command: string) => bash(command)?.id ?? null;

describe('irreversibleAction — deploy and publish', () => {
  it.each([
    ['gh pr merge 1287 --merge --repo 2lab-ai/soma-work', 'pr-merge'],
    ['git push origin main:deploy/prod', 'git-push-deploy'],
    ['git push origin HEAD:refs/heads/deploy/dev', 'git-push-deploy'],
    ['git push origin v0.34.0', 'git-push-tag'],
    ['git push --tags', 'git-push-tag'],
    ['npm publish --access public', 'package-publish'],
    ['pnpm publish', 'package-publish'],
    ['yarn npm publish', 'package-publish'],
    ['cargo publish', 'package-publish'],
    ['twine upload dist/*', 'package-publish'],
    ['npm unpublish @2lab.ai/ui@0.34.0', 'package-unpublish'],
    ['npm run deploy:prod', 'deploy-script'],
    ['make release', 'deploy-script'],
    ['./scripts/deploy-prod.sh', 'deploy-script'],
    ['gh release create v1.2.0 --notes x', 'release-publish'],
    ['gh workflow run deploy --ref main -f confirm=deploy', 'workflow-run'],
    ['docker push ghcr.io/2lab-ai/soma:latest', 'image-push'],
    ['npx vercel@latest deploy --prebuilt --prod', 'prod-deploy'],
    ['vercel deploy --prebuilt --prod', 'prod-deploy'],
    ['vercel promote https://x.vercel.app', 'prod-deploy'],
    ['kubectl apply -f k8s/', 'k8s-change'],
    ['helm upgrade soma ./chart', 'helm-change'],
    ['terraform apply -auto-approve', 'infra-apply'],
  ])('%s → %s', (command, expected) => {
    expect(id(command)).toBe(expected);
  });
});

describe('irreversibleAction — destructive', () => {
  it.each([
    ['git push --force origin main', 'git-force-push'],
    ['git push -f', 'git-force-push'],
    ['git push --force-with-lease origin feat/x', 'git-force-push'],
    ['git push origin +main', 'git-force-push'],
    ['git push origin --delete feat/old', 'git-push-delete'],
    ['git push origin :feat/old', 'git-push-delete'],
    ['git reset --hard origin/main', 'git-reset-hard'],
    ['git -C repo clean -fdx', 'git-clean'],
    ['git branch -D feat/x', 'git-branch-force-delete'],
    ['rm -rf ./build', 'rm-recursive'],
    ['sudo rm -R /var/tmp/x', 'rm-recursive'],
    ['find . -name "*.log" | xargs rm -rf', 'rm-recursive'],
    ['dd if=/dev/zero of=/dev/disk4 bs=1m', 'disk-overwrite'],
    ['mkfs.ext4 /dev/sdb1', 'disk-overwrite'],
    ['psql -c "DROP TABLE users"', 'db-delete'],
    ['mysql -e "truncate table sessions"', 'db-delete'],
    ['redis-cli FLUSHALL', 'redis-flush'],
    ['gh repo delete 2lab-ai/tmp --yes', 'repo-delete'],
    ['kubectl delete ns soma', 'k8s-delete'],
    ['terraform destroy', 'infra-destroy'],
    ['docker system prune -af', 'docker-data-delete'],
  ])('%s → %s', (command, expected) => {
    expect(id(command)).toBe(expected);
  });

  it.each([
    // review P2: wrapped, grouped and continued commands
    ["bash -c 'git push --force origin main'", 'git-force-push'],
    ['sh -c "rm -rf /tmp/x"', 'rm-recursive'],
    ['bash -lc "cd ui && npm publish"', 'package-publish'],
    ['(cd packages/ui && npm publish)', 'package-publish'],
    ['(cd repo && git push --force)', 'git-force-push'],
    ['echo $(git push --force origin x)', 'git-force-push'],
    ['git push origin \\\n  main:deploy/prod', 'git-push-deploy'],
    // review P3: option values of prefixes and globals
    ['sudo -u deploy rm -rf /srv/x', 'rm-recursive'],
    ['sudo -u www-data rm -rf /srv/x', 'rm-recursive'],
    ['timeout 600 npm publish', 'package-publish'],
    ['gh -R 2lab-ai/soma-work pr merge 12 --squash', 'pr-merge'],
    ['pnpm --filter @2lab.ai/ui publish', 'package-publish'],
    ['git branch -d -f old', 'git-branch-force-delete'],
    ['bash scripts/deploy.sh prod', 'deploy-script'],
    ['node scripts/deploy-prod.mjs', 'deploy-script'],
    ['find . -name "*.tmp" -delete', 'find-delete'],
    ['find dist -type f -exec rm {} +', 'find-delete'],
    // what runs inside double quotes still runs
    ['echo "done: $(git push --force origin x)"', 'git-force-push'],
    ['echo "tag `git push origin v1.0.0`"', 'git-push-tag'],
    // a heredoc fed to a shell is commands
    ["bash <<'EOF'\ncd repo\ngit push --force origin main\nEOF", 'git-force-push'],
    ['rm -rf "$BUILD_DIR"', 'rm-recursive'],
    ["ssh deploy@host <<'EOF'\nrm -rf /srv/app/releases\nEOF", 'rm-recursive'],
    ['psql "$URL" <<\'SQL\'\nDROP TABLE sessions;\nSQL', 'db-delete'],
    // review 4 P2: SQL piped into a client
    ['cat <<EOF | psql\nDROP TABLE x;\nEOF', 'db-delete'],
    ['echo "DROP TABLE users" | psql app', 'db-delete'],
    // review 5: a `2>&1` redirection is not a break
    ['echo "DROP TABLE x" 2>&1 | psql app', 'db-delete'],
    ['psql "$URL" -c "DROP TABLE sessions"', 'db-delete'],
    // review 3 P3: an escaped first letter (alias bypass) still names the command
    ['\\rm -rf node_modules', 'rm-recursive'],
    ['\\git push --force origin main', 'git-force-push'],
  ])('%s → %s', (command, expected) => {
    expect(id(command)).toBe(expected);
  });

  it('a later segment counts: cd && git push --force', () => {
    expect(id('cd repo && git status; git push --force origin feat')).toBe('git-force-push');
  });
});

describe('irreversibleAction — ordinary calls stay plain', () => {
  it.each([
    'git push origin feat/irreversible-approval',
    'git push -u origin main',
    'git status',
    'git reset --soft HEAD~1',
    'git clean -n',
    'git branch -d merged-branch',
    'gh pr create --base main --title x',
    'gh pr view 12',
    'npm ci',
    'npm run build',
    'npm test',
    'rm -f stale.lock',
    'ls -la',
    'echo "npm publish later"',
    'git commit -m "drop table support from the docs"',
    'vercel pull --yes --environment=production',
    'kubectl get pods',
    'terraform plan',
    // review P3: a dry run changes nothing
    'npm publish --dry-run',
    'kubectl apply --dry-run=client -f k8s/',
    'helm upgrade --dry-run soma ./chart',
    'git push -n --force origin main',
    'git push --dry-run origin main:deploy/prod',
    'ssh host uptime',
    'find . -name "*.log"',
    // review 2 P2: quoted prose is text, not commands
    'git commit -m "docs: document \\`rm -rf\\` guard"',
    'git commit -m "feat: add \\`npm publish\\` step"',
    'git commit -m "$(cat <<\'EOF\'\nfix: never \\`git push --force\\`\n\n- `git push --force` is refused\n- run `npm publish` by hand\nEOF\n)"',
    'gh pr comment 12 --body "use \\`gh pr merge\\` after CI"',
    'git commit -m "fix: avoid (rm -rf tmp)"',
    "git commit -m 'fix: avoid (rm -rf tmp); then git push --force'",
    'sed -i "s/(rm -rf)/x/" notes.md',
    'grep -E "(rm -rf|del)" log.txt',
    'echo "a; git push --force"',
    'git commit -m "docs: run psql then DROP TABLE in staging only"',
    // review 3 P3: the SQL must be what the client runs
    "grep -ri 'drop table' migrations && psql -c 'select 1'",
    "cat <<'EOF' > notes.md\nrm -rf build\ngit push --force\nEOF",
    // review 2 P3: test files are not deploy scripts
    'python3 tests/test_deploy.py',
    'node --test src/deploy.test.js',
  ])('%s → null', (command) => {
    expect(bash(command)).toBeNull();
  });

  it('no command, an empty command, or a non-object input → null', () => {
    expect(irreversibleAction('Bash', undefined)).toBeNull();
    expect(irreversibleAction('Bash', { command: '   ' })).toBeNull();
    expect(irreversibleAction('Bash', 'rm -rf /')).toBeNull();
  });

  it('other tools: only the ones named irreversible', () => {
    expect(irreversibleAction('mcp__github__merge_pull_request', { pull_number: 1 })).toEqual({
      id: 'pr-merge',
      label: 'PR 머지',
    });
    expect(irreversibleAction('Edit', { file_path: '/x', old_string: 'a', new_string: 'b' })).toBeNull();
    expect(irreversibleAction('Write', { file_path: '/x', content: 'rm -rf /' })).toBeNull();
    // review P3: no prototype lookups
    expect(irreversibleAction('constructor', {})).toBeNull();
    expect(irreversibleAction('toString', {})).toBeNull();
    expect(irreversibleAction('__proto__', {})).toBeNull();
  });
});

describe('irreversibleAction — never slows or breaks a prompt (review 3 P1)', () => {
  const fast = (command: string) => {
    const t0 = performance.now();
    const hit = bash(command);
    return { hit, ms: performance.now() - t0 };
  };
  it.each([
    ['one 50 KB line', `echo ${'QUJD'.repeat(12_500)} | base64 -d > blob.bin`],
    ['50 KB line ending in a heredoc token', `echo ${'QUJD'.repeat(12_500)} <<EOF`],
    ['50 KB line with a heredoc token mid-line', `echo ${'QUJD'.repeat(6_250)} <<EOF ${'QUJD'.repeat(6_250)}`],
    ['400 heredoc tokens on one line', `${'cat <<EOF '.repeat(400)}`],
    ['6000 heredoc tokens then a newline', `${'cat <<E '.repeat(6_000)}\nls`],
    ['an unterminated 50 KB sh -c string', `bash -c "${'x '.repeat(25_000)}`],
    // review 4 P3: unclosed heredoc operators, one per line
    ['5000 unclosed heredocs', 'cat <<EOF\n'.repeat(5_000)],
    // review 5: one pipeline of 9300 client stages
    ['9300 piped psql stages', 'psql | '.repeat(9_300)],
    ['5000 unclosed heredocs, distinct tags', Array.from({ length: 5_000 }, (_, i) => `cat <<T${i}\n`).join('')],
  ])('%s: under 100 ms', (_name, command) => {
    expect(fast(command).ms).toBeLessThan(100);
  });

  it('a huge command is still read (its head) and never throws', () => {
    expect(bash(`git push --force origin main; echo ${'x'.repeat(200_000)}`)?.id).toBe('git-force-push');
    expect(() => bash('\\'.repeat(10_000))).not.toThrow();
  });
});

describe('irreversibleAction — the label', () => {
  it('is static catalog text, never a piece of the command', () => {
    const hit = bash('git push --force origin <@U123>|*bold*');
    expect(hit).toEqual({ id: 'git-force-push', label: 'force push' });
    expect(bash('psql -c "DROP TABLE <script>"')?.label).toBe('DB 데이터 삭제');
  });
});

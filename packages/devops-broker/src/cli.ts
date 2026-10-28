#!/usr/bin/env node

// soma-devops-broker — holds the devops keys under its own OS user and runs approved requests
// (.prd/16-devops-tools-architecture.md §2, §8). Secrets enter through `ingest` on stdin only; nothing
// this command prints ever contains a secret value.

import * as path from 'node:path';
import { PROTOCOL_VERSION } from '@soma/process-shared/devops/protocol.js';
import { APPROVAL_STATE_FILE, createApprovals, initialApprovalState } from './approval.js';
import { createBroker } from './broker.js';
import { createCloudflareLeases, type LeaseView, loadCfLeaseStores } from './cf-client.js';
import { createGhRunner, type GhRunner } from './gh-runner.js';
import { createGithubAdmin } from './github-admin.js';
import { Ledger } from './ledger.js';
import { brokerPaths } from './paths.js';
import { type BrokerPolicy, formatDuration, loadPolicy } from './policy.js';
import {
  ingestSecret,
  readSecret,
  SECRET_KINDS,
  SecretError,
  type SecretKind,
  SLACK_APP_SECRET_NAME,
  secretFile,
} from './secrets.js';
import { createSlackApi, type SlackApi } from './slack-api.js';
import { StateStore } from './state.js';

/** The pinned gh the installer copies (root-owned); `--gh` overrides it. */
export const DEFAULT_GH_PATH = '/usr/local/libexec/soma-devops/gh';

const USAGE = [
  `usage: soma-devops-broker <command> [--root <dir>]    (broker protocol v${PROTOCOL_VERSION})`,
  '',
  '  serve [--gh <path>]    run the broker (gh default: /usr/local/libexec/soma-devops/gh, must be root-owned)',
  '  ingest <kind> <name>   store a secret piped on stdin (gh <account> | cf <env> | slack broker-app)',
  '  check-policy           validate policy.json and list which secret files are in place (never their values)',
  '',
  '  --root <dir>           data root (default: $SOMA_DEVOPS_ROOT or /usr/local/var/soma-devops)',
].join('\n');

type Args = { command: string | undefined; positional: string[]; root: string | undefined; gh: string | undefined };

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const words: string[] = [];
  let root: string | undefined;
  let gh: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const next = argv[i + 1];
      if (next === undefined || next.length === 0) return { error: '--root needs a directory' };
      root = next;
      i++;
    } else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
      if (root.length === 0) return { error: '--root needs a directory' };
    } else if (arg === '--gh') {
      const next = argv[i + 1];
      if (next === undefined || next.length === 0) return { error: '--gh needs a path' };
      gh = next;
      i++;
    } else if (arg.startsWith('--gh=')) {
      gh = arg.slice('--gh='.length);
      if (gh.length === 0) return { error: '--gh needs a path' };
    } else if (arg === '--help' || arg === '-h') {
      words.unshift('help');
    } else if (arg.startsWith('-')) {
      return { error: `unknown option ${JSON.stringify(arg)}` };
    } else {
      words.push(arg);
    }
  }
  return { command: words[0], positional: words.slice(1), root, gh };
}

function usageError(message: string): number {
  process.stderr.write(`soma-devops-broker: ${message}\n${USAGE}\n`);
  return 2;
}

/** SecretError and system-error messages name files, never values; anything else is reported by type only. */
function describeError(err: unknown): string {
  if (err instanceof SecretError) return err.message;
  if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string') return err.message;
  return err instanceof Error ? `unexpected ${err.name}` : 'unexpected error';
}

async function ingest(args: string[], root: string | undefined): Promise<number> {
  if (args.length !== 2) return usageError('ingest takes <kind> <name>');
  const [kind, name] = args;
  if (!(SECRET_KINDS as readonly string[]).includes(kind)) {
    return usageError(`kind must be one of ${SECRET_KINDS.join(', ')}`);
  }
  const paths = brokerPaths(root);
  try {
    secretFile(paths, kind as SecretKind, name);
  } catch (err) {
    return usageError(describeError(err));
  }
  try {
    const { bytes } = await ingestSecret(paths, kind as SecretKind, name, process.stdin);
    process.stdout.write(`stored ${kind}/${name} (${bytes} bytes)\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`soma-devops-broker: ingest ${kind}/${name} failed: ${describeError(err)}\n`);
    return 1;
  }
}

function expectedSecrets(policy: BrokerPolicy): [SecretKind, string][] {
  return [
    ...Object.keys(policy.gh.accounts).map((name): [SecretKind, string] => ['gh', name]),
    ...Object.keys(policy.cloudflare).map((env): [SecretKind, string] => ['cf', env]),
    ['slack', SLACK_APP_SECRET_NAME],
  ];
}

function checkPolicy(args: string[], root: string | undefined): number {
  if (args.length !== 0) return usageError('check-policy takes no arguments');
  const paths = brokerPaths(root);
  let policy: BrokerPolicy;
  try {
    policy = loadPolicy(paths.policyFile);
  } catch (err) {
    process.stderr.write(
      `soma-devops-broker: policy rejected: ${err instanceof Error ? err.message : 'unexpected error'}\n`,
    );
    return 1;
  }
  const out: string[] = [`policy ${paths.policyFile}: valid`, `admins: ${policy.admins.length}`];
  out.push(`gh org: ${policy.gh.org}; allowed owners: ${policy.gh.allowedOwners.join(', ')}`);
  out.push('gh accounts:');
  for (const [name, account] of Object.entries(policy.gh.accounts)) {
    out.push(`  ${name.padEnd(16)} class=${account.class}`);
  }
  out.push('cloudflare environments:');
  const envs = Object.entries(policy.cloudflare);
  if (envs.length === 0) out.push('  (none)');
  for (const [env, cf] of envs) {
    const zones = Object.keys(cf.zones);
    out.push(
      `  ${env.padEnd(16)} zones: ${zones.length > 0 ? zones.join(', ') : '(account level only)'}; ` +
        `lease ttl default ${formatDuration(cf.defaultTtlSeconds)}, max ${formatDuration(cf.maxTtlSeconds)}`,
    );
  }
  out.push(
    `approval timeout ${formatDuration(policy.approvalTimeoutSeconds)}, at most ${policy.maxPendingApprovals} pending cards`,
  );
  out.push('secret files:');
  let healthy = true;
  for (const [kind, name] of expectedSecrets(policy)) {
    let status: string;
    try {
      readSecret(paths, kind, name);
      status = 'ok';
    } catch (err) {
      healthy = false;
      status = err instanceof SecretError && err.reason === 'missing' ? 'missing' : `bad (${describeError(err)})`;
    }
    out.push(`  ${`${kind}/${name}`.padEnd(24)} ${status}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return healthy ? 0 : 1;
}

function log(line: string): void {
  process.stderr.write(`soma-devops-broker: ${line}\n`);
}

/** Startup errors name files and modes (policy, secrets, gh, run directory), never a secret value. */
function startupError(err: unknown): string {
  return err instanceof Error ? err.message : 'unexpected error';
}

/** A lease the broker could not confirm deleted: tell every admin, best effort (the sweeper retries). */
function notifyRevokeFailed(slack: SlackApi, policy: BrokerPolicy, lease: LeaseView, error: string): void {
  const text =
    `Cloudflare 단기 키 폐기 실패 — 환경 ${lease.env}, lease ${lease.leaseId.slice(0, 8)}…, 만료 ${lease.expiresAt}: ` +
    `${error}. 다음 정리 주기에 다시 시도합니다.`;
  for (const admin of policy.admins) {
    slack
      .openDm(admin)
      .then((channel) => slack.postMessage(channel, { text }))
      .catch((err: unknown) => log(`revoke-failed notice to an admin failed: ${describeError(err)}`));
  }
}

async function serve(args: string[], root: string | undefined, ghPath: string): Promise<number> {
  if (args.length !== 0) return usageError('serve takes no arguments');
  const paths = brokerPaths(root);
  let policy: BrokerPolicy;
  let slackToken: string;
  let ghRunner: GhRunner;
  try {
    policy = loadPolicy(paths.policyFile);
  } catch (err) {
    log(`policy rejected: ${startupError(err)}`);
    return 1;
  }
  try {
    slackToken = readSecret(paths, 'slack', SLACK_APP_SECRET_NAME);
    ghRunner = createGhRunner({ ghPath, ctx: { allowedOwners: policy.gh.allowedOwners, restWriteAllowlist: [] } });
  } catch (err) {
    log(`cannot start: ${startupError(err)}`);
    return 1;
  }
  const ledger = new Ledger(paths.ledgerFile);
  const approvalStore = new StateStore(path.join(paths.stateDir, APPROVAL_STATE_FILE), initialApprovalState());
  let leaseStores: Awaited<ReturnType<typeof loadCfLeaseStores>>;
  try {
    await approvalStore.load();
    leaseStores = await loadCfLeaseStores(paths.stateDir);
  } catch (err) {
    log(`cannot start: ${startupError(err)}`);
    return 1;
  }
  const slack = createSlackApi({ token: slackToken });
  const approvals = createApprovals({ policy, slack, store: approvalStore, ledger, log });
  const cfLeases = createCloudflareLeases({
    policy,
    // Read per operation, so a key rotated with `ingest` takes effect without a restart.
    readForgeKey: (env) => readSecret(paths, 'cf', env),
    store: leaseStores.store,
    tokenStore: leaseStores.tokenStore,
    ledger,
    onRevokeFailed: (lease, error) => notifyRevokeFailed(slack, policy, lease, error),
  });
  const broker = createBroker({
    paths,
    policy,
    readSecret: (kind, name) => readSecret(paths, kind, name),
    ghRunner,
    cfLeases,
    approvals,
    githubAdmin: createGithubAdmin(),
    ledger,
    log,
  });

  const stopped = new Promise<NodeJS.Signals>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  let server: Awaited<ReturnType<typeof broker.listen>>;
  try {
    server = await broker.listen();
  } catch (err) {
    log(`cannot start: ${startupError(err)}`);
    await approvals.close();
    return 1;
  }
  await ledger.append({ event: 'broker.start', protocol: PROTOCOL_VERSION }).catch(() => undefined);
  log(`listening on ${paths.socketPath} (protocol v${PROTOCOL_VERSION})`);
  // Leases a crash left mid-operation (minting, revoking, expired) are handled now, not one interval later.
  cfLeases.sweep().then(
    (r) => log(`startup sweep: ${r.revoked} revoked, ${r.failed} failed, ${r.orphansDeleted} orphans deleted`),
    (err: unknown) => log(`startup sweep failed: ${describeError(err)}`),
  );
  const stopSweeper = cfLeases.startSweeper();

  const signal = await stopped;
  log(`${signal}: no new requests; waiting for running ones`);
  stopSweeper();
  await server.close();
  await approvals.close();
  await ledger.append({ event: 'broker.stop', signal }).catch(() => undefined);
  log('stopped');
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) return usageError(parsed.error);
  if (parsed.gh !== undefined && parsed.command !== 'serve') return usageError('--gh is only for serve');
  switch (parsed.command) {
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case 'ingest':
      return ingest(parsed.positional, parsed.root);
    case 'check-policy':
      return checkPolicy(parsed.positional, parsed.root);
    case 'serve':
      return serve(parsed.positional, parsed.root, parsed.gh ?? DEFAULT_GH_PATH);
    case undefined:
      return usageError('missing command');
    default:
      return usageError(`unknown command ${JSON.stringify(parsed.command)}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('soma-devops-broker: unexpected error\n');
      process.exitCode = 1;
    },
  );
}

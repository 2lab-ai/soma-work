// The broker's socket server and request routing (.prd/16-devops-tools-architecture.md §2, §3, §5): one request
// per connection on the 0660 socket in the 0750 run directory, every decision taken here from the broker's own
// policy, approvals the broker verified itself, and one ledger row per request. Anything unexpected while
// routing becomes an `internal` error — never an execution.

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import {
  classifyGh as defaultClassifyGh,
  type GhClassification,
  type GhPolicyContext,
} from '@soma/process-shared/devops/gh-policy.js';
import {
  type BrokerMessage,
  type CfApiArgs,
  type CfLeaseRequestArgs,
  type DevopsErrorCode,
  type DevopsRequest,
  encodeMessage,
  type GhArgs,
  type GhOrgMemberArgs,
  type GhRepoAccessArgs,
  type JsonValue,
  PROTOCOL_VERSION,
  parseJsonLine,
  parseLeaseTtlSeconds,
  parseRequest,
  splitLines,
} from '@soma/process-shared/devops/protocol.js';
import {
  ApprovalConsumeError,
  ApprovalError,
  type ApprovalOutcome,
  type ApprovalRequest,
  type Approvals,
} from './approval.js';
import type { CfApiRequest, CloudflareLeases, LeaseView } from './cf-client.js';
import { GhRunDeniedError, type GhRunner, type GhRunResult } from './gh-runner.js';
import {
  GITHUB_LOGIN_RE,
  type GithubAdmin,
  type GithubAdminResult,
  type GithubMergeOptions,
  type GithubOrgMembership,
  type GithubRepoAccess,
} from './github-admin.js';
import type { Ledger } from './ledger.js';
import type { BrokerPaths } from './paths.js';
import { type BrokerPolicy, type CfEnvPolicy, formatDuration } from './policy.js';
import type { SecretKind } from './secrets.js';
import { CARD_LIMITS } from './slack-card.js';

type ApprovalPending = Parameters<Parameters<Approvals['request']>[1]['onPending']>[0];

// ── Broker ────────────────────────────────────────────────

export interface BrokerDeps {
  paths: BrokerPaths;
  policy: BrokerPolicy;
  readSecret(kind: SecretKind, name: string): string;
  ghRunner: GhRunner;
  cfLeases: Pick<CloudflareLeases, 'mint' | 'call' | 'revoke' | 'list' | 'permissionGroupNames'>;
  approvals: Pick<Approvals, 'request' | 'postResult' | 'release'>;
  githubAdmin: GithubAdmin;
  ledger: Pick<Ledger, 'append'>;
  now?: () => number;
  /** Tests only. */
  classifyGh?: (argv: readonly string[], ctx: GhPolicyContext) => GhClassification;
  /** How long a connection may take to send its request line. Default 10 s. */
  requestTimeoutMs?: number;
  /** How long `close()` waits for running requests. Default 30 s. */
  closeTimeoutMs?: number;
  /** Operator log (stderr by default). Never given a secret value. */
  log?: (line: string) => void;
}

export interface Broker {
  listen(): Promise<{ close(): Promise<void> }>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;
/** The MCP client gives up 30 s after the card's expiry; answer before it does. */
const STILL_EXECUTING_AFTER_EXPIRY_MS = 25_000;
const GROUP_NAMES_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_000;
const MAX_CONNECTIONS = 64;
/** After the terminal message, a client that keeps its side open loses the socket this long after. */
const END_LINGER_MS = 2_000;
const MAX_MESSAGE = 1000;
/** A denied or oversized argv goes to the ledger as count + hash + this much of each element, not whole. */
const DENIED_ARG_PREVIEW = 200;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
/** `gh pr merge` flags as gh-policy's table has them (`-R` included): long name → short form, takes a value. */
const MERGE_FLAGS: Record<string, { short?: string; value: boolean }> = {
  repo: { short: 'R', value: true },
  merge: { short: 'm', value: false },
  squash: { short: 's', value: false },
  rebase: { short: 'r', value: false },
  'disable-auto': { value: false },
  'delete-branch': { short: 'd', value: false },
  subject: { short: 't', value: true },
  body: { short: 'b', value: true },
  'match-head-commit': { value: true },
};
const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
/** What a v1 merge may carry; anything else (--delete-branch, ...) is refused. gh-policy already refuses --auto. */
const MERGE_SUPPORTED = new Set<string>(['repo', ...MERGE_METHODS, 'match-head-commit', 'subject', 'body']);
const ORG_RANK: Record<string, number> = { member: 1, admin: 2 };
const REPO_RANK: Record<string, number> = { pull: 1, triage: 2, push: 3, maintain: 4, admin: 5 };

const REVIEW_APPROVE_WARNING = '다른 계정이 만든 PR의 리뷰 요건을 채우는 데 쓰일 수 있음';
const LOWERING_WARNING = '권한이 낮아짐';
const MAYBE_LOWERING_WARNING = '권한이 낮아질 수 있음 (현재 역할과 비교할 수 없음)';
const MERGE_WARNING = 'PR의 대상(base) 브랜치에 바로 병합';
const CI_WARNING = 'CI 코드 실행에 영향';
// Deferred effects (gh 2.102.0): the approved action can take effect after the card is closed.
const STALE_APPROVAL_WARNING = '이후 커밋에도 이 승인이 남을 수 있음 (오래된 승인 자동 해제가 꺼진 레포)';
const WORKFLOW_ENABLE_WARNING = '이후 예약·이벤트 실행이 다시 켜짐 (그때 브랜치의 워크플로 코드가 실행됨)';

type ErrorCode = Exclude<DevopsErrorCode, 'not-approved'>;
type Allowed = Exclude<GhClassification, { kind: 'deny' }>;

type Terminal =
  | { type: 'result'; data: JsonValue }
  | { type: 'error'; code: 'not-approved'; reason: 'denied' | 'expired'; message: string }
  | { type: 'error'; code: ErrorCode; message: string };

type Row = { event: string } & Record<string, unknown>;

/** A deliberate refusal with a protocol code; every other exception while routing is `internal`. */
class Refusal extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
  }
}

function clip(text: string, max = MAX_MESSAGE): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function ok(data: JsonValue): Terminal {
  return { type: 'result', data };
}

function fail(code: ErrorCode, message: string): Terminal {
  return { type: 'error', code, message: clip(message) };
}

function notApproved(reason: 'denied' | 'expired', message: string): Terminal {
  return { type: 'error', code: 'not-approved', reason, message };
}

function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Error class and code only: messages from other layers may quote request data. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'non-error thrown';
  const code = errorCode(err);
  return code === undefined ? err.name : `${err.name} (${code})`;
}

function leaseData(view: LeaseView): JsonValue {
  return {
    leaseId: view.leaseId,
    env: view.env,
    access: view.access,
    zones: [...view.zones],
    expiresAt: view.expiresAt,
    state: view.state,
  };
}

function ghData(result: GhRunResult): JsonValue {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
    killedForMemory: result.killedForMemory === true,
    watchdogFailed: result.watchdogFailed === true,
  };
}

/** Why gh ended without an exit code, or null when it exited. */
function stopReason(result: GhRunResult): string | null {
  if (result.timedOut) return 'time limit';
  if (result.killedForMemory === true) return 'memory limit';
  if (result.watchdogFailed === true) return 'memory watchdog failed';
  return result.exitCode === null ? (result.signal ?? 'signal') : null;
}

/**
 * A `gh pr merge` argv the classifier accepted, parsed with the same flag table: the PR number and the flags
 * that are set (`--x=false` is unset). Null = a form the classifier should have refused.
 */
function parseMerge(argv: readonly string[]): { number: string; flags: Map<string, string> } | null {
  const flags = new Map<string, string>();
  let number: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    let name: string | undefined;
    let inline: string | undefined;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      inline = eq < 0 ? undefined : token.slice(eq + 1);
    } else if (token.startsWith('-') && token.length === 2) {
      name = Object.keys(MERGE_FLAGS).find((long) => MERGE_FLAGS[long].short === token[1]);
    } else {
      if (number !== null) return null;
      number = token;
      continue;
    }
    if (name === undefined || !Object.hasOwn(MERGE_FLAGS, name) || flags.has(name)) return null;
    if (MERGE_FLAGS[name].value) {
      const value = inline ?? argv[++i];
      if (value === undefined) return null;
      flags.set(name, value);
    } else {
      const value = inline ?? 'true';
      if (value !== 'true' && value !== 'false') return null;
      if (value === 'true') flags.set(name, value);
    }
  }
  return number === null ? null : { number, flags };
}

function membershipText(m: GithubOrgMembership): string {
  if (!m.member) return '멤버 아님';
  return m.state === 'pending' ? `초대 대기 중(${m.role})` : m.role;
}

function accessText(a: GithubRepoAccess): string {
  return a.collaborator ? a.permission : '협업자 아님';
}

/** A warning when a set-or-change PUT moves someone down (or cannot be compared). */
function loweringWarning(ranks: Record<string, number>, current: string | null, next: string): string | null {
  if (current === null) return null;
  const from = own(ranks, current);
  const to = own(ranks, next);
  if (from === undefined || to === undefined) return MAYBE_LOWERING_WARNING;
  return from > to ? LOWERING_WARNING : null;
}

/** The value of `--org` / `-o` in an org-scoped write (`variable set|delete`, whose flags all take a value). */
function orgFlag(argv: readonly string[]): string | null {
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--org' || token === '-o') return argv[i + 1] ?? null;
    if (token.startsWith('--org=')) return token.slice('--org='.length);
    if (token.startsWith('-') && !token.includes('=')) i++;
  }
  return null;
}

function ghLabel(c: Allowed): string {
  if (c.command === 'api' && c.api !== undefined) return `api ${c.api.method} ${c.api.path}`;
  return c.subcommand === null ? c.command : `${c.command} ${c.subcommand}`;
}

/** Over-warning is harmless (a body text of `-a` adds a needless line); missing one is not. */
function ghWarnings(c: Allowed, argv: readonly string[]): string[] {
  const warnings: string[] = [];
  const sub = c.subcommand ?? '';
  const approves = argv.some((token) => token === '--approve' || token === '-a' || token === '--approve=true');
  if (c.command === 'pr' && sub === 'review' && approves) {
    warnings.push(REVIEW_APPROVE_WARNING, STALE_APPROVAL_WARNING);
  }
  if (c.command === 'workflow' && sub === 'enable') warnings.push(WORKFLOW_ENABLE_WARNING);
  if (
    (c.command === 'workflow' && ['run', 'enable', 'disable'].includes(sub)) ||
    (c.command === 'variable' && ['set', 'delete'].includes(sub)) ||
    (c.command === 'run' && sub === 'rerun')
  ) {
    warnings.push(CI_WARNING);
  }
  return warnings;
}

// ── Connection ────────────────────────────────────────────

class Connection {
  readonly controller = new AbortController();
  requestId: string | null = null;
  /** `awaiting` = a card is out; `executing` = the approval is (being) consumed and the action runs. */
  phase: 'reading' | 'routing' | 'awaiting' | 'executing' | 'done' = 'reading';
  /** The client was told `not-approved` at the deadline; a late approval must not run. */
  gaveUp = false;
  stillExecuting = false;
  private pendingSent = false;
  private terminalSent = false;
  private deadline: NodeJS.Timeout | undefined;

  constructor(
    readonly socket: net.Socket,
    private readonly now: () => number,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  pending(p: ApprovalPending): void {
    if (this.pendingSent || this.terminalSent || this.requestId === null) return;
    this.pendingSent = true;
    this.send(
      {
        v: PROTOCOL_VERSION,
        id: this.requestId,
        type: 'pending',
        approvalId: p.approvalId,
        digestPrefix: p.digestPrefix,
        expiresAt: p.expiresAt,
      },
      false,
    );
    const expires = Date.parse(p.expiresAt);
    if (!Number.isFinite(expires)) return;
    clearTimeout(this.deadline);
    this.deadline = setTimeout(
      () => this.onDeadline(),
      Math.max(0, expires + STILL_EXECUTING_AFTER_EXPIRY_MS - this.now()),
    );
  }

  private onDeadline(): void {
    if (this.terminalSent) return;
    if (this.phase === 'awaiting') {
      this.gaveUp = true;
      this.controller.abort('answer-deadline');
      this.finish(notApproved('expired', 'no admin answered before the card expired; nothing was run'));
    } else if (this.phase === 'executing') {
      this.stillExecuting = true;
      this.finish(
        fail(
          'still-executing',
          'approved and still running; the outcome goes to the ledger and the card thread — do not ask again',
        ),
      );
    }
  }

  /** Sends the one terminal message and ends the connection; later calls are no-ops. */
  finish(terminal: Terminal): void {
    if (this.terminalSent) return;
    this.terminalSent = true;
    const message: BrokerMessage =
      terminal.type === 'result'
        ? { v: PROTOCOL_VERSION, id: this.requestId ?? '', type: 'result', data: terminal.data }
        : { v: PROTOCOL_VERSION, id: this.requestId, ...terminal };
    this.send(message, true);
  }

  dispose(): void {
    clearTimeout(this.deadline);
    this.phase = 'done';
  }

  private send(message: BrokerMessage, end: boolean): void {
    let line: string;
    try {
      line = encodeMessage(message);
    } catch {
      line = encodeMessage({
        v: PROTOCOL_VERSION,
        id: this.requestId,
        type: 'error',
        code: 'internal',
        message: 'the answer is too large to send',
      });
    }
    if (this.socket.destroyed) return;
    if (!this.socket.writable) {
      if (end) this.socket.destroy();
      return;
    }
    if (!end) {
      this.socket.write(line);
      return;
    }
    this.socket.end(line);
    // end() only closes our side; a client that never closes its side would hold a connection slot for good.
    setTimeout(() => this.socket.destroy(), END_LINGER_MS).unref();
  }
}

// ── Socket setup ──────────────────────────────────────────

function checkRunDir(runDir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(runDir);
  } catch (err) {
    throw new Error(`${runDir} cannot be used (${errorCode(err) ?? 'error'}); the installer creates it 0750`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${runDir} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${runDir} is owned by uid ${stat.uid}, not ${uid}`);
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${runDir} is group- or other-writable (mode 0${(stat.mode & 0o777).toString(8)})`);
  }
}

/** Is something accepting connections on this socket file? */
function probe(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(true);
    }, PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      const code = errorCode(err);
      if (code === 'ECONNREFUSED' || code === 'ENOENT') resolve(false);
      else reject(new Error(`${socketPath} cannot be probed (${code ?? 'error'})`));
    });
  });
}

async function clearStaleSocket(socketPath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    throw err;
  }
  if (!stat.isSocket()) throw new Error(`${socketPath} exists and is not a socket; refusing to replace it`);
  if (await probe(socketPath)) throw new Error(`another broker is already listening on ${socketPath}`);
  fs.unlinkSync(socketPath);
}

// ── Routing ───────────────────────────────────────────────

export function createBroker(deps: BrokerDeps): Broker {
  const { policy } = deps;
  const now = deps.now ?? Date.now;
  const classifyGh = deps.classifyGh ?? defaultClassifyGh;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const closeTimeoutMs = deps.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const log = deps.log ?? ((line: string) => process.stderr.write(`soma-devops-broker: ${line}\n`));
  const ghCtx: GhPolicyContext = { allowedOwners: policy.gh.allowedOwners, restWriteAllowlist: [] };
  /** Lease id → the session that asked for it: only so `list` can show a session its own leases (not a boundary). */
  const leaseSessions = new Map<string, string>();
  const connections = new Set<Connection>();
  const inflight = new Set<Promise<unknown>>();

  function track<T>(promise: Promise<T>): Promise<T> {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise)).catch(() => {});
    return promise;
  }

  async function audit(row: Row): Promise<void> {
    try {
      await deps.ledger.append(row);
    } catch (err) {
      log(`ledger append failed for ${row.event}: ${describeError(err)}`);
    }
  }

  function postResult(approvalId: string, line: string): void {
    track(
      deps.approvals.postResult(approvalId, line).catch((err: unknown) => {
        log(`posting the result line for ${approvalId} failed: ${describeError(err)}`);
      }),
    );
  }

  function ghToken(account: string): string {
    try {
      return deps.readSecret('gh', account);
    } catch (err) {
      // Secret errors name the file, never the value; the operator log may carry the path, the model may not.
      log(`gh/${account} token unreadable: ${err instanceof Error ? err.message : describeError(err)}`);
      throw new Refusal(
        'internal',
        `the broker cannot read the token of gh account ${account}; an operator must fix it`,
      );
    }
  }

  function ghAccount(name: string): { login: string; class: string } {
    const account = own(policy.gh.accounts, name);
    if (account === undefined) throw new Refusal('unknown-account', `no gh account named ${name}; see list`);
    return account;
  }

  function orgAdminAccount(): [string, { login: string; class: string }] {
    const admins = Object.entries(policy.gh.accounts).filter(([, account]) => account.class === 'org-admin');
    if (admins.length !== 1) {
      throw new Refusal(
        'policy-denied',
        `the broker policy must hold exactly one org-admin account for this tool (it holds ${admins.length})`,
      );
    }
    return admins[0];
  }

  function cfEnv(name: string): CfEnvPolicy {
    const env = own(policy.cloudflare, name);
    if (env === undefined) throw new Refusal('unknown-env', `no Cloudflare environment named ${name}; see list`);
    return env;
  }

  function ownerAllowed(owner: string): boolean {
    const wanted = owner.toLowerCase();
    return policy.gh.allowedOwners.some((allowed) => allowed.toLowerCase() === wanted);
  }

  function checkUser(user: string): void {
    if (!GITHUB_LOGIN_RE.test(user)) throw new Refusal('bad-request', 'user is not a valid GitHub login');
  }

  /** A classifier that throws is a broker bug, not a policy answer: `internal`, and nothing runs. */
  function classify(argv: readonly string[]): GhClassification {
    try {
      return classifyGh(argv, ghCtx);
    } catch (err) {
      log(`gh classifier threw: ${describeError(err)}`);
      throw new Refusal('internal', 'the gh allowlist could not classify these arguments; nothing was run');
    }
  }

  /**
   * Classifies and records the argv: whole once the allowlist accepted it and it would fit on an approval card
   * (what an admin can see), otherwise as count + sha256 + a short prefix of each element — a refused or
   * oversized request (a card-free gh_read repeated with 64 KiB fields) cannot bloat the ledger.
   */
  function classifyInto(row: Row, argv: readonly string[]): GhClassification {
    let c: GhClassification;
    try {
      c = classify(argv);
    } catch (err) {
      row.classification = 'error';
      recordDeniedArgv(row, argv);
      throw err;
    }
    row.classification = c.kind;
    if (c.kind === 'deny' || JSON.stringify(argv).length > CARD_LIMITS.totalChars) recordDeniedArgv(row, argv);
    else row.argv = [...argv];
    return c;
  }

  function recordDeniedArgv(row: Row, argv: readonly string[]): void {
    row.argc = argv.length;
    row.argvSha256 = createHash('sha256').update(JSON.stringify(argv)).digest('hex');
    row.argvPreview = argv.map((arg) => arg.slice(0, DENIED_ARG_PREVIEW));
  }

  /** gh_read gets reads only, gh_write writes only; everything else is named and refused. */
  function misrouted(tool: 'gh_read' | 'gh_write', c: GhClassification): Refusal {
    if (c.kind === 'deny' && c.code === 'internal-error') {
      log(`gh classifier failed: ${c.reason}`);
      return new Refusal('internal', 'the gh allowlist could not classify these arguments; nothing was run');
    }
    if (c.kind === 'deny') return new Refusal('policy-denied', `gh arguments denied (${c.code}): ${c.reason}`);
    if (c.kind === 'org-admin-op') {
      return new Refusal('policy-denied', `${c.reason}; use gh_org_member or gh_repo_access`);
    }
    if (tool === 'gh_read') {
      return new Refusal('policy-denied', `gh ${ghLabel(c)} changes something; use gh_write (it needs an admin ✅)`);
    }
    return new Refusal('policy-denied', `gh ${ghLabel(c)} only reads; use gh_read (no approval needed)`);
  }

  function recordRun(row: Row, result: GhRunResult): void {
    row.exitCode = result.exitCode;
    row.signal = result.signal;
    row.timedOut = result.timedOut;
    row.killedForMemory = result.killedForMemory === true;
    row.watchdogFailed = result.watchdogFailed === true;
  }

  async function runGh(token: string, argv: readonly string[]): Promise<GhRunResult> {
    try {
      return await deps.ghRunner.run(token, argv);
    } catch (err) {
      if (err instanceof GhRunDeniedError && err.code !== 'internal-error') {
        throw new Refusal('policy-denied', `gh arguments denied (${err.code}): ${err.reason}`);
      }
      log(`gh run failed: ${describeError(err)}`);
      throw new Refusal('internal', 'gh could not be started; nothing was run');
    }
  }

  async function groupNames(env: string): Promise<Record<string, string>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        deps.cfLeases.permissionGroupNames(env),
        new Promise<Record<string, string>>((resolve) => {
          timer = setTimeout(() => resolve({}), GROUP_NAMES_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  const CF_CODES: readonly string[] = [
    'unknown-env',
    'lease-not-found',
    'lease-expired',
    'lease-out-of-scope',
    'upstream-error',
    'result-unknown',
    'policy-denied',
    'bad-request',
  ];

  function cfFailure(err: unknown, what: string): Refusal {
    const code = errorCode(err);
    if (code !== undefined && CF_CODES.includes(code) && err instanceof Error) {
      return new Refusal(code as ErrorCode, err.message);
    }
    log(`${what} failed: ${describeError(err)}`);
    return new Refusal('internal', `${what} failed inside the broker`);
  }

  /** A plain Error (e.g. a request after close) is `internal`. */
  function approvalFailure(err: unknown): Refusal {
    switch (err instanceof ApprovalError ? err.code : undefined) {
      case 'too-many-pending-approvals': {
        // approval.ts writes these messages from counts and limits only; they name which limit was hit.
        const { message, retryAfterSeconds } = err as ApprovalError;
        const retry =
          retryAfterSeconds !== undefined && !/try again in \d+ s/.test(message)
            ? `; try again in ${retryAfterSeconds} s`
            : '';
        return new Refusal('too-many-pending-approvals', `${message}${retry}`);
      }
      case 'card-too-long':
        return new Refusal(
          'policy-denied',
          'the request is too long to show on the approval card (an admin must see all of it); shorten it',
        );
      case 'slack-unavailable':
        return new Refusal('upstream-error', 'no approval card could be posted to Slack; nothing was run');
      default:
        log(`approval request failed: ${describeError(err)}`);
        return new Refusal('internal', 'the approval card could not be handled; nothing was run');
    }
  }

  function cancelledMessage(conn: Connection): string {
    if (conn.signal.reason === 'broker-shutting-down') {
      return 'the broker is shutting down; the approval card was withdrawn and nothing was run — ask again once it is back';
    }
    return 'the approval was cancelled by the broker (the card was withdrawn); nothing was run — you may ask again';
  }

  /**
   * Card → admin answer → consume → execute. The approval is consumed before anything runs; once consumption
   * starts the request counts as executing (the deadline answers `still-executing`, never `not-approved`).
   */
  async function withApproval(
    conn: Connection,
    row: Row,
    card: ApprovalRequest,
    execute: (approvalId: string) => Promise<Terminal>,
  ): Promise<Terminal> {
    if (conn.signal.aborted) {
      row.outcome = 'cancelled';
      return notApproved('expired', cancelledMessage(conn));
    }
    conn.phase = 'awaiting';
    let answer: ApprovalOutcome;
    try {
      answer = await deps.approvals.request(card, { onPending: (p) => conn.pending(p), signal: conn.signal });
    } catch (err) {
      throw approvalFailure(err);
    }
    row.approvalId = answer.approvalId;
    if (answer.outcome !== 'approved') {
      row.outcome = answer.outcome;
      if (answer.outcome === 'denied') return notApproved('denied', 'an admin denied the card; nothing was run');
      if (answer.outcome === 'cancelled') return notApproved('expired', cancelledMessage(conn));
      return notApproved('expired', 'no admin answered before the card expired; nothing was run');
    }
    if (conn.gaveUp) {
      row.outcome = 'approved-too-late';
      // The client was already told `not-approved`: give the approval back so nothing stays approved on disk.
      await deps.approvals.release(answer.approvalId, 'requester-stopped-waiting').catch((err: unknown) => {
        log(`releasing approval ${answer.approvalId} failed: ${describeError(err)}`);
      });
      return notApproved('expired', 'the approval came after the answer deadline; nothing was run');
    }
    conn.phase = 'executing';
    try {
      await answer.consume();
    } catch (err) {
      if (err instanceof ApprovalConsumeError) {
        const reason = err.reason;
        if (reason === 'closed') {
          row.outcome = 'approval-closed';
          throw new Refusal('internal', 'the broker is shutting down; the approval was not used and nothing was run');
        }
        if (reason === 'not-approved') {
          row.outcome = 'approval-not-approved';
          return notApproved('expired', 'the approval was no longer valid when it was used; nothing was run');
        }
        // Identical requests share one card; the waiter that consumed it first is the one running it.
        row.outcome = 'approval-already-used';
        return fail(
          'still-executing',
          `approval ${answer.approvalId} was already used by an identical request, which runs it; this one ran nothing — do not ask again`,
        );
      }
      log(`approval ${answer.approvalId} could not be consumed: ${describeError(err)}`);
      throw new Refusal('internal', 'the approval could not be used; nothing was run');
    }
    return execute(answer.approvalId);
  }

  // ── Tools ──

  function list(req: DevopsRequest): Terminal {
    const session = req.claimedRequester.sessionKey;
    return ok({
      accounts: Object.entries(policy.gh.accounts).map(([name, account]) => ({ name, class: account.class })),
      envs: Object.entries(policy.cloudflare).map(([name, env]) => ({
        name,
        zones: Object.keys(env.zones),
        access: { read: [...env.permissionGroups.read], edit: [...env.permissionGroups.edit] },
        defaultTtl: formatDuration(env.defaultTtlSeconds),
        maxTtl: formatDuration(env.maxTtlSeconds),
      })),
      leases: deps.cfLeases
        .list()
        .filter((lease) => leaseSessions.get(lease.leaseId) === session)
        .map(leaseData),
    });
  }

  async function ghRead(args: GhArgs, row: Row): Promise<Terminal> {
    ghAccount(args.account);
    row.account = args.account;
    const c = classifyInto(row, args.args);
    if (c.kind !== 'read') throw misrouted('gh_read', c);
    const result = await runGh(ghToken(args.account), args.args);
    recordRun(row, result);
    return ok(ghData(result));
  }

  async function ghWrite(conn: Connection, req: DevopsRequest, args: GhArgs, row: Row): Promise<Terminal> {
    const account = ghAccount(args.account);
    row.account = args.account;
    const c = classifyInto(row, args.args);
    if (c.kind !== 'write') throw misrouted('gh_write', c);
    // gh may turn a merge into a queued or auto merge on its own (merge queue on the base), so a merge does not
    // run gh: the broker makes one immediate, sha-pinned merge call. Only --disable-auto still runs gh.
    let disableAutoTitle: string | null = null;
    if (c.command === 'pr' && c.subcommand === 'merge') {
      const parsed = parseMerge(args.args);
      if (parsed === null || c.repo === null) {
        throw new Refusal('policy-denied', 'the gh pr merge arguments could not be read; nothing was run');
      }
      if (!parsed.flags.has('disable-auto')) return mergePullRequest(conn, req, args, account, row, c.repo, parsed);
      const extra = [...parsed.flags.keys()].find((name) => name !== 'repo' && name !== 'disable-auto');
      if (extra !== undefined) {
        throw new Refusal(
          'policy-denied',
          `gh pr merge --disable-auto takes only the PR number and -R; drop --${extra} (merges are a separate request)`,
        );
      }
      disableAutoTitle = `${args.account} 계정이 ${c.repo} PR #${parsed.number} 자동 머지 해제`;
    }
    // Read before the card: a missing token should not cost an admin an approval.
    const token = ghToken(args.account);
    const org = c.repo === null ? orgFlag(args.args) : null;
    const target = c.repo ?? (org !== null && ownerAllowed(org) ? org : '조직');
    const card: ApprovalRequest = {
      tool: 'gh_write',
      title: disableAutoTitle ?? `${args.account} 계정이 ${target}에 gh ${ghLabel(c)} 실행`,
      details: [
        { label: '계정', value: `${args.account} (${account.login})` },
        c.repo !== null ? { label: '레포', value: c.repo } : { label: '조직', value: target },
        { label: '명령', value: `gh ${ghLabel(c)}` },
      ],
      argv: [...args.args],
      warnings: ghWarnings(c, args.args),
      claimedRequester: req.claimedRequester,
      canonical: {
        tool: 'gh_write',
        account: args.account,
        login: account.login,
        args: args.args,
        claimedRequester: req.claimedRequester,
      },
    };
    return withApproval(conn, row, card, async (approvalId) => {
      let result: GhRunResult;
      try {
        result = await runGh(token, args.args);
      } catch (err) {
        postResult(approvalId, '실패 — gh를 실행하지 못함 (보내지 않음)');
        throw err;
      }
      recordRun(row, result);
      const why = stopReason(result);
      if (why !== null) {
        // §5.5: no automatic re-run; gh writes have no generic read-back, so a person confirms.
        row.confirm = 'manual';
        postResult(approvalId, '결과 불명 — gh가 끝나기 전에 중단됨, 자동 재시도 안 함 (수동 확인 필요)');
        return fail(
          'result-unknown',
          `gh was stopped (${why}) before it finished; ` +
            'the change may or may not have been applied — check before asking again',
        );
      }
      postResult(approvalId, `${result.exitCode === 0 ? '완료' : '실패'} — 종료 코드 ${result.exitCode}`);
      return ok(ghData(result));
    });
  }

  /**
   * `gh pr merge` as one GitHub API call: `PUT /repos/{o}/{r}/pulls/{n}/merge` with the approved head sha.
   * GitHub merges at once or refuses (head moved = 409, merge queue required, checks); it never queues it.
   */
  async function mergePullRequest(
    conn: Connection,
    req: DevopsRequest,
    args: GhArgs,
    account: { login: string },
    row: Row,
    repoFull: string,
    parsed: { number: string; flags: Map<string, string> },
  ): Promise<Terminal> {
    const unsupported = [...parsed.flags.keys()].find((name) => !MERGE_SUPPORTED.has(name));
    if (unsupported !== undefined) {
      throw new Refusal(
        'policy-denied',
        `gh pr merge --${unsupported} is not supported for merges in v1: the broker merges once, immediately, ` +
          'through the GitHub API (use --disable-auto alone to turn an existing auto-merge off)',
      );
    }
    const methods = MERGE_METHODS.filter((method) => parsed.flags.has(method));
    if (methods.length !== 1) {
      throw new Refusal('policy-denied', 'gh pr merge needs exactly one of --merge, --squash or --rebase');
    }
    const method = methods[0];
    const sha = parsed.flags.get('match-head-commit');
    if (sha === undefined || !FULL_SHA_RE.test(sha)) {
      throw new Refusal(
        'policy-denied',
        'gh pr merge needs --match-head-commit <the full 40-character head SHA> so the merge is exactly what ' +
          'the admin approves; read it with gh_read (gh pr view <n> -R <repo> --json headRefOid), add it, ask again',
      );
    }
    const number = Number(parsed.number);
    if (!Number.isSafeInteger(number) || number < 1) throw new Refusal('bad-request', 'the PR number is not valid');
    const commitTitle = parsed.flags.get('subject');
    const commitMessage = parsed.flags.get('body');
    const [owner, repo] = repoFull.split('/');
    row.pr = number;
    row.method = method;
    row.sha = sha;
    const token = ghToken(args.account);
    const card: ApprovalRequest = {
      tool: 'gh_write',
      title:
        `${args.account} 계정이 ${repoFull} PR #${number} 즉시 머지 (기준 커밋 ${sha.slice(0, 12)}, 방식 ${method}) — ` +
        '그 사이 커밋이 올라오면 GitHub가 거절함; 머지 큐가 필요한 브랜치면 실패함',
      details: [
        { label: '계정', value: `${args.account} (${account.login})` },
        { label: '레포', value: repoFull },
        { label: 'PR', value: `#${number}` },
        { label: '방식', value: method },
        { label: '머지 기준 커밋', value: sha },
        ...(commitTitle === undefined ? [] : [{ label: '커밋 제목', value: commitTitle }]),
        ...(commitMessage === undefined ? [] : [{ label: '커밋 메시지', value: commitMessage }]),
        { label: '실행', value: `GitHub API PUT /repos/${repoFull}/pulls/${number}/merge (gh는 실행하지 않음)` },
      ],
      warnings: [MERGE_WARNING],
      claimedRequester: req.claimedRequester,
      canonical: {
        tool: 'gh_write',
        operation: 'pr-merge',
        account: args.account,
        login: account.login,
        repo: repoFull,
        number,
        method,
        sha,
        title: commitTitle ?? null,
        message: commitMessage ?? null,
        args: args.args,
        claimedRequester: req.claimedRequester,
      },
    };
    const options: GithubMergeOptions = { sha, method };
    if (commitTitle !== undefined) options.title = commitTitle;
    if (commitMessage !== undefined) options.message = commitMessage;
    return withApproval(conn, row, card, (approvalId) =>
      githubAdminCall(
        approvalId,
        row,
        () => deps.githubAdmin.mergePullRequest(token, owner, repo, number, options),
        async () => {
          const pr = await deps.githubAdmin.getPullRequest(token, owner, repo, number);
          const text = pr.merged
            ? `머지됨 (${pr.mergeCommitSha === null ? '머지 커밋 불명' : pr.mergeCommitSha.slice(0, 12)})`
            : `머지 안 됨 (상태 ${pr.state})`;
          return { json: { merged: pr.merged, mergeCommitSha: pr.mergeCommitSha, state: pr.state }, text };
        },
      ),
    );
  }

  /** What a confirming read saw after a lost answer (§5.5): ledger value and card text. */
  async function observe(read: () => Promise<{ json: JsonValue; text: string }>): Promise<{
    json: JsonValue;
    text: string;
  }> {
    try {
      return await read();
    } catch (err) {
      log(`confirming read failed: ${describeError(err)}`);
      return { json: 'unavailable', text: '조회 실패' };
    }
  }

  async function githubAdminCall(
    approvalId: string,
    row: Row,
    call: () => Promise<GithubAdminResult>,
    confirm: () => Promise<{ json: JsonValue; text: string }>,
  ): Promise<Terminal> {
    let result: GithubAdminResult;
    try {
      result = await call();
    } catch (err) {
      const code = errorCode(err);
      if (code === 'result-unknown') {
        // Never re-sent; a read shows what GitHub holds now (it may or may not be this request's doing).
        const observed = await observe(confirm);
        row.observed = observed.json;
        postResult(approvalId, `결과 불명 — GitHub 응답 유실, 자동 재시도 안 함; 조회 결과: ${observed.text}`);
        throw new Refusal(
          'result-unknown',
          `${err instanceof Error ? err.message : 'the GitHub answer was lost'}; a read afterwards shows: ${observed.text}`,
        );
      }
      postResult(approvalId, '실패 — GitHub에 보내지 못함');
      if (code === 'upstream-error') {
        throw new Refusal('upstream-error', err instanceof Error ? err.message : 'GitHub is unreachable');
      }
      log(`GitHub admin call failed: ${describeError(err)}`);
      throw new Refusal('internal', 'the GitHub call could not be made; nothing was sent');
    }
    row.status = result.status;
    const success = result.status >= 200 && result.status < 300;
    postResult(approvalId, `${success ? '완료' : '실패'} — GitHub ${result.status}`);
    if (!success) return fail('upstream-error', `GitHub answered ${result.status}: ${clip(result.body, 600)}`);
    return ok({ status: result.status, body: result.body });
  }

  /** The current state goes on the card; without it the card cannot say what the PUT changes. */
  async function readCurrent<T>(what: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      if (errorCode(err) === 'upstream-error' || errorCode(err) === 'result-unknown') {
        throw new Refusal(
          'upstream-error',
          `the current ${what} could not be read from GitHub, so no card was posted (${err instanceof Error ? err.message : 'error'})`,
        );
      }
      log(`reading the current ${what} failed: ${describeError(err)}`);
      throw new Refusal('internal', `the current ${what} could not be read; no card was posted`);
    }
  }

  async function ghOrgMember(conn: Connection, req: DevopsRequest, args: GhOrgMemberArgs, row: Row) {
    const [name, account] = orgAdminAccount();
    row.account = name;
    checkUser(args.user);
    const org = policy.gh.org;
    row.org = org;
    row.action = args.action;
    row.user = args.user;
    const token = ghToken(name);
    const role = args.action === 'remove' ? null : args.role;
    if (role !== null) row.role = role;
    const readMembership = () => deps.githubAdmin.getMembership(token, org, args.user);
    const current = await readCurrent('organization membership', readMembership);
    row.current = current;
    const now = membershipText(current);
    const currentRole = current.member ? current.role : null;
    const warnings: string[] = [];
    if (role === null) {
      if (currentRole === 'admin') warnings.push('조직 소유자(owner) 제거');
      if (current.member) warnings.push(LOWERING_WARNING);
    } else {
      if (role === 'admin' && currentRole !== 'admin') warnings.push('조직 소유자(owner) 권한 부여');
      const lowering = loweringWarning(ORG_RANK, currentRole, role);
      if (lowering !== null) warnings.push(lowering);
    }
    const change = role === null ? '제거' : `${role}로 ${current.member ? '변경' : '추가'}`;
    const card: ApprovalRequest = {
      tool: 'gh_org_member',
      title: `${name} 계정이 ${org}에서 ${args.user}의 조직 역할: 현재 ${now} → ${change}`,
      details: [
        { label: '계정', value: `${name} (${account.login})` },
        { label: '조직', value: org },
        { label: '대상', value: args.user },
        { label: '현재 상태', value: now },
        ...(role === null ? [] : [{ label: '역할', value: role }]),
      ],
      warnings,
      claimedRequester: req.claimedRequester,
      canonical: {
        tool: 'gh_org_member',
        account: name,
        login: account.login,
        org,
        args,
        current,
        claimedRequester: req.claimedRequester,
      },
    };
    return withApproval(conn, row, card, (approvalId) =>
      githubAdminCall(
        approvalId,
        row,
        () =>
          role === null
            ? deps.githubAdmin.removeMembership(token, org, args.user)
            : deps.githubAdmin.setMembership(token, org, args.user, role),
        async () => {
          const seen = await readMembership();
          return { json: seen, text: membershipText(seen) };
        },
      ),
    );
  }

  async function ghRepoAccess(conn: Connection, req: DevopsRequest, args: GhRepoAccessArgs, row: Row) {
    const [name, account] = orgAdminAccount();
    row.account = name;
    checkUser(args.user);
    const [owner, repo] = args.repo.split('/');
    if (!ownerAllowed(owner)) throw new Refusal('policy-denied', `owner ${owner} is not in the broker policy's owners`);
    // `.` and `..` would be resolved away in the request URL.
    if (/^\.+$/.test(repo)) throw new Refusal('bad-request', 'repo name is not valid');
    row.repo = args.repo;
    row.action = args.action;
    row.user = args.user;
    const token = ghToken(name);
    const permission = args.action === 'grant' ? args.permission : null;
    if (permission !== null) row.permission = permission;
    const readAccess = () => deps.githubAdmin.getCollaboratorPermission(token, owner, repo, args.user);
    const current = await readCurrent('repository access', readAccess);
    row.current = current;
    const now = accessText(current);
    const currentPermission = current.collaborator ? current.permission : null;
    const warnings: string[] = [];
    if (permission === null) {
      if (current.collaborator) warnings.push(LOWERING_WARNING);
    } else {
      if (permission === 'admin' && currentPermission !== 'admin') {
        warnings.push('레포 관리자 권한 — 설정·보호 규칙 변경 가능');
      }
      const lowering = loweringWarning(REPO_RANK, currentPermission, permission);
      if (lowering !== null) warnings.push(lowering);
    }
    const change = permission === null ? '제거' : `${permission}로 ${current.collaborator ? '변경' : '추가'}`;
    const card: ApprovalRequest = {
      tool: 'gh_repo_access',
      title: `${name} 계정이 ${args.repo}에서 ${args.user}의 레포 권한: 현재 ${now} → ${change}`,
      details: [
        { label: '계정', value: `${name} (${account.login})` },
        { label: '레포', value: args.repo },
        { label: '대상', value: args.user },
        // The permission endpoint reports effective access: team and organization base permissions count too.
        { label: '현재 상태', value: current.collaborator ? `${now} (팀·조직 기본 권한 포함)` : now },
        ...(permission === null ? [] : [{ label: '권한', value: permission }]),
      ],
      warnings,
      claimedRequester: req.claimedRequester,
      canonical: {
        tool: 'gh_repo_access',
        account: name,
        login: account.login,
        args,
        current,
        claimedRequester: req.claimedRequester,
      },
    };
    return withApproval(conn, row, card, (approvalId) =>
      githubAdminCall(
        approvalId,
        row,
        () =>
          permission === null
            ? deps.githubAdmin.removeCollaborator(token, owner, repo, args.user)
            : deps.githubAdmin.addCollaborator(token, owner, repo, args.user, permission),
        async () => {
          const seen = await readAccess();
          return { json: seen, text: accessText(seen) };
        },
      ),
    );
  }

  async function cfLeaseRequest(conn: Connection, req: DevopsRequest, args: CfLeaseRequestArgs, row: Row) {
    const env = cfEnv(args.env);
    row.env = args.env;
    row.access = args.access;
    const allowed = env.permissionGroups[args.access];
    const permissionGroupIds = [...new Set(args.permissions)];
    const outside = permissionGroupIds.find((id) => !allowed.includes(id));
    if (outside !== undefined) {
      throw new Refusal(
        'policy-denied',
        `permission group ${outside} is not allowed for ${args.access} leases in ${args.env}; see list`,
      );
    }
    const zones = [...new Set(args.zones)];
    const zoneIds = zones.map((zone) => {
      const id = own(env.zones, zone);
      if (id === undefined) throw new Refusal('policy-denied', `zone ${zone} is not in ${args.env}; see list`);
      return id;
    });
    let ttlSeconds = env.defaultTtlSeconds;
    if (args.ttl !== undefined) {
      const parsed = parseLeaseTtlSeconds(args.ttl);
      if (parsed === null) throw new Refusal('bad-request', 'ttl must be <n>m or <n>h, at most 71h');
      ttlSeconds = parsed;
    }
    if (ttlSeconds > env.maxTtlSeconds) {
      throw new Refusal(
        'policy-denied',
        `ttl is longer than ${formatDuration(env.maxTtlSeconds)}, the limit for ${args.env}`,
      );
    }
    row.permissionGroupIds = permissionGroupIds;
    row.zones = zones;
    row.ttlSeconds = ttlSeconds;
    const names = await groupNames(args.env);
    const shown = permissionGroupIds.map((id) => {
      const groupName = own(names, id);
      return typeof groupName === 'string' && groupName.length > 0 ? `${groupName} (${id})` : id;
    });
    const access = args.access === 'edit' ? '편집' : '읽기';
    const scope = zones.length > 0 ? zones.join(', ') : '계정 전체';
    const card: ApprovalRequest = {
      tool: 'cf_lease_request',
      title: `${args.env} 환경 Cloudflare ${access} 단기 키를 ${formatDuration(ttlSeconds)} 동안 발급 (${scope})`,
      details: [
        { label: '환경', value: args.env },
        { label: '권한', value: `${args.access}: ${shown.join(', ')}` },
        { label: '존', value: zones.length > 0 ? zones.join(', ') : '계정 전체 (계정의 모든 존에 적용될 수 있음)' },
        { label: '수명', value: formatDuration(ttlSeconds) },
        { label: '사유', value: args.reason },
      ],
      warnings: args.access === 'edit' ? ['변경 권한 — 이 범위의 설정을 바꿀 수 있음'] : [],
      claimedRequester: req.claimedRequester,
      canonical: {
        tool: 'cf_lease_request',
        env: args.env,
        accountId: env.accountId,
        access: args.access,
        permissionGroupIds,
        zones,
        zoneIds,
        ttlSeconds,
        reason: args.reason,
        claimedRequester: req.claimedRequester,
      },
    };
    return withApproval(conn, row, card, async (approvalId) => {
      const leaseId = randomBytes(16).toString('hex');
      row.leaseId = leaseId;
      let view: LeaseView;
      try {
        view = await deps.cfLeases.mint({
          leaseId,
          scope: { env: args.env, access: args.access, permissionGroupIds, zoneIds },
          ttlSeconds,
          approvalId,
        });
      } catch (err) {
        const refusal = cfFailure(err, 'minting the lease');
        postResult(approvalId, `발급 실패 — ${refusal.code}`);
        throw refusal;
      }
      leaseSessions.set(leaseId, req.claimedRequester.sessionKey);
      postResult(approvalId, `발급됨 — lease ${leaseId.slice(0, 8)}…, 만료 ${view.expiresAt}`);
      return ok(leaseData(view));
    });
  }

  async function cfApi(req: DevopsRequest, args: CfApiArgs, row: Row): Promise<Terminal> {
    row.lease = args.lease;
    row.method = args.method;
    row.path = args.path;
    const call: CfApiRequest = { method: args.method, path: args.path };
    if (args.query !== undefined) call.query = args.query;
    if (args.body !== undefined) call.body = args.body;
    let answer: Awaited<ReturnType<CloudflareLeases['call']>>;
    try {
      answer = await deps.cfLeases.call(args.lease, call, { sessionKey: req.claimedRequester.sessionKey });
    } catch (err) {
      throw cfFailure(err, 'the Cloudflare call');
    }
    row.status = answer.status;
    return ok({
      status: answer.status,
      body: (answer.body ?? null) as JsonValue,
      truncated: answer.truncated === true,
    });
  }

  async function cfLeaseRevoke(req: DevopsRequest, lease: string, row: Row): Promise<Terminal> {
    row.lease = lease;
    let view: LeaseView;
    try {
      view = await deps.cfLeases.revoke(lease, `cf_lease_revoke (claimed session ${req.claimedRequester.sessionKey})`);
    } catch (err) {
      throw cfFailure(err, 'revoking the lease');
    }
    row.state = view.state;
    return ok(leaseData(view));
  }

  async function route(conn: Connection, req: DevopsRequest, row: Row): Promise<Terminal> {
    switch (req.tool) {
      case 'list':
        return list(req);
      case 'gh_read':
        return ghRead(req.args, row);
      case 'gh_write':
        return ghWrite(conn, req, req.args, row);
      case 'gh_org_member':
        return ghOrgMember(conn, req, req.args, row);
      case 'gh_repo_access':
        return ghRepoAccess(conn, req, req.args, row);
      case 'cf_lease_request':
        return cfLeaseRequest(conn, req, req.args, row);
      case 'cf_api':
        return cfApi(req, req.args, row);
      case 'cf_lease_revoke':
        return cfLeaseRevoke(req, req.args.lease, row);
    }
  }

  async function handleLine(conn: Connection, line: string): Promise<void> {
    conn.phase = 'routing';
    const json = parseJsonLine(line);
    const parsed = json.ok ? parseRequest(json.value) : null;
    if (parsed === null || !parsed.ok) {
      const code = parsed === null ? 'bad-request' : parsed.code;
      const message = parsed === null ? (json.ok ? 'bad request' : json.message) : parsed.message;
      conn.requestId = parsed?.id ?? null;
      await audit({ event: 'request', requestId: conn.requestId, outcome: code });
      conn.finish(fail(code, message));
      conn.dispose();
      return;
    }
    const req = parsed.value;
    conn.requestId = req.id;
    const row: Row = { event: 'request', requestId: req.id, tool: req.tool, claimedRequester: req.claimedRequester };
    let terminal: Terminal;
    try {
      terminal = await route(conn, req, row);
    } catch (err) {
      if (err instanceof Refusal) {
        terminal = fail(err.code, err.message);
      } else {
        log(`${req.tool} failed while routing: ${describeError(err)}`);
        terminal = fail('internal', 'the broker hit an internal error on this request');
      }
    }
    if (row.outcome === undefined) row.outcome = terminal.type === 'result' ? 'ok' : terminal.code;
    if (conn.stillExecuting) row.stillExecuting = true;
    await audit(row);
    conn.finish(terminal);
    conn.dispose();
  }

  function onConnection(socket: net.Socket): void {
    const conn = new Connection(socket, now);
    connections.add(conn);
    socket.setEncoding('utf8');
    // EPIPE / ECONNRESET from a client that went away; 'close' follows.
    socket.on('error', () => {});
    let buffered = '';
    const idle = setTimeout(() => {
      if (conn.phase !== 'reading') return;
      conn.phase = 'done';
      conn.finish(fail('bad-request', `no request line within ${requestTimeoutMs / 1000} s`));
    }, requestTimeoutMs);
    socket.on('data', (chunk: string) => {
      // One request per connection: anything after the first line is ignored, not buffered.
      if (conn.phase !== 'reading') return;
      const split = splitLines(buffered, chunk);
      buffered = split.rest;
      if (split.overflow) {
        clearTimeout(idle);
        conn.phase = 'done';
        buffered = '';
        conn.finish(fail('bad-request', 'request line too long'));
        return;
      }
      if (split.lines.length === 0) return;
      clearTimeout(idle);
      buffered = '';
      track(
        handleLine(conn, split.lines[0]).catch((err: unknown) => {
          log(`request handling failed: ${describeError(err)}`);
          conn.finish(fail('internal', 'the broker hit an internal error on this request'));
          conn.dispose();
        }),
      );
    });
    socket.on('close', () => {
      clearTimeout(idle);
      connections.delete(conn);
      // A card still waiting for an answer is withdrawn; an approved action keeps running to its ledger row.
      conn.controller.abort('client-disconnected');
    });
  }

  async function listen(): Promise<{ close(): Promise<void> }> {
    const { runDir, socketPath } = deps.paths;
    checkRunDir(runDir);
    await clearStaleSocket(socketPath);
    const server = net.createServer(onConnection);
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // The bind happens inside listen(): the socket file is created 0660, never wider, even for an instant.
      const previous = process.umask(0o117);
      try {
        server.listen(socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      } finally {
        process.umask(previous);
      }
    });
    fs.chmodSync(socketPath, 0o660);
    server.on('error', (err) => log(`socket server error: ${describeError(err)}`));

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const conn of connections) {
          if (conn.phase === 'reading') conn.socket.destroy();
          else conn.controller.abort('broker-shutting-down');
        }
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise((resolve) => {
            timer = setTimeout(resolve, closeTimeoutMs);
          }),
        ]);
        clearTimeout(timer);
        for (const conn of connections) conn.socket.destroy();
        await closed;
      })();
      return closing;
    };
    return { close };
  }

  return { listen };
}

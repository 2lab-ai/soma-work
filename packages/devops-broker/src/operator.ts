// The operator's line to the running broker (#1056): `soma-devops-broker passkey …`, run as the broker user
// from a sudo terminal, talks to the broker over a unix socket inside the broker's state directory. That
// directory is 0700 and owned by the broker user, so the bot user (and so the model) cannot reach the socket.
// The broker's request socket in run/ is group-reachable and has none of these operations.
//
// One connection carries one enrolment from start to finish: when it closes — the operator pressed Ctrl-C,
// the terminal went away — an enrolment still open on it is cancelled, so nothing can be confirmed later.

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { PasskeyError, type Passkeys } from './passkeys.js';
import type { BrokerPaths } from './paths.js';

export const OPERATOR_SOCKET_FILE = 'operator.sock';

export function operatorSocketPath(paths: Pick<BrokerPaths, 'stateDir'>): string {
  return path.join(paths.stateDir, OPERATOR_SOCKET_FILE);
}

const MAX_LINE_BYTES = 4096;
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,20}$/;

type OperatorRequest =
  | { op: 'enrol-start'; admin: string }
  | { op: 'enrol-status' }
  | { op: 'enrol-confirm'; fingerprint: string | null }
  | { op: 'list' }
  | { op: 'revoke'; fingerprint: string };

type OperatorReply = { ok: true; [key: string]: unknown } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequest(line: string): OperatorRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.op) {
    case 'enrol-start':
      return typeof value.admin === 'string' && SLACK_USER_RE.test(value.admin)
        ? { op: 'enrol-start', admin: value.admin }
        : null;
    case 'enrol-status':
      return { op: 'enrol-status' };
    case 'enrol-confirm':
      if (value.fingerprint === null) return { op: 'enrol-confirm', fingerprint: null };
      return typeof value.fingerprint === 'string' && value.fingerprint.length <= 64
        ? { op: 'enrol-confirm', fingerprint: value.fingerprint }
        : null;
    case 'list':
      return { op: 'list' };
    case 'revoke':
      return typeof value.fingerprint === 'string' && value.fingerprint.length <= 64
        ? { op: 'revoke', fingerprint: value.fingerprint }
        : null;
    default:
      return null;
  }
}

/** The socket may only sit in a directory nobody but its owner can enter. */
function checkPrivateDir(dir: string): void {
  const stat = fs.statSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} is not owned by the broker user`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `${dir} is reachable by group or others (mode 0${(stat.mode & 0o777).toString(8)}); it must be 0700`,
    );
  }
}

export interface OperatorServer {
  close(): Promise<void>;
}

export async function startOperatorSocket(opts: {
  socketPath: string;
  passkeys: Passkeys;
  /** Printed by the CLI for the admin to open. */
  enrolUrl: string;
  /** After a passkey was stored (the broker tells the admins). Never throws into the reply. */
  onEnrolled?(admin: string, fingerprint: string): void;
  log(line: string): void;
}): Promise<OperatorServer> {
  const { socketPath, passkeys } = opts;
  checkPrivateDir(path.dirname(socketPath));
  try {
    if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
    else throw new Error(`${socketPath} exists and is not a socket; refusing to replace it`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const connections = new Set<net.Socket>();

  function onConnection(socket: net.Socket): void {
    connections.add(socket);
    socket.setEncoding('utf8');
    let buffered = '';
    /** The enrolment this connection started, while it is neither stored nor discarded. */
    let enrolment: { id: string; admin: string } | undefined;
    let chain: Promise<void> = Promise.resolve();

    const reply = (message: OperatorReply) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };

    async function handle(line: string): Promise<void> {
      const request = parseRequest(line);
      if (request === null) return reply({ ok: false, error: 'malformed request' });
      try {
        switch (request.op) {
          case 'enrol-start': {
            if (enrolment !== undefined) return reply({ ok: false, error: 'this connection already has an enrolment' });
            const started = passkeys.startEnrolment(request.admin);
            enrolment = { id: started.enrolmentId, admin: request.admin };
            return reply({ ok: true, code: started.code, expiresAt: started.expiresAt, url: opts.enrolUrl });
          }
          case 'enrol-status': {
            if (enrolment === undefined) return reply({ ok: true, status: 'gone' });
            return reply({ ok: true, status: passkeys.enrolmentStatus(enrolment.id) });
          }
          case 'enrol-confirm': {
            if (enrolment === undefined) return reply({ ok: true, result: 'gone' });
            const { id, admin } = enrolment;
            const result = await passkeys.confirm(id, request.fingerprint);
            if (result !== 'not-submitted') enrolment = undefined;
            if (result === 'enrolled' && request.fingerprint !== null) {
              try {
                opts.onEnrolled?.(admin, request.fingerprint);
              } catch {
                // The passkey is stored; a failed notice does not change that.
              }
            }
            return reply({ ok: true, result });
          }
          case 'list':
            return reply({ ok: true, passkeys: await passkeys.list() });
          case 'revoke':
            return reply({ ok: true, result: await passkeys.revoke(request.fingerprint) });
        }
      } catch (err) {
        if (err instanceof PasskeyError) return reply({ ok: false, error: err.message });
        opts.log(`operator request failed (${err instanceof Error ? err.name : 'error'})`);
        return reply({ ok: false, error: 'the broker hit an internal error on this request' });
      }
    }

    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE_BYTES && !buffered.includes('\n')) {
        socket.destroy();
        return;
      }
      let at = buffered.indexOf('\n');
      while (at >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        chain = chain.then(() => handle(line)).catch(() => undefined);
        at = buffered.indexOf('\n');
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      connections.delete(socket);
      // After whatever is still being handled: the operator is gone, nothing more can be confirmed.
      chain = chain.then(() => {
        if (enrolment !== undefined) passkeys.cancelEnrolment(enrolment.id);
        enrolment = undefined;
      });
    });
  }

  const server = net.createServer(onConnection);
  const previousUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(previousUmask);
  }
  fs.chmodSync(socketPath, 0o600);

  return {
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of connections) socket.destroy();
      });
    },
  };
}

/** A client connection: one request line out, one reply line back, in order. */
export interface OperatorClient {
  call(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

export function connectOperator(socketPath: string, timeoutMs = 15_000): Promise<OperatorClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding('utf8');
    let buffered = '';
    const waiting: {
      resolve(value: Record<string, unknown>): void;
      reject(err: Error): void;
      timer: NodeJS.Timeout;
    }[] = [];
    const failAll = (err: Error) => {
      for (const waiter of waiting.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
    };
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      socket.on('error', (err) => failAll(err));
      socket.on('close', () => failAll(new Error('the broker closed the connection')));
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        let at = buffered.indexOf('\n');
        while (at >= 0) {
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          const waiter = waiting.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            try {
              const value: unknown = JSON.parse(line);
              if (isRecord(value)) waiter.resolve(value);
              else waiter.reject(new Error('the broker sent a malformed reply'));
            } catch {
              waiter.reject(new Error('the broker sent a malformed reply'));
            }
          }
          at = buffered.indexOf('\n');
        }
      });
      resolve({
        call(request) {
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              socket.destroy();
              rej(new Error('the broker did not answer in time'));
            }, timeoutMs);
            waiting.push({ resolve: res, reject: rej, timer });
            socket.write(`${JSON.stringify(request)}\n`);
          });
        },
        close() {
          socket.destroy();
        },
      });
    });
  });
}

export const PASSKEY_USAGE = [
  '  passkey enrol <admin>  enrol a passkey for an admin (Slack user id); asks for the fingerprint the page shows',
  '  passkey list           list enrolled passkeys (admin, fingerprint, date)',
  '  passkey revoke <fingerprint>',
];

function connectError(err: unknown, socketPath: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    return `no broker with an approval page is running (${socketPath}); add policy.approvalPage and restart the broker`;
  }
  if (code === 'EACCES') return `${socketPath} is not reachable; run this as the broker user (sudo -u <broker user>)`;
  return `cannot reach the broker (${code ?? 'error'})`;
}

/** Reads one line from the terminal. Null = the input ended. */
function readLine(input: Readable): Promise<string | null> {
  return new Promise((resolve) => {
    let buffered = '';
    const done = (value: string | null) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onEnd);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const at = buffered.indexOf('\n');
      if (at >= 0) {
        const rest = buffered.slice(at + 1);
        if (rest.length > 0) input.unshift(Buffer.from(rest));
        done(buffered.slice(0, at).trim());
      }
    };
    const onEnd = () => done(buffered.length > 0 ? buffered.trim() : null);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('close', onEnd);
    input.resume();
  });
}

/** `soma-devops-broker passkey …`. Returns the exit code. */
export async function runPasskeyCommand(
  args: readonly string[],
  io: { socketPath: string; stdin: Readable; stdout: Writable; stderr: Writable },
): Promise<number> {
  const out = (line: string) => io.stdout.write(`${line}\n`);
  const fail = (line: string) => {
    io.stderr.write(`soma-devops-broker: ${line}\n`);
    return 1;
  };
  const [sub, arg, ...rest] = args;
  const usage = () => {
    io.stderr.write(`soma-devops-broker: usage:\n${PASSKEY_USAGE.join('\n')}\n`);
    return 2;
  };
  if (rest.length > 0) return usage();
  if (sub === 'list' ? arg !== undefined : sub === 'enrol' || sub === 'revoke' ? arg === undefined : true)
    return usage();
  if (sub === 'enrol' && !SLACK_USER_RE.test(arg ?? '')) return fail('the admin must be a Slack user id (U… or W…)');

  let client: OperatorClient;
  try {
    client = await connectOperator(io.socketPath);
  } catch (err) {
    return fail(connectError(err, io.socketPath));
  }
  try {
    if (sub === 'list') {
      const reply = await client.call({ op: 'list' });
      if (reply.ok !== true) return fail(String(reply.error ?? 'refused'));
      const rows = Array.isArray(reply.passkeys) ? reply.passkeys.filter(isRecord) : [];
      if (rows.length === 0) out('no passkeys enrolled');
      for (const row of rows)
        out(`${String(row.fingerprint)}  ${String(row.admin).padEnd(12)}  ${String(row.createdAt)}`);
      return 0;
    }
    if (sub === 'revoke') {
      const reply = await client.call({ op: 'revoke', fingerprint: arg });
      if (reply.ok !== true) return fail(String(reply.error ?? 'refused'));
      if (reply.result !== 'revoked') return fail('no passkey has that fingerprint');
      out('revoked');
      return 0;
    }
    const started = await client.call({ op: 'enrol-start', admin: arg });
    if (started.ok !== true) return fail(String(started.error ?? 'refused'));
    // The code rides in the URL fragment: the page reads it and clears it. There is no box to paste a code
    // into, so a look-alike page cannot ask for one.
    out("1. On the admin's computer open exactly this address (it works once):");
    out(`     ${String(started.url)}#${String(started.code)}`);
    out(`   Check the address bar says ${new URL(String(started.url)).origin} before going on.`);
    out(`   (valid until ${String(started.expiresAt)}; this terminal must stay open)`);
    out('2. The page creates the passkey and shows a fingerprint (XXXX-XXXX-XXXX-XXXX).');
    out('   Type the fingerprint you see ON THAT PAGE here. Nothing is enrolled until it matches.');
    out('   If the page shows an error instead, press Enter to cancel: the address was used by someone else.');
    for (;;) {
      io.stdout.write('fingerprint> ');
      const typed = await readLine(io.stdin);
      const fingerprint = typed === null || typed.length === 0 ? null : typed;
      const reply = await client.call({ op: 'enrol-confirm', fingerprint });
      if (reply.ok !== true) return fail(String(reply.error ?? 'refused'));
      switch (reply.result) {
        case 'enrolled':
          out('enrolled. The admin can now decide approval cards on the approval page.');
          return 0;
        case 'not-submitted':
          out('The page has not handed in a passkey yet. Finish step 1 and 2, then type the fingerprint.');
          continue;
        case 'gone':
          return fail('the enrolment expired or was cancelled; nothing was enrolled');
        default:
          return fail(
            fingerprint === null
              ? 'cancelled; nothing was enrolled'
              : 'the fingerprint does not match (or the passkey was refused); nothing was enrolled — start again',
          );
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'unexpected error');
  } finally {
    client.close();
  }
}

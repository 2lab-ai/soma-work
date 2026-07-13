import { spawn } from 'node:child_process';
import {
  createTrackedClaudeProcessSpawner,
  getClaudeChildProcessRegistry,
  type TrackedClaudeProcess,
} from '../../claude-child-process-registry';

const mode = process.argv[2];
const childProgram = `
  process.on('SIGTERM', () => {});
  process.stdout.write('ready\\n');
  setInterval(() => {}, 1_000);
`;

type ReadinessProcess = Pick<TrackedClaudeProcess, 'stdout' | 'once' | 'off'>;

async function waitUntilStubborn(child: ReadinessProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => finish(new Error('stubborn child readiness timed out')), 2_000);
    timeout.unref?.();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes('ready')) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`stubborn child exited before readiness: code=${code} signal=${signal}`));
    };
    const onError = (error: Error) => finish(error);
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function reportChild(child: ReadinessProcess & { readonly pid?: number }): Promise<void> {
  if (child.pid === undefined || !process.send)
    throw new Error('Lifecycle harness requires IPC and a spawned child pid');
  process.send({ childPid: child.pid });
  await waitUntilStubborn(child);
}

async function main(): Promise<void> {
  if (mode === 'untracked') {
    const child = spawn(process.execPath, ['-e', childProgram], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await reportChild(child);
    process.exit(0);
  }

  if (mode === 'tracked') {
    const child = createTrackedClaudeProcessSpawner()({
      command: process.execPath,
      args: ['-e', childProgram],
      cwd: process.cwd(),
      env: process.env,
      signal: new AbortController().signal,
    }) as TrackedClaudeProcess;
    await reportChild(child);
    await getClaudeChildProcessRegistry().drain({ graceMs: 50, killWaitMs: 1_000 });
    process.exit(0);
  }

  throw new Error(`Unknown lifecycle harness mode: ${mode}`);
}

void main();

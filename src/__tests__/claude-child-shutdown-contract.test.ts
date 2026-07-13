import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

describe('Claude child shutdown cleanup contract', () => {
  it('aborts active requests and drains Claude children before graceful process exit', () => {
    const clearAll = source.indexOf('slackHandler.getRequestCoordinator().clearAll()');
    const drain = source.indexOf('await getClaudeChildProcessRegistry().drain()');
    const exit = source.indexOf('process.exit(0)', drain);

    expect(clearAll).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(clearAll);
    expect(exit).toBeGreaterThan(drain);
  });

  it('turns a failed child drain into an explicit non-zero shutdown', () => {
    const drain = source.indexOf('await getClaudeChildProcessRegistry().drain()');
    const failureLog = source.indexOf("logger.error('Claude child cleanup failed during shutdown:', error)", drain);
    const failureExit = source.indexOf('process.exit(1)', failureLog);
    const successExit = source.indexOf('process.exit(0)', failureExit);

    expect(drain).toBeGreaterThan(-1);
    expect(failureLog).toBeGreaterThan(drain);
    expect(failureExit).toBeGreaterThan(failureLog);
    expect(successExit).toBeGreaterThan(failureExit);
  });

  it('synchronously kills tracked Claude children from the process exit hook', () => {
    const exitHook = source.indexOf("process.on('exit', () => {");
    const exitSection = source.slice(exitHook, source.indexOf('});', exitHook) + 3);
    const kill = exitSection.indexOf("getClaudeChildProcessRegistry().killAllSync('SIGKILL')");
    const releaseLock = exitSection.indexOf('releasePidLock(DATA_DIR)');

    expect(exitHook).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(-1);
    expect(releaseLock).toBeGreaterThan(kill);
  });

  it('synchronously kills tracked Claude children in both crash handlers before exit', () => {
    const crashSections = source
      .split("process.on('")
      .filter((section) => section.startsWith('uncaughtException') || section.startsWith('unhandledRejection'));

    expect(crashSections).toHaveLength(2);
    for (const section of crashSections) {
      const kill = section.indexOf("getClaudeChildProcessRegistry().killAllSync('SIGKILL')");
      const exit = section.indexOf('process.exit(1)');
      expect(kill).toBeGreaterThan(-1);
      expect(exit).toBeGreaterThan(kill);
    }
  });
});

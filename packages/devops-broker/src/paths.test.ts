import * as path from 'node:path';
import { DEFAULT_BROKER_SOCKET_PATH } from '@soma/process-shared/devops/protocol.js';
import { afterEach, describe, expect, it } from 'vitest';
import { BROKER_ROOT_ENV, brokerPaths, DEFAULT_BROKER_ROOT } from './paths.js';

describe('brokerPaths', () => {
  const saved = process.env[BROKER_ROOT_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[BROKER_ROOT_ENV];
    else process.env[BROKER_ROOT_ENV] = saved;
  });

  it('puts the socket where the MCP server looks by default', () => {
    expect(DEFAULT_BROKER_ROOT).toBe('/usr/local/var/soma-devops');
    expect(brokerPaths(DEFAULT_BROKER_ROOT).socketPath).toBe(DEFAULT_BROKER_SOCKET_PATH);
  });

  it('lays out policy, secrets, state, ledger and run under the root', () => {
    expect(brokerPaths('/srv/devops')).toEqual({
      root: '/srv/devops',
      policyFile: '/srv/devops/policy.json',
      secretsDir: '/srv/devops/secrets',
      stateDir: '/srv/devops/state',
      ledgerFile: '/srv/devops/state/ledger.jsonl',
      runDir: '/srv/devops/run',
      socketPath: '/srv/devops/run/broker.sock',
    });
  });

  it('uses SOMA_DEVOPS_ROOT when no root is given', () => {
    process.env[BROKER_ROOT_ENV] = '/srv/override';
    expect(brokerPaths().root).toBe('/srv/override');
    expect(brokerPaths().socketPath).toBe('/srv/override/run/broker.sock');
  });

  it('falls back to the default root when the env is unset or empty', () => {
    delete process.env[BROKER_ROOT_ENV];
    expect(brokerPaths().root).toBe(DEFAULT_BROKER_ROOT);
    process.env[BROKER_ROOT_ENV] = '';
    expect(brokerPaths().root).toBe(DEFAULT_BROKER_ROOT);
  });

  it('resolves a relative root to an absolute path', () => {
    const paths = brokerPaths('relative/root');
    expect(path.isAbsolute(paths.root)).toBe(true);
    expect(paths.root).toBe(path.resolve('relative/root'));
  });
});

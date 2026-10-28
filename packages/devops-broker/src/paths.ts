// Broker data layout (.prd/16-devops-tools-architecture.md §8). The installer creates the tree:
// root 0750 broker:soma-devops, secrets/ and state/ 0700, run/ 0750 holding the 0660 socket.

import * as path from 'node:path';

export const DEFAULT_BROKER_ROOT = '/usr/local/var/soma-devops';

/** Overrides the data root (tests, non-default installs). Empty = unset. */
export const BROKER_ROOT_ENV = 'SOMA_DEVOPS_ROOT';

export interface BrokerPaths {
  root: string;
  policyFile: string;
  secretsDir: string;
  stateDir: string;
  ledgerFile: string;
  runDir: string;
  socketPath: string;
}

export function brokerPaths(root: string = process.env[BROKER_ROOT_ENV] || DEFAULT_BROKER_ROOT): BrokerPaths {
  const base = path.resolve(root);
  const stateDir = path.join(base, 'state');
  const runDir = path.join(base, 'run');
  return {
    root: base,
    policyFile: path.join(base, 'policy.json'),
    secretsDir: path.join(base, 'secrets'),
    stateDir,
    ledgerFile: path.join(stateDir, 'ledger.jsonl'),
    runDir,
    socketPath: path.join(runDir, 'broker.sock'),
  };
}

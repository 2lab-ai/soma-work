/** env-access WU4 (#1212): environments are server-tools entries with `envUser`, and the skills they list. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  environmentLabel,
  environmentOfServer,
  environmentOfSkill,
  environmentsFromConfig,
  environmentsOfPlugin,
  loadEnvironments,
} from '../env-users';

const CONFIG = {
  'server-tools': {
    permission: { list: 'read' },
    dev2: { envUser: 'env:acme-dev2', ssh: { host: 'dev2' }, skills: ['acme-env:deploy-dev2', 'acme-env:qa-dev2'] },
    'dev2-db': { envUser: 'env:acme-dev2', ssh: { host: 'db' }, skills: ['acme-env:qa-dev2'] },
    stage0: { envUser: 'env:acme-stage0', ssh: { host: 's0' }, skills: ['acme-stage:*'] },
    plain: { ssh: { host: 'p' } },
    bad: { envUser: 'acme-dev3', ssh: { host: 'x' } },
    junk: { envUser: 'env:acme-junk', skills: ['no-colon', 3, '../x:y'] },
  },
};

describe('environments', () => {
  const envs = environmentsFromConfig(CONFIG);

  it('groups the server-tools entries by envUser, with their skills', () => {
    expect(envs).toEqual([
      { id: 'env:acme-dev2', servers: ['dev2', 'dev2-db'], skills: ['acme-env:deploy-dev2', 'acme-env:qa-dev2'] },
      { id: 'env:acme-stage0', servers: ['stage0'], skills: ['acme-stage:*'] },
      { id: 'env:acme-junk', servers: ['junk'], skills: [] },
    ]);
  });

  it('finds the one environment of a skill, by exact key or plugin:*', () => {
    expect(environmentOfSkill('acme-env:deploy-dev2', envs)?.id).toBe('env:acme-dev2');
    expect(environmentOfSkill('acme-stage:anything', envs)?.id).toBe('env:acme-stage0');
    expect(environmentOfSkill('acme-env:other', envs)).toBeNull();
    expect(environmentOfSkill('acme-stagex:a', envs)).toBeNull();
  });

  it('gives a skill two environments claim to neither', () => {
    const both = environmentsFromConfig({
      'server-tools': {
        a: { envUser: 'env:a', skills: ['p:s'] },
        b: { envUser: 'env:b', skills: ['p:*'] },
      },
    });
    expect(environmentOfSkill('p:s', both)).toBeNull();
    expect(environmentOfSkill('p:t', both)?.id).toBe('env:b');
  });

  it('maps servers and plugins to environments', () => {
    expect(environmentOfServer('dev2-db', envs)?.id).toBe('env:acme-dev2');
    expect(environmentOfServer('plain', envs)).toBeNull();
    expect(environmentsOfPlugin('acme-env', envs).map((e) => e.id)).toEqual(['env:acme-dev2']);
    expect(environmentLabel('env:acme-dev2')).toBe('acme-dev2');
  });

  it('reads config.json again when it changes', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-users-')), 'config.json');
    fs.writeFileSync(file, JSON.stringify(CONFIG));
    expect(loadEnvironments(file).map((e) => e.id)).toContain('env:acme-dev2');
    fs.writeFileSync(file, JSON.stringify({ 'server-tools': { x: { envUser: 'env:only', skills: [] } } }));
    expect(loadEnvironments(file).map((e) => e.id)).toEqual(['env:only']);
    expect(loadEnvironments(path.join(path.dirname(file), 'missing.json'))).toEqual([]);
    // trinity R1 (astra): a config that stops parsing keeps the last environments read, not none (the gate stays).
    fs.writeFileSync(file, '{ not json');
    expect(loadEnvironments(file).map((e) => e.id)).toEqual(['env:only']);
  });
});

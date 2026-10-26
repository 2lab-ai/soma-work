/**
 * Real round trip, no mocks: the deploy step writes `config.json#deploySandbox`
 * and the operator then runs `/z plugin add|remove` (or a marketplace add/remove).
 * Every PluginManager CRUD persists through `loadConfig` → spread → `saveConfig`
 * (`plugin-manager.ts` `commit` → `saveConfig`), which used to drop every key
 * `Config` does not name — silently revoking the grant until the next deploy.
 * (`admin plugins update` is `forceRefresh`, which does not save config.)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDeploySandbox } from '../../deploy/apply-deploy-sandbox';
import { loadDeploySandboxGrant } from '../../sandbox/deploy-sandbox-grant';
import { PluginManager } from '../plugin-manager';

describe('PluginManager saves keep config.json#deploySandbox', () => {
  let tmpDir: string;
  let targetDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mgr-deploy-sandbox-'));
    targetDir = path.join(tmpDir, 'target');
    fs.mkdirSync(targetDir);
    configFile = path.join(targetDir, 'config.json');
    fs.writeFileSync(
      configFile,
      `${JSON.stringify(
        {
          ui: {},
          plugin: {
            marketplace: [{ name: 'acme-env', repo: 'acme/env-plugins', ref: 'main' }],
            plugins: ['acme-env@acme-env'],
          },
        },
        null,
        2,
      )}\n`,
    );
    // Exactly what the Deploy step writes for this runner.
    applyDeploySandbox({
      targetDir,
      runnerLabel: 'runner-a',
      deploySandbox: 'runner-a|UAPPROVED1|qa.example.test,admin.qa.example.test|/srv/qa/lock,/srv/qa/runs',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function grantOnDisk(): unknown {
    return JSON.parse(fs.readFileSync(configFile, 'utf8')).deploySandbox;
  }

  function manager(): PluginManager {
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return new PluginManager(onDisk.plugin, path.join(tmpDir, 'plugins'), configFile);
  }

  it.each([
    ['addPlugin', (mgr: PluginManager) => mgr.addPlugin('acme-extra@acme-env')],
    ['removePlugin', (mgr: PluginManager) => mgr.removePlugin('acme-env@acme-env')],
    ['addMarketplace', (mgr: PluginManager) => mgr.addMarketplace({ name: 'acme-more', repo: 'acme/more-plugins' })],
    ['removeMarketplace', (mgr: PluginManager) => mgr.removeMarketplace('acme-env')],
  ])('%s leaves the grant present and identical', (_label, mutate) => {
    const before = grantOnDisk();
    expect(before).toEqual({
      users: ['UAPPROVED1'],
      allowedDomains: ['qa.example.test', 'admin.qa.example.test'],
      allowWrite: ['/srv/qa/lock', '/srv/qa/runs'],
    });

    expect(mutate(manager())).toEqual({ success: true });

    expect(grantOnDisk()).toEqual(before);
    // …and the runtime still reads it, with nothing dropped.
    const logger = { warn: vi.fn() };
    expect(loadDeploySandboxGrant(configFile, logger)).toEqual(before);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('add then remove round-trips back to the same grant', () => {
    const before = grantOnDisk();
    expect(manager().addPlugin('acme-extra@acme-env')).toEqual({ success: true });
    expect(manager().removePlugin('acme-extra@acme-env')).toEqual({ success: true });
    expect(grantOnDisk()).toEqual(before);
  });
});

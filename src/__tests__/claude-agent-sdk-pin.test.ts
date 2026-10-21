/**
 * SDK 0.3.284 bundles the CLI 2.1.284. claude-opus-5-5 needs CLI >= 2.1.280
 * (2.1.251 rejected it with `unrecognized_model`); Fable 5.1 needs >= 2.1.251.
 * Use an exact version: a previous 0.2.140 upgrade was rolled back after
 * mid-turn halts. Further upgrades require behavioral validation, not just tsc.
 * build-stream-options preserves TodoWrite and blocking MCP initialization.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
const SDK = '@anthropic-ai/claude-agent-sdk';
const EXPECTED = '0.3.284';
const EXPECTED_CLI = '2.1.284';

describe('@anthropic-ai/claude-agent-sdk version pin', () => {
  it('pins the claude-opus-5-5 compatible SDK exactly', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies[SDK]).toBe(EXPECTED);
  });

  it('locks and installs the same reviewed SDK', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', SDK, 'package.json'), 'utf8'));
    expect(lock.packages[`node_modules/${SDK}`].version).toBe(EXPECTED);
    expect(installed.version).toBe(EXPECTED);
    expect(installed.optionalDependencies[`${SDK}-darwin-arm64`]).toBe(EXPECTED);
    expect(installed.claudeCodeVersion).toBe(EXPECTED_CLI);
  });
});

/**
 * SDK 0.3.321 bundles the CLI 2.1.321. claude-fable-5-2 needs a newer CLI than
 * 2.1.284: the subscription endpoint answered the 0.3.284 SDK with
 * `400 Claude Code 2.1.284 does not support this model; version 2.1.290 or
 * newer is required` (error_code `claude_code_version_too_old`, live probe
 * through llmux 2026-11-10), and Anthropic's Fable 5.2 page asks for 2.1.321.
 * Earlier floors: claude-opus-5-5 needs CLI >= 2.1.280 (2.1.251 rejected it with
 * `unrecognized_model`); Fable 5.1 needs >= 2.1.251.
 * Behavioural validation for 0.3.284 -> 0.3.321 (2026-11-10, through llmux):
 * a two-turn Bash tool round trip succeeded on claude-fable-5-2[1m],
 * claude-opus-5-5[1m], gpt-6.1-terra[1m] and grok-4.6, and the SDK priced
 * Fable 5.2 at its own $8 / $40 / $0.20 / $10 rates.
 * Use an exact version: a previous 0.2.140 upgrade was rolled back after
 * mid-turn halts. Further upgrades require behavioral validation, not just tsc.
 * build-stream-options preserves TodoWrite and blocking MCP initialization.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
const SDK = '@anthropic-ai/claude-agent-sdk';
const EXPECTED = '0.3.321';
const EXPECTED_CLI = '2.1.321';

describe('@anthropic-ai/claude-agent-sdk version pin', () => {
  it('pins the claude-fable-5-2 compatible SDK exactly', () => {
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

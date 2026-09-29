/**
 * Conformance of `evaluateToolPolicy` with its Lean model on real tool calls, through the real
 * guard primitives (no mocks).
 *
 * Each `concrete` vector is a real call (a sensitive Read, `ssh`, a cross-user path, a
 * dangerous `rm -rf`, a safe `ls`, a denied MCP tool, a PR creation in a handoff session, ...).
 * It lists the primitive calls the policy makes for it with the values the model was given; this
 * suite first checks those values against the real primitives, then requires the real
 * `evaluateToolPolicy` to return the model's result. The sensitive-path entry, arguments
 * included, is the model's own `sensitiveCall` for the case's input. The `constants` vector pins
 * the tool lists the model hardcodes.
 *
 * `{{HOME}}` in a vector stands for `os.homedir()` and is substituted before anything runs, so
 * the committed file names no home directory. The mocked, exhaustive counterpart is
 * `tool-policy.lean-conformance.test.ts`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { bypassBashPermissionDecision, isCrossUserAccess, isSshCommand } from '../../dangerous-command-filter';
import { NATIVE_BYPASS_TOOLS } from '../../hooks/bypass-permission-guard';
import { handlePrIssuePrecondition, type PrIssueGuardInput } from '../../hooks/pr-issue-guard';
import { checkBashSensitivePaths, checkSensitiveGlob, checkSensitivePath } from '../../sensitive-path-filter';
import type { HandoffContext } from '../../types';
import type { PermissionMode } from '../policy/permission-mode';
import { evaluateToolPolicy, TOOL_POLICY_MATCHERS, type ToolPolicyContext } from '../policy/tool-policy';

const repoRoot = path.resolve(__dirname, '../../..');

type PrimitiveCall =
  | {
      fn: 'isSshCommand' | 'checkBashSensitivePaths' | 'checkSensitivePath';
      args: [string];
      result: unknown;
    }
  /** A base path that is `undefined` is written `null`. */
  | { fn: 'checkSensitiveGlob'; args: [string, string | null]; result: unknown }
  | { fn: 'isCrossUserAccess'; args: [string, string]; result: unknown }
  | { fn: 'handlePrIssuePrecondition'; args: [PrIssueGuardInput]; result: unknown }
  | { fn: 'bypassBashPermissionDecision'; args: [string]; disabledRules: string[]; result: unknown };

interface ConcreteCase {
  kind: 'concrete';
  name: string;
  tool: string;
  input: Record<string, unknown>;
  ctx: {
    user: string;
    isAdmin: boolean;
    mode: PermissionMode;
    aborted: boolean;
    handoffContext: HandoffContext | null;
    mcpDenied: string | null;
    disabledRules: string[];
  };
  pre: PrimitiveCall[];
  expect: Record<string, unknown>;
}

interface ConstantsCase {
  kind: 'constants';
  nativeBypassTools: string[];
  toolPolicyMatchers: string[];
}

interface VectorFile {
  module: string;
  count: number;
  cases: Array<{ kind: string }>;
}

const HOME_TOKEN = '{{HOME}}';

/** Every string in `value` with `{{HOME}}` replaced by the real home directory. */
function withHome<T>(value: T): T {
  if (typeof value === 'string') return value.split(HOME_TOKEN).join(os.homedir()) as T;
  if (Array.isArray(value)) return value.map(withHome) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withHome(v)])) as T;
  }
  return value;
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'verification/vectors/tool-policy.json'), 'utf8'),
) as VectorFile;

const concrete = vectors.cases.filter((c) => c.kind === 'concrete').map((c) => withHome(c as ConcreteCase));
const constants = vectors.cases.filter((c) => c.kind === 'constants') as ConstantsCase[];

function call(pre: PrimitiveCall): unknown {
  switch (pre.fn) {
    case 'isSshCommand':
      return isSshCommand(pre.args[0]);
    case 'checkBashSensitivePaths':
      return checkBashSensitivePaths(pre.args[0]);
    case 'checkSensitivePath':
      return checkSensitivePath(pre.args[0]);
    case 'checkSensitiveGlob':
      return checkSensitiveGlob(pre.args[0], pre.args[1] ?? undefined);
    case 'isCrossUserAccess':
      return isCrossUserAccess(pre.args[0], pre.args[1]);
    case 'handlePrIssuePrecondition':
      return handlePrIssuePrecondition(pre.args[0]);
    case 'bypassBashPermissionDecision':
      return bypassBashPermissionDecision(pre.args[0], (id) => pre.disabledRules.includes(id));
    default:
      // e.g. `no-sensitive-call`: a case that lists a sensitive-path check the model never makes.
      throw new Error(`unknown primitive call ${JSON.stringify(pre)}`);
  }
}

function contextOf(c: ConcreteCase): ToolPolicyContext {
  return {
    user: c.ctx.user,
    isAdmin: c.ctx.isAdmin,
    mode: c.ctx.mode,
    aborted: c.ctx.aborted,
    isDangerousRuleDisabled: (id) => c.ctx.disabledRules.includes(id),
    handoffContext: c.ctx.handoffContext ?? undefined,
    checkMcpToolPermission: () => c.ctx.mcpDenied,
  };
}

/** A JSON round trip drops `undefined` properties, which the vector file cannot hold. */
function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

describe('tool-policy Lean conformance vectors (real primitives)', () => {
  it('carry enough distinct concrete cases', () => {
    expect(vectors.module).toBe('tool-policy');
    expect(concrete.length).toBeGreaterThanOrEqual(12);
    expect(new Set(concrete.map((c) => c.name)).size).toBe(concrete.length);
    // No home directory is committed: only the placeholder is, substituted above. (A home of
    // `/`, as in some containers, would match every path, so it is not checked.)
    const raw = fs.readFileSync(path.join(repoRoot, 'verification/vectors/tool-policy.json'), 'utf8');
    expect(raw.includes(HOME_TOKEN)).toBe(true);
    if (os.homedir() !== '/') expect(raw.includes(os.homedir())).toBe(false);
  });

  it('pin the tool lists the model hardcodes', () => {
    expect(constants).toHaveLength(1);
    expect([...NATIVE_BYPASS_TOOLS]).toEqual(constants[0].nativeBypassTools);
    expect([...TOOL_POLICY_MATCHERS]).toEqual(constants[0].toolPolicyMatchers);
  });

  it('assert primitive results the real primitives return', () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const c of concrete) {
      for (const pre of c.pre) {
        checked += 1;
        const actual = plain(call(pre));
        if (!isDeepStrictEqual(actual, pre.result)) {
          mismatches.push(
            `${c.name}: ${pre.fn}(${JSON.stringify(pre.args)}) vector ${JSON.stringify(pre.result)}, real ${JSON.stringify(actual)}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBe(concrete.reduce((sum, c) => sum + c.pre.length, 0));
  });

  it('agree with evaluateToolPolicy on every concrete call', () => {
    const mismatches: string[] = [];
    for (const c of concrete) {
      const actual = plain(evaluateToolPolicy(c.tool, c.input, contextOf(c)));
      if (!isDeepStrictEqual(actual, c.expect)) {
        mismatches.push(`${c.name}: model ${JSON.stringify(c.expect)}, code ${JSON.stringify(actual)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

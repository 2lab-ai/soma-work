/**
 * Conformance of `evaluateToolPolicy` with its Lean model, over every combination of
 * primitive results.
 *
 * `verification/lean/SomaVerify/ToolPolicy/Model.lean` transcribes the policy with the guard
 * primitives (`isSshCommand`, the sensitive-path checks, `isCrossUserAccess`,
 * `checkMcpToolPermission`, `handlePrIssuePrecondition`, `bypassBashPermissionDecision`) as
 * inputs. `Proofs.lean` proves the documented invariants of the phase-1 policy
 * (`ModelOriginal.lean`) and `Simplification.lean` proves they hold for `Model.lean` too, which
 * returns the phase-1 result for every input (`evaluate_toOriginal`). This suite ties the model to the
 * code: it mocks every primitive module the policy imports, and for each vector row feeds the
 * row's primitive results to the REAL `evaluateToolPolicy`, once per call of the row, requiring
 * the model's result exactly. The `table` rows are the full truth table: every mode, context
 * flag and primitive result, for every path through the policy's tool-name tests. The `incident`
 * rows are the only ones with `ctx.incidentReadOnly` set: allowlists, near misses of them and
 * every deny condition, in every mode, for admins and non-admins (`ProofsIncident.lean` proves
 * what the incident tier does).
 *
 * The sensitive-path checks are held to their arguments as well: each call carries the check
 * and arguments the model says the policy passes (`sensitiveCall`), and the mocked checks answer
 * only that exact call, throwing on any other check or argument list. A slip in how the policy
 * picks those arguments from the tool input therefore fails the replay.
 *
 * Real inputs through the real primitives are replayed by
 * `tool-policy.concrete.lean-conformance.test.ts` (`vi.mock` is file-scoped, hence two files).
 * The vector file is regenerated and drift-checked by the "Lean Verify" workflow
 * (`scripts/verification/lean-verify.sh --check`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dangerous-command-filter', () => ({
  bypassBashPermissionDecision: vi.fn(),
  isCrossUserAccess: vi.fn(),
  isSshCommand: vi.fn(),
}));
vi.mock('../../sensitive-path-filter', () => ({
  checkBashSensitivePaths: vi.fn(),
  checkSensitiveGlob: vi.fn(),
  checkSensitivePath: vi.fn(),
}));
vi.mock('../../hooks/pr-issue-guard', () => ({
  handlePrIssuePrecondition: vi.fn(),
}));

import {
  type BypassBashPermissionResult,
  bypassBashPermissionDecision,
  isCrossUserAccess,
  isSshCommand,
} from '../../dangerous-command-filter';
import { handlePrIssuePrecondition, type PrIssueGuardResult } from '../../hooks/pr-issue-guard';
import {
  checkBashSensitivePaths,
  checkSensitiveGlob,
  checkSensitivePath,
  type SensitivePathResult,
} from '../../sensitive-path-filter';
import type { HandoffContext } from '../../types';
import type { PermissionMode } from '../policy/permission-mode';
import { evaluateToolPolicy, type IncidentReadOnlyContext, type ToolPolicyContext } from '../policy/tool-policy';

const repoRoot = path.resolve(__dirname, '../../..');

interface Primitives {
  ssh: boolean;
  sensitive: SensitivePathResult;
  crossUser: boolean;
  mcpDenied: string | null;
  /** The model treats `reason` as an opaque string; a boundary vector uses `''`. */
  prIssue: { blocked: boolean; reason?: string; message?: string };
  bash: BypassBashPermissionResult;
}

/** A sensitive-path check call: the check and its arguments. */
interface SensitiveCall {
  fn: 'checkBashSensitivePaths' | 'checkSensitivePath' | 'checkSensitiveGlob';
  /** A Glob base path that is `undefined` is written `null`. */
  args: Array<string | null>;
}

interface MockedCall {
  tool: string;
  /** `null` stands for an undefined `toolInput`. */
  input: Record<string, unknown> | null;
  /** The sensitive-path call the model says the policy makes; `null`: none. */
  sensitiveCall: SensitiveCall | null;
  expect: Record<string, unknown>;
}

interface MockedRow {
  kind: 'table' | 'tool-names' | 'boundary' | 'arguments' | 'incident';
  mode: PermissionMode;
  isAdmin: boolean;
  aborted: boolean;
  handoff: boolean;
  prims: Primitives;
  /** Present only on `incident` rows; absent means `ctx.incidentReadOnly` stays undefined. */
  incidentReadOnly?: IncidentReadOnlyContext;
  calls: MockedCall[];
}

interface VectorFile {
  module: string;
  generator: string;
  lean: string;
  count: number;
  cases: Array<{ kind: string }>;
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'verification/vectors/tool-policy.json'), 'utf8'),
) as VectorFile;

const MOCKED_KINDS = ['table', 'tool-names', 'boundary', 'arguments', 'incident'];
const rows = vectors.cases.filter((c) => MOCKED_KINDS.includes(c.kind)) as MockedRow[];

/**
 * Any defined context works: the PR-issue primitive is mocked, and the policy only tests
 * `ctx.handoffContext` for presence.
 */
const HANDOFF: HandoffContext = {
  handoffKind: 'plan-to-work',
  sourceIssueUrl: null,
  escapeEligible: false,
  tier: null,
  issueRequiredByUser: false,
  parentEpicUrl: null,
  chainId: 'chain-vectors',
  hopBudget: 1,
};

/**
 * The sensitive-path checks answer only `expected`, with `value`, and throw on any other check or
 * argument list, so the policy's choice of arguments is replayed along with its logic.
 */
function mockSensitiveChecks(expected: SensitiveCall | null, value: SensitivePathResult): void {
  const answer = (fn: SensitiveCall['fn'], args: Array<string | undefined>): SensitivePathResult => {
    if (
      expected !== null &&
      expected.fn === fn &&
      isDeepStrictEqual(
        args,
        expected.args.map((a) => a ?? undefined),
      )
    ) {
      return value;
    }
    throw new Error(`unexpected ${fn}(${JSON.stringify(args)}); the model calls ${JSON.stringify(expected)}`);
  };
  vi.mocked(checkBashSensitivePaths).mockImplementation((command) => answer('checkBashSensitivePaths', [command]));
  vi.mocked(checkSensitivePath).mockImplementation((filePath) => answer('checkSensitivePath', [filePath]));
  vi.mocked(checkSensitiveGlob).mockImplementation((pattern, basePath) =>
    answer('checkSensitiveGlob', [pattern, basePath]),
  );
}

function mockPrimitives(prims: Primitives): void {
  vi.mocked(isSshCommand).mockReturnValue(prims.ssh);
  vi.mocked(isCrossUserAccess).mockReturnValue(prims.crossUser);
  vi.mocked(handlePrIssuePrecondition).mockReturnValue(prims.prIssue as PrIssueGuardResult);
  vi.mocked(bypassBashPermissionDecision).mockReturnValue(prims.bash);
}

function contextOf(row: MockedRow): ToolPolicyContext {
  return {
    user: 'U0VECTOR01',
    isAdmin: row.isAdmin,
    mode: row.mode,
    aborted: row.aborted,
    isDangerousRuleDisabled: () => false,
    handoffContext: row.handoff ? HANDOFF : undefined,
    checkMcpToolPermission: () => row.prims.mcpDenied,
    ...(row.incidentReadOnly ? { incidentReadOnly: row.incidentReadOnly } : {}),
  };
}

/** Replays every call of `selected`; returns the mismatches and how many calls ran. */
function replay(selected: MockedRow[]): { mismatches: string[]; calls: number } {
  const mismatches: string[] = [];
  let calls = 0;
  for (const row of selected) {
    mockPrimitives(row.prims);
    const ctx = contextOf(row);
    for (const call of row.calls) {
      calls += 1;
      mockSensitiveChecks(call.sensitiveCall, row.prims.sensitive);
      let actual: unknown;
      try {
        // A JSON round trip drops `undefined` properties, which the vector file cannot hold.
        actual = JSON.parse(JSON.stringify(evaluateToolPolicy(call.tool, call.input ?? undefined, ctx)));
      } catch (error) {
        actual = { threw: error instanceof Error ? error.message : String(error) };
      }
      if (!isDeepStrictEqual(actual, call.expect)) {
        const { calls: _calls, ...context } = row;
        mismatches.push(
          `${JSON.stringify(context)} tool=${JSON.stringify(call.tool)} input=${JSON.stringify(call.input)}: ` +
            `model ${JSON.stringify(call.expect)}, code ${JSON.stringify(actual)}`,
        );
      }
    }
  }
  return { mismatches, calls };
}

function rowsOf(kind: MockedRow['kind']): MockedRow[] {
  return rows.filter((row) => row.kind === kind);
}

function callCount(selected: MockedRow[]): number {
  return selected.reduce((sum, row) => sum + row.calls.length, 0);
}

describe('tool-policy Lean conformance vectors (mocked primitives)', () => {
  it('carry exactly the cases they declare, each of a known kind', () => {
    expect(vectors.module).toBe('tool-policy');
    expect(vectors.count).toBe(vectors.cases.length);
    const known = [...MOCKED_KINDS, 'constants', 'concrete'];
    expect(vectors.cases.filter((c) => !known.includes(c.kind)).map((c) => c.kind)).toEqual([]);
  });

  it('were generated by the pinned Lean toolchain', () => {
    const toolchain = fs.readFileSync(path.join(repoRoot, 'verification/lean/lean-toolchain'), 'utf8').trim();
    expect(toolchain).toBe(`leanprover/lean4:v${vectors.lean}`);
  });

  it('hold the full truth table: 3 modes × 2^9 flag and primitive combinations, no repeats', () => {
    const table = rowsOf('table');
    expect(table).toHaveLength(1536);
    const combinations = new Set(table.map(({ calls: _calls, ...context }) => JSON.stringify(context)));
    expect(combinations.size).toBe(1536);
    // One call per path through the policy's tool-name tests, the same nine in every row.
    const tools = JSON.stringify(table[0].calls.map((c) => [c.tool, c.input]));
    expect(table.every((row) => JSON.stringify(row.calls.map((c) => [c.tool, c.input])) === tools)).toBe(true);
    expect(table[0].calls).toHaveLength(9);
  });

  it('set incidentReadOnly on exactly the incident rows, in every mode, for admins and non-admins', () => {
    expect(rows.filter((row) => (row.incidentReadOnly !== undefined) !== (row.kind === 'incident'))).toEqual([]);
    const incident = rowsOf('incident');
    expect(new Set(incident.map((row) => `${row.mode}/${row.isAdmin}`)).size).toBe(6);
    // The incident tier only allows or denies, and the rows reach both outcomes.
    const decisions = new Set(incident.flatMap((row) => row.calls.map((call) => call.expect.decision)));
    expect([...decisions].sort()).toEqual(['allow', 'deny']);
  });

  for (const kind of MOCKED_KINDS as MockedRow['kind'][]) {
    it(`agree with evaluateToolPolicy on every ${kind} call`, () => {
      const selected = rowsOf(kind);
      expect(selected.length).toBeGreaterThan(0);
      const { mismatches, calls } = replay(selected);
      expect(mismatches).toEqual([]);
      expect(calls).toBe(callCount(selected));
    });
  }

  it('agree on every mocked call in the file, all kinds together', () => {
    const { mismatches, calls } = replay(rows);
    expect(mismatches).toEqual([]);
    expect(calls).toBe(callCount(rows));
    expect(calls).toBeGreaterThan(13824);
  });
});

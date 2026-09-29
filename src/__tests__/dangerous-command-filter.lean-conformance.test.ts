/**
 * Conformance of `src/dangerous-command-filter.ts` with its Lean model.
 *
 * `verification/lean/SomaVerify/BypassDecision/Model.lean` transcribes
 * `bypassBashPermissionDecision` over an abstract catalog in which each rule
 * already carries what its matcher returned. `Proofs.lean` proves the
 * documented invariants of that model (lockdown rules never take part,
 * disabling only silences, an `allow` carries no ids) and its equality with
 * the model of the function before its simplification (`ModelOriginal.lean`).
 * `Vectors.lean` writes `verification/vectors/bypass-decision.json`, and this
 * suite replays every case against the exported function.
 *
 * The function reads soma-lib's catalog through a module import, so the cases
 * reach it in two ways:
 *
 * - Abstract cases (`bypass-*`) bring their own catalog. A second instance of
 *   `../dangerous-command-filter` is loaded with the imported `DANGEROUS_RULES`
 *   replaced by an array this suite refills before each case. Each rule's
 *   matcher returns the case's `matches` flag. The function body is the real
 *   one; only the catalog it iterates is substituted.
 * - Real-catalog cases run the statically imported module, unmocked, on
 *   soma-lib's catalog. A case records which matchers fire on its command
 *   with the empty context the function passes. The suite first checks that
 *   they still do, so the model saw exactly what the real catalog reports,
 *   then compares the results.
 *
 * The vector file is regenerated and drift-checked by the "Lean Verify"
 * workflow (`scripts/verification/lean-verify.sh --check`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DangerousRule, DangerousRuleContext } from 'somalib/permission/dangerous-rules';
import { DANGEROUS_RULES } from 'somalib/permission/dangerous-rules';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as unmocked from '../dangerous-command-filter';

const repoRoot = path.resolve(__dirname, '../..');

interface RuleInput {
  id: string;
  sessionOverridable: boolean;
  matches: boolean;
}

interface BypassResult {
  decision: 'allow' | 'ask';
  matchedRuleIds: string[];
}

interface BypassCase {
  group: 'bypass-exhaustive' | 'bypass-targeted';
  catalog: RuleInput[];
  disabled: string[];
  expect: BypassResult;
}

interface RealRulesCase {
  group: 'real-catalog-rules';
  rules: { id: string; sessionOverridable: boolean }[];
}

interface RealCommandCase {
  group: 'real-catalog';
  command: string;
  matches: string[];
  /** `null`: no predicate, i.e. the default `() => false`. */
  disabled: string[] | null;
  expect: { bypassBashPermissionDecision: BypassResult };
}

type Case = BypassCase | RealRulesCase | RealCommandCase;

interface VectorFile {
  module: string;
  generator: string;
  lean: string;
  count: number;
  cases: Case[];
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'verification/vectors/bypass-decision.json'), 'utf8'),
) as VectorFile;

const bypassCases = vectors.cases.filter(
  (c): c is BypassCase => c.group === 'bypass-exhaustive' || c.group === 'bypass-targeted',
);
const realRulesCases = vectors.cases.filter((c): c is RealRulesCase => c.group === 'real-catalog-rules');
const realCommandCases = vectors.cases.filter((c): c is RealCommandCase => c.group === 'real-catalog');

/** Every catalog of 0 to 4 rules over `kinds` rule kinds. */
function exhaustiveCount(kinds: number): number {
  return [0, 1, 2, 3, 4].reduce((sum, n) => sum + kinds ** n, 0);
}

/** The command abstract cases pass; their matchers check they receive it. */
const ABSTRACT_COMMAND = 'abstract catalog case';

/** What the substituted module instance sees as `DANGEROUS_RULES`. */
const substitutedCatalog: DangerousRule[] = [];

/** Matcher calls that did not receive `ABSTRACT_COMMAND` and an empty context. */
const unexpectedMatchCalls: string[] = [];

let substituted: typeof unmocked;

function loadCatalog(catalog: RuleInput[]): void {
  const rules = catalog.map(
    (rule): DangerousRule => ({
      id: rule.id,
      label: rule.id,
      description: rule.id,
      sessionOverridable: rule.sessionOverridable,
      match: (command: string, ctx: DangerousRuleContext) => {
        if (command !== ABSTRACT_COMMAND || Object.keys(ctx).length > 0) {
          unexpectedMatchCalls.push(`${rule.id}: ${JSON.stringify(command)} ${JSON.stringify(ctx)}`);
        }
        return rule.matches;
      },
    }),
  );
  substitutedCatalog.splice(0, substitutedCatalog.length, ...rules);
}

function observedMatches(command: string): string[] {
  return DANGEROUS_RULES.filter((rule) => rule.match(command, {})).map((rule) => rule.id);
}

describe('bypass-decision Lean conformance vectors', () => {
  it('carry exactly the cases they declare, each in a group replayed below', () => {
    expect(vectors.module).toBe('bypass-decision');
    expect(vectors.count).toBe(vectors.cases.length);
    expect(bypassCases.length + realRulesCases.length + realCommandCases.length).toBe(vectors.count);
    expect(realRulesCases).toHaveLength(1);
  });

  it('cover every catalog of up to four rules, each once', () => {
    const exhaustiveBypass = bypassCases.filter((c) => c.group === 'bypass-exhaustive');
    expect(exhaustiveBypass).toHaveLength(exhaustiveCount(8));
    // Inside the domain (ids r1..rn by position, disabled ids among them) and
    // distinct: with the count above, that is every catalog of the domain.
    for (const c of exhaustiveBypass) {
      expect(c.catalog.map((rule) => rule.id)).toEqual(['r1', 'r2', 'r3', 'r4'].slice(0, c.catalog.length));
      expect(c.disabled.every((id) => c.catalog.some((rule) => rule.id === id))).toBe(true);
    }
    const distinct = (keys: string[]) => new Set(keys).size === keys.length;
    expect(distinct(bypassCases.map((c) => JSON.stringify([c.catalog, c.disabled])))).toBe(true);
    expect(distinct(realCommandCases.map((c) => JSON.stringify([c.command, c.disabled])))).toBe(true);
  });

  it('were generated by the pinned Lean toolchain', () => {
    const toolchain = fs.readFileSync(path.join(repoRoot, 'verification/lean/lean-toolchain'), 'utf8').trim();
    expect(toolchain).toBe(`leanprover/lean4:v${vectors.lean}`);
  });
});

describe('abstract catalogs: the exported function over a substituted catalog', () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('somalib/permission/dangerous-rules', async (importOriginal) => ({
      ...(await importOriginal<typeof import('somalib/permission/dangerous-rules')>()),
      DANGEROUS_RULES: substitutedCatalog,
    }));
    substituted = await import('../dangerous-command-filter');
  });

  it('load as a separate instance of the module', () => {
    expect(substituted).not.toBe(unmocked);
  });

  it('bypassBashPermissionDecision returns the model result on every bypass case', () => {
    unexpectedMatchCalls.length = 0;
    const mismatches: string[] = [];
    for (const c of bypassCases) {
      loadCatalog(c.catalog);
      const disabled = new Set(c.disabled);
      const actual = substituted.bypassBashPermissionDecision(ABSTRACT_COMMAND, (ruleId) => disabled.has(ruleId));
      if (!isDeepStrictEqual(actual, c.expect)) {
        mismatches.push(
          `[${c.group}] catalog ${JSON.stringify(c.catalog)} disabled ${JSON.stringify(c.disabled)}: ` +
            `TS ${JSON.stringify(actual)}, model ${JSON.stringify(c.expect)}`,
        );
      }
    }
    expect(unexpectedMatchCalls).toEqual([]);
    expect(mismatches).toEqual([]);
  });
});

describe('real catalog: the unmocked module on soma-lib DANGEROUS_RULES', () => {
  it('has the ids and sessionOverridable flags the vectors were generated for', () => {
    expect(DANGEROUS_RULES.map((rule) => ({ id: rule.id, sessionOverridable: rule.sessionOverridable }))).toEqual(
      realRulesCases[0].rules,
    );
  });

  it('fires, on every recorded command, exactly the recorded matchers', () => {
    const drift = realCommandCases
      .filter((c) => !isDeepStrictEqual(observedMatches(c.command), c.matches))
      .map(
        (c) =>
          `${JSON.stringify(c.command)}: soma-lib ${JSON.stringify(observedMatches(c.command))}, vectors ${JSON.stringify(c.matches)}`,
      );
    expect(drift).toEqual([]);
  });

  it('returns the model result on every command and disable setting', () => {
    const mismatches: string[] = [];
    for (const c of realCommandCases) {
      const disabled = c.disabled === null ? null : new Set(c.disabled);
      // No predicate: omitted, and passed as `undefined`; both take the default.
      const bypassResults =
        disabled === null
          ? [
              unmocked.bypassBashPermissionDecision(c.command),
              unmocked.bypassBashPermissionDecision(c.command, undefined),
            ]
          : [unmocked.bypassBashPermissionDecision(c.command, (ruleId) => disabled.has(ruleId))];
      for (const bypass of bypassResults) {
        const actual = { bypassBashPermissionDecision: bypass };
        if (!isDeepStrictEqual(actual, c.expect)) {
          mismatches.push(
            `${JSON.stringify(c.command)} disabled ${JSON.stringify(c.disabled)}: ` +
              `TS ${JSON.stringify(actual)}, model ${JSON.stringify(c.expect)}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

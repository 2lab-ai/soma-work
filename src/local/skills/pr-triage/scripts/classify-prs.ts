#!/usr/bin/env npx tsx
/**
 * pr-triage classification helper
 *
 * Reads PR list JSON (either `gh pr list --json ...` plain output or a
 * GraphQL query result via `gh api graphql ...`) plus an optional
 * per-PR CI-status JSON keyed by PR number, computes:
 *
 *   - lastActivityAt: max(headCommit, latestComment, latestReview submission)
 *     -- explicitly NOT pr.updatedAt (label/milestone/reviewer changes reset
 *     it, which would let this skill self-reset its own stale clock).
 *   - ageDays: floor((now - lastActivityAt) / 86400000), UTC.
 *   - tier: "failing-CI" | "approved" | "draft" | "ready" -- most-specific match.
 *   - category: e.g. "approved-mergeable", "approved-stale", "stale", "rotten",
 *     "behind", "conflicted", "no-ci-yet", "stack-dependent", "stack-stuck",
 *     "exempt", "healthy".
 *   - recommendedLabels: array drawn from {"stale","rotten","needs-rebase",
 *     "needs-ci-fix"}. Idempotent: only labels NOT already on the PR.
 *   - removeLabels: array of currently-present labels that should be removed
 *     (un-staling on fresh activity).
 *   - parent: { number, headRefName, category } | null  (stack-PR linkage)
 *   - reasonHints: short strings that the LLM concatenates into the per-PR
 *     "Reason" cell of the report. Avoid one-message-for-all-PRs (the
 *     documented weakness of actions/stale).
 *
 * Decision tree mirrors src/local/skills/pr-triage/SKILL.md §5 + §6.
 *
 * Usage:
 *   gh api graphql -f query='...' --paginate > prs.json
 *   gh run list --branch <H> --limit 1 --json status,conclusion,databaseId,createdAt -q '.[0]' > ci-<num>.json  (per PR, in parallel)
 *   npx tsx local/skills/pr-triage/scripts/classify-prs.ts \
 *     --prs prs.json [--ci ci-by-num.json] [--now 2026-05-08T06:00:00Z]
 *
 *   Output is JSON written to stdout.
 *
 * Input shapes accepted (auto-detected):
 *   1) GraphQL: { data: { repository: { pullRequests: { nodes: [...] } } } }
 *   2) Paginated GraphQL bag: array of objects each shaped as (1)
 *   3) `gh pr list --json ...` plain array of PR records
 *
 * The script is intentionally pure: no network calls. Run gh separately.
 */

import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IsoString = string;

type Tier = 'failing-CI' | 'approved' | 'draft' | 'ready';

type Category =
  | 'approved-mergeable'
  | 'approved-stale'
  | 'approved-rotten'
  | 'awaiting-review-active'
  | 'awaiting-review-stale'
  | 'awaiting-review-rotten'
  | 'changes-requested-active'
  | 'changes-requested-stale'
  | 'changes-requested-rotten'
  | 'draft-active'
  | 'draft-stale'
  | 'draft-rotten'
  | 'failing-ci-active'
  | 'failing-ci-stale'
  | 'failing-ci-rotten'
  | 'behind-base'
  | 'conflicted'
  | 'no-ci-yet'
  | 'stack-dependent'
  | 'stack-stuck'
  | 'exempt'
  | 'healthy';

type LabelName = 'stale' | 'rotten' | 'needs-rebase' | 'needs-ci-fix' | 'keep-open' | 'pinned';

interface RawPR {
  number: number;
  title: string;
  isDraft: boolean;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | string;
  mergeStateStatus?: 'CLEAN' | 'BEHIND' | 'BLOCKED' | 'DIRTY' | 'DRAFT' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE' | string;
  baseRefName: string;
  headRefName: string;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  author?: { login?: string } | { login: string } | null;
  createdAt: IsoString;
  updatedAt: IsoString;
  labels?: { nodes: { name: string }[] } | { name: string }[]; // graphql vs `gh pr list --json labels`
  commits?: { nodes: { commit: { committedDate: IsoString } }[] };
  comments?: { nodes: { createdAt: IsoString }[] };
  reviews?: { nodes: { submittedAt: IsoString }[] };
  latestReviews?: { nodes: { submittedAt: IsoString }[] };
}

interface CiStatus {
  status?: string | null; // 'completed' | 'in_progress' | 'queued' | null
  conclusion?: string | null; // 'success' | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | 'neutral' | null
  databaseId?: number | null;
  createdAt?: IsoString | null;
}

type CiOutcome = 'green' | 'red' | 'in-flight' | 'no-run' | 'other'; // 'skipped' | 'neutral' etc — treated as no-signal

interface ClassifiedPR {
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  labels: string[];
  lastActivityAt: IsoString;
  ageDays: number;
  ciOutcome: CiOutcome;
  ciDetail: { status: string | null; conclusion: string | null; runId: number | null; createdAt: IsoString | null };
  tier: Tier;
  category: Category;
  recommendedLabels: LabelName[];
  removeLabels: LabelName[];
  parent: { number: number; headRefName: string; category: Category } | null;
  reasonHints: string[];
}

interface ClassifyOutput {
  generatedAt: IsoString;
  repo: '2lab-ai/soma-work';
  totalOpen: number;
  warnings: string[];
  byCategory: Record<string, number>;
  prs: ClassifiedPR[];
}

// ---------------------------------------------------------------------------
// Thresholds (must match SKILL.md §"Tier policy")
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  draft: { stale: 7, rotten: 14 },
  ready: { stale: 14, rotten: 30 },
  approved: { stale: 5, rotten: 10 },
  'failing-CI': { stale: 7, rotten: 14 },
} as const;

const NEEDS_CI_FIX_AGE_D = 3;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  prsPath: string;
  ciPath?: string;
  now: number; // epoch ms
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> & { now?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prs') args.prsPath = argv[++i];
    else if (a === '--ci') args.ciPath = argv[++i];
    else if (a === '--now') args.now = Date.parse(argv[++i]);
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.prsPath) throw new Error('--prs <path> required');
  return {
    prsPath: args.prsPath,
    ciPath: args.ciPath,
    now: args.now ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

/** Accept GraphQL/paginated/`gh pr list` shapes; normalize to RawPR[]. */
function normalizePRs(raw: unknown): RawPR[] {
  if (Array.isArray(raw)) {
    // Either `gh pr list --json` (objects with .number) or paginated GraphQL bag
    if (raw.length === 0) return [];
    const first = raw[0] as Record<string, unknown>;
    if (typeof first.number === 'number') return raw as RawPR[];
    // assume paginated GraphQL: array of {data:{repository:{pullRequests:{nodes:[]}}}}
    return raw.flatMap((page) => extractFromGraphQL(page));
  }
  return extractFromGraphQL(raw);
}

function extractFromGraphQL(obj: unknown): RawPR[] {
  if (!obj || typeof obj !== 'object') return [];
  const o = obj as Record<string, unknown>;
  const repo = (o.data as Record<string, unknown> | undefined)?.repository as Record<string, unknown> | undefined;
  const prs = (repo?.pullRequests as Record<string, unknown> | undefined)?.nodes;
  if (Array.isArray(prs)) return prs as RawPR[];
  return [];
}

function readLabels(pr: RawPR): string[] {
  if (!pr.labels) return [];
  // graphql: { nodes: [{name}] } ; gh pr list --json labels: [{name}]
  if (Array.isArray(pr.labels)) return pr.labels.map((l) => l.name);
  if ('nodes' in pr.labels) return pr.labels.nodes.map((l) => l.name);
  return [];
}

function readAuthor(pr: RawPR): string {
  const a = pr.author;
  if (!a) return 'unknown';
  if (typeof a === 'object' && 'login' in a && typeof a.login === 'string') return a.login;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Activity timestamp (NOT pr.updatedAt)
// ---------------------------------------------------------------------------

function lastActivity(pr: RawPR): IsoString {
  const ts: number[] = [];

  const pushIso = (s?: IsoString | null): void => {
    if (!s) return;
    const n = Date.parse(s);
    if (!Number.isNaN(n)) ts.push(n);
  };

  // Head commit
  for (const n of pr.commits?.nodes ?? []) pushIso(n.commit?.committedDate);
  // Last issue/PR conversation comment
  for (const n of pr.comments?.nodes ?? []) pushIso(n.createdAt);
  // Last review submission
  for (const n of pr.reviews?.nodes ?? []) pushIso(n.submittedAt);
  for (const n of pr.latestReviews?.nodes ?? []) pushIso(n.submittedAt);

  // Fallback: createdAt (PR has no commits/comments/reviews captured) — better
  // than NaN. Do NOT fall back to updatedAt (the very mutation we want to ignore).
  if (ts.length === 0) pushIso(pr.createdAt);

  return new Date(Math.max(...ts)).toISOString();
}

// ---------------------------------------------------------------------------
// CI outcome
// ---------------------------------------------------------------------------

function ciOutcome(ci?: CiStatus | null): CiOutcome {
  if (!ci || (!ci.status && !ci.conclusion)) return 'no-run';
  if (ci.status === 'in_progress' || ci.status === 'queued') return 'in-flight';
  if (ci.status === 'completed') {
    switch (ci.conclusion) {
      case 'success':
        return 'green';
      case 'failure':
      case 'cancelled':
      case 'timed_out':
      case 'action_required':
        return 'red';
      default:
        return 'other';
    }
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Tier selection (most-specific first)
// ---------------------------------------------------------------------------

function pickTier(pr: RawPR, ci: CiOutcome): Tier {
  if (ci === 'red') return 'failing-CI';
  if (pr.reviewDecision === 'APPROVED' && pr.mergeable === 'MERGEABLE' && (ci === 'green' || ci === 'no-run')) {
    return 'approved';
  }
  if (pr.isDraft) return 'draft';
  return 'ready';
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Ctx {
  now: number;
  // PR head -> PR number, used for stack-PR detection
  headToNumber: Map<string, number>;
  // PR number -> classification, populated in two passes
  classified: Map<number, ClassifiedPR>;
}

function classifyOne(pr: RawPR, ctx: Ctx, ci: CiStatus | undefined): ClassifiedPR {
  const labels = readLabels(pr);
  const isExempt = labels.includes('keep-open') || labels.includes('pinned');
  const lastAt = lastActivity(pr);
  const ageDays = Math.floor((ctx.now - Date.parse(lastAt)) / 86_400_000);
  const outcome = ciOutcome(ci);
  const tier = pickTier(pr, outcome);
  const reasons: string[] = [];

  reasons.push(`age ${ageDays}d in ${tier} tier`);
  if (outcome === 'red') reasons.push(`CI red (run ${ci?.databaseId ?? '?'})`);
  if (outcome === 'green') reasons.push('CI green');
  if (outcome === 'no-run') reasons.push('no CI run yet');
  if (outcome === 'in-flight') reasons.push('CI in-flight');
  if (pr.mergeable === 'CONFLICTING') reasons.push('merge conflict');
  if (pr.mergeStateStatus === 'BEHIND') reasons.push('base branch advanced');
  if (pr.reviewDecision === 'APPROVED') reasons.push('approved');
  if (pr.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes requested');
  if (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === null || pr.reviewDecision === undefined)
    reasons.push('no reviewer feedback');

  const result: ClassifiedPR = {
    number: pr.number,
    title: pr.title,
    author: readAuthor(pr),
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    mergeable: pr.mergeable ?? 'UNKNOWN',
    mergeStateStatus: pr.mergeStateStatus ?? 'UNKNOWN',
    reviewDecision: pr.reviewDecision ?? null,
    labels,
    lastActivityAt: lastAt,
    ageDays,
    ciOutcome: outcome,
    ciDetail: {
      status: ci?.status ?? null,
      conclusion: ci?.conclusion ?? null,
      runId: ci?.databaseId ?? null,
      createdAt: ci?.createdAt ?? null,
    },
    tier,
    category: 'healthy',
    recommendedLabels: [],
    removeLabels: [],
    parent: null,
    reasonHints: reasons,
  };

  if (isExempt) {
    result.category = 'exempt';
    return result;
  }

  // Conflicted (early branch — independent of tier age, but require >3d to
  // avoid spamming on freshly-conflicted PRs while their author is awake).
  if (pr.mergeable === 'CONFLICTING' && ageDays >= 3) {
    result.category = 'conflicted';
  }

  // Behind base (orthogonal — can co-exist with other categories; assigned
  // here only if not yet classified into a stale category. The needs-rebase
  // label is suggested in either case.)
  if (pr.mergeStateStatus === 'BEHIND') {
    result.recommendedLabels.push('needs-rebase');
    if (result.category === 'healthy') result.category = 'behind-base';
  }

  // CI status that isn't yet "red for tier days" still warrants needs-ci-fix
  // once it has been red for ≥3 days.
  if (outcome === 'red' && ageDays >= NEEDS_CI_FIX_AGE_D) {
    result.recommendedLabels.push('needs-ci-fix');
  }

  // Tier-specific rotten/stale classification.
  const t = THRESHOLDS[tier];
  if (tier === 'failing-CI') {
    if (ageDays >= t.rotten) {
      result.category = 'failing-ci-rotten';
      result.recommendedLabels.push('rotten');
    } else if (ageDays >= t.stale) {
      result.category = 'failing-ci-stale';
      result.recommendedLabels.push('stale');
    } else if (result.category === 'healthy') {
      result.category = 'failing-ci-active';
    }
  } else if (tier === 'approved') {
    if (ageDays >= t.rotten) {
      result.category = 'approved-rotten';
      result.recommendedLabels.push('rotten');
    } else if (ageDays >= t.stale) {
      result.category = 'approved-stale';
      result.recommendedLabels.push('stale');
    } else {
      result.category = 'approved-mergeable';
    }
  } else if (tier === 'draft') {
    if (ageDays >= t.rotten) {
      result.category = 'draft-rotten';
      result.recommendedLabels.push('rotten');
    } else if (ageDays >= t.stale) {
      result.category = 'draft-stale';
      result.recommendedLabels.push('stale');
    } else if (result.category === 'healthy') {
      result.category = 'draft-active';
    }
  } else {
    // ready
    const subTier = pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested' : 'awaiting-review';
    if (ageDays >= t.rotten) {
      result.category = `${subTier}-rotten` as Category;
      result.recommendedLabels.push('rotten');
    } else if (ageDays >= t.stale) {
      result.category = `${subTier}-stale` as Category;
      result.recommendedLabels.push('stale');
    } else if (result.category === 'healthy') {
      result.category = `${subTier}-active` as Category;
    }
  }

  // No-CI-yet override: if we have no CI signal AND the PR is older than 3d,
  // flag it specifically rather than letting it slip through as approved-green
  // or healthy. Do NOT auto-label — a PR with no CI run isn't safely classifiable.
  if (outcome === 'no-run' && ageDays > 3 && tier !== 'failing-CI') {
    result.category = 'no-ci-yet';
    result.recommendedLabels = result.recommendedLabels.filter((l) => l !== 'stale' && l !== 'rotten');
  }

  // Idempotency: drop labels already on the PR.
  result.recommendedLabels = result.recommendedLabels.filter((l) => !labels.includes(l));

  // Un-stale: if currently labeled stale/rotten but the PR is no longer in
  // the stale tier, recommend removal. Same for needs-rebase / needs-ci-fix.
  const inStaleCat = result.category.endsWith('-stale') || result.category.endsWith('-rotten');
  if (!inStaleCat) {
    if (labels.includes('stale')) result.removeLabels.push('stale');
    if (labels.includes('rotten')) result.removeLabels.push('rotten');
  }
  if (pr.mergeStateStatus !== 'BEHIND' && labels.includes('needs-rebase')) {
    result.removeLabels.push('needs-rebase');
  }
  if (outcome !== 'red' && labels.includes('needs-ci-fix')) {
    result.removeLabels.push('needs-ci-fix');
  }

  return result;
}

/**
 * Stack-PR escalation, second pass. Per SKILL.md §6:
 *  - parent healthy/active → child suppressed to "stack-dependent" (no labels)
 *  - parent stale/rotten → child surfaces in "stack-stuck" with parent linkage
 *    AND keeps its own labels (parent stuckness must NOT shield children
 *    indefinitely — that's how MVC phase 1-7 chains hide today).
 *  - parent merged/closed → no longer dependent (re-classify as solo, but we
 *    only see open PRs so this branch is effectively unreachable from the
 *    input data; default behavior is fine).
 */
function applyStackEscalation(ctx: Ctx): void {
  for (const pr of ctx.classified.values()) {
    if (pr.baseRefName === 'main' || pr.baseRefName === 'master') continue;
    const parentNum = ctx.headToNumber.get(pr.baseRefName);
    if (parentNum === undefined) continue;
    const parent = ctx.classified.get(parentNum);
    if (!parent) continue;

    const parentRotten = parent.category.endsWith('-rotten');
    const parentStale = parent.category.endsWith('-stale');

    pr.parent = {
      number: parent.number,
      headRefName: parent.headRefName,
      category: parent.category,
    };

    if (parentRotten || parentStale) {
      // Surface as stack-stuck, keep child labels.
      const original = pr.category;
      pr.category = 'stack-stuck';
      pr.reasonHints.push(`parent #${parent.number} is ${parentRotten ? 'rotten' : 'stale'}; was ${original}`);
    } else if (parent.category !== 'exempt') {
      // Parent healthy/active — suppress child stale labeling.
      pr.category = 'stack-dependent';
      pr.recommendedLabels = pr.recommendedLabels.filter((l) => l !== 'stale' && l !== 'rotten');
      // Note: needs-rebase / needs-ci-fix are still valid for stack children.
      pr.reasonHints.push(`stack-dep on healthy parent #${parent.number}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rawPRs = normalizePRs(readJson<unknown>(args.prsPath));
  const ciByNum: Record<string, CiStatus> = args.ciPath ? readJson<Record<string, CiStatus>>(args.ciPath) : {};

  const warnings: string[] = [];
  if (rawPRs.length >= 200) {
    warnings.push(
      `Processed first ${rawPRs.length} open PRs; if the repo exceeds 200 the input may be truncated. Tighten exemption policy.`,
    );
  }

  const headToNumber = new Map<string, number>();
  for (const pr of rawPRs) headToNumber.set(pr.headRefName, pr.number);

  const ctx: Ctx = {
    now: args.now,
    headToNumber,
    classified: new Map(),
  };

  for (const pr of rawPRs) {
    const ci = ciByNum[String(pr.number)];
    const classified = classifyOne(pr, ctx, ci);
    ctx.classified.set(pr.number, classified);
  }

  applyStackEscalation(ctx);

  const prs = Array.from(ctx.classified.values()).sort((a, b) => b.ageDays - a.ageDays);

  const byCategory: Record<string, number> = {};
  for (const p of prs) byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;

  const out: ClassifyOutput = {
    generatedAt: new Date(args.now).toISOString(),
    repo: '2lab-ai/soma-work',
    totalOpen: prs.length,
    warnings,
    byCategory,
    prs,
  };

  process.stdout.write(JSON.stringify(out, null, 2));
  process.stdout.write('\n');
}

main();

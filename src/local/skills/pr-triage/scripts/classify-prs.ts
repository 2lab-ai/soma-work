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
 *   # 1. Fetch PR list (gh ≥ 2.40 for --slurp; pipe through `jq -s` on older gh).
 *   #    Do NOT pass -F endCursor=null — gh seeds the cursor itself when
 *   #    --paginate sees $endCursor + pageInfo.endCursor in the response.
 *   gh api graphql --paginate --slurp -f query='...' > prs.json
 *
 *   # 2. Fan out CI lookups per PR (capped at 8 in parallel) into per-file JSON.
 *   for n in <pr-numbers>; do
 *     gh run list --branch "<head>" --limit 1 \
 *       --json status,conclusion,databaseId,createdAt -q '.[0] // {}' > ci-$n.json &
 *   done; wait
 *
 *   # 3. Fold per-PR files into one map keyed by PR-number string.
 *   jq -n 'reduce inputs as $r ({};
 *     . + ({(input_filename | capture("ci-(?<n>[0-9]+)\\.json").n): $r}))' \
 *     ci-*.json > ci-by-num.json
 *
 *   # 4. Classify.
 *   npx tsx local/skills/pr-triage/scripts/classify-prs.ts \
 *     --prs prs.json [--ci ci-by-num.json] [--now 2026-05-08T06:00:00Z]
 *
 *   Output is JSON written to stdout.
 *   The full pipeline lives in src/local/skills/pr-triage/SKILL.md §3-§5.
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
  // GraphQL returns the actor as User | Bot | Mannequin | EnterpriseUserAccount
  // | Organization. We capture __typename so we can distinguish bot authors
  // (~80% of PRs in soma-work are app/zhuge-liang-bot) from humans — bots
  // can't be pinged via /cc and won't reopen closed PRs, so the recommended
  // action track is different.
  author?: { __typename?: string; login?: string } | { __typename?: string; login: string } | null;
  createdAt: IsoString;
  // Deliberately NOT modeling pr.updatedAt: it mutates on label/milestone/
  // reviewer changes, which would let this skill self-reset its own stale
  // clock the moment it labels a PR. lastActivity() pulls from commits,
  // comments, and reviews instead.
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

type AuthorType = 'user' | 'bot' | 'ghost' | 'unknown';

interface ClassifiedPR {
  number: number;
  title: string;
  author: string;
  /** From GraphQL __typename: User / Bot / null author. Drives recommendation track. */
  authorType: AuthorType;
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

const MS_PER_DAY = 86_400_000;

const THRESHOLDS = {
  draft: { stale: 7, rotten: 14 },
  ready: { stale: 14, rotten: 30 },
  approved: { stale: 5, rotten: 10 },
  'failing-CI': { stale: 7, rotten: 14 },
} as const;

const NEEDS_CI_FIX_AGE_D = 3;

/**
 * Tier → (rotten | stale | active) → Category.
 * Replaces template-literal `as Category` casts: lookups are type-checked end-to-end.
 * `ready` tier resolves via READY_MAP because reviewDecision splits it into two sub-tiers.
 */
const TIER_CATS = {
  'failing-CI': { rotten: 'failing-ci-rotten', stale: 'failing-ci-stale', active: 'failing-ci-active' },
  approved: { rotten: 'approved-rotten', stale: 'approved-stale', active: 'approved-mergeable' },
  draft: { rotten: 'draft-rotten', stale: 'draft-stale', active: 'draft-active' },
} as const satisfies Record<Exclude<Tier, 'ready'>, Record<'rotten' | 'stale' | 'active', Category>>;

const READY_MAP = {
  'awaiting-review': {
    rotten: 'awaiting-review-rotten',
    stale: 'awaiting-review-stale',
    active: 'awaiting-review-active',
  },
  'changes-requested': {
    rotten: 'changes-requested-rotten',
    stale: 'changes-requested-stale',
    active: 'changes-requested-active',
  },
} as const satisfies Record<string, Record<'rotten' | 'stale' | 'active', Category>>;

/**
 * Per-category display label (used in row entries / debug output).
 * Distinct from REPORT_SECTIONS below: many categories collapse into one
 * report section (e.g. all three failing-ci-* go to "Failing CI").
 */
export const CATEGORY_LABELS: Record<Category, string> = {
  'approved-mergeable': 'Approved & Mergeable',
  'approved-stale': 'Approved Stale',
  'approved-rotten': 'Approved Rotten',
  'awaiting-review-active': 'Awaiting Review',
  'awaiting-review-stale': 'Awaiting Review Stale',
  'awaiting-review-rotten': 'Awaiting Review Rotten',
  'changes-requested-active': 'Changes Requested',
  'changes-requested-stale': 'Changes Requested Stale',
  'changes-requested-rotten': 'Changes Requested Rotten',
  'draft-active': 'Draft',
  'draft-stale': 'Draft Stale',
  'draft-rotten': 'Draft Rotten',
  'failing-ci-active': 'Failing CI',
  'failing-ci-stale': 'Failing CI Stale',
  'failing-ci-rotten': 'Failing CI Rotten',
  'behind-base': 'Behind base',
  conflicted: 'Conflicted',
  'no-ci-yet': 'No CI yet',
  'stack-dependent': 'Stack Dependent',
  'stack-stuck': 'Stack-Stuck',
  exempt: 'Exempt',
  healthy: 'Healthy',
};

/**
 * SKILL.md §8 report sections, with their exact emoji-prefixed headers
 * and the categories that roll up into each. The LLM rendering the report
 * MUST use this mapping verbatim — otherwise two invocations produce
 * differently-headed reports. Keep in sync with SKILL.md §"Emit report".
 */
export const REPORT_SECTIONS: Array<{ heading: string; categories: Category[] }> = [
  {
    heading: '🔴 Rotten — close 추천',
    categories: [
      'approved-rotten',
      'awaiting-review-rotten',
      'changes-requested-rotten',
      'draft-rotten',
      'failing-ci-rotten',
    ],
  },
  {
    heading: '🟡 Stale',
    categories: [
      'approved-stale',
      'awaiting-review-stale',
      'changes-requested-stale',
      'draft-stale',
      'failing-ci-stale',
    ],
  },
  { heading: '🚧 Failing CI', categories: ['failing-ci-active'] },
  { heading: '🔧 Behind base', categories: ['behind-base'] },
  { heading: '⛔ Conflicted', categories: ['conflicted'] },
  { heading: '⏳ Awaiting Review', categories: ['awaiting-review-active', 'changes-requested-active'] },
  { heading: '✅ Approved & Mergeable', categories: ['approved-mergeable'] },
  { heading: '📦 Stack Dependent', categories: ['stack-dependent'] },
  { heading: '⚠️ Stack-Stuck', categories: ['stack-stuck'] },
  { heading: '❓ No CI yet', categories: ['no-ci-yet'] },
  { heading: '🛡 Exempt', categories: ['exempt'] },
];

/**
 * Categories whose report rows have a meaningful "Reason" cell. For all other
 * categories (healthy, plain *-active, exempt) the reasonHints array is dropped
 * before serialization to avoid bloating LLM input with text the report won't
 * render anyway. (~30KB saved on a 200-PR repo.)
 */
const REASON_BEARING: ReadonlySet<Category> = new Set<Category>([
  'approved-stale',
  'approved-rotten',
  'awaiting-review-stale',
  'awaiting-review-rotten',
  // changes-requested-active is actionable too: someone needs to address feedback.
  'changes-requested-active',
  'changes-requested-stale',
  'changes-requested-rotten',
  'draft-stale',
  'draft-rotten',
  // failing-ci-active is actionable: red CI even if young — surface the run id.
  'failing-ci-active',
  'failing-ci-stale',
  'failing-ci-rotten',
  'behind-base',
  'conflicted',
  'no-ci-yet',
  'stack-stuck',
]);

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

function readAuthor(pr: RawPR): { login: string; type: AuthorType } {
  const a = pr.author;
  if (!a) return { login: 'ghost', type: 'ghost' };
  if (typeof a === 'object' && 'login' in a && typeof a.login === 'string') {
    const login = a.login;
    const t = a.__typename;
    let type: AuthorType = 'unknown';
    if (t === 'Bot') type = 'bot';
    else if (t === 'User') type = 'user';
    else if (t === 'Mannequin' || t === 'EnterpriseUserAccount' || t === 'Organization') type = 'user';
    else if (login.startsWith('app/') || login.endsWith('[bot]') || login.endsWith('-bot')) {
      // Fallback for inputs without __typename (e.g. `gh pr list --json author`
      // returns `app/<name>` for App actors). Heuristic, not authoritative.
      type = 'bot';
    } else {
      type = 'user';
    }
    return { login, type };
  }
  return { login: 'unknown', type: 'unknown' };
}

// ---------------------------------------------------------------------------
// Activity timestamp (NOT pr.updatedAt)
// ---------------------------------------------------------------------------

function lastActivity(pr: RawPR): { iso: IsoString; ms: number } {
  const ts: number[] = [];

  const pushIso = (s?: IsoString | null): void => {
    if (!s) return;
    const n = Date.parse(s);
    if (!Number.isNaN(n)) ts.push(n);
  };

  for (const n of pr.commits?.nodes ?? []) pushIso(n.commit?.committedDate);
  for (const n of pr.comments?.nodes ?? []) pushIso(n.createdAt);
  for (const n of pr.reviews?.nodes ?? []) pushIso(n.submittedAt);
  for (const n of pr.latestReviews?.nodes ?? []) pushIso(n.submittedAt);

  // Fallback: createdAt (PR has no commits/comments/reviews captured) — better
  // than NaN. Do NOT fall back to updatedAt (the very mutation we want to ignore).
  if (ts.length === 0) pushIso(pr.createdAt);

  if (ts.length === 0) {
    // Pathological: no parseable timestamps at all (corrupted input). Use
    // epoch=0 so ageDays goes very high — surfaces the broken PR in the
    // report without crashing. main() collects a warning for these.
    return { iso: new Date(0).toISOString(), ms: 0 };
  }

  const ms = Math.max(...ts);
  return { iso: new Date(ms).toISOString(), ms };
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
  // GitHub returns mergeable=UNKNOWN for ~5–30s after a push while the merge
  // engine recomputes — completely normal for a freshly-approved PR. Treating
  // UNKNOWN as approved is risky (an unseen conflict could be hiding); falling
  // through to ready/draft applies the wrong (looser) thresholds. Compromise:
  // an APPROVED+UNKNOWN PR is treated as `approved` for tier selection so it
  // gets the tighter thresholds, but the caller stamps it with a
  // `pending-mergeability` reasonHint and skips destructive label suggestions.
  // The CONFLICTING case never reaches `approved` — it'll be caught by the
  // single-condition "conflicted" override.
  if (
    pr.reviewDecision === 'APPROVED' &&
    (pr.mergeable === 'MERGEABLE' || pr.mergeable === 'UNKNOWN' || pr.mergeable === undefined) &&
    (ci === 'green' || ci === 'no-run')
  ) {
    return 'approved';
  }
  if (pr.isDraft) return 'draft';
  return 'ready';
}

/**
 * A freshly-approved PR may have mergeable=UNKNOWN for tens of seconds; be
 * conservative and skip stale/rotten labels for that transient. BUT: if the
 * UNKNOWN persists past UNKNOWN_AGING_GRACE_D days, GitHub has effectively
 * given up computing — base ref permission denied, repo migration cruft, or
 * force-pushed base. In that case treat it as a real signal and let the
 * normal classification proceed without label protection.
 */
const UNKNOWN_AGING_GRACE_D = 7;
function isPendingMergeability(pr: RawPR, ageDays: number): boolean {
  return (
    pr.reviewDecision === 'APPROVED' &&
    (pr.mergeable === 'UNKNOWN' || pr.mergeable === undefined) &&
    ageDays < UNKNOWN_AGING_GRACE_D
  );
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Tier age vs thresholds → which sub-bucket. Pure, single source. */
function pickAgeBucket(tier: Tier, ageDays: number): 'rotten' | 'stale' | 'active' {
  const t = THRESHOLDS[tier];
  if (ageDays >= t.rotten) return 'rotten';
  if (ageDays >= t.stale) return 'stale';
  return 'active';
}

function pickTierCategory(pr: RawPR, tier: Tier, bucket: 'rotten' | 'stale' | 'active'): Category {
  if (tier === 'ready') {
    const sub = pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested' : 'awaiting-review';
    return READY_MAP[sub][bucket];
  }
  return TIER_CATS[tier][bucket];
}

function classifyOne(pr: RawPR, now: number, ci: CiStatus | undefined): ClassifiedPR {
  const labels = readLabels(pr);
  const isExempt = labels.includes('keep-open') || labels.includes('pinned');
  const lastAt = lastActivity(pr);
  const ageDays = Math.floor((now - lastAt.ms) / MS_PER_DAY);
  const outcome = ciOutcome(ci);
  const tier = pickTier(pr, outcome);

  const reasons: string[] = [`age ${ageDays}d in ${tier} tier`];
  if (outcome === 'red') reasons.push(`CI red (run ${ci?.databaseId ?? '?'})`);
  else if (outcome === 'green') reasons.push('CI green');
  else if (outcome === 'no-run') reasons.push('no CI run yet');
  else if (outcome === 'in-flight') reasons.push('CI in-flight');
  if (pr.mergeable === 'CONFLICTING') reasons.push('merge conflict');
  if (pr.mergeStateStatus === 'BEHIND') reasons.push('base branch advanced');
  if (pr.reviewDecision === 'APPROVED') reasons.push('approved');
  else if (pr.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes requested');
  else reasons.push('no reviewer feedback');

  const authorInfo = readAuthor(pr);
  if (authorInfo.type === 'bot') {
    reasons.push(`bot-author (${authorInfo.login}) — pings won't work; close-or-revive`);
  } else if (authorInfo.type === 'ghost') {
    reasons.push('author account deleted — ping impossible; close-or-reassign');
  }

  const result: ClassifiedPR = {
    number: pr.number,
    title: pr.title,
    author: authorInfo.login,
    authorType: authorInfo.type,
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    mergeable: pr.mergeable ?? 'UNKNOWN',
    mergeStateStatus: pr.mergeStateStatus ?? 'UNKNOWN',
    reviewDecision: pr.reviewDecision ?? null,
    labels,
    lastActivityAt: lastAt.iso,
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

  // 1. Tier-specific bucket (rotten / stale / active).
  const bucket = pickAgeBucket(tier, ageDays);
  result.category = pickTierCategory(pr, tier, bucket);
  if (bucket === 'rotten') result.recommendedLabels.push('rotten');
  else if (bucket === 'stale') result.recommendedLabels.push('stale');

  // 2. Override with single-condition categories that take precedence over the
  //    tier classification *only when the tier put the PR in `active`* (the
  //    "no escalation needed" bucket). A stale or rotten PR keeps its tier
  //    category — it's more informative than `behind-base` alone.
  if (bucket === 'active') {
    if (pr.mergeable === 'CONFLICTING' && ageDays >= 3) {
      result.category = 'conflicted';
    } else if (pr.mergeStateStatus === 'BEHIND') {
      result.category = 'behind-base';
    }
  }

  // 3. Orthogonal labels (independent of category): always recommend
  //    needs-rebase for BEHIND, needs-ci-fix for ≥3d red CI.
  if (pr.mergeStateStatus === 'BEHIND') {
    result.recommendedLabels.push('needs-rebase');
  }
  if (outcome === 'red' && ageDays >= NEEDS_CI_FIX_AGE_D) {
    result.recommendedLabels.push('needs-ci-fix');
  }

  // 4. No-CI-yet override: brand-new PRs / disabled workflows give an empty
  //    `gh run list` array. We can't safely classify these as approved-green
  //    or failing — surface them in their own bucket and DO NOT auto-label
  //    stale/rotten (a PR with no CI run is not safely classifiable).
  if (outcome === 'no-run' && ageDays > 3 && tier !== 'failing-CI') {
    result.category = 'no-ci-yet';
    result.recommendedLabels = result.recommendedLabels.filter((l) => l !== 'stale' && l !== 'rotten');
  }

  // 4b. Pending-mergeability override: APPROVED PR with mergeable=UNKNOWN
  //     usually means the merge engine is still computing (post-push transient).
  //     Strip stale/rotten label suggestions during the grace window — at
  //     UNKNOWN_AGING_GRACE_D days, persistent UNKNOWN is a real signal
  //     (base ref permission denied, etc.), and labels apply normally.
  if (isPendingMergeability(pr, ageDays)) {
    result.recommendedLabels = result.recommendedLabels.filter((l) => l !== 'stale' && l !== 'rotten');
    result.reasonHints.push('mergeable=UNKNOWN — merge engine still computing; re-evaluate next run');
  } else if (
    pr.reviewDecision === 'APPROVED' &&
    (pr.mergeable === 'UNKNOWN' || pr.mergeable === undefined) &&
    ageDays >= UNKNOWN_AGING_GRACE_D
  ) {
    // Persistent UNKNOWN — note in the reason hints so the operator knows
    // why this PR is showing up despite mergeable=UNKNOWN.
    result.reasonHints.push(`mergeable=UNKNOWN persisted >${UNKNOWN_AGING_GRACE_D}d — labels applied`);
  }

  // 5. Idempotency: drop labels already on the PR.
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

  // Strip non-actionable reasonHints in-place so the contract is consistent
  // whether classifyOne is consumed via the CLI (main()) or imported. See
  // REASON_BEARING for the allowlist.
  if (!REASON_BEARING.has(result.category)) {
    result.reasonHints = [];
  }

  return result;
}

/** True when the parent is itself stuck (stale, rotten, or already flipped to stack-stuck). */
function isStuckParent(category: Category): boolean {
  return category === 'stack-stuck' || category.endsWith('-rotten') || category.endsWith('-stale');
}

/**
 * Stack-PR escalation, second pass. Per SKILL.md §6:
 *  - parent healthy/active → child suppressed to "stack-dependent" (no labels)
 *  - parent stale/rotten/stack-stuck → child surfaces in "stack-stuck" with parent linkage
 *    AND keeps its own labels (parent stuckness must NOT shield children
 *    indefinitely — that's how MVC phase 1-7 chains hide today).
 *  - parent merged/closed → no longer dependent (re-classify as solo, but we
 *    only see open PRs so this branch is effectively unreachable from the
 *    input data; default behavior is fine).
 *
 * Processes parents before children via topological order on the
 * baseRefName→headRefName edges, so a grandchild C of a stack-stuck B (whose
 * parent A is stale) inherits the stuckness in one pass. Without parent-first
 * ordering, C would read B before B is flipped to stack-stuck and silently
 * fall to stack-dependent — exactly the failure mode this function exists to
 * prevent. Cycles (which GitHub doesn't allow but we defend anyway) terminate
 * after one fixed-point retry.
 */
function applyStackEscalation(classified: Map<number, ClassifiedPR>, headToNumber: Map<string, number>): void {
  // Build parent number → list of immediate child numbers.
  const childrenOf = new Map<number, number[]>();
  const rootless: number[] = [];
  for (const pr of classified.values()) {
    if (pr.baseRefName === 'main' || pr.baseRefName === 'master') {
      rootless.push(pr.number);
      continue;
    }
    const parentNum = headToNumber.get(pr.baseRefName);
    if (parentNum === undefined || !classified.has(parentNum)) {
      // Base is some other branch we don't see as a PR (e.g. release/* gone) —
      // treat as rootless for stack purposes.
      rootless.push(pr.number);
      continue;
    }
    const arr = childrenOf.get(parentNum);
    if (arr) arr.push(pr.number);
    else childrenOf.set(parentNum, [pr.number]);
  }

  // BFS from rootless PRs so each parent is processed before its children.
  // Visited guards against accidental cycles in malformed input.
  const visited = new Set<number>();
  const queue: number[] = [...rootless];
  while (queue.length > 0) {
    const num = queue.shift();
    if (num === undefined || visited.has(num)) continue;
    visited.add(num);

    const pr = classified.get(num);
    if (!pr) continue;

    // For non-root PRs, look at parent (already processed).
    if (pr.baseRefName !== 'main' && pr.baseRefName !== 'master') {
      const parentNum = headToNumber.get(pr.baseRefName);
      const parent = parentNum !== undefined ? classified.get(parentNum) : undefined;
      if (parent) {
        pr.parent = { number: parent.number, headRefName: parent.headRefName, category: parent.category };

        if (isStuckParent(parent.category)) {
          // Surface as stack-stuck, keep child labels.
          const original = pr.category;
          pr.category = 'stack-stuck';
          const why =
            parent.category === 'stack-stuck'
              ? `parent #${parent.number} is itself stack-stuck`
              : parent.category.endsWith('-rotten')
                ? `parent #${parent.number} is rotten`
                : `parent #${parent.number} is stale`;
          pr.reasonHints.push(`${why}; was ${original}`);
        } else if (parent.category !== 'exempt') {
          // Parent healthy/active — suppress child stale labeling.
          pr.category = 'stack-dependent';
          pr.recommendedLabels = pr.recommendedLabels.filter((l) => l !== 'stale' && l !== 'rotten');
          // stack-dependent is non-REASON_BEARING — drop pre-strip hints so we
          // don't bloat the JSON with reasons the report won't render.
          // needs-rebase / needs-ci-fix labels remain valid for stack children.
          pr.reasonHints = [];
        }
      }
    }

    // Enqueue children for parent-first ordering.
    const kids = childrenOf.get(num);
    if (kids) queue.push(...kids);
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

  // Build head→PR map; warn (do NOT silently last-write-wins) on duplicates.
  // GitHub allows the same head to back multiple open PRs targeting different
  // bases (cherry-pick PRs, cross-fork PRs). When that happens, stack-PR
  // detection becomes ambiguous, so we drop those entries from the map and
  // warn — children of an ambiguous head simply won't be detected as
  // stack-dependent (safer than picking the wrong parent).
  const headToNumber = new Map<string, number>();
  const ambiguousHeads = new Set<string>();
  for (const pr of rawPRs) {
    if (headToNumber.has(pr.headRefName)) {
      ambiguousHeads.add(pr.headRefName);
    } else {
      headToNumber.set(pr.headRefName, pr.number);
    }
  }
  for (const head of ambiguousHeads) {
    headToNumber.delete(head);
    warnings.push(`Head ref "${head}" backs multiple open PRs; stack detection skipped for that ref.`);
  }
  // Track PRs that had no parsable timestamps so the report can surface them.
  for (const pr of rawPRs) {
    const hasAny =
      (pr.commits?.nodes?.length ?? 0) +
        (pr.comments?.nodes?.length ?? 0) +
        (pr.reviews?.nodes?.length ?? 0) +
        (pr.latestReviews?.nodes?.length ?? 0) >
      0;
    if (!hasAny && !pr.createdAt) {
      warnings.push(`PR #${pr.number} has no parsable activity timestamp; classified at age ∞.`);
    }
  }

  const classified = new Map<number, ClassifiedPR>();
  for (const pr of rawPRs) {
    const ci = ciByNum[String(pr.number)];
    classified.set(pr.number, classifyOne(pr, args.now, ci));
  }

  applyStackEscalation(classified, headToNumber);
  // Note: classifyOne already strips reasonHints for non-REASON_BEARING
  // categories. applyStackEscalation explicitly clears reasonHints when
  // flipping to stack-dependent (also non-REASON_BEARING). stack-stuck is
  // REASON_BEARING and gets a "was X" hint pushed during escalation.

  const prs = Array.from(classified.values()).sort((a, b) => b.ageDays - a.ageDays);

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

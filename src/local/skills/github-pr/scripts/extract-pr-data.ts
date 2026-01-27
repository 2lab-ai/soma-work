#!/usr/bin/env npx tsx
/**
 * Extract PR Data Script
 *
 * Processes GitHub MCP result files and extracts only necessary fields
 * to reduce token usage when feeding PR data to AI models.
 *
 * Supports two input formats:
 * - MCP wrapped: [{type: "text", text: "<JSON string>"}]
 * - Plain JSON: Direct GitHub API response
 *
 * Data types supported:
 * - PR info (get_pull_request)
 * - Comments (get_pull_request_comments)
 * - Reviews (get_pull_request_reviews)
 * - Files (get_pull_request_files)
 *
 * Usage (from skill directory or with full path):
 *   npx tsx extract-pr-data.ts <type> <input_file> [output_file]
 *   npx tsx extract-pr-data.ts comments ./data/pr-comments.json
 *   npx tsx extract-pr-data.ts files ./data/pr-files.json ./data/pr-files-compact.json
 *   cat mcp-result.json | npx tsx extract-pr-data.ts comments -
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Type Definitions - Input (from GitHub MCP)
// ============================================================================

interface McpTextResult {
  type: 'text';
  text: string;
}

interface GitHubUser {
  login: string;
  id: number;
  node_id?: string;
  avatar_url?: string;
  gravatar_id?: string;
  url?: string;
  html_url?: string;
  followers_url?: string;
  following_url?: string;
  gists_url?: string;
  starred_url?: string;
  subscriptions_url?: string;
  organizations_url?: string;
  repos_url?: string;
  events_url?: string;
  received_events_url?: string;
  type?: string;
  site_admin?: boolean;
}

interface GitHubPRComment {
  url: string;
  id: number;
  node_id: string;
  pull_request_review_id: number;
  diff_hunk: string;
  path: string;
  position: number | null;
  original_position: number | null;
  commit_id: string;
  original_commit_id: string;
  in_reply_to_id?: number;
  user: GitHubUser;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request_url: string;
  author_association: string;
  _links: Record<string, unknown>;
  line?: number;
  original_line?: number;
  start_line?: number;
  original_start_line?: number;
  start_side?: string;
  side?: string;
  subject_type?: string;
}

interface GitHubPRReview {
  id: number;
  node_id: string;
  user: GitHubUser;
  body: string | null;
  state: string;
  html_url: string;
  pull_request_url: string;
  author_association: string;
  submitted_at: string;
  commit_id: string;
  _links: Record<string, unknown>;
}

interface GitHubPRFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch?: string;
  previous_filename?: string;
}

interface GitHubPR {
  url: string;
  id: number;
  node_id: string;
  html_url: string;
  diff_url: string;
  patch_url: string;
  issue_url: string;
  number: number;
  state: string;
  locked: boolean;
  title: string;
  user: GitHubUser;
  body: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  assignee: GitHubUser | null;
  assignees: GitHubUser[];
  requested_reviewers: GitHubUser[];
  requested_teams: unknown[];
  labels: Array<{ id: number; name: string; color: string }>;
  milestone: unknown | null;
  draft: boolean;
  commits_url: string;
  review_comments_url: string;
  review_comment_url: string;
  comments_url: string;
  statuses_url: string;
  head: {
    label: string;
    ref: string;
    sha: string;
    user: GitHubUser;
    repo: { full_name: string; clone_url: string };
  };
  base: {
    label: string;
    ref: string;
    sha: string;
    user: GitHubUser;
    repo: { full_name: string; clone_url: string };
  };
  _links: Record<string, unknown>;
  author_association: string;
  auto_merge: unknown | null;
  active_lock_reason: string | null;
  merged: boolean;
  mergeable: boolean | null;
  rebaseable: boolean | null;
  mergeable_state: string;
  merged_by: GitHubUser | null;
  comments: number;
  review_comments: number;
  maintainer_can_modify: boolean;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
}

// ============================================================================
// Type Definitions - Output (Compact)
// ============================================================================

interface CompactComment {
  id: number;
  node_id: string;
  path: string;
  line?: number | null;
  body: string;
  user: string;
  created_at: string;
  html_url: string;
  in_reply_to_id?: number;
  review_id?: number;
}

interface CompactReview {
  id: number;
  user: string;
  state: string;
  body: string | null;
  submitted_at: string;
}

interface CompactFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface CompactPR {
  number: number;
  title: string;
  state: string;
  user: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  draft: boolean;
  merged: boolean;
  base_branch: string;
  head_branch: string;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  labels: string[];
}

// ============================================================================
// Validation Functions
// ============================================================================

function validateUser(user: unknown, context: string): asserts user is GitHubUser {
  if (!user || typeof user !== 'object') {
    throw new Error(`${context}: user field is missing or not an object`);
  }
  const u = user as Record<string, unknown>;
  if (typeof u.login !== 'string') {
    throw new Error(`${context}: user.login is missing or not a string`);
  }
}

function validateComment(comment: unknown, index: number): asserts comment is GitHubPRComment {
  if (!comment || typeof comment !== 'object') {
    throw new Error(`Comment[${index}]: not an object`);
  }
  const c = comment as Record<string, unknown>;
  if (typeof c.id !== 'number') {
    throw new Error(`Comment[${index}]: id is missing or not a number`);
  }
  if (typeof c.node_id !== 'string') {
    throw new Error(`Comment[${index}]: node_id is missing or not a string`);
  }
  if (typeof c.path !== 'string') {
    throw new Error(`Comment[${index}]: path is missing or not a string`);
  }
  validateUser(c.user, `Comment[${index}]`);
}

function validateReview(review: unknown, index: number): asserts review is GitHubPRReview {
  if (!review || typeof review !== 'object') {
    throw new Error(`Review[${index}]: not an object`);
  }
  const r = review as Record<string, unknown>;
  if (typeof r.id !== 'number') {
    throw new Error(`Review[${index}]: id is missing or not a number`);
  }
  if (typeof r.state !== 'string') {
    throw new Error(`Review[${index}]: state is missing or not a string`);
  }
  validateUser(r.user, `Review[${index}]`);
}

function validateFile(file: unknown, index: number): asserts file is GitHubPRFile {
  if (!file || typeof file !== 'object') {
    throw new Error(`File[${index}]: not an object`);
  }
  const f = file as Record<string, unknown>;
  if (typeof f.filename !== 'string') {
    throw new Error(`File[${index}]: filename is missing or not a string`);
  }
  if (typeof f.status !== 'string') {
    throw new Error(`File[${index}]: status is missing or not a string`);
  }
}

function validatePR(pr: unknown): asserts pr is GitHubPR {
  if (!pr || typeof pr !== 'object') {
    throw new Error('PR data is not an object');
  }
  const p = pr as Record<string, unknown>;
  if (typeof p.number !== 'number') {
    throw new Error('PR: number field is missing or not a number');
  }
  if (typeof p.title !== 'string') {
    throw new Error(`PR #${p.number}: title is missing or not a string`);
  }
  validateUser(p.user, `PR #${p.number}`);
  if (!p.base || typeof p.base !== 'object') {
    throw new Error(`PR #${p.number}: base is missing or not an object`);
  }
  if (typeof (p.base as Record<string, unknown>).ref !== 'string') {
    throw new Error(`PR #${p.number}: base.ref is missing or not a string`);
  }
  if (!p.head || typeof p.head !== 'object') {
    throw new Error(`PR #${p.number}: head is missing or not an object`);
  }
  if (typeof (p.head as Record<string, unknown>).ref !== 'string') {
    throw new Error(`PR #${p.number}: head.ref is missing or not a string`);
  }
  if (!Array.isArray(p.labels)) {
    throw new Error(`PR #${p.number}: labels is missing or not an array`);
  }
}

// ============================================================================
// Extraction Functions
// ============================================================================

function extractComment(comment: GitHubPRComment): CompactComment {
  return {
    id: comment.id,
    node_id: comment.node_id,
    path: comment.path,
    line: comment.line ?? comment.original_line ?? comment.position,
    body: comment.body,
    user: comment.user.login,
    created_at: comment.created_at,
    html_url: comment.html_url,
    ...(comment.in_reply_to_id !== undefined && { in_reply_to_id: comment.in_reply_to_id }),
    ...(comment.pull_request_review_id !== undefined && { review_id: comment.pull_request_review_id }),
  };
}

function extractReview(review: GitHubPRReview): CompactReview {
  return {
    id: review.id,
    user: review.user.login,
    state: review.state,
    body: review.body,
    submitted_at: review.submitted_at,
  };
}

function extractFile(file: GitHubPRFile): CompactFile {
  return {
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  };
}

function extractPR(pr: GitHubPR): CompactPR {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    user: pr.user.login,
    body: pr.body,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    draft: pr.draft,
    merged: pr.merged,
    base_branch: pr.base.ref,
    head_branch: pr.head.ref,
    commits: pr.commits,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    labels: pr.labels.map((l) => l.name),
  };
}

// ============================================================================
// MCP Result Parsing
// ============================================================================

/**
 * Parse MCP result format
 *
 * Handles two input formats:
 * - MCP wrapped: [{type: "text", text: "<JSON string>"}]
 * - Plain JSON: Direct GitHub API response
 *
 * Auto-detects format and parses accordingly.
 */
function parseMcpResult<T>(content: string): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const preview = content.substring(0, 100);
    throw new Error(
      `Failed to parse input JSON: ${error instanceof Error ? error.message : String(error)}\n` +
        `Content preview: ${preview}${content.length > 100 ? '...' : ''}`
    );
  }

  // Check if it's MCP format (array with text objects)
  if (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    typeof parsed[0] === 'object' &&
    parsed[0] !== null &&
    'type' in parsed[0] &&
    parsed[0].type === 'text'
  ) {
    const mcpResult = parsed as McpTextResult[];
    const textContent = mcpResult
      .filter((r) => typeof r.text === 'string')
      .map((r) => r.text)
      .join('');

    if (!textContent) {
      throw new Error('MCP result contains no text content');
    }

    try {
      return JSON.parse(textContent) as T;
    } catch (error) {
      const preview = textContent.substring(0, 100);
      throw new Error(
        `Failed to parse MCP inner JSON: ${error instanceof Error ? error.message : String(error)}\n` +
          `Content preview: ${preview}${textContent.length > 100 ? '...' : ''}`
      );
    }
  }

  // Already plain JSON
  return parsed as T;
}

// ============================================================================
// Main Processing
// ============================================================================

const VALID_TYPES = ['pr', 'comments', 'reviews', 'files'] as const;
type DataType = (typeof VALID_TYPES)[number];

function processData(type: DataType, content: string): unknown {
  switch (type) {
    case 'pr': {
      const pr = parseMcpResult<unknown>(content);
      validatePR(pr);
      return extractPR(pr);
    }
    case 'comments': {
      const comments = parseMcpResult<unknown[]>(content);
      if (!Array.isArray(comments)) {
        throw new Error('Comments data is not an array');
      }
      comments.forEach((c, i) => validateComment(c, i));
      return (comments as GitHubPRComment[]).map(extractComment);
    }
    case 'reviews': {
      const reviews = parseMcpResult<unknown[]>(content);
      if (!Array.isArray(reviews)) {
        throw new Error('Reviews data is not an array');
      }
      reviews.forEach((r, i) => validateReview(r, i));
      return (reviews as GitHubPRReview[]).map(extractReview);
    }
    case 'files': {
      const files = parseMcpResult<unknown[]>(content);
      if (!Array.isArray(files)) {
        throw new Error('Files data is not an array');
      }
      files.forEach((f, i) => validateFile(f, i));
      return (files as GitHubPRFile[]).map(extractFile);
    }
    default:
      throw new Error(`Unknown data type: ${type}`);
  }
}

function printUsage(): void {
  console.log(`
Extract PR Data - Reduce GitHub MCP result tokens

Usage:
  npx tsx extract-pr-data.ts <type> <input> [output]

Types:
  pr        - Pull request info
  comments  - PR review comments
  reviews   - PR reviews
  files     - Changed files

Arguments:
  input     - Input file path or '-' for stdin
  output    - Output file path (optional, defaults to stdout)

Examples:
  npx tsx extract-pr-data.ts comments ./data/pr-comments.json
  npx tsx extract-pr-data.ts files ./data/pr-files.json ./compact-files.json
  cat mcp-result.json | npx tsx extract-pr-data.ts comments -

Token Savings:
  Actual savings are calculated dynamically and reported for each run.
  Typical reductions vary based on PR size and content:
  - Removes: diff_hunk, patch content, most URLs, nested objects
  - Keeps: essential IDs, content, timestamps, line numbers
`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch (error) {
    throw new Error(`Failed to read from stdin: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  // Quick check to verify script path is correct
  if (args[0] === '--check') {
    console.log('OK: extract-pr-data.ts is reachable');
    console.log(`Path: ${process.argv[1]}`);
    process.exit(0);
  }

  if (args.length < 2) {
    printUsage();
    process.exit(1);
  }

  const typeArg = args[0];
  const inputPath = args[1];
  const outputPath = args[2];

  // Validate type BEFORE casting
  if (!VALID_TYPES.includes(typeArg as DataType)) {
    console.error(`Error: Invalid type '${typeArg}'. Must be one of: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }
  const type = typeArg as DataType;

  try {
    // Read input
    let content: string;
    if (inputPath === '-') {
      content = await readStdin();
    } else {
      try {
        if (!fs.existsSync(inputPath)) {
          console.error(`Error: Input file not found: ${inputPath}`);
          process.exit(1);
        }
        content = fs.readFileSync(inputPath, 'utf-8');
      } catch (error) {
        const fsError = error as NodeJS.ErrnoException;
        console.error(`Error reading file '${inputPath}': ${fsError.code || ''} ${fsError.message}`);
        process.exit(1);
      }
    }

    // Process
    const result = processData(type, content);

    let output: string;
    try {
      output = JSON.stringify(result, null, 2);
    } catch (error) {
      console.error(`Error serializing result: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    // Calculate savings (handle empty input)
    const inputSize = content.length;
    const outputSize = output.length;
    const savings = inputSize > 0 ? ((1 - outputSize / inputSize) * 100).toFixed(1) : '0.0';

    // Write output
    if (outputPath) {
      try {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(outputPath, output + '\n');
        console.error(`Processed ${type}: ${inputSize} -> ${outputSize} bytes (${savings}% reduction)`);
        console.error(`Output written to: ${outputPath}`);
      } catch (error) {
        const fsError = error as NodeJS.ErrnoException;
        console.error(`Error writing file '${outputPath}': ${fsError.code || ''} ${fsError.message}`);
        process.exit(1);
      }
    } else {
      // Write stats to stderr, data to stdout
      console.error(`Processed ${type}: ${inputSize} -> ${outputSize} bytes (${savings}% reduction)`);
      console.log(output);
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`JSON Parse Error: ${error.message}`);
    } else if (error instanceof Error && 'code' in error) {
      const fsError = error as NodeJS.ErrnoException;
      console.error(`File System Error: ${fsError.code || ''} - ${fsError.message}`);
    } else if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unknown error: ${String(error)}`);
    }
    process.exit(1);
  }
}

main();

#!/usr/bin/env tsx
/**
 * soma-cli — compatibility entry for the archived-session query tool.
 *
 * The implementation moved to `src/cli/sessions.ts`, which is also what
 * `somawork sessions list|show` calls. This file keeps the historical
 * invocation (`tsx scripts/soma-cli.ts sessions …`), the historical flags, and
 * the historical output — including the `Usage: soma-cli …` line — by delegating
 * to that single owner rather than holding a second copy of the parser.
 *
 * Two things deliberately did **not** come along:
 *
 * - The module-scope data-directory constant. It resolved
 *   `SOMA_CONFIG_DIR/data`, and otherwise `process.cwd()` plus the current git
 *   branch via an `execSync('git branch --show-current')` subprocess. That
 *   contradicted the canonical `SOMA_DATA_DIR` the service and
 *   `@soma/common/env-paths` agree on, made the answer depend on which directory
 *   the operator was standing in, and shelled out on every run.
 * - Reading anything at import time. `resolveSessionsDataDir` is called inside
 *   `main()`, so importing this file (as the characterization tests do) touches
 *   no environment and no disk.
 *
 * Usage:
 *   tsx scripts/soma-cli.ts sessions list [--profile <preview|production>] [options]
 *   tsx scripts/soma-cli.ts sessions show <sessionKey> [--conversation] [--json]
 */

import { getSomaHome } from '@soma/common/soma-paths';
import { isProfileName, type ProfileName } from '../src/cli/profile';
import {
  type ArchivedSession,
  type ConversationRecord,
  listSessions,
  resolveSessionsDataDir,
  type SessionsContextOptions,
  sessionDirs,
  showSession as showSessionCore,
} from '../src/cli/sessions';

const PROGRAM_NAME = 'soma-cli';

/** Default when the invocation names no profile. Matches the stable formula. */
const DEFAULT_PROFILE: ProfileName = 'production';

function readProfileFlag(args: string[]): { profile: ProfileName; rest: string[] } {
  const rest: string[] = [];
  let profile: ProfileName = DEFAULT_PROFILE;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') {
      const value = args[++i];
      if (value === undefined || !isProfileName(value)) {
        console.error(`Invalid --profile value. Expected one of: preview, production.`);
        process.exit(1);
      }
      profile = value;
      continue;
    }
    rest.push(args[i]);
  }
  return { profile, rest };
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] !== 'sessions') {
    console.log(`${PROGRAM_NAME} — Session Archive Query Tool

Usage:
  tsx scripts/soma-cli.ts sessions list [options]
  tsx scripts/soma-cli.ts sessions show <sessionKey> [--conversation] [--json]

List Options:
  --profile <name>  preview | production (default: ${DEFAULT_PROFILE})
  --user <id>       Filter by user ID or name
  --model <model>   Filter by model name
  --since <date>    Start date (YYYY-MM-DD)
  --until <date>    End date (YYYY-MM-DD)
  --limit <N>       Max results (default: 50)
  --json            Output as JSON`);
    process.exit(args.length === 0 ? 0 : 1);
  }

  const subcommand = args[1];
  const { profile, rest } = readProfileFlag(args.slice(2));
  const dataDir = resolveSessionsDataDir({ env: process.env, home: getSomaHome(), profile });
  const opts = { ...sessionDirs(dataDir), programName: PROGRAM_NAME };

  switch (subcommand) {
    case 'list':
      listSessions(rest, opts);
      break;
    case 'show':
      showSessionCore(rest, opts);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

// Only execute when invoked directly (not imported by tests).
if (require.main === module) {
  main();
}

/**
 * The historical `showSession` entry, with this program's name pre-bound.
 *
 * Anything reaching soma-cli — including its characterization tests — sees the
 * `Usage: soma-cli …` line it always saw, while the body is the one in
 * `src/cli/sessions.ts`.
 */
export function showSession(args: string[], opts: SessionsContextOptions): void {
  // Caller options first, then the program name **forced**: spreading `opts`
  // last would let an explicit `programName: undefined` fall through to the
  // `somawork` default and silently change this entry's historical usage line.
  showSessionCore(args, { ...opts, programName: PROGRAM_NAME });
}

export type { ArchivedSession, ConversationRecord };

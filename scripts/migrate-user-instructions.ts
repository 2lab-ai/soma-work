#!/usr/bin/env tsx
/**
 * Admin entry for the user-instruction data-model migration (#754).
 *
 * Usage:
 *   npm run migrate:user-instructions -- --dry-run
 *   npm run migrate:user-instructions -- --apply
 *
 * Prints a JSON summary of what changed (users touched, new instructions
 * projected, backup path on apply mode).
 *
 * The same migration function is invoked eagerly at startup
 * (`src/index.ts` → `runStartupUserInstructionsMigration`); this script is
 * the operator-side knob for re-running the projection or previewing it
 * without restarting the bot.
 */

import '../src/env-paths';
import { DATA_DIR } from '../src/env-paths';
import { migrateUserInstructions } from '../src/user-instructions-migration';

interface ParsedArgs {
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let dryRun: boolean | null = null;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a === '--apply') dryRun = false;
  }
  if (dryRun === null) {
    process.stderr.write(
      'Usage: npm run migrate:user-instructions -- --dry-run | --apply\n' +
        '  --dry-run  Preview the migration; no files are written.\n' +
        '  --apply    Take a backup of sessions.json and write user docs.\n',
    );
    process.exit(2);
  }
  return { dryRun };
}

function main(): void {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const result = migrateUserInstructions({ dataDir: DATA_DIR, dryRun });

  // Single line of structured output for log capture.
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode: dryRun ? 'dry-run' : 'apply',
        dataDir: DATA_DIR,
        usersTouched: result.userIdsTouched,
        newInstructions: result.newInstructions,
        backupPath: result.backupPath ?? null,
        sessionPointers: Object.fromEntries(
          Object.entries(result.sessionPointers).slice(0, 50), // cap output
        ),
      },
      null,
      2,
    )}\n`,
  );
}

main();

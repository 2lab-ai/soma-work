/**
 * The two env-var names the LaunchAgent uses to hand a profile's env files to
 * the supervisor.
 *
 * ## Why these two strings live in a leaf module of their own
 *
 * They are one half of a contract with two ends: the *supervisor*
 * (`src/run-with-rotating-logs.ts`) reads them at start-up, and the
 * *controller* (`src/cli/service.ts`) writes them into the LaunchAgent plist.
 * Until packaging, the controller imported them straight from the supervisor —
 * which is correct for `tsc` (a compiled `dist/cli/service.js` only pulls the
 * supervisor module in at require time for two frozen strings) and wrong for a
 * bundler.
 *
 * The public controller archive is a single self-contained `esbuild` bundle of
 * `src/cli/index.ts`. That one import dragged the whole supervisor — plus
 * `rotating-file-stream` — into it, which broke two things at once:
 *
 * 1. **The archive contract.** The controller package is specified to contain
 *    no daemon entry and no rotating supervisor; it shipped both.
 * 2. **Every discovery command.** `esbuild` compiles ES modules into one CommonJS
 *    file, so each original module's `require.main === module` guard resolves
 *    against the *bundle's* `module` — which is the main module. The
 *    supervisor's entrypoint guard therefore ran the moment
 *    `somawork profile list` touched `src/cli/service.ts`, spawned a child, and
 *    exited the process with the child's status. `somawork profile list` printed
 *    nothing and exited 1.
 *
 * Splitting the constants out is the fix that keeps both ends honest: the
 * supervisor is no longer in the controller's import closure at all, so no
 * bundler flag, `--define` trick, or entrypoint-guard rewrite is needed to keep
 * it out.
 */

/**
 * Env vars (set by the LaunchAgent) naming the two profile env files.
 *
 * Two variables rather than one separated list: a profile path may legally
 * contain a colon (or a space), and a joined list makes every such machine
 * un-startable. Splitting on a character that can appear in the data is a bug
 * waiting for the first operator with a colon in their home directory.
 */
export const PROFILE_ENV_FILE_VAR = 'SOMA_PROFILE_ENV_FILE';
export const PROFILE_SECRETS_FILE_VAR = 'SOMA_PROFILE_SECRETS_FILE';

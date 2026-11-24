import { posix } from 'node:path';
import { redactSecrets } from '@soma/common/logger';

/**
 * What the Processes tab may show of a command line — an allow-list, fail-closed.
 *
 * `ps args` joins argv with spaces and does not quote, so argument boundaries are gone, and even with them a flag's
 * arity is unknown (`jq --arg name --swordfish`: the third word is a value that looks like a flag; `p@ss/word` is a
 * value that looks like a path). No rule over the words can tell a value from a flag or a path. So nothing after the
 * program is copied from the command line. The preview is built only from:
 *   - the program's basename;
 *   - for an interpreter (`node`, `python3` …), its script's basename, when the script is where the interpreter takes
 *     it and looks like a file: the first operand, with only known no-value options before it. Once any value has been
 *     cut, no word is taken as the script — ps may have split that value (`--import 'data:… /hunter2 …'`), and its
 *     tail can look like a script;
 *   - flag names from {@link SHOWN_FLAGS}, a fixed list: a known flag that takes no value is shown as is; a known flag
 *     that takes one value is shown with its value cut (`--model …`, `--model=…`);
 *   - `…`.
 * The walk stops at the first word it does not know — an unknown flag, a short flag, an operand, `NAME=value`, a
 * second value — and everything from there is one `…`. So the output is a known prefix of the command, and every word
 * in it is a constant of this module or the program's (and script's) own name. The logger's shaped-token redaction then
 * runs over that name.
 */

const MAX_ARGS = 16;
const MAX_TOTAL = 240;
const MAX_NAME = 60;
const CUT = '…';

/** Flags that take no value: shown as is. */
const BARE_FLAGS = [
  // Claude Code (the SDK's CLI)
  '--verbose',
  '--continue',
  '--fork-session',
  '--include-partial-messages',
  '--include-hook-events',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--allow-dangerously-skip-permissions',
  '--dangerously-skip-permissions',
  '--debug-to-stderr',
  '--no-optional-locks',
  // node
  '--enable-source-maps',
  '--no-warnings',
  '--no-deprecation',
  '--trace-warnings',
  '--expose-gc',
  // common
  '--porcelain',
  '--short',
  '--quiet',
  '--silent',
  '--version',
  '--help',
  '--watch',
  '--no-color',
] as const;

/** Flags that take exactly one value: the name is shown, the value is cut. */
const VALUE_FLAGS = [
  // Claude Code (the SDK's CLI)
  '--model',
  '--fallback-model',
  '--output-format',
  '--input-format',
  '--permission-mode',
  '--max-turns',
  '--max-thinking-tokens',
  '--max-budget-usd',
  '--effort',
  '--thinking-display',
  '--setting-sources',
  '--permission-prompt-tool',
  '--resume',
  '--add-dir',
  '--plugin-dir',
  '--tools',
  '--agent',
  // node
  '--require',
  '--import',
  '--max-old-space-size',
  // common
  '--port',
] as const;

/** Every flag name the preview may show. Anything else — including any short flag — ends the preview. */
export const SHOWN_FLAGS: ReadonlySet<string> = new Set<string>([...BARE_FLAGS, ...VALUE_FLAGS]);
const TAKES_VALUE: ReadonlySet<string> = new Set<string>(VALUE_FLAGS);

const INTERPRETER = /^(node|bun|deno|python[0-9.]*|ruby|perl|sh|bash|zsh)$/;

/**
 * What a multi-command tool is doing: its subcommand words, right after the program and before any flag — `npm run
 * build`, `git status`, `gh pr view`, `docker compose up`. Only these tools, only that position, only words shaped like a
 * subcommand (lowercase, short), and the second word only after a first word that takes one. A value (a branch, a PR
 * number, a path) never sits there.
 */
const SUBCOMMAND_DEPTH: Readonly<Record<string, number>> = {
  npm: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  uv: 2,
  gh: 2,
  docker: 2,
  npx: 1,
  bunx: 1,
  git: 1,
  kubectl: 1,
  cargo: 1,
  go: 1,
  make: 1,
  pip: 1,
  pip3: 1,
  brew: 1,
  deno: 1,
  rustup: 1,
  terraform: 1,
};
/** First words that take a second one (`npm run build`, `gh pr view`, `docker compose up`, `uv pip install`). */
const TAKES_SUBCOMMAND = new Set([
  'run',
  'run-script',
  'exec',
  'x',
  'dlx',
  'pr',
  'issue',
  'repo',
  'workflow',
  'compose',
  'pip',
  'tool',
]);
const SUBCOMMAND_WORD = /^[a-z][a-z0-9:_-]{0,24}$/;
/** `python -m <module>`: the module the interpreter runs. */
const MODULE_NAME = /^[A-Za-z_][\w.]{0,40}$/;
/** A script argument that is a file: path-like (a `/` or a script extension), with no quotes, spaces or brackets. */
const SCRIPT_FILE = /^(?=[\w./@+-]+$)(?:.*\/.*|.*\.(?:js|mjs|cjs|ts|mts|py|rb|pl|sh|php|lua))$/;
const LONG_TOKEN = /[A-Za-z0-9_\-+/=.]{32,}/g;

const basename = (p: string): string => posix.basename(p) || p;

/** A name taken from the command line (the program's, the script's): token-redacted, long runs cut, length capped. */
function safeName(raw: string): string {
  const name = String(redactSecrets(raw)).replace(LONG_TOKEN, CUT);
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}${CUT}` : name;
}

interface Walked {
  readonly exe: string;
  readonly script?: string;
  /** The known prefix after the program: shown flags, `…` for a cut value, and a final `…` if the walk stopped. */
  readonly rest: string[];
}

/** Walk argv while every word is known (see the module comment); stop at the first one that is not. */
function walk(argv: readonly string[]): Walked {
  const exe = safeName(basename(argv[0]));
  const interpreter = INTERPRETER.test(basename(argv[0]));
  const subDepth = SUBCOMMAND_DEPTH[basename(argv[0])] ?? 0;
  const rest: string[] = [];
  const subcommands: string[] = [];
  let script: string | undefined;
  // A value was cut: from here on a word may be its spill, so none is taken as the script.
  let afterValue = false;
  let shown = 0;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (shown >= MAX_ARGS) {
      rest.push(CUT);
      break;
    }
    shown++;
    // A subcommand: right after the program (nothing else shown yet), a known tool, a subcommand-shaped word.
    if (
      subcommands.length < subDepth &&
      rest.length === subcommands.length &&
      SUBCOMMAND_WORD.test(arg) &&
      (subcommands.length === 0 || TAKES_SUBCOMMAND.has(subcommands[0]))
    ) {
      subcommands.push(arg);
      rest.push(arg);
      continue;
    }
    // `python -m pytest`: the module, then nothing else is a script.
    if (
      /^python[0-9.]*$/.test(basename(argv[0])) &&
      arg === '-m' &&
      rest.length === 0 &&
      MODULE_NAME.test(argv[i + 1] ?? '')
    ) {
      rest.push('-m', argv[i + 1]);
      afterValue = true;
      i++;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (SHOWN_FLAGS.has(name)) {
      if (name !== arg) {
        // `--model=opus`, `--porcelain=v2`: the value is written in.
        rest.push(`${name}=${CUT}`);
        afterValue = true;
        continue;
      }
      rest.push(name);
      if (TAKES_VALUE.has(name) && i + 1 < argv.length) {
        // The next word is this flag's value, whatever it looks like (`--model --verbose` hides `--verbose`).
        rest.push(CUT);
        afterValue = true;
        i++;
      }
      continue;
    }
    if (interpreter && script === undefined && !afterValue && !arg.startsWith('-') && SCRIPT_FILE.test(arg)) {
      // The interpreter's first operand is its script.
      script = safeName(basename(arg));
      rest.push(script);
      continue;
    }
    rest.push(CUT);
    break;
  }
  return { exe, script, rest };
}

/** Split a `ps args` line into argv. ps joins argv with single spaces and does not quote, so this is best effort. */
export function splitArgs(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/** Program name for the table: the executable's basename, plus the script for an interpreter. */
export function processName(argv: readonly string[]): string {
  if (argv.length === 0) return '?';
  const { exe, script } = walk(argv);
  const name = script ? `${exe} ${script}` : exe;
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}${CUT}` : name;
}

/** A command line safe to show in the dashboard (see the module comment for what is shown). */
export function commandPreview(argv: readonly string[]): string {
  if (argv.length === 0) return '';
  const { exe, rest } = walk(argv);
  let line = [exe, ...rest].join(' ');
  if (line.length > MAX_TOTAL) line = `${line.slice(0, MAX_TOTAL - 1)}${CUT}`;
  return line;
}

/**
 * `somawork` argument parsing.
 *
 * ## Every token is consumed exactly once
 *
 * The first version detected flags with `indexOf` / `includes` and threw the
 * rest away. That is quietly dangerous for a CLI whose entire JSON subsystem
 * exists to keep stdout parseable: `somawork doctor --jsonn` silently produced
 * *human text* where a script expected JSON, and
 * `--profile preview --profile production` silently kept the first and dropped
 * the second without a word.
 *
 * So every command now declares its exact grammar in {@link COMMAND_GRAMMAR}
 * and {@link parseArguments} walks the tail token by token: an unrecognised
 * flag, a flag valid for a *different* command, a repeated flag, a missing
 * value, and a stray positional are all `CliArgError`. Messages name the
 * offending flag or value and nothing else from the argv.
 *
 * The private `_capture-slack-auth` / `_print-slack-manifest` hook subcommands
 * are deliberately absent from this grammar. They are routed *before* this
 * parser in `index.ts` and must never appear here, in an error message, or in
 * the help text {@link publicCommandSummaries} generates from this same table.
 */

import { isProfileName, type ProfileName } from './profile';
import { SESSIONS_LIST_FLAGS, SESSIONS_SHOW_FLAGS, type SessionsFlagKind } from './sessions';

export type ServiceAction = 'install' | 'start' | 'stop' | 'restart' | 'status';
export type ProfileAction = 'list' | 'show' | 'remove';
export type SessionsAction = 'list' | 'show';

export type CliCommand =
  | { command: 'setup'; profile?: ProfileName; resume: boolean }
  | { command: 'doctor'; profile?: ProfileName; json: boolean }
  | { command: 'status'; profile?: ProfileName; json: boolean }
  | { command: 'service'; action: ServiceAction; profile?: ProfileName }
  | { command: 'profile'; action: ProfileAction; profile?: ProfileName; json: boolean }
  /**
   * `rest` is the sessions handler's own argument tail, validated here against
   * the tables `src/cli/sessions.ts` exports but passed through otherwise
   * untouched apart from `--profile`. The filters and renderers have exactly one
   * owner; re-declaring their semantics here would create a second one.
   */
  | { command: 'sessions'; action: SessionsAction; profile?: ProfileName; rest: string[] }
  | { command: 'help' }
  | { command: 'version' };

export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

const SERVICE_ACTIONS: readonly ServiceAction[] = ['install', 'start', 'stop', 'restart', 'status'];
const PROFILE_ACTIONS: readonly ProfileAction[] = ['list', 'show', 'remove'];
const SESSIONS_ACTIONS: readonly SessionsAction[] = ['list', 'show'];

/** Public command names, in help order. Never includes a private hook route. */
export const PUBLIC_COMMANDS = ['setup', 'doctor', 'status', 'service', 'profile', 'sessions'] as const;

const HELP_TOKENS = new Set(['help', '--help', '-h']);
const VERSION_TOKENS = new Set(['version', '--version', '-V']);

const PROFILE_FLAG = '--profile';

type FlagKind = SessionsFlagKind;

interface Grammar {
  flags: Readonly<Record<string, FlagKind>>;
  minPositionals: number;
  maxPositionals: number;
}

const PROFILE_ONLY: Readonly<Record<string, FlagKind>> = { [PROFILE_FLAG]: 'value' };

const COMMAND_GRAMMAR: Readonly<Record<(typeof PUBLIC_COMMANDS)[number], Grammar>> = {
  setup: { flags: { ...PROFILE_ONLY, '--resume': 'boolean' }, minPositionals: 0, maxPositionals: 0 },
  doctor: { flags: { ...PROFILE_ONLY, '--json': 'boolean' }, minPositionals: 0, maxPositionals: 0 },
  status: { flags: { ...PROFILE_ONLY, '--json': 'boolean' }, minPositionals: 0, maxPositionals: 0 },
  service: { flags: PROFILE_ONLY, minPositionals: 0, maxPositionals: 0 },
  profile: { flags: { ...PROFILE_ONLY, '--json': 'boolean' }, minPositionals: 0, maxPositionals: 0 },
  // Replaced per-action below; `sessions` never uses this entry directly.
  sessions: { flags: PROFILE_ONLY, minPositionals: 0, maxPositionals: 0 },
};

/** One-line summaries, rendered by `index.ts`'s help route from this same table. */
export function publicCommandSummaries(): ReadonlyArray<{ usage: string; summary: string }> {
  return [
    { usage: 'somawork setup [--profile preview|production] [--resume]', summary: 'Run or resume onboarding.' },
    { usage: 'somawork doctor [--profile <p>] [--json]', summary: 'Diagnose a profile.' },
    { usage: 'somawork status [--profile <p>] [--json]', summary: 'Show profile and service state.' },
    {
      usage: `somawork service <${SERVICE_ACTIONS.join('|')}> [--profile <p>]`,
      summary: 'Manage the background service.',
    },
    {
      usage: `somawork profile <${PROFILE_ACTIONS.join('|')}> [--profile <p>] [--json]`,
      summary: 'Inspect installed profiles.',
    },
    {
      usage: `somawork sessions <${SESSIONS_ACTIONS.join('|')}> [--profile <p>] [filters]`,
      summary: 'Query archived sessions.',
    },
    { usage: 'somawork help | --help | -h', summary: 'Show this message.' },
    { usage: 'somawork version | --version | -V', summary: 'Print the controller version.' },
  ];
}

// ---------------------------------------------------------------------------
// Token walker
// ---------------------------------------------------------------------------

interface ParsedArguments {
  flags: Map<string, string | true>;
  positionals: string[];
}

/**
 * Walk `tokens` against `grammar`, consuming every one exactly once.
 *
 * `command` appears in error messages so an operator learns *which* command
 * rejected the flag; no other argv token is ever echoed except the offending
 * one itself.
 */
function parseArguments(tokens: readonly string[], grammar: Grammar, command: string): ParsedArguments {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.startsWith('-') && token !== '-') {
      const kind = grammar.flags[token];
      if (kind === undefined) {
        throw new CliArgError(
          `Unknown option "${token}" for "${command}". Expected one of: ${Object.keys(grammar.flags).join(', ') || 'no options'}.`,
        );
      }
      if (flags.has(token)) {
        throw new CliArgError(`Option "${token}" was given more than once.`);
      }
      if (kind === 'boolean') {
        flags.set(token, true);
        continue;
      }
      const value = tokens[i + 1];
      // A value that is itself an option means the operator forgot one: taking
      // it would swallow a real flag and produce a nonsense value.
      if (value === undefined || value.startsWith('--')) {
        throw new CliArgError(`Option "${token}" requires a value.`);
      }
      flags.set(token, value);
      i += 1;
      continue;
    }

    positionals.push(token);
  }

  if (positionals.length > grammar.maxPositionals) {
    throw new CliArgError(`Unexpected argument "${positionals[grammar.maxPositionals]}" for "${command}".`);
  }
  if (positionals.length < grammar.minPositionals) {
    throw new CliArgError(`"${command}" needs ${grammar.minPositionals} more argument(s).`);
  }

  return { flags, positionals };
}

function readProfile(parsed: ParsedArguments): ProfileName | undefined {
  const value = parsed.flags.get(PROFILE_FLAG);
  if (value === undefined) return undefined;
  if (value === true) throw new CliArgError(`Option "${PROFILE_FLAG}" requires a value.`);
  if (!isProfileName(value)) {
    throw new CliArgError(`Invalid --profile value "${value}". Expected one of: preview, production.`);
  }
  return value;
}

function readAction<T extends string>(rest: readonly string[], parent: string, allowed: readonly T[]): T {
  const action = rest[0];
  if (action === undefined) {
    throw new CliArgError(`Missing action for "${parent}". Expected one of: ${allowed.join(', ')}.`);
  }
  if (!(allowed as readonly string[]).includes(action)) {
    throw new CliArgError(`Unknown "${parent}" action "${action}". Expected one of: ${allowed.join(', ')}.`);
  }
  return action as T;
}

/**
 * Rebuild the sessions tail in a canonical order for the handler.
 *
 * The handler's `parseShowArgs` reads the session key as `args[0]`, so a tail
 * passed through verbatim made `sessions show --json sess-abc` look up a session
 * literally named `--json` — a loud failure, but one the help text
 * (`sessions <list|show> … [filters]`) actively invites. The strict parser
 * already knows which token was the positional, so it emits the key first and
 * the flags after it.
 *
 * This is re-ordering, not re-interpretation: only tokens the operator actually
 * typed are emitted, `--profile` (consumed by this layer) is dropped, and every
 * flag keeps its value. The handler's semantics stay its own.
 */
function normalizeSessionsArgv(parsed: ParsedArguments, handlerFlags: Readonly<Record<string, FlagKind>>): string[] {
  // Positional first: an absent key still yields an empty lead, so the handler
  // reaches its historical usage line rather than a parse error.
  const out: string[] = [...parsed.positionals];
  for (const flag of Object.keys(handlerFlags)) {
    const value = parsed.flags.get(flag);
    if (value === undefined) continue;
    out.push(flag);
    if (value !== true) out.push(value);
  }
  return out;
}

function assertNoExtraTokens(rest: readonly string[], command: string): void {
  if (rest.length > 0) {
    throw new CliArgError(`Unexpected argument "${rest[0]}" for "${command}".`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse `process.argv.slice(2)` into a typed `CliCommand`.
 *
 * Grammar (see {@link publicCommandSummaries} for the rendered form):
 *   somawork setup    [--profile <preview|production>] [--resume]
 *   somawork doctor   [--profile <preview|production>] [--json]
 *   somawork status   [--profile <preview|production>] [--json]
 *   somawork service  <install|start|stop|restart|status> [--profile <p>]
 *   somawork profile  <list|show|remove> [--profile <p>] [--json]
 *   somawork sessions <list|show> [--profile <p>] [handler filters]
 *   somawork help | --help | -h
 *   somawork version | --version | -V
 */
export function parseCli(argv: string[]): CliCommand {
  const [command, ...rest] = argv;

  if (command === undefined) {
    throw new CliArgError(
      `Missing command. Expected one of: ${PUBLIC_COMMANDS.join(', ')} (or "help"). Run "somawork help".`,
    );
  }

  if (HELP_TOKENS.has(command)) {
    assertNoExtraTokens(rest, 'help');
    return { command: 'help' };
  }
  if (VERSION_TOKENS.has(command)) {
    assertNoExtraTokens(rest, 'version');
    return { command: 'version' };
  }

  switch (command) {
    case 'setup': {
      const parsed = parseArguments(rest, COMMAND_GRAMMAR.setup, 'setup');
      return { command: 'setup', profile: readProfile(parsed), resume: parsed.flags.has('--resume') };
    }
    case 'doctor':
    case 'status': {
      const parsed = parseArguments(rest, COMMAND_GRAMMAR[command], command);
      return { command, profile: readProfile(parsed), json: parsed.flags.has('--json') };
    }
    case 'service': {
      const action = readAction(rest, 'service', SERVICE_ACTIONS);
      const parsed = parseArguments(rest.slice(1), COMMAND_GRAMMAR.service, 'service');
      return { command: 'service', action, profile: readProfile(parsed) };
    }
    case 'profile': {
      const action = readAction(rest, 'profile', PROFILE_ACTIONS);
      const parsed = parseArguments(rest.slice(1), COMMAND_GRAMMAR.profile, 'profile');
      return { command: 'profile', action, profile: readProfile(parsed), json: parsed.flags.has('--json') };
    }
    case 'sessions': {
      const action = readAction(rest, 'sessions', SESSIONS_ACTIONS);
      const tail = rest.slice(1);
      // The handler's own flags, plus `--profile`, which this layer consumes.
      // `sessions show` takes an optional session key: omitting it must reach
      // the handler so it prints its historical usage line, not a parse error.
      const handlerFlags = action === 'list' ? SESSIONS_LIST_FLAGS : SESSIONS_SHOW_FLAGS;
      const grammar: Grammar =
        action === 'list'
          ? { flags: { ...handlerFlags, ...PROFILE_ONLY }, minPositionals: 0, maxPositionals: 0 }
          : { flags: { ...handlerFlags, ...PROFILE_ONLY }, minPositionals: 0, maxPositionals: 1 };
      const parsed = parseArguments(tail, grammar, `sessions ${action}`);
      return {
        command: 'sessions',
        action,
        profile: readProfile(parsed),
        rest: normalizeSessionsArgv(parsed, handlerFlags),
      };
    }
    default:
      throw new CliArgError(
        `Unknown command "${command}". Expected one of: ${PUBLIC_COMMANDS.join(', ')} (or "help").`,
      );
  }
}

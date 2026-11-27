/**
 * Query options as they may be logged.
 *
 * `options.env` is the agent's whole environment — its llmux key or OAuth token at least — and each MCP server's `env`
 * and `headers` carry what that server authenticates with (the Slack bot token, an `Authorization` header resolved
 * from config), and a server's arguments or URL can carry a key too. The log redactor knows a few credential shapes,
 * not every secret, so the debug log of a turn's options once wrote the GitHub App's private key and the Slack signing
 * secret in clear. Here an environment and a header map are reduced to their names, a server's arguments to their
 * count and its URL to its origin; everything else is logged as it was. The options themselves are not touched.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';

type Loggable = Record<string, unknown>;

function names(map: unknown): string[] | undefined {
  if (!map || typeof map !== 'object') return undefined;
  return Object.keys(map).sort();
}

/** The origin of `url` only: a path or query may be a signed credential. */
function origin(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  try {
    return new URL(url).origin;
  } catch {
    return '[unparsed url]';
  }
}

function loggableServer(server: unknown): unknown {
  if (!server || typeof server !== 'object') return server;
  const { env, headers, args, url, ...rest } = server as Loggable;
  return {
    ...rest,
    ...(env !== undefined ? { env: names(env) } : {}),
    ...(headers !== undefined ? { headers: names(headers) } : {}),
    // An argument may be a key (`--api-key …`, a configured `${VAR}`): the count only.
    ...(Array.isArray(args) ? { args: `${args.length} args` } : {}),
    ...(url !== undefined ? { url: origin(url) } : {}),
  };
}

export function loggableOptions(options: Options): Loggable {
  const { env, mcpServers, ...rest } = options as Options & Loggable;
  return {
    ...rest,
    ...(env !== undefined ? { env: names(env) } : {}),
    ...(mcpServers && typeof mcpServers === 'object'
      ? {
          mcpServers: Object.fromEntries(
            Object.entries(mcpServers as Loggable).map(([name, server]) => [name, loggableServer(server)]),
          ),
        }
      : {}),
  };
}

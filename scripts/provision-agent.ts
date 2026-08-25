#!/usr/bin/env npx tsx
/**
 * provision-agent.ts — DEPRECATED hard wrapper.
 *
 * ## Why the implementation is gone rather than ported
 *
 * The old script provisioned a Slack app by:
 *
 * 1. storing a long-lived Slack **configuration token** (plus its refresh
 *    token) inside the repository's `config.json`;
 * 2. running a local HTTP server on a fixed port as an OAuth callback and
 *    reading the resulting `xoxb-` token out of a redirect;
 * 3. printing a link and asking the operator to paste an `xapp-` token into the
 *    terminal;
 * 4. writing the tokens into `config.json` and creating a prompt directory as a
 *    side effect.
 *
 * Every one of those is a credential path the current design forbids: no
 * credential may enter argv, a URL, stdout, a state file, or a
 * version-controlled config. Slack app creation and installation are now owned
 * by the Slack CLI, and the runtime tokens travel child env -> local Unix socket
 * -> 0600 `secrets.env` without ever being a value the wizard holds. There is no
 * subset of the old flow that survives that contract, and no separately
 * supported public multi-agent provisioning surface for it to serve, so the
 * code was deleted rather than kept as dead helpers.
 *
 * The canonical manifest construction lives in `src/cli/setup/slack-manifest.ts`
 * (`buildProfileManifest` / `materializeSlackProject`) and is not duplicated
 * here.
 */

const MESSAGE = `provision-agent.ts is deprecated and no longer provisions anything.

Slack app creation, installation and runtime-credential capture are part of the
onboarding wizard:

    somawork setup [--profile preview|production]

The removed flow stored a Slack configuration token in config.json, ran a local
OAuth callback server, and prompted for an app-level token on the terminal. If
you have a stale "configurationToken" entry in a config.json, delete it: nothing
reads it any more, and it is a live credential sitting in a tracked file.
`;

function main(): void {
  process.stderr.write(MESSAGE);
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}

export { MESSAGE as PROVISION_AGENT_DEPRECATION_MESSAGE };

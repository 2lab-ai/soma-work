#!/bin/bash
# new-deploy-setup.sh — DEPRECATED compatibility shim.
#
# Replaced by `somawork setup`. The old three-phase script installed tools with
# curl, prompted for `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_SIGNING_SECRET`
# on the terminal, wrote them into a repo-relative `.env`, cloned into
# `/opt/soma-work/<env>`, and tracked progress in a `.new-deploy-state` file.
# All of that is deleted: runtime credentials are now minted by the Slack CLI
# and delivered over a profile-scoped Unix socket into a 0600 `secrets.env`,
# never through a prompt, an argv, or a shell history entry.
#
# Profile mapping, for the one historical argument that is unambiguous:
#   DEPLOY_ENV=dev   -> --profile preview
#   DEPLOY_ENV=main  -> --profile production
# Anything else is left to `somawork setup`'s own runtime discovery.
set -euo pipefail

echo "scripts/new-deploy-setup.sh is deprecated; running \`somawork setup\` instead." >&2

case "${DEPLOY_ENV:-}" in
  dev)  exec somawork setup --profile preview ;;
  main) exec somawork setup --profile production ;;
  *)    exec somawork setup ;;
esac

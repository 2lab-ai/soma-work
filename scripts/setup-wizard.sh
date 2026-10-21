#!/bin/bash
# setup-wizard.sh — DEPRECATED compatibility shim.
#
# Onboarding is `somawork setup`: one resumable wizard that discovers the
# installed runtime, brings llmux up, authorizes the Slack CLI, creates the
# Slack app and captures its runtime credentials over a local Unix socket,
# materializes the profile, runs the doctor gate, and installs the service.
#
# Everything this file used to do is gone on purpose: the curl installers, the
# credential prompts, the `/opt/soma-work` materialization, and the private
# `.setup-wizard-state` file. None of them are reachable from here any more.
set -euo pipefail

echo "scripts/setup-wizard.sh is deprecated; running \`somawork setup\` instead." >&2
exec somawork setup "$@"

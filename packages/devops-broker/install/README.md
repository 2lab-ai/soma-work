# devops-broker installer (macOS)

`install.sh` puts the devops broker on a Mac as its own OS user, with root-owned code and a LaunchDaemon
(`.prd/16-devops-tools-architecture.md` §2, §7, §8). Run it with `sudo`. Running it again is the upgrade path.
`uninstall.sh` removes it.

## What it installs

| Path | Owner | Mode | Holds |
|---|---|---|---|
| `/usr/local/libexec/soma-devops/` | `root:wheel` | dirs 0755, files 0644 | code: copied, never linked |
| `…/node`, `…/gh` | `root:wheel` | 0755 | from the official release archives in `pins.txt` |
| `…/app/node_modules/@soma/{devops-broker,process-shared}/` | `root:wheel` | 0755 / 0644 | `package.json` + `dist/` of each, nothing else |
| `/usr/local/var/soma-devops/` | `root:soma-devops` | 0750 | data root (`SOMA_DEVOPS_ROOT`) |
| `…/policy.json` | `root:wheel` | 0644 | broker policy (below) |
| `…/secrets/` + `gh/ cf/ slack/` | `_somadevops:soma-devops` | 0700 | one 0600 file per secret |
| `…/state/` | `_somadevops:soma-devops` | 0700 | approval and lease state, `ledger.jsonl` |
| `…/run/` | `_somadevops:soma-devops` | 0750 | `broker.sock` (0660) |
| `/usr/local/var/log/soma-devops/` | `_somadevops:soma-devops` | 0700 | daemon stdout/stderr |
| `/Library/LaunchDaemons/ai.soma.devops-broker.plist` | `root:wheel` | 0644 | from `ai.soma.devops-broker.plist.template` |

- **Users.** A hidden system user `_somadevops` (shell `/usr/bin/false`, home `/var/empty`) and a group `soma-devops`
  with the same id when it is free: the highest id from 499 down to 401 that is neither a UID nor a GID
  (`dscl . -list`). An existing user or group keeps its id. The bot user is added to `soma-devops`, which is what
  lets it reach the socket. **Restart the bot afterwards**: a running process keeps the groups it started with.
  The group must hold the bot user and nobody else (no other members, no nested groups): the checklist fails
  otherwise.
- **Every directory above** the code, the data root, the log directory and the plist must be root-owned, not
  group- or other-writable and without an ACL that grants anything, all the way to `/`. Otherwise the installer
  prints a `FAIL` line and stops before changing anything. On a Mac where Homebrew owns `/usr/local/var` or
  `/usr/local/libexec`, give those directories back to root first.
- **The data root is `root:soma-devops 0750`.** Only root can add, rename or replace anything directly in it, so the
  broker cannot swap `policy.json`, and the broker and the bot (through the group) can only enter it. `secrets/`,
  `state/` and `run/` inside it are the broker's. `loadPolicy` accepts a root-owned parent, `readSecret` checks only
  `secrets/` and below, and `serve` checks only `run/` (broker-owned, not group- or other-writable).
- **No ACL grants anything on what the installer owns.** It strips ACLs (`chmod -N`) from the staged code, the plist,
  the data root, `policy.json`, `secrets/`, `state/`, `run/` and the log directory. Inside the broker's own
  directories it asks the broker user to do it, never root. An ACL that granted something on the data or logs before
  the run is removed and still fails that run: whoever it named may already have read a secret or rewritten the
  policy, so find out, rotate what it exposed, and run the installer again. The checklist fails on any ACL entry
  that grants anything anywhere under the code, the data, the logs or the plist. Deny-only entries are fine.
- **policy.json is `root:wheel 0644`.** Policy changes need sudo, which is how 16 §8 changes the admin list. The
  broker reads it through the world-read bit; only the broker user and `soma-devops` members can enter the data root,
  and the file holds IDs, not secrets. The installer refuses a `policy.json` that is a symlink or has more than one
  hard link, and never changes the owner or mode of anything inside a broker-owned directory: it asks the broker user
  to create `secrets/gh`, `secrets/cf` and `secrets/slack`, and only checks them afterwards.
- **Umask 63 (= 0o077).** launchd applies it before it starts the daemon. Any file or directory the broker creates
  without an explicit mode is private to the broker user, and so are the launchd log files. The one shared object
  is the socket. The broker sets the umask to 0o117 just for the bind, puts the old one back, and then `chmod`s
  the socket to 0660 (`broker.ts` `listen`). Its group is `soma-devops` because BSD gives a new file the group of
  its directory. Before it binds, `serve` refuses a `run/` that is not owned by the broker user or that is group-
  or other-writable. The installer makes `run/` 0750 `_somadevops:soma-devops`, which passes that check. A
  launchd umask of 23 (0o027) would make every file the broker creates without an explicit mode readable by
  `soma-devops`, which includes the bot.
- **`serve --gh <path>`.** The daemon runs `<libexec>/node <cli.js> serve --gh <libexec>/gh` with
  `SOMA_DEVOPS_ROOT` set and working directory `/`. gh-runner then checks that the gh file and the directory it
  really lives in are root-owned and not group- or other-writable. `ExitTimeOut` is 90 seconds: on SIGTERM the
  broker waits up to 30 seconds for running requests, and one gh run can take 60 seconds.

## Before you start

1. **A build in a checkout the bot user cannot write.** The installer copies `packages/devops-broker/dist` and
   `packages/process-shared/dist` in as root-owned code. Build in a fresh clone owned by you (`npm ci && npm run
   build`), never in the bot's working tree. The installer fails, before it changes anything, when any of these is
   owned by the bot user, group- or other-writable, or carries an ACL that grants anything: the two `package.json`
   files, every file and directory in the two `dist/` trees, the plist template, `pins.txt`, and every directory from
   them up to the checkout root. It also fails when a copied entry is a symlink, a hard link or not a regular
   file or directory. Above the checkout root, no directory may belong to the bot user or be writable by others
   unless it is sticky. Read `install.sh` and `pins.txt` in that clone before you run them with sudo.
2. **No Slack CLI login in the bot user's home** (see "Slack CLI login").
3. **The broker's own Slack app** is installed and you have its bot token (WU2 manifest).
4. **Network to nodejs.org and github.com**, or the two archives already downloaded (next section).
5. `otool` needs the Xcode Command Line Tools.

## node and gh: official archives, pinned by sha256

The installer never takes `node` or `gh` from a `PATH`, a Homebrew prefix or a path you pass. It uses the official
release archives listed in `pins.txt`, one per tool and architecture (Apple silicon or Intel), each with its sha256:

| Tool | Version | Archive (arm64 / x64) | Checksums taken from |
|---|---|---|---|
| gh | 2.102.0 = `GH_POLICY_GH_VERSION` | `gh_2.102.0_macOS_arm64.zip` / `gh_2.102.0_macOS_amd64.zip` | `https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt` (same digests on the release assets in the GitHub API) |
| node | 24.22.1 (LTS line 24) | `node-v24.22.1-darwin-arm64.tar.gz` / `node-v24.22.1-darwin-x64.tar.gz` | `https://nodejs.org/dist/v24.22.1/SHASUMS256.txt` |

By default it downloads the archive with `/usr/bin/curl` (https only) from `https://nodejs.org/dist/v<version>/` and
`https://github.com/cli/cli/releases/download/v<version>/`. Offline, pass `--node-archive <file>` and
`--gh-archive <file>` instead. Either way the archive is copied into a root-only (0700) stage and hashed there, and
only an archive with the pinned sha256 is unpacked. Then, on the staged copy, the installer checks three things:
`otool -L` lists only `/usr/lib` and `/System/Library`; `node --version` and `gh --version` report the pinned
versions when run as `nobody` with an empty environment; and the broker code passes the `require()` scan. Only then
does it open the stage. Nothing from the archive runs as root.

The gh version must equal `GH_POLICY_GH_VERSION` in `packages/process-shared/src/devops/gh-policy.ts`, because the
allowlist is written against that release. To move to a new version, update `pins.txt` from the release's own
checksum file in the same change that moves `GH_POLICY_GH_VERSION` (or the node line). The installer refuses a
`pins.txt` that disagrees with the build.

## Slack CLI login

A Slack CLI login (`~<bot-user>/.slack/credentials.json`) left on the bot user can mint tokens for every Slack app
its human collaborates on. If that includes the broker's app, the model can edit pending cards. If that human is a
broker admin, it can approve them. So `install.sh` fails while that file exists. Either log out of the Slack CLI as
the bot user, or check it by hand and re-run with `--accept-slack-cli-login`, which turns the `FAIL` into a `WARN`
line in the checklist. The check by hand:

1. Read the logged-in user IDs without printing the tokens:
   `sudo grep -o '"user_id": *"[^"]*"' ~<bot-user>/.slack/credentials.json`.
2. None of those IDs may be in `policy.json` `admins`.
3. None of those users may be a collaborator on the broker's Slack app (the app's settings page, Collaborators).

Repeat the check whenever the admin list or the app's collaborators change.

## Install

```sh
sudo packages/devops-broker/install/install.sh --bot-user <bot-os-user>
# offline:
sudo packages/devops-broker/install/install.sh --bot-user <bot-os-user> \
  --node-archive ~/Downloads/node-v24.22.1-darwin-arm64.tar.gz --gh-archive ~/Downloads/gh_2.102.0_macOS_arm64.zip
```

Run it from an operator account. It refuses to run when `SUDO_USER` is the bot user.

The installer:

1. Runs preflight checks. They only read, and nothing changes if any of them fails:
   - the Slack CLI login check;
   - the checkout trust rules ("Before you start");
   - `pins.txt` against the build;
   - the ownership of the target ancestors.
2. Stages the code in `/usr/local/libexec/.soma-devops.new` (0700). It obtains and verifies the archives, unpacks
   `node` and `gh`, and copies both packages. It then checks the copy: no symlinks or extra hard links, the
   `require()` scan, the staged `GH_POLICY_GH_VERSION`, the linkage, and the versions run as `nobody`. Only after
   that does it set `root:wheel` with 0755 for dirs and 0644 for files (0755 for `node` and `gh`) and open the stage.
   A failure removes the stage.
3. Creates the user and group, and adds the bot user to the group.
4. Creates the data tree, and installs the policy template if `policy.json` is missing.
5. Boots out a running daemon, swaps in the new code, writes the plist, and runs `check-policy` as `_somadevops`. The
   output shows its exit status.
6. Prints the ownership and permission checklist: one `OK`/`FAIL` line per path; every entry of the code tree
   (owner, mode, one link); ACL grants; the group members; and the Slack CLI `WARN` if you accepted one.
7. Runs `launchctl bootstrap` only when the checklist has no `FAIL` and `check-policy` passed. Otherwise it prints
   the next steps: one `ingest` line per missing secret.

Exit status: `0` = installed and the daemon was started; `3` = installed but not started yet (fill the policy and
ingest the secrets, then run it again); `1` = a check failed (the daemon stays stopped); `2` = usage error.
`--dry-run` prints the actions without changing anything.

## policy.json

The first run installs this template. Every `<…>` placeholder fails validation, so the daemon cannot start until
you replace all of them. Edit the file with `sudo` and keep it `root:wheel 0644`; the installer resets that on every
run. Add one `cloudflare` entry per environment, with names of 1–16 characters from `a-z 0-9 -`. Leave
`cloudflare` out if there is none. Optional keys: `gh.allowedOwners` (default `[org]`) and `maxPendingApprovals`
(default 3). See `parsePolicy` in `src/policy.ts` for the rules.

<!-- policy-template:begin -->
```json
{
  "admins": ["<slack-user-id>"],
  "gh": {
    "org": "<github-org>",
    "accounts": {
      "member": { "login": "<member-login>", "class": "member" },
      "org-admin": { "login": "<org-admin-login>", "class": "org-admin" }
    },
    "restWriteAllowlist": []
  },
  "cloudflare": {
    "<env>": {
      "accountId": "<32-hex-account-id>",
      "zones": { "<zone-name>": "<32-hex-zone-id>" },
      "permissionGroups": { "read": ["<permission-group-id>"], "edit": ["<permission-group-id>"] },
      "defaultTtl": "1h",
      "maxTtl": "71h",
      "ipCondition": false
    }
  },
  "approvalTimeout": "5m"
}
```
<!-- policy-template:end -->

## Secrets

Secrets enter through stdin only, never through arguments or the environment. Run the installer again once
`policy.json` is filled in. It then prints one line per missing secret, e.g.:

```sh
cd / && pbpaste | sudo -u _somadevops env -i PATH=/usr/bin:/bin HOME=/var/empty /usr/local/libexec/soma-devops/node \
  /usr/local/libexec/soma-devops/app/node_modules/@soma/devops-broker/dist/cli.js \
  ingest gh member --root /usr/local/var/soma-devops; pbcopy </dev/null
```

Copy the secret, then run its line. `cd /` matters because the broker user cannot read your working directory.
`env -i` keeps your environment (`NODE_OPTIONS` and the like) away from the broker's code, and `pbcopy </dev/null`
clears the clipboard. Then check with the same command using `check-policy` instead of `ingest …`, and run the
installer again to start the daemon.

## Upgrade

Build the new version (see "Before you start") and run `install.sh` again. The installer keeps `policy.json` and
every secret, swaps in the new code, and starts the daemon again only if the checklist is clean and `check-policy`
passes against the new code. Otherwise the daemon stays stopped and the output says why.

## Uninstall

```sh
sudo packages/devops-broker/install/uninstall.sh                         # daemon, plist and code; keeps data and logs
sudo packages/devops-broker/install/uninstall.sh --purge                 # also the data root (policy, secrets, state, ledger) and logs
sudo packages/devops-broker/install/uninstall.sh --purge --purge-user    # also the _somadevops user and soma-devops group
```

Before it deletes anything, `--purge` refuses while `state/cf-leases.json` has a lease in state `minting`,
`active`, `revoking` or `revoke_failed`. Its Cloudflare token may still be live, and once `state/` is gone nothing
can revoke it. Revoke those leases first (`cf_lease_revoke`, or let the running broker's sweep do it).
`--force-unrevoked` purges anyway; you then delete those tokens in Cloudflare by hand. `--purge` also copies
`state/ledger.jsonl` to `/usr/local/var/soma-devops-archive/ledger-<UTC time>.jsonl` (root-only, 0600 in a 0700
directory) before it deletes the data. `--purge-user` requires `--purge`. Otherwise the broker's files would outlive
the uid that owns them, and a later account given that uid would own the secrets.

## Tests

`src/install.test.ts` runs both scripts in test mode: `SOMA_DEVOPS_INSTALL_TEST=1` plus `--prefix <tmp>`. Every
target goes under the prefix, but the plist keeps the real paths. Each test installs from its own copy of the
checkout, with fake release archives and a `pins.txt` that pins them, and a fake bot user whose uid differs from the
checkout owner's. Shims in `src/__fixtures__/install-shims/` stand in for `dscl`, `dseditgroup`, `launchctl`, `chown`,
`sudo`, `otool` and `curl`, and each one records its arguments. Test mode refuses to run as root, and it refuses any
of those tools that resolves to a system directory. Outside test mode both scripts reset `PATH` to
`/usr/bin:/bin:/usr/sbin:/sbin`.

A test without root cannot give a file another owner. The test hooks below make each checklist rule fire anyway:

- `SHIM_CHOWN_TAMPER` makes the `chown` shim change modes in the staged code after the installer has set them.
- `SHIM_SUDO_REFUSE` makes the `sudo` shim refuse one command.
- `SOMA_DEVOPS_INSTALL_TEST_CODE_UID` sets the owner the code tree is held to. `install.sh` reads it only in test
  mode.

The ACL tests set real ACLs (`chmod +a "user:nobody allow …"`), which APFS supports.

---
name: chore-open-source
description: "Use when a repository is about to go public, or already is, and private traces — host names, other companies, personal paths, secrets — must leave its files, history, PR text, releases and clones. Triggers: 'chore-open-source', '오픈소스 청소', '오픈소스 공개 준비', 'clean before open-sourcing'. Not for branch or PR hygiene (chore)."
---

# chore-open-source — publish nothing private, prove it, keep every clone working

**One line:** inventory everything a stranger can read, fix the tree by normal PRs, gate it with the shared
pattern list, rewrite the history only when it carries a hit, swap it in with the owner's approval, then move
every clone to the new history.

| # | Phase | Tool | Output / gate | Owner approval |
|---|---|---|---|---|
| 0 | Intake | `gh repo view` | visibility, siblings sharing the list, who force-pushes | — |
| 1 | Recon | `$ENGINE/recon.py` | `W/recon/<repo>.md` (local only); clean → skip to 3 | — |
| 2 | Rules + tip cleanup | PRs | current tree clean, merged | review as usual |
| 3 | Shared gate | PR + secret | sanitize run green on the default branch | — |
| 4 | Rewrite | `$ENGINE/rewrite.sh` | `verify.txt`: 0 hits, `scan: clean`; review branch | — |
| 5 | Swap | `$ENGINE/swap.sh` | remote == rewritten repo | **yes** (force push) |
| 6 | Finalize | `$ENGINE/finalize.sh` | shared secret complete, gate rerun green | yes if it widens the list |
| 7 | After | `$ENGINE/find-clones.sh`, `$ENGINE/migrate-clone.py` | every clone clean | forks, Support: **owner decides** |
| 8 | Going public | checklist below | `gh repo edit --visibility public` | **yes** |

## Args

`OWNER/REPO` — the repository to clean (required; there is no default target). Several repositories that share
one pattern list are cleaned one at a time and finalized together (phase 6).

Read the rules, then run the phases in order. Each phase ends with evidence in the report (counts, file
paths, run URLs — never a matched value).

Paths: ENGINE = `$CLAUDE_PLUGIN_ROOT/skills/chore-open-source/scripts`; `$CLAUDE_PLUGIN_ROOT` is two
directories above this skill's base directory (`…/skills/chore-open-source` → `…`). Shells do not set it and
shell state does not carry over, so start every call with
`export ENGINE=<absolute path> CHOS_WORK=<W>`. W = a new folder in the session's working directory for this
run: `W/config/` holds the rules, `W/out/<repo>/` the rewrite, `W/recon/` the inventory. Write the engine
calls as bash scripts or single commands — zsh does not split `$list` into words and macOS bash 3.2 has no
`mapfile`; both silently produced wrong counts in the first run.

## Rules

1. **Never write a matched value anywhere public** — not in a PR or issue body, commit message, release note,
   chat message or test name. Say what class it is ("a machine name", "another company's domain"). The values
   live only in `W/` and in Actions secrets; `recon.md` is local only.
2. **No exception lists.** A published hit is fixed by rewriting the history, never by listing the commit as a
   known leak. `scripts/sanitize-known-leaks.txt` stays header-only.
3. **Credentials first.** A leaked token, key or password is revoked or rotated before anything else; a
   rewrite does not un-leak it.
4. **Destructive steps wait for the owner** in this conversation: swap (force push of every branch and tag),
   making the repo public, changing forks, contacting GitHub Support, rewriting someone else's clone. Ask
   with a recommended option; never infer approval from an earlier, different approval.
5. **Media is the owner's call.** OCR finds names in screenshots and recordings; propose repaint or removal,
   do it only if the owner wants it (an owner may accept what a recording shows).
6. **Keep behavior.** Tip cleanup replaces names with neutral words ("a shared host", "the owner's Mac",
   `example.com`, synthetic ids) and keeps tests green; a default that named a private resource becomes empty
   or configurable.

## 0. Intake

`gh repo view OWNER/REPO --json visibility,isPrivate,licenseInfo,forkCount,defaultBranchRef`. Note which
repositories share the pattern list (the shared gate, phase 3) — they are finalized together. Note branch
protection on the default branch (force pushes must be allowed for the swap minute) and which workflows a
push to each branch or tag starts (deploys, releases, previews).

## 1. Recon (read-only)

Write `W/config/patterns.txt` (the forbidden list: one extended regex per line — the shared list plus anything
this repository adds) and optionally `W/config/repo-patterns.txt`, then
`python3 -I "$ENGINE/recon.py" OWNER/REPO --ocr`. It covers: every line any commit ever added (all branches,
tags, pull request refs), messages, author and committer lines, tags, ref names, path names; built-in leak
classes (home paths, non-example e-mail, private and CGNAT addresses, tailnet / `.internal` / `.local` hosts,
chat workspace ids, token shapes, private keys); media text by OCR; workflow hazards; and the GitHub side no
rewrite reaches — PR and issue bodies and comments, review and commit comments, release notes, release asset
contents, forks, secret and variable names.

Exit 3 = incomplete: a GitHub read, a release asset, an oversized blob or a media file was not read — media
needs `--ocr` (tesseract; ffmpeg for video, pdftotext + pdftoppm for PDFs). The report's `INCOMPLETE` section
names each. An incomplete recon proves nothing clean — fix the access or tool and rerun.

Read the whole report. A match judged harmless (a test fixture, a code identifier) goes into `W/config/allow.txt` as a regex so reruns show only what is left; the forbidden list is never filtered. The classes cannot know internal vocabulary: also grep for product code names,
customer, colleague and team names, internal repository and service names the owner gives you. Decide per
hit: rule (replace), path removal, media repaint (owner), credential rotation, or owner accepts.

- **Nothing private anywhere** → no rewrite (it would only change every commit id). Go to phase 3.
- **Hits** → phases 2–7. Hits only in GitHub text (PR, issue, release) are edited in place with `gh`, not by a
  rewrite.

## 2. Rules and tip cleanup

Fix the current tree first, through normal reviewed PRs, so the rewritten tip equals the current default
branch except the gate list and docs. Then write the rewrite rules in `W/config/`:

- `replace.txt` — filter-repo rules: `literal==>replacement`, `regex:PATTERN==>replacement`; applied to file
  contents, commit and tag messages, and (via `filename-callback.py`) path names. Start from
  [templates/replace.txt.example](templates/replace.txt.example).
- `mailmap` — `New Name <new@mail> <old@mail>` for author lines that carry a host name or another company.
- `blob-map.txt` — `<old blob id> <file with new bytes>` for media the owner wants repainted.
- `filter-args` — extra filter-repo arguments, one per line (`--path`, `--invert-paths` to drop a file).
- `post-rewrite.sh` — optional executable run in a worktree of the rewritten tip (docs that describe the gate).
- `sanitize-scan.sh` — the **trusted** gate script (the canonical copy from phase 3). The engine never runs
  the repository's own copy: anyone who can push could change it, and the engine runs with your credentials.

## 3. Shared gate

One gate for every repository that shares the list: `scripts/sanitize-scan.sh` is the same file everywhere
(canonical copy: `scripts/sanitize-scan.sh` in 2lab-ai/soma-work; fix it in every copy together), a workflow on
`push` and `pull_request` to the default branch with `fetch-depth: 0`, read-only `permissions`, a same-repo
guard before any secret reaches a job, secrets `SANITIZE_PATTERNS_SHARED` (shared, required) and
`SANITIZE_PATTERNS` (this repository only, optional), and a header-only `scripts/sanitize-known-leaks.txt`.
The shared secret may only hold patterns the current history passes; patterns that the rewrite makes
passable join in phase 6. Set secrets with `printf '%s' "$value" | gh secret set NAME -R OWNER/REPO` — the value
never on a command line or in output.

## 4. Rewrite (nothing is pushed)

`"$ENGINE/rewrite.sh" OWNER/REPO` mirrors the remote, rewrites every branch and tag with the rules, adds the
list-emptying commit and the `post-rewrite.sh` commit, and writes `W/out/<repo>/verify.txt`; it exits 1 unless
the rewrite is clean. Require: commit counts identical on every ref, tip-tree differences only the gate list
and docs, pattern hits 0 in messages, authors, tags, ref names, paths and contents, and `scan: clean`. Publish the top commit as a review branch
for the owner: `git -C W/out/<repo>/new.git push https://github.com/OWNER/REPO.git refs/post/main:refs/heads/main-rewritten`.
Reruns are deterministic (same remote state → same ids). Optional proof against the real secrets nobody can
read back: [templates/rewrite-verify.yml](templates/rewrite-verify.yml) on a throwaway branch, run by a
self-hosted runner that can read W; delete the branch right after.

## 5. Swap (owner approval)

`SWAP_PAUSE="<workflow files>" "$ENGINE/swap.sh" OWNER/REPO`. It re-checks the remote against the snapshot and
rewrites again (up to 5 times) when someone pushed meanwhile — other sessions keep pushing to active
branches; pushes all branches and tags atomically with a lease per ref (a ref that moved fails the whole push,
nothing changes); pushes the top commit; verifies the remote equals the rewritten repo; deletes the review
branch. It pushes nothing unless `verify.txt` is clean (`SWAP_ALLOW_UNSCANNED=1` accepts a skipped scan), and
after the atomic push it marks the run so a rerun resumes instead of rewriting the already-rewritten remote —
whose commit map would no longer lead back to the original history. `SWAP_PAUSE` needs `actions:write`; a bot App token usually gets HTTP 403 — leave it empty only when the
pushes start nothing harmful (GitHub creates no push event for a push carrying more than three tags; a push
to the default branch builds a preview as on every merge). Deploy branches with a deploy workflow must be
paused by someone who can.

## 6. Finalize

After every repository sharing the list has swapped: `"$ENGINE/finalize.sh" OWNER/REPO...` stores
`W/config/patterns.txt` as each one's `SANITIZE_PATTERNS_SHARED`, then re-runs the sanitize run of the
rewritten tip (not merely the latest run) and waits for it; it exits 1 unless every one succeeds. Quote
`sanitize-scan: clean` and the run URL; check CI on the new tip too.

## 7. After the swap

- **Clones:** `"$ENGINE/find-clones.sh" OWNER/REPO [roots]` lists every clone and its state;
  `python3 -I "$ENGINE/migrate-clone.py" OWNER/REPO <clone> --plan`, then `--apply` (backup first; worktree
  edits kept with their staged/unstaged split, or the worktree put back exactly as it was; detached HEADs and
  shallow clones handled; local-only branches rebuilt with the same rules; refuses rather than guesses). Another session's or person's clone: only with the owner's approval. A folder the owner keeps
  as a deliberate backup of the old history is left alone.
- **Forks** keep the old history; only the fork owner can force-sync or delete them. Ask.
- **GitHub Support** removes pull request refs and cached commit pages. Ask; if the owner wants it, give
  owner/repo, the number of affected pull requests and the first changed commits
  (`W/out/<repo>/new.git/filter-repo/first-changed-commits`). It is the owner's request to file.
- Collaborators rebase (never merge) branches from before the swap; one merge brings the old history back.

## 8. Going public (private repositories)

Before `gh repo edit OWNER/REPO --visibility public --accept-visibility-change-consequences` (owner approval):
LICENSE and the package metadata license field; README without internal links or hosts; SECURITY.md and
private vulnerability reporting; CONTRIBUTING; third-party notices for bundled code; `.gitleaks.toml` and a
gitleaks job; secret scanning with push protection; Dependabot alerts; Actions — approval for outside
contributors' runs, no self-hosted runner on a job a fork pull request triggers, read-only default workflow
token, no `pull_request_target` that checks out the head; branch protection on the default branch; no internal
package registry or deploy config in the tree; release notes and assets checked (recon covers them).

## Report

Per phase: recon counts by class (no values), the rules' shape (how many rules, which classes), PR links,
`verify.txt`, swap output (refs matched), gate run URL with `sanitize-scan: clean`, clone check totals, and
what the owner chose for forks, Support and visibility.

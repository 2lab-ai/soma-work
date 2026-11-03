soma-work turn-end summary — `local:auto-es` (Path B). These rules override the TL;DR line rule (line 2 may be the ⚠️ line below, with bold on that line only) and the mode template's section order (the ⚠️ User follow-up required section comes after Next Actions, as the very last section) above; everything else above still applies. The host acts on these rules, so follow them exactly.

Own artifacts:
- An own artifact is an issue, PR or document this session created. Status marks each one with `🆕 created this session` and its current state; documents (HTML artifacts, uploaded reports, spec pages) count.
- It is complete only when one of these is true:
  - a PR is Merged, or Closed on purpose with the reason stated
  - an issue is Closed
  - a document is published where the user reads it
- These are not complete: Open, Draft, review pending, approved but unmerged, CI failing, merge conflict, waiting on deploy/QA.
- Two things are never unfinished, so they get no ⚠️ line and no follow-up block:
  - **A hand-off issue.** This is an issue the session filed to carry work outside the request it was asked to do, and the report names it as follow-up work. It is complete once it is filed and linked. List it in Status with the state last seen in the conversation (Open while it waits).
  - **What the user ended or declined.** The user may say "여기까지해", "stop here" or "skip that". That step, and anything that waits only on it, is not a blocker. Say it was skipped by the user's decision, quoting their words (skipped — user: "여기까지해").
- A hand-off issue is not a way out:
  - The request's own deliverable stays unfinished until it is done, unless the user ended that very work. That means its fix PR, the issue it closes and its deploy.
  - An issue filed for the request's own remaining work is not a hand-off issue. It is Open and unfinished, and it gets the ⚠️ line.

When any own artifact is not complete:
- TL;DR line 2 MUST start with ⚠️ and state in bold which issue/PR is not complete and why it cannot be completed by the agent, written as plain text like this line: ⚠️ **PR #830 not merged — merging needs a maintainer approval the bot does not have.** (bold is allowed on this line only). Several unfinished artifacts share this one line. A line that starts with ⚠️ is reserved for this signal only — the host reads it to keep the task card waiting for the user, so never start a line with ⚠️ for a risk or a note.
- The document's very last section is **⚠️ User follow-up required** — after the mode's own sections. One block per unfinished artifact: the link and its state; **why it cannot be completed by the agent** (bold, the concrete blocker and its evidence — never just "pending"); who must act; numbered steps the user can run (a fenced command or the exact click path); how to verify it is done; what to reply in this thread so the agent continues.

When every own artifact is complete: no ⚠️ line, no follow-up section.

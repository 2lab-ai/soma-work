# Batch approval inbox: research and recommended design

Citations [n] point to the source list at the end. "Unverified" means no primary source confirmed it.

## 1. Bulk approval in real products

| Product | What it does | Deny, undo, expiry |
|---|---|---|
| GitHub Actions pending deployments | One dialog per run with a checkbox for each waiting environment, an optional comment, then "Approve and deploy" or "Reject". Bypassing rules needs a comment and a button reading "I understand the consequences, start deploying" [1] | Self-approval can be blocked [2]. No per-review expiry; the run is cancelled at 35 days, waiting included [3] |
| C1 (ConductorOne) | Tick tasks, then pick the action from a menu. The comment you enter is posted on every affected task. An Insights tab shows risk level and how many others have the access [4][5] | Reassigning needs a reason. In access reviews, decisions can be changed until you submit [5] |
| Okta Access Requests | Approve in the web app, Slack, Teams or email. Stalled tasks can be escalated [6] | No bulk approval found (absence unverified) |
| Opal | Group and filter so "similar grants get decided together". AI marks low-risk grants, shows its signals, and clears them in one click [7] | Scripted auto-approval (4 hours or less, non-production). If unsure, the request goes to a human [8] |
| Teleport | Approve or deny with `--reason` [9]. A threshold filter can require a review reason [10] | Pending requests expire after 1 hour by default [10]. On conflicting automatic reviews, DENIED wins [11] |
| AWS TEAM | A request carries a duration, a ticket ID and a justification. Tick it, then Approve or Reject; a comment may be required [12][13] | Admin-set "Request expiry timeout". Auditors see justifications [12] |
| HCP Terraform, Spinnaker, Argo | One item at a time: "Confirm & Apply" or "Discard Plan" (Terraform) [14]. Spinnaker's Manual Judgment shows instructions and optional choices [15]. Argo's `suspend: {}` waits forever [16] | No bulk action |
| Jira | Bulk change of up to 1,000 items, with a confirmation screen before you Acknowledge [17] | No undo documented |
| ServiceNow | "My Approvals" list: select records, then Approve or Reject (community post) [18] | By default the portal rejects without asking for a reason (community post) [19] |
| Gmail | `x` select, `e` archive, `z` undo, `j`/`k` move [20]. Selecting every match warns "This action will affect all N conversations" (third-party source) [21] | Undo Send delay of 5–30 s, 5 s by default [22] |
| Google Workspace investigation tool | A bulk action on more than 300 items needs a second admin [23] | Expires after 72 hours |
| Linear inbox, GitHub notifications | Linear: `J`/`K`, `U` read, `H` snooze [24]. GitHub: multi-select triage, `E` done, `Shift+I`/`Shift+U` read/unread [25][26] | GitHub keeps items marked Done for 3 months |

**What they have in common**
- No approval tool documents merging identical requests; alerting tools do (section 2).
- Safe confirm steps show the scope first: Jira's review screen, Gmail's count, GitHub's acknowledgement.
- Deny reasons are mostly optional. Expiry is long or admin-set; Teleport's 1 hour is the exception.
- Undo is rare: Gmail's delay and C1's submit step.

## 2. Reducing approval fatigue

- Anthropic: constant approve clicks cause "approval fatigue", and users "might not pay close attention". Sandboxing cut its prompts by 84% [27].
- Microsoft: "about 1% of users will accept a simple approval request on the first try". In its studies, number matching plus context (location, app) "eliminated MFA fatigue attacks" [28]. So show context and require a deliberate action.
- AHRQ: "Tier alerts according to severity" and "Make only high-level (severe) alerts interruptive" [29].
- Auto-approve low-risk requests by policy, as in Opal [8], Teleport [11] and on-call rules [30]. Caution: anyone who can join the on-call rota can then grant themselves access [31].
- Merge duplicates: Alertmanager sends similar alerts as one notification (`group_wait` 30 s, `repeat_interval` 4 h), with silences [32][33]. AWS archive rules hide expected findings [34].
- Mozilla: 99% of permission prompts go unaccepted. After a user action, 24% to 56% are accepted [35].

## 3. Notifying a signed-in admin

- **WebSocket alone is unreliable.** Chrome heavily throttles timers on tabs hidden for more than 5 minutes [36], and Memory Saver deactivates idle tabs [37]. Add Web Push as a backup.
- **Permission.** Firefox 72+ denies requests that don't follow a user action [35]. Safari push needs one too [38]. Never ask again after a denial [39]. On mobile, use the service worker's `showNotification()` instead of the constructor [40].
- **Options** [40][41]:
  - `requireInteraction` (stay until dismissed): Chrome and Edge. Firefox only on Windows. Not Safari.
  - `renotify` (alert again on replace): Chrome and Edge only.
  - `tag` (replace instead of stack): has "no effect" in Safari, so notifications may pile up there (unverified).
- **macOS.** "Google Chrome Helper (Alerts)" must be allowed in System Settings, and Focus modes hide notifications [42].
- **Badges.**
  - Show the count in the page title, for example "(3) Approvals".
  - A favicon badge needs a canvas workaround, as there is no standard tab-badge API (unverified) [43].
  - `navigator.setAppBadge()` works only in installed apps: Chrome 81+, Safari 17 on macOS Sonoma, iOS 16.4 Home Screen apps. Not Firefox [43][44].
- **Sound.** Audio needs a prior user action [45]. Unlock it on the click that turns alerts on.
- **Closed tab.** Web Push works in Safari 16 and later. Every push must show a notification [38]. On iOS, push works only for apps added to the Home Screen [46].
- **Visibility.** Pick the channel based on `document.visibilityState` [47].

## 4. Recommended design

**Layout.** One list, sorted by risk (highest first), then by age (oldest first). Filter chips for kind, session and risk. A detail pane shows parameters, the agent's reason and history.

**One-line summary.** Format: `[risk] Verb · object · scope · as whom · duration — requester · age`. Show changes as before → after [28]:
- `LOW Issue Cloudflare DNS key · read-only · dev2 · 10 min from approval — agent #482 · 4m`
- `HIGH Set org role · user Y: admin → member — agent #490 · 1h`

**Risk tiers** (set by policy, not by the agent):
- **Low:** read-only, short-lived, non-production. Auto-approve by policy and list in an "Auto-approved" tab [8][11].
- **Medium:** non-production writes, running skills.
- **High:** role changes, admitting users, granting MCP tools, deleting messages, production.

**Grouping.** Group by kind; group by session as an option. Merge requests with the same kind, parameters and requester into one row marked "×N"; one decision answers all of them.

**Selection.** Nothing is selected on load. A group checkbox or `Shift+A` selects only low- and medium-risk rows. High-risk rows must be ticked one at a time.

**Confirm sheet.**
- A headline count, for example "Approve 6: 3 keys (max 10 min), 2 PR reviews, 1 role change".
- One line per effect, with high-risk items in their own section.
- An optional comment applied to all items, and a button showing the count, for example "Approve 6".
- With any high-risk item, the admin must tick "I reviewed 1 high-risk change" [1].
- The server checks again on submit and drops items that changed.

**Deny.** Press `d`, then pick a reason ("not needed", "too broad", "wrong env") or type one. A reason is required for bulk and high-risk denials. The reason goes back to the agent [4][19].

**Undo.** Hold approvals 5 s, with an Undo toast [22].

**Shortcuts** [20][26]: `j`/`k` move, `x` select, `Enter` details, `a` approve (opens the sheet), `d` deny, `z` undo, `Shift+A` select safe rows, `?` help.

**Notification rules.**
- **Tab visible:** in-page toast. No OS notification, no sound.
- **Tab hidden or closed:** notify on the first request at once. Fold later requests into the same notification (`tag: "approvals"`) until 60 s of quiet, for example "5 pending (1 high)".
- **High-risk:** always notify at once, with `renotify` and `requireInteraction` where supported.
- **Badges:** keep the title, favicon and app badge in sync. Clear them only when the queue is empty.
- **Sound:** off by default. When on, only for high-risk requests.
- **Permission:** ask from a "Turn on desktop alerts" button, never on page load [35].
- **Fallback (my suggestion, not sourced):** one Slack digest message, edited in place, sent if the dashboard isn't opened within 15 minutes.

**Age, not countdown.**
- Show relative age ("4m", "2h"), with the exact time on hover.
- Amber after 1 hour, red after 8 hours.
- Show whether the agent session is still waiting.
- Expire silently on the server, for example after 7 days (compare 72 hours and 35 days [23][3]).
- Credential lifetimes start at approval.

## Sources
1. https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments
2. https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
3. https://docs.github.com/en/actions/reference/limits
4. https://www.c1.ai/docs/product/how-to/access-change-tasks
5. https://www.c1.ai/docs/product/how-to/review-tasks
6. https://help.okta.com/oie/en-us/content/topics/identity-governance/access-requests/ar-overview.htm
7. https://www.opal.dev/blog/ai-guided-access-reviews
8. https://docs.opal.dev/docs/requestreview-examples
9. https://goteleport.com/docs/identity-governance/access-requests/oss-role-requests/
10. https://goteleport.com/docs/identity-governance/access-requests/access-request-configuration/
11. https://goteleport.com/docs/reference/access-controls/access-monitoring-rules/
12. https://aws-samples.github.io/iam-identity-center-team/docs/guides/admin.html
13. https://aws-samples.github.io/iam-identity-center-team/docs/guides/approver.html
14. https://developer.hashicorp.com/terraform/cloud-docs/run/ui
15. https://blog.spinnaker.io/can-i-push-that-building-safer-low-risk-deployments-with-spinnaker-a27290847ac4
16. https://github.com/argoproj/argo-workflows/blob/main/examples/suspend-template.yaml
17. https://support.atlassian.com/jira-software-cloud/docs/edit-multiple-issues/
18. https://www.servicenow.com/community/itsm-forum/ui-action-for-bulk-approval-reject-in-approval-table/td-p/659712
19. https://www.servicenow.com/community/developer-forum/redesigned-my-approvals-page-with-bulk-approve-reject-amp-send/td-p/3407264
20. https://support.google.com/mail/answer/6594
21. https://nerdtechy.com/how-to-delete-all-promotional-social-emails-gmail-at-once
22. https://blog.google/products-and-platforms/products/gmail/how-to-unsend-email-gmail/
23. https://knowledge.workspace.google.com/admin/security/require-reviewers-for-bulk-actions
24. https://linear.app/docs/inbox
25. https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox
26. https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts
27. https://www.anthropic.com/engineering/claude-code-sandboxing
28. https://techcommunity.microsoft.com/blog/microsoft-entra-blog/defend-your-users-from-mfa-fatigue-attacks/2365677
29. https://psnet.ahrq.gov/primer/alert-fatigue
30. https://goteleport.com/docs/identity-governance/access-requests/plugins/pagerduty/
31. https://docs.p0.dev/integrations/approval-integrations/pagerduty
32. https://prometheus.io/docs/alerting/latest/alertmanager/
33. https://prometheus.io/docs/alerting/latest/configuration/
34. https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-archive-rules.html
35. https://hacks.mozilla.org/2019/11/upcoming-notification-permission-changes-in-firefox-72/
36. https://developer.chrome.com/blog/timer-throttling-in-chrome-88
37. https://support.google.com/chrome/answer/12929150
38. https://webkit.org/blog/12945/meet-web-push/
39. https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
40. https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification
41. https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json
42. https://pushpad.xyz/blog/google-chrome-helper-alerts
43. https://developer.mozilla.org/en-US/docs/Web/API/Badging_API
44. https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json
45. https://developer.chrome.com/blog/autoplay
46. https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
47. https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API

Not covered: Sym and Indent documentation could not be reached. Indent's on-call auto-approval is known only from a partner blog: https://www.twingate.com/blog/other/supporting-on-demand-access-with-indent

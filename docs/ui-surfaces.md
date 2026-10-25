# UI surfaces configuration

Control what the user-facing surfaces show, and how each field renders, with the top-level `ui` key in `config.json`. The schema and defaults live in `packages/slack/src/surface-config.ts` (exported as `@soma/slack/surface-config`).

A bad `ui` value never breaks boot: structurally invalid input degrades to the built-in defaults with a warning in the logs.

On first boot, if `config.json` has no `ui` key, the full default composition is seeded into the file automatically — edit the settings right there. An existing `ui` key (even an empty `{}`) is never overwritten, so your edits are safe across restarts. `config.default.json` in the repo root remains the pristine reference copy of the defaults.

Because the seed is a copy, a later change to the built-in defaults does not reach a `config.json` that already has `ui`. A field added to a default therefore ships with a one-time boot migration. The first one (2026-10-16) adds `dashboardLink` to the thread header: on the first boot after the upgrade, every `ui.threadheader` lines array (the base `lines` and each `themes.<name>.lines`) that does not mention `dashboardLink` at all gets `{ "field": "dashboardLink", "show": true }` — right before the first `links`/`linkhistory` field, or else as its own context line after the title line. An array that mentions it in any form (`"show": false` included) is left alone, and so is an array with no field the thread header knows (it falls back to the base lines or the built-in default anyway). Other keys, `${VAR}` placeholders included, keep their values; the file is rewritten with 2-space indentation. A marker `.threadheader-dashboard-link-once-2026-10-16.json` in the data directory makes this run once per data directory, so anything you change afterwards (removing the link included) stays. The boot log reports the outcome: `migrated`, `already-present`, `no-ui`, `marker-present`, `contended` (another program kept rewriting `config.json` during the update — nothing was written), or `failed`. The last two write no marker and are retried on the next boot.

## Surfaces

| Surface | Where it appears |
|---|---|
| `threadheader` | Slack thread header message (title, owner, model, context bar, links, status) |
| `turnend` | Turn-end summary card posted when a turn finishes |
| `dashboardheader` | Card header on the dashboard kanban board (`/dashboard`) |

## Shape

Each surface takes `lines` — an ordered list of line objects, each with a list of `fields`. Lines may also be written as bare arrays of field objects.

```json
{
  "ui": {
    "threadheader": {
      "lines": [
        { "block": "header", "fields": [{ "field": "title", "truncate": 150 }] },
        {
          "block": "context",
          "separator": " | ",
          "fields": [
            { "field": "owner", "format": "name" },
            { "field": "model", "show": false }
          ]
        }
      ],
      "themes": {
        "compact": { "lines": [{ "fields": [{ "field": "title" }] }] }
      }
    }
  }
}
```

Line options:

- `block` — Slack block type for the line: `header`, `section`, `context` or `divider`. Default `context`. Ignored by the dashboard (HTML) surface.
- `separator` — joiner between rendered field values in the line.
- `fields` — ordered field entries (see below).

## Field options

| Option | Type | What it does |
|---|---|---|
| `field` | string | Registry key (required). Unknown fields are skipped with a warning — never invented. |
| `show` | boolean | Hide the field without deleting the entry. Default `true`. |
| `label` | string | Text label prefix, for example `"Ctx"`. Empty string removes the default label. |
| `prefixEmoji` | string | Explicit emoji prefix (shortcode or unicode). |
| `style` | object | mrkdwn style: `bold`, `italic`, `code`, `strike`. Slack supports nothing else. |
| `truncate` | number | Max characters for the rendered value. Renderer hard caps still apply. |
| `color` | string | Colour hint. Honoured only where Slack supports colour (attachment colour bars). Ignored with a one-time warning for inline mrkdwn — Slack has no text colour. |
| `format` | string | Field-specific variant, for example owner: `mention`, `name`, `both`. |
| `max` | number | Max entries for list-like fields (links per type, tools shown, tasks). |
| `bar` | object | Gauge-bar styling for bar fields: `width`, `filledChar`, `emptyChar`. |
| `decimals` | number | Decimal places for percentage values. |

`name` is accepted as an alias for `{ "field": "owner", "format": "name" }`.

## Resolution order

For each surface and theme, the first non-empty `lines` wins:

1. user `ui.<surface>.themes.<theme>.lines`
2. user `ui.<surface>.lines` (applies to all themes)
3. built-in theme preset
4. built-in default lines

Themes: `default`, `compact`, `minimal`.

## Field registries

Only these fields exist per surface — anything else warns and is skipped.

- `threadheader`: `title`, `owner`, `workflow`, `model`, `contextwindow`, `links`, `linkhistory`, `dashboardLink`, `status`, `separator`
- `turnend`: `status`, `title`, `threadlink`, `errorbody`, `persona`, `model`, `effort`, `startedat`, `contextwindow`, `duration`, `fivehour`, `sevenday`, `toolstats`, `separator`
- `dashboardheader`: `title`, `owner`, `workflow`, `model`, `links`, `mergestats`, `tokens`, `cost`, `contextwindow`, `tasks`, `status`, `separator`

Field names match case-insensitively. `dashboardLink` renders `📋 작업 로그`, the deep link to the session's card on the owner's dashboard (`/dashboard/<ownerId>?session=<sessionKey>`). When the conversation viewer (the web server that serves the dashboard) is not listening there is no URL and the field renders nothing. A new session also posts the same link into a thread a user started; that post is skipped in the same case. To hide the header link, set `{ "field": "dashboardLink", "show": false }` or remove that entry from each theme's lines in `config.json` — this controls the header field only.

A field that does not appear in the resolved lines is hidden. The dashboard (Agent inbox) card is collapsed by default: its face shows the title, a one-line summary, the current task, the subagent pulse, `tokens` / `cost`, the status and the `tasks` / `contextwindow` counts. The expanded card (spec 13, `.prd/13-dashboard-three-surfaces-spec.md`) keeps `model` (its model · effort switch), `links` (short refs and Slack) and `tasks` (the task window) under their gates, and never repeats the face's numbers. `owner`, `workflow`, `status` (last activity) and `mergestats` have no card reader any more: those values live in the session panel's 세션 정보, which is the complete record and ignores these gates — the fields stay valid in the registry, they just change nothing on the card. In the expanded card the pending-question block and the action buttons are always shown regardless of configuration.

## Slack constraints

The renderers enforce Slack's hard limits regardless of configuration:

- mrkdwn has no text colour — `color` only affects attachment colour bars
- `header` blocks: plain text, 150 characters max
- `context` blocks: 10 elements max
- 50 blocks per message

## config.default.json

`config.default.json` at the repo root is a generated, test-locked copy of the built-in defaults (`{ "ui": DEFAULT_UI_SURFACES }`). Do not edit it — inspect it, then copy the sections you want to change into `config.json` under `ui`. Regenerate after changing the defaults in code:

```bash
node -e "const m=require('./packages/slack/dist/surface-config.js'); console.log(JSON.stringify({ui:m.DEFAULT_UI_SURFACES},null,2))" > config.default.json
```

## Worked example

"Show the title as a header; below it the owner's name (not a mention) and the context bar; hide the model."

```json
{
  "ui": {
    "threadheader": {
      "lines": [
        { "block": "header", "fields": [{ "field": "title" }] },
        {
          "block": "context",
          "fields": [
            { "field": "name" },
            { "field": "model", "show": false },
            { "field": "contextwindow", "bar": { "width": 5 }, "decimals": 1 }
          ]
        }
      ]
    }
  }
}
```

Restart the service after editing `config.json` — the `ui` value is installed once at boot (`src/index.ts`).

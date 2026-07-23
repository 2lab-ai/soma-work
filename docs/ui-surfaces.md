# UI surfaces configuration

Control what the user-facing surfaces show, and how each field renders, with the top-level `ui` key in `config.json`. The schema and defaults live in `packages/slack/src/surface-config.ts` (exported as `@soma/slack/surface-config`).

A bad `ui` value never breaks boot: structurally invalid input degrades to the built-in defaults with a warning in the logs.

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

- `threadheader`: `title`, `owner`, `workflow`, `model`, `contextwindow`, `links`, `linkhistory`, `status`, `separator`
- `turnend`: `status`, `title`, `threadlink`, `errorbody`, `persona`, `model`, `effort`, `startedat`, `contextwindow`, `duration`, `fivehour`, `sevenday`, `toolstats`, `separator`
- `dashboardheader`: `title`, `owner`, `workflow`, `model`, `links`, `mergestats`, `tokens`, `cost`, `contextwindow`, `tasks`, `status`, `separator`

A field that does not appear in the resolved lines is hidden. On the dashboard card, the pending-question block and action buttons are always shown regardless of configuration.

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

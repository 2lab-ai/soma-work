# Attribution

The `dimensional-drawing` skill is vendored from the `dimensional-drawing`
skill published in
[`enesozturk/dimensional-drawing`](https://github.com/enesozturk/dimensional-drawing)
by Enes Ozturk.

Upstream commit referenced: `5c457437c8c83524308aad3b7443e81adcc13153`
(2026-10-23). The upstream repository is licensed under the **MIT License**
(Copyright (c) 2026 Enes Ozturk) — a verbatim copy is kept at
[`enesozturk-dimensional-drawing-MIT.txt`](./enesozturk-dimensional-drawing-MIT.txt).

The drawing style follows Apple's public accessory dimensional drawings
(developer.apple.com/accessories/dimensional-drawings), as described by the
upstream author.

## Bundled files

- `SKILL.md` — upstream body verbatim, with the local changes below.
- `examples/card-sheet.html`, `examples/dialog-sheet.html` — verbatim.

Not bundled: the upstream `assets/` folder (README preview PNG, GIF and MP4,
about 18 MB). The two example HTML files render the same sheets.

## Local changes

- Frontmatter extended with EN/KO trigger keywords, `allowed-tools`,
  `version` and `license` fields.
- Added the attribution paragraph under the title.
- Added the `Delivery in soma-work` section (measure with the Playwright that
  ships with soma-work, render the PNG with the `html` skill renderer, publish
  with the `html` skill server, upload to Slack). It replaces the claude.ai
  Artifact step for this runtime.

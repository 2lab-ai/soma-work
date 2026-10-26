# Attribution

The `dimensional-drawing-motion` skill is vendored from the
`dimensional-drawing-motion` skill published in
[`enesozturk/dimensional-drawing`](https://github.com/enesozturk/dimensional-drawing)
by Enes Ozturk.

Upstream commit referenced: `5c457437c8c83524308aad3b7443e81adcc13153`
(2026-10-23). The upstream repository is licensed under the **MIT License**
(Copyright (c) 2026 Enes Ozturk) — a verbatim copy is kept at
[`enesozturk-dimensional-drawing-MIT.txt`](./enesozturk-dimensional-drawing-MIT.txt).

## Bundled files

- `SKILL.md` — upstream body verbatim, with the local changes below.
- `templates/scene-dialog.js`, `templates/base.css` — verbatim.
- `adapters/claude-motion.md` — verbatim (kept for claude.ai users).
- `adapters/headless/player.html`, `package.json`, `README.md` — verbatim.
- `adapters/headless/render.mjs` — verbatim except one local change below.

## Local changes

- Frontmatter extended with EN/KO trigger keywords, `allowed-tools`,
  `version` and `license` fields.
- Added the attribution paragraph under the title.
- Added the `Running in soma-work` section: the headless adapter is the path
  in this runtime, run in place from the plugin directory (Playwright resolves
  from the soma-work install), never `npm install` into the shared plugin
  directory.
- `adapters/headless/render.mjs`: the upstream renderer ignored the encoder's
  exit code, so a failed ffmpeg still printed `N frames → film.mp4` and exited
  0 with no file written. It now exits 1 with the ffmpeg exit code or signal.
  Covered by `__tests__/headless-render-exit.test.ts` (stub `playwright`, fake
  encoder). Worth sending upstream.

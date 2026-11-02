# Stageshow: how soma-work should use it

Research date: 2 November 2026. Source: [benjitaylor/skills](https://github.com/benjitaylor/skills) at `8020574`. Decision: use Stageshow in 2 ways. First, as a review lens for our own interface — its craft and framing rules found the defects listed below in the dashboard and in @2lab.ai/ui, fixed in @2lab.ai/ui 0.21.0 and the soma-work change that carries this note. Second, vendor it later as a `local:stageshow` skill, the same way we vendored the Emil Kowalski and dimensional-drawing skills, but only when someone asks the bot for product illustrations.

## What Stageshow is

The repository holds one skill, Stageshow. It helps an agent build faux product UI: a believable interface used as a marketing or docs illustration. The output is a still, a feature card, a bento grid or a short animated demo with a cursor. It is not a component library for a real app and it does not automate a browser.

The skill folder has 4 parts:

- `SKILL.md` and `references/` (about 1,400 lines): the rules for framing, the still frame (`craft.md`), motion (`motion.md`), verification and review
- `kit/`: a React and CSS kit — `Stage`, `Window`, `Phone`, motion parts such as `Roll`, `Count` and `Fly`, and small parts such as `Row`, `Bar` and `Icon`
- `examples/` and `teaching/`: 69 examples (about 40 of them marked "gold" as the quality bar) and bad and good pairs
- `scripts/`: `film.mjs` films a stage in headless Chrome into a contact sheet and flags framing faults; `layout.mjs`, `jumps.mjs` and `class-clash.mjs` check the rest

Install upstream with `npx skills add benjitaylor/skills --skill stageshow`. The folder is 3 MB and 358 files. It needs Node 20.19 or later, React 18, `lucide-react`, Vite and `playwright-core`.

## Licence

The source is MIT. Some assets are not: `assets/app-icons.ts` holds app icons from their own app bundles, and `kit/brands/` holds logos under SVGL (MIT), payment-icons (Apache 2.0), Cryptocurrency Icons (CC0) and the owners' brand terms. `NOTICE.md` and `kit/brands/SOURCES.md` record each one. A vendored copy must keep both files and the licence texts, as `src/local/skills/apple-design/LICENSES/` does.

## It runs on the bot's machine

We ran it on the bot host on 2 November 2026:

1. `npm ci` in the skill folder took under 2 seconds with a warm cache.
2. `npm run dev` fails on macOS without the optional `portless` package. Starting Vite directly works: `node node_modules/vite/bin/vite.js playground --config playground/vite.config.ts --port <port>`.
3. `CHROME_PATH=<Playwright's Chrome for Testing> node scripts/film.mjs "<url>/?capture=hero-demo" --still --out hero.png` filmed the gold hero in under 4 seconds.

So the full loop the skill expects — copy a gold example, edit it, film it, read the frames, fix — works in a bot session with no new system dependency.

## Option 1: a review lens for our own interface (done)

Most of `craft.md` is about real interface quality, not only illustration. We applied these rules to the dashboard and to @2lab.ai/ui:

- emoji are content, never icons: the rewind button used the ⏪ emoji, and the star buttons the ★ and ☆ text glyphs, next to vector icons
- no sparkle as generic AI decoration: every board column head, and the agent tree's title, drew a ✦ with no meaning
- say it once: a waiting card printed its question twice, an open card printed its links twice, and the settings page printed the same lock reason under all 26 rows
- real sizes, then scale (never 7px type): the ui.2lab.ai gallery drew every demo at 0.56, so 13px text became 7px
- no window floating whole on a plate with air on four sides: 13 gallery tiles filled less than 45% of their area, a small preview stranded at the top of an empty grey tile
- change only what changed: the board's running clock dropped its zero (23분 4초, then 23분 17초), so the card re-wrapped as it ticked

The same screenshot audit (light and dark, 1440, 820 and 390 wide) also found plain defects outside Stageshow's rules, fixed in the same change: the top bar's chips overlapping at 820px, EN and KO looking the same in dark, a sideways-clipped example tab row on 44 of 45 ui.2lab.ai pages, and 382 live controls inside gallery links. The rules worth keeping as a standing checklist for dashboard reviews are the "Faults that come back every round" list in `SKILL.md` and the sections Restraint, Spacing and alignment, and Icons and logos in `references/craft.md`.

## Option 2: vendor it as `local:stageshow` (when asked)

Vendor it when a user asks the bot for a product illustration, a feature card or a demo animation. Until then the 3 MB folder and its React toolchain add weight with no caller. When we do it:

1. Copy the whole `stageshow/` folder to `src/local/skills/stageshow/` without `node_modules`, with a `LICENSES/NOTICE.md` that names the upstream commit and keeps `NOTICE.md`, `kit/brands/SOURCES.md` and every licence file.
2. Add a "Delivery in soma-work" section, as `dimensional-drawing` has: copy the skill to a scratch folder, `npm ci`, start Vite directly on a free port (no `portless`), set `CHROME_PATH` to the Playwright Chrome the `html` skill already uses, film, read every frame, then upload the PNG contact sheet (or publish the page through the `html` skill's local web server) to the Slack thread.
3. Add a contract test in `src/local/skills/stageshow/__tests__/` that checks the front matter, the licence files and the delivery section, as `dimensional-drawing-skill.test.ts` does.
4. Route to it from `local:diagram` and `local:html` when the request is a product shot, not a chart or a document.

## What not to do

- Do not use the Stageshow kit inside the dashboard. The dashboard is server-rendered HTML with @2lab.ai/ui Web Components; the kit is React for illustrations.
- Do not install it per user with `npx skills add`. Bot sessions load skills from `src/local/skills`, so a per-user install never reaches the bot.
- Do not vendor it docs-only, as we did with Impeccable. Its value is the gold examples and `film.mjs`; the rules alone lose the self-check loop.

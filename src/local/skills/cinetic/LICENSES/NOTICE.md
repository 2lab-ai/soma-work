# Third-party notice

`cinetic` here is a loader for the upstream skill **cinetic** by Leonxlnx (https://github.com/Leonxlnx/cinetic),
released under the MIT License (`cinetic-MIT.txt`, copied from the upstream `LICENSE`).

- Pinned upstream commit: `f4bbfc844877891fe92279d47b7874fb44d485ae` (2026-11-07, after release v1.5.1).
- Nothing of the upstream skill is copied into this repository. `scripts/install.sh` clones it at that commit into
  `~/.cache/cinetic` (or `CINETIC_HOME`) and the agent reads the upstream `skills/cinetic/SKILL.md` from there.
- Local changes: none to the upstream content. This directory adds only the loader (`SKILL.md`, `scripts/install.sh`),
  the routing to `cinematic-film`, and this notice.

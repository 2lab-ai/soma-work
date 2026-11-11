---
name: cinetic
description: Make a motion film from code (launch film, update video, UI walkthrough, logo sting, social ad) with the upstream cinetic skill (Leonxlnx/cinetic, MIT), pinned and fetched on first use. Films cut from screen recordings go to cinematic-film. Triggers on "cinetic", "시네틱", "모션 그래픽", "업데이트 영상", "update video", "logo sting".
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
version: 1.0.0
license: MIT (upstream Leonxlnx/cinetic; see LICENSES/NOTICE.md)
---

# cinetic (pinned upstream)

cinetic is an agent skill that directs a short film from code: it writes a script a stranger understands, deals one
animation per line from a tested bank, builds the product's screens as live components, cuts to a licensed music
track and measures the result before it ships. It is maintained upstream at https://github.com/Leonxlnx/cinetic. This
skill does not copy it. It fetches the upstream skill at one pinned commit and hands the work to its own `SKILL.md`.

## Load it

Every Bash call is a fresh shell, so set the plugin root in each block.

```bash
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<base directory of this skill>/../..}"
CINETIC_ROOT="$(bash "$CLAUDE_PLUGIN_ROOT/skills/cinetic/scripts/install.sh")" || { echo "cinetic: install failed, stop here" >&2; exit 1; }
echo "$CINETIC_ROOT"
```

Then read `$CINETIC_ROOT/SKILL.md` and follow it from start to end. Its scripts run from that skill root (for example
`bash "$CINETIC_ROOT/scripts/new-film.sh" <film-dir> --template update`). The upstream rules win over anything here.

Requirements (checked by the upstream setup guide, `docs/setup.md` in the checkout): Node 22+, ffmpeg 6+ with libx264,
Python 3.11+ with numpy, scipy, soundfile, pyloudnorm, opencv-python and librosa, a headless Chromium, and earshot 0.4+
for the sound.

## Which film skill

| The film is | Use |
| --- | --- |
| Built from code and copy: a launch film, an update video, a logo sting, a social ad, motion design | **cinetic** (this skill) |
| Cut from real desktop screen recordings, made to look like a product ad (tilted plane, depth of field) | `cinematic-film`, the plane look |
| Real use on a phone: the real app recorded at a phone viewport, played inside an iPhone mockup with taps, keyboard and chapter captions | `cinematic-film`, the device look |
| A product demo from the real product, per display language, with README GIFs | `make-product-demo` (it uses `cinematic-film`) |

## Updating the pin

Read the upstream `CHANGELOG.md` between the pinned commit and the new one, try one film with
`CINETIC_PIN=<new sha>`, then change the default `PIN` in `scripts/install.sh` and the commit in
`LICENSES/NOTICE.md` in one pull request.

## License

cinetic is MIT-licensed by Leonxlnx (`LICENSES/cinetic-MIT.txt`). It renders with Remotion by default: Remotion's
license is free for individuals and companies of up to 3 people; larger companies need a Remotion company license.
Music and sound effects keep their own licenses; keep a CREDITS file next to every delivered film.

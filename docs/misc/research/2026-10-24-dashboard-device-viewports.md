# Dashboard device viewports: iPhone Duo, iPhone 18 Pro Max and Galaxy Z Fold8

Researched 24 October 2026 for the device-responsive dashboard (`src/conversation/dashboard.ts`).
The layout contract is in [`.prd/10-agent-inbox-board-spec.md`](../../../.prd/10-agent-inbox-board-spec.md) §5.

## Summary

The user asked for a layout fitted to three devices, and for the foldables in both postures:

- the new foldable iPhone, which the user called "폴드 듀오": it shipped as the iPhone Duo
- the latest iPhone Max, which is the iPhone 18 Pro Max
- the new wide Galaxy Fold, the "Fold 8 Wide": it shipped as the Galaxy Z Fold8; the tall model is the Fold8 Ultra

Both foldables are landscape by default when unfolded, at 951 by 543 and about 933 by 704 CSS px. The old dashboard
treated every width from 640px to 1023px as one tier and forced 3 board columns of at least 300px. That needs 964px, so the third
column was cut off on both unfolded screens.

## CSS viewports

Values are CSS px. "Usable" is what Safari gives the page after its own controls.

| Device | Posture | Physical px | CSS portrait | CSS landscape | DPR | Confidence |
|---|---|---|---|---|---|---|
| iPhone Duo | folded (cover) | 1398×2034, 5.4" | 466×678, usable 382×580 | 678×466, usable 678×340 | 3 | pixels official; viewport measured in the Xcode 27.1 simulator |
| iPhone Duo | unfolded (inner) | 1878×2670, 7.6" | 669×951, usable 669×825 | 951×669, usable 951×543 | 3 | pixels official; viewport measured in the simulator |
| iPhone 18 Pro Max | single screen | 1320×2868, 6.9" | 440×956 | 956×440 | 3 | official and measured |
| Galaxy Z Fold8 | cover | 1248×1972, 5.5" | ≈476×751 | ≈751×476 | 2.625 | pixels official; CSS derived (pixels ÷ 2.625) |
| Galaxy Z Fold8 | main | 2448×1848, 7.6" | ≈704×933 | ≈933×704 | 2.625 | pixels official; CSS derived |

Safe areas (native values; Safari's `env()` values are not yet published for the Duo):

- iPhone Duo folded: bottom 34, right 84 (Safari's control column)
- iPhone Duo unfolded: top 82 in portrait, right 84 in landscape
- iPhone 18 Pro Max: top 62 and bottom 34 in portrait; left and right 62 in landscape

The Fold8 derivation follows the Fold7, whose measured browser traffic (412×960 and 750×832 at DPR 2.625) matches the same
calculation. Do not use the 626×890 figure quoted for the Duo (that is pixels ÷ 3 of the wrong panel) or estimates that assume
DPR 3 for the Fold8.

## Fold behaviour in the browser

- No page reload on either device. Folding or unfolding fires `resize`. The Duo simulator fired 2 to 3 resize events per fold,
  with a transient 466×498 size between postures. No interval between those events has been measured.
- `screen.width` keeps reporting the cover width on the Duo after unfolding: use `innerWidth` or media queries.
- The Device Posture API and the viewport segments API report a single flat segment on both devices, and Safari has both
  behind a flag that is off by default. The layout does not rely on them.

## Layout decision

The design was agreed by a unanimous trinity panel (astra, grok, fable) in round 5 of 5:

- the session drawer is a full-screen sheet below 840px and docks beside the board from 840px
- the board's columns follow the inbox's own width through a container query, because a docked drawer narrows it
- a layout-mode change `{columns, panel closed|sheet|docked, applied view}` animates the cards; a resize while they move retargets
  from where they are on screen
- Tasks and Artifacts stay pinned, and the main scroll area keeps at least half of the panel body

Every fold, unfold and rotation of the three devices crosses one of these boundaries, so each one is animated. The transient Duo
size stays inside the compact mode and starts nothing.

## Verification and limits

`npx tsx scripts/screenshot-responsive.ts` renders every posture above, plus 1440×900 and 1920×1080, in Chromium and
WebKit, and replays the Duo fold. Chromium's `setViewportSize` is not a hinge. It proves the layout and the animation
scheduling, not the device's own OS transition or its on-screen keyboard. Check those on real devices.

## Sources

- [Apple: iPhone Duo specifications](https://www.apple.com/iphone-duo/specs/)
- [Apple: iPhone 18 Pro specifications](https://www.apple.com/iphone-18-pro/specs/)
- [MacRumors: iPhone Duo roundup](https://www.macrumors.com/roundup/iphone-duo/)
- [Apple Developer Forums: iPhone Duo viewport thread](https://developer.apple.com/forums/thread/847644)
- [Xcode 27.1 iPhone Duo simulator notes](https://blakecrosley.com/blog/xcode-27-1-beta-iphone-duo-simulator)
- [What Safari gives a web page on iPhone Duo](https://dev.to/tyoukyou23/i-measured-what-safari-actually-gives-your-web-page-on-iphone-duo-8jp)
- [iOS Ref: resolutions](https://iosref.com/res)
- [safearea.info: iPhone Duo](https://safearea.info/iphone-duo.md) and [iPhone 18 Pro Max](https://safearea.info/iphone-18-pro-max.md)
- [Samsung Mobile Press: Galaxy Z Fold8 Ultra, Fold8 and Flip8](https://www.samsungmobilepress.com/articles/galaxy-z-fold8-ultra-fold8-flip8-perfected-every-way-living)
- [GSMArena: Galaxy Z Fold Wide 5G](https://www.gsmarena.com/samsung_galaxy_z_fold_wide_5g-14673.php)
- [windowinsets.info: Galaxy Z Fold8](https://windowinsets.info/galaxy-z-fold8)
- [DeviceAtlas: viewport resolutions of popular smartphones](https://deviceatlas.com/blog/viewport-resolution-diagonal-screen-size-and-dpi-most-popular-smartphones)
- [Chrome: viewport segments API shipped](https://developer.chrome.com/blog/viewport-segments-api-shipped)
- [MDN: Device Posture API](https://developer.mozilla.org/en-US/docs/Web/API/Device_Posture_API)

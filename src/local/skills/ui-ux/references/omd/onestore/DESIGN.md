---
name: 원스토어
colors:
  brand-surface: '#2a1f60'
  canvas: '#ffffff'
  foreground: '#000000'
  secondary-foreground: '#454545'
typography:
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.46
    use: Storefront body sample; computed system stack is not a brand font
rounded:
  square: 0px
components:
  game-primary-button:
    type: button
    backgroundColor: '#28245b'
    textColor: '#ffffff'
    border: '1px #28245b'
    rounded: 23px
    padding: 11px 28px
    height: 45px
    typography: 16px / 400 / 21px
    states: default on one button; the bundle holds no state frame
    use: Game-catalog filled pill button (a.btn.btn-primary) at surface-2::[data-omd-capture="1"], 140 x 45, paired with game-light-button in one button group; the computed family is the system stack, so no family is claimed
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  game-light-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#3e3877'
    border: '1px #acaac4'
    rounded: 23px
    padding: 11px 28px
    height: 45px
    typography: 16px / 400 / 21px
    states: default on one button; the bundle holds no state frame
    use: Game-catalog outline pill button (a.btn.btn-light) at surface-2::[data-omd-capture="0"], 140 x 45, first in the same button group; system-stack family, not claimed
  app-detail-link-button:
    type: button
    backgroundColor: transparent
    textColor: '#3d3a73'
    padding: 13.5px 16px
    height: 48px
    typography: 15px / 400 / 21px
    states: default on two links (capture 1, 2); the bundle holds no state frame
    use: App-detail section text button (a.btn.btn-link.sm) at surface-4::[data-omd-capture="1"], 71 x 48, beside the description and update-history headings
  app-detail-info-link:
    type: button
    backgroundColor: transparent
    textColor: '#4b469c'
    padding: 14.5px 0px
    height: 48px
    typography: 13px / 400 / 19px
    states: default on one link; the bundle holds no state frame
    use: App-detail additional-information link (a) at surface-4::[data-omd-capture="3"], 60 x 48
  home-notice-link:
    type: button
    backgroundColor: '#f7f7f8'
    rounded: 16px
    padding: 21.5px 0px
    size: 1100px x 64px
    states: default on one link; the bundle holds no state frame
    use: Storefront home notice bar (a.notice-link) at home::[data-omd-capture="5"]; its own text colour and type equal the page body (#000000, 15px / 400 / 21.9px), so no label style is claimed
  home-filled-link:
    type: button
    backgroundColor: rgba(42, 31, 96, 0.96)
    padding: 19px 0px
    size: 250px x 60px
    states: default on two links (capture 3, 4); the bundle holds no state frame
    use: Storefront home filled link (a) at home::[data-omd-capture="3"] and "4"; it has no text content, so no label style is claimed
  home-footer-link:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    padding: 1.5px 0px
    height: 20px
    typography: 15px / 400 / 21px
    states: default on six footer links (capture 6-9, 18, 20); the bundle holds no state frame
    use: Storefront footer link (a) at home::[data-omd-capture="6"]; the link with class point (capture 19) records 15px / 700 / 21px
  home-footer-icon-link:
    type: button
    backgroundColor: transparent
    padding: 4px
    size: 48px x 48px
    states: default on two links (capture 12, 13); the bundle holds no state frame
    use: Storefront footer icon link (a) at home::[data-omd-capture="12"]; its own type equals the page body, so no label style is claimed
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# 원스토어

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 원스토어; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/onestore/DESIGN.md

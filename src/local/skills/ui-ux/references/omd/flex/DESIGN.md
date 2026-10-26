---
name: flex
colors:
  canvas: '#ffffff'
  ink: '#111111'
  on-dark: '#ffffff'
  action-lime: '#00ff44'
  announcement-orange: '#ff4d00'
typography:
  about-display:
    fontSize: 96px
    fontWeight: 600
    lineHeight: 1
    use: About-page relationship statement
  about-display-inverse:
    fontSize: 80px
    fontWeight: 600
    lineHeight: 1.2
    use: Dark About-page statement
  body-emphasis:
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.55
    use: About-page explanatory copy
  navigation:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1
    use: Global navigation controls
rounded:
  nav: 8px
  badge: 18px
  cta: 24px
spacing:
  compact: 8
  nav-action-x: 14
  cta-y: 30
  cta-x: 44
components:
  relationship-story-card:
    type: card
    backgroundColor: rgba(255,255,255,0.04)
    border: 1px solid rgba(255,255,255,0.08)
    rounded: 16px
    padding: 24px
    use: Non-interactive relationship-data story item observed on the public home surface
  nav-action-outline:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    border: '1px #111111'
    rounded: 8px
    padding: 8px 14px
    height: 33px
    typography: 13px / 700
    states: default captured on both surfaces; the capture holds no state frame for this action
    use: 'About-page global navigation secondary action (a, variant-border) at surface-2::[data-omd-capture="8"]; on the dark home header the same action computes #ffffff text and a 1px #ffffff border (home::[data-omd-capture="8"])'
  nav-action-solid:
    type: button
    backgroundColor: '#111111'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 14px
    height: 33px
    typography: 13px / 700
    states: default captured on both surfaces; the capture holds no state frame for this action
    use: 'About-page global navigation primary action (a, variant-invert) at surface-2::[data-omd-capture="9"]; on the dark home header it inverts to a #ffffff fill with #111111 text (home::[data-omd-capture="9"])'
    focus: no visible change (measured 2026-10-16) on :focus-visible
  gnb-menu-button:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    rounded: 8px
    padding: 8px
    height: 32px
    typography: 14px / 700
    states: default captured on six menu buttons per surface; no state frame and no menu-open record
    use: 'About-page global navigation menu button (button, variant-gnb) at surface-2::[data-omd-capture="2"]; the dark home header computes #ffffff text for the same buttons'
  lime-cta:
    type: button
    backgroundColor: '#00ff44'
    textColor: '#111111'
    rounded: 24px
    padding: 30px 44px
    height: 80px
    typography: 17px / 700
    states: default captured on both surfaces; no state frame
    use: High-emphasis marketing conversion link (a, variant-color, size-xl) at home::[data-omd-capture="13"]; /about repeats it at surface-2::[data-omd-capture="25"]
  new-badge:
    type: badge
    backgroundColor: '#ff4d00'
    textColor: '#000000'
    rounded: 18px
    padding: 0px 8px
    height: 20px
    typography: 12px / 700 / 16.56px
    states: static label; no state frame
    use: Announcement-strip new badge (span, badgeType-new) at home::span; /about carries the same badge (surface-2::span)
  carousel-arrow:
    type: button
    backgroundColor: rgba(17, 17, 17, 0.08)
    rounded: 50%
    padding: 0px
    size: 40px x 40px
    hover: bg rgba(17, 17, 17, 0.12)
    pressed: bg rgba(17, 17, 17, 0.12)
    states: 'rest, hover, and pressed sampled on the enabled arrow (capture 12); both frames record rgba(17, 17, 17, 0.12). The disabled arrow beside it (capture 11, same class) records the same two frames, which supports a settled value; the disabled arrow is given no state. Focus is not declared from the bundle: there is no focus frame, and the collector presses before it focuses'
    use: About-page carousel arrow (button.l2024-c-lnBcZQ) at surface-2::[data-omd-capture="12"]; icon-only, its glyph colour was not sampled
  accordion-item:
    type: card
    backgroundColor: rgba(255, 255, 255, 0.08)
    rounded: 24px
    padding: 24px
    states: collapsed (capture 15, class open-false) and expanded (capture 13 and 14, class open-true) variants captured at rest; the expanded fill is rgba(255, 255, 255, 0.1); no pointer-state frame
    use: About-page accordion item (li role=button, l2024-c-bloTie) at surface-2::[data-omd-capture="15"]; the white-alpha fill implies a dark section, and the label style was not sampled separately
  feature-card:
    type: card
    backgroundColor: rgba(17, 17, 17, 0.96)
    rounded: 24px
    padding: 24px
    size: 328px x 452px
    states: non-interactive; three colour variants
    use: 'About-page feature card (li.l2024-c-fMALsr, color-black, two occurrences) at surface-2::li; the color-gray variant fills rgba(17, 17, 17, 0.1) and the color-green variant #00dc3a'
  about-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 24px
    padding: 24px
    states: non-interactive; three colour variants
    use: 'About-page 500px-wide card (li.l2024-c-CFKUv, color-white) at surface-2::li; the color-black variant fills #111111 and the color-trans variant rgba(255, 255, 255, 0.08)'
fonts:
  roles:
    ui: Pretendard Variable
---

# flex

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to flex; reproduced for educational reference. Full prose: https://oh-my-design.kr/flex/design.md

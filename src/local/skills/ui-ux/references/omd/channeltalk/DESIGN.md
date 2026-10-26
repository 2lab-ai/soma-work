---
name: Channel Talk
colors:
  primary: '#242428'
  canvas: '#ffffff'
  surface: '#f7f6f3'
  foreground: '#000000'
  secondary: '#716f6d'
  dark-surface: '#3a3530'
  hairline: '#e4e4e5'
  on-primary: '#ffffff'
typography:
  marketing-heading:
    fontSize: 44px
    fontWeight: 600
    lineHeight: 1.41
    letterSpacing: '-0.88px'
    use: Large current marketing headings
  marketing-body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.56
    letterSpacing: '-0.18px'
    use: Current marketing body and action copy
  marketing-tab:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.56
    letterSpacing: '-0.16px'
    use: Interactive marketing category tabs
  docs-body:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.59
    letterSpacing: '-0.1px'
    use: English product documentation body
rounded:
  control: 6px
  utility: 8px
  card: 35px
  full: 9999px
spacing:
  xs: 4
  sm: 6
  md: 10
  lg: 20
  xl: 30
components:
  marketing-primary:
    type: button
    backgroundColor: '#242428'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 10px 22px
    typography: 18px / 400
    hover: opacity 1 → 0.85 (bg unchanged)
    pressed: opacity 1 → 0.85 (bg unchanged)
    focus: no focus indication in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    states: 'default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on the hero 무료로 시작하기 button (156px x 48px, Tab 6), never activated; hover equals pressed; the #3a3a3f promoted here on 2026-09-17 belongs to the sticky-header link (header-cta), whose 43px height and 9px 14px padding that re-verify reproduced'
    use: Primary signup and conversion action on current KR/US marketing
    height: 48px
  marketing-outline:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px solid #242428'
    rounded: 9999px
    padding: 10px 22px
    typography: 18px / 400
    hover: bg rgba(0, 0, 0, 0.04)
    pressed: bg rgba(0, 0, 0, 0.04)
    focus: no focus indication in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on the first SectionHeader 자세히 보기 pill (127px x 50px, Tab 13); hover equals pressed; the computed radius is 1368.71px, a pill
    use: Secondary marketing conversion action
  marketing-card:
    type: card
    backgroundColor: '#f7f6f3'
    border: '1px solid #e4e4e5'
    rounded: 35px
    padding: 30px 35px
    use: Current KR/US marketing information card
  marketing-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#716f6d'
    rounded: 9999px
    padding: 6px 35px
    typography: 16px / 600
    selected: 'fg #ffffff (the dark pill behind the label is drawn by another element, not compared)'
    hover: no change in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) on both 패션 and the selected 라이프스타일 — measured 2026-09-29
    pressed: no change in the compared scope (same scope, both tabs) — measured 2026-09-29
    focus: no focus indication in the compared scope (same scope) on the selected tab (Tab 14) — measured 2026-09-29
    states: 'selected and tab-selected observed in six safe expansions 2026-07-12; hover and pressed measured 2026-09-29 on 패션 and 라이프스타일; keyboard focus measured on the selected tab only: the tablist uses a roving tabindex, 패션 is tabIndex -1 and was not reached by Tab, so its focus is unmeasured'
    use: Interactive category switcher on current marketing (KR home; the US page read 6px 20px padding on 2026-07-12)
  docs-icon-button:
    type: button
    backgroundColor: transparent
    textColor: rgba(0,0,0,0.85)
    rounded: 6px
    hover: bg rgba(28, 28, 28, 0.08); fg rgba(0, 0, 0, 0.6) → rgba(0, 0, 0, 0.85) on the svg icon
    pressed: bg rgba(28, 28, 28, 0.08); fg rgba(0, 0, 0, 0.6) → rgba(0, 0, 0, 0.85) on the svg icon
    focus: outline 3px rgba(97, 87, 234, 0.3), offset 0 (authored ring) — measured 2026-09-29
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on the first sidebar chevron (20px x 20px, Tab 5); pressed equals hover; the July pressed frames were alpha-0 transition frames with no value
    use: Compact icon action in product documentation
  header-cta:
    type: button
    backgroundColor: '#242428'
    textColor: '#ffffff'
    rounded: 999px
    padding: 9px 14px
    size: 127px x 43px
    typography: 16px / 600
    hover: 'bg #3a3a3f'
    pressed: 'bg #3a3a3f'
    states: 'default captured 2026-07-12 on home, us and the rebrand page; hover and pressed measured 2026-09-29, the same #3a3a3f the 2026-09-17 re-verify read on this link; keyboard focus unmeasured: the link has no href attribute, so Tab never reaches it'
    use: Sticky-header 무료로 시작하기 link at home::[data-omd-capture="7"]
  nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 999px
    padding: 6px 12px
    height: 37px
    typography: 16px / 400
    hover: bg rgba(36, 36, 40, 0.05)
    pressed: bg rgba(36, 36, 40, 0.05)
    focus: 'outline 2px #242428, offset 2px (authored ring); bg rgba(36, 36, 40, 0.05) — measured 2026-09-29'
    states: default captured 2026-07-12 on five header triggers; hover, pressed and keyboard focus measured 2026-09-29 on 가격 안내 (Tab 4), the only one with an href; the other four are anchors without href that Tab skips, so their focus is unmeasured
    use: Header navigation trigger at home::[data-omd-capture="1"] to [data-omd-capture="5"]
  header-login-link:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 999px
    padding: 6px 12px
    height: 37px
    typography: 16px / 400
    states: 'default captured 2026-07-12 on home, us and the rebrand page; not probed: on 2026-09-29 it had no href attribute, so Tab never reaches it'
    use: Header 로그인 control at home::[data-omd-capture="6"]
  marketing-band-cta:
    type: button
    backgroundColor: '#242428'
    textColor: '#ffffff'
    rounded: 1368.71px
    padding: 10px 22px
    size: 125px x 48px
    typography: 18px / 400
    states: default captured 2026-07-12 (six occurrences on home and us); the computed radius makes it a pill; not probed
    use: Dark 자세히 보기 pill in the section intro band at home::[data-omd-capture="9"]
  customer-case-carousel-nav:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.2)
    textColor: '#ffffff'
    rounded: 9999px
    padding: 0px
    size: 48px x 48px
    states: default captured 2026-07-12 (four occurrences on home and us); not probed
    use: Translucent carousel arrow over the dark customer-case media at home::[data-omd-capture="23"]
  demo-input:
    type: input
    backgroundColor: transparent
    textColor: '#0a0b0b'
    padding: 0px 4px
    size: 428px x 27px
    typography: 17px / 400
    states: default captured 2026-07-12 on home and us; not probed; its submit button was captured disabled, so no value is taken from it
    use: Marketing demo prompt input (role=combobox) at home::[data-omd-capture="10"]
  docs-search-button:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.05)
    textColor: rgba(0, 0, 0, 0.85)
    rounded: 12px
    padding: 11px 14px
    size: 250px x 44px
    states: default captured 2026-07-12 on both documentation pages; not probed
    use: Documentation header search trigger at surface-3::[data-omd-capture="1"]
fonts:
  roles:
    ui: Pretendard
    marketing: Pretendard
    docs: Inter
---

# Channel Talk

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Channel Talk; reproduced for educational reference. Full prose: https://oh-my-design.kr/channeltalk/design.md

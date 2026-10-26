---
name: KakaoBank
colors:
  primary: '#ffe300'
  canvas: '#ffffff'
  foreground: '#000000'
  secondary: '#888888'
  body: '#444444'
  surface: '#f7f7f7'
  divider: '#e6e6e6'
typography:
  hero:
    fontSize: 90px
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: '-0.9px'
    use: Current corporate home hero
  display:
    fontSize: 42px
    fontWeight: 700
    lineHeight: 1.24
    letterSpacing: '-0.84px'
    use: Current service page title
  section:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.36
    letterSpacing: '-0.64px'
    use: Current public service section heading
  card-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.44
    letterSpacing: '-0.48px'
    use: Current public service and brand-resource card heading
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Current public body and list text
  navigation:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: '-0.14px'
    use: Current top navigation
rounded:
  action: 6px
  section: 16px
  full: 9999px
spacing:
  xs: 8
  sm: 12
  md: 16
  lg: 24
  xl: 40
components:
  top-navigation:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0 20px
    height: 62px
    typography: 14px / 600
    hover: 'fg #444444'
    active: 'fg #444444'
    pressed: 'fg #444444 (same as hover)'
    focus: 'outline 2px solid #007bff, offset 2px (authored ring; fg and bg unchanged)'
    states: hover, pressed and keyboard focus measured 2026-09-29 (real :hover, :active, and Tab to :focus-visible); the colour settles after a 0.4s ease-in-out transition, and the near-black values captured 2026-07-12 were early frames of it
    use: Current corporate top navigation item
  service-tab:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '0 0 1px #e6e6e6'
    rounded: 0px
    padding: 16px 0
    height: 62px
    typography: 20px / 700 (label h5; the button's own font is 16px / 400)
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: no change among the compared properties (measured 2026-09-29)
    focus: 'outline 2px solid #007bff, offset 2px (authored ring)'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29; an accordion trigger (aria-expanded, no role=tab) whose expanded state was not opened
    use: Current public service-category accordion trigger (저축 …)
  black-action:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 6px
    padding: 9.5px 18px
    height: 42px
    typography: 15px / 600
    hover: 'bg #444444'
    pressed: 'bg #444444 (same as hover)'
    focus: 'outline 2px solid #007bff, offset 2px (authored ring)'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29; the fill settles after a 0.35s ease transition
    use: Current corporate high-emphasis action
  resource-download:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 6px
    padding: 10px 16px 10px 20px
    height: 43px
    typography: 15px / 600 (label span; the anchor's own font is 16px / 400)
    hover: 'bg #444444'
    pressed: 'bg #444444 (same as hover)'
    focus: 'outline 2px solid #007bff, offset 2px (authored ring)'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29
    use: Current official brand-resource download action
  brand-spec-row:
    type: listItem
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px 0 0 #e6e6e6'
    rounded: 0px
    padding: 10px 0
    typography: 16px / 400 / 24px
    use: Current official brand specification row
  link-row:
    type: card
    backgroundColor: '#f7f7f7'
    textColor: '#000000'
    rounded: 16px
    padding: 22px 24px
    height: 72px
    typography: 16px / 600 (label h6; the anchor's own font is 16px / 400)
    hover: 'fg #444444 (label); bg stays #f7f7f7'
    pressed: 'fg #444444 (same as hover)'
    focus: 'outline 2px solid #007bff, offset 2px (authored ring)'
    states: default captured 2026-07-12 (six rows, 672px wide); hover, pressed and keyboard focus measured 2026-09-29 on 금융기술연구소; the change is instant (transition 0s)
    use: Home related-service link row (금융기술연구소 …), opens in a new window
  service-pill-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#222222'
    rounded: 50px
    padding: 10px 22px
    height: 38px
    typography: 16px / 600 / -0.16px tracking
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: no change among the compared properties (measured 2026-09-29)
    focus: 'outline 2px solid #007bff, offset 2px (authored ring)'
    states: 'default captured 2026-07-12 (four unselected pills); the selected pill reads fg #ffffff on a transparent own background, its fill painted by another element that was not identified; hover, pressed and keyboard focus measured 2026-09-29 on 청소년'
    use: Sticky in-page category pill on the service page (청소년 …)
  brand-section-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 30px
    padding: 8px 17px
    height: 40px
    typography: 16px / 600 / -0.16px tracking
    selected: 'bg #000000 fg #ffffff'
    states: default and selected captured 2026-07-12; the 2026-09-29 survey reads the same four pills; no pointer-state sample
    use: Brand-resource section pill (로고, 앱 아이콘, 색상, 미디어 패키지)
  footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#888888'
    height: 16px
    typography: 14px / 500
    states: default captured 2026-07-12 (18 links on each captured page); no pointer-state sample
    use: Footer related-service and channel link (카카오뱅크 AD, 금융기술연구소, 기술블로그, 인스타그램 …)
  top-scroll-button:
    type: button
    backgroundColor: '#e6e6e6'
    rounded: 50%
    size: 52px x 52px
    states: default captured 2026-07-12 on all three captured pages; no pointer-state sample
    use: Floating back-to-top button (맨 위로 이동), icon only
fonts:
  roles:
    ui: Pretendard Variable
  faces:
    Pretendard Variable:
      scripts:
        - hangul
        - latin
      evidence:
        - official-product-use
        - live-surface-use
      source: https://github.com/orioncactus/pretendard
      licence: OFL-1.1
      distribution: public
      note: KakaoBank serves the public Pretendard v1.3.9 variable file unmodified.
---

# KakaoBank

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KakaoBank; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/kakaobank/DESIGN.md

---
name: LikeLion
colors:
  primary: '#ff6000'
  foreground: '#222222'
  muted: '#a3a3a3'
  muted-secondary: '#737373'
  hairline: '#e5e5e5'
  promo: '#fcf4ee'
  nav-border: '#d4d4d4'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed home body copy; the computed Pretendard Variable face is unresolved, so no UI-family token is assigned.
  section-heading:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    use: Observed home course-section heading.
  search:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.2
    use: Observed home course-search input (2026-07-13; the input was absent on 2026-09-29).
rounded:
  promo: 16px
components:
  promo-tile:
    type: button
    backgroundColor: '#fcf4ee'
    textColor: '#222222'
    rounded: 16px
    padding: 40px
    typography: 16px / 400 / unresolved computed stack
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: no change among the compared properties (measured 2026-09-29)
    focus: outline-style none on the control; no visible focus indication among the compared properties (measured 2026-09-29)
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on the BUSINESS tile (real :hover, :active, and Tab to :focus-visible); transition 0s
    use: home::[data-omd-capture="13"] clickable warm promotional tile; 310px rendered height.
    height: 310px
  account-pill:
    type: button
    backgroundColor: transparent
    textColor: '#222222'
    border: '1px solid #d4d4d4'
    rounded: 9999px
    padding: 10px 16px
    typography: 14px / 600 (label span; the button's own font is 16px / 400)
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: no change among the compared properties (measured 2026-09-29)
    focus: outline-style none on the control; no visible focus indication among the compared properties (measured 2026-09-29)
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 (the mouse release was swallowed, so no login flow opened)
    use: home::[data-omd-capture="6"] 로그인/회원가입 control; 43px rendered height; low-confidence collector classification.
  course-search:
    type: input
    textColor: '#ff6000'
    typography: 20px / 600 / unresolved computed stack
    pressed: 'border-color #2563eb (border-width 0, nothing drawn; 2026-07-13 pseudo-state sample)'
    focus: 'border-color #2563eb (border-width 0, nothing drawn; 2026-07-13 pseudo-state sample)'
    states: default plus focus and pressed pseudo-state samples captured 2026-07-13 only; the input was absent from https://likelion.net/ and /catalog on 2026-09-29, so nothing was re-measured
    use: home::[data-omd-capture="7"] course-search input observed 2026-07-13; no complete interaction or result state was captured.
  nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#262626'
    rounded: 0px
    padding: 20px 16px
    height: 63px
    typography: '15px / 600 (label span; the anchor''s own computed style is #222222 16px / 400)'
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: no change among the compared properties (measured 2026-09-29)
    focus: outline-style none on the control; no visible focus indication among the compared properties (measured 2026-09-29)
    states: default captured 2026-07-13 (전체강의; four more header links at padding 20px 12px); hover, pressed and keyboard focus measured 2026-09-29 on 전체강의
    use: Header course-navigation link (전체강의, 부트캠프국비지원, AI교육, 기업교육, AX 해커톤)
  section-detail-link:
    type: tab
    backgroundColor: transparent
    textColor: '#a3a3a3'
    padding: 0px
    height: 24px
    typography: '16px / 500 (label span; the anchor''s own computed style is #222222 16px / 400)'
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: no change among the compared properties (measured 2026-09-29)
    focus: outline-style none on the control; no visible focus indication among the compared properties (measured 2026-09-29)
    states: default captured 2026-07-13 (two links); hover, pressed and keyboard focus measured 2026-09-29 on the first
    use: Section-heading 자세히 보기 link (to /catalog and the bootcamp site)
  tile-detail-button:
    type: button
    backgroundColor: transparent
    textColor: '#a3a3a3'
    padding: 0px
    height: 21px
    typography: 16px / 600
    states: default captured 2026-07-13 and present in the 2026-09-29 survey; nested inside each promo-tile anchor; no pointer-state sample
    use: 자세히 보기 label button inside each promo tile
  footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#222222'
    height: 16px
    typography: 14px / 600 / 21px
    states: default captured 2026-07-13 (11 links); the 2026-09-29 survey reads the same style; no pointer-state sample
    use: Footer column link (전체 강의, 국비지원 부트캠프, AI교육, 기업교육, AX 해커톤 … in the 2026-09-29 survey)
  social-icon-link:
    type: button
    backgroundColor: transparent
    size: 24px x 24px
    states: default captured 2026-07-13 (five icon links); no pointer-state sample
    use: Footer social icon link (Instagram, YouTube, a Kakao channel, Brunch and Facebook in the 2026-09-29 survey); icon colour not read
  filter-pill:
    type: tab
    backgroundColor: transparent
    textColor: '#222222'
    border: '1px #e5e5e5'
    rounded: 9999px
    padding: 8px 12px
    height: 42px
    typography: 16px / 400
    selected: 'bg #1e1e1e fg #ffffff, no border (40px tall)'
    states: default and selected captured 2026-07-13 (one selected and four unselected list items); no pointer-state sample; the 2026-09-29 survey did not list them
    use: Home course-list filter pill (li)
  section-tab:
    type: tab
    backgroundColor: rgba(255,243,235,0.1)
    textColor: '#222222'
    rounded: 12px
    padding: 12px 16px
    height: 48px
    typography: 16px / 400
    states: default captured 2026-07-13 (three list items, 257px wide); no pointer-state sample; the 2026-09-29 survey did not list them
    use: Home three-way tab row (li); its labels were not captured
  category-button:
    type: button
    backgroundColor: transparent
    textColor: '#737373'
    rounded: 0px
    padding: 0px
    size: 96px x 96px
    typography: '16px / 400 (label; the button''s own colour is #222222)'
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: no change among the compared properties (measured 2026-09-29)
    focus: outline-style none on the control; no visible focus indication among the compared properties (measured 2026-09-29)
    states: measured 2026-09-29 only, on /catalog (a surface added to this reference that day); an image sits above the label
    use: Course-catalog category button (프로그래밍 …)
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# LikeLion

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to LikeLion; reproduced for educational reference. Full prose: https://oh-my-design.kr/likelion/design.md

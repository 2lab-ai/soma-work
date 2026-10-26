---
name: SOCAR
colors:
  primary: '#0078ff'
  canvas: '#ffffff'
  foreground: '#354153'
  secondary: '#697383'
  muted: '#b4bbcb'
  on-primary: '#ffffff'
  surface: '#f2f3f8'
  hairline: '#e5e8ef'
typography:
  h1:
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.38
    use: Large current product heading
  h2:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.36
    use: Section heading
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Product body and list text
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Supporting product copy
rounded:
  sm: 4px
  action: 14px
  card: 12px
  full: 48px
spacing:
  xs: 4
  sm: 10
  md: 14
  base: 16
  lg: 20
components:
  primary-action:
    type: button
    backgroundColor: '#0078ff'
    textColor: '#ffffff'
    rounded: 14px
    padding: 16px 22px
    typography: 16px / 600
    hover: no visible change (measured 2026-09-29)
    pressed: 'transform scale(0.92); overlay ::after rgba(242,243,248,0.66) over the full box; bg stays #0078ff'
    focus: outline browser default ring (outline-style auto), not brand — measured 2026-09-29
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on the /guide 웹에서 예약하기 link (real :hover, :active and Tab to :focus-visible, three reads); transition all 0.1s ease-in-out
    use: Prominent guide/product action
    height: 56px
  search-action:
    type: button
    backgroundColor: '#f2f3f8'
    textColor: '#b4bbcb'
    rounded: 12px
    padding: 12px 18px
    typography: 14px / 600
    disabled: '#f2f3f8'
    states: disabled appearance captured 2026-07-12; re-read 2026-09-29 as a genuinely disabled control (disabled=true, cursor not-allowed), so its hover and pressed reads are its disabled rendering, not states, and it takes no keyboard focus; the enabled look needs a completed booking form
    use: Home search action before required values are complete
  region-list:
    type: listItem
    backgroundColor: '#f9f9fb'
    textColor: '#354153'
    rounded: 12px
    padding: 24px 16px
    use: Home region or destination collection item
  floating-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#354153'
    rounded: 48px
    padding: 11px
    typography: 14px / 600
    hover: no visible change (measured 2026-09-29 on /guide)
    pressed: overlay ::after rgba(20,26,36,0.06); transform scale(0.95)
    focus: outline browser default ring (outline-style auto), not brand — measured 2026-09-29 on /guide
    states: default captured 2026-07-12 on home, service, guide and fare; the pressed overlay was first read 2026-09-16; hover, pressed and keyboard focus measured 2026-09-29 on /guide, because on home the button's fixed wrapper stays at opacity 0, and the button reads inert with pointer-events none, until the page scrolls; transition all 0.1s ease-in-out
    use: Floating circular navigation/control button
  nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#354153'
    padding: 0px
    typography: 16px / 600 / Pretendard
    hover: 'fg #0078ff'
    pressed: 'fg #0078ff'
    focus: outline browser default ring (outline-style auto), not brand — measured 2026-09-29
    states: 'hover and pressed state samples captured 2026-07-12 on the header links of home, service, guide and fare (22 frames, all #0078ff); re-measured 2026-09-29 on 예약하기 with real :hover and :active; keyboard focus measured 2026-09-29 (Tab 2)'
    use: Header navigation link (예약하기, 쏘카 서비스, 블로그)
  search-input:
    type: input
    backgroundColor: transparent
    textColor: '#354153'
    rounded: 0px
    padding: 0px
    height: 24px
    typography: 16px / 400 / Pretendard
    hover: no visible change (measured 2026-09-29)
    pressed: 'border 1px #99ceff on the wrapper div two levels up (the press focuses the field)'
    focus: 'border 1px #e5e8ef → 1px #99ceff on the wrapper div two levels up; no outline on the input — measured 2026-09-29'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 (Tab 9); focusing the field opens a place layer (제주예약, 닫기)
    use: 'Home booking-strip place field 대여 장소 검색; the visible box is its wrapper (bg #ffffff, 1px solid #e5e8ef)'
  time-range-chip:
    type: button
    backgroundColor: '#ffffff'
    border: '1px solid #e5e8ef'
    rounded: 14px
    padding: 0px 12px
    height: 48px
    states: default captured 2026-07-12 (343px wide on home); no state sample; its label element was not captured, so no text colour or type is declared
    use: Home booking-strip date-time chip (오늘 09:50 ~ 13:50)
  location-tile:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#354153'
    border: '1px solid #e5e8ef'
    rounded: 14px
    padding: 20px
    size: 300px x 90px
    typography: 16px / 600 / Pretendard (city-name h3)
    states: default captured 2026-07-12 (14 tiles at 300px x 90px, 24 at 300px x 66px); the July hover and pressed frames drift the border by 1-5 channel units with no sibling agreement (transition frames), so no hover or pressed value is declared
    use: Home city and airport entry tile (the Location / Region Card in the prose)
  jeju-entry-tile:
    type: card
    backgroundColor: '#f9f9fb'
    textColor: '#354153'
    border: '1px solid #e5e8ef'
    rounded: 16px
    padding: 20px
    size: 618px x 90px
    typography: 16px / 600 / Pretendard (label span)
    hover: no visible change (measured 2026-09-29)
    pressed: no visible change (measured 2026-09-29)
    states: 'rest, hover and pressed measured 2026-09-29 (probe tool plus a cross-check over all seven descendants); keyboard focus UNMEASURED: 300 Tab presses never reached it because the place layer traps the walk'
    use: Home 제주에서 빌리기 entry tile (link to /jeju); the July capture has no 618px-wide tile
  row-button:
    type: button
    backgroundColor: transparent
    rounded: 0px
    padding: 14px 16px
    height: 52px
    pressed: bg rgba(20,26,36,0.06); radius 0px → 14px
    states: default captured 2026-07-12 (18 rows on home, guide and fare); pressed frames on guide and fare agree 12 of 12; hover and focus not sampled; the label span was not captured, so no text colour or type is declared
    use: Full-width list row button (1248px x 52px) on home, guide and fare
  footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#697383'
    typography: 14px / 400 / Pretendard
    hover: 'fg #354153'
    pressed: 'fg #354153'
    states: 'default captured 2026-07-12 (56 links on home, service, guide and fare); hover and pressed frames on four links on service and fare all read #354153; focus not sampled'
    use: Footer link in secondary text
fonts:
  roles:
    product: Pretendard
    brand-center: IBM Plex Sans KR
---

# SOCAR

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SOCAR; reproduced for educational reference. Full prose: https://oh-my-design.kr/socar/design.md

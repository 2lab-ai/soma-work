---
name: 여기어때
colors:
  primary: '#1d8bff'
  canvas: '#ffffff'
  foreground: '#222222'
  border: '#e6e6e6'
  red: '#f94239'
  red-tint: '#ffedea'
  blue-tint: '#e3f0ff'
  yellow: '#ffc83b'
  slate: '#49627a'
typography:
  display-large:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.1875
    use: Highest display hierarchy
  display-medium:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.1667
    use: Page-level display hierarchy
  title-large:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.1111
    use: Large component or section title
  body-medium:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4286
    use: Multiline product body
  caption-large:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.3333
    use: Multiline caption
rounded:
  xs: 2px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 20px
  full: 9999px
spacing:
  xs: 2
  sm: 4
  md: 8
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button:
    type: button
    backgroundColor: '#1d8bff'
    textColor: '#ffffff'
    rounded: 8px
    states: enabled, pressed, disabled
    use: YDS public Button family; exact variant geometry belongs to the component page
  search-bar:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 12px
    states: idle, focused, typing, populated
    use: YDS public search pattern and product destination/accommodation search
  price-marker:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 20px
    states: default, selected
    use: YDS public map price marker
  filter-chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #e6e6e6'
    rounded: 100px
    padding: 0px 16px
    height: 32px
    typography: 13px / 600 / Pretendard
    hover: 'bg #f5f5f5'
    pressed: 'bg #f5f5f5'
    focus: 'border 1px #243b52 replaces the 1px #e6e6e6 border (authored; gone after blur) — measured 2026-09-29'
    states: rest, hover, pressed and keyboard focus measured 2026-09-29 on the results page's '5만원 이하' (real :hover, :active, and Tab to :focus-visible); instant (transition all 0s)
    use: Price and grade filters on the accommodation results page (gc-capsule-button)
  listing-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 0px 0px 24px
    size: 282px x 343px
    hover: 'photo only: image filter none → brightness(0.8) saturate(1.5), image bg rgba(0,0,0,0.16); the card itself unchanged'
    pressed: same as hover
    focus: no visible change (measured 2026-09-29)
    states: default captured 2026-07-11 (35 cards on the home carousels); hover and pressed measured 2026-09-29 in a run with this card alone, keyboard focus in the first run
    use: 'Home accommodation carousel card (gc-carousel-seller-card): photo, grade, name, location, rating, price'
  search-cta:
    type: button
    backgroundColor: '#1d8bff'
    textColor: '#ffffff'
    rounded: 10px
    padding: 0px 18px
    height: 48px
    typography: 15px / 700 / Pretendard
    hover: 'bg #006ce0'
    pressed: 'bg #006ce0'
    focus: 'no visible change: no outline is drawn and nothing else changes (measured 2026-09-29)'
    states: default captured 2026-07-11; hover, pressed and keyboard focus measured 2026-09-29; 0.15s transition
    use: Home search submit '검색' (yf-* family); 10px radius, not the 8px of the YDS Button
  box-button:
    type: button
    backgroundColor: '#1d8bff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 9px 14px
    height: 40px
    typography: 14px / 600 / Pretendard
    hover: 'bg #006ce0'
    pressed: 'bg #006ce0'
    focus: 'border 1px #243b52 added (authored), widening the box 117.7px → 119.7px — measured 2026-09-29'
    states: default captured 2026-07-11; hover, pressed and keyboard focus measured 2026-09-29
    use: 'Filled product button (gc-box-button), e.g. ''로그인/회원가입'' in the page body; same #1d8bff fill and 8px radius as the YDS Button'
  outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #e6e6e6'
    rounded: 8px
    padding: 0px 14px
    height: 40px
    typography: 14px / 600 / Pretendard
    hover: 'bg #f5f5f5'
    pressed: 'bg #f5f5f5'
    focus: 'no visible change: no outline is drawn and nothing else changes (measured 2026-09-29)'
    states: default captured 2026-07-11; hover, pressed and keyboard focus measured 2026-09-29; colour transitions 0.15s
    use: Header '비회원 예약조회'
  header-login-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1d8bff'
    border: '1px solid #1d8bff'
    rounded: 8px
    padding: 0px 14px
    height: 40px
    typography: 14px / 600 / Pretendard
    states: default captured 2026-07-11; no pointer-state sample
    use: Header '로그인/회원가입', outlined in the action blue
  menu-button:
    type: button
    backgroundColor: '#ffffff'
    rounded: 8px
    size: 40px x 40px
    hover: 'bg #e6e6e6'
    pressed: 'bg #e6e6e6'
    states: 'hover and pressed state samples captured 2026-07-11, both settling on #e6e6e6 (the Neutral 100 border colour); keyboard focus not measured'
    use: Header '메뉴 열기' icon button
  search-field:
    type: input
    backgroundColor: transparent
    textColor: '#222222'
    border: 1px solid transparent
    rounded: 16px
    padding: 16px 24px
    size: 351px x 72px
    typography: 16px / 600 / Pretendard (input text)
    hover: 'bg #e6e6e6 (field wrapper)'
    states: 'default captured 2026-07-11 (three fields: 여행지, 일정, 인원); hover measured 2026-09-29; a press or keyboard focus turns the wrapper #ffffff with a 1px #222222 border, but that look stayed after blur, so it may be script state and is not declared'
    use: Home search field wrapper, the live product's search bar; the YDS search-bar entry keeps its documented 12px radius
  section-tab-chip:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #e6e6e6'
    rounded: 100px
    padding: 8px 16px
    height: 32px
    typography: 13px / 500 / Pretendard
    selected: 'bg #1d8bff, fg #ffffff, border 1px #ffffff, 13px / 700'
    states: unselected and aria-selected=true variants captured 2026-07-11 (7 and 10 samples; the collector's tab interactions selected each in turn); no pointer-state sample
    use: Home section tablist chip (role=tab)
fonts:
  roles:
    sans: Pretendard
---

# 여기어때

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 여기어때; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/yeogiotte/DESIGN.md

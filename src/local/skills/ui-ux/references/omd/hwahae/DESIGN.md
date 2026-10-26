---
name: Hwahae
colors:
  ink: '#000000'
  ink-soft: '#111111'
  label: '#3d3d3d'
  muted: '#666666'
  faint: '#999999'
  placeholder: '#aaaaaa'
  hairline: '#e8e8e8'
  canvas: '#ffffff'
  surface: '#f7f7f7'
  on-media: '#ffffff'
  award-accent: '#82e6e6'
  info-ink: '#3750be'
  info-tint: '#ebf5ff'
typography:
  section:
    fontSize: 18px
    fontWeight: 600
    letterSpacing: '-0.2px'
    use: Home section title (h2.hds-text-title-medium, line height computes normal)
  title-large:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.2px'
    use: Awards page title text (p.hds-text-title-large)
  nav:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.53
    use: Top navigation, selected item; unselected items compute 400
  button:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.53
    use: Awards outline button label
  card-title:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    use: White label over category imagery on home (h3)
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Page body text
  label:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Header search field text
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Footer chip and note text
rounded:
  xs: 4px
  sm: 8px
  tile: 12px
  md: 16px
  full: 99999px
spacing:
  chip-x: 8
  tile: 12
  control-x: 16
  card: 16
  icon-button: 10
  header-x: 20
components:
  nav-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#111111'
    typography: 15px / 400 / 23px Pretendard Variable
    selected: '15px / 600 on the current section: 홈 on home (capture 8), 어워드 on the awards page (capture 4)'
    states: selected variant read from rest values only; no pointer or focus frame was recorded for these links
    use: Top navigation link (홈, 랭킹, 어워드) at home::[data-omd-capture="9"], 26 x 23; the same three links repeat on the awards page
  language-button:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    rounded: 8px
    padding: 10px
    height: 44px
    typography: 16px / 400 / 24px Pretendard Variable
    states: 'hover and pressed frames change only border-color (#e8e8e8 to #111111) while the computed border width stays 0px, so nothing visible changes and no state value is declared'
    use: Header language selector (한국어) at home::[data-omd-capture="3"], 108 x 44
  footer-login-chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#3d3d3d'
    border: '1px solid #e8e8e8'
    rounded: 4px
    padding: 0px 8px
    height: 24px
    typography: 12px / 400 / 18px Pretendard Variable
    states: rest on home, rankings and awards; no state frame
    use: 24px outline chip at the foot of each page (home::[data-omd-capture="106"], 49 x 24); the page text places 로그인 at this position
    pressed: 'bg #f7f7f7 (:hover + :active)'
    focus: no visible change (measured 2026-10-16) on :focus-visible
  footer-info-toggle:
    type: button
    backgroundColor: transparent
    textColor: '#3d3d3d'
    rounded: 4px
    padding: 0px 8px
    height: 24px
    typography: 12px / 400 / 18px Pretendard Variable
    states: rest on all three pages; no state frame
    use: Footer text button (home::[data-omd-capture="98"], 89 x 24) whose six-character label the page text gives as 사업자 정보
  dark-block-button:
    type: button
    backgroundColor: '#3d3d3d'
    rounded: 8px
    size: 344px x 52px
    states: rest only; no state frame
    use: Full-width dark button on home (home::[data-omd-capture="108"], class bg-gray-850); its label sits in a child that was not captured, so no text colour is claimed
  ranking-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 16px
    shadow: rgba(0, 0, 0, 0.08) 0px 2px 8px 0px
    size: 560px x 112px
    use: Rankings list card (li.shadow-card) on the rankings page
  award-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    shadow: rgba(0, 0, 0, 0.08) 0px 2px 8px 0px
    size: 560px x 284px
    use: Awards page section card (div.rounded-16.shadow-card, six captured)
  award-outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#3d3d3d'
    border: '1px solid #e8e8e8'
    rounded: 8px
    padding: 0px 16px
    height: 44px
    typography: 15px / 600 / 23px Pretendard Variable
    hover: 'bg #f7f7f7'
    pressed: 'bg #f7f7f7'
    states: 'rest, hover and pressed; the hover and pressed frames of both sibling buttons (capture 14, 21) read #f7f7f7; focus is not declared from the capture'
    use: Full-width outline button on the awards page (surface-3::[data-omd-capture="14"], 528 x 44)
  award-tint-button:
    type: button
    backgroundColor: '#ebf5ff'
    textColor: '#3750be'
    rounded: 8px
    padding: 0px 16px
    height: 44px
    typography: 15px / 600 / 23px Pretendard Variable
    states: rest only; no state frame
    use: Blue-tint full-width button near the end of the awards page (surface-3::[data-omd-capture="51"], 520 x 44)
  award-category-tile:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e8e8e8'
    rounded: 12px
    padding: 12px
    size: 88px x 124px
    use: Awards category tile link, ten captured in two rows (surface-3::[data-omd-capture="8"])
  banner-card:
    type: card
    rounded: 16px
    size: 560px x 332px
    use: Home carousel banner link (a.rounded-16 at home::[data-omd-capture="11"]); the imagery carries the colour
  product-row:
    type: listItem
    backgroundColor: '#ffffff'
    textColor: '#000000'
    size: 320px x 80px
    typography: 16px / 400 / 24px Pretendard Variable
    use: Ranking product row (li.bg-white w-[320px]); 44 captured on home and rankings
  search-field:
    type: input
    textColor: '#aaaaaa'
    height: 21px
    typography: 14px / 400 / 21px Pretendard Variable
    states: the home field carries the disabled attribute (it opens /search rather than accepting text); no hover or focus frame
    use: Header search field text (home::[data-omd-capture="6"], 496 x 21) inside a rounded wrapper link whose own styles were not captured
fonts:
  roles:
    product: Pretendard Variable
---

# Hwahae

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Hwahae; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/hwahae/DESIGN.md

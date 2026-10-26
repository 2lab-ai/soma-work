---
name: Hyundai Card
colors:
  ink: '#000000'
  canvas: '#ffffff'
  inverse: '#ffffff'
  link-product: '#0070f0'
  link-corporate: '#1e75d6'
typography:
  hero:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 52
    use: Product-home h2 headings
  corporate-hero:
    fontSize: 54px
    fontWeight: 700
    lineHeight: 80
    use: Corporate-information h2 headings on the two captured routes
  nav:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 26
    use: Product-home second-level navigation links
  card-title:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 22
    use: Product-card title labels
rounded:
  corporate-outline-action: 3px
  carousel-control: 5px
spacing:
  nav-inline: 20
  corporate-action-inline: 29
components:
  product-card-link:
    type: card
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    size: 146px x 160px
    typography: 16px / 500 / 22px platform system stack (label span.card_name; the anchor's own font is 16px / 400)
    hover: transform (parent li) translateY(-12px); the anchor itself unchanged
    pressed: 'transform (parent li) translateY(-12px); outline auto 2px #005fcc, offset -3px (the site''s :focus rule also draws on mouse press)'
    focus: 'outline auto 2px #005fcc, offset -3px (drawn by a site :focus rule, not the browser default)'
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on the lineup card 'the Red' (real :hover, :active, and Tab to :focus-visible)
    use: Product-home card link; transparent, borderless default
  second-level-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px 20px
    height: 80px
    typography: 18px / 500 / 26px / YouandiNewKr
    hover: '::before 2px #000000 bar across the link width; fg and bg unchanged; the fixed header (div#header) drops its rgba(0,0,0,0.08) 0px 2px 4px 0px shadow while the mega-menu is open'
    pressed: '::before 2px #000000 bar; outline auto 2px #005fcc, offset -3px (the site''s :focus rule also draws on mouse press)'
    focus: 'outline auto 2px #005fcc, offset -3px (drawn by a site :focus rule, not the browser default); ::before 2px #000000 bar'
    states: default captured 2026-07-13 (header links 1 to 7); hover, pressed and keyboard focus measured 2026-09-29 on 카드 (real :hover, :active, and Tab to :focus-visible)
    use: Product-home header second-level link (Account, 카드, 혜택, 금융, 컬처, 고객 지원, Apple Pay)
  product-detail-link:
    type: tab
    backgroundColor: transparent
    textColor: '#0070f0'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 16px / 700 / platform system stack
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: 'outline auto 2px #005fcc, offset -3px (the site''s :focus rule also draws on mouse press)'
    focus: 'outline auto 2px #005fcc, offset -3px (drawn by a site :focus rule, not the browser default)'
    states: default captured 2026-07-13 (four 전체보기 links); hover, pressed and keyboard focus measured 2026-09-29 on the first
    use: Product-home 전체보기 detail link, the colors.link-product role
  search-open:
    type: button
    backgroundColor: transparent
    textColor: rgba(0,0,0,0.48)
    rounded: 0px
    size: 30px x 30px (24px x 24px once the header shrinks on scroll)
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: 'outline auto 2px #005fcc, offset -3px (the site''s :focus rule also draws on mouse press)'
    focus: 'outline auto 2px #005fcc, offset -3px (drawn by a site :focus rule, not the browser default)'
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29; the glyph is a background image; the search layer it opens was not opened
    use: Header search opener (검색 영역 열기); no text input exists until it opens
  corporate-outline-action:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: 1px rgba(255,255,255,0.6)
    rounded: 3px
    padding: 0px 29px
    height: 48px
    typography: 16px / 400 / 46px / platform system stack
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: no change among the compared properties (measured 2026-09-29)
    focus: 'outline auto 1px #005fcc, offset 1px (consistent with the browser default; not a brand token)'
    states: default captured 2026-07-13 on the English (ceh) and Korean (ckh) corporate routes; hover, pressed and keyboard focus measured 2026-09-29 on the English route only (Go to Company Overview, in an auto-advancing hero)
    use: Corporate-information hero outline action; corporate routes only
  corporate-text-link:
    type: tab
    backgroundColor: transparent
    textColor: '#1e75d6'
    rounded: 0px
    padding: 0px
    height: 16px
    typography: 13px / 400 / platform system stack
    hover: no change among the compared properties (measured 2026-09-29)
    pressed: no change among the compared properties (measured 2026-09-29)
    focus: 'outline auto 1px #005fcc, offset 1px (consistent with the browser default; not a brand token)'
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on the English route (Go to Recruitment Homepage); a 12px arrow image follows the label
    use: Corporate-information text link, the colors.link-corporate role
  utility-link:
    type: tab
    backgroundColor: transparent
    textColor: '#5c5c5c'
    rounded: 0px
    padding: 2px 6px
    height: 24px
    typography: 14px / 400 / 20px / platform system stack
    states: default captured 2026-07-13; the 2026-09-29 survey reads the same four links; no pointer-state sample
    use: Product-home header utility link (법인, 가맹점, 소비자보호 포털, 상품공시실)
  corporate-menu-link:
    type: tab
    backgroundColor: transparent
    textColor: '#959595'
    rounded: 0px
    padding: 0px 0px 0px 28px
    height: 42px
    typography: 14px / 400 / 18px / YouandiNewKr
    states: default captured 2026-07-13 on the English corporate route; the 2026-09-29 survey reads the same four links; no pointer-state sample
    use: Corporate-information top menu link (About Us, Investor Relations, Ethics, Careers)
  carousel-pause-control:
    type: button
    backgroundColor: '#000000'
    rounded: 5px
    size: 20px x 10px
    states: default captured 2026-07-13; the 2026-09-29 survey labels it 일시정지; no pointer-state sample
    use: Product-home hero carousel pause control; the rounded.carousel-control radius
  login-filled-button:
    type: button
    backgroundColor: '#000000'
    rounded: 8px
    padding: 17px 4px
    size: 280px x 56px
    states: default captured 2026-07-13; deliberately not hovered, pressed or focused on 2026-09-29 because it belongs to the login widget
    use: Product-home login widget action (간편번호 등록); the anchor's own text colour equals its fill and the visible label was not read, so no text colour is declared
    height: 56px
    typography: 16px / 400
  quick-menu-box:
    type: card
    backgroundColor: transparent
    border: '1px #858585'
    rounded: 8px
    size: 280px x 78px
    states: default captured 2026-07-13; no pointer-state sample
    use: Product-home quick-menu box beside the login widget (상담·문의 …)
fonts:
  roles:
    sans: YouandiNewKr
---

# Hyundai Card

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Hyundai Card; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/hyundaicard/DESIGN.md

---
name: PortOne
colors:
  primary: '#fc6b2d'
  secondary: '#363a44'
  on-primary: '#ffffff'
  selected-surface: '#fff8f5'
  ink: '#111827'
  body: '#374151'
  muted: '#6b7280'
  subtle: '#9ca3af'
  label-dark: '#333333'
  canvas: '#ffffff'
  accent-blue: '#2873ff'
  accent-purple: '#8438e8'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 400
    lineHeight: 1.2
    use: Home hero H1 (AI로 결제와 재무 운영을 자유롭게), tracking -2.24px
  page-title:
    fontSize: 56px
    lineHeight: 1.2
    use: Page H1 on pricing and team; weight set on the variable axis, see §3
  section:
    fontSize: 48px
    lineHeight: 1.25
    use: Home section headlines, tracking -1.44px
  sub-section:
    fontSize: 36px
    fontWeight: 400
    lineHeight: 1.35
    use: Product block headlines (사업의 시작부터 확장까지, 단 하나의 결제 인프라)
  serif-accent:
    fontSize: 36px
    fontWeight: 400
    lineHeight: 1.2
    use: 'Serif accent heading on the team (RECIPE culture) page, #6b7280'
  eyebrow:
    fontSize: 24px
    lineHeight: 1.5
    use: Coloured product-line eyebrow above each home block
  card-title:
    fontSize: 28px
    lineHeight: 1.35
    use: Feature headings inside product blocks
  body:
    fontSize: 17px
    lineHeight: 1.5
    use: Body copy and value descriptions
  nav:
    fontSize: 15px
    lineHeight: 1.47
    use: Header navigation and header button labels
  caption:
    fontSize: 13px
    lineHeight: 1.7
    use: Footer company details
rounded:
  tab: 16px
  pill: 64px
spacing:
  pill-pad: 16
  tab-pad: 16
components:
  header-cta:
    type: button
    backgroundColor: 'linear-gradient(180deg, #363a44 0%, #030712 100%)'
    textColor: '#ffffff'
    rounded: 64px
    height: 40px
    padding: 16px
    typography: 15px Pretendard Variable
    hover: 'gradient lightens to #3f434d -> #6b7280 (instant)'
    pressed: same as hover
    use: Header 도입문의 (contact sales), the site's primary action
  hero-cta:
    type: button
    backgroundColor: 'linear-gradient(180deg, #363a44 0%, #030712 100%)'
    textColor: '#ffffff'
    height: 49.5px
    typography: 17px Pretendard Variable
    shadow: inset 0 2px 0 rgba(255, 255, 255, 0.1)
    hover: 'gradient lightens to #3f434d -> #6b7280 (instant)'
    pressed: same as hover
    use: Hero 시작하기 and the 살펴보기 block buttons; the fill sits on an inner wrapper, not on the link
  login-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 64px
    height: 40px
    padding: 16px
    typography: 15px Pretendard Variable
    hover: 'bg #eeeeee'
    pressed: same as hover
    use: Header 로그인 (leads to the admin console, which was not opened)
  product-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#374151'
    border: '1px solid #e5e5e5'
    rounded: 16px
    height: 55px
    padding: 16px
    typography: 17px Pretendard Variable
    selected: 'bg #fff8f5, label #fc6b2d, 1px border #fc6b2d'
    states: 'hover and pressed: no change (probe); focus not measured'
    use: Two-up switcher inside a product block (국내 결제 / 해외 결제)
fonts:
  roles:
    display: Pretendard Variable
    body: Pretendard Variable
    serif-accent: PT Serif Caption
---

# PortOne

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to PortOne; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/portone/DESIGN.md

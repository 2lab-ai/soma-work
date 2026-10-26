---
name: Kmong
colors:
  canvas: '#ffffff'
  ink: '#000000'
  heading: '#212224'
  muted: '#555969'
  hairline: '#f2f3f7'
  control-border: '#c8cad2'
  primary: '#92fa72'
  on-primary: '#212224'
  header-action: '#212224'
  on-header-action: '#ffffff'
  category-surface: '#fafafc'
  category-border: '#e4e5ed'
typography:
  marketplace-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Repeated public marketplace body, card, and list sample
  header-action:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Public home/category header action
  hero:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.3
    use: Public home headline
  search:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    use: Public home search input
  category-heading:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.22
    use: Public category-page heading sample
rounded:
  square: 0px
  primary-cta: 4px
  control: 8px
  category-panel: 12px
  home-search: 36px
  category-search: 24px
spacing:
  xxs: 2
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
components:
  home-primary-cta:
    type: button
    backgroundColor: '#92fa72'
    textColor: '#212224'
    rounded: 4px
    padding: 0px 24px
    height: 52px
    typography: 16px / 500 Pretendard
    states: default only; no interaction state captured
    use: Public home CTA, selector home::[data-omd-capture=143]
  header-action:
    type: button
    backgroundColor: '#212224'
    textColor: '#ffffff'
    rounded: 8px
    height: 36px
    typography: 14px / 500 Pretendard
    states: default only; no interaction state captured
    use: Public marketplace header action, selector home::[data-omd-capture=6]
  home-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#212224'
    border: '1px solid #c8cad2'
    rounded: 36px
    padding: 0px 32px
    height: 64px
    typography: 20px / 400 Pretendard
    states: default only; no interaction state captured
    use: Public home search shell/input, selectors home::form and home::[data-omd-capture=7]
  home-outline-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#212224'
    border: '1px solid #c8cad2'
    rounded: 8px
    padding: 0px 24px
    height: 52px
    typography: 16px / 500 Pretendard
    states: default only; no interaction state captured
    use: Public home outlined CTA, selector home::[data-omd-capture=145]
  category-filter-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#212224'
    border: '1px solid #e4e5ed'
    rounded: 8px
    padding: 0px 12px
    height: 36px
    typography: 14px / 400 Pretendard
    states: default only; no interaction state captured
    use: Public category filter control, selector surface-3::[data-omd-capture=93]
  category-panel:
    type: card
    backgroundColor: '#fafafc'
    rounded: 12px
    padding: 32px 24px
    use: Public category-page panel, selector surface-3::article; its text sits in child elements and the 16px / 400 it computes is the inherited body type, so no font is declared (corrected 2026-09-30)
  header-text-link:
    type: tab
    backgroundColor: transparent
    textColor: '#212224'
    rounded: 0px
    padding: 0px
    height: 36px
    typography: 14px / 500 Pretendard
    states: three per capture at rest on both home captures and on category; no state frame in the bundle
    use: Header text link and link-styled buttons (home captures 3-5), home::[data-omd-capture="4"]; colour and font are the child label p.font-medium.typo-14 (line height 20px); the control itself computes the 16px / 400 body type
  keyword-chip:
    type: button
    backgroundColor: '#f2f3f7'
    textColor: '#212224'
    rounded: 9999px
    padding: 0px 16px
    height: 36px
    typography: 14px / 400 Pretendard
    states: ten per home capture at rest (captures 9-18 on home); no state frame in the bundle
    use: Rounded chip on home, home::[data-omd-capture="9"]; colour and font are the child label p (line height 21px)
  section-outline-link:
    type: button
    backgroundColor: transparent
    textColor: '#212224'
    border: '1px #c8cad2'
    rounded: 4px
    padding: 0px 20px
    height: 42px
    typography: 16px / 400 Pretendard
    states: twelve per home capture at rest (even captures 42-64 on home); no state frame in the bundle
    use: Outlined link, 214 px wide, home::[data-omd-capture="42"]; colour and font are the child label p.typo-16 (line height 23px)
  caption-tile:
    type: card
    backgroundColor: transparent
    textColor: '#212224'
    rounded: 0px
    size: 143px x 138px
    typography: 15px / 500 Pretendard
    states: twelve per home capture at rest (captures 66-77 on home); no state frame in the bundle
    use: Home tile with a centred caption, home::[data-omd-capture="66"]; colour and font are the caption p (line height 20px)
  category-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#212224'
    rounded: 0px
    padding: 0px
    height: 48px
    typography: 16px / 500 Pretendard
    states: nine captured at rest on category (captures 10-18); no state frame in the bundle
    use: Category-page navigation link, surface-3::[data-omd-capture="10"]; colour and font are the child label p (line height 24px)
  category-link-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#212224'
    border: '1px #e4e5ed'
    rounded: 12px
    padding: 16px 12px
    size: 218px x 70px
    typography: 14px / 700 Pretendard
    states: five captured at rest on category; no state frame in the bundle
    use: 'Bordered link card on category: the list item holds the background, border and radius, the link inside it (surface-3::[data-omd-capture="20"]) the padding, and its h3 the label (line height 20px)'
  pagination-button:
    type: button
    backgroundColor: transparent
    textColor: '#9a9ba7'
    rounded: 8px
    size: 32px x 36px
    selected: 'bg #212224'
    states: 'four page buttons captured at rest on category (captures 141-144); the current page (capture 140, class cursor-default) computes bg #212224; captures 139 and 145 are disabled and give no rest value; no state frame in the bundle'
    use: Category pagination button, surface-3::[data-omd-capture="141"]; the colour comes from the button class text-gray-500; no label font is declared because the digit has no element of its own in the dump
  footer-link:
    type: button
    backgroundColor: transparent
    textColor: '#727585'
    rounded: 0px
    padding: 0px
    typography: 14px / 400 Pretendard
    states: 17 captured at rest on category (captures 149-165); no state frame in the bundle
    use: Footer text link on category, surface-3::[data-omd-capture="149"]; its child p computes the same colour and type (line height 21px)
  outline-link-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#212224'
    border: '1px #c8cad2'
    rounded: 8px
    padding: 0px 16px
    height: 40px
    typography: 14px / 700 Pretendard
    states: two captured at rest on category (captures 147 and 148); no state frame in the bundle
    use: Outlined link button (role link) on category, surface-3::[data-omd-capture="147"]; line height 14px as computed on the control
  inline-text-link:
    type: button
    backgroundColor: transparent
    textColor: '#4b94fa'
    rounded: 0px
    padding: 0px
    typography: 16px / 400 Pretendard
    states: nine per home capture at rest (captures 146-154 on home); no state frame in the bundle
    use: Blue text link (classes text-blue-500 and underline) inside the 390 px home articles, home::[data-omd-capture="146"]; line height 24px
fonts:
  roles:
    ui: Pretendard
---

# Kmong

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Kmong; reproduced for educational reference. Full prose: https://oh-my-design.kr/kmong/design.md

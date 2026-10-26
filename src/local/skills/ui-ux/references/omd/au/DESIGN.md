---
name: au
colors:
  primary: '#eb5505'
  canvas: '#ffffff'
  foreground: '#333333'
  link: '#0066aa'
  muted: '#777777'
  hairline: '#e5e5e5'
  control-border: '#d1d1d1'
  on-primary: '#ffffff'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
    use: Repeated public au.com body and card text
  navigation:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.4
    use: Public global-navigation item
  search:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 2.5
    use: Public header text search input
rounded:
  square: 0px
  card: 5px
spacing:
  xs: 10
  sm: 15
  md: 20
  lg: 25
components:
  mobile-orange-action:
    type: button
    backgroundColor: '#eb5505'
    textColor: '#ffffff'
    rounded: 0px
    height: 44px
    padding: 12.8px 40px 12.8px 15px
    typography: 16px / 700 / noto-sans-cjk-jp
    states: default only; no button interaction state captured
    use: Mobile catalog orange action, selector surface-2::[data-omd-capture=91]
    focus: 'outline #eb5505 solid 2px on :focus-visible'
  mobile-outline-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #333333'
    rounded: 0px
    height: 44px
    padding: 12.8px 40px 12.8px 15px
    typography: 16px / 400 / noto-sans-cjk-jp
    states: default only; no button interaction state captured
    use: Mobile catalog outline action, selector surface-2::[data-omd-capture=92]
  header-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #d1d1d1'
    rounded: 0px
    height: 32px
    padding: 0px 30px 0px 6px
    typography: 12px / 400 / noto-sans-cjk-jp
    states: default only; no input interaction state captured
    use: Public header search input, selector surface-2::[data-omd-capture=8]
  mobile-tab:
    type: tab
    textColor: '#333333'
    border: '0px 0px 2px solid #eb5505 when selected'
    rounded: 0px
    padding: 0px 16px
    typography: 16px / 400 / noto-sans-cjk-jp
    states: selected and unselected observed; tab selection interaction captured
    use: Mobile catalog tab, selector surface-2::[data-omd-capture=81]
  mobile-service-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e5e5e5'
    rounded: 5px
    padding: 15px 25px 25px
    use: Mobile catalog service-card wrapper and contents, selectors surface-2::div.cmp-au-com-card__wrapper and .cmp-au-com-card__contents-section
  smartphone-label:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#eb5505'
    border: '1px solid #eb5505'
    rounded: 0px
    padding: 3.3px 11px
    typography: 11px / 400 / noto-sans-cjk-jp
    use: Smartphone catalog product label, selector surface-3::span.product-card-item-label
fonts:
  roles:
    ui: noto-sans-cjk-jp
    brand: Tazugane Gothic
---

# au

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to au; reproduced for educational reference. Full prose: https://oh-my-design.kr/au/design.md

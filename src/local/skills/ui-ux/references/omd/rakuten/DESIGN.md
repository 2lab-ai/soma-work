---
name: Rakuten
colors:
  primary: '#bf0000'
  ink: '#333333'
  muted: '#666666'
  link: '#1d54a7'
  service-blue: '#0078b5'
  canvas: '#ffffff'
  surface: '#f4f4f4'
  input-surface: '#f7f7f7'
  hairline: '#ebebeb'
  border-strong: '#d1d1d1'
  sale-yellow: '#fff100'
  sale-cream: '#fff9c8'
  on-primary: '#ffffff'
  rex-action: '#134ff3'
  rex-action-hover: '#3a6dfa'
  rex-action-active: '#053ace'
typography:
  section:
    fontSize: 20px
    fontWeight: 600
    use: Module headings on Ichiba (今売れている商品 등 weight 700 on Books)
  nav:
    fontSize: 13px
    fontWeight: 400
    use: Group service nav links
  input:
    fontSize: 16px
    fontWeight: 400
    use: Header keyword search field
  body:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.1
    use: Dense commerce body/default text
  button:
    fontSize: 12px
    fontWeight: 400
    use: Header CTA labels (ログイン)
  button-lg:
    fontSize: 14px
    fontWeight: 400
    use: Books CTA / outline button labels
rounded:
  sm: 4px
  md: 8px
  lg: 15px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  section: 40
components:
  button-primary:
    type: button
    backgroundColor: '#bf0000'
    textColor: '#ffffff'
    rounded: 4px
    height: 32px
    padding: 0 11px
    typography: 12px / 400
    use: ログイン / member CTA in global header (35px·14px on Books)
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #d1d1d1'
    rounded: 4px
    height: 37px
    typography: 14px / 400
    use: Secondary actions — 楽天会員登録(無料), もっと見る
  button-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #d1d1d1'
    rounded: 15px
    padding: 5px 26px 5px 20px
    typography: 14px / 400
    use: Read-more pill on Books modules
  search-bar:
    type: input
    backgroundColor: '#f7f7f7'
    textColor: '#666666'
    border: '1px solid #ebebeb'
    rounded: 4px
    height: 40px
    padding: 8px 12px
    typography: 16px / 400
    use: 'Header keyword search; crimson #bf0000 submit block attached right (0 4px 4px 0)'
  service-tab:
    type: tab
    textColor: '#ffffff'
    typography: 13px / 400
    padding: 12px 8px
    active: '#ffffff text on #bf0000 bg'
    use: Group service nav; current service fills crimson
  card-module:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    use: 'Product/content module floated on #f4f4f4 canvas, hairline-separated, shadowless'
  sale-banner:
    type: card
    backgroundColor: '#fff100'
    textColor: '#666666'
    rounded: 8px
    padding: 12px 24px 16px
    use: Big-sale / campaign section container
  rex-button:
    type: button
    backgroundColor: '#134ff3'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 16px
    typography: 16px / 400
    hover: '#3a6dfa'
    active: '#053ace'
    use: ReX library primary action (npm @rakuten-rex/button, archived 2021)
fonts:
  roles:
    jp-live: Meiryo, Hiragino Kaku Gothic ProN, MS PGothic
    brand: Rakuten Sans (corporate, Dalton Maag 2020)
    rex: system-ui stack
---

# Rakuten

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Rakuten; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/rakuten/DESIGN.md

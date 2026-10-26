---
name: ZOZOTOWN
colors:
  primary: '#000000'
  canvas: '#ffffff'
  accent-red: '#e60012'
  body: '#333333'
  sub: '#666666'
  muted: '#999999'
  hairline: '#cccccc'
  surface: '#f5f5f5'
  surface-subtle: '#fafafa'
  border: '#e5e5e5'
  border-strong: '#dddddd'
  success: '#2e9c4f'
  caution: '#f5a623'
  on-primary: '#ffffff'
typography:
  page-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0.02px
    use: Top-level section / landing headers
  section:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0.02px
    use: Category and module titles
  subheading:
    fontSize: 17px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0.02px
    use: Card group headers, feature titles
  brand-name:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0.04px
    use: Product-card brand label
  item-title:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Product name, 2-line clamp
  price:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.3
    use: Price — black/red, tabular numerals
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.7
    use: Descriptions, reviews, long copy
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Metadata, timestamps, fine print
  micro:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
    use: Tab labels, tag chips, footnotes
  badge:
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0.02px
    use: SALE / NEW / 残りわずか badges
rounded:
  sm: 2px
  md: 4px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    padding: 14px 24px
    typography: 15/700
    use: カートに入れる, 購入手続きへ, ログイン
  button-reverse:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 4px
    padding: 14px 24px
    typography: 15/700
    use: お気に入り登録, 続けて買い物
  button-sale:
    type: button
    backgroundColor: '#e60012'
    textColor: '#ffffff'
    rounded: 4px
    padding: 14px 24px
    typography: 15/700
    use: タイムセール, 今すぐ購入 — urgency only
  button-disabled:
    type: button
    backgroundColor: '#cccccc'
    textColor: '#ffffff'
    rounded: 4px
    use: Out-of-stock / unavailable (在庫なし)
  product-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 0px
    use: Photography-led grid unit, 3:4 portrait, gap-separated
  badge-sale:
    type: badge
    backgroundColor: '#e60012'
    textColor: '#ffffff'
    rounded: 2px
    padding: 2px 6px
    typography: 11/700
    use: SALE overlay top-left of image
  badge-new:
    type: badge
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 2px
    padding: 2px 6px
    typography: 11/700
    use: NEW / NEW ARRIVAL overlay
  badge-lowstock:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#e60012'
    rounded: 2px
    padding: 2px 6px
    typography: 11/700
    use: 残りわずか — red border outline
  badge-preorder:
    type: badge
    backgroundColor: '#666666'
    textColor: '#ffffff'
    rounded: 2px
    padding: 2px 6px
    typography: 11/700
    use: 予約 pre-order flag
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 4px
    padding: 12px 14px
    typography: 15/400
    use: 'Form field — neutral black focus, #cccccc default border'
  bottom-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#999999'
    typography: 11/400
    active: '#000000 icon + label'
    use: ホーム/カテゴリー/お気に入り/カート/マイページ
  filter-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#666666'
    typography: 14/700
    active: '#000000 text + 2px bottom underline #000000'
    use: 新着/人気/価格が安い in-page switcher
  toast:
    type: toast
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 16px
    typography: 14/400
    use: Transient bottom-anchored confirmation
  bottom-sheet:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 20px
    use: Size/color/filter/sort — dominant mobile overlay
  modal:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 24px
    use: Confirmations, login prompts
fonts:
  roles:
    sans: Hiragino Kaku Gothic ProN
    mono: Helvetica Neue
---

# ZOZOTOWN

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to ZOZOTOWN; reproduced for educational reference. Full prose: https://oh-my-design.kr/zozotown/design.md

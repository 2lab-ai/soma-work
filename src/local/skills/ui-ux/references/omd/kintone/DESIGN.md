---
name: kintone
colors:
  primary: '#ef3f24'
  primary-hover: '#d63b22'
  brand: '#ef3f24'
  canvas: '#ffffff'
  foreground: '#333333'
  muted: '#666666'
  on-primary: '#ffffff'
  surface: '#f5f5f5'
  hairline: '#dddddd'
  body: '#555555'
  placeholder: '#999999'
  accent-green: '#3fa862'
  accent-cerulean: '#00afec'
  accent-aloe: '#00afaa'
  accent-sunshine: '#ffba00'
  error: '#e74c3c'
  success: '#3fa862'
  warning: '#ffba00'
  info: '#00afec'
typography:
  display-hero:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0.02em
    use: Marketing hero みんな、つくれる
  display-large:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: 0.02em
    use: Section titles, landing headers
  heading-1:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    use: Page titles, app names
  heading-2:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.45
    use: Card headers, form section titles
  heading-3:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.5
    use: Sub-sections, field group labels
  subtitle:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: List headers, dialog titles
  body-large:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.7
    use: Intro copy, descriptions
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.7
    use: Standard UI text, record fields
  body-small:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.65
    use: Secondary info, table cells
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
    use: Field hints, timestamps, fine print
  label:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.5
    use: Form field labels above inputs
  button:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: 0.02em
    use: CTA and action button text
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#ef3f24'
    textColor: '#ffffff'
    rounded: 4px
    padding: 10px 24px
    typography: 14px / 700
    hover: '#d63b22'
    active: '#c0341e'
    disabled: 'bg #f5b3aa fg #ffffff'
    use: Primary CTA 無料ではじめる / 保存
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#ef3f24'
    border: '1px solid #ef3f24'
    rounded: 4px
    padding: 10px 24px
    typography: 14px / 700
    hover: '#fff0ee'
    use: Secondary action paired with primary
  button-neutral:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#555555'
    border: '1px solid #dddddd'
    rounded: 4px
    padding: 10px 20px
    typography: 14px / 700
    hover: 'bg #f5f5f5 border #bbbbbb'
    use: Cancel, close, back キャンセル
  button-text:
    type: button
    backgroundColor: transparent
    textColor: '#00afec'
    rounded: 4px
    padding: 8px 12px
    typography: 14px / 700
    hover: 'underline + #f5f5f5'
    use: Inline link-style actions in tables/toolbars
  button-danger:
    type: button
    backgroundColor: '#e74c3c'
    textColor: '#ffffff'
    rounded: 4px
    padding: 10px 24px
    typography: 14px / 700
    hover: '#d63b22'
    use: Destructive confirmation 削除する
  input-text:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #dddddd'
    rounded: 4px
    padding: 8px 10px
    typography: 14px / 400
    focus: 'border #00afec + 0 0 0 2px rgba(0,175,236,0.15) ring'
    disabled: 'bg #f5f5f5 fg #999999'
    use: Single-line record fields, search
  input-error:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #e74c3c'
    rounded: 4px
    use: Validation failure with inline message
  card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #dddddd'
    rounded: 6px
    padding: 20px
    shadow: 0 1px 3px rgba(0,0,0,0.08)
    use: Record cards, dashboard widgets, settings panels
  card-tile:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 16px
    shadow: 0 1px 3px rgba(0,0,0,0.08)
    hover: 0 4px 12px rgba(0,0,0,0.12)
    use: Signature app launcher tile
  badge-neutral:
    type: badge
    backgroundColor: '#f5f5f5'
    textColor: '#555555'
    border: '1px solid #dddddd'
    rounded: 12px
    padding: 2px 10px
    typography: 12px / 700
    use: Neutral status / category tag
  badge-success:
    type: badge
    backgroundColor: '#e7f5ed'
    textColor: '#3fa862'
    rounded: 12px
    padding: 2px 10px
    typography: 12px / 700
    use: Success status pill
  badge-info:
    type: badge
    backgroundColor: '#e6f7fd'
    textColor: '#00afec'
    rounded: 12px
    padding: 2px 10px
    typography: 12px / 700
    use: Info status pill
  badge-danger:
    type: badge
    backgroundColor: '#fdeeee'
    textColor: '#e74c3c'
    rounded: 12px
    padding: 2px 10px
    typography: 12px / 700
    use: Danger status pill
  tab-underline:
    type: tab
    textColor: '#666666'
    border: '1px solid #dddddd bottom'
    typography: 14px / 700
    padding: 10px 16px
    hover: '#333333'
    active: '#ef3f24 text + 2px bottom border #ef3f24'
    use: Record detail tabs, settings nav
  toast:
    type: toast
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 16px
    shadow: 0 4px 12px rgba(0,0,0,0.18)
    typography: 13px / 400
    use: Auto-dismissing confirmation 保存しました
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 24px
    shadow: 0 8px 24px rgba(0,0,0,0.20)
    use: Confirmation dialogs, settings, backdrop rgba(0,0,0,0.5)
  toggle:
    type: toggle
    backgroundColor: '#dddddd'
    rounded: 9999px
    active: '#3fa862 track white thumb'
    use: Enable/disable settings 通知をオン
fonts:
  roles:
    sans: Meiryo
    mono: SFMono-Regular
---

# kintone

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to kintone; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/kintone/DESIGN.md

---
name: Spindle (CyberAgent Ameba)
colors:
  primary: '#298737'
  primary-hover: '#0f5c1f'
  link: '#237b31'
  accent-light: '#e7f5e9'
  accent-light-active: '#c6e5c9'
  accent-secondary: '#82be28'
  accent-secondary-object: '#5e9b15'
  accent-secondary-text: '#477d00'
  accent-secondary-light: '#f0f7e6'
  ink: '#08121a'
  canvas: '#ffffff'
  background: '#f5f6f6'
  on-primary: '#ffffff'
  caution: '#d91c0b'
  focus: '#0091ff'
  highlight-yellow: '#f5e100'
  expressive-pink: '#e6456a'
typography:
  display:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    use: Section display headings (h2), bold
  heading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    use: Sub-section heads (h3)
  title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    use: Hero / page title (h1, h2 on docs)
  nav:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.5
    use: Global nav links, bold
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.3
    use: Standard reading text
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Dense UI text, captions, table cells
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    use: Contained CTA label, bold
  button-sm:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1
    use: Compact header register/login pill
rounded:
  sm: 8px
  md: 15px
  lg: 16px
  pill: 48px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
components:
  button-contained:
    type: button
    backgroundColor: '#298737'
    textColor: '#ffffff'
    rounded: 48px
    padding: 8px 16px
    height: 48px
    typography: 16px / 700 Hiragino Sans
    hover: '#0f5c1f'
    use: Primary contained CTA (新規登録), full pill
  button-register-sm:
    type: button
    backgroundColor: '#2d8c3c'
    textColor: '#ffffff'
    rounded: 15px
    height: 30px
    typography: 12px / 700 Hiragino Sans
    use: Compact header register pill on ameba.jp
  button-outlined:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#237b31'
    border: '1px solid #237b31'
    rounded: 15px
    height: 30px
    typography: 12px / 700 Hiragino Sans
    hover: '#e7f5e9'
    use: Outlined secondary action (ログイン)
  button-lighted:
    type: button
    backgroundColor: '#e7f5e9'
    textColor: '#237b31'
    rounded: 48px
    typography: 16px / 700 Hiragino Sans
    hover: '#c6e5c9'
    use: Lighted (soft) action button
  text-link:
    type: tab
    textColor: '#237b31'
    typography: 14px / 700 Hiragino Sans
    active: 'text #237b31 + bottom underline'
    use: Inline text link / もっと見る, bold green
  input-search:
    type: input
    backgroundColor: '#f6f8fa'
    textColor: '#08121a'
    border: 1px solid rgba(8,18,26,0.08)
    rounded: 16px
    padding: 7px 32px
    height: 32px
    typography: 14px Hiragino Sans
    use: Search field, low-emphasis surface fill
  card-lighted:
    type: card
    backgroundColor: '#e7f5e9'
    textColor: '#08121a'
    rounded: 16px
    use: Lighted accent surface card (highlighted blog row)
  table:
    type: card
    backgroundColor: '#ffffff'
    border: 1px solid rgba(8,18,26,0.08)
    rounded: 16px
    use: 'Data table container, striped rows #f5f6f6'
  badge-caution:
    type: badge
    backgroundColor: '#d91c0b'
    textColor: '#ffffff'
    rounded: 9999px
    typography: 12px / 700 Hiragino Sans
    use: Caution / danger status pill
fonts:
  roles:
    sans: Hiragino Sans
    fallback: Meiryo, Yu Gothic Medium, system-ui, -apple-system, sans-serif
---

# Spindle (CyberAgent Ameba)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Spindle (CyberAgent Ameba); reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/spindle/DESIGN.md

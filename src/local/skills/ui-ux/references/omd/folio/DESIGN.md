---
name: FOLIO
colors:
  primary: '#f26161'
  primary-light: '#ff8c8c'
  primary-surface: '#ffe2e8'
  foreground: '#202128'
  text-secondary: '#70707e'
  text-tertiary: '#b0b0bb'
  link: '#6585c2'
  positive: '#007e7d'
  canvas: '#ffffff'
  surface: '#f7f8fa'
  border: '#e9eaef'
  gray-70: '#41424e'
  gray-80: '#292a33'
typography:
  xxs:
    fontSize: 10px
    use: '--FOLIOWEB-LP-font-size-xxs'
  xs:
    fontSize: 12px
    use: '--FOLIOWEB-LP-font-size-xs'
  s:
    fontSize: 14px
    use: '--FOLIOWEB-LP-font-size-s'
  m:
    fontSize: 16px
    use: '--FOLIOWEB-LP-font-size-m; body, header buttons and navigation'
  l:
    fontSize: 20px
    use: '--FOLIOWEB-LP-font-size-l; the 48px pill buttons'
  xl:
    fontSize: 24px
    use: '--FOLIOWEB-LP-font-size-xl'
  xxl:
    fontSize: 32px
    use: '--FOLIOWEB-LP-font-size-xxl'
  xxxl:
    fontSize: 40px
    use: '--FOLIOWEB-LP-font-size-xxxl, the largest step'
rounded:
  m: 8px
  l: 16px
  full: 999px
spacing:
  xxxxs: 2
  xxxs: 4
  xxs: 8
  xs: 16
  s: 24
  m: 32
  l: 40
  xl: 48
  xxl: 56
  xxxl: 64
  xxxxl: 80
components:
  button-primary:
    type: button
    backgroundColor: '#f26161'
    textColor: '#ffffff'
    rounded: 999px
    height: 40px
    padding: 0 24px
    typography: 16px / 600
    hover: '#ff8c8c'
    pressed: '#ff8c8c'
    use: 口座開設 in the header — the coral pill that opens an account. Lightens to --color-light-pink on hover; focus is the browser's ring.
  button-dark:
    type: button
    backgroundColor: '#202128'
    textColor: '#ffffff'
    rounded: 999px
    height: 48px
    padding: 0 24px
    typography: 20px / 600
    hover: '#70707e'
    pressed: '#70707e'
    use: 詳しく見る on dark — a near-black pill that turns mid-gray on hover.
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#202128'
    border: '1px solid #70707e'
    rounded: 999px
    height: 40px
    padding: 0 24px
    typography: 16px / 600
    hover: 'fg #f26161, border #f26161'
    pressed: 'fg #f26161, border #f26161'
    use: 'ログイン — white pill with a gray border; on hover the label and border both turn coral #f26161 while the fill stays white.'
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#202128'
    height: 32px
    typography: 16px / 600
    hover: 'fg #f26161'
    pressed: 'fg #f26161'
    use: 'Header navigation (手数料 and siblings). The label turns coral #f26161 on hover.'
  link-inline:
    type: button
    backgroundColor: transparent
    textColor: '#6585c2'
    typography: 16px / 400
    hover: transparent
    pressed: transparent
    use: Inline notice links in the leftover blue. Identical at rest, hover and press — only the browser's focus ring distinguishes a state.
fonts:
  roles:
    sans: Aoto Gothic
    latin: Roboto
---

# FOLIO

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to FOLIO; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/folio/DESIGN.md

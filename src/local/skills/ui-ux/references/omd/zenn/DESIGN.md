---
name: Zenn
colors:
  primary: '#3ea8ff'
  primary-hover: '#0f83fd'
  primary-pressed: '#0868ce'
  foreground: '#000000'
  secondary: '#807aff'
  alert: '#ff6868'
  like: '#f76685'
  text-low-priority: '#65717b'
  text-lower-priority: '#8f9faa'
  text-link: '#0f83fd'
  text-link-visited: '#4b4f52'
  canvas: '#ffffff'
  bg-outer: '#edf2f7'
  bg-neutral-lighter: '#f1f5f9'
  bg-neutral-lightest: '#f5f9fc'
  bg-primary: '#e0efff'
  bg-primary-lighter: '#ecf5ff'
  bg-secondary: '#f3f2ff'
  bg-alert: '#fff0f0'
  bg-like: '#ffeaf4'
  border: '#d6e3ed'
  border-lighter: '#e4edf4'
  focus-shadow: '#bfdcff'
  form-input-bg: '#f5f9fc'
  blue-100: '#f0f7ff'
  blue-200: '#ecf5ff'
  blue-350: '#cfe5ff'
  blue-400: '#bfdcff'
  blue-700: '#0868ce'
  gray-100: '#f5f9fc'
  gray-400: '#e4edf4'
  gray-600: '#acbcc7'
  gray-800: '#65717b'
  purple-200: '#f3f2ff'
  purple-300: '#dbdfff'
  red-100: '#fff0f0'
  red-300: '#ffc5c5'
  warn: '#ffa909'
  warn-bg: '#fff6e4'
  button-share-fg: '#8f9faa'
  button-secondary-hover-bg: '#f5fbff'
  button-secondary-grayed-bg: '#f5f9fc'
typography:
  micro:
    fontSize: 10px
    use: The smallest rendered step
  caption:
    fontSize: 11px
    use: Metadata under a card; 93 elements
  small:
    fontSize: 11.5px
    use: The second most common size on the page — 308 elements
  label:
    fontSize: 12px
    use: Tags and counts; 267 elements
  base:
    fontSize: 16px
    use: The dominant size — 956 of 2,227 elements, and the primary button's label
  lead:
    fontSize: 16.8px
    use: Card titles
  display:
    fontSize: 42px
    use: The hero, set in Inter; 256 elements
rounded:
  xxs: 2px
  xs: 4px
  sm: 7px
  md: 10px
  lg: 14px
  xl: 20px
  full: 1584px
spacing:
  s3xs: 4
  sxxs: 8
  sxs: 16
  ssm: 24
  smd: 32
  slg: 40
  sxl: 48
  sxxl: 64
components:
  button-primary:
    type: button
    backgroundColor: '#3ea8ff'
    textColor: '#ffffff'
    border: 1px solid rgba(92,147,187,.15)
    rounded: 1584px
    height: 44px
    typography: 16px / 700
    hover: '#0f83fd'
    pressed: '#0f83fd'
    focus: '#0f83fd'
    use: '今すぐはじめる — the filled pill. Hover, pressed and focus are the same #0f83fd fill and nothing else: the component sets outline-style none and supplies no replacement, so focus is indistinguishable from hover.'
    padding: 9.6px 24px
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: rgba(0,0,0,.82)
    border: '1px solid #d6e3ed'
    rounded: 1584px
    height: 40px
    typography: 14.4px / 400
    hover: '#f5fbff'
    pressed: '#bfdcff'
    focus: '#bfdcff'
    use: '…もっとみる — the outline pill. Hover fills #f5fbff; pressed and focus draw an authored 2px #bfdcff box-shadow ring and turn the border #3ea8ff.'
  button-signin:
    type: button
    backgroundColor: '#3ea8ff'
    textColor: '#ffffff'
    rounded: 1584px
    height: 36px
    typography: 15px / 600
    hover: '#0f83fd'
    pressed: '#0f83fd'
    focus: '#0f83fd'
    use: Log in, in the header — the primary variant at a second size, confirming the no-ring behaviour on an independent instance.
fonts:
  roles:
    sans: Hiragino Kaku Gothic ProN
    latin: Inter
    mono: SFMono-Regular
---

# Zenn

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Zenn; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/zenn/DESIGN.md
